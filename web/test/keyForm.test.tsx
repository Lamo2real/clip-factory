import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, PlatformSetup } from "../src/api/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let current: Partial<Api>;
vi.mock("../src/api/index.ts", () => ({ api: () => current }));

const { KeyForm, NO_DRAFT } = await import("../src/screens/settings/setup/KeyForm.tsx");
type KeyDraft = import("../src/screens/settings/setup/KeyForm.tsx").KeyDraft;
const { ToastProvider } = await import("../src/components/Toasts.tsx");

const ID = "123456789012-abcdefghij0123456789klmnopqrst.apps." + "googleusercontent.com";
const SECRET = "GOCSPX-" + "AbCdEfGhIjKlMnOpQrStUvWxYz12";
const setup: PlatformSetup = {
  platform: "youtube",
  stepsDone: [],
  ready: false,
  keys: { saved: false },
  account: { platform: "youtube", status: "not_connected" },
  gates: [],
};

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("KeyForm", () => {
  it("fills both YouTube boxes from Google's JSON pasted into one, then saves only through the API", async () => {
    const saved = vi.fn(async () => ({ ...setup, keys: { saved: true, hints: { clientId: "123456….com", clientSecret: "••••yz12" } } }));
    current = { saveSetupKeys: saved };
    const onSaved = vi.fn();
    act(() =>
      root.render(
        <ToastProvider>
          <KeyForm platform="youtube" setup={setup} primary onSaved={onSaved} />
        </ToastProvider>,
      ),
    );
    const [id, secret] = Array.from(host.querySelectorAll<HTMLInputElement>("input.key-field__input"));
    const save = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Save keys")!;
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(save.className).toContain("btn--primary");

    type(id!, JSON.stringify({ web: { client_id: ID, client_secret: SECRET } }));
    expect(id!.value).toBe(ID);
    expect(secret!.value).toBe(SECRET);
    expect(save.getAttribute("aria-disabled")).toBeNull();

    await act(async () => {
      save.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(saved).toHaveBeenCalledWith("youtube", { clientId: ID, clientSecret: SECRET });
    expect(onSaved).toHaveBeenCalled();
  });

  it("says what a wrong value looks like, and keeps Save keys off", () => {
    current = {};
    act(() =>
      root.render(
        <ToastProvider>
          <KeyForm platform="youtube" setup={setup} primary={false} onSaved={() => undefined} />
        </ToastProvider>,
      ),
    );
    const [, secret] = Array.from(host.querySelectorAll<HTMLInputElement>("input.key-field__input"));
    type(secret!, "not-a-secret");
    expect(host.textContent).toContain("That does not look right. The Client secret starts with GOCSPX-.");
    expect(secret!.getAttribute("aria-invalid")).toBe("true");
    const save = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Save keys")!;
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(save.className).not.toContain("btn--primary");
  });

  it("shows only the masked hints once saved", () => {
    current = {};
    const saved = { ...setup, keys: { saved: true, hints: { clientId: "123456….com", clientSecret: "••••yz12" } } };
    act(() =>
      root.render(
        <ToastProvider>
          <KeyForm platform="youtube" setup={saved} primary={false} onSaved={() => undefined} />
        </ToastProvider>,
      ),
    );
    expect(host.textContent).toContain("Keys saved");
    expect(host.textContent).toContain("123456….com");
    expect(host.textContent).toContain("••••yz12");
    expect(host.querySelectorAll("input.key-field__input")).toHaveLength(0);
  });

  it("keeps what was typed when its step folds and opens again (the page holds the draft)", () => {
    current = {};
    // The step's body (and the form with it) goes away while the step is folded; the page keeps the typing.
    function Page({ open }: { open: boolean }) {
      const [draft, setDraft] = useState<KeyDraft>(NO_DRAFT);
      return open ? <KeyForm platform="youtube" setup={setup} primary onSaved={() => undefined} draft={draft} onDraft={setDraft} /> : null;
    }
    const draw = (open: boolean) =>
      act(() =>
        root.render(
          <ToastProvider>
            <Page open={open} />
          </ToastProvider>,
        ),
      );
    draw(true);
    const [id] = Array.from(host.querySelectorAll<HTMLInputElement>("input.key-field__input"));
    type(id!, ID);
    expect(host.textContent).toContain("Looks right.");
    draw(false);
    expect(host.querySelectorAll("input.key-field__input")).toHaveLength(0);
    draw(true);
    expect(host.querySelector<HTMLInputElement>("input.key-field__input")!.value).toBe(ID);
    expect(host.textContent).toContain("Looks right.");
  });

  it("keeps Change keys open with its typing through a fold, and forgets the typing once saved", async () => {
    const savedSetup = { ...setup, keys: { saved: true, hints: { clientId: "123456….com", clientSecret: "••••yz12" } } };
    current = { saveSetupKeys: vi.fn(async () => savedSetup) };
    let seen: KeyDraft = NO_DRAFT;
    function Page({ open }: { open: boolean }) {
      const [draft, setDraft] = useState<KeyDraft>(NO_DRAFT);
      seen = draft;
      return open ? <KeyForm platform="youtube" setup={savedSetup} primary onSaved={() => undefined} draft={draft} onDraft={setDraft} /> : null;
    }
    const draw = (open: boolean) =>
      act(() =>
        root.render(
          <ToastProvider>
            <Page open={open} />
          </ToastProvider>,
        ),
      );
    draw(true);
    act(() => Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Change keys")!.click());
    const [id, secret] = Array.from(host.querySelectorAll<HTMLInputElement>("input.key-field__input"));
    type(id!, ID);
    type(secret!, SECRET);
    draw(false);
    draw(true);
    const again = Array.from(host.querySelectorAll<HTMLInputElement>("input.key-field__input"));
    expect(again.map((i) => i.value)).toEqual([ID, SECRET]);
    await act(async () => {
      Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Save keys")!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(seen).toEqual(NO_DRAFT);
    expect(host.textContent).toContain("Keys saved");
  });
});
