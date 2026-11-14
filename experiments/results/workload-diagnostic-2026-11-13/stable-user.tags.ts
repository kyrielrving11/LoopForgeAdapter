/**
 * Normalize a tag: NFC Unicode normalization, trim, locale-independent
 * lowercasing, and collapse of internal whitespace runs to one ASCII space.
 * Empty or whitespace-only input yields an empty string.
 */
export function normalizeTag(input: string): string {
  const normalized = input.normalize('NFC').trim().toLowerCase();
  if (normalized === '') {
    return '';
  }
  return normalized.replace(/\s+/g, ' ');
}

/**
 * Normalize each input tag, drop empty results, and count occurrences.
 * Returns a null-prototype dictionary so arbitrary tag names such as
 * "__proto__" or "constructor" are stored as ordinary keys. The input
 * array is never mutated.
 */
export function countTags(inputs: readonly string[]): Record<string, number> {
  const counts = Object.create(null) as Record<string, number>;
  for (const input of inputs) {
    const tag = normalizeTag(input);
    if (tag === '') {
      continue;
    }
    counts[tag] = (counts[tag] ?? 0) + 1;
  }
  return counts;
}

/**
 * Normalize each tag, drop empty results, and remove duplicates while
 * preserving the order in which each tag first appeared. The input array
 * is never mutated.
 */
export function uniqueTags(inputs: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const input of inputs) {
    const tag = normalizeTag(input);
    if (tag === '' || seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    result.push(tag);
  }
  return result;
}
