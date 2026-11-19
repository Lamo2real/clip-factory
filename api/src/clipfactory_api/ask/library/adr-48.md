## ADR-48 Ask pictures go inline, are read once into words, and are never stored

- **Context.** The owner (2026-11-19) wants to show Ask a picture of the screen instead of explaining in words where
  they are. Ask's model only rewords a help answer that search found (§19.5), and search runs on words, so a picture
  helps only if it changes what search finds. A 6 to 8 year old must manage it.
- **Decision.**
  - *Inline*: up to 4 pictures go as base64 JPEG inside `POST /v1/help/answers`, each at most 600 KB after the
    browser re-encodes it to at most 1568 px (about 3.2 MB at most, under the Lambda's 6 MB and the HTTP API's 10 MB).
  - *Read once into words*: one "look" Converse call with image blocks returns `{page, words, seen}`; search runs on
    the question plus `words` and the page; the existing text-only rewrite follows with `picture` as data. Grounding is
    unchanged: a picture can change which help doc is found, never add a page, button, link or number.
  - *Never stored or logged*: the server forgets the pictures after the request; later turns carry only `seen` (one
    sentence), so follow-ups cost nothing more and send nothing again.
  - *Metadata stripped twice*: the browser re-encodes through a canvas and drops APPn segments; the API drops
    APP1..APP15 and COM before Bedrock, for direct API calls.
  - *No "show Ask this screen" button.*
- **Alternatives.** *Presigned S3 upload*: two more round trips, a new prefix with a lifecycle rule, `s3:GetObject`
  for the API role, and pictures stored somewhere, while chats live only in memory so "delete with the chat" is
  impossible; it pays off only above about 5 MB, which this design never reaches. *Re-sending the pictures every
  turn*: up to 8 000 more input tokens and seconds of upload per follow-up. *Capturing the page in the browser*
  (html2canvas or html-to-image, 40 to 200 KB): renders `backdrop-filter`, the SVG glass and `blob:` video wrong,
  cross-origin thumbnails taint the canvas, and `foreignObject` is unreliable in WebKit. *`getDisplayMedia`*: missing
  in the Mac app (WKWebView) and on iOS, and in Chromium it opens a screen picker a child cannot manage.
- **Consequences.** A follow-up about a detail that is not in `seen` needs the picture again (the owner re-attaches
  it). A picture question uses two units of the 30-day model cap and takes about 2 to 4 s longer. A daily picture
  limit (40) and a `pictures` kill-switch attribute bound the cost. Whether Claude Haiku 5.5 on the EU profile takes
  images with JSON-schema output must be confirmed after deploy; until it works every look is `error` and Ask answers
  in words with "I couldn't look at your picture this time." (`HELP_LOOK_MODEL_ID` is the additive way out). The Mac
  app's native drop handler is off, so the page decides what a drop does: only Ask takes one.
