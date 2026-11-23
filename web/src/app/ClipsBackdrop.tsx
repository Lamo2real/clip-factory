import { Backdrop } from "../components/Backdrop.tsx";
import { useAppOnScreen } from "./shell.ts";

/**
 * Clip Factory's own backdrop (components/Backdrop.tsx: its living colours, its picture, its own colours, its Frosted
 * frost), drawn by the shell only while Clip Factory is on screen. While Lamo Stories is, Lamo Stories draws its own
 * stage and nothing of Clip Factory's lies under it, so neither app touches the other's page (request 2: "The only
 * shared element should be the application shell"). Back on screen, Clip Factory's backdrop is drawn as its Look says
 * now, before the first frame. While Lamo Stories is switched off it is always drawn, in its old place, exactly as
 * before.
 */
export function ClipsBackdrop() {
  return useAppOnScreen() === "clips" ? <Backdrop /> : null;
}
