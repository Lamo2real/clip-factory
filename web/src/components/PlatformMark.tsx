// Simplified, single-colour platform marks so they sit in the palette instead of fighting it.
import type { ReactNode } from "react";
import type { Platform, SourcePlatform } from "../api/types.ts";
import { PLATFORM_LABEL } from "../lib/format.ts";
import { Icon } from "./Icon.tsx";

type Mark = Platform | SourcePlatform;

const SHAPES: Record<Exclude<Mark, "upload">, ReactNode> = {
  youtube: (
    <>
      <rect x="2.5" y="5.5" width="19" height="13" rx="4" fill="currentColor" />
      <path d="M10 9.2v5.6l4.8-2.8L10 9.2Z" fill="var(--mark-cut, #0F372B)" />
    </>
  ),
  twitch: (
    <>
      <path d="M5 3.5 3.5 7v12.5h4.2v2.2h2.4l2.2-2.2h3.4l4.8-4.8V3.5H5Z" fill="currentColor" />
      <path d="M11 8v4.5M15.5 8v4.5" stroke="var(--mark-cut, #0F372B)" strokeWidth="1.8" strokeLinecap="round" />
    </>
  ),
  kick: (
    <path
      d="M4 3.5h5.2v4.2h1.8V5.6h2V3.5H20v6.2h-2.2v2.1h-2v.4h2v2.1H20v6.2h-7v-2.1h-2v-2.1H9.2v4.2H4V3.5Z"
      fill="currentColor"
    />
  ),
  instagram: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="5" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="3.8" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="17" cy="7" r="1.2" fill="currentColor" />
    </>
  ),
  facebook: (
    <>
      <circle cx="12" cy="12" r="9" fill="currentColor" />
      <path
        d="M13.2 21v-6.6h2.2l.4-2.6h-2.6v-1.6c0-.8.3-1.3 1.4-1.3h1.3V6.6a17 17 0 0 0-2-.1c-2 0-3.3 1.2-3.3 3.4v1.9H8.4v2.6h2.2V21"
        fill="var(--mark-cut, #0F372B)"
      />
    </>
  ),
  tiktok: (
    <path
      d="M14.2 3.5h3c.2 1.9 1.4 3.2 3.3 3.4v3a6.6 6.6 0 0 1-3.3-1v6.3a5.6 5.6 0 1 1-5.6-5.6h.5v3.1a2.6 2.6 0 1 0 2.1 2.5V3.5Z"
      fill="currentColor"
    />
  ),
  x: <path d="M4 4h4.6l3.9 5.4L17.2 4h2.3l-6 7 6.5 9h-4.6l-4.2-5.8L6.1 20H3.8l6.4-7.3L4 4Z" fill="currentColor" />,
};

export function PlatformMark({ platform, size = 22, title }: { platform: Mark; size?: number; title?: string }) {
  if (platform === "upload") return <Icon name="upload" size={size} />;
  return (
    <svg
      className="mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      {SHAPES[platform]}
    </svg>
  );
}

export function platformName(p: Mark): string {
  return PLATFORM_LABEL[p];
}
