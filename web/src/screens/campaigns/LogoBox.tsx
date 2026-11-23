// The campaign's logo (docs/CONTRACTS.md §38.4 item 5): one drop box for the file, or a Google Drive or Dropbox link.
// Only PNG, JPG or WebP, under 10 MB. Before he is in, only a line: the logo comes with joining.
import { useId, useImperativeHandle, useRef, useState, type DragEvent, type Ref } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import { putFile } from "../../api/upload.ts";
import type { Campaign } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button, Progress } from "../../components/ui.tsx";
import { reloadCr } from "../../lib/contentRewards.ts";
import { Lines, OpenButton } from "./bits.tsx";

export const LOGO_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;
export const LOGO_MAX = 10 * 1024 * 1024;
export const LOGO_WRONG_TYPE = "Clip Factory needs a PNG, JPG or WebP picture. Save the logo as PNG and try again.";
export const LOGO_TOO_BIG = "That picture is too big. Use one under 10 MB.";

/** What is wrong with a picked logo file, or null. */
export function logoProblem(file: Pick<File, "type" | "size" | "name">): string | null {
  const type = file.type || (/\.png$/i.test(file.name) ? "image/png" : /\.jpe?g$/i.test(file.name) ? "image/jpeg" : /\.webp$/i.test(file.name) ? "image/webp" : "");
  if (!(type in LOGO_TYPES)) return LOGO_WRONG_TYPE;
  if (file.size > LOGO_MAX) return LOGO_TOO_BIG;
  return null;
}

export interface LogoBoxHandle {
  pick(): void;
}

export function LogoBox({
  campaign,
  onCampaign,
  handle,
  openCampaign,
}: {
  campaign: Campaign;
  onCampaign: (c: Campaign) => void;
  handle?: Ref<LogoBoxHandle>;
  /** The campaign's page on Content Rewards, where the logo file is (a glass Open campaign leads the box). */
  openCampaign?: string;
}) {
  const id = useId();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [changing, setChanging] = useState(false);
  const logo = campaign.logo;
  const isIn = campaign.membership === "in" || campaign.membership === "manual";

  useImperativeHandle(handle, () => ({
    pick() {
      input.current?.click();
    },
  }));

  async function upload(file: File) {
    const wrong = logoProblem(file);
    setError(wrong);
    if (wrong) return false;
    const contentType = (file.type in LOGO_TYPES ? file.type : /\.png$/i.test(file.name) ? "image/png" : /\.webp$/i.test(file.name) ? "image/webp" : "image/jpeg") as keyof typeof LOGO_TYPES;
    try {
      setProgress(0);
      const put = await api().crLogoUpload(campaign.campaignId, { filename: file.name, contentType, size: file.size });
      await putFile(put, file, setProgress);
      const next = await api().crLogoDone(campaign.campaignId, put.key);
      onCampaign(next);
      setChanging(false);
      void reloadCr();
      toast.success("Logo added ✓");
      return true;
    } catch (e) {
      setError(friendlyMessage(e));
      return false;
    } finally {
      setProgress(null);
    }
  }

  async function fromLink(url: string) {
    if (!url.trim()) return false;
    setBusy(true);
    setError(null);
    try {
      const next = await api().crLogoLink(campaign.campaignId, url.trim());
      onCampaign(next);
      if (next.logo.state === "failed") setError(next.logo.error ?? "That link did not work.");
      else {
        setLink("");
        setChanging(false);
      }
      void reloadCr();
      return next.logo.state !== "failed";
    } catch (e) {
      setError(friendlyMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function pasteLink() {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) {
        toast.info("Nothing is copied yet. Copy the logo's Google Drive or Dropbox link first.");
        return;
      }
      setLink(text);
      void fromLink(text);
    } catch {
      document.getElementById(`${id}-link`)?.focus();
      toast.info("Press and hold in the link box, then choose Paste.");
    }
  }

  function drop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void upload(file);
    else {
      const text = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
      if (text) {
        setLink(text.trim());
        void fromLink(text.trim());
      }
    }
  }

  if (!logo.needed) return null;
  return (
    <section className="cr-logo" data-help="cr-logo" aria-labelledby={`${id}-title`}>
      <h2 className="cr-section__title" id={`${id}-title`}>
        Logo
      </h2>
      {!isIn ? (
        <p className="cr-quiet">You can get the logo once you&apos;re in.</p>
      ) : logo.state === "ready" && !changing ? (
        <div className="cr-logo__ready">
          {logo.url ? <img className="cr-logo__tile" src={logo.url} alt="The campaign's logo" /> : null}
          <p className="gstep__note is-ok">
            <Icon name="checkCircle" size={18} />
            Logo added ✓
          </p>
          <Button variant="glass" icon="edit" onClick={() => setChanging(true)}>
            Change
          </Button>
        </div>
      ) : (
        <>
          {openCampaign ? (
            <div className="cr-logo__actions">
              <OpenButton label="Open campaign" href={openCampaign} />
            </div>
          ) : null}
          <Lines
            lines={[
              openCampaign
                ? "Tap Open campaign. Open **Reference materials**. Tap the file with “logo” in its name. Download it."
                : "On the campaign page, open **Reference materials**. Tap the file with “logo” in its name. Download it.",
              "Tap Choose a file. Pick it from Downloads.",
            ]}
          />
          <div
            className={`dropzone cr-logo__drop${over ? " is-over" : ""}${error ? " is-bad" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={drop}
          >
            <Icon name="image" size={26} />
            <span className="dropzone__text cr-semibold">Drop the logo here, or paste a Google Drive or Dropbox link.</span>
            <input
              ref={input}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              aria-label="Choose the logo file"
              tabIndex={-1}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void upload(f);
              }}
            />
            <div className="cr-logo__actions">
              <Button variant="glass" icon="paste" act="paste" onClick={pasteLink} loading={busy}>
                Paste
              </Button>
              <Button variant="glass" icon="upload" act="upload" playOnClick={false} onClick={() => input.current?.click()}>
                Choose a file
              </Button>
            </div>
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${id}-link`}>
              Or type the logo&apos;s link
            </label>
            <div className="linkbox">
              <span className="linkbox__mark" aria-hidden="true">
                <Icon name="link" />
              </span>
              <input
                id={`${id}-link`}
                className="linkbox__input"
                type="url"
                inputMode="url"
                placeholder="https://drive.google.com/file/d/…"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void fromLink(link);
                  }
                }}
              />
            </div>
          </div>
          {progress !== null ? <Progress value={progress} label="Logo upload" /> : null}
          {logo.state === "fetching" ? (
            <p className="gstep__note" role="status">
              <span className="spinner" aria-hidden="true" /> Getting the logo…
            </p>
          ) : null}
          {error || (logo.state === "failed" && logo.error) ? (
            <p className="callout callout--bad" role="alert">
              <Icon name="alert" size={18} />
              <span>{error ?? logo.error}</span>
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
