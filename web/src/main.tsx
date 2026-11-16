import "@fontsource-variable/inter/index.css";
import "@fontsource/tinos/400.css";
import "@fontsource/tinos/400-italic.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/glass.css";
import "./styles/components.css";
import "./styles/fly.css";
import "./styles/motion.css";
import "./styles/layout.css";
import "./styles/screens.css";
import "./styles/system.css";
import "./styles/settings.css";
import "./styles/performance.css";
import "./styles/setup.css";
import "./styles/help.css";
import "./styles/setup-todo.css";
import "./styles/glide.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { ErrorBoundary } from "./app/ErrorBoundary.tsx";
import { installClickSounds } from "./lib/sound.ts";
import { sounds } from "./lib/sounds.ts";
import { initPwa } from "./lib/pwa.ts";
import { startUpdateChecks } from "./lib/update.ts";
import { applyLookNow } from "./lib/look.ts";

// Refraction inside backdrop-filter only works in Chromium; elsewhere the glass falls back to blur and saturation.
const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands;
if (brands?.some((b) => b.brand === "Chromium")) document.documentElement.classList.add("refract");

// See-through in the desktop app: the page goes transparent before anything is drawn (§22.3).
applyLookNow();

installClickSounds(sounds);
initPwa();
startUpdateChecks();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary scope="app">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
