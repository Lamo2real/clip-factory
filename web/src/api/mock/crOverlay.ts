// CR active (docs/CONTRACTS.md §53) in memory: the logo library (C4), the CR switch and Make it / Reset (C5), with the
// API's rules and sentences. A render becomes ready after about 1.5 s and keeps the clip's video link (the mock has
// one picture for every clip). Test knobs: window.__cfMock.crOverlay.
import { ApiError } from "../errors.ts";
import type { Api, Campaign, Clip, Logo, OverlayBody } from "../types.ts";
import { FAILED_LINE, LOGO_MAX_BYTES, LOGO_MAX_COUNT, LOGO_REFUSE, LOGO_SIZE_MAX, LOGO_SIZE_MIN, LOGO_TYPES, TEXT_MAX, WORKING_LINE } from "../../lib/crOverlay.ts";
import { ulid } from "./fixtures.ts";

export type CrOverlayApi = Pick<
  Api,
  "listLogos" | "createLogoUpload" | "completeLogo" | "logoFromCampaign" | "deleteLogo" | "setClipCr" | "makeOverlay" | "resetOverlay"
>;

/** How long a pretend render takes. */
export const MOCK_RENDER_MS = 1500;

export interface CrOverlayControls {
  /** The next render fails (the Try again path). */
  failNext(): void;
  /** Starts again with the one seeded logo. */
  reset(): void;
}

const bad = (msg: string) => new ApiError(400, "bad_request", msg);
const notFound = (msg: string) => new ApiError(404, "not_found", msg);
const conflict = (msg: string) => new ApiError(409, "conflict", msg);
const NO_LOGO = "That logo is not in your library any more.";
const NOT_WAITING = "This clip is not waiting for review any more.";

/** A flat picture standing in for an uploaded logo (the mock never reads the file). */
export function logoArt(name: string, wide = false): string {
  const hue = Array.from(name).reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 17);
  const letters = (name.match(/[A-Za-z0-9]/g) ?? ["L"]).slice(0, 2).join("").toUpperCase();
  const [w, h] = wide ? [480, 160] : [256, 256];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="${Math.round(h / 5)}" fill="hsl(${hue} 55% 38%)"/><text x="50%" y="55%" font-family="Inter,Arial,sans-serif" font-weight="800" font-size="${Math.round(h * 0.42)}" fill="#fff8ee" text-anchor="middle" dominant-baseline="middle">${letters}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

interface Deps {
  delay: (min?: number, max?: number) => Promise<void>;
  clip: (clipId: string) => Clip;
  publishClip: (c: Clip) => void;
  /** The campaign as the owner has it (null when he has not, or Content Rewards is off). */
  campaign: (campaignId: string) => Promise<Campaign | null>;
}

const seeded = (): Logo[] => [
  { logoId: ulid(), name: "Lamo Clips", url: logoArt("Lamo Clips"), width: 256, height: 256, createdAt: new Date(Date.now() - 86_400_000).toISOString() },
];

export function crOverlayApi({ delay, clip, publishClip, campaign }: Deps): { api: CrOverlayApi; controls: CrOverlayControls } {
  let logos: Logo[] = seeded();
  const pending = new Map<string, { name: string; type: string; size: number }>();
  let failNext = false;
  // The clip's own file before the edit (the mock keeps one link, so Reset only has to put the fields back).
  const originals = new Map<string, string | undefined>();

  const check = (c: Clip) => {
    if (c.status !== "review") throw conflict(NOT_WAITING);
  };
  const reset = (c: Clip) => {
    if (originals.has(c.clipId)) c.videoUrl = originals.get(c.clipId) ?? c.videoUrl;
    originals.delete(c.clipId);
    delete c.overlay;
  };

  /** The API's checks on a logo's and a text's numbers (C2). */
  function checkBody(body: OverlayBody, c: Clip) {
    const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
    const unit = (v: unknown) => num(v) && (v as number) >= 0 && (v as number) <= 1;
    if (!body.logo && !body.text) throw bad("Add a logo or some words first.");
    if (body.logo) {
      const l = body.logo;
      if (!logos.some((x) => x.logoId === l.logoId)) throw notFound(NO_LOGO);
      if (!unit(l.x) || !unit(l.y)) throw bad("The logo has to stay inside the picture.");
      if (!num(l.size) || l.size < LOGO_SIZE_MIN - 1e-9 || l.size > LOGO_SIZE_MAX + 1e-9) throw bad("The logo can be 8% to 50% of the width.");
    }
    if (body.text) {
      const t = body.text;
      if (typeof t.text !== "string" || !t.text.trim() || Array.from(t.text).length > TEXT_MAX) throw bad(`The words can be 1 to ${TEXT_MAX} letters.`);
      if (!unit(t.x) || !unit(t.y)) throw bad("The words have to stay inside the picture.");
      if (!["s", "m", "l"].includes(t.size)) throw bad("Pick Small, Medium or Large.");
    }
    if (body.timing) {
      const { startSec, endSec } = body.timing;
      if (!num(startSec) || !num(endSec) || startSec < 0 || endSec <= startSec || endSec > c.durationSec + 0.05) throw bad("Pick a start before the end, inside the clip.");
    }
  }

  const api: CrOverlayApi = {
    async listLogos() {
      await delay();
      return structuredClone(logos);
    },
    async createLogoUpload({ filename, contentType, size }) {
      await delay();
      if (!(LOGO_TYPES as readonly string[]).includes(contentType) || size > LOGO_MAX_BYTES || size <= 0) throw bad(LOGO_REFUSE.kind);
      if (logos.length >= LOGO_MAX_COUNT) throw bad(LOGO_REFUSE.full);
      const logoId = ulid();
      pending.set(logoId, { name: filename, type: contentType, size });
      return { logoId, uploadUrl: "mock://upload", headers: { "Content-Type": contentType } };
    },
    async completeLogo(logoId) {
      await delay();
      const p = pending.get(logoId);
      if (!p) throw bad(LOGO_REFUSE.kind);
      pending.delete(logoId);
      const logo: Logo = { logoId, name: p.name, url: logoArt(p.name), width: 256, height: 256, createdAt: new Date().toISOString() };
      logos = [...logos, logo];
      return structuredClone(logo);
    },
    async logoFromCampaign(campaignId) {
      await delay();
      const c = await campaign(campaignId);
      const has = !!c && (c.logo.state === "ready" || c.rules?.logo.required === true);
      if (!c || !has) throw notFound("That campaign has no logo.");
      const again = logos.find((l) => l.campaignId === campaignId);
      if (again) return structuredClone(again);
      const logo: Logo = { logoId: ulid(), name: `${c.brand} logo`, url: logoArt(c.brand, true), width: 480, height: 160, campaignId, createdAt: new Date().toISOString() };
      logos = [...logos, logo];
      return structuredClone(logo);
    },
    async deleteLogo(logoId) {
      await delay();
      logos = logos.filter((l) => l.logoId !== logoId);
    },
    async setClipCr(clipId, body) {
      await delay(100, 240);
      const c = clip(clipId);
      check(c);
      if (typeof body.active !== "boolean") throw bad("active must be true or false.");
      if (body.campaignId !== undefined) {
        const own = await campaign(body.campaignId);
        if (!own) throw notFound("That campaign is not one of yours.");
      }
      if (!body.active) {
        reset(c);
        c.cr = { active: false };
      } else {
        c.cr = { active: true, ...(body.campaignId ? { campaignId: body.campaignId } : {}) };
      }
      publishClip(c);
      return structuredClone(c);
    },
    async makeOverlay(clipId, body) {
      await delay(100, 240);
      const c = clip(clipId);
      check(c);
      if (!c.cr?.active) throw conflict("Turn CR active on first.");
      if (c.overlay?.status === "working") throw conflict(WORKING_LINE);
      checkBody(body, c);
      if (!originals.has(clipId)) originals.set(clipId, c.videoUrl);
      const rev = (c.overlay?.rev ?? 0) + 1;
      c.overlay = { rev, status: "working", ...(body.logo ? { logo: { ...body.logo } } : {}), ...(body.text ? { text: { ...body.text } } : {}), ...(body.timing ? { timing: { ...body.timing } } : {}) };
      publishClip(c);
      const fail = failNext;
      failNext = false;
      setTimeout(() => {
        // Reset, thrown away or made again meanwhile: this render is stale and changes nothing.
        if (c.status !== "review" || c.overlay?.rev !== rev || c.overlay.status !== "working") return;
        c.overlay = fail ? { ...c.overlay, status: "failed", error: FAILED_LINE } : { ...c.overlay, status: "ready" };
        publishClip(c);
      }, MOCK_RENDER_MS);
      return structuredClone(c);
    },
    async resetOverlay(clipId) {
      await delay(100, 240);
      const c = clip(clipId);
      check(c);
      reset(c);
      publishClip(c);
      return structuredClone(c);
    },
  };

  const controls: CrOverlayControls = {
    failNext: () => {
      failNext = true;
    },
    reset: () => {
      logos = seeded();
      pending.clear();
      failNext = false;
    },
  };
  return { api, controls };
}
