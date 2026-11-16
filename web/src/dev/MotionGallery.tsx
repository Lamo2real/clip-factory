// Mock (e2e) mode only, at /__motion: one Button per action motion kind, so motion.spec.ts can tap each one and
// check the order (the handler fires before the motion ends), the reduced fade, the failure and the overflow rules
// (docs/CONTRACTS.md §20.10). The router only answers this address when the mock build is running.
import { useState, type MouseEvent } from "react";
import { PageHeader, Segmented, Stepper, Toggle, Button } from "../components/ui.tsx";
import { ACT_KINDS } from "../lib/motion.ts";

export function MotionGallery() {
  const [failing, setFailing] = useState(false);
  const [count, setCount] = useState(3);
  const [pick, setPick] = useState<"a" | "b">("a");
  const [starred, setStarred] = useState(false);
  const fire = (e: MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.dataset.fired = String(performance.now());
    return failing ? Promise.reject(new Error("pretend failure")) : undefined;
  };
  return (
    <div className="page motion-gallery">
      <PageHeader title="Motion gallery" lede="Every action motion, one button each. Test page: mock mode only." />
      <section className="panel glass motion-gallery__panel">
        <Toggle checked={failing} onChange={setFailing} label="Make them fail" description="Each button's action fails, so it shakes instead." />
        <div className="motion-gallery__grid">
          {ACT_KINDS.map((kind) =>
            kind === "star" ? (
              <Button
                key={kind}
                act={kind}
                data-kind={kind}
                aria-pressed={starred}
                onClick={(e) => {
                  setStarred((s) => !s);
                  return fire(e);
                }}
              >
                {kind}
              </Button>
            ) : (
              <Button key={kind} act={kind} data-kind={kind} variant={kind === "send" ? "primary" : "glass"} onClick={fire}>
                {kind}
              </Button>
            ),
          )}
        </div>
        <Stepper value={count} min={1} max={9} onChange={setCount} label="Things" />
        <Segmented
          value={pick}
          onChange={setPick}
          label="Pick one"
          options={[
            { value: "a", label: "First" },
            { value: "b", label: "Second" },
          ]}
        />
      </section>
    </div>
  );
}
