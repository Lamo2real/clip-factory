import { getPrefs } from "./prefs.ts";
import { SoundEngine } from "./sound.ts";

/** The app's one sound engine, following the Sound setting. */
export const sounds = new SoundEngine(() => getPrefs().soundEnabled);
