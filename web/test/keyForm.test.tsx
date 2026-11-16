import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, PlatformSetup } from "../src/api/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let current: Partial<Api>;
vi.mock("../src/api/index.ts", () => ({ api: () => current }));

const { KeyForm } = await import("../src/screens/settings/setup/KeyForm.tsx");
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
});
