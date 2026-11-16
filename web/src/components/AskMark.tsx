/**
 * The Ask Clip Factory mark: a chat bubble with a clip's play button inside and the brand's tomato dot
 * on its corner (the same dot as the "C" in the logo). The dot breathes slowly to say "it thinks".
 * Line weight and size match <Icon>, so it drops in where an icon goes.
 */
export function AskMark({ size = 22 }: { size?: number }) {
  return (
    <svg
      className="icon ask-mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 17.6H6.2a2.6 2.6 0 0 1-2.6-2.6V7.4a2.6 2.6 0 0 1 2.6-2.6h8.3M20.4 10.6V15a2.6 2.6 0 0 1-2.6 2.6h-5.6L8 20.9v-3.3" />
      <path d="M10 8.6v5.2l4.3-2.6L10 8.6Z" fill="currentColor" strokeWidth={1.4} />
      <circle className="ask-mark__dot" cx="19" cy="5.2" r="2.6" fill="var(--tomato)" stroke="none" />
    </svg>
  );
}
