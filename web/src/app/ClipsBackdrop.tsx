import { Backdrop } from "../components/Backdrop.tsx";
import { useAppOnScreen } from "./shell.ts";

/**
 * Clip Factory's own backdrop (components/Backdrop.tsx: its living colours, its picture, its own colours, its Frosted
 * frost), shown by the shell only while Clip Factory is on screen. While Clips Funded is, the backdrop is kept, the
 * same element, but not drawn and with its drift waiting (`away`), so nothing of Clip Factory's lies under Clips
 * Funded's own stage and neither app touches the other's page (request 2: "The only shared element should be the
 * application shell"). Back on screen it is drawn as Clip Factory's Look says now, before the first frame, its colours
 * where the owner left them (a new element would start its drift over). While Clips Funded is switched off it is always
 * drawn, in its old place, exactly as before.
 */
export function ClipsBackdrop() {
  return useAppOnScreen() === "clips" ? <Backdrop /> : <Backdrop away />;
}
