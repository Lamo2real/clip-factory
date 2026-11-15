// Settings as a tree (docs/CONTRACTS.md §15.1), in the owner's words: the field is all of Settings, the trees are a
// few big groups, each tree has branches (sections), each branch has apples (the settings you change) and every
// apple has a leaf (one short line of help). This file is only the map: names, routes and words. The screens that
// draw each branch live in screens/settings/.
import type { IconName } from "../components/Icon.tsx";

export interface Apple {
  /** Anchor on the branch page (`/settings/look-and-feel/sounds#click-sound`). Unique across all of Settings. */
  id: string;
  name: string;
  /** One short line of help, shown under the apple. */
  leaf: string;
  /** Other everyday words people might search for. */
  words?: string[];
}

export interface Branch {
  slug: string;
  name: string;
  /** One line on the branch card. */
  line: string;
  icon: IconName;
  apples: Apple[];
  /** Hidden where it makes no sense (Get the app once the app is installed). */
  onlyWhenNotInstalled?: boolean;
}

export interface Tree {
  slug: string;
  name: string;
  line: string;
  icon: IconName;
  branches: Branch[];
}

export const TREES: Tree[] = [
  {
    slug: "clip-making",
    name: "Clip making",
    line: "How your clips are made.",
    icon: "scissors",
    branches: [
      {
        slug: "clips",
        name: "Clips",
        line: "How many clips, and how long a video can be.",
        icon: "layers",
        apples: [
          {
            id: "clip-count",
            name: "How many clips",
            leaf: "Clip Factory makes between your fewest and most clips each time.",
            words: ["number", "fewest", "most", "amount"],
          },
          {
            id: "longest-video",
            name: "Longest video",
            leaf: "For a longer video, only the first part is used.",
            words: ["hours", "stream", "length", "source"],
          },
        ],
      },
      {
        slug: "skills",
        name: "Skills",
        line: "Teach Clip Factory how you like your clips.",
        icon: "file",
        apples: [
          {
            id: "add-skill",
            name: "Add a skill",
            leaf: "A SKILL.md file (up to 1 MB) or a .zip with one inside (up to 20 MB).",
            words: ["upload", "md", "zip", "new skill"],
          },
          {
            id: "your-skills",
            name: "Your skills",
            leaf: "Skills that are on are used every time you make clips.",
            words: ["switch", "turn off", "delete", "view"],
          },
        ],
      },
      {
        slug: "youtube",
        name: "YouTube help",
        line: "For when YouTube blocks a video.",
        icon: "cookie",
        apples: [
          {
            id: "youtube-cookies",
            name: "YouTube cookies",
            leaf: "You can skip this. Add them only if YouTube blocks a video.",
            words: ["cookies.txt", "blocked", "download"],
          },
        ],
      },
    ],
  },
  {
    slug: "posting",
    name: "Posting",
    line: "Where your kept clips go.",
    icon: "share",
    branches: [
      {
        slug: "accounts",
        name: "Accounts",
        line: "The accounts your clips are posted to.",
        icon: "users",
        apples: [
          {
            id: "accounts",
            name: "Connected accounts",
            leaf: "Connecting an account lets Clip Factory post your kept clips there. Coming in a later update.",
            words: ["YouTube", "Instagram", "Facebook", "TikTok", "X", "connect", "login"],
          },
        ],
      },
      {
        slug: "where",
        name: "Where clips go",
        line: "Pick the places your kept clips are posted.",
        icon: "check",
        apples: [
          {
            id: "post-to",
            name: "Post kept clips to",
            leaf: "Pick at least one place.",
            words: ["platforms", "YouTube", "Instagram", "Facebook", "TikTok", "X"],
          },
        ],
      },
    ],
  },
  {
    slug: "look-and-feel",
    name: "Look & feel",
    line: "Sounds, motion and your background.",
    icon: "sparkle",
    branches: [
      {
        slug: "sounds",
        name: "Sounds",
        line: "Turn sounds on or off, and pick your two sounds.",
        icon: "volume",
        apples: [
          {
            id: "sounds-on",
            name: "Sounds",
            leaf: "Sounds only play when you tap, never when you scroll.",
            words: ["mute", "quiet", "silent", "volume", "on", "off"],
          },
          {
            id: "click-sound",
            name: "Click sound",
            leaf: "Plays when you tap something that works.",
            words: ["tap", "click", "beep", "noise", "when it works"],
          },
          {
            id: "error-sound",
            name: "Error sound",
            leaf: "Plays when something can't be done.",
            words: ["wrong", "fail", "deny", "noise", "when it can't"],
          },
          {
            id: "try-sounds",
            name: "Try it",
            leaf: "Hear your two sounds on a pretend Sign in button.",
            words: ["test", "preview", "listen"],
          },
        ],
      },
      {
        slug: "motion",
        name: "Motion",
        line: "Less moving around on the screen.",
        icon: "motion",
        apples: [
          {
            id: "reduce-motion",
            name: "Reduce motion",
            leaf: "Turns off confetti, page moves and the moving background.",
            words: ["animation", "dizzy", "confetti", "still"],
          },
        ],
      },
      {
        slug: "background",
        name: "Background",
        line: "Your own picture behind the glass.",
        icon: "image",
        apples: [
          {
            id: "background-picture",
            name: "Background picture",
            leaf: "Use your own picture behind the glass. It stays on this device.",
            words: ["wallpaper", "photo", "colours", "colors", "image"],
          },
        ],
      },
    ],
  },
  {
    slug: "app",
    name: "App & account",
    line: "The app, updates, and your account.",
    icon: "settings",
    branches: [
      {
        slug: "get-the-app",
        name: "Get the app",
        line: "Open Clip Factory like any other app.",
        icon: "download",
        onlyWhenNotInstalled: true,
        apples: [
          {
            id: "get-app",
            name: "Get the app",
            leaf: "Put Clip Factory on this device, next to your other apps.",
            words: ["install", "download", "home screen", "desktop", "phone"],
          },
        ],
      },
      {
        slug: "updates",
        name: "Updates",
        line: "Your version, and checking for a new one.",
        icon: "retry",
        apples: [
          {
            id: "this-version",
            name: "This version",
            leaf: "New versions arrive by themselves.",
            words: ["version", "build", "number"],
          },
          {
            id: "check-updates",
            name: "Check for updates",
            leaf: "Looks for a new version right now.",
            words: ["update", "new version", "reload", "refresh"],
          },
        ],
      },
      {
        slug: "account",
        name: "Account",
        line: "Who is signed in, and signing out.",
        icon: "logout",
        apples: [
          {
            id: "signed-in",
            name: "Signed in as",
            leaf: "The email you use to sign in.",
            words: ["email", "user", "me", "profile"],
          },
          {
            id: "sign-out",
            name: "Sign out",
            leaf: "Signs you out of Clip Factory here.",
            words: ["log out", "logout", "leave", "exit"],
          },
        ],
      },
    ],
  },
];

export interface Place {
  tree: Tree;
  branch: Branch | null;
}

/** The trees and branches to show: Get the app disappears once the app is installed (§12.1). */
export function visibleTrees(installed: boolean): Tree[] {
  return TREES.map((t) => ({ ...t, branches: t.branches.filter((b) => !(installed && b.onlyWhenNotInstalled)) }));
}

export function findTree(slug: string): Tree | undefined {
  return TREES.find((t) => t.slug === slug);
}

export function findBranch(tree: Tree, slug: string): Branch | undefined {
  return tree.branches.find((b) => b.slug === slug);
}

/** `/settings`, `/settings/{tree}` or `/settings/{tree}/{branch}`, with an optional apple anchor. */
export function settingsPath(tree?: string | null, branch?: string | null, apple?: string | null): string {
  let path = "/settings";
  if (tree) path += `/${tree}`;
  if (tree && branch) path += `/${branch}`;
  return apple ? `${path}#${apple}` : path;
}

/** Where an apple lives. */
export function findApple(id: string): { tree: Tree; branch: Branch; apple: Apple } | undefined {
  for (const tree of TREES)
    for (const branch of tree.branches)
      for (const apple of branch.apples) if (apple.id === id) return { tree, branch, apple };
  return undefined;
}

export function appleCount(tree: Tree): number {
  return tree.branches.reduce((n, b) => n + b.apples.length, 0);
}

// ---------- "Find a setting" ----------

export interface SearchHit {
  tree: Tree;
  branch: Branch;
  apple: Apple;
  /** "apple" when the words are in the setting's name, "leaf" when only its help line (or other words) has them. */
  found: "apple" | "leaf";
  href: string;
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, "")
    .replace(/&/g, " and ");

/** The app's own name is in many help lines ("Signs you out of Clip Factory here"), so it never counts as a match. */
const withoutAppName = (s: string) => s.replace(/clip\s*factory/g, " ");

/**
 * Finds settings by name and by help line. Every word typed must appear somewhere (name, leaf, branch or tree,
 * other words); hits on the name come first. Get the app is left out once the app is installed.
 */
export function searchSettings(query: string, installed = false): SearchHit[] {
  const words = fold(query).split(/[^a-z0-9.]+/).filter(Boolean);
  if (!words.length) return [];
  const hits: (SearchHit & { score: number; order: number })[] = [];
  let order = 0;
  for (const tree of visibleTrees(installed)) {
    for (const branch of tree.branches) {
      for (const apple of branch.apples) {
        order++;
        const name = fold(apple.name);
        const leaf = withoutAppName(fold(apple.leaf));
        const extra = fold([...(apple.words ?? []), branch.name, tree.name].join(" "));
        const all = `${name} ${leaf} ${extra}`;
        if (!words.every((w) => all.includes(w))) continue;
        const inName = words.filter((w) => name.includes(w)).length;
        const inLeaf = words.filter((w) => leaf.includes(w)).length;
        const starts = name.startsWith(words[0]!) ? 2 : 0;
        const score = starts + inName * 3 + inLeaf;
        hits.push({
          tree,
          branch,
          apple,
          found: inName > 0 ? "apple" : "leaf",
          href: settingsPath(tree.slug, branch.slug, apple.id),
          score,
          order,
        });
      }
    }
  }
  return hits.sort((a, b) => b.score - a.score || a.order - b.order).map(({ score: _s, order: _o, ...hit }) => hit);
}

// ---------- Old links ----------

/** The one-page Settings had `#section` anchors; each now has a home in the tree. */
const LEGACY_ANCHORS: Record<string, string> = {
  "get-app": settingsPath("app", "get-the-app"),
  skills: settingsPath("clip-making", "skills"),
  accounts: settingsPath("posting", "accounts"),
  clips: settingsPath("clip-making", "clips"),
  appearance: settingsPath("look-and-feel"),
  sounds: settingsPath("look-and-feel", "sounds"),
  app: settingsPath("app"),
  cookies: settingsPath("clip-making", "youtube"),
};

/**
 * Where an old Settings link should go now, or null to stay. `/settings#skills` goes to the Skills branch, and
 * the hooks API's `/settings?account=…&status=coming_soon` (§14.3) goes to Accounts with its query kept.
 */
export function legacySettingsRedirect(pathname: string, search: string, hash: string): string | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path !== "/settings") return null;
  const query = new URLSearchParams(search);
  if (query.get("account") && query.get("status")) return `${settingsPath("posting", "accounts")}${search}`;
  const anchor = hash.replace(/^#/, "");
  if (!anchor) return null;
  if (anchor in LEGACY_ANCHORS) return `${LEGACY_ANCHORS[anchor]}${search}`;
  const found = findApple(anchor);
  return found ? `${settingsPath(found.tree.slug, found.branch.slug, anchor)}${search}` : null;
}
