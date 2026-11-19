// The cookies.txt check before upload (docs/CONTRACTS.md §29.6). It runs in the browser only: the file's text is never
// logged, kept or sent anywhere but the existing presigned PUT. It only says whether the file can help YouTube: a
// Netscape cookies file, with youtube.com sign-in cookies that have not run out.

export type CookiesCheck = "ok" | "notCookies" | "notSignedIn" | "expired";

/** The cookies that mean "signed in to YouTube" (any one is enough). */
const SIGN_IN = new Set(["LOGIN_INFO", "__Secure-3PSID", "SAPISID"]);

export const COOKIES_WORDS: Record<Exclude<CookiesCheck, "ok">, string> = {
  notCookies: "This is not a cookies.txt file. Export it again and pick that file.",
  notSignedIn: "This file has no YouTube sign-in. Sign in to YouTube in the private window, then export again.",
  expired: "These cookies ran out. Export new ones.",
};

/** The steps of "How to get cookies" in Settings › YouTube help. */
export const COOKIES_STEPS = [
  "Open a private window in Chrome (⌘ Shift N on a Mac, Ctrl Shift N on Windows).",
  "Turn on Get cookies.txt LOCALLY for private windows (Extensions › Details › Allow in Incognito).",
  "Sign in to YouTube there.",
  "In the same tab, go to youtube.com/robots.txt.",
  "Tap Get cookies.txt LOCALLY, then Export.",
  "Close the private window. Don't open it again.",
  "Tap Add cookies.txt and pick the file.",
] as const;

export const COOKIES_TIP = "A spare Google account is safest.";

/** `now` in seconds since 1970. An expiry of 0 is a session cookie: it counts as not run out. */
export function checkCookies(text: string, now: number): CookiesCheck {
  let rows = 0;
  let signIn = 0;
  let fresh = 0;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#HttpOnly_")) line = line.slice("#HttpOnly_".length);
    else if (line.startsWith("#")) continue;
    const f = line.split("\t");
    if (f.length !== 7 || !/^\d+$/.test(f[4] ?? "")) continue;
    rows += 1;
    const domain = (f[0] ?? "").toLowerCase();
    if (!(domain === "youtube.com" || domain.endsWith(".youtube.com"))) continue;
    if (!SIGN_IN.has(f[5] ?? "")) continue;
    signIn += 1;
    const expires = Number(f[4]);
    if (expires === 0 || expires > now) fresh += 1;
  }
  if (rows === 0) return "notCookies";
  if (signIn === 0) return "notSignedIn";
  return fresh > 0 ? "ok" : "expired";
}
