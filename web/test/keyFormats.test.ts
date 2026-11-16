import { describe, expect, it } from "vitest";
import {
  cleanKey,
  extractConfigId,
  keyLooksRight,
  keyNames,
  keyProblem,
  keysBody,
  keysReady,
  maskKey,
  parseGoogleClientJson,
} from "../src/lib/keyFormats.ts";

// One good and one bad sample per row of docs/CONTRACTS.md §17.4 (the API tests use the same samples).
const SAMPLES = {
  youtube: {
    clientId: ["123456789012-abcdefghij0123456789klmnopqrst.apps." + "googleusercontent.com", "123456789012-abc.apps.google.com"],
    clientSecret: ["GOCSPX-" + "AbCdEfGhIjKlMnOpQrStUvWxYz12", "AbCdEfGhIjKlMnOpQrStUvWxYz12"],
  },
  tiktok: {
    clientId: ["awx1y2z3b4c5d6e7", "aw-x1y2"],
    clientSecret: ["Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe", "short"],
  },
  instagram: {
    clientId: ["1234567890123456", "12345abc90"],
    clientSecret: ["0123456789abcdef0123456789abcdef", "0123456789ABCDEF0123456789ABCDEF"],
    configId: ["9876543210987654", "config-1"],
  },
  facebook: {
    clientId: ["1234567890123456", "123"],
    clientSecret: ["fedcba9876543210fedcba9876543210", "fedcba98765432"],
    configId: ["1122334455667788", "abc"],
  },
  x: {
    clientId: ["dGhpc2lzYWNsaWVudGlkMTIz", "short"],
    clientSecret: ["c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0", "too-short-secret"],
  },
} as const;

describe("key formats (§17.4)", () => {
  for (const [platform, rows] of Object.entries(SAMPLES)) {
    for (const [name, [good, badValue]] of Object.entries(rows)) {
      it(`${platform} ${name}: a good one passes, a bad one says what it looks like`, () => {
        const p = platform as keyof typeof SAMPLES;
        const n = name as "clientId" | "clientSecret" | "configId";
        expect(keyProblem(p, n, good)).toBeNull();
        expect(keyLooksRight(p, n, good)).toBe(true);
        expect(keyProblem(p, n, badValue)).toMatch(/^That does not look right\. The .+\.$/);
      });
    }
  }

  it("lists the boxes each platform needs", () => {
    expect(keyNames("youtube")).toEqual(["clientId", "clientSecret"]);
    expect(keyNames("instagram")).toEqual(["clientId", "clientSecret", "configId"]);
    expect(keyNames("facebook")).toEqual(["clientId", "clientSecret", "configId"]);
  });

  it("forgives what copying brings along: spaces at the ends, quotes and invisible characters", () => {
    expect(cleanKey('  "GOCSPX-abc"​ ')).toBe("GOCSPX-abc");
    expect(keyProblem("youtube", "clientSecret", " GOCSPX-" + "AbCdEfGhIjKlMnOpQrStUvWxYz12\n")).toBeNull();
    expect(keyProblem("youtube", "clientSecret", "GOCSPX-AbCdEf GhIjKlMnOpQrStUvWxYz12")).toMatch(/space inside/);
    expect(keyProblem("youtube", "clientId", "")).toBeNull();
  });

  it("finds the Configuration ID inside a pasted Login URL", () => {
    const url = "https://www.facebook.com/v27.0/dialog/oauth?client_id=1234567890123456&config_id=9876543210987654&redirect_uri=x";
    expect(extractConfigId(url)).toBe("9876543210987654");
    expect(keyProblem("instagram", "configId", url)).toBeNull();
    expect(keysBody("instagram", { clientId: "1234567890123456", clientSecret: "0123456789abcdef0123456789abcdef", configId: url }).configId).toBe(
      "9876543210987654",
    );
  });

  it("is ready only when every box looks right", () => {
    expect(keysReady("x", { clientId: SAMPLES.x.clientId[0] })).toBe(false);
    expect(keysReady("x", { clientId: SAMPLES.x.clientId[0], clientSecret: SAMPLES.x.clientSecret[0] })).toBe(true);
    expect(keysBody("x", { clientId: ` ${SAMPLES.x.clientId[0]} `, clientSecret: SAMPLES.x.clientSecret[0] })).toEqual({
      clientId: SAMPLES.x.clientId[0],
      clientSecret: SAMPLES.x.clientSecret[0],
    });
  });

  it("masks like the API: first 6 and last 4 of the id, the last 4 of a secret", () => {
    expect(maskKey("clientId", "1234567890123456")).toBe("123456…3456");
    expect(maskKey("clientSecret", "0123456789abcdef0123456789abcdef")).toBe("••••cdef");
    expect(maskKey("configId", "9876543210987654")).toBe("…7654");
  });

  it("reads Google's downloaded client file", () => {
    const file = JSON.stringify({
      web: { client_id: SAMPLES.youtube.clientId[0], client_secret: SAMPLES.youtube.clientSecret[0], project_id: "clip-factory" },
    });
    expect(parseGoogleClientJson(file)).toEqual({ clientId: SAMPLES.youtube.clientId[0], clientSecret: SAMPLES.youtube.clientSecret[0] });
    expect(parseGoogleClientJson("GOCSPX-abc")).toBeNull();
    expect(parseGoogleClientJson("{not json")).toBeNull();
    expect(parseGoogleClientJson('{"web":{}}')).toBeNull();
  });
});
