// The paste boxes for a platform's keys (docs/CONTRACTS.md §17.1, §17.4): a Paste button on each box, a format
// check while typing with a friendly sentence under the box, Google's downloaded JSON fills both boxes, and a Login
// URL gives its Configuration ID. After Save keys the values leave the browser: only masked hints come back.
import { useId, useRef, useState, type DragEvent } from "react";
import { api } from "../../../api/index.ts";
import { friendlyMessage } from "../../../api/errors.ts";
import type { KeyCheck, KeyName, Platform, PlatformSetup } from "../../../api/types.ts";
import { Icon } from "../../../components/Icon.tsx";
import { useToast } from "../../../components/Toasts.tsx";
import { Button, Pill } from "../../../components/ui.tsx";
import { useAction } from "../../../lib/motion.ts";
import { usePickAction } from "../parts.tsx";
import { keyNames, keyProblem, keysBody, keysReady, KEY_LABEL, parseGoogleClientJson } from "../../../lib/keyFormats.ts";
import { readClipboard } from "./bits.tsx";

type Values = Partial<Record<KeyName, string>>;

export function KeyForm({
  platform,
  setup,
  primary,
  onSaved,
}: {
  platform: Platform;
  setup: PlatformSetup;
  /** Save keys is this screen's vermilion button. */
  primary: boolean;
  onSaved: (setup: PlatformSetup) => void;
}) {
  const toast = useToast();
  const id = useId();
  const names = keyNames(platform);
  const [values, setValues] = useState<Values>({});
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const pick = usePickAction("upload");
  // Save keys is a submit button: the tick pops at the tap, and a refused key plays the failure (§20.5).
  const saveAct = useAction("save");
  const showForm = editing || !setup.keys.saved;
  const ready = keysReady(platform, values);

  /** A value arrives in one box; Google's whole JSON file fills both boxes. */
  function set(name: KeyName, raw: string) {
    if (platform === "youtube") {
      const json = parseGoogleClientJson(raw);
      if (json) {
        setValues((v) => ({ ...v, ...json }));
        toast.success("Both boxes filled in from Google's file.");
        return;
      }
    }
    setValues((v) => ({ ...v, [name]: raw }));
  }

  /** Pastes into one box; false when the browser would not share what was copied (the owner pastes by hand). */
  async function paste(name: KeyName) {
    const text = await readClipboard();
    if (text === null) {
      toast.info("Tap the box, then paste: hold your finger on it, or press Ctrl+V (Cmd+V on a Mac).");
      document.getElementById(`${id}-${name}`)?.focus();
      return false;
    }
    set(name, text);
    return true;
  }

  async function readJsonFile(f: File, picked = false) {
    if (picked) pick.play();
    const failed = (message: string) => {
      if (picked) pick.fail({ sound: false });
      toast.error(message);
    };
    if (f.size > 64 * 1024) return failed("That file is too big. Pick the client_secret … .json file Google gave you.");
    const json = parseGoogleClientJson(await f.text());
    if (!json) return failed("That is not Google's key file. Pick the client_secret … .json file, or paste the two values.");
    setValues((v) => ({ ...v, ...json }));
    toast.success("Both boxes filled in from Google's file.");
  }

  function drop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) void readJsonFile(f);
    else {
      const text = e.dataTransfer.getData("text/plain");
      if (text) set("clientId", text);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const next = await api().saveSetupKeys(platform, keysBody(platform, values));
      // The keys now live only on the server: forget them here.
      setValues({});
      setEditing(false);
      toast.success("Keys saved.");
      onSaved(next);
    } catch (e) {
      saveAct.fail({ sound: false });
      toast.error(friendlyMessage(e));
    } finally {
      setSaving(false);
    }
  }

  if (!showForm) {
    return (
      <div className="key-saved">
        <div className="key-saved__head">
          <Pill tone="success" icon="check">
            Keys saved
          </Pill>
        </div>
        <dl className="key-saved__list">
          {names.map((n) => (
            <div key={n} className="key-saved__row">
              <dt>{KEY_LABEL[platform][n]}</dt>
              <dd>
                <code>{setup.keys.hints?.[n] ?? "••••"}</code>
              </dd>
            </div>
          ))}
        </dl>
        <CheckIt platform={platform} check={setup.keys.check} onChecked={onSaved} />
        <Button size="sm" variant="ghost" icon="key" onClick={() => setEditing(true)}>
          Change keys
        </Button>
      </div>
    );
  }

  return (
    <form
      className={`key-form${dragging ? " is-dragging" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !saving) void save();
      }}
      onDragOver={(e) => {
        if (platform !== "youtube") return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={platform === "youtube" ? drop : undefined}
      autoComplete="off"
    >
      {names.map((n) => {
        const value = values[n] ?? "";
        const problem = keyProblem(platform, n, value);
        const ok = !!value && !problem;
        return (
          <div className="field key-field" key={n}>
            <label className="field__label" htmlFor={`${id}-${n}`}>
              {KEY_LABEL[platform][n]}
            </label>
            <div className="key-field__row">
              <input
                id={`${id}-${n}`}
                className="input key-field__input"
                value={value}
                onChange={(e) => set(n, e.target.value)}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                inputMode="text"
                data-1p-ignore
                data-lpignore="true"
                placeholder={`Paste the ${KEY_LABEL[platform][n]}`}
                aria-invalid={problem ? true : undefined}
                aria-describedby={`${id}-${n}-status`}
              />
              <Button size="sm" icon="paste" act="paste" onClick={() => paste(n)} aria-label={`Paste the ${KEY_LABEL[platform][n]}`}>
                Paste
              </Button>
            </div>
            <p className={`field__status${problem ? " is-bad" : ok ? " is-ok" : ""}`} id={`${id}-${n}-status`} role={problem ? "alert" : undefined}>
              {problem ? (
                <>
                  <Icon name="alert" size={16} />
                  {problem}
                </>
              ) : ok ? (
                <>
                  <Icon name="check" size={16} />
                  Looks right.
                </>
              ) : null}
            </p>
          </div>
        );
      })}
      {platform === "youtube" ? (
        <div className="key-form__file">
          <input
            ref={file}
            type="file"
            accept=".json,application/json"
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void readJsonFile(f, true);
              e.target.value = "";
            }}
          />
          <Button size="sm" variant="ghost" icon="file" act={pick} playOnClick={false} onClick={() => file.current?.click()}>
            Use the key file from Google
          </Button>
        </div>
      ) : null}
      <div className="key-form__actions">
        <Button type="submit" variant={primary ? "primary" : "action"} size="lg" icon="check" act={saveAct} loading={saving} disabled={!ready}>
          Save keys
        </Button>
        {setup.keys.saved ? (
          <Button size="sm" variant="ghost" icon="x" onClick={() => setEditing(false)}>
            Keep the saved keys
          </Button>
        ) : null}
      </div>
      {!ready ? <p className="key-form__hint">Save keys works once every box says Looks right.</p> : null}
    </form>
  );
}

/** Check it: asks the platform whether the saved keys (and the connection) work. */
export function CheckIt({
  platform,
  check,
  onChecked,
}: {
  platform: Platform;
  check?: KeyCheck;
  onChecked: (setup: PlatformSetup) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  /** Asks the platform; false when the keys or the connection do not work (the button plays its failure). */
  async function run() {
    setBusy(true);
    try {
      const out = await api().checkSetup(platform);
      if (out.check.ok) toast.success(out.check.message);
      else toast.error(out.check.message);
      onChecked(out.setup);
      return out.check.ok;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="check-it">
      <Button size="sm" icon="shield" act="check" loading={busy} onClick={() => run()}>
        Check it
      </Button>
      {check ? (
        <p className={`check-it__result${check.ok ? " is-ok" : " is-bad"}`} role="status">
          <Icon name={check.ok ? "checkCircle" : "alert"} size={18} />
          <span>{check.message}</span>
        </p>
      ) : null}
    </div>
  );
}
