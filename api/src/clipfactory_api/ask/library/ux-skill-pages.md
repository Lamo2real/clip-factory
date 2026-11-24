## Skill pages

The owner's words: *"I want to be able to create, read, update, delete skills in Settings, following the trees,
branches, apples, leaves structure."* Contract:
[CONTRACTS.md §18.7](CONTRACTS.md#187-settings-tree-placement-web). Every skill is always used, so there is **no
switch** anywhere in the Skills branch.

**The branch** `Settings › Clip making › Skills` (`/settings/clip-making/skills`) has two apples:

| Apple | What it shows | Leaf |
|---|---|---|
| **Your skills** | every skill as a [skill row](#components), built-ins first, then the owner's by name; the whole row opens the skill's page | "Clip Factory uses every skill here, every time it makes or checks anything." |
| **Add a skill** | the vermilion **Write a skill** (the branch's one main action) and a glass **Upload a file** (.md / .zip) | "Write one by answering three easy questions, or upload a skill file from your computer." |

**Pages under the branch.** Each has its own address, a breadcrumb (`Settings › Clip making › Skills › Funny moments
first`), the big **Back** on phones (one level up), and the folder panel keeps **Skills** highlighted on desktop. Deep
links and reloads work at every level; an unknown id shows "We could not find that skill" with a button back to Skills.
A skill page opened while its delete can still be undone (for example with Back right after **Delete**) shows "You
just deleted this skill" and "Tap Undo at the bottom to bring it back." with **Back to Skills**, not the not-found
words.

| Page | Address | What is on it | Leaf |
|---|---|---|---|
| **Write a skill** | `…/skills/new` | Three big glass fields, one question each, with an example under each and a "Use the example" link that fills it: "What is the skill called?", "When should Clip Factory use it?", "What should it do?" (the last at least 10 lines tall and growing as you type). A live character count under each; errors (too long, same name as another skill) sit right under their field. Vermilion **Save skill**, ghost **Cancel**. | "Clip Factory reads your skill every time it makes clips." |
| **Skill page** | `…/skills/{skillId}` | Title, badges and where it came from in words (the same words as the row), "When it is used" (the description), then the skill itself as formatted text: headings, lists, bold, code. The frontmatter is not shown (the title and "When it is used" already say it), and a first heading that only repeats the title is left out. A `.zip` lists "Other files in this skill". Owner skills: vermilion **Edit**, ghost **Delete**. Built-ins: no buttons, only reading. | owner: "Always used. Changes count from your next clips." built-in: "Comes with Clip Factory. Always used. You can read it, but not change or delete it." |
| **Edit** | `…/skills/{skillId}/edit` | Titled "Change this skill": the same three fields, filled in, and vermilion **Save changes** (then the toast "Saved {title}. Clip Factory uses it from your next clips."). A `.zip` skill also gets a ghost **Replace the whole file**; a skill too long to edit here shows only that option ("This skill is too long to change here. Upload a new file to replace it."). | "Change the words, then tap Save changes." |

**Safe reading.** The skill text is shown with the app's own small markdown renderer, never as HTML: anything that
looks like HTML (`<script>`, `<img onerror=…>`) is shown as plain text, only `http`, `https` and `mailto` links are
links (they open in a new tab), and pictures are never loaded: only "Picture: {alt}" is shown ("Picture: no
description" when there is none), never the address. A very long
skill shows its first 200,000 characters with "This skill is very long; only the start is shown here."

**Sheets.** All three are small glass sheets (the 320 ms sheet motion), centred on desktop and from the bottom on
phones, with the safe choice focused first and Escape meaning the safe choice. They are near-solid glass (bottle green 0.95
to 0.94 over a deep green scrim at 0.55), so the page never shows through the question:

| When | Title | Words | Buttons |
|---|---|---|---|
| Delete on a skill page | "Delete {title}?" | "Clip Factory will stop using it." | **Keep it**, **Delete** |
| Saving a skill that changed on another screen | "This skill was changed somewhere else" | "It was changed on another screen. Use the newest one, or save yours over it." | **Use the newest** (reloads the form), **Save mine anyway** |
| Leaving an edit page with unsaved changes | "Leave without saving?" | "Your changes are not saved yet. If you leave, they are gone." | **Keep editing**, **Leave** |

**Name already used.** On the form the words sit under the first question: "You already have a skill called {title}.
Pick another name." or, for a built-in's name, "Clip Factory already has a skill called {title}. Pick another name."
An upload has no name box, so its error toast says what to do instead: "You already have a skill called {title}. To
change it, open it and tap Replace the whole file." or "Clip Factory already has a skill called {title}. Change the
name inside your file, then upload it again."

**Other words** (exactly as in the web code):

| Where | Words |
|---|---|
| Your skills, when there are none | "No skills yet. Tap Write a skill to teach Clip Factory how you like your clips." |
| Form, empty name | "Give your skill a name." |
| Form, name too long | "Make the name shorter: at most 60 letters." |
| Form, name with no letter or number | "Use at least one letter or number in the name." |
| Form, "When should Clip Factory use it?" too short / too long | "Say when Clip Factory should use it, in a few words." / "Make this shorter: at most 1024 letters." |
| Form, "What should it do?" empty / too long | "Say what the skill should do." / "Make this shorter: at most 50,000 letters." |
| Upload, not a `.md` or `.zip` (toast) | "That is not a skill. Pick a SKILL.md file or a .zip with one inside." |
| Upload, too big (toast) | "That skill file is too big. Pick one under 1 MB." / "That .zip is too big. Pick one under 20 MB." |
| Replace the whole file (hint under the heading) | "Pick a skill file. It replaces this skill." |
| Opening a built-in's edit address (toast, then its page) | "Built-in skills can be read, but not changed." |

The delete sheet is the only confirm in Settings, because a skill can hold a lot of typing. After **Delete** the app
goes back to the Skills branch, the row is gone, and the usual toast "Deleted {title}." offers **Undo** for 8 seconds;
nothing is sent until the toast ends, and a failed delete puts the row back with an error toast ("{problem} The skill
is back in your list.") and the error sound.

**Layout.** Below 1024 px: one column, rows and fields full width, every target at least 48 px, the buttons stacked
under the form. From 1024 px: the folder panel on the left and the content on the right, the form at most 720 px wide.
Titles, descriptions, file names and long unbroken words wrap (`user-text`); nothing overflows from 320 to 1920 px.
The click sound plays only on a click; the error sound comes with every error toast; success sound and confetti only
when a new skill is saved.
