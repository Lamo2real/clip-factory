## 18. Skills: full create, read, update, delete; every AI call uses every skill (owner request, 2026-11-16)

The owner's words: *"I want to be able to create, read, update, delete skills in Settings, following the trees,
branches, apples, leaves structure. The whole AI system should use all of these skills by default, no matter what,
as long as I add them: whatever AI service we use (Bedrock, AgentCore, whatever), when it is generating stuff or
reading stuff."* Where this section and an earlier one disagree, this one wins. It supersedes: the skills routes in
the §5 table (already rewritten to point here), the §5 `Skill` interface, the §6 Skill row and built-in choice note, the
§7 `skills/` prefix, the §8 Skills bullet, the §9 `cf-prod-learn` environment and the §15.1 Skills row (each says so).

### 18.1 Always on (the switch is gone)

* **Every built-in skill and every skill the owner added is used by every model call that writes or reads text or
  images** (§18.6). There is no on/off switch anywhere: not in the web, not in the API, not in the agent.
* **API.** `Skill.enabled` is removed from every response. `PATCH /v1/skills/{skillId}` always answers `400
  bad_request` "Skills are always used now, so there is no switch." (any body, any skill; the route stays one
  release so an old cached app gets a plain message, then it is deleted). `POST`/`PUT` bodies with `enabled` → `400`
  (`validate.only_keys`). Legacy data: an owner item's `enabled` attribute is ignored on read and `REMOVE`d by the next
  `PUT`; the old built-in choice items (`SKILL#builtin-<name>`, `type="skill_choice"`) are ignored everywhere and
  `GET /v1/skills` deletes each one it sees (best effort, log `skill.choice_removed`; a failure is logged, never shown).
  `_owner_items` keeps only `type == "skill"` (or, for items written before §18, items with a `key` and no `builtin`).
* **Agent.** `prepare_skills` stops filtering: `builtin_choices` is deleted; every built-in folder and every owner row
  with `type == "skill"` (or a `key`) is used, whatever `enabled` says. Order: built-ins by name, then owner skills
  by `name` (ties by `skillId`); the old `createdAt` order is gone.
* **Built-ins**: readable, never editable or deletable, always used. `PUT`/`DELETE` on a built-in → `409 conflict`
  "Built-in skills are part of Clip Factory. You can read them, but not change or delete them."
* **Storage per revision.** Every saved file (create, edit, replace) goes to a new key
  `skills/{userId}/{skillId}/{revisionId}/SKILL.md` or `.../skill.zip` (`revisionId` = new ULID). The item's `key`
  points at the current one; after a successful save the previous key is deleted (best effort, log
  `skill.old_revision_left` on failure). Keys never change content, so readers can cache by key (§18.6) and a job
  that already started never sees a half-written file. Items from before §18 keep their old key until the next save.
  `register`/`PUT` accept a key only if it is `skills/{caller}/{skillId}/{26-char ULID}/(SKILL.md|skill.zip)` (or,
  for `register` only, the legacy key) and it exists (HEAD); anything else → `400` "That upload does not belong to you."

### 18.2 Create

**(a) Write a skill in the app** (`POST /v1/skills` with `{ "title", "description", "instructions" }`):

| Form question (web label) | Field | Rule (after trimming; `\r\n` → `\n`; control characters other than `\n`/`\t` removed) |
|---|---|---|
| "What is the skill called?" (example "Funny moments first") | `title` | 1–60 characters, at least one letter or digit |
| "When should Clip Factory use it?" (example "Every time it picks moments from my Minecraft videos.") | `description` | 3–1024 characters; newlines become single spaces (it is the frontmatter `description`) |
| "What should it do?" (example "Pick the moments where I laugh the loudest. Put the funniest part in the first 2 seconds. Never use bad words in captions.") | `instructions` | 1–50,000 characters |

The request body must be ≤ 256 KB (else `413 too_large`). The API (pure functions in `api/src/clipfactory_api/skills.py`):
* `slug(title)`: NFKD, drop combining marks, lowercase, every run of characters outside `[a-z0-9]` → `-`, trim `-`,
  cut to ≤ 64 at the last `-` that keeps it ≤ 64 (or hard cut), empty → `my-skill`. Examples: "Funny Moments FIRST!!"
  → `funny-moments-first`; "Ça va" → `ca-va`; "🎮🎮" → `my-skill`. It must match `NAME_RE`.
* **Unique**: the slug may not equal any built-in name or another owner skill's `name` (the skill being edited is
  excluded) → `409 conflict` with field hint `title`. The words depend on whose name it is and where it came from:

  | Clash | Form (write or edit; the web shows it under the first question) | Upload or replace (a toast; there is no name box) |
  |---|---|---|
  | owner's own skill | "You already have a skill called {title}. Pick another name." | "You already have a skill called {title}. To change it, open it and tap Replace the whole file." |
  | built-in name | "Clip Factory already has a skill called {title}. Pick another name." | "Clip Factory already has a skill called {title}. Change the name inside your file, then upload it again." |

  The API (`routes/skills.py` `_check_unique(..., source="form" | "upload")`) and the web (`skillName.ts`) use these
  exact words; if the **Write a skill** or **Replace the whole file** button is renamed, update both. A rare race
  between two saves is allowed; the agent still de-duplicates folder names (`_unique`).
* `build_skill_md(name, description, title, instructions, extra_frontmatter="")` →
  ```
  ---
  name: <slug>
  description: <description as a JSON double-quoted string>
  <extra_frontmatter lines, verbatim>
  ---

  # <title>

  <instructions>
  ```
  The `# <title>` line is left out when `instructions` already starts with a level-1 heading. The result must pass
  `read_frontmatter` (same name and description back) and be ≤ 1 MB (`MD_MAX_BYTES`), else `413 too_large`.
* Stored exactly like an uploaded `.md` (new `skillId`, revision key, `format "md"`, `source "written"`), item
  `title` = the typed title, `version 1`, `createdAt` = `updatedAt` = now. Log `skill.added` with `source`.

**(b) Upload** `.md` / `.zip`: as before (presign, PUT, `register`), plus `source "upload"`, `version 1`,
`updatedAt`, and `title` = `humanize(name)` (dashes → spaces, first letter upper: `funny-moments-first` → "Funny
moments first"). Built-ins also get `title = humanize(name)`, `source "builtin"`, `version 1`,
`updatedAt = createdAt = BUILTIN_CREATED_AT`.

### 18.3 Read

* `GET /v1/skills` → `{ skills: Skill[] }`: built-ins first (by name), then the owner's by `name`. Each has `title`,
  `description`, `builtin`, `source`, `format`, `size` (bytes of the stored file), `createdAt`, `updatedAt`, `version`.
* `GET /v1/skills/{skillId}` → `SkillDetail` (built-in ids are `builtin-<name>`, owner ids ULIDs; else `404`):
  ```ts
  interface SkillForm { title: string; description: string; instructions: string }
  interface SkillDetail { skill: Skill; content: string /* the SKILL.md text */;
                          form: SkillForm | null /* null for built-ins, or when it cannot be edited here */;
                          formBlocked?: "builtin" | "too_long" /* present only when form is null: why */;
                          files: string[] /* zip only: the other member paths, ≤ 500, sorted; [] for .md */ }
  ```
  `parse_form(item, text)`: `description` from the frontmatter; `title` = `item.title`; `instructions` = the body
  after the frontmatter with a leading `# <title>` line (and the blank lines after it) removed when it equals the title.
  `build_skill_md(parse_form(...))` round-trips for written skills (test). Body > 50,000 characters → `form: null`,
  `formBlocked "too_long"` (the web says "This skill is too long to change here. Upload a new file to replace it.").
* The web renders `content` as **safe markdown** with its own tiny renderer (`web/src/lib/markdown.ts`, no new
  dependency): headings, paragraphs, lists, block quotes, bold/italic, inline code and fenced code blocks become React
  elements; the frontmatter is not shown (the title and the "When it is used" card already say it), and a first
  heading that equals the title is left out so it is not said twice; raw HTML
  (`<script>`, `<img onerror>`, …) is shown as literal text; links are anchors only for `http:`, `https:`, `mailto:`
  (`target="_blank" rel="noopener noreferrer nofollow"`), everything else is text; markdown images are never loaded
  and show only "Picture: {alt}" ("Picture: no description" when the alt is empty), with no address. Nothing in `web/src` may use `dangerouslySetInnerHTML` (a Vitest grep test).
  Over 200,000 characters: the first 200,000 are shown with "This skill is very long; only the start is shown here."

### 18.4 Update (owner skills only)

`PUT /v1/skills/{skillId}`, two shapes, both carry the `version` the client last read (integer ≥ 1):
1. **Form** `{ version, title, description, instructions }` (same rules as §18.2). For an `.md` skill the new
   SKILL.md is `build_skill_md` with the old file's other top-level frontmatter keys kept verbatim (in their order;
   `name`/`description` replaced). For a `.zip` skill the API rewrites the zip: every member is copied unchanged
   (same names, order, dates) except `SKILL.md`, which is replaced by the rebuilt text; the result is re-checked with
   `skill_md_from_zip` and the upload zip limits (≤ 20 MB, ≤ 500 entries, ≤ 50 MB unzipped). `title`/`name` follow
   the new title (uniqueness as §18.2).
2. **Replace the whole file** `{ version, key }`: `key` comes from `POST /v1/skills/uploads` with
   `{ filename, skillId }` (the presign checks the skill is the caller's owner skill; built-in → `409`). The file is
   validated like an upload; its format may change (`.md` ↔ `.zip`); `name` from its frontmatter (unique), `title =
   humanize(name)`, `source "upload"`. The presign answers `{ skillId, key, uploadUrl, headers }`; an unknown skill →
   `404`. A replace file that is too big → `400` (as every upload); only a form save that grows past the size limits
   → `413 too_large`. A form save on a zip answers `413` only for those size limits and `400 bad_request` for any
   other problem with the stored zip.

**Zip members.** Every skill zip (upload, replace, form edit, and every model call that reads it, in both the API
and the agent) must have no password-locked member and use only the stored or deflate packing method. The API
answers `400 bad_request` "This .zip has a file locked with a password, which is not allowed. Make it again with no
password." / "This .zip was packed in a way we cannot open. Make it again with the normal Zip." (`skill_md_from_zip`,
`strict=True`; `strict=False` only lets the owner still read an older stored zip). At model-call time such a skill is
skipped and logged (`skills.skipped`) in both packages (agent `extract_zip` raises `SkillError`, never a raw
`RuntimeError`/`NotImplementedError`). Both packages accept exactly the same zips: the agent's `extract_zip` applies
every rule of the API's `skill_md_from_zip` to every member, `__MACOSX` entries included (at most 20 MB, at most 500
entries counting folders, safe names, no links, at most 50 MB unzipped, exactly one `SKILL.md` at the root or in one
top folder and at most 1 MB), and has no other size rule; it only skips `__MACOSX` and files outside the skill's
folder when extracting.

Order of a save: validate → write the new revision object → `UpdateItem` with `ConditionExpression version = :v`
(for a legacy item without `version`, `attribute_not_exists(version)` when `:v` is 1) setting `key`, `name`,
`title`, `description`, `format`, `size`, `source`, `updatedAt`, `version = :v + 1`, `REMOVE enabled` → delete the
old key. The condition failing (stale `version`) → delete the just-written object, `409 conflict` "This skill was
changed somewhere else. Load the newest one, then save again." The web then shows a glass sheet with **Use the
newest** (reloads the form, keeps nothing) and **Save mine anyway** (resends with the fresh `version`). A missing
skill → `404`. Success → `{ skill }` with the new `version`; log `skill.updated` (`shape: "form" | "file"`).
Changes apply to the next model call that loads skills (the agent loads them once per job at `analyze`).

### 18.5 Delete

* `DELETE /v1/skills/{skillId}` (owner skills): deletes the item, then every object under
  `skills/{userId}/{skillId}/` (List with that prefix + DeleteObjects; failures logged, never shown). Built-in → `409`.
* Web, consistent with §12.4 and the existing Undo pattern (`toast.undo`, `UNDO_MS = 8000`, commit on timeout or
  `pagehide`): the skill page's **Delete** opens a small glass sheet "Delete {title}? Clip Factory will stop using
  it." with **Delete** and **Keep it** (a sheet here because a skill can hold a lot of typing; it is the only
  confirm in Settings). Delete → back to the Skills branch, the row is gone, toast "Deleted {title}." with **Undo** for
  8 s; Undo puts the row back in place and no request is sent; the `DELETE` is sent when the toast ends; a failed
  `DELETE` puts the row back with an error toast (as today). No server-side soft delete.

### 18.6 Every AI call uses every skill (one shared rule)

**The rule.** Every text-generating or reading model call (Claude Agent SDK `query`, Bedrock `Converse`, now and
later, agent and API) gets the **skills block** as the **first** part of its system prompt. Embedding calls (Titan,
`invoke_model` in `vectors.py` of both packages) are not text generation and are left alone.

**The skills block** (identical builder in both packages: `agent/src/clipfactory_agent/skills.py` and the new
`api/src/clipfactory_api/skill_prompt.py`, function `skills_block(docs, *, where) -> SkillsBlock(text, counts)`):
* Input: built-ins sorted by name, then owner skills sorted by `name` (ties by `skillId`; both builders sort by
  `(not builtin, name, skill_id)`); each doc = `SkillDoc` (name, builtin, skill id, SKILL.md text). Only `SKILL.md` text goes in the block (other files in a zip are on disk for the Agent
  SDK only).
* `SKILL_MAX_PROMPT_CHARS = 40_000` per skill, `SKILLS_BUDGET_CHARS = 120_000` in total, `MIN_TRUNCATED_CHARS = 2_000`.
  Walk the docs in order: cut each to 40,000 characters (then append `\n…(shortened)`); if it does not fit what is
  left of the budget, cut it to what is left when that is ≥ 2,000 characters (marked the same way), else leave it out.
  Built-ins come first, so they are never the ones left out.
* Text (exact):
  ```
  <owner_skills count="{N}">
  These are the owner's skills. Follow every one of them in everything you write, pick, judge or describe, as long
  as that does not break this task's rules or answer format.
  <skill name="{name}" source="built-in|owner">
  {text}
  </skill>
  …
  <skills_left_out names="{a, b}">These skills were too long to fit this time.</skills_left_out>   (only when any)
  </owner_skills>
  ```
  `{N}` is the number of skills included in the block (not the total; left-out ones are only named in
  `skills_left_out`). With no skills at all the block is `<owner_skills count="0"></owner_skills>` (still first, so
  prompts stay uniform).
* `counts` = `{builtin, owner, included, truncated, omitted, chars}`; every block build logs
  `skills.block` with these counts plus `where` (`agent.job`, `api.distil`, `api.week`, `api.help` since §19.5a).
* `compose_system(block, task_system) -> list[SystemContentBlock]` returns `[{"text": block.text}, {"cachePoint":
  {"type": "default"}}, {"text": task_system}]` (the cache point only when `len(block.text) ≥ 8_000`, so the stable
  prefix is cached across a job's many calls). A `ValidationException` whose message mentions the cache point turns
  cache points off for the rest of the process (log `bedrock.cache_point_off`) and the call is retried without it,
  the same pattern as the forced `toolChoice` fallback; that retry does not use up one of the three answer attempts.
  In the agent, `compose_system` has an extra keyword `cache_point: bool = True` and the cache-point-off state lives on
  each `Bedrock` client (one per process); in the API it is module state (`turn_cache_points_off`). For the Agent SDK, `compose_system_text(block, task_system)`
  = `block.text + "\n\n" + task_system` (the SDK file system prompt).
* Golden test: both packages have `tests/fixtures/skills_block_golden.txt` built from the same three fixture skills
  (one built-in, two owner, one over 40,000 characters) and assert their builder's output equals it byte for byte.

**Agent** (`agent/**`). `prepare_skills` returns `SkillSet(docs, skipped)` (with a `full_text` property).
`JobState.skills_block` is built once in `analyze` right after `prepare_skills` (all skills, §18.1) and logged. Every call site takes it explicitly:

| Call | Where | How it gets the block |
|---|---|---|
| Moment selection, Agent SDK `query` | `agent.find_with_sdk` / `sdk_options` | `sdk_options(..., skills: SkillsBlock)`; prompt file = `compose_system_text(block, system_prompt(b))`; `.claude/skills` still has every skill |
| Moment selection fallback (Converse, `submit_moments`) | `agent.find_with_converse` | `bedrock.structured(..., skills=block)` |
| Facecam / layout vision | `bedrock.detect_layout(jpeg, w, h, *, skills)` | pipeline passes `functools.partial(self.bedrock.detect_layout, skills=st.skills_block)` to `render_clip` |
| Checklist judgement (incl. the hook check and `new_hook` rewrite) | `pipeline._review` | `structured(..., skills=block)` |
| Watching the picture, Fable on frames (ADR-40, §8) | `watch.watch_chunks` | `structured(..., skills=block)`, tool `report_scenes`; with a chat box on screen its prompt gets one more sentence (§37.6) |
| Watching the picture, Nova 2 Lite on video (ADR-40, §8) | `nova.watch_parts` | `structured(..., skills=block)` on the second `Bedrock` client (`cache_points=False`: the block is sent uncached) |
| The second look at each picked moment (ADR-40, §8) | `verify.second_look` | `structured(..., skills=block)`, tool `check_moment` |
| Captions (all platforms) | `captions.write_captions(..., skills=block)` | `structured(..., skills=block)` |

Hooks have no separate model call: they come from moment selection and the checklist's `new_hook`, both above.
`Bedrock.structured` gets a required keyword `skills: SkillsBlock` (no default; mypy catches a missing one) and builds
`system` with `compose_system`; `_call`/`_converse` stay private to `bedrock.py`. The old manual concatenations
(`"..." + skills_prompt(st.skills)`, `<owner_skills>` inside `system_prompt(b)`, `Brief.skills_text`) are removed, so
skills appear exactly once per prompt. `captions.required_tags` keeps reading the full (uncut) skills text.
A skill whose file cannot be fetched is retried 3 times, then skipped and logged (`skills.skipped`); the `analyze`
step message says so ("Found 12 loud moments. 1 skill could not be read."). A failure to read the skill rows fails the step
(normal step retry), so a job never silently runs without the owner's skills.

**API** (`api/**`).
* `skill_prompt.load_skills(store, media, user_id) -> list[SkillDoc]`: built-ins from the package
  (`skills.load_builtins()`), owner items from one Query `begins_with(sk, "SKILL#")` (`type == "skill"` or legacy
  rows with a `key`), each file read through a module-level LRU cache keyed by S3 `key` (revision keys never change;
  legacy keys by `(key, version)`), ≤ 64 entries / ≤ 16 MB per Lambda container. Caps: item `size` > 20 MB or
  SKILL.md > 1 MB → skipped. `NoSuchKey`/`AccessDenied` (no `ListBucket`, so a missing key reads as denied) → skipped
  and logged `skills.skipped`; other S3 errors are retried 3 times, then raised (the step fails and its normal retry
  runs). Zips: `skills.skill_md_from_zip`.
* `learn.converse_text(bedrock, model_id, system, user_text, *, max_chars, skills: SkillsBlock)` (required keyword)
  sends `system=compose_system(skills, system)`; everything else as §16.6 (maxTokens 4000, effort low, no sampling
  parameters). `distil_learning` (clip-flow `distil`, 48 h) and `ask_week` (`cf-prod-learn`) each load the block for
  the owner just before their call and pass it in. `clip_flow` deps and `weekly` deps gain `media` (`MEDIA_BUCKET`).
  Ask Clip Factory (§19.5) uses the same helper with its own settings through optional keywords: `max_tokens`,
  `request_fields` (replaces `additionalModelRequestFields`), `output_config` (JSON-schema `outputConfig`) and
  `on_response` (reads the token usage); the defaults are unchanged.
* `converse_text` is the only place in `clipfactory_api` that calls `.converse(`.

**No bypass (tests in each package).** `agent/tests/test_skills_everywhere.py` and
`api/tests/test_skills_everywhere.py` parse every `src/**/*.py` with `ast` and fail when:
* agent: a `.converse(` call is outside `bedrock.Bedrock._converse`; a `.structured(` call has no `skills=` keyword;
  `Bedrock._call`/`_converse` are reached from anywhere but `Bedrock.structured` (and each other); the Agent SDK is
  entered other than through `from claude_agent_sdk import query` inside `agent.find_with_sdk` with `options` built by
  `sdk_options(..., skills=)` (`ClaudeSDKClient` is not allowed); a model method name appears as a string;
  `getattr` / `attrgetter` / `methodcaller` take a computed name; `.converse`, `.structured`, `.detect_layout`,
  `sdk_options` or the SDK's `query` is used without being called (an alias; `functools.partial(..., skills=)` is the
  one allowed wrapper); `invoke_model` / `converse_stream` / `invoke_model_with_response_stream` appear outside the
  allow-list (`vectors.py` `invoke_model` only with `modelId=<…>.embed_model_id`, Titan);
* api: `.converse(` is outside `learn.converse_text`; a `converse_text(` call has no `skills=` keyword; `.converse` or
  `.invoke_model` is used without being called (an alias); `converse_text` is used without being called; a model
  method name appears as a string (`getattr`, dynamic calls); `getattr` / `attrgetter` / `methodcaller` take a
  computed name; `invoke_model` appears anywhere but `vectors.py` with `modelId=self.embed_model_id` (Titan);
  `converse_stream` / `invoke_model_with_response_stream` appear anywhere.
Both scans have the same strength: every way around the helper that one catches, the other catches too.
Each package also has a negative test per rule (a small sample package that must fail the scan). Any future model
call therefore has to go through these helpers.

### 18.7 Settings tree placement (web)

Tree **Clip making** → branch **Skills** (`/settings/clip-making/skills`) → apples, each with its leaf:

| Apple (anchor) | What it shows | Leaf (kid words) |
|---|---|---|
| **Your skills** (`#your-skills`) | every skill as a glass row: icon, title, description (2 lines), badges **Always used** (green, on every row) and **Built in**, and where it came from in words (no ".md", no size): "Written by you · Changed 16 Nov", "From a file · Changed 16 Nov" (.md), "From a file with extra files · Changed 16 Nov" (.zip; the skill page, which knows the count, says "From a file with {n} extra files", "1 extra file"), or "Comes with Clip Factory"; the whole row opens the skill page | "Clip Factory uses every skill here, every time it makes or checks anything." |
| **Add a skill** (`#add-skill`) | the vermilion **Write a skill** (→ `/skills/new`) and a glass **Upload a file** (.md / .zip, as today) | "Write one by answering three easy questions, or upload a skill file from your computer." |

Sub-routes (nested under the branch; the left folder panel keeps **Skills** highlighted; breadcrumb on every level;
big Back on phones goes one level up):

| Route | Page | Leaf |
|---|---|---|
| `/settings/clip-making/skills/new` | **Write a skill**: the three questions of §18.2 as big glass fields with their example under each (tap "Use the example" fills it), a live character count, one vermilion **Save skill**, a ghost **Cancel**. Errors sit under their field. Success: success sound, confetti, toast "Your skill is ready. Clip Factory will use it every time.", then the new skill's page. | "Clip Factory reads your skill every time it makes clips." |
| `/settings/clip-making/skills/{skillId}` | **Skill page**: title, badges, "When it is used" (description), the rendered skill (§18.3); zips list their other files. Owner skills: vermilion **Edit**, ghost **Delete** (§18.5). Built-ins: no Edit or Delete. | owner: "Always used. Changes count from your next clips." built-in: "This skill comes with Clip Factory. It is always used. You can read it, but not change or delete it." |
| `/settings/clip-making/skills/{skillId}/edit` | the same form filled from `form`, vermilion **Save changes**; for a zip a ghost **Replace the whole file**; `formBlocked "too_long"` shows only the replace option; a built-in id redirects to its page with an info toast. Leaving with unsaved changes asks "Leave without saving?" (**Keep editing** / **Leave**); when browser Back asked, **Leave** finishes that Back (no extra history entry, so the next Back goes one more step, even when it is pressed at once, while the page change still fades). The description box grows with its words and has no drag grip (it never gets wider than the form). | "Change the words, then tap Save changes." |


Router (`web/src/lib/router.ts`): `{ name: "skill", mode: "new" | "read" | "edit", skillId: string | null }`, nav
section `settings`; `skillId` must match `^[0-9A-HJKMNP-TV-Z]{26}$` or `^builtin-[a-z0-9-]{1,64}$`, else the
friendly "We could not find that skill" page with a button back to Skills (also for a `404`). A skill page opened
while that skill's delete **Undo** is still on screen shows "You just deleted this skill" / "Tap Undo at the bottom to
bring it back." (with **Back to Skills**) instead of the not-found page. Deep links and reloads
work at every level. `settingsTree.ts`: the two apples above with words `["new", "upload", "md", "zip"]` and
`["read", "edit", "change", "delete", "always used"]` (search "write a skill" → Add a skill, through its leaf; "write" is
not a word of its own so that Ask Clip Factory does not answer "write my homework" with it, §19.11). The old switch, its
`.is-off` style and `setSkillEnabled` are deleted. Layout: one column < 1024 px (rows full width, ≥ 48 px targets,
form fields full width, the instructions box ≥ 10 lines and auto-growing), two columns ≥ 1024 px (folder panel +
content, form max 720 px wide; on a skill's page the head with Edit/Delete, the meta line and the cards share one
820 px column, so the buttons end where the cards end, also when the head is too narrow for one row and they wrap
under the title, as with the setup list's column open beside the page, §17.13); nothing overflows from 320 to 1920 px (long names and unbroken words wrap,
`user-text`); click sound only on a click; error sound with error toasts.

Web API (`api/types.ts`): `listSkills()`, `getSkill(id): SkillDetail`, `writeSkill(form): Skill`,
`updateSkill(id, { version } & (SkillForm | { key })): Skill`, `createSkillUpload(filename, skillId?)`,
`createSkill({ skillId, key })`, `deleteSkill(id)`; `setSkillEnabled` and `skillContent` are removed.
`web/src/lib/skillName.ts` mirrors the API's `slug` and `humanize` (same examples as tests) for the duplicate-name
hint before saving; the API stays the judge.

### 18.8 Infra (`infra/**`)

* `modules/flows` `cf-prod-clip-flow`: new statement `{ Sid = "Skills", Action = ["s3:GetObject"], Resource =
  ["${var.media_bucket_arn}/skills/*"] }` (its `ClipFiles` statement stays `jobs/*`).
* `modules/stats` `cf-prod-learn`: new variables `media_bucket`, `media_bucket_arn`; env `MEDIA_BUCKET`; the same
  `Skills` statement. `envs/prod` passes `module.storage.media_bucket` / `media_bucket_arn`.
* No `s3:ListBucket` for either (keys come from the table). `cf-prod-api` already has `skills/*` get/put/delete and
  the prefix-limited list (used by §18.5); the agent role already reads the bucket. No route changes: the HTTP API is
  `ANY /v1/{proxy+}` and CORS already allows `PUT`.
* tftests: clip-flow and learn have exactly the `Skills` statement above (no wider S3 access, no list), learn has
  `MEDIA_BUCKET`, stats has no S3 access at all.

### 18.9 Mock mode and tests (offline, fakes only)

* **Mock API** (`web/src/api/mock`): every route of §18 with the same rules (slug, uniqueness, limits, version
  conflicts, built-ins read-only, `formBlocked`), fixtures with one built-in, one written `.md`, one `.zip` (with
  `files`) and one owner skill whose content contains `<script>alert(1)</script>` and a `javascript:` link; a test hook
  `window.__cfMock.bumpSkillVersion(skillId)` simulates an edit from another screen. `PATCH` answers the §18.1 400.
* **api** (`pytest`): `slug`/`humanize` table (examples above, 80-char title, emoji-only, accents); `build_skill_md` →
  `read_frontmatter` round-trip and `parse_form` round-trip; limits (title 0/61, description 2/1025, instructions
  50,001, body > 256 KB → 413, file > 1 MB → 413); uniqueness vs built-in and owner (409) and self-rename allowed; PUT
  form on md keeps extra frontmatter keys; PUT form on zip keeps every other member byte-identical; PUT replace with
  another skill's key → 400, md → zip allowed; stale `version` → 409 and the new object deleted, old kept; legacy item
  without `version` saves with `version 1`; built-in PUT/DELETE → 409; PATCH → 400 with the message; list has no
  `enabled`, sorts built-ins then owner by name, deletes `skill_choice` items; DELETE removes every revision; detail
  `form`/`formBlocked`/`files`; `skills_block` order, 40,000 cut, budget cut ≥ 2,000, omission list, empty block,
  counts log, golden file; `load_skills` caches by key (second call reads S3 zero times), skips oversize/missing/denied,
  raises after retries; `distil_learning` and `ask_week` send `system[0]` = the block (with a built-in and an owner
  skill's text, `enabled: false` legacy items included) and `system[-1]` = the task prompt; cache point present only
  ≥ 8,000 characters; `test_skills_everywhere.py`; the build zip contains `builtin_skills/*/SKILL.md`.
* **agent** (`pytest`): `prepare_skills` uses owner rows with `enabled: false` and ignores choice items, order by name;
  every fake Converse request from moment fallback, layout, review and captions has `system[0].text` starting with
  `<owner_skills`, and exactly one `<owner_skills` per request; the SDK prompt file starts with the block; cache point
  off after a cache `ValidationException`; a skipped skill is counted in the `analyze` message;
  `test_skills_everywhere.py`; golden file.
* **web**: Vitest for `markdown.ts` (script/HTML as text, `javascript:` not a link, images show only "Picture: {alt}", frontmatter and a repeated first heading not shown),
  `skillName.ts`, router parsing of the three sub-routes and bad ids, the `dangerouslySetInnerHTML` grep.
  **Playwright (mock mode)** `e2e/skills.spec.ts`, each test at **375×812** and **1440×900**: *create* (Write a skill →
  fill → Save → confetti → skill page → back → row with **Always used**; duplicate name shows the hint under the first
  question); *read* (open the fixture skill: heading rendered, `<script>` visible as text, no `role="switch"` on the
  Skills branch or any skill page (Sounds and Motion keep their own switches), built-in has no Edit/Delete); *update* (Edit → change → Save → new text shown; `bumpSkillVersion` →
  Save → conflict sheet → Use the newest / Save mine anyway; zip "Replace the whole file"; deep-link reload of
  `/edit`; Back goes up one level; Leave without saving prompt); *delete* (sheet → Delete → row gone → Undo → row back,
  no request; Delete again → after 8 s the mock `DELETE` ran). `overflow.spec.ts` adds `/settings/clip-making/skills`,
  `/new`, `/{id}`, `/{id}/edit` at 320, 375, 600, 768, 1024, 1440, 1920 px; `settings-tree.spec.ts` searches "write a
  skill"; `screenshots.spec.ts` adds the four pages at 375 and 1440 px, light and dark.
* **infra**: §18.8 tftests.

### 18.10 Who builds what (parallel builders; each stays inside its folder)

| Builder | Owns |
|---|---|
| api | `api/**`: `skills.py` (slug, humanize, build/parse form, zip rewrite), new `skill_prompt.py` (loader, cache, `skills_block`, `compose_system`), `routes/skills.py` + `routes/__init__.py` (GET one, PUT, PATCH 400), `s3.py` (revision keys), `learn.py` (`converse_text(..., skills=)`), `weekly.py` and `flows/clip_flow.py` (deps `media`, load the block), tests and golden file |
| agent | `agent/**`: `skills.py` (no filter, order, `skills_block`, `compose_system*`), `bedrock.py` (required `skills`, cache point and its fallback, `detect_layout`), `agent.py` (SDK prompt, fallback), `pipeline.py` (block in `analyze`, every call site), `captions.py`, `render.py` (detector signature), tests and golden file |
| web | `web/**`: Skills branch, the three sub-routes, `markdown.ts`, `skillName.ts`, router, `settingsTree.ts`, API types/client, mock API + fixtures, Vitest and Playwright tests, screenshots |
| infra | `infra/**`: §18.8 and tftests |
| docs | this section (done) and `docs/**` other than this file (BUSINESS_REQUIREMENTS, AGENT, ARCHITECTURE: "every model call gets the skills block"; DECISIONS ADR-32; UX_DESIGN_SYSTEM: the skill pages and the delete sheet; TESTING; SECURITY; ROADMAP) plus `README.md`, all by the docs builder; the web builder does not edit `docs/**` |

Shared names: `SkillsBlock(text, counts)`, `skills_block(docs, *, where)`, `compose_system(block, task_system)`,
`compose_system_text(block, task_system)`, `skill_prompt.load_skills(store, media, user_id)`,
`skills.slug(title)`, `skills.humanize(name)`, `skills.build_skill_md(...)`, `skills.parse_form(item, text)`,
constants `SKILL_MAX_PROMPT_CHARS = 40_000`, `SKILLS_BUDGET_CHARS = 120_000`, `MIN_TRUNCATED_CHARS = 2_000`,
cache point threshold `8_000` characters.
