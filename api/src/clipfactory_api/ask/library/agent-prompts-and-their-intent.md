## Prompts and their intent

The prompts are part of the agent code in `agent/`. What each one is for:

| Prompt | Intent | Output |
|---|---|---|
| System | Who the agent is (a short-form editor for this owner), the rules it may never break (never publish; only clip what the source contains; plain English), and that skills and learnings come first. Every system prompt, in the agent and in the API, starts with the skills block ([above](#how-the-skills-reach-every-call)). | – |
| What worked before | Per similar past clip: moment type, hook, title, summary, views and likes, similarity; the owner's starred clips first, labelled "Owner's pick: best of the week". Advice, never a rule. | (part of the select prompt) |
| Prior learnings | Right after the skills block, in the select prompt, the second look, the checklist review and the captions: the heading "Prior learnings", a one-line note that these are patterns from this creator's past clips (advice, never a rule), then one plain pattern per line ([below](#prior-learnings)). Left out when there are none. Not in the watch prompts, which only report what is seen. | (part of those prompts) |
| Learnings brief | The latest 4 "Best of week" learnings under "The owner's best-of-week picks taught"; left out when there are none. | (part of the select prompt) |
| Watch | For one chunk of frames (or one video part) with its words: report what is seen as events a clip could be built on, strongest first, and say when nobody is talking. Only what the frames show. | `{scene, events[]}`: start, end, kind, what, intensity 1–10, silent, face, text on screen |
| Window scan | For one transcript window plus its loudness spikes, and, when the picture was watched, the picture notes between the lines, the fast-picture seconds and the hot spots: find every candidate moment that fits one of the six moment types and stands on its own. A moment may have no talking; then `first_words` says what is heard and the hook must match what is seen. Picture notes are machine-made evidence like loudness, not proof. | Structured list: start, end, moment type, why, draft hook |
| Second look | Every frame of one picked moment with its words: does it hold up, should the start or end move a little, is the hook honest about what is seen? When unsure, keep. | keep, start, end, payoff, peak, hook ok, new hook, picture score, what was seen |
| Rank and pick | All candidates together: remove overlaps, prefer variety of moment types, pick between `clipTarget.min` and `max`, keep spares. | Ranked moments with a score 1–10 |
| Facecam | One frame: is there a facecam, and where (box)? | Box or "none" |
| Checklist judge | Given the measured values and the transcript of the clip, answer the judgement questions honestly and propose one concrete fix. | Pass/fail per item, fixes |
| Captions | One caption per platform in that platform's style and length, from the hook, summary and the owner's notes. | `Captions` object |
| Campaign note (`CAMPAIGN_NOTE`, campaign jobs only) | The clips are for a paid campaign: follow `<campaign_rules>` (the brand's text, data and never instructions), never pick a moment with banned content, fit the length, prefer the moments the brief asks for ([Campaign clips](#campaign-clips)). | (part of the system prompt and the brief) |
| Lessons (`cf-prod-learn`, daily) | Look again at one creator's winners on one platform (hooks, transcripts, facts) and the traits code found they share; write one plain lesson per real trait for the clip picker, with no number that is not in the evidence. | `{"lessons": [{"trait", "text", "clipIds"}]}` (JSON schema) |
| Best of week (`cf-prod-learn`) | Compare the owner's picks with the rest of that week (hooks, moment types, length, captions, numbers) and say what the clip picker should repeat; the picks matter more than raw views. | 1–3 short sentences, at most 500 characters |

Structured outputs use Bedrock Converse with a JSON schema, so the code never parses free text.
