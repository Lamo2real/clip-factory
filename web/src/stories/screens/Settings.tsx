// Lamo Stories › Settings (docs/CONTRACTS.md §45.29, §45.16.7): Lamo Stories' own setup, apart from Clip Factory's
// (which stays in Clip Factory's Settings, unchanged). One page per section, `/stories/settings/{section}`: AI (models,
// effort, each agent and task, Check models, usage and cost, prices, providers and keys), Agents, Skills, Memory,
// Video and Storage and production; Social accounts is the Connections page. The sections live in
// web/src/stories/settings/ (builder F2).
import "../styles/settings.css";
import { useLayoutEffect, useRef, useState } from "react";
import { Glide } from "../../components/Glide.tsx";
import { A } from "../../components/ui.tsx";
import { storiesHref, type SettingsSection } from "../routes.ts";
import { AgentsSection } from "../settings/AgentsSection.tsx";
import { AiSection } from "../settings/AiSection.tsx";
import { LookSection } from "../settings/LookSection.tsx";
import { SectionBarSlot, SettingsPageProvider, SIcon, type SettingsPageName, type SIconName } from "../settings/bits.tsx";
import { MemorySection } from "../settings/MemorySection.tsx";
import { SkillsSection } from "../settings/SkillsSection.tsx";
import { StorageSection } from "../settings/StorageSection.tsx";
import { VideoSection } from "../settings/VideoSection.tsx";
import { StIcon, useOnboarding } from "../ui.tsx";
import type { StoriesScreenProps } from "./types.ts";

/** The sections in the order the bar shows them; Social accounts opens the Connections page. */
export const SECTIONS: { section: SettingsSection | "social"; label: string; icon: SIconName; lede: string }[] = [
  { section: "ai", label: "AI", icon: "chip", lede: "Which AI models think for Lamo Stories, and how hard." },
  { section: "agents", label: "Agents", icon: "people", lede: "Lamo Stories' five helpers: what each one does, and with which model and skills." },
  { section: "skills", label: "Skills", icon: "book", lede: "Know-how the agents read before they work. Clip Factory's skills are separate." },
  { section: "memory", label: "Memory", icon: "note", lede: "What Lamo Stories remembers about you and your videos." },
  { section: "social", label: "Social accounts", icon: "plug", lede: "" },
  { section: "video", label: "Video", icon: "film", lede: "How videos are made: the makers, size, length and quality." },
  { section: "storage", label: "Storage", icon: "box", lede: "Space used, the files made, and how videos are put together." },
];

/** How sentences name each section's page ("… in Settings › Video"), so one shown on that page skips the trip (§45.36 E17). */
const PAGE_NAME: Record<SettingsSection, SettingsPageName> = { ai: "AI", agents: "Agents", skills: "Skills", memory: "Memory", video: "Video", storage: "Storage" };

function hrefOf(section: SettingsSection | "social"): string {
  return section === "social" ? storiesHref({ name: "connections", platform: null, result: null, ws: null }) : storiesHref({ name: "settings", section });
}

/** The first-time setup, always one tap away (§45.36 E15): with what is still left when steps were skipped. */
function SetupAgain({ ws }: { ws: string }) {
  const { data } = useOnboarding(ws);
  const left = data ? data.steps.filter((s) => s.state !== "done" && s.step !== "done").length : 0;
  return (
    <p className="st-stg-head__setup">
      {/* The shared glass pill (.st-pill), on the hero like the section pills under it. */}
      <A href="/stories/setup" className="st-pill st-stg-head__setup-go">
        <StIcon name="rocket" size={18} />
        Open setup again
      </A>
      {left ? <span className="st-stg-head__setup-left">{left === 1 ? "1 step left" : `${left} steps left`}</span> : null}
    </p>
  );
}

export function SettingsScreen({ ws, page }: StoriesScreenProps) {
  const section: SettingsSection = page.name === "settings" ? page.section : "ai";
  const here = SECTIONS.find((s) => s.section === section)!;
  // The section's bar (its note and the Saved mark) is drawn inside the section head's plate, so the words above the
  // first card are one plate, not two of different widths.
  const [barSlot, setBarSlot] = useState<HTMLDivElement | null>(null);
  // On a phone the section pills are one row that scrolls sideways: the chosen one is always in view.
  const tabs = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    const row = tabs.current;
    const cell = row?.querySelector<HTMLElement>(".st-stg-tab.is-on")?.parentElement;
    if (!row || !cell || row.scrollWidth <= row.clientWidth) return;
    const left = cell.offsetLeft;
    if (left >= row.scrollLeft && left + cell.offsetWidth <= row.scrollLeft + row.clientWidth) return;
    row.scrollLeft = Math.max(0, left - (row.clientWidth - cell.offsetWidth) / 2);
  }, [section]);
  return (
    <section className="st-page st-stg">
      {/* The one hero surface of the page: the page head and the section pills on it (glass pills, the chosen one cream). */}
      <div className="st-stg-top st-glass st-glass--hero st-lens">
        <header className="st-stg-head">
          <h1 className="st-stg-head__title st-display">Settings</h1>
          <p className="st-stg-head__lede">Lamo Stories' own settings. Nothing here changes Clip Factory.</p>
          <SetupAgain ws={ws} />
        </header>
        <nav className="st-stg-nav" aria-label="Settings sections">
          <ul className="st-stg-tabs" ref={tabs}>
            <Glide active=".st-stg-tab.is-on" className="st-stg-glide" as="li" />
            {SECTIONS.map((s) => {
              const on = s.section === section;
              return (
                <li key={s.section} className="st-stg-tabs__cell">
                  <A href={hrefOf(s.section)} className={`st-pill st-stg-tab${on ? " is-on" : ""}${s.section === "social" ? " st-stg-tab--out" : ""}`} aria-current={on ? "page" : undefined}>
                    <SIcon name={s.icon} size={20} />
                    <span>{s.label}</span>
                  </A>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
      <div className="st-stg-section">
        {/* Words loose on the page sit on a plate: nothing over Ember, a glass plate in Picture and See-through. */}
        <div className="st-stg-section__head st-plate">
          <h2 className="st-stg-section__title st-display">{section === "storage" ? "Storage and production" : here.label}</h2>
          <p className="st-stg-section__lede">{here.lede}</p>
          <div className="st-stg-section__bar" ref={setBarSlot} />
        </div>
        <SectionBarSlot value={barSlot}>
          <SettingsPageProvider value={PAGE_NAME[section]}>
            {section === "ai" ? <AiSection key={ws} ws={ws} /> : null}
            {section === "agents" ? <AgentsSection key={ws} ws={ws} /> : null}
            {section === "skills" ? <SkillsSection key={ws} ws={ws} /> : null}
            {section === "memory" ? <MemorySection key={ws} ws={ws} /> : null}
            {section === "video" ? <VideoSection key={ws} ws={ws} /> : null}
            {section === "storage" ? <StorageSection key={ws} ws={ws} /> : null}
            {/* Look (the glass contract): what is behind the glass, this device's own like Sounds and motion. */}
            {section === "storage" ? <LookSection /> : null}
          </SettingsPageProvider>
        </SectionBarSlot>
      </div>
    </section>
  );
}
