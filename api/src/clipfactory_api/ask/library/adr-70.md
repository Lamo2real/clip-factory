## ADR-70 Workspaces: Lamo Clips is the built-in workspace, new workspaces live in partitions of their own

- **Context.** The owner asked (2026-11-21) for a second studio, Lamo Stories, inside the same app and sign-in, with
  its own screens, content, jobs, settings and social accounts, and made protecting the existing app the highest
  priority: no renamed tables, attributes or resources, no change to how Lamo Clips looks or works. Every Lamo Clips
  item sits under `USER#{userId}`; the live-update and notification streams forward items by sort-key prefix; the
  stats poller follows `gsi2`; `posts.account_items` reads every `ACCOUNT#` under the user.
- **Options.** (1) Add a `workspaceId` attribute to every existing item and back-fill Lamo Clips' data (a migration of
  owner data, and every existing query would need a filter); (2) store Lamo Stories items under `USER#{userId}` with new
  sort-key prefixes (no migration, but every existing whole-partition read and the `ACCOUNT#` readers would see them,
  and an unlucky prefix would reach the streams); (3) Lamo Clips is the built-in workspace `clips`, never written, its
  data where it is; each other workspace gets a registry item in `USER#{userId}#WSREG` and its own partition
  `USER#{userId}#WS#{workspaceId}`, with sort-key prefixes no stream forwards; (4) a second table (new infrastructure
  the owner asked not to add without need).
- **Decision.** (CONTRACTS §45.3) Option 3. Ownership is in the key (built from the JWT's `sub`), checked again on
  every item's `userId` and `workspaceId`. The workspace registry holds `workspaceType` (`clips` built in, `stories`),
  so a later brand is a new workspace or one new type. In the web, `/stories/…` is Lamo Stories and every other path is
  today's shell; the choice persists on the device and in the URL. A web switch, `STORIES_ON`, keeps it hidden until
  all of it has merged.
- **Consequences.** No Lamo Clips item, query, stream, index or screen changes; nothing is migrated. Lamo Stories
  screens poll instead of using the WebSocket (no stream filter change). A user's data now spans more than one
  partition, so a future "delete everything" must walk the registry too (none exists today).
