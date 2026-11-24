// A few Chrome DevTools calls on the browser target only, over a plain WebSocket (Node 22+ has one built in). Used
// for the owner's TikTok login window (§47.10, D6): no page is ever attached there, so Google and TikTok see a plain
// Chrome; the helper only reads whether a TikTok session cookie has appeared (never its value) and closes the
// window. Also used to close a helper Chrome on another lane's port (one helper Chrome at a time).

/** The browser target's WebSocket URL on this port, or null when nothing answers there. */
export async function browserUrl(port, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/json/version`);
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body.webSocketDebuggerUrl === "string" ? body.webSocketDebuggerUrl : null;
  } catch {
    return null;
  }
}

/**
 * One command on the browser target. Resolves with its result; ``Browser.close`` also resolves when the connection
 * closes before an answer (Chrome is gone). Rejects when nothing answers on the port.
 */
export async function send(port, method, params = {}, { timeout = 10_000 } = {}) {
  const url = await browserUrl(port);
  if (!url) throw new Error("No helper Chrome on that port.");
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // already closed
      }
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("Chrome did not answer.")), timeout);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id !== 1) return;
      if (msg.error) finish(reject, new Error(String(msg.error.message || "Chrome refused.")));
      else finish(resolve, msg.result || {});
    };
    ws.onerror = () => finish(method === "Browser.close" ? resolve : reject, method === "Browser.close" ? {} : new Error("Chrome's connection failed."));
    ws.onclose = () => finish(method === "Browser.close" ? resolve : reject, method === "Browser.close" ? {} : new Error("Chrome closed."));
  });
}

/** Is there a TikTok session in this Chrome? true / false, or null when the Chrome is gone (the window was closed). */
export function hasTikTokSession(cookies) {
  return (cookies || []).some(
    (c) => c && c.name === "sessionid" && c.value && /(^|\.)tiktok\.com$/i.test(String(c.domain || "").replace(/^\./, ""))
  );
}

export async function sessionSeen(port) {
  try {
    const { cookies } = await send(port, "Storage.getCookies");
    return hasTikTokSession(cookies);
  } catch {
    return (await browserUrl(port)) ? false : null;
  }
}

/** Every cookie of the Chrome on this port (its own profile only): a login as the wrong account is undone. */
export async function clearCookies(port) {
  await send(port, "Storage.clearCookies");
}

export async function closeBrowser(port) {
  try {
    await send(port, "Browser.close", {}, { timeout: 5_000 });
  } catch {
    // already gone
  }
}
