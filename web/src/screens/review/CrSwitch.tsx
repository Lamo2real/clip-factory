// The CR switch of a Review card (docs/CONTRACTS.md §53 C1, C5): CR inactive (the default) or CR active. Inactive, the
// card is exactly as before. Active, "Edit for campaign" opens the editor; while the edit is made the card says so and
// asks the clip again every 2 seconds; when it is ready the clip plays the edited file. Reset puts the original back.
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { Clip } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button, Pill, Segmented } from "../../components/ui.tsx";
import { burst, centerOf } from "../../lib/confetti.ts";
import { pictureCount } from "../../lib/crLayers.ts";
import { FAILED_LINE, isCrActive, OVERLAY_POLL_MS, W } from "../../lib/crOverlay.ts";
import { CampaignEdit } from "./CampaignEdit.tsx";

type Choice = "inactive" | "active";

export function CrSwitch({ clip, onClip }: { clip: Clip; onClip: (c: Clip) => void }) {
  const toast = useToast();
  // The pick shows at once; the clip from the server (or the live news) takes over when it answers.
  const [want, setWant] = useState<boolean | null>(null);
  const [editing, setEditing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const active = want ?? isCrActive(clip);
  const overlay = clip.overlay;
  const status = overlay?.status;
  // One or more pictures (a §53 edit has one `logo`, a §54 edit has `logos`).
  const pictures = pictureCount(overlay);
  const editButton = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const onClipRef = useRef(onClip);
  onClipRef.current = onClip;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // While the edit is made: ask the clip again every 2 seconds, until it is ready or has not worked.
  useEffect(() => {
    if (status !== "working") return;
    let live = true;
    const timer = setInterval(() => {
      api()
        .getClip(clip.clipId)
        .then((fresh) => live && onClipRef.current(fresh))
        .catch(() => undefined);
    }, OVERLAY_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [status, clip.clipId]);

  // A moment of joy when the edit this card was waiting for is ready (and a note when it did not work).
  const was = useRef(status);
  useEffect(() => {
    const prev = was.current;
    was.current = status;
    if (prev !== "working" || !status) return;
    if (status === "ready") {
      burst(centerOf(editButton.current), 90);
      toast.success("Your edit is ready.");
    } else if (status === "failed") toast.error(overlay?.error ?? FAILED_LINE);
  }, [status, overlay?.error, toast]);

  async function choose(next: Choice) {
    const on = next === "active";
    if (on === active) return;
    const hadEdit = !!overlay;
    setWant(on);
    try {
      const fresh = await api().setClipCr(clip.clipId, on ? { active: true } : { active: false });
      onClip(fresh);
      if (!on && hadEdit) toast.info(W.removed);
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      if (alive.current) setWant(null);
    }
  }

  async function reset() {
    if (resetting) return;
    setResetting(true);
    try {
      onClip(await api().resetOverlay(clip.clipId));
      toast.info(W.removed);
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      if (alive.current) setResetting(false);
    }
  }

  return (
    <section className="cr-switch" data-help="cr-switch" aria-label="Campaign edit">
      <Segmented<Choice>
        label="Campaign edit"
        value={active ? "active" : "inactive"}
        options={[
          { value: "inactive", label: W.inactive },
          { value: "active", label: W.active },
        ]}
        onChange={(v) => void choose(v)}
      />
      {active ? (
        <div className="cr-switch__body">
          {status === "working" ? (
            <p className="cr-switch__working" role="status">
              <span className="spinner" aria-hidden="true" />
              {W.making}
            </p>
          ) : (
            <>
              <Button ref={editButton} variant="glass" icon="edit" data-help="cr-edit" onClick={() => setEditing(true)}>
                {W.edit}
              </Button>
              {status === "ready" ? (
                <span className="cr-switch__tags">
                  {pictures ? (
                    <Pill tone="success" icon="image">
                      {pictures > 1 ? `${W.logo} × ${pictures}` : W.logo}
                    </Pill>
                  ) : null}
                  {overlay?.text ? <Pill tone="success">{W.text}</Pill> : null}
                </span>
              ) : null}
              {overlay ? (
                <Button variant="ghost" size="sm" icon="undo" act="undo" loading={resetting} onClick={() => void reset()}>
                  {W.reset}
                </Button>
              ) : null}
            </>
          )}
          {status === "failed" ? (
            <p className="cr-switch__bad" role="alert">
              <Icon name="alert" size={18} />
              {overlay?.error ?? FAILED_LINE}
            </p>
          ) : null}
        </div>
      ) : null}
      {editing ? (
        <CampaignEdit
          clip={clip}
          onClose={() => setEditing(false)}
          onClip={onClip}
          onMade={(made) => {
            onClip(made);
            setEditing(false);
          }}
        />
      ) : null}
    </section>
  );
}
