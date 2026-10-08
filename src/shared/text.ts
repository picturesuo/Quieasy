import type { QuestionKind } from './types';

/** Normalizes text for comparisons: Unicode-compatible, case-folded, single-spaced. */
export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Collapses whitespace for display while keeping line breaks between blocks. */
export function tidyText(text: string): string {
  return text
    .replace(/[ \t\f\v ]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/** 64-bit FNV-1a, returned as 16 hex characters. Synchronous so content scripts can key lookups. */
export function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * The cache key for a question. Choice order is ignored so a shuffled copy of the
 * same question reuses the cached answer, which is stored by choice text.
 */
export function questionKey(kind: QuestionKind, stem: string, choices: string[]): string {
  const sortedChoices = choices.map(normalizeText).sort();
  return `q${fnv1a64(JSON.stringify([kind, normalizeText(stem), sortedChoices]))}`;
}

export function choiceLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
