// Sign-in with our own glass screen, straight against the Cognito user pool (no hosted UI). Amplify v6 does the
// SRP exchange (the password itself never leaves the device), the first-login "choose a password" step and token
// refresh. Access tokens live 15 minutes; the refresh token lives 30 days and rotates on every refresh, so an owner
// who uses the app stays signed in (docs/CONTRACTS.md §3).
import { networkError } from "../api/errors.ts";
import { config, isMock } from "./config.ts";

export type SignInStep = { kind: "done" } | { kind: "new_password" };

export interface AuthClient {
  /** The signed-in owner's email, or null when nobody is signed in on this device. */
  currentUser(): Promise<{ email: string } | null>;
  signIn(email: string, password: string): Promise<SignInStep>;
  /** First sign-in: replace the temporary password from the invitation email. */
  setNewPassword(password: string): Promise<SignInStep>;
  /** A valid access token (refreshed when needed, or always with fresh=true), or null: sign in again. */
  accessToken(fresh?: boolean): Promise<string | null>;
  signOut(): Promise<void>;
}

/** Plain words for Cognito's errors. Never the raw message (it can name the user pool). */
export function authProblem(e: unknown): string {
  const name = (e as { name?: string } | null)?.name ?? "";
  switch (name) {
    case "NotAuthorizedException":
    case "UserNotFoundException":
      return "That email or password is not right. Check both and try again.";
    case "InvalidPasswordException":
    case "InvalidParameterException":
      return "That password does not meet the rules below.";
    case "LimitExceededException":
    case "TooManyRequestsException":
    case "TooManyFailedAttemptsException":
      return "Too many tries. Wait a few minutes, then try again.";
    case "PasswordResetRequiredException":
      return "Your password has to be reset. Ask the administrator for a new invitation.";
    default:
      return "Signing in did not work. Check your connection and try again.";
  }
}

/** Cognito errors that mean the stored sign-in is really gone (Amplify clears the tokens for these). */
const SESSION_GONE = [
  "NotAuthorizedException",
  "TokenRevokedException",
  "UserNotFoundException",
  "PasswordResetRequiredException",
  "UserNotConfirmedException",
  "RefreshTokenReuseException",
  "UserUnAuthenticatedException",
];

/**
 * True when a refresh failed because the sign-in ended, false for network, throttling and service errors.
 * Those keep the stored refresh token, so the app must not treat them as "signed out" (docs/CONTRACTS.md §3).
 */
export function sessionGone(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return typeof name === "string" && SESSION_GONE.some((n) => name.startsWith(n));
}

/** The first-login challenge is no longer usable (Cognito's 3-minute Session ran out, or the page lost it). */
export function challengeExpired(e: unknown): boolean {
  const err = e as { name?: unknown; message?: unknown } | null;
  const name = typeof err?.name === "string" ? err.name : "";
  const message = typeof err?.message === "string" ? err.message : "";
  return (
    name === "SignInException" ||
    name === "NotAuthorizedException" ||
    name === "ExpiredCodeException" ||
    /session (is )?expired|invalid session/i.test(message)
  );
}

export const CHALLENGE_EXPIRED = "That took too long. Sign in again with the password from your invitation.";

export const PASSWORD_RULES = "At least 12 characters, with an uppercase letter, a lowercase letter, a number and a symbol.";

/** The first rule a new password breaks, or null. Mirrors the user pool's password policy. */
export function passwordProblem(p: string): string | null {
  if (p.length < 12) return "Use at least 12 characters.";
  if (!/[a-z]/.test(p)) return "Add a lowercase letter.";
  if (!/[A-Z]/.test(p)) return "Add an uppercase letter.";
  if (!/[0-9]/.test(p)) return "Add a number.";
  if (!/[^A-Za-z0-9]/.test(p)) return "Add a symbol, like ! or #.";
  return null;
}

type AmplifyAuth = typeof import("aws-amplify/auth");

function amplifyClient(): AuthClient {
  let ready: Promise<AmplifyAuth> | null = null;
  // Amplify is loaded on first use so the sign-in screen paints before the library arrives.
  const auth = () =>
    (ready ??= (async () => {
      const [{ Amplify }, mod] = await Promise.all([import("aws-amplify"), import("aws-amplify/auth")]);
      const c = config();
      // Amplify's default token store is localStorage, so the refresh token survives closing the app.
      Amplify.configure({ Auth: { Cognito: { userPoolId: c.userPoolId, userPoolClientId: c.userPoolClientId } } });
      return mod;
    })());

  const step = (out: Awaited<ReturnType<AmplifyAuth["signIn"]>>): SignInStep => {
    if (out.isSignedIn || out.nextStep.signInStep === "DONE") return { kind: "done" };
    if (out.nextStep.signInStep === "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED") return { kind: "new_password" };
    throw Object.assign(new Error(`unsupported sign-in step ${out.nextStep.signInStep}`), { name: "UnsupportedStep" });
  };

  return {
    async currentUser() {
      try {
        const a = await auth();
        const s = await a.fetchAuthSession();
        if (!s.tokens?.accessToken) return null;
        const email = s.tokens.idToken?.payload.email;
        return { email: typeof email === "string" ? email : "" };
      } catch (e) {
        // Offline or a Cognito hiccup: the refresh token is still stored, so this is not "signed out".
        if (sessionGone(e)) return null;
        throw e;
      }
    },
    async signIn(email, password) {
      const a = await auth();
      // A half-finished earlier attempt must not get in the way.
      await a.signOut().catch(() => undefined);
      return step(
        await a.signIn({
          username: email.trim().toLowerCase(),
          password,
          options: { authFlowType: "USER_SRP_AUTH" },
        }),
      );
    },
    async setNewPassword(password) {
      return step(await (await auth()).confirmSignIn({ challengeResponse: password }));
    },
    async accessToken(fresh = false) {
      try {
        const s = await (await auth()).fetchAuthSession({ forceRefresh: fresh });
        return s.tokens?.accessToken?.toString() ?? null;
      } catch (e) {
        if (sessionGone(e)) return null;
        // A failed refresh because of the network or the service: report it as such, never as a sign-out.
        throw networkError();
      }
    },
    async signOut() {
      await (await auth()).signOut().catch(() => undefined);
    },
  };
}

/** Mock mode: a fake owner who is signed in unless the session says otherwise (tests use this). */
function mockClient(): AuthClient {
  const KEY = "cf.mockSignedOut";
  const signedOut = () => {
    try {
      return sessionStorage.getItem(KEY) === "1";
    } catch {
      return false;
    }
  };
  const set = (out: boolean) => {
    try {
      if (out) sessionStorage.setItem(KEY, "1");
      else sessionStorage.removeItem(KEY);
    } catch {
      /* private mode */
    }
  };
  // When the first-login challenge started; like Cognito's Session it is only good for 3 minutes.
  let pendingNew: number | null = null;
  return {
    async currentUser() {
      return signedOut() ? null : { email: "owner@example.com" };
    },
    async signIn(email, password) {
      await new Promise((r) => setTimeout(r, 400));
      pendingNew = null;
      if (password === "wrong") throw Object.assign(new Error("bad"), { name: "NotAuthorizedException" });
      if (email.startsWith("new")) {
        pendingNew = Date.now();
        return { kind: "new_password" };
      }
      set(false);
      return { kind: "done" };
    },
    async setNewPassword() {
      await new Promise((r) => setTimeout(r, 400));
      if (pendingNew === null || Date.now() - pendingNew > 180_000)
        throw Object.assign(new Error("Invalid session for the user, session is expired."), { name: "NotAuthorizedException" });
      pendingNew = null;
      set(false);
      return { kind: "done" };
    },
    async accessToken() {
      return signedOut() ? null : "mock-token";
    },
    async signOut() {
      set(true);
    },
  };
}

let client: AuthClient | null = null;

export function auth(): AuthClient {
  return (client ??= isMock ? mockClient() : amplifyClient());
}

/** Lets the app react when a call finds the sign-in gone (refresh token expired or revoked). */
const listeners = new Set<() => void>();
export function onSignedOut(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function announceSignedOut() {
  for (const fn of listeners) fn();
}
