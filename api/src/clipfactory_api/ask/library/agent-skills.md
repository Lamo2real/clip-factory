## Skills

Skills tell the agent what "good" looks like. They are plain `SKILL.md` files with YAML frontmatter (`name`,
`description`) and markdown instructions, the same format Claude uses everywhere. The owner's rule: **every skill is
used by every AI call, always**
([CONTRACTS.md §18](CONTRACTS.md#18-skills-full-create-read-update-delete-every-ai-call-uses-every-skill-owner-request-2026-11-16),
[ADR-32](DECISIONS.md#adr-32-every-ai-call-gets-every-skill-through-one-shared-skills-block)).

- **Built-in skills** live in [`skills/`](../skills/viral-clip-editing/SKILL.md) in the repository and are
  bundled into the agent image at `/app/skills`. Today there is one: `viral-clip-editing` (which moments go
  viral and why, reading faces and sound, where to start and end, the hook and tease, the cover frame, post text per
  platform, a final check). It only asks for what the pipeline can act on (it replaced `short-form-video-playbook`
  on 2026-11-18). The owner can read them in the app but
  not change or delete them.
- **Owner skills** are made in Settings › Clip making › Skills: written in the app by answering three questions (the
  API turns the answers into a `SKILL.md`), or uploaded as a `.md` file or a `.zip` containing one `SKILL.md` (with
  any supporting files). The owner can read, change and delete them. Every save is a new file at
  `skills/<userId>/<skillId>/<revisionId>/` in the media bucket, so a job that already started never sees a
  half-written skill.
- **All of them, always.** There is no on/off switch. The agent uses every built-in skill and every skill the owner
  has, whatever an old `enabled` value says.

### How the skills reach every call

At `analyze` the agent loads the skills once for the job (`prepare_skills`): built-ins by name first, then the
owner's by name. It writes each to `<workdir>/.claude/skills/<name>/SKILL.md` (zips are extracted next to it), so the
Claude Agent SDK also discovers them the normal way, and it builds one **skills block**: every skill's `SKILL.md`
text inside `<owner_skills>`, the same text for the whole job. The `analyze` step says how many skills it uses
("Found 12 loud moments. 1 skill could not be read.").

The block is the **first** part of the system prompt of every model call the agent makes:

| Call | How |
|---|---|
| Moment picking (Claude Agent SDK on AgentCore) | the SDK's system prompt file starts with the block |
| Moment picking fallback (Bedrock Converse) | `Bedrock.structured(..., skills=block)` |
| Facecam check (Bedrock Converse, one frame) | `Bedrock.detect_layout(..., skills=block)` |
| Watching the picture (Fable, frames of every 150-second chunk) | `Bedrock.structured(..., skills=block)` in `watch.py` |
| Watching the picture, second watcher (Nova 2 Lite, each 300-second video part) | `Bedrock.structured(..., skills=block)` in `nova.py`, on a second client with no cache point (Nova's prompt cache is smaller than the block) |
| The second look at each picked moment and spare (Fable, every frame of the moment) | `Bedrock.structured(..., skills=block)` in `verify.py` |
| Checklist judgement, including the hook check and the new hook it may write | `Bedrock.structured(..., skills=block)` |
| Captions for every platform | `Bedrock.structured(..., skills=block)` |

Hooks have no call of their own: they come from moment picking and the checklist, both above. `skills` is a required
argument of `Bedrock.structured` with no default, so a call without it does not type-check, and
`agent/tests/test_skills_everywhere.py` reads the whole package and fails if any model call goes around these helpers.
The only model call without the block is the Titan embedding in `vectors.py` (turning text into numbers is not
writing or reading).

**Size.** Each skill goes in up to 40,000 characters and all of them together up to 120,000. A skill that does not
fit is shortened (marked "…(shortened)") when at least 2,000 characters are left, otherwise left out and named in the
block and the logs (`skills.block`). Built-ins come first, so they are never the ones left out. A block of 8,000
characters or more gets a Bedrock prompt-cache point, so the job's many calls reuse it; if Bedrock refuses the cache
point, it is turned off and the call retried without it.

**When reading fails.** A skill file that cannot be read is retried 3 times, then skipped and counted in the
`analyze` message. If the list of skills itself cannot be read, the step fails and retries, so a job never runs
without the owner's skills.

A skill added or changed in Settings is used by the very next job; nothing is redeployed. The API's own Claude calls
(the 48-hour learning and the weekly best learning) get the same block, built the same way
([below](#learnings-loop)).

If two skills disagree, the owner's own skills win over built-in ones, and the more specific instruction wins over
the general one. The agent says so in the clip's summary when it had to choose.
