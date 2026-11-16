// Types for scripts/help-corpus.mjs (used by test/helpCorpus.test.ts).
export declare const METRICS: string[];
export declare const STOPWORDS: string[];
export declare const SYNONYMS: Record<string, string>;
export declare const SENSITIVE: RegExp;
export declare function routesTable(routes: { name: string; path: string }[]): string;
export declare function buildCorpus(): Promise<{
  corpus: unknown;
  routes: { name: string; path: string }[];
  problems: string[];
  text: string;
}>;
