// Mac fetches it (docs/CONTRACTS.md §35.5): while a YouTube job waits for the owner's Mac, the job page says so in
// plain words. Two minutes in, with no Mac on it, it also says where to go ("Open Clip Factory on your Mac to
// continue."), the same words as the notification. In the desktop app itself the app is already open, so the hint
// never shows there. No live region of its own: the live line (§31) already announces the step.
import type { Job } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { canMacFetch, macWaitWords } from "../../lib/macFetch.ts";

export function MacWait({ job, here = canMacFetch() }: { job: Job; here?: boolean }) {
  const words = macWaitWords(job, here);
  if (!words) return null;
  const hint = words.hint && job.macFetch?.nudgedAt ? words.hint : undefined;
  return (
    <div className="callout callout--info mac-wait" data-help="mac-wait">
      <Icon name="monitor" />
      <div className="mac-wait__words">
        <p className="mac-wait__title">{words.title}</p>
        {hint ? <p className="mac-wait__hint">{hint}</p> : null}
      </div>
    </div>
  );
}
