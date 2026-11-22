// What the video analysis agent found in a reference video (docs/CONTRACTS.md §45.28): what happens, the hook and
// its timing, the pacing, every shot (with "Watch from here"), the jokes and the acting without words, the sound
// (from the measured loudness and silences: the model cannot hear), the caption style, what to borrow and what not
// to copy.
import type { ReferenceAnalysis } from "../../api/types.ts";
import { Glass } from "../../glass/index.ts";
import { Btn, clock, Icon } from "../kit.tsx";

const TONES = ["sun", "sky", "mint", "coral"] as const;

export function AnalysisView({ analysis, durationSec, onSeek }: { analysis: ReferenceAnalysis; durationSec: number | null; onSeek: ((sec: number) => void) | null }) {
  const total = Math.max(durationSec ?? 0, ...analysis.shots.map((s) => s.end), 1);
  return (
    <div className="st-ref-analysis">
      <Glass as="section" className="st-ref-block st-ref-block--wide" aria-labelledby="st-ref-what">
        <h2 id="st-ref-what" className="st-ref-block__title">
          What happens
        </h2>
        <p>{analysis.summary}</p>
      </Glass>

      <Glass as="section" className="st-ref-block" aria-labelledby="st-ref-hook">
        <h2 id="st-ref-hook" className="st-ref-block__title">
          The hook
        </h2>
        <p className="st-ref-big">At {clock(analysis.hook.atSec)}</p>
        <p>{analysis.hook.what}</p>
      </Glass>

      <Glass as="section" className="st-ref-block" aria-labelledby="st-ref-pace">
        <h2 id="st-ref-pace" className="st-ref-block__title">
          Pacing
        </h2>
        <p className="st-ref-big">
          {analysis.pacing.cutsPer10s.toLocaleString(undefined, { maximumFractionDigits: 1 })} {analysis.pacing.cutsPer10s === 1 ? "cut" : "cuts"} every 10 seconds
        </p>
        <p>{analysis.pacing.notes}</p>
      </Glass>

      <Glass as="section" className="st-ref-block st-ref-block--wide" aria-labelledby="st-ref-shots">
        <h2 id="st-ref-shots" className="st-ref-block__title">
          Shot by shot
        </h2>
        <div className="st-ref-strip" aria-hidden="true">
          {analysis.shots.map((s, i) => (
            <span key={i} className={`st-ref-strip__shot st-ref-strip__shot--${TONES[i % TONES.length]}`} style={{ flexGrow: Math.max(0.2, (s.end - s.start) / total) }} />
          ))}
        </div>
        <ol className="st-ref-shots">
          {analysis.shots.map((s, i) => (
            <li key={i} className="st-ref-shot">
              <div className="st-ref-shot__head">
                <span className={`st-ref-shot__num st-ref-shot__num--${TONES[i % TONES.length]}`}>{i + 1}</span>
                <span className="st-ref-shot__time">
                  {clock(s.start)} to {clock(s.end)}
                </span>
                {onSeek ? (
                  <Btn quiet className="st-ref-shot__seek" onClick={() => onSeek(s.start)} label={`Watch shot ${i + 1} from ${clock(s.start)}`}>
                    <Icon name="eye" size={18} />
                    Watch
                  </Btn>
                ) : null}
              </div>
              <p className="st-ref-shot__what">{s.what}</p>
              {s.acting ? (
                <p className="st-ref-shot__line">
                  <b>Acting:</b> {s.acting}
                </p>
              ) : null}
              {s.sound ? (
                <p className="st-ref-shot__line">
                  <b>Sound:</b> {s.sound}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      </Glass>

      <Glass as="section" className="st-ref-block" aria-labelledby="st-ref-gags">
        <h2 id="st-ref-gags" className="st-ref-block__title">
          Jokes and acting
        </h2>
        <ul className="st-ref-list">
          {analysis.gags.map((g, i) => (
            <li key={i}>{g}</li>
          ))}
        </ul>
      </Glass>

      <Glass as="section" className="st-ref-block" aria-labelledby="st-ref-sound">
        <h2 id="st-ref-sound" className="st-ref-block__title">
          Sound
        </h2>
        <p>{analysis.sound}</p>
        <p className="st-ref-small">Measured from how loud it is and where it goes quiet. The model cannot hear.</p>
      </Glass>

      <Glass as="section" className="st-ref-block st-ref-block--wide" aria-labelledby="st-ref-captions">
        <h2 id="st-ref-captions" className="st-ref-block__title">
          Captions
        </h2>
        <p>{analysis.captions}</p>
      </Glass>

      <Glass as="section" variant="tinted" tone="var(--st-mint-rgb)" className="st-ref-block st-ref-block--borrow" aria-labelledby="st-ref-borrow">
        <h2 id="st-ref-borrow" className="st-ref-block__title">
          Borrow these
        </h2>
        <ul className="st-ref-list st-ref-list--yes">
          {analysis.borrow.map((g, i) => (
            <li key={i}>
              <Icon name="check" size={18} />
              <span>{g}</span>
            </li>
          ))}
        </ul>
      </Glass>

      <Glass as="section" variant="tinted" tone="var(--st-coral-rgb)" className="st-ref-block st-ref-block--avoid" aria-labelledby="st-ref-avoid">
        <h2 id="st-ref-avoid" className="st-ref-block__title">
          Don't copy these
        </h2>
        <ul className="st-ref-list st-ref-list--no">
          {analysis.avoid.map((g, i) => (
            <li key={i}>
              <Icon name="close" size={18} />
              <span>{g}</span>
            </li>
          ))}
        </ul>
      </Glass>
    </div>
  );
}
