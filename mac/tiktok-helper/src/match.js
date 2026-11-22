// Pure text helpers: does a TikTok Studio row hold this clip's caption, and what is a post's link.

/** Lower case, accents and marks gone, every run of spaces one space (the §42 finder's rule, a little wider). */
export function normalize(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The part of a caption that must show in a Studio row: the first 40 characters (Studio may cut long ones). */
export function captionKey(caption) {
  return normalize(caption).slice(0, 40).trim();
}

export function captionMatches(rowText, caption) {
  const key = captionKey(caption);
  if (!key) return false;
  return normalize(rowText).includes(key);
}

/** The video id in a TikTok link (``/video/<id>``), or null. */
export function videoId(href) {
  const m = /\/video\/(\d{6,})/.exec(String(href || ""));
  return m ? m[1] : null;
}

/** ``https://www.tiktok.com/@name/video/<id>``. ``href`` may already be absolute or only a path. */
export function postLink(href, handle) {
  const id = videoId(href);
  if (!id) return null;
  const m = /@([A-Za-z0-9._]+)/.exec(String(href));
  const name = m ? m[1] : handle ? String(handle).replace(/^@/, "") : null;
  return name ? `https://www.tiktok.com/@${name}/video/${id}` : null;
}

/**
 * The new post for this caption among Studio's rows: a row whose id was not there before (``baseline``) and whose
 * text holds the caption. Two candidates = unsure = null (never guess a link).
 */
export function findNewPost(rows, caption, baseline) {
  const seen = new Set(baseline || []);
  const hits = rows.filter((r) => r.id && !seen.has(r.id) && captionMatches(r.text, caption));
  return hits.length === 1 ? hits[0] : null;
}

/** A row that already holds this caption (he posted it himself, or an earlier try did): a duplicate to avoid. */
export function findExisting(rows, caption) {
  const hits = rows.filter((r) => r.id && captionMatches(r.text, caption));
  return hits.length ? hits[0] : null;
}

/** A video file name that is safe on macOS and never overwrites a file in Downloads. */
export function freeName(name, exists) {
  const clean = String(name || "clip-factory.mp4").replace(/[/:\\\0]/g, "-");
  if (!exists(clean)) return clean;
  const dot = clean.lastIndexOf(".");
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : "";
  for (let n = 2; n < 1000; n++) {
    const next = `${stem} (${n})${ext}`;
    if (!exists(next)) return next;
  }
  return `${stem}-${Date.now()}${ext}`;
}
