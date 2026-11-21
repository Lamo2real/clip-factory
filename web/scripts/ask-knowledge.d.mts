// Types for the parts of ask-knowledge.mjs the tests import (the script itself is plain JavaScript run by Node).
export interface SetupStepRow {
  id: string;
  /** The number the guide shows (Content Rewards: within each part, §38.17). */
  n: number;
  part: string;
  partTitle: string;
  title: string;
  say: string[];
  ifYouSee?: { see: string; do: string }[];
  open?: { label: string; url: string };
  checkedOn: string;
  auto?: string;
}
export declare function setupSteps(): Promise<{ steps: Record<string, SetupStepRow[]>; names: Record<string, string> }>;
export declare function redact(text: string): string;
export declare function setupLink(url: string): string;
