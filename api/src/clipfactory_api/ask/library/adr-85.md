## ADR-85 The second app is called Clip Stories on screen; every internal name stays

- **Context.** The second app was built as Lamo Stories and renamed Clip Factory Stories on 2026-11-22. The same day
  the owner chose another name: "actually i like the name clip factory for the streamers clipping, and id actually
  like to use the name clip stories for the other application that we wanted to name clip factory stories".
- **Options.** (1) Rename what people see only; (2) also rename the internal names (workspace type, keys, routes,
  resources), which would move or orphan the owner's stored data and replace live AWS resources.
- **Decision.** (CONTRACTS §45) Option 1. Every visible name (screens, page titles, labels, API and agent sentences,
  prompts, skills, config labels, help and docs) reads "Clip Stories"; the streamer-clipping app stays "Clip Factory".
  A workspace stored with either old default name ("Lamo Stories" or "Clip Factory Stories") shows as "Clip Stories"
  (API `shown_workspace_name`, web `shownWorkspaceName` as a fallback); the stored record is never rewritten, and a
  new workspace gets "Clip Stories". Internal names stay as before: the workspace type and id `stories`, the `/stories`
  and `/v1/workspaces` routes, storage and setting keys (`cf.storiesPreview`, `cf.stories.*`), DynamoDB keys, S3 and
  Secrets Manager paths, CSS classes, test ids, Terraform (`module.stories_agent`, `cf-prod-*`) and the package
  `lamostories_agent`. One code move: the logo is the shell's (`web/src/components/WorkspaceMark.tsx`,
  `web/src/styles/ws-mark.css`, `.ws-mark*`, CONTRACTS §45.38), so it stays out of Clip Stories' own code.
- **Consequences.** No data or resource change; the deploy replaces nothing. Terraform changes one text in place: the
  email text (`alarm_description`) of Clip Stories' agent alarm, `cf-prod-stories-agent-errors`. The deploy's Clip
  Factory check counts a commit that names "Clip Stories", "Clip Factory Stories" or "Lamo Stories" as Clip Stories
  work. An agent whose stored text is a
  former default still counts as not edited (`formerInstructions` keeps the earlier texts). Old code comments may still say
  Lamo Stories; they are not shown to anyone.
