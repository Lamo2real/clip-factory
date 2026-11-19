## ADR-27 Settings as a navigable tree with real routes

- **Context.** Settings grew one flat page at a time: clip range, skills, cookies, accounts, platforms, sound, motion,
  background, Get the app, updates, sign out, and now 60 sounds. The owner asked for it to be organised "like a
  folder structure": a field (all of Settings), trees, branches, apples (the settings) and leaves (their help), "so
  that it is all organized". It must stay kid-proof (UX-13).
- **Decision.** Settings is a fixed tree of four trees and eleven branches
  ([CONTRACTS.md §15.1](CONTRACTS.md#15-settings-as-a-tree-and-choosing-your-click-sounds-owner-request-2026-11-16)),
  described once as data in the web app (each node: id, name, icon, one line, its apples and leaves, extra search
  words) and drawn from that data by the field page, the tree and branch pages, the breadcrumb, the folder panel and
  search. Every tree and branch is a **real route** (`/settings/{tree}/{branch}`), not a tab, an accordion or a hash.
  Below 1024 px you drill down one level at a time with a breadcrumb and a Back button; from 1024 px a folder panel
  shows the whole tree beside the content. Old addresses redirect.
- **Alternatives.** *One long page with headings and anchors* (the old way: hard to scan, search scrolls a long page,
  and a 60-card picker would bury everything below it). *Tabs* (four tabs fit, but branches inside tabs need a second
  tab row; no deep links without extra work). *Accordions on one page* (state lives in the page, not the address;
  Back does not close them; deep levels are fiddly on a phone). *A modal or a sheet* (no address, nothing to bookmark).
- **Consequences.** Links, reloads, bookmarks, browser Back and the OAuth return (`/settings?account=…`) all land on
  the right place, and Playwright can open any branch directly. Adding a setting means adding an apple to the data
  under the right branch; the rule "never loose on the field or a tree page" keeps the tree tidy. Search, the panel
  and the breadcrumb cannot drift apart because they read the same data. The cost is a few more routes and a redirect
  table for the old anchors, which must stay.
