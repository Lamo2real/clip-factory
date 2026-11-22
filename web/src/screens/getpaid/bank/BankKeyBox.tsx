// Step 5's box (docs/CONTRACTS.md §40.5.2, §40.5.4): the App ID paste box, Save and Check again, the check's sentence,
// and, folded, the .pem path for an app made with Enable Banking's default. The web keeps only the first app ID it
// finds anywhere in what he pasted, shows it, and sends only that. The .pem's words are never kept in React state:
// the boxes are emptied after the send and when the page closes, with no autocomplete or spellcheck.
import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import type { BankAppCode, BankView } from "../../../api/types.ts";
import { Icon } from "../../../components/Icon.tsx";
import { Button } from "../../../components/ui.tsx";
import { BANK_GUIDE, NO_APP_ID, PEM_MAX_BYTES, PEM_SAVED, findAppId } from "../../../getpaid/bank.ts";
import { Rich } from "../../settings/setup/bits.tsx";

const upload = BANK_GUIDE.steps.find((s) => s.id === "bank-appid")!.upload!;

/** Save or Check again, as the step's main button (the page decides whether it is the vermilion or pinned). */
export function KeyMain({ saved, primary, busy, onSave, onCheck }: { saved: boolean; primary: boolean; busy: "save" | "check" | null; onSave: () => unknown; onCheck: () => unknown }) {
  return saved ? (
    <Button variant={primary ? "primary" : "glass"} size="lg" icon="retry" act="retry" loading={busy === "check"} onClick={onCheck} data-help-clear={primary ? "" : undefined} data-bank="check-again">
      Check again
    </Button>
  ) : (
    <Button variant={primary ? "primary" : "glass"} size="lg" icon="check" loading={busy === "save"} onClick={onSave} data-help-clear={primary ? "" : undefined} data-bank="save">
      Save
    </Button>
  );
}

export function BankKeyBox({
  view,
  paste,
  onPaste,
  primary,
  pinned,
  busy,
  onSave,
  onCheck,
  onPem,
  onPemDeleted,
  check,
}: {
  view: BankView;
  /** What he pasted in App ID (not secret: the page keeps it, so a pinned Save on a phone sends it). */
  paste: string;
  onPaste: (v: string) => void;
  /** The step's main button is the page's vermilion. */
  primary: boolean;
  /** Phones: the main button is pinned at the bottom right, so the box leaves it out. */
  pinned: boolean;
  busy: "save" | "check" | "pem" | null;
  onSave: () => unknown;
  onCheck: () => unknown;
  /** The .pem path: its words, and the file's name when it came as a file. */
  onPem: (pem: string, fileName?: string) => Promise<boolean>;
  onPemDeleted: () => unknown;
  /**
   * The latest check (Save's or Check again's answer in this visit, else the stored one): its sentence, icon and
   * `data-check` all come from the same answer, so a "down" answer never sits beside the stored check's green tick.
   */
  check: { code: BankAppCode; text: string } | null;
}) {
  const id = useId();
  const saved = !!view.key.appIdHint;
  const found = paste.trim() ? findAppId(paste) : null;
  const [fold, setFold] = useState(false);
  const [cantPick, setCantPick] = useState(false);
  const [over, setOver] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const pemBox = useRef<HTMLTextAreaElement>(null);

  // The .pem paste box is emptied when the page closes (and when the box goes).
  useEffect(() => {
    const box = pemBox.current;
    const empty = () => {
      if (pemBox.current) pemBox.current.value = "";
    };
    window.addEventListener("pagehide", empty);
    return () => {
      window.removeEventListener("pagehide", empty);
      if (box) box.value = "";
    };
  }, [cantPick]);

  async function sendFile(f: File) {
    setProblem(null);
    if (!/\.pem$/i.test(f.name) || f.size > PEM_MAX_BYTES) {
      setProblem("That isn't Enable Banking's key file. It ends in .pem and starts with BEGIN PRIVATE KEY.");
      return;
    }
    const text = await f.text();
    await onPem(text, f.name);
  }

  async function sendPasted() {
    const box = pemBox.current;
    if (!box) return;
    const text = box.value;
    box.value = "";
    if (!text.trim()) return;
    await onPem(text);
  }

  function drop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files[0];
    if (f) void sendFile(f);
  }

  // Once an app ID is saved, Save is for a new one: it shows only once he has pasted something.
  const other =
    saved && paste.trim() ? (
      <Button variant="glass" size="md" icon="check" loading={busy === "save"} onClick={onSave} data-bank="save">
        Save
      </Button>
    ) : null;
  const good = check?.code === "ok" || check?.code === "not_active";

  return (
    <div className="bank-key" data-bank="key-box">
      <label className="bank-key__label" htmlFor={`${id}-appid`}>
        App ID
      </label>
      <textarea
        id={`${id}-appid`}
        className="input bank-key__paste"
        rows={2}
        value={paste}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={`${id}-found`}
        onChange={(e) => onPaste(e.target.value)}
      />
      <p className="bank-key__found" id={`${id}-found`} aria-live="polite">
        {found ? (
          <>
            <Icon name="checkCircle" size={18} />
            <span>
              App ID: <code className="bank-key__id">{found}</code>
            </span>
          </>
        ) : paste.trim() ? (
          <>
            <Icon name="info" size={18} />
            <span>
              <Rich text={NO_APP_ID} />
            </span>
          </>
        ) : saved ? (
          <span>Saved: {view.key.appIdHint}</span>
        ) : null}
      </p>
      <div className="gstep__actions bank-key__actions">
        {pinned ? null : <KeyMain saved={saved} primary={primary} busy={busy === "pem" ? null : busy} onSave={onSave} onCheck={onCheck} />}
        {other}
      </div>
      {check?.text ? (
        <p className="gp-result bank-key__check" role="status" data-check={check.code}>
          <Icon name={good ? "checkCircle" : "info"} size={18} />
          <span>
            <Rich text={check.text} />
          </span>
        </p>
      ) : null}
      {view.key.pemReminder ? (
        <div className="bank-key__reminder" data-bank="pem-reminder">
          <p>
            <Icon name="alert" size={18} />
            <span>{PEM_SAVED}</span>
          </p>
          <Button variant="glass" size="lg" icon="check" className="btn--leaf" onClick={onPemDeleted}>
            I deleted it
          </Button>
        </div>
      ) : null}
      <div className="bank-key__pem">
        <button type="button" className="text-link bank-key__fold" aria-expanded={fold} onClick={() => setFold((f) => !f)}>
          {upload.fold}
        </button>
        {fold ? (
          <div className="bank-key__pem-body">
            <p>
              <Rich text={upload.better} />
            </p>
            <div
              className={`upload-box__zone${over ? " is-over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={drop}
            >
              <Icon name="upload" size={26} />
              <p className="upload-box__text">{upload.label}</p>
              <input
                ref={file}
                type="file"
                accept=".pem"
                className="sr-only"
                tabIndex={-1}
                aria-label={upload.label}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void sendFile(f);
                }}
              />
              <Button size="sm" icon="upload" loading={busy === "pem"} onClick={() => file.current?.click()}>
                Pick the file
              </Button>
            </div>
            {problem ? (
              <p className="bank-key__problem" role="alert">
                {problem}
              </p>
            ) : null}
            <button type="button" className="text-link bank-key__fold" aria-expanded={cantPick} onClick={() => setCantPick((c) => !c)}>
              {upload.cantPick}
            </button>
            {cantPick ? (
              <div className="bank-key__pem-paste">
                <label className="bank-key__label" htmlFor={`${id}-pem`}>
                  {upload.pasteLabel}
                </label>
                <textarea ref={pemBox} id={`${id}-pem`} className="input bank-key__paste" rows={4} autoComplete="off" spellCheck={false} data-bank="pem-paste" />
                <p className="bank-key__small">Paste the app ID in App ID above too.</p>
                <Button variant="glass" size="md" icon="check" loading={busy === "pem"} onClick={() => void sendPasted()} aria-label="Save the .pem file">
                  Save
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
