// Settings as a tree (docs/CONTRACTS.md §15): the field (all of Settings, with "Find a setting"), the trees, their
// branches, and on each branch the apples (settings) with their leaves (help). Phones drill down page by page with
// a big Back button; from 1024 px a folder panel on the left shows the whole tree.
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "../../components/Icon.tsx";
import { A, PageHeader } from "../../components/ui.tsx";
import { plural } from "../../lib/format.ts";
import { prefersReducedMotion, setPrefs, usePrefs } from "../../lib/prefs.ts";
import { useInstall } from "../../lib/pwa.ts";
import { navigate, useHash, type Route } from "../../lib/router.ts";
import {
  appleCount,
  findBranch,
  findTree,
  searchSettings,
  settingsPath,
  visibleTrees,
  type Branch,
  type SearchHit,
  type Tree,
} from "../../lib/settingsTree.ts";
import {
  AccountBranch,
  AccountsBranch,
  BackgroundBranch,
  ClipsBranch,
  GetAppBranch,
  MotionBranch,
  UpdatesBranch,
  WhereBranch,
  YoutubeBranch,
} from "./branches.tsx";
import { Trail } from "./parts.tsx";
import { SkillScreen } from "./SkillPages.tsx";
import { SkillsSection } from "./SkillsSection.tsx";
import { SoundsBranch } from "./SoundsBranch.tsx";

export { comingSoonPlatform } from "./branches.tsx";

/** What each branch page shows, by `tree/branch`. */
const BRANCHES: Record<string, () => ReactNode> = {
  "clip-making/clips": () => <ClipsBranch />,
  "clip-making/skills": () => <SkillsSection />,
  "clip-making/youtube": () => <YoutubeBranch />,
  "posting/accounts": () => <AccountsBranch />,
  "posting/where": () => <WhereBranch />,
  "look-and-feel/sounds": () => <SoundsBranch />,
  "look-and-feel/motion": () => <MotionBranch />,
  "look-and-feel/background": () => <BackgroundBranch />,
  "app/get-the-app": () => <GetAppBranch />,
  "app/updates": () => <UpdatesBranch />,
  "app/account": () => <AccountBranch />,
};

/** Every branch route in the tree, for tests: each must have a page. */
export const BRANCH_ROUTES = Object.keys(BRANCHES);

export function Settings({
  tree: treeSlug = null,
  branch: branchSlug = null,
  skill = null,
}: {
  tree?: string | null;
  branch?: string | null;
  /** A page under the Skills branch (§18.7): new, read or edit. */
  skill?: Omit<Extract<Route, { name: "skill" }>, "name"> | null;
}) {
  const { installed } = useInstall();
  const trees = useMemo(() => visibleTrees(installed), [installed]);
  if (skill) {
    treeSlug = "clip-making";
    branchSlug = "skills";
  }
  const tree = treeSlug ? findTree(treeSlug) : undefined;
  const branch = tree && branchSlug ? findBranch(tree, branchSlug) : undefined;

  return (
    <div className="page settings">
      <div className="settings-layout">
        <FolderPanel trees={trees} tree={tree?.slug ?? null} branch={branch?.slug ?? null} installed={installed} />
        <div className="settings-content">
          {skill && tree && branch ? (
            <SkillScreen tree={tree} branch={branch} mode={skill.mode} skillId={skill.skillId} />
          ) : tree && branch ? (
            <BranchPage tree={tree} branch={branch} />
          ) : tree ? (
            <TreePage tree={trees.find((t) => t.slug === tree.slug) ?? tree} />
          ) : (
            <FieldPage trees={trees} installed={installed} />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- The field: all of Settings ----------

function FieldPage({ trees, installed }: { trees: Tree[]; installed: boolean }) {
  return (
    <>
      <PageHeader
        title={
          <>
            Make it <em>yours</em>.
          </>
        }
        lede="How your clips are made, where they go, and how the app looks and sounds."
      />
      <FindSetting installed={installed} />
      <ul className="tree-cards" aria-label="Settings groups">
        {trees.map((t) => (
          <li key={t.slug}>
            <A href={settingsPath(t.slug)} className="tree-card glass">
              <span className="tree-card__icon" aria-hidden="true">
                <Icon name={t.icon} size={26} />
              </span>
              <span className="tree-card__text">
                <span className="tree-card__name">{t.name}</span>
                <span className="tree-card__line">{t.line}</span>
                <span className="tree-card__count">
                  {plural(appleCount(t), "setting")} · {t.branches.map((b) => b.name).join(", ")}
                </span>
              </span>
              <Icon name="chevronRight" size={22} className="icon tree-card__go" />
            </A>
          </li>
        ))}
      </ul>
    </>
  );
}

/** How many results "Find a setting" lists at most. */
const MAX_HITS = 8;

/**
 * The search box over every apple and leaf. Its results are a listbox: Up and Down move through them, Enter opens
 * the one marked (or the best match), Escape clears, and a tap opens one. `compact` is the folder panel's copy.
 */
function FindSetting({ installed, compact = false }: { installed: boolean; compact?: boolean }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const id = useId();
  const hits = useMemo(() => searchSettings(query, installed).slice(0, MAX_HITS), [query, installed]);
  const typed = query.trim().length > 0;
  const open = typed && hits.length > 0;
  const optionId = (i: number) => `${id}-hit-${i}`;

  function go(hit: SearchHit | undefined) {
    if (!hit) return;
    setQuery("");
    setActive(-1);
    navigate(hit.href);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    go(hits[active] ?? hits[0]);
  }

  function keys(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      if (!query) return;
      e.preventDefault();
      setQuery("");
      setActive(-1);
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && open) {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i < 0 ? (step > 0 ? 0 : hits.length - 1) : (i + step + hits.length) % hits.length));
    }
  }

  // Keeps the marked result in view in a short panel.
  useEffect(() => {
    if (active >= 0) document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return (
    <div className={`find${compact ? " find--compact" : " glass"}`} role="search" aria-label="Search settings">
      <form className="find__form" onSubmit={submit}>
        <label className={compact ? "sr-only" : "find__label"} htmlFor={`${id}-q`}>
          Find a setting
        </label>
        <div className="find__box">
          <Icon name="search" size={20} />
          <input
            id={`${id}-q`}
            className="find__input"
            type="search"
            role="combobox"
            value={query}
            placeholder={compact ? "Find a setting" : "Try “sound” or “skills”"}
            autoComplete="off"
            enterKeyHint="go"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-describedby={`${id}-status`}
            aria-controls={`${id}-results`}
            aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(-1);
            }}
            onKeyDown={keys}
          />
          {typed ? (
            <button
              type="button"
              className="find__clear"
              aria-label="Clear the search"
              onClick={() => {
                setQuery("");
                setActive(-1);
              }}
            >
              <Icon name="x" size={18} />
            </button>
          ) : null}
        </div>
      </form>
      <p className={typed ? "find__status" : "sr-only"} id={`${id}-status`} role="status">
        {!typed ? "" : hits.length ? `${plural(hits.length, "setting")} found. Tap one to go there.` : `Nothing found for “${query.trim()}”. Try a shorter word, like “sound”.`}
      </p>
      <ul className="find__results" id={`${id}-results`} role="listbox" aria-label="Settings found" hidden={!open}>
        {open
          ? hits.map((hit, i) => <FindResult key={hit.apple.id} id={optionId(i)} hit={hit} active={i === active} onOpen={() => go(hit)} />)
          : null}
      </ul>
    </div>
  );
}

function FindResult({ id, hit, active, onOpen }: { id: string; hit: SearchHit; active: boolean; onOpen: () => void }) {
  return (
    // Picked with the pointer here, and with the keyboard from the search box (aria-activedescendant).
    <li id={id} role="option" aria-selected={active} className={`find-hit${active ? " is-active" : ""}`} onClick={onOpen}>
      <span className="find-hit__icon" aria-hidden="true">
        <Icon name={hit.branch.icon} size={20} />
      </span>
      <span className="find-hit__text">
        <span className="find-hit__name">{hit.apple.name}</span>
        <span className="find-hit__path">
          {hit.tree.name} › {hit.branch.name}
        </span>
        <span className={`find-hit__leaf${hit.found === "leaf" ? " is-match" : ""}`}>{hit.apple.leaf}</span>
      </span>
      <Icon name="chevronRight" size={20} className="icon find-hit__go" />
    </li>
  );
}

// ---------- A tree: its branches ----------

function TreePage({ tree }: { tree: Tree }) {
  return (
    <>
      <Trail tree={tree} />
      <header className="page-head settings-head">
        <div className="page-head__text">
          <h1 className="page-head__title">{tree.name}</h1>
          <p className="page-head__lede">{tree.line}</p>
        </div>
      </header>
      <ul className="branch-cards" aria-label={`${tree.name} sections`}>
        {tree.branches.map((b) => (
          <li key={b.slug}>
            <A href={settingsPath(tree.slug, b.slug)} className="branch-card glass">
              <span className="branch-card__icon" aria-hidden="true">
                <Icon name={b.icon} size={22} />
              </span>
              <span className="branch-card__text">
                <span className="branch-card__name">{b.name}</span>
                <span className="branch-card__line">{b.line}</span>
                <span className="branch-card__apples">{b.apples.map((a) => a.name).join(" · ")}</span>
              </span>
              <Icon name="chevronRight" size={20} className="icon branch-card__go" />
            </A>
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------- A branch: its apples ----------

/** The found apple lights up for 2 seconds, once the page has had a moment to draw. */
const SHOW_AFTER_MS = 120;
const FOUND_MS = 2000;

function BranchPage({ tree, branch }: { tree: Tree; branch: Branch }) {
  const hash = useHash();
  const body = useRef<HTMLDivElement>(null);
  const render = BRANCHES[`${tree.slug}/${branch.slug}`];

  // "Find a setting" (and old links) land here with #apple: bring it into view, light it up, and focus it.
  useEffect(() => {
    if (!hash) return;
    let el: HTMLElement | null = null;
    const show = setTimeout(() => {
      el = document.getElementById(hash);
      if (!el || !body.current?.contains(el)) return;
      // A tall apple (a grid of 30 sound cards) goes to the top, so its name and leaf stay on screen; a short one
      // sits in the middle.
      const tall = el.getBoundingClientRect().height > window.innerHeight * 0.6;
      el.scrollIntoView({ block: tall ? "start" : "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      el.classList.remove("is-found");
      void el.offsetWidth;
      el.classList.add("is-found");
      el.focus({ preventScroll: true });
    }, SHOW_AFTER_MS);
    const fade = setTimeout(() => el?.classList.remove("is-found"), SHOW_AFTER_MS + FOUND_MS);
    return () => {
      clearTimeout(show);
      clearTimeout(fade);
      el?.classList.remove("is-found");
    };
  }, [hash, branch.slug]);

  return (
    <>
      <Trail tree={tree} branch={branch} />
      <header className="page-head settings-head">
        <div className="page-head__text">
          <h1 className="page-head__title">{branch.name}</h1>
          <p className="page-head__lede">{branch.line}</p>
        </div>
      </header>
      <div className="branch-body" ref={body}>
        {render?.()}
      </div>
    </>
  );
}

// ---------- The folder panel (1024 px and wider) ----------

/** The trees that start shut on a first visit: every one but the tree you are in. */
function firstVisitClosed(trees: readonly Tree[], tree: string | null): string[] {
  return trees.map((t) => t.slug).filter((slug) => slug !== tree);
}

/** The rows the arrow keys move between, top to bottom: All settings, each folder, and the branches in open folders. */
const ROWS = ".folders__home, .folders__toggle, .folders__branches:not([hidden]) .folders__branch";

function FolderPanel({
  trees,
  tree,
  branch,
  installed,
}: {
  trees: Tree[];
  tree: string | null;
  branch: string | null;
  installed: boolean;
}) {
  const { closedTrees, foldersSet } = usePrefs();
  const id = useId();
  const nav = useRef<HTMLElement>(null);
  const closed = foldersSet ? closedTrees : firstVisitClosed(trees, tree);

  // A first visit opens only the current tree, and remembers that. After that, going into a tree opens its folder,
  // so the current page is always visible in the panel.
  useEffect(() => {
    if (!foldersSet) setPrefs({ closedTrees: firstVisitClosed(trees, tree), foldersSet: true });
    else if (tree && closedTrees.includes(tree)) setPrefs({ closedTrees: closedTrees.filter((t) => t !== tree) });
    // Only when the page changes: folding the current tree shut afterwards is the owner's choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree]);

  const setOpen = (slug: string, open: boolean) => {
    if (open === !closed.includes(slug)) return;
    setPrefs({ closedTrees: open ? closed.filter((t) => t !== slug) : [...closed, slug], foldersSet: true });
  };

  // Arrow Up and Down move between rows, Right opens a folder (or steps into it), Left closes it (or steps out to
  // it from a branch), Home and End jump to the first and last row. Enter follows a link as usual.
  function keys(e: KeyboardEvent<HTMLElement>) {
    const row = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>(ROWS) : null;
    if (!row || !nav.current?.contains(row)) return;
    const rows = Array.from(nav.current.querySelectorAll<HTMLElement>(ROWS));
    const at = rows.indexOf(row);
    const folder = row.closest<HTMLElement>(".folders__tree");
    const slug = folder?.dataset.tree;
    const toggle = folder?.querySelector<HTMLElement>(".folders__toggle");
    let next: HTMLElement | undefined;
    if (e.key === "ArrowDown") next = rows[Math.min(at + 1, rows.length - 1)];
    else if (e.key === "ArrowUp") next = rows[Math.max(at - 1, 0)];
    else if (e.key === "Home") next = rows[0];
    else if (e.key === "End") next = rows[rows.length - 1];
    else if (e.key === "ArrowRight" && slug && row === toggle) {
      if (closed.includes(slug)) setOpen(slug, true);
      else next = folder?.querySelector<HTMLElement>(".folders__branch") ?? undefined;
    } else if (e.key === "ArrowLeft" && slug) {
      if (row === toggle) setOpen(slug, false);
      else next = toggle ?? undefined;
    } else return;
    e.preventDefault();
    next?.focus();
  }

  return (
    <nav className="folders glass" aria-label="Settings sections" ref={nav} onKeyDown={keys}>
      {/* The field has its own search box at the top; elsewhere the panel carries one. */}
      {tree ? <FindSetting installed={installed} compact /> : null}
      <A href={settingsPath()} className={`folders__home${!tree ? " is-current" : ""}`} aria-current={!tree ? "page" : undefined}>
        <Icon name="settings" size={20} />
        <span>All settings</span>
      </A>
      <ul className="folders__trees">
        {trees.map((t) => {
          const open = !closed.includes(t.slug);
          const here = tree === t.slug;
          return (
            <li key={t.slug} data-tree={t.slug} className={`folders__tree${open ? " is-open" : ""}${here ? " is-here" : ""}`}>
              <button
                type="button"
                className="folders__toggle"
                aria-expanded={open}
                aria-controls={`${id}-${t.slug}`}
                onClick={() => setOpen(t.slug, !open)}
              >
                <Icon name="chevronRight" size={16} className="icon folders__chevron" />
                <Icon name={t.icon} size={20} />
                <span className="folders__name" title={t.name}>
                  {t.name}
                </span>
              </button>
              <ul className="folders__branches" id={`${id}-${t.slug}`} hidden={!open}>
                {t.branches.map((b) => {
                  const current = here && branch === b.slug;
                  return (
                    <li key={b.slug}>
                      <A
                        href={settingsPath(t.slug, b.slug)}
                        className={`folders__branch${current ? " is-current" : ""}`}
                        aria-current={current ? "page" : undefined}
                        title={b.name}
                      >
                        <Icon name={b.icon} size={18} />
                        <span>{b.name}</span>
                      </A>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
