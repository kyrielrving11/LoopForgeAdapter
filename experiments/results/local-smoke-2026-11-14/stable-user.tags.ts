export function normalizeTag(input: string): string { return input.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " "); }
export function uniqueTags(inputs: readonly string[]): string[] { return [...new Set(inputs.map(normalizeTag).filter(Boolean))]; }
export function countTags(inputs: readonly string[]): Record<string, number> { const counts: Record<string, number> = Object.create(null); for (const input of inputs) { const tag = normalizeTag(input); if (tag) counts[tag] = (counts[tag] ?? 0) + 1; } return counts; }
