// Signing the helper in to Clip Factory as the owner (docs/CONTRACTS.md §3).
//
// The owner signs in once, in the helper's own Chrome window (cli.js setup). The helper copies that sign-in's
// refresh token into the login keychain and removes it from the page, so only the helper keeps refreshing it
// (rotation is on: each refresh returns a new refresh token, which replaces the stored one). Refreshing uses
// Cognito's GetTokensFromRefreshToken, the call Amplify uses for this app client (infra/modules/auth/main.tf).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { APP_URL, KEYCHAIN_SERVICE, SECURITY } from "./paths.js";

const run = promisify(execFile);
const ACCOUNT = "refresh-token";

export class SignInNeeded extends Error {
  constructor(message = "Sign your Mac in to Clip Factory again (run the setup on your Mac).") {
    super(message);
  }
}

export async function appConfig(fetchImpl = fetch) {
  const res = await fetchImpl(`${APP_URL}/config.json`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Clip Factory's config did not load (${res.status}).`);
  const c = await res.json();
  for (const k of ["region", "userPoolClientId", "apiUrl"]) {
    if (!c[k]) throw new Error(`Clip Factory's config has no ${k}.`);
  }
  return c;
}

export async function readRefreshToken() {
  try {
    const { stdout } = await run(SECURITY, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", ACCOUNT, "-w"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function saveRefreshToken(token) {
  await run(SECURITY, ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", ACCOUNT, "-w", token]);
}

export async function forgetRefreshToken() {
  try {
    await run(SECURITY, ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", ACCOUNT]);
  } catch {
    // nothing stored
  }
}

/** A fresh access token (15 minutes). Saves the rotated refresh token before returning. */
export async function accessToken(config, fetchImpl = fetch) {
  return (await freshTokens(config, fetchImpl)).token;
}

/**
 * The access token for a whole tick, or any run longer than one token (24 Nov 2026: a tick that waits 20 minutes for
 * a TikTok login sent 401s from minute 15, so its beats and its stop never reached Clip Factory). ``get()`` renews
 * it 2 minutes before it runs out; ``renew(stale)`` after a 401, unless a newer one is already there. One refresh
 * at a time: each refresh rotates the refresh token, so two at once would spend the same one twice.
 * @param {() => Promise<{token: string, expiresIn: number}>} fetchTokens freshTokens(config) (a fake in tests)
 */
export function tokenSource(fetchTokens, now = () => Date.now()) {
  let token = null;
  let until = 0;
  let pending = null;
  const refresh = () => {
    pending ||= fetchTokens()
      .then((fresh) => {
        token = fresh.token;
        until = now() + Math.max(60, (Number(fresh.expiresIn) || 900) - 120) * 1000;
        return token;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  return {
    get: () => (token && now() < until ? Promise.resolve(token) : refresh()),
    renew: (stale) => (token && token !== stale && now() < until ? Promise.resolve(token) : refresh()),
  };
}

/** freshTokens: one GetTokensFromRefreshToken, with how long the access token lasts (seconds). */
export async function freshTokens(config, fetchImpl = fetch) {
  const refresh = await readRefreshToken();
  if (!refresh) throw new SignInNeeded("Your Mac isn't signed in to Clip Factory yet. Run the setup on your Mac.");
  const res = await fetchImpl(`https://cognito-idp.${config.region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.GetTokensFromRefreshToken",
    },
    body: JSON.stringify({ ClientId: config.userPoolClientId, RefreshToken: refresh }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const type = String(body.__type || "");
    if (/NotAuthorized|InvalidParameter|UserNotFound|RefreshTokenReuse/i.test(type)) throw new SignInNeeded();
    throw new Error(`Clip Factory's sign-in did not answer (${res.status} ${type}).`);
  }
  const result = body.AuthenticationResult || {};
  if (result.RefreshToken && result.RefreshToken !== refresh) await saveRefreshToken(result.RefreshToken);
  if (!result.AccessToken) throw new SignInNeeded();
  return { token: result.AccessToken, expiresIn: Number(result.ExpiresIn) || 900 };
}
