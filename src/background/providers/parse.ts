import type { Source } from '../../shared/types';

/** Replies are untrusted JSON; these read them without assuming any shape. */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Adds an http(s) page once per URL, keeping the first real title seen for it. */
export function addSource(sources: Map<string, Source>, url: unknown, title: unknown): void {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
  const key = urlKey(url);
  const named = typeof title === 'string' ? title.trim() : '';
  const existing = sources.get(key);
  if (!existing) sources.set(key, { url, title: named || url });
  else if (named && existing.title === existing.url) existing.title = named;
}

/** Compares URLs ignoring fragments and trailing slashes. */
export function urlKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}
