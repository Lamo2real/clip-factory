import { useSession } from "../app/session.tsx";
import { setPrefs, usePrefs } from "../lib/prefs.ts";
import { section, useRoute } from "../lib/router.ts";
import { plural } from "../lib/format.ts";
import { useInstall } from "../lib/pwa.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { A } from "./ui.tsx";

interface Item {
  key: "home" | "jobs" | "review" | "library" | "settings";
  href: string;
  label: string;
  icon: IconName;
}

const ITEMS: Item[] = [
  { key: "home", href: "/", label: "Home", icon: "home" },
  { key: "jobs", href: "/jobs", label: "Jobs", icon: "layers" },
  { key: "review", href: "/review", label: "Review", icon: "review" },
  { key: "library", href: "/library", label: "Library", icon: "library" },
  { key: "settings", href: "/settings", label: "Settings", icon: "settings" },
];

function useNavState() {
  const route = useRoute();
  const { me } = useSession();
  const active = section(route);
  const review = me?.counts.review ?? 0;
  const running = me?.counts.running ?? 0;
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

/** Larger screens: a glass sidebar that folds down to icons. The choice is remembered on this device. */
export function Sidebar() {
  const { active, review, running, accessible } = useNavState();
  const { sidebarCollapsed } = usePrefs();
  const { installed } = useInstall();
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
          <Icon name={sidebarCollapsed ? "menu" : "sidebar"} />
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
      <ul className="sidebar__list" id="sidebar-list">
        {ITEMS.map((item) => (
          <li key={item.key}>
            <A
              href={item.href}
              className={`sidebar__item${active === item.key ? " is-active" : ""}`}
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
        {ITEMS.map((item) => (
          <li key={item.key} className="tabbar__cell">
            <A
              href={item.href}
              className={`tabbar__item${active === item.key ? " is-active" : ""}`}
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
