// Settings > Look & feel > Sounds (docs/CONTRACTS.md §15.3): the sound picker the owner liked, in the app's glass.
// Tapping a card plays it and picks it; "Try it: Sign in" plays the two picks on a pretend button. While Sounds is
// off nothing is picked or "tried" silently: the tap says sounds are off and offers to turn them on.
import { useId, useRef, useState, type MouseEvent } from "react";
import { useSession } from "../../app/session.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button } from "../../components/ui.tsx";
import { usePrefs } from "../../lib/prefs.ts";
import type { SoundKind } from "../../lib/sound.ts";
import { CLICK_SOUNDS, ERROR_SOUNDS, recipeFor, type SoundRecipe } from "../../lib/soundCatalog.ts";
import { sounds } from "../../lib/sounds.ts";
import { Apple, AppleSwitch, Panel } from "./parts.tsx";

/** Restarts a one-shot CSS animation class on an element (the card's pulse, the button's shake). */
function replay(el: HTMLElement, cls: string) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

/** One practice toast at a time, short, so they never pile up over the panel. */
const PRACTICE = { group: "sounds-practice", ms: 2600 } as const;

export function SoundsBranch() {
  const { me, saveSettings } = useSession();
  const prefs = usePrefs();
  const on = me?.settings.soundEnabled ?? prefs.soundEnabled;
  const click = me?.settings.clickSound ?? prefs.clickSound;
  const error = me?.settings.errorSound ?? prefs.errorSound;
  // The device copy of soundEnabled flips before the save is sent, so the click sound can answer straight away
  // (still inside the tap, which is what lets iOS play it): you hear that sounds are back.
  const turnOn = (target: HTMLElement) => {
    void saveSettings({ soundEnabled: true });
    sounds.play("tap", target);
  };

  return (
    <>
      <Panel>
        <Apple id="sounds-on">
          <AppleSwitch apple="sounds-on" checked={on} onChange={(v) => void saveSettings({ soundEnabled: v })} />
        </Apple>
      </Panel>

      <TryIt click={recipeFor("tap", click)} error={recipeFor("deny", error)} soundsOn={on} onTurnOn={turnOn} />

      <SoundGroup
        apple="click-sound"
        kind="tap"
        title="When it works"
        list={CLICK_SOUNDS}
        picked={click}
        soundsOn={on}
        onTurnOn={turnOn}
        onPick={(id) => void saveSettings({ clickSound: id })}
      />
      <SoundGroup
        apple="error-sound"
        kind="deny"
        title="When it can't"
        list={ERROR_SOUNDS}
        picked={error}
        soundsOn={on}
        onTurnOn={turnOn}
        onPick={(id) => void saveSettings({ errorSound: id })}
      />
    </>
  );
}

function SoundGroup({
  apple,
  kind,
  title,
  list,
  picked,
  soundsOn,
  onTurnOn,
  onPick,
}: {
  apple: "click-sound" | "error-sound";
  kind: SoundKind;
  title: string;
  list: readonly SoundRecipe[];
  picked: number;
  soundsOn: boolean;
  onTurnOn: (target: HTMLElement) => void;
  onPick: (id: number) => void;
}) {
  const toast = useToast();
  const label = kind === "tap" ? "Click sound" : "Error sound";
  function tap(e: MouseEvent<HTMLButtonElement>, sound: SoundRecipe) {
    // With Sounds off a tap cannot be heard, so it does not pick a sound you never heard.
    if (!soundsOn) {
      toast.info("Sounds are off. Turn them on to hear it first.", PRACTICE);
      return;
    }
    // The card plays its own sound (data-sound="off" keeps the usual click sound out of the way).
    sounds.play(kind, e.currentTarget, sound.id);
    replay(e.currentTarget, "is-playing");
    if (sound.id !== picked) onPick(sound.id);
  }
  return (
    <Panel className={`sound-group is-${kind}`}>
      <Apple id={apple} title={title} wide>
        {!soundsOn ? <SoundsOffNote onTurnOn={onTurnOn} /> : null}
        <ul className="sound-grid" aria-label={`${label}s`}>
          {list.map((sound) => {
            const chosen = sound.id === picked;
            return (
              <li key={sound.id}>
                <button
                  type="button"
                  className={`sound-card${chosen ? " is-picked" : ""}`}
                  aria-pressed={chosen}
                  aria-label={`${label} ${sound.id}: ${sound.name}. ${sound.feel}.`}
                  data-sound="off"
                  data-sound-id={sound.id}
                  onClick={(e) => tap(e, sound)}
                >
                  <span className="sound-card__num" aria-hidden="true">
                    {sound.id}
                  </span>
                  <span className="sound-card__name">{sound.name}</span>
                  <span className="sound-card__feel">{sound.feel}</span>
                  {chosen ? (
                    <span className="sound-card__badge" aria-hidden="true">
                      <Icon name="check" size={13} strokeWidth={2.6} />
                      Pick
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </Apple>
    </Panel>
  );
}

function SoundsOffNote({ onTurnOn }: { onTurnOn: (target: HTMLElement) => void }) {
  return (
    <div className="sounds-off" role="note">
      <Icon name="volume" size={20} />
      <p className="sounds-off__text">
        <strong>Sounds are off.</strong> Turn them on to hear a sound when you tap it.
      </p>
      {/* data-sound="off": it plays the click sound itself, once sounds are on. */}
      <Button size="sm" icon="volume" data-sound="off" onClick={(e) => onTurnOn(e.currentTarget)}>
        Turn sounds on
      </Button>
    </div>
  );
}

function TryIt({
  click,
  error,
  soundsOn,
  onTurnOn,
}: {
  click: SoundRecipe;
  error: SoundRecipe;
  soundsOn: boolean;
  onTurnOn: (target: HTMLElement) => void;
}) {
  const toast = useToast();
  const [fail, setFail] = useState(false);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);

  function tryIt() {
    // Nothing to hear: say why, rather than a silent pretend sign-in.
    if (!soundsOn) {
      toast.info("Sounds are off. Turn them on to hear it.", PRACTICE);
      return;
    }
    // Plays the pick by itself (data-sound="off"), so a failed try is only the error sound, never both.
    sounds.play(fail ? "deny" : "tap", button.current);
    if (fail) {
      if (button.current) replay(button.current, "is-shaking");
      toast.error("Wrong password. Try again.", PRACTICE);
    } else {
      toast.success("Signed in", PRACTICE);
    }
  }

  return (
    <Panel className="try-it">
      <Apple id="try-sounds">
        <div className="try-it__controls">
          <div className="try-it__fail">
            <span className="try-it__fail-label" id={`${id}-fail`}>
              Make it fail
            </span>
            <button
              type="button"
              role="switch"
              className="switch"
              aria-checked={fail}
              aria-labelledby={`${id}-fail`}
              onClick={() => setFail((f) => !f)}
            >
              <span className="switch__thumb" />
            </button>
          </div>
          <Button ref={button} variant="primary" icon="key" data-sound="off" onClick={tryIt}>
            Try it: Sign in
          </Button>
        </div>
      </Apple>
      {!soundsOn ? <SoundsOffNote onTurnOn={onTurnOn} /> : null}
      <p className="try-it__picks" aria-live="polite">
        <span className="try-it__pick is-tap">
          <span className="try-it__dot" aria-hidden="true" />
          Click {click.id}: {click.name}
        </span>
        <span className="try-it__pick is-deny">
          <span className="try-it__dot" aria-hidden="true" />
          Error {error.id}: {error.name}
        </span>
      </p>
    </Panel>
  );
}
