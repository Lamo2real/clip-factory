// What the client tells the API about where it is (docs/CONTRACTS.md §19.6): fixed choices only, never free text.
import { currentOs, installedHere, type DeviceOs } from "../../lib/device.ts";
import type { Route } from "../../lib/router.ts";
import { HELP_PAGES, type HelpContext, type HelpDevice, type HelpPage } from "./types.ts";

/** Phones and tablets by OS and width; everything else wide is a desktop. */
export function deviceOf(os: DeviceOs, width: number): HelpDevice {
  if (width < 768) return "phone";
  if (os === "ios" || os === "android") return "tablet";
  return "desktop";
}

/** The route's name as the API's page enum: a name the API does not know (the mock-only pages) is "not_found". */
export function helpPage(name: Route["name"]): HelpPage {
  return (HELP_PAGES as readonly string[]).includes(name) ? (name as HelpPage) : "not_found";
}

export function helpContext(route: Route): HelpContext {
  const os = currentOs();
  const width = typeof window === "undefined" ? 1280 : window.innerWidth;
  return { device: deviceOf(os, width), os, installed: installedHere(), page: helpPage(route.name) };
}

/** Opens the panel from anywhere: `openHelp()` or `openHelp("How do I…?")`. */
export const HELP_EVENT = "cf:help";

export function openHelp(question?: string): void {
  window.dispatchEvent(new CustomEvent(HELP_EVENT, { detail: question ? { question } : {} }));
}
