import type { CSSProperties } from "react";
import { useSession } from "../app/session.tsx";
import { useShellHosted } from "../app/shell.ts";
import { Glide } from "./Glide.tsx";
import { setPrefs, usePrefs } from "../lib/prefs.ts";
import { section, useRoute } from "../lib/router.ts";
import { plural } from "../lib/format.ts";
import { useDeletedJobs } from "../lib/jobDeletes.ts";
import { useInstall } from "../lib/pwa.ts";
import { useLiveStatus } from "../lib/live.ts";
import { LiveDot } from "./LiveDot.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { A } from "./ui.tsx";

interface Item {
  key: "home" | "jobs" | "review" | "library" | "money" | "settings";
  href: string;
  label: string;
  icon: IconName;
}

const ITEMS: Item[] = [
  { key: "home", href: "/", label: "Home", icon: "home" },
  { key: "jobs", href: "/jobs", label: "Jobs", icon: "layers" },
  { key: "review", href: "/review", label: "Review", icon: "review" },
  { key: "library", href: "/library", label: "Library", icon: "library" },
  { key: "money", href: "/money", label: "Money", icon: "coin" },
  { key: "settings", href: "/settings", label: "Settings", icon: "settings" },
];

function useNavState() {
  const route = useRoute();
  const { me } = useSession();
  const active = section(route);
  // A job deleted here comes off the counts at once, until the server's own counts include it (§34.5).
  const gone = useDeletedJobs();
  const review = Math.max(0, (me?.counts.review ?? 0) - gone.reviewClips);
  const running = Math.max(0, (me?.counts.running ?? 0) - gone.working);
  const accessible = (item: Item) =>
    item.key === "review" && review > 0 ? `${item.label}, ${plural(review, "clip")} waiting` : item.label;
  return { active, review, running, accessible };
}

function Badge({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="badge" aria-hidden="true">
      {n > 99 ? "99+" : n}
    </span>
  );
}

// .act-turn gives the span its own box (motion.css); only the angle is set here.
const TURN = { "--act-turn": "180deg" } as CSSProperties;
const FLIP: CSSProperties = { display: "inline-grid", transform: "rotate(180deg)" };

/** Larger screens: a glass sidebar that folds down to icons. The choice is remembered on this device. */
export function Sidebar() {
  const { active, review, running, accessible } = useNavState();
  const { sidebarCollapsed } = usePrefs();
  const { installed } = useInstall();
  // Next to Lamo Stories the shell draws the workspace switch and the Live chip for both apps, in this very place
  // (app/WorkspaceDock.tsx, §45.37): the rows under them stay exactly where they are.
  const hosted = useShellHosted();
  const live = useLiveStatus() === "live";
  return (
    <nav className={`sidebar glass glass--refract${sidebarCollapsed ? " is-collapsed" : ""}`} aria-label="Main">
      <div className="sidebar__top">
        <button
          type="button"
          className="icon-btn sidebar__toggle"
          aria-expanded={!sidebarCollapsed}
          aria-controls="sidebar-list"
          aria-label={sidebarCollapsed ? "Expand menu" : "Collapse menu"}
          data-tip={sidebarCollapsed ? "Expand menu" : undefined}
          onClick={() => setPrefs({ sidebarCollapsed: !sidebarCollapsed })}
        >
          {/* §20.11: state-driven, no shot. The wrapper turns 180° with aria-expanded (240 ms, instant under reduced
              motion); the panel glyph is drawn pre-turned so it still reads the right way round when open. */}
          <span className="act-turn sidebar__turn" style={TURN} aria-hidden="true">
            {sidebarCollapsed ? (
              <Icon name="menu" />
            ) : (
              <span style={FLIP}>
                <Icon name="sidebar" />
              </span>
            )}
          </span>
        </button>
        <A href="/" className="brand" aria-label="Clip Factory home">
          <span className="brand__mark" aria-hidden="true">
            C<span className="brand__dot" />
          </span>
          <span className="brand__name">
            Clip <em>Factory</em>
          </span>
        </A>
      </div>
      <ul className="sidebar__list" id="sidebar-list" data-ws-tab-after={hosted ? "" : undefined}>
        <Glide active=".sidebar__item.is-active" className="glide--menu" as="li" />
        {ITEMS.map((item) => (
          <li key={item.key}>
            <A
              href={item.href}
              className={`sidebar__item${active === item.key ? " is-active" : ""}`}
              data-help={`nav-${item.key}`}
              aria-current={active === item.key ? "page" : undefined}
              aria-label={sidebarCollapsed ? accessible(item) : undefined}
              data-tip={sidebarCollapsed ? item.label : undefined}
            >
              <span className="sidebar__icon">
                <Icon name={item.icon} />
                {sidebarCollapsed && item.key === "review" ? <Badge n={review} /> : null}
              </span>
              <span className="sidebar__label">{item.label}</span>
              {!sidebarCollapsed && item.key === "review" && review > 0 ? (
                <span className="sidebar__count" aria-label={`${plural(review, "clip")} waiting`}>
                  {review}
                </span>
              ) : null}
            </A>
          </li>
        ))}
      </ul>
      <div className="sidebar__foot">
        {hosted ? (
          // The room of the Live chip's row the shell draws here, so every row of the foot stays where it was.
          live ? <span className="sidebar__live-room" aria-hidden="true" /> : null
        ) : (
          <span className="sidebar__live">
            <LiveDot compact={sidebarCollapsed} />
          </span>
        )}
        {!installed ? (
          <A
            href="/get-app"
            className={`sidebar__item sidebar__getapp${active === "get_app" ? " is-active" : ""}`}
            aria-current={active === "get_app" ? "page" : undefined}
            aria-label={sidebarCollapsed ? "Get the app" : undefined}
            data-tip={sidebarCollapsed ? "Get the app" : undefined}
          >
            <span className="sidebar__icon">
              <Icon name="download" />
            </span>
            <span className="sidebar__label">Get the app</span>
          </A>
        ) : null}
        {running > 0 ? (
          <A href="/jobs" className="sidebar__status" data-tip={sidebarCollapsed ? `${plural(running, "job")} working` : undefined} aria-label={`${plural(running, "job")} working`}>
            <span className="pulse-dot" aria-hidden="true" />
            <span className="sidebar__label">{plural(running, "job")} working</span>
          </A>
        ) : null}
      </div>
    </nav>
  );
}

/** Phones: a floating glass tab bar with icons only. Names are announced to screen readers and shown on hover. */
export function TabBar() {
  const { active, review, accessible } = useNavState();
  return (
    <nav className="tabbar glass glass--refract" aria-label="Main">
      <ul className="tabbar__list">
        <Glide active=".tabbar__item.is-active" className="glide--tabbar" as="li" />
        {ITEMS.map((item) => (
          <li key={item.key} className="tabbar__cell">
            <A
              href={item.href}
              className={`tabbar__item${active === item.key ? " is-active" : ""}`}
              data-help={`nav-${item.key}`}
              aria-current={active === item.key ? "page" : undefined}
              aria-label={accessible(item)}
              title={item.label}
            >
              <Icon name={item.icon} size={24} />
              {item.key === "review" ? <Badge n={review} /> : null}
            </A>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The rows the sidebar foot shows under the Live chip: Get the app (until the app is installed) and the jobs line
 * (while jobs are working), from the same state the sidebar draws them from. Next to Lamo Stories the shell's
 * workspace switch and Live chip sit right above them in both apps (app/WorkspaceDock.tsx, §45.37), so it reads them
 * here. `known`: the session's first answer is in (until then the counts are not the owner's yet).
 */
export function useFootRows(): { getApp: boolean; jobs: boolean; known: boolean } {
  const { running } = useNavState();
  const { installed } = useInstall();
  const { me } = useSession();
  return { getApp: !installed, jobs: running > 0, known: me !== null };
}
