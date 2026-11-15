import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchAuthSession = vi.fn();
const signOut = vi.fn(async () => undefined);
vi.mock("aws-amplify", () => ({ Amplify: { configure: vi.fn() } }));
vi.mock("aws-amplify/auth", () => ({
  fetchAuthSession,
  signOut,
  signIn: vi.fn(),
  confirmSignIn: vi.fn(),
}));

const { auth, challengeExpired, sessionGone } = await import("../src/lib/auth.ts");
const { loadConfig } = await import("../src/lib/config.ts");

const named = (name: string, message = "x") => Object.assign(new Error(message), { name });

beforeEach(async () => {
  fetchAuthSession.mockReset();
  await loadConfig(async () =>
    new Response(JSON.stringify({ region: "eu-north-1", userPoolId: "eu-north-1_x", userPoolClientId: "c", apiUrl: "https://api.test" })),
  );
});

describe("sessionGone", () => {
  it("is true only for errors that end the sign-in", () => {
    expect(sessionGone(named("NotAuthorizedException"))).toBe(true);
    expect(sessionGone(named("TokenRevokedException"))).toBe(true);
    expect(sessionGone(named("RefreshTokenReuseException"))).toBe(true);
    expect(sessionGone(named("NetworkError"))).toBe(false);
    expect(sessionGone(new TypeError("Failed to fetch"))).toBe(false);
    expect(sessionGone(named("InternalErrorException"))).toBe(false);
    expect(sessionGone(named("TooManyRequestsException"))).toBe(false);
    expect(sessionGone(null)).toBe(false);
  });
});

describe("challengeExpired", () => {
  it("spots a first-login challenge that ran out", () => {
    expect(challengeExpired(named("NotAuthorizedException", "Invalid session for the user, session is expired."))).toBe(true);
    expect(challengeExpired(named("SignInException"))).toBe(true);
    expect(challengeExpired(named("InvalidPasswordException"))).toBe(false);
    expect(challengeExpired(named("NetworkError"))).toBe(false);
  });
});

describe("amplify client", () => {
  it("is signed out when there are no tokens or the refresh token is gone", async () => {
    fetchAuthSession.mockResolvedValueOnce({ tokens: undefined });
    await expect(auth().currentUser()).resolves.toBeNull();
    fetchAuthSession.mockRejectedValueOnce(named("NotAuthorizedException"));
    await expect(auth().currentUser()).resolves.toBeNull();
  });

  it("does not report signed out when the refresh fails because of the network or the service", async () => {
    fetchAuthSession.mockRejectedValueOnce(named("NetworkError"));
    await expect(auth().currentUser()).rejects.toMatchObject({ name: "NetworkError" });
    fetchAuthSession.mockRejectedValueOnce(named("InternalErrorException"));
    await expect(auth().accessToken()).rejects.toMatchObject({ code: "network" });
    expect(signOut).not.toHaveBeenCalled();
  });

  it("returns null from accessToken only when the sign-in has ended", async () => {
    fetchAuthSession.mockRejectedValueOnce(named("TokenRevokedException"));
    await expect(auth().accessToken(true)).resolves.toBeNull();
    fetchAuthSession.mockResolvedValueOnce({ tokens: { accessToken: { toString: () => "tok" } } });
    await expect(auth().accessToken()).resolves.toBe("tok");
  });
});
