import { LOCAL_KEYS } from '../shared/settings';

/** Content script registration for the sites the user allowed in settings. */
export const CUSTOM_SITES_SCRIPT_ID = 'quieasy-sites';

/** Turns "canvas.school.edu" or a pasted URL into a host name, or null when invalid. */
export function parseSiteHost(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  let host: string;
  try {
    host = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return null;
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  return host;
}

export function sitePattern(host: string): string {
  return `https://${host}/*`;
}

export async function storedSites(): Promise<string[]> {
  const stored = await chrome.storage.local.get(LOCAL_KEYS.customSites);
  const sites = stored[LOCAL_KEYS.customSites];
  return Array.isArray(sites) ? sites.filter((site): site is string => typeof site === 'string') : [];
}

/** Registers the content script for every saved site the user has granted access to. */
export async function syncCustomSites(): Promise<string[]> {
  const sites = await storedSites();
  const granted = new Set((await chrome.permissions.getAll()).origins ?? []);
  const matches = sites.map(sitePattern).filter((pattern) => granted.has(pattern));
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CUSTOM_SITES_SCRIPT_ID] });
  if (existing.length > 0) await chrome.scripting.unregisterContentScripts({ ids: existing.map((script) => script.id) });
  if (matches.length > 0) {
    await chrome.scripting.registerContentScripts([
      {
        id: CUSTOM_SITES_SCRIPT_ID,
        matches,
        js: ['content.js'],
        css: ['content.css'],
        allFrames: true,
        runAt: 'document_idle',
        persistAcrossSessions: true,
      },
    ]);
  }
  return matches;
}
