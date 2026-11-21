// Ask Clip Factory's memory (docs/CONTRACTS.md §45.16.1, §19.8): the open conversation and whether the panel is
// open, kept by one provider mounted above the Clip Factory / Lamo Stories branch. Switching to Lamo Stories and
// back then finds Ask as it was: the conversation, an answer still streaming in (its stream keeps writing here while
// Ask is off screen), and the panel open or closed. Ask's look and behaviour do not change: the launcher only reads
// its state from here instead of holding it itself. Memory only, never stored; sign-out unmounts the provider, which
// lets go of every picture's object URL (useRevokeDropped), as Ask unmounting did before.
import { createContext, useContext, useMemo, useReducer, useRef, useState, type Dispatch, type MutableRefObject, type ReactNode, type SetStateAction } from "react";
import { chatReducer, initialChat, useRevokeDropped, type ChatEvent, type ChatState } from "./chatState.ts";

export interface AskMemory {
  chat: ChatState;
  dispatch: Dispatch<ChatEvent>;
  /** Bumped by Start over, so answers still on their way are dropped. */
  generation: MutableRefObject<number>;
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
}

const AskMemoryContext = createContext<AskMemory | null>(null);

function useAskState(): AskMemory {
  const [chat, dispatch] = useReducer(chatReducer, initialChat);
  const generation = useRef(0);
  const [open, setOpen] = useState(false);
  // Pictures are object URLs: each is let go when it leaves the chat, and all of them when this unmounts.
  useRevokeDropped(chat);
  return useMemo(() => ({ chat, dispatch, generation, open, setOpen }), [chat, open]);
}

/** Mounted once in the signed-in app, above the Clip Factory / Lamo Stories branch (App.tsx). */
export function AskMemoryProvider({ children }: { children: ReactNode }) {
  const memory = useAskState();
  return <AskMemoryContext.Provider value={memory}>{children}</AskMemoryContext.Provider>;
}

/**
 * Ask's conversation and open state: the provider's, or, with no provider above (Ask rendered on its own, as in its
 * tests), one of its own that lives as long as the launcher, exactly as before.
 */
export function useAskMemory(): AskMemory {
  const kept = useContext(AskMemoryContext);
  const own = useAskState();
  return kept ?? own;
}
