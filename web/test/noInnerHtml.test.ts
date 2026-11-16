import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("no raw HTML from text (§18.3)", () => {
  it("nothing in web/src uses dangerouslySetInnerHTML", () => {
    const using = files(SRC).filter((f) => readFileSync(f, "utf8").includes("dangerouslySetInnerHTML"));
    expect(using).toEqual([]);
  });

  it("nothing in web/src sets innerHTML or outerHTML either", () => {
    const using = files(SRC).filter((f) => /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML/.test(readFileSync(f, "utf8")));
    expect(using).toEqual([]);
  });
});
