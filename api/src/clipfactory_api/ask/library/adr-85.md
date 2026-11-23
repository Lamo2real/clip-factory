## ADR-85 The second app is called Clips Funded on screen; every internal name stays

- **Context.** The second app was built as Lamo Stories and renamed Clip Factory Stories on 2026-11-22. The same day
  the owner chose another name: "actually i like the name clip factory for the streamers clipping, and id actually
  like to use the name clip stories for the other application that we wanted to name clip factory stories". On
  2026-11-23 they chose the final one: "i'd like to change the name of the new app finally to funded clips".
- **Options.** (1) Rename what people see only; (2) also rename the internal names (workspace type, keys, routes,
  resources), which would move or orphan the owner's stored data and replace live AWS resources.
- **Decision.** (CONTRACTS §45) Option 1. Every visible name (screens, page titles, labels, API and agent sentences,
  prompts, skills, config labels, help and docs) reads "Clips Funded"; the streamer-clipping app stays "Clip Factory".
  A workspace stored with an old default name ("Lamo Stories", "Clip Factory Stories", "Clip Stories" or "Funded
  Clips") shows as "Clips Funded" (API `shown_workspace_name`, web `shownWorkspaceName` as a fallback); the stored
  record is never rewritten, and a new workspace gets "Clips Funded". Internal names stay as before: the workspace
  type and id `stories`, the `/stories` and `/v1/workspaces` routes, storage and setting keys (`cf.storiesPreview`,
  `cf.stories.*`), DynamoDB keys, S3 and Secrets Manager paths, CSS classes, test ids, Terraform
  (`module.stories_agent`, `cf-prod-*`) and the package `lamostories_agent`. One code move: the logo is the shell's
  (`web/src/components/WorkspaceMark.tsx`, `web/src/styles/ws-mark.css`, `.ws-mark*`, CONTRACTS §45.38), so it stays
  out of Clips Funded's own code.
- **Consequences.** No data or resource change; the deploy replaces nothing. Terraform changes one text in place: the
  email text (`alarm_description`) of Clips Funded's agent alarm, `cf-prod-stories-agent-errors`. The deploy's Clip
  Factory check counts a commit that names "Clips Funded", "Funded Clips", "Clip Stories", "Clip Factory Stories" or
  "Lamo Stories" (whole words, any case) as Clips Funded work. An agent whose stored text is a former default still
  counts as not edited (`formerInstructions` keeps every earlier default text: Lamo Stories, Clip Factory Stories,
  Clip Stories and Funded Clips). Old code comments may still say Lamo Stories; they are not shown to anyone.
- **Amended (2026-11-23).** The same day the owner renamed it "Clips Funded" to match its YouTube channel: "my youtube
  channel is already called clips funded so i need to rewrite the app name to Clips Funded". Every visible name reads
  "Clips Funded" (the switch "Clip Factory | Clips Funded", the wordmark Clips *Funded*); "Funded Clips" joins the old
  defaults above. Nothing stored and no internal name changes; Terraform changes texts in place only (the agent
  alarm's email text and the agent runtime's description).
