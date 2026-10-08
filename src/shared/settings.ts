/**
 * chrome.storage.local keys. Local storage is restricted to extension pages and the service worker.
 * The AI settings live under AI_SETTINGS_KEY (see providers.ts).
 */
export const LOCAL_KEYS = {
  customSites: 'customSites',
} as const;

/** chrome.storage.session keys. Session storage is cleared when the browser restarts. */
export const SESSION_KEYS = {
  state: 'state',
  answerPrefix: 'a:',
  framePrefix: 'f:',
  lookupPrefix: 'l:',
} as const;

export function answerStorageKey(questionKey: string): string {
  return `${SESSION_KEYS.answerPrefix}${questionKey}`;
}

export function frameStorageKey(tabId: number, frameId: number): string {
  return `${SESSION_KEYS.framePrefix}${tabId}:${frameId}`;
}

/** The question keys one tab has looked up since Quieasy was last turned on. */
export function lookupStorageKey(tabId: number): string {
  return `${SESSION_KEYS.lookupPrefix}${tabId}`;
}

/**
 * Size limits applied to a question before its key is computed. The content script and the
 * service worker both cut to these, so both arrive at the same key for the same question.
 */
export const MAX_STEM_CHARS = 4000;
export const MAX_CHOICE_CHARS = 1000;
export const MAX_CHOICES = 26;

/**
 * New lookups one tab may start each time Quieasy is turned on. Every lookup is billed to the
 * user's key, and a page that keeps rewriting its questions would otherwise start them forever.
 */
export const MAX_LOOKUPS_PER_TAB = 200;

/** Maximum simultaneous AI requests. */
export const MAX_CONCURRENT_REQUESTS = 4;

/** Maximum web searches the model may run per question. */
export const MAX_SEARCHES_PER_QUESTION = 3;
