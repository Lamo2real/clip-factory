// The ways out of a failure whose sentence names a Lamo Stories setting (docs/CONTRACTS.md §45.25, §45.26): a model
// that is refused stops with "… Pick another model in Lamo Stories › Settings › AI, or try again." and a switched-off
// agent with "… Switch it on in Lamo Stories › Settings › Agents.", each with the button that does it. Used by the
// chat's failed answers and the reference page's failed analyses, so both say it the same way.
import { A } from "../../components/ui.tsx";
import { storiesHref } from "../routes.ts";
import { Btn } from "./kit.tsx";

/** Which settings a failure's sentence sends the owner to. */
export function settingsNamed(text: string | null | undefined): { ai: boolean; agents: boolean } {
  const t = text ?? "";
  return { ai: /Settings › AI\b/.test(t), agents: /Settings › Agents\b/.test(t) };
}

/**
 * "Pick another model" (opens the model sheet) and the links to the setting the sentence names. `pick` also offers
 * the model sheet when the sentence names no setting (a failure whose reason is not known).
 */
export function FixIt({ text, onPickModel, pick = false }: { text: string | null | undefined; onPickModel?: () => void; pick?: boolean }) {
  const named = settingsNamed(text);
  return (
    <>
      {onPickModel && (named.ai || pick) && !named.agents ? (
        <Btn quiet icon="tune" onClick={onPickModel}>
          Pick another model
        </Btn>
      ) : null}
      {named.ai ? (
        <A href={storiesHref({ name: "settings", section: "ai" })} className="st-chat-link">
          Open Settings › AI
        </A>
      ) : null}
      {named.agents ? (
        <A href={storiesHref({ name: "settings", section: "agents" })} className="st-chat-link">
          Open Settings › Agents
        </A>
      ) : null}
    </>
  );
}
