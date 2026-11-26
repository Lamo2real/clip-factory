## 52. Attach files and images to a job's notes (owner request, 2026-11-26)

The owner: "i should be able to attach and paste images or files in general and if i want to drag and drop it will
highlight it a bit more when I hold the file and hover over the dropbox, also i should be able to delete it." Place:
the notes box on Home. BR-33, ADR-104.

- **F1. Limits.** Up to 6 files per job, 20 MB each. Allowed: images (png, jpeg, webp, gif), PDF, plain text, Markdown,
  CSV, JSON, and Word, Excel, PowerPoint, RTF and OpenDocument text files. Not allowed: videos (they go in "Pick a
  video") and anything else, each refused with one short sentence.
- **F2. Upload.** `POST /v1/uploads` takes an optional `purpose: "attachment"`. With it the type must be allowed (else
  400 "That kind of file can't be added.") and the size at most 20 MB (else 413 `too_large` "That file is bigger than 20
  MB."). The key is still `uploads/{userId}/{uploadId}/{filename}`, so the 14-day `uploads/` lifecycle cleans it up. No
  `purpose`: exactly as before (video only). The browser sends the file straight to S3 with the presigned PUT.
- **F3. Job create.** `POST /v1/jobs` takes optional `attachments` (at most 6) of `{key, name, type, size}`, nothing
  more per item. Each key must sit under the user's `uploads/` prefix and be safe, the object must exist and be at most
  20 MB, the type allowed, the name at most 255 characters, no key twice. Stored as `Job.attachments` only when not
  empty; old jobs have none; the API returns it as is. Retry, rerun and copies keep it. Deleting a job deletes no
  attachment (the lifecycle does).
- **F4. The agent reads them, no new model calls.** Readable: png, jpeg, webp, gif, PDF, plain text, Markdown, CSV,
  JSON. They ride in the existing prompts that already carry the owner's notes, as data that never changes the task.
  Cost bounds, named constants: text 20,000 characters per file and 60,000 across files in each prompt with the notes;
  images at most 3.75 MB and PDFs 4.5 MB and 20 pages each (unknown page count: skipped), at most 4 such blocks, sent
  only on the first Converse moment window and the captions call. A missing, expired, oversized or unreadable file is
  logged and skipped; the job never fails for it. Other allowed documents are saved only.
- **F5. The notes box.** Under the text: **Add files or images**, the hint "Logo, rules, screenshots. Up to 6 files, 20
  MB each.", then chips. Paste (Cmd or Ctrl+V) of a file or image anywhere in the Home form attaches it; a plain text
  paste still types. Drop on the notes box, or anywhere on the form for non-video files, attaches. A file held over the
  notes box lights it up with a stronger glass glow and "Drop to add", eased in and out (reduced motion: a plain fade).
  Links, Pick a video, video drops, How many clips, auto-posting and the draft work as before (a held video or a
  thumbnail with its link keeps the card's own highlight). Files can be added while the video uploads.
- **F6. A chip** shows a thumbnail or file icon, the name, the size, an eased progress bar while it uploads, and a
  remove button (44 by 44 px target, label "Remove {name}"). Remove acts at once and shows **Undo** for about 6 seconds.
  A failed file shows a short error and **Try again**; the other chips and the notes stay. A kind the agent can't read
  says "Saved, but Clip Factory can't read this kind of file." after its size.
- **F7. Make clips** waits for uploads in flight and sends only the finished ones. If a chip failed it says so in one
  line; pressing Make clips again goes on without it. Finished chips are kept in the draft as `{key, name, type, size}`.

Tests: `api/tests/test_attachments.py`, `agent/tests/test_attachments.py`, `web/test/attachments.test.tsx`.
