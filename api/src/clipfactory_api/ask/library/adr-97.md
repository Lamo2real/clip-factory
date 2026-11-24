## ADR-97 Video drafts are their own item; vehicles are car bodies shown as Vehicles; roles are additive fields

- **Context.** The owner wants to save Make a new video before making it, a main character and a villain per video,
  and vehicles (plural, "it could even be a plane") made from outside and inside photos, with the Cars tab called
  Vehicles (CONTRACTS §45.47). Hard rules 2 and 4 forbid renaming stored names or replacing live data.
- **Options.** (1) Save a draft as a STORY# with status `draft`: that status already means "Not made yet", Make it
  would start production with nothing stale, and the idea would be marked used too early. (2) A new `VDRAFT#` item.
  For vehicles: (a) a new `kind: "vehicle"` and renamed fields (`script.vehicles`), which breaks every saved car and
  script; (b) keep `kind: "car"` and add bodies grouped into families worked out from `body`.
- **Decision.** Drafts are option 2: `VDRAFT#{draftId}`, `type="ws_video_draft"`, at most 50 of 32 KB, checked
  loosely, kept on the server and deleted in the same transaction that makes the video. Vehicles are option (b):
  bodies `bus`, `motorbike`, `plane`, `boat`, `VEHICLE_OF` for the family, an optional `CarLook.interior` from the
  inside photos, a `side` per reference, and the sets `sky` and `sea`. Only the visible name changes to Vehicles
  (`/stories/vehicles…`; `/stories/cars…` and the route names stay). Roles are a new optional `roles` on StoryInput
  and Story (`mainId` is the first person; `villainId` another person); a story's cast grows to 4 (3 people, 2
  vehicles); series and idea casts stay at 3.
- **Consequences.** Every change is an added field or item, so old cars, stories and scripts read as before and no
  migration is needed. A plane or boat is still a cartoon drawn by the car rig; cockpit, handlebar and helm shots and
  photo-real vehicles are follow-ups. Amends
  [ADR-85](#adr-85-the-second-app-is-called-clips-funded-on-screen-every-internal-name-stays) only by adding another
  visible-only rename (Cars to Vehicles).
