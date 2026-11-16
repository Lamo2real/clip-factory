import "@fontsource-variable/inter/index.css";
import "@fontsource/tinos/400.css";
import "@fontsource/tinos/400-italic.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/glass.css";
import "./styles/components.css";
import "./styles/layout.css";
import "./styles/screens.css";
import "./styles/system.css";
import "./styles/settings.css";
import "./styles/performance.css";
import "./styles/setup.css";
import "./styles/help.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { installClickSounds } from "./lib/sound.ts";
import { sounds } from "./lib/sounds.ts";
import { initPwa } from "./lib/pwa.ts";
import { startUpdateChecks } from "./lib/update.ts";

// Refraction inside backdrop-filter only works in Chromium; elsewhere the glass falls back to blur and saturation.
const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands;
if (brands?.some((b) => b.brand === "Chromium")) document.documentElement.classList.add("refract");

installClickSounds(sounds);
initPwa();
startUpdateChecks();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
