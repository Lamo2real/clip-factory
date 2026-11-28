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
  /** Where the apple lives when it is not on its branch page (a platform's setup page). */
  href?: string;
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
        line: "How many clips, how long a video can be, which AI makes them, and your take.",
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
          {
            id: "ai-model",
            name: "AI model",
            leaf: "The AI that finds your moments and writes your captions. Your pick is used for your next clips.",
            words: ["model", "AI", "Claude", "Fable", "Opus", "Sonnet", "Haiku", "brain", "smart", "smarter", "cheap", "fast", "Bedrock"],
          },
          {
            id: "your-take",
            name: "Your take",
            leaf: "Every clip gets one short comment that is yours.",
            words: ["take", "comment", "commentary", "opinion", "original", "own words", "reach", "fewer views", "reupload", "re-upload"],
          },
          {
            id: "take-voice",
            name: "Say it out loud",
            leaf: "A voice reads your take at the start of the clip.",
            words: ["voice", "voiceover", "voice over", "speak", "spoken", "talk", "narrator", "read aloud"],
          },
          {
            id: "take-style",
            name: "How you talk",
            leaf: "A few words on your style. Like: funny, honest, a bit cheeky.",
            words: ["style", "tone", "personality", "funny", "honest", "cheeky", "sound like me"],
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
            id: "your-skills",
            name: "Your skills",
            leaf: "Clip Factory uses every skill here, every time it makes or checks anything.",
            words: ["read", "edit", "change", "delete", "always used"],
          },
          {
            id: "add-skill",
            name: "Add a skill",
            leaf: "Write one by answering three easy questions, or upload a skill file from your computer.",
            // "write" is in the leaf, so Find a setting still finds it; as a keyword it made Ask Clip Factory answer "write my homework".
            words: ["new", "upload", "md", "zip"],
          },
        ],
      },
      {
        slug: "learned",
        name: "What it learned",
        line: "Lessons from your clips that did best.",
        icon: "sparkle",
        apples: [
          {
            id: "what-it-learned",
            name: "What it learned",
            leaf: "Lessons from clips that did much better than normal. Turn one off or delete it.",
            words: ["learn", "learned", "learnings", "lessons", "prior learnings", "best clips", "winners", "patterns", "undo", "what works", "smarter"],
          },
        ],
      },
      {
        slug: "streamers",
        name: "Streamers I follow",
        line: "Follow YouTube, Twitch and Kick streamers and see who is live.",
        icon: "users",
        apples: [
          {
            id: "follow-streamer",
            name: "Follow a streamer",
            leaf: "Paste their link or type their name. Only follow streamers who said you can make clips.",
            words: ["follow", "add", "streamer", "youtuber", "creator", "channel", "twitch", "kick", "youtube", "subscribe", "watch", "spectate"],
          },
          {
            id: "streamers-followed",
            name: "Who you follow",
            leaf: "Who is live right now, and when a stream ended or a new video came out.",
            words: ["live", "offline", "streaming", "online", "unfollow", "remove", "stop following", "badge"],
          },
          {
            id: "clips-by-itself",
            name: "Clips by itself",
            leaf: "Each video it makes costs the same as one you paste. Coming in the next update.",
            words: ["automatic", "auto", "by itself", "limit", "how many a day", "pause", "stop all", "shortest", "cost"],
          },
          {
            id: "streamer-keys",
            name: "Twitch and Kick keys",
            leaf: "A grown-up does this once. YouTube works without it.",
            words: ["keys", "client id", "setup", "grown-up", "parent", "webhook", "developer"],
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
            leaf: "You can skip this. Add them only if YouTube blocks a video. Export them from a private window, then close it.",
            words: ["cookies.txt", "blocked", "download", "private window", "incognito", "expired", "get cookies.txt locally", "ran out"],
          },
        ],
      },
    ],
  },
  {
    slug: "posting",
    name: "Posting",
    line: "Where your clips go.",
    icon: "share",
    branches: [
      {
        slug: "setup",
        name: "Set up posting",
        line: "Connect YouTube, TikTok, Instagram, Facebook and X.",
        icon: "link",
        apples: [
          {
            id: "setup-posting",
            name: "Set up posting",
            leaf: "Do each one once. After that Clip Factory posts by itself.",
            words: ["YouTube", "Instagram", "Facebook", "TikTok", "X", "connect", "login", "accounts", "keys", "steps"],
          },
          {
            id: "setup-todo",
            name: "The setup list on your screen",
            leaf: "It stays at the top right until each place is set up or skipped. Skipped ones wait here.",
            words: ["to-do", "todo", "checklist", "list", "skip", "skipped", "un-skip", "unskip", "gone", "disappeared", "where did it go", "pill", "setup list"],
          },
          {
            id: "youtube-privacy",
            name: "Who can see your YouTube clips",
            leaf: "Everyone, only people with the link, or only you.",
            words: ["YouTube", "public", "unlisted", "private", "privacy"],
            href: "/settings/posting/setup/youtube#youtube-privacy",
          },
          {
            id: "x-cost",
            name: "What X costs",
            leaf: "About 1.5 cents a post. It stops at $10 a month.",
            words: ["X", "twitter", "money", "price", "credits", "card", "pay"],
            href: "/settings/posting/setup/x#x-cost",
          },
          {
            id: "contentrewards",
            name: "Content Rewards",
            leaf: "Get paid by brands for your clips. Set it up once.",
            words: ["content rewards", "whop", "campaign", "campaigns", "brand", "brand deal", "clipping", "cpm", "get paid", "earn"],
            href: "/settings/posting/setup/contentrewards",
          },
          {
            id: "campaigns",
            name: "Your campaigns",
            leaf: "The Content Rewards campaigns you added, and what to do next.",
            words: ["content rewards", "campaign", "campaigns", "brand", "join", "am i in", "whop"],
            href: "/campaigns",
          },
          {
            id: "campaign-finder",
            name: "Find campaigns",
            leaf: "Campaigns on Content Rewards that pay what you want.",
            words: ["find campaigns", "campaign finder", "discover", "new campaigns", "requirements", "what i want", "content rewards"],
            href: "/campaigns/find",
          },
        ],
      },
      {
        slug: "getpaid",
        name: "Get paid",
        line: "Set up how each app pays you. See if money can reach you.",
        icon: "coin",
        apples: [
          {
            id: "getpaid",
            name: "Get paid",
            leaf: "One card per place. Do the steps once so money can reach you.",
            words: ["get paid", "payout", "payouts", "bank", "bank account", "paypal", "stripe", "adsense", "whop", "tax", "money on hold", "withdraw", "cash out"],
          },
          {
            id: "getpaid-bank",
            name: "Your bank",
            leaf: "See which app money reached your bank.",
            words: ["bankid", "enable banking", "reached your bank", "reconnect bank", "bank link"],
            href: "/settings/posting/getpaid/bank",
          },
        ],
      },
      {
        slug: "where",
        name: "Where clips go",
        line: "Pick the places your clips go.",
        icon: "check",
        apples: [
          {
            id: "post-to",
            name: "Upload clips to",
            leaf: "Pick at least one place.",
            words: ["platforms", "YouTube", "Instagram", "Facebook", "TikTok", "X"],
          },
        ],
      },
      {
        slug: "my-settings",
        name: "My settings",
        line: "How each clip goes up: public, open for comments, never made for kids.",
        icon: "sparkle",
        apples: [
          {
            id: "my-settings-youtube",
            name: "YouTube",
            leaf: "Everyone can see it, Entertainment, tells subscribers. Never made for kids.",
            words: ["YouTube", "preset", "use my settings", "made for kids", "kids", "category", "public", "subscribers", "embed", "monetize", "ads"],
          },
          {
            id: "my-settings-tiktok",
            name: "TikTok",
            leaf: "Everyone can see it; comments, Duet and Stitch on. Every clip starts on these.",
            words: ["TikTok", "preset", "use my settings", "privacy", "everyone", "duet", "stitch", "comments"],
          },
          {
            id: "my-settings-instagram",
            name: "Instagram",
            leaf: "Reels also show in your feed.",
            words: ["Instagram", "preset", "feed", "reels", "share to feed"],
          },
          {
            id: "my-settings-facebook",
            name: "Facebook",
            leaf: "Reels on your Page are public. Nothing to pick.",
            words: ["Facebook", "preset", "public", "reels", "page"],
          },
          {
            id: "my-settings-x",
            name: "X",
            leaf: "Everyone can reply. Used once X is set up.",
            words: ["X", "twitter", "preset", "replies", "reply", "everyone"],
          },
        ],
      },
      {
        // Auto-posting (docs/CONTRACTS.md §46.2): the oldest clips in Review go up by themselves, every few hours.
        slug: "auto",
        name: "Auto-posting",
        line: "The oldest clips in Review go up by themselves, every few hours.",
        icon: "clock",
        apples: [
          {
            id: "auto-post-on",
            name: "Post my clips by themselves",
            leaf: "Clips in Review go up without your tap. Throw one away to stop it.",
            words: ["auto", "autopost", "auto-post", "automatic", "schedule", "by itself", "without approval", "on", "off"],
          },
          {
            id: "auto-post-every",
            name: "How often",
            leaf: "Post every few hours, a few clips each time. Even gaps, also across midnight.",
            words: ["hours", "every", "how many", "clips each time", "per day", "a day", "interval", "frequency", "timer"],
          },
          {
            id: "auto-post-where",
            name: "Where they go",
            leaf: "Every place that is set up, with My settings. TikTok goes through your Mac.",
            words: ["platforms", "YouTube", "Instagram", "Facebook", "X", "TikTok", "places", "my settings", "Mac"],
          },
          {
            id: "auto-post-next",
            name: "Next up",
            leaf: "The oldest clips in Review go first.",
            words: ["queue", "line", "order", "oldest", "next", "throw away", "decline"],
          },
          {
            id: "auto-post-waiting",
            name: "Waits for you",
            leaf: "Clips auto-posting skips, and why. Upload them yourself.",
            words: ["skipped", "campaign", "check", "waiting", "missing"],
          },
          {
            id: "auto-post-failed",
            name: "Didn't work",
            leaf: "Posts that did not go up, with what went wrong.",
            words: ["failed", "error", "try again", "retry"],
          },
          {
            id: "auto-post-recent",
            name: "Recent",
            leaf: "The last runs, newest first.",
            words: ["history", "runs", "log", "posted", "open"],
          },
          {
            id: "auto-post-test",
            name: "Test it first",
            leaf: "Practice, or a private test run. Nothing public.",
            words: ["practice", "test", "private", "try", "dry run", "only me", "draft"],
          },
        ],
      },
      {
        // Your Mac posts it on TikTok (docs/CONTRACTS.md §47): Upload and auto-posting hand TikTok to the owner's Mac.
        slug: "tiktok-mac",
        name: "Your Mac posts TikTok",
        line: "Your Mac posts your TikTok clips for everyone, one at a time.",
        icon: "monitor",
        apples: [
          {
            id: "tiktok-mac-on",
            name: "My Mac posts my TikTok clips",
            leaf: "Upload and auto-posting give TikTok to your Mac. It posts each clip for everyone.",
            words: ["TikTok", "Mac", "computer", "automation", "automatic", "by itself", "helper", "Chrome", "everyone", "public", "on", "off"],
          },
          {
            id: "tiktok-mac-status",
            name: "Your Mac",
            leaf: "When your Mac last checked in, and how many clips wait for it.",
            words: ["checked in", "last seen", "waiting", "queue", "needs you", "paused", "set up", "asleep"],
          },
          {
            id: "tiktok-mac-send",
            name: "Send these to my Mac",
            leaf: "Clips that aren't on TikTok yet can go to your Mac, one after each auto-posting run.",
            words: ["send", "not on TikTok yet", "waiting", "old clips", "all", "TikTok", "backlog"],
          },
          {
            id: "tiktok-mac-login",
            name: "TikTok login on your Mac",
            leaf: "Kept in your Mac's Keychain, so your Mac logs back in to TikTok by itself. Change it or forget it.",
            words: ["login", "log in", "logged out", "password", "Keychain", "change", "forget", "remove", "delete", "TikTok"],
          },
        ],
      },
      {
        slug: "money",
        name: "Money",
        line: "How close you are to getting paid, and real money each app reports.",
        icon: "coin",
        apples: [
          {
            id: "money-dashboard",
            name: "Money dashboard",
            leaf: "The money each app reported, and what each clip earned.",
            words: ["revenue", "mrr", "dashboard", "earnings", "earnings per video", "money per video", "money per clip", "income"],
            href: "/money",
          },
          {
            id: "money-country",
            name: "Your country",
            leaf: "Some apps have different goals in each country. Pick yours once.",
            words: ["country", "where I live", "region", "tiktok", "creator rewards", "rules"],
          },
          {
            id: "money-youtube",
            name: "YouTube",
            leaf: "How close you are to the Partner Program, and what YouTube says you earned.",
            words: ["youtube", "partner program", "ypp", "monetized", "monetization", "subscribers", "watch hours", "shorts", "earn", "earnings", "money", "revenue", "adsense", "allow money reading"],
          },
          {
            id: "money-tiktok",
            name: "TikTok",
            leaf: "How close you are to Creator Rewards.",
            words: ["tiktok", "creator rewards", "creativity program", "followers", "views", "monetized", "allow follower reading"],
          },
          {
            id: "money-instagram",
            name: "Instagram",
            leaf: "Followers against the goal for Gifts.",
            words: ["instagram", "insta", "gifts", "followers", "monetized", "reels"],
          },
          {
            id: "money-facebook",
            name: "Facebook",
            leaf: "Followers, minutes watched and Meta's estimate once it is checked.",
            words: ["facebook", "meta", "content monetization", "reels", "monetized", "earnings"],
          },
          {
            id: "money-x",
            name: "X",
            leaf: "Premium and verified followers against the goal.",
            words: ["x", "twitter", "premium", "verified followers", "revenue sharing", "creator revenue"],
          },
          {
            id: "money-contentrewards",
            name: "Content Rewards money",
            leaf: "Money from brand campaigns, in their own numbers, and how to move it to your bank.",
            words: ["content rewards", "whop", "campaign", "campaigns", "brand", "withdraw", "balance", "payout", "get paid"],
            href: "/money#content-rewards",
          },
          {
            id: "money-payouts",
            name: "Getting your money out",
            leaf: "Each app pays you itself. Get paid shows the steps for each one.",
            href: "/settings/posting/getpaid",
            words: ["bank", "bank account", "paypal", "payout", "payouts", "withdraw", "cash out", "get paid", "stripe", "adsense", "balance", "payment", "card"],
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
        line: "See-through glass, your picture or your colours.",
        icon: "image",
        apples: [
          {
            id: "background-kind",
            name: "What's behind the glass",
            leaf: "Pick See-through, Picture or Colours.",
            words: ["see-through", "see through", "transparent", "liquid glass", "glass", "behind", "desktop", "computer background", "mode"],
          },
          {
            id: "glass-strength",
            name: "Glass strength",
            leaf: "Clear shows more of what's behind. Frosted shows less.",
            words: ["see-through", "see through", "transparent", "blur", "blurry", "frosted", "clear", "strength"],
          },
          {
            id: "background-picture",
            name: "Background picture",
            leaf: "Use your own picture behind the glass. It stays on this device.",
            words: ["wallpaper", "photo", "image"],
          },
          {
            id: "background-colours",
            name: "Background colours",
            leaf: "Mix up to 3 colours behind the glass.",
            words: ["colours", "colors", "colour", "color", "gradient", "rainbow", "paint", "swatch"],
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
        slug: "notifications",
        name: "Notifications",
        line: "Get told when your clips are ready, even with the app closed.",
        icon: "bell",
        apples: [
          {
            id: "notify-device",
            name: "This device",
            leaf: "Turn notifications on here. On iPhone, open Clip Factory from your Home Screen first.",
            words: ["notifications", "alerts", "push", "ping", "buzz", "phone", "iphone", "allow", "permission", "turn on", "home screen"],
          },
          {
            id: "notify-ready",
            name: "Clips ready",
            leaf: "When your clips are done.",
            words: ["done", "finished", "ready", "tell me"],
          },
          {
            id: "notify-stopped",
            name: "It stopped",
            leaf: "When a video stops and needs Try again.",
            words: ["failed", "error", "stopped", "try again", "broken"],
          },
          {
            id: "notify-resumed",
            name: "Picked up again",
            leaf: "When a video that stopped starts again by itself.",
            words: ["resume", "resumed", "picking up", "started again", "restart"],
          },
          {
            id: "notify-steps",
            name: "Every step",
            leaf: "One card per video that changes as it works: the step and the clip. It can buzz often.",
            words: ["progress", "live", "status", "steps", "what it's doing", "lock screen", "updates", "clip 3 of 10"],
          },
          {
            id: "notify-contentrewards",
            name: "Content Rewards news",
            leaf: "You're in, send-now reminders, approvals, proof, money and new campaigns.",
            words: ["content rewards", "campaign", "brand", "approved", "send now", "proof", "whop"],
          },
          {
            id: "notify-getpaid",
            name: "Money on hold or sent to your bank",
            leaf: "When Google or Whop holds your money, or sends it to your bank.",
            words: ["get paid", "payout", "bank", "on hold", "money sent", "adsense", "whop"],
          },
          {
            id: "notify-badge",
            name: "Number on the app icon",
            leaf: "Shows how many videos are working right now.",
            words: ["badge", "icon", "red dot", "count", "working"],
          },
          {
            id: "notify-lock-screen",
            name: "Lock Screen widget",
            leaf: "Lock Screen widgets only come with App Store apps. Your notifications show there instead.",
            words: ["widget", "lock screen", "live activity", "dynamic island", "app store", "always on"],
          },
          {
            id: "notify-test",
            name: "Send a test",
            leaf: "Sends one to this device so you can see it work.",
            words: ["test", "try", "check", "does it work"],
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
        slug: "ask",
        name: "Ask",
        line: "Web search, and what Ask can do for you.",
        icon: "search",
        apples: [
          {
            id: "ask-web-setup",
            name: "Web search",
            leaf: "Lets Ask read today's web pages, for steps that change.",
            words: ["internet", "search key", "brave", "browse", "web", "google", "online", "key"],
          },
          {
            id: "ask-status",
            name: "What Ask can do",
            leaf: "Ask answers any question, knows your app and reads your files.",
            words: ["assistant", "chat", "claude", "opus", "files", "pictures", "help"],
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
          href: apple.href ?? settingsPath(tree.slug, branch.slug, apple.id),
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
  accounts: settingsPath("posting", "setup"),
  clips: settingsPath("clip-making", "clips"),
  appearance: settingsPath("look-and-feel"),
  sounds: settingsPath("look-and-feel", "sounds"),
  app: settingsPath("app"),
  cookies: settingsPath("clip-making", "youtube"),
  // §21's money apples were retired by §25: their old links open the Money branch.
  "money-how": settingsPath("posting", "money"),
  "money-paid": settingsPath("posting", "money"),
  "money-rate": settingsPath("posting", "money"),
  "money-sources": settingsPath("posting", "money"),
};

const SETUP_PLATFORMS = ["youtube", "tiktok", "instagram", "facebook", "x"];

/**
 * Where an old Settings link should go now, or null to stay. `/settings#skills` goes to the Skills branch;
 * Accounts became Set up posting (§17.1), so `/settings/posting/accounts` and the old hooks API links
 * (`?account=…&status=…`) go there, to the platform's own page when the link names one.
 */
export function legacySettingsRedirect(pathname: string, search: string, hash: string): string | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  const query = new URLSearchParams(search);
  const account = query.get("account");
  if ((path === "/settings" || path === "/settings/posting/accounts") && account && query.get("status")) {
    return SETUP_PLATFORMS.includes(account) ? `${settingsPath("posting", "setup")}/${account}` : settingsPath("posting", "setup");
  }
  if (path === "/settings/posting/accounts") return settingsPath("posting", "setup") + (hash && hash !== "#accounts" ? hash : "");
  if (path !== "/settings") return null;
  const anchor = hash.replace(/^#/, "");
  if (!anchor) return null;
  if (anchor in LEGACY_ANCHORS) return `${LEGACY_ANCHORS[anchor]}${search}`;
  const found = findApple(anchor);
  if (!found) return null;
  return found.apple.href ?? `${settingsPath(found.tree.slug, found.branch.slug, anchor)}${search}`;
}
