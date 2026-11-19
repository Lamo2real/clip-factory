## ADR-32 Every AI call gets every skill through one shared skills block

- **Context.** The owner: *"The whole AI system should use all of these skills by default, no matter what, as long as
  I add them: whatever AI service we use (Bedrock, AgentCore, whatever), when it is generating stuff or reading
  stuff."* Before this, only the agent's moment picking read the skills; the facecam check, the checklist, the
  captions and the API's two learnings (the 48-hour `distil` and the weekly best) did not, and each skill had an on/off
  switch. The owner also wants to write, read, change and delete skills in Settings, following the trees, branches,
  apples and leaves.
- **Decision.**
  1. **No switch.** Every built-in skill and every skill the owner adds is always used. `enabled` is gone from the
     API, the agent and the app; old values are ignored and cleaned up.
  2. **One skills block, first in every system prompt.** Both Python packages have the same builder
     (`skills_block`), checked byte for byte against one shared reference file. It holds every skill's `SKILL.md`
     text, built-ins first, then the owner's by name, at most 40,000 characters per skill and 120,000 in total;
     a skill that does not fit is shortened or left out and named, and built-ins are never the ones left out.
     `compose_system` puts it before the task's own prompt, with a Bedrock prompt-cache point once it reaches 8,000
     characters. It covers every Claude call: the Agent SDK on AgentCore and every Bedrock Converse call, in the agent
     (moment picking and its fallback, facecam, checklist with the hook rewrite, captions) and in the Lambdas
     (`distil` and the weekly best). Titan embeddings are not text generation and get none.
  3. **Enforced by the type checker and by tests.** `skills` is a required argument (no default) of the helpers that
     call the model, and a test in each package reads its own source and fails if any model call goes around them.
  4. **Full CRUD in Settings.** Writing a skill is three plain questions (the API builds a valid `SKILL.md`); uploads
     work as before; each skill has its own page and edit page under the Skills branch; saves check a `version`, and
     every save is a new S3 object, so a running job never sees a half-written skill and files can be cached by key.
     Deleting asks once in a small glass sheet and then shows the usual 8-second Undo.
- **Alternatives.** *Keep the per-skill switch* (the owner said "no matter what": a skill that is quietly off is what
  the owner asked not to happen). *Skills only for moment picking* (the old behaviour; hooks, captions, facecam and
  learnings would ignore the owner's rules). *Ask the model to fetch skills with a tool when it wants* (the model could
  decide not to; Converse calls with forced tool choice cannot also call a skills tool; more round trips). *Pick the
  relevant skills per call by their description, or by embedding search* (cheaper prompts, but "all of them, no matter
  what" would become "the ones a classifier picked"; can be revisited if the skills grow very large). *A Bedrock
  AgentCore or Bedrock Agents feature for instructions* (Converse calls and the Lambdas would not get it; ties the rule
  to one service when the owner said "whatever AI service we use"). *Put the block last in the prompt* (the task's own
  rules and answer format would be the stable prefix instead, and the block could not be cached across calls with
  different tasks). *Delete with the Undo toast only, no sheet* (what §12.4 prefers, but a skill can hold a lot of
  typing, so a small sheet plus Undo is the one deliberate exception in Settings).
- **Consequences.** Every call costs more input tokens (up to about 120,000 characters of skills); the cache point
  makes the repeats within a job much cheaper, and the size caps keep any call within the model's limits. The owner's
  skills apply to things they may not have been written for (for example the facecam check); the block tells the model
  to follow them only as far as the task's own rules and answer format allow. A new model call anywhere in the code has
  to pass the block, or the build fails. The Lambdas `cf-prod-clip-flow` and `cf-prod-learn` gain read access to
  `skills/*` (no list), and `cf-prod-learn` gains `MEDIA_BUCKET`. A change to a skill counts from the next call that
  loads skills (for a clip job, the next job).
