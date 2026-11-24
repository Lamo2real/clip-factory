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
  return result.AccessToken;
}
