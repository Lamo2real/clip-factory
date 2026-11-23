// The phone tab bar's round active highlight. Two ways to use it: put <PhoneTabHighlight /> inside the active tab
// (it sits behind the icon), or give the bar's sliding <Glide> the same class (className="… st-tab-orb") so the
// round highlight slides between tabs. The bar itself is .st-glass.st-glass--bar.
import { cx } from "./cx.ts";

export const TAB_ORB = "st-tab-orb";

export function PhoneTabHighlight({ className }: { className?: string }) {
  return <span className={cx(TAB_ORB, className)} aria-hidden="true" />;
}
