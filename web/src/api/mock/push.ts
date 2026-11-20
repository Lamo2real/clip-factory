// The notification routes of docs/CONTRACTS.md §32.3 in memory. The key is a fixed P-256 public key (65 bytes): the
// mock build never sends anything; e2e tests stand in for the browser's push service. Only bundled into mock builds.
import { ApiError } from "../errors.ts";
import type { Api, PushDevice } from "../types.ts";

export type PushApi = Pick<Api, "pushKey" | "listPushDevices" | "savePushDevice" | "deletePushDevice" | "sendTestPush">;

/** A real P-256 public key (uncompressed point), so the browser accepts it as an applicationServerKey. */
export const MOCK_PUSH_KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
const LABELS = ["iPhone", "iPad", "Mac", "Windows", "Android", "Linux", "Chromebook", "This device"];

export function pushApi(): PushApi {
  const devices = new Map<string, PushDevice>();
  let lastTest = 0;
  return {
    async pushKey() {
      return MOCK_PUSH_KEY;
    },
    async listPushDevices() {
      return [...devices.values()];
    },
    async savePushDevice(deviceId, body) {
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(deviceId)) throw new ApiError(400, "bad_request", "That device id is not valid.");
      if (!body.endpoint.startsWith("https://")) throw new ApiError(400, "bad_request", "Notifications only work with Safari, Chrome, Edge or Firefox.");
      if (!LABELS.includes(body.deviceLabel)) throw new ApiError(400, "bad_request", "Unknown device name.");
      const now = new Date().toISOString();
      const device: PushDevice = { deviceId, kind: "webpush", deviceLabel: body.deviceLabel, createdAt: devices.get(deviceId)?.createdAt ?? now, updatedAt: now };
      devices.set(deviceId, device);
      return { ...device };
    },
    async deletePushDevice(deviceId) {
      devices.delete(deviceId);
    },
    async sendTestPush(deviceId) {
      const targets = deviceId ? [...devices.keys()].filter((d) => d === deviceId) : [...devices.keys()];
      if (!targets.length) throw new ApiError(404, "not_found", "Turn on notifications on this device first.");
      if (Date.now() - lastTest < 10_000) throw new ApiError(429, "conflict", "Wait a few seconds, then try again.");
      lastTest = Date.now();
      // What the service worker would show: the e2e tests read it from the page.
      (window as Window & { __cfMockPushes?: unknown[] }).__cfMockPushes?.push({ title: "Clip Factory", body: "Notifications are on 🎉" });
      return { sent: targets.length, devices: targets.length };
    },
  };
}
