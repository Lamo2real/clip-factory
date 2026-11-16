// Home's "Set up posting · 2 of 5 ready" card (docs/CONTRACTS.md §17.1): a ring, the next platform to do, and
// Continue. It shows while any platform in Where clips go is not ready, and leaves once they all are. It is never
// Home's tomato button (Make clips is).
import { useSession } from "../../app/session.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { ProgressRing } from "../../components/ProgressRing.tsx";
import { LinkButton } from "../../components/ui.tsx";
import { stateLine } from "../../lib/setupProgress.ts";
import { GUIDES, SETUP_ORDER } from "../../setup/index.ts";
import { useSetup } from "../settings/setup/useSetup.ts";

export function SetupCard() {
  const { data } = useSetup();
  const { me } = useSession();
  if (!data || !me) return null;
  const enabled = me.settings.platforms;
  const next = SETUP_ORDER.find((p) => enabled.includes(p) && !data.platforms.find((x) => x.platform === p)?.ready);
  if (!next) return null;
  const setup = data.platforms.find((x) => x.platform === next);
  return (
    <section className="setup-home glass" aria-labelledby="setup-home-title">
      <ProgressRing value={data.ready / 5} size={64} label={`${data.ready} of 5 platforms ready`}>
        {data.ready}/5
      </ProgressRing>
      <div className="setup-home__text">
        {/* The " · " dots hold on to the words before them (a no-break space), so a narrow phone breaks after a dot,
            never leaving one alone at the start of a line. */}
        <h2 className="setup-home__title" id="setup-home-title">
          Set up posting{"\u00a0· "}
          <span className="nowrap">{data.ready} of 5 ready</span>
        </h2>
        <p className="setup-home__next">
          <span className={`setup-home__mark is-${next}`}>
            <PlatformMark platform={next} size={16} />
          </span>
          <span>Next: {GUIDES[next].name}{"\u00a0· "}</span>
          <span className="setup-home__state">{stateLine(GUIDES[next], setup)}</span>
        </p>
        <p className="setup-home__lede">Do each one once. After that Clip Factory posts by itself.</p>
      </div>
      <LinkButton href={`/settings/posting/setup/${next}`} size="md" iconAfter="chevronRight" className="setup-home__go">
        Continue
      </LinkButton>
    </section>
  );
}
