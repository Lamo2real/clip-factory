/** Joins class names, leaving out the empty ones (Stories' own: nothing of Clip Factory's is imported here). */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}
