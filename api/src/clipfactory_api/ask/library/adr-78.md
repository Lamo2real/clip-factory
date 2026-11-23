## ADR-78 Clip Stories' own agents, skills, chat and memory live in its runtime; actions wait for the owner's tap

- **Context.** The second request asks for its own agents and agent configuration, skills (upload, versions,
  enable/disable, assign to agents), a creative chat with history and memory, and reference-video analysis; Clip
  Factory's standing rule that every AI call gets all its skills belongs to Clip Factory.
- **Options.** Memory: AgentCore Memory (a managed service resource) or items in the workspace partition the owner
  can see and edit. Chat: an agent that acts on its own, or one that proposes and the owner taps. Skills: shared with
  Clip Factory, or Clip Stories' own.
- **Decision.** (CONTRACTS §45.26–§45.28) Five built-in agents with editable instructions, models, efforts and
  skills; Clip Stories' own skills only (Clip Factory's are never read); memory as `MEM#` items; the creative
  director's tools read and draft, and anything that costs a render or changes a video is a button the owner taps;
  reference videos are uploaded files analyzed from frames and sound.
- **Consequences.** The owner sees and edits everything the agents remember; nothing is published or rendered
  without his tap; Clip Factory's skills rule is untouched. Reference links to other people's videos are not
  downloaded (upload the file).
