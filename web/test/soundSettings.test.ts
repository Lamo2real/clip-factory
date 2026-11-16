import { describe, expect, it } from "vitest";
import { seed } from "../src/api/mock/fixtures.ts";
import { mockApi } from "../src/api/mock/index.ts";
import type { Settings } from "../src/api/types.ts";
import { withSoundDefaults } from "../src/app/session.tsx";

describe("click and error sound settings", () => {
  it("the mock starts with the owner's picks", async () => {
    const s = await mockApi(seed()).getSettings();
    expect(s.clickSound).toBe(6);
    expect(s.errorSound).toBe(5);
  });

  it("saves a new pick and rejects anything but a whole number 1..30 with a plain message", async () => {
    const api = mockApi(seed());
    expect((await api.putSettings({ clickSound: 12, errorSound: 30 })).clickSound).toBe(12);
    await expect(api.putSettings({ clickSound: 0 })).rejects.toThrow("Pick a click sound from 1 to 30.");
    await expect(api.putSettings({ errorSound: 31 })).rejects.toThrow("Pick an error sound from 1 to 30.");
    await expect(api.putSettings({ errorSound: 2.5 })).rejects.toThrow("Pick an error sound from 1 to 30.");
    const now = await api.getSettings();
    expect([now.clickSound, now.errorSound]).toEqual([12, 30]);
  });

  it("settings stored before sounds could be picked read as the defaults", () => {
    const old = { clipMin: 5, clipMax: 10, soundEnabled: true } as unknown as Settings;
    expect(withSoundDefaults(old)).toMatchObject({ clickSound: 6, errorSound: 5 });
    expect(withSoundDefaults({ ...old, clickSound: 3, errorSound: 40 })).toMatchObject({ clickSound: 3, errorSound: 5 });
  });
});
