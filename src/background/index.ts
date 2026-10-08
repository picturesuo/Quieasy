import {
  AI_SETTINGS_KEY,
  endpointPermission,
  LEGACY_KEYS,
  PROVIDERS,
  providerConfig,
  readAiSettings,
  type AiSettings,
  type ProviderConfig,
} from '../shared/providers';
import {
  answerStorageKey,
  frameStorageKey,
  lookupStorageKey,
  MAX_CHOICE_CHARS,
  MAX_CHOICES,
  MAX_CONCURRENT_REQUESTS,
  MAX_LOOKUPS_PER_TAB,
  MAX_STEM_CHARS,
  SESSION_KEYS,
} from '../shared/settings';
import { questionKey } from '../shared/text';
import type {
  AnswerKeyEntry,
  AnswerKeyResponse,
  AnswerRecord,
  ContentMessage,
  FrameReport,
  QuestionData,
  QuieasyState,
  UiMessage,
} from '../shared/types';
import { answerQuestion, errorRecord } from './answer';
import { AnswerScheduler } from './scheduler';
import { syncCustomSites } from './sites';

const KEEPALIVE_MS = 20_000;
const MAX_QUESTIONS_PER_FRAME = 200;

/** In-memory mirrors of chrome.storage.session, rebuilt whenever the service worker starts. */
const answers = new Map<string, AnswerRecord>();
const frames = new Map<string, FrameReport>();
/** Question keys each tab has asked to look up since Quieasy was last turned on. */
const lookupsByTab = new Map<number, Set<string>>();
let enabled = false;
let keepAlive: ReturnType<typeof setInterval> | null = null;

const scheduler = new AnswerScheduler({
  concurrency: MAX_CONCURRENT_REQUESTS,
  run: async (question, signal, queuedMs) => {
    const setup = await providerSetup();
    if ('missing' in setup) return errorRecord(question, setup.label, setup.missing, queuedMs, 0);
    return answerQuestion(question, setup.config, signal, queuedMs);
  },
  onResult: (record) => void storeAnswer(record),
  onFailure: (question, _error, queuedMs) => errorRecord(question, 'unknown', 'The AI request failed.', queuedMs, 0),
  onPending: (count) => (count > 0 ? startKeepAlive() : stopKeepAlive()),
});

const ready = initialize();

async function initialize(): Promise<void> {
  // Content scripts may read session state (on/off and cached answers) but never local
  // storage, which holds the API keys.
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await migrateLegacySettings();
  const stored = await chrome.storage.session.get(null);
  for (const [key, value] of Object.entries(stored)) {
    if (key === SESSION_KEYS.state) enabled = Boolean((value as QuieasyState).enabled);
    else if (key.startsWith(SESSION_KEYS.answerPrefix)) answers.set(key.slice(SESSION_KEYS.answerPrefix.length), value as AnswerRecord);
    else if (key.startsWith(SESSION_KEYS.framePrefix)) frames.set(key.slice(SESSION_KEYS.framePrefix.length), value as FrameReport);
    else if (key.startsWith(SESSION_KEYS.lookupPrefix)) lookupsByTab.set(Number(key.slice(SESSION_KEYS.lookupPrefix.length)), new Set(value as string[]));
  }
  await updateBadge();
}

async function loadAiSettings(): Promise<AiSettings> {
  return readAiSettings(await chrome.storage.local.get([AI_SETTINGS_KEY, LEGACY_KEYS.apiKey, LEGACY_KEYS.model]));
}

/** Moves an Anthropic key and model saved by a version before multi-service support to the new layout. */
async function migrateLegacySettings(): Promise<void> {
  const stored = await chrome.storage.local.get([AI_SETTINGS_KEY, LEGACY_KEYS.apiKey, LEGACY_KEYS.model]);
  if (stored[LEGACY_KEYS.apiKey] === undefined && stored[LEGACY_KEYS.model] === undefined) return;
  if (stored[AI_SETTINGS_KEY] === undefined) await chrome.storage.local.set({ [AI_SETTINGS_KEY]: readAiSettings(stored) });
  await chrome.storage.local.remove([LEGACY_KEYS.apiKey, LEGACY_KEYS.model]);
}

type ProviderSetup = { config: ProviderConfig } | { missing: string; label: string };

/** The selected service's request settings, or what the user still has to do in settings. */
async function providerSetup(): Promise<ProviderSetup> {
  const settings = await loadAiSettings();
  const { label } = PROVIDERS[settings.provider];
  const result = providerConfig(settings);
  if ('missing' in result) return { missing: result.missing, label };
  const origin = endpointPermission(settings);
  if (origin && !(await chrome.permissions.contains({ origins: [origin] }))) {
    const host = new URL(origin.replace(/\/\*$/, '')).host;
    return { missing: `Quieasy is not allowed to reach ${host}. Open Quieasy settings and click Save to allow it.`, label };
  }
  return result;
}

async function setEnabled(next: boolean): Promise<void> {
  await ready;
  enabled = next;
  const spent = [...lookupsByTab.keys()].map(lookupStorageKey);
  lookupsByTab.clear();
  if (spent.length > 0) await chrome.storage.session.remove(spent);
  if (!next) {
    // Abort in-flight requests; any response that still arrives is discarded by storeAnswer.
    scheduler.cancelAll();
  } else {
    await dropFailedAnswers();
  }
  const state: QuieasyState = { enabled: next, changedAt: Date.now() };
  await chrome.storage.session.set({ [SESSION_KEYS.state]: state });
  await updateBadge();
}

async function dropFailedAnswers(): Promise<void> {
  const failed = [...answers.values()].filter((answer) => answer.status === 'error').map((answer) => answer.key);
  failed.forEach((key) => answers.delete(key));
  if (failed.length > 0) await chrome.storage.session.remove(failed.map(answerStorageKey));
}

async function storeAnswer(record: AnswerRecord): Promise<void> {
  if (!enabled) return;
  answers.set(record.key, record);
  await chrome.storage.session.set({ [answerStorageKey(record.key)]: record });
}

async function updateBadge(): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
  await chrome.action.setBadgeText({ text: enabled ? 'ON' : '' });
  await chrome.action.setTitle({ title: enabled ? 'Quieasy is on' : 'Quieasy is off' });
}

function sanitizeQuestions(questions: unknown): QuestionData[] {
  if (!Array.isArray(questions)) return [];
  const clean: QuestionData[] = [];
  for (const raw of questions.slice(0, MAX_QUESTIONS_PER_FRAME)) {
    const value = raw as Partial<QuestionData>;
    if (value.kind !== 'single' && value.kind !== 'multiple') continue;
    if (typeof value.stem !== 'string' || !Array.isArray(value.choices)) continue;
    if (value.source !== 'canvas-classic' && value.source !== 'canvas-new-quizzes' && value.source !== 'generic') continue;
    const choices = value.choices.filter((choice): choice is string => typeof choice === 'string').slice(0, MAX_CHOICES);
    if (choices.length < 2) continue;
    const stem = value.stem.slice(0, MAX_STEM_CHARS);
    const trimmedChoices = choices.map((choice) => choice.slice(0, MAX_CHOICE_CHARS));
    clean.push({
      key: questionKey(value.kind, stem, trimmedChoices),
      kind: value.kind,
      stem,
      choices: trimmedChoices,
      hasImages: Boolean(value.hasImages),
      label: typeof value.label === 'string' ? value.label.slice(0, 80) : '',
      source: value.source,
    });
  }
  return clean;
}

async function handleQuestions(tabId: number, frameId: number, message: Extract<ContentMessage, { type: 'questions' }>): Promise<void> {
  const frameKey = `${tabId}:${frameId}`;
  const questions = sanitizeQuestions(message.questions);
  if (questions.length === 0) {
    frames.delete(frameKey);
    scheduler.releaseWhere((subscriber) => subscriber === frameKey);
    await chrome.storage.session.remove(frameStorageKey(tabId, frameId));
    return;
  }
  const previous = frames.get(frameKey);
  const keys = new Set(questions.map((question) => question.key));
  const displayMs = Object.fromEntries(Object.entries(previous?.displayMs ?? {}).filter(([key]) => keys.has(key)));
  const report: FrameReport = {
    questions,
    extractMs: message.extractMs > 0 ? message.extractMs : (previous?.extractMs ?? 0),
    displayMs,
    updatedAt: Date.now(),
  };
  frames.set(frameKey, report);
  await chrome.storage.session.set({ [frameStorageKey(tabId, frameId)]: report });
  if (!enabled) return;
  await schedule(frameKey, questions);
}

async function schedule(frameKey: string, questions: QuestionData[]): Promise<void> {
  const setup = await providerSetup();
  // The frame may have been removed (tab closed, empty pagehide report) during the await above;
  // starting lookups for it would bill requests nobody displays and leave an orphaned lookup key.
  if (!enabled || !frames.has(frameKey)) return;
  if ('missing' in setup) {
    scheduler.want(frameKey, []);
    return;
  }
  const tabId = Number(frameKey.split(':')[0]);
  const used = lookupsByTab.get(tabId) ?? new Set<string>();
  lookupsByTab.set(tabId, used);
  const before = used.size;
  scheduler.want(frameKey, withinBudget(used, questions.filter((question) => !answers.has(question.key))));
  if (used.size > before) await chrome.storage.session.set({ [lookupStorageKey(tabId)]: [...used] });
}

/** The questions a tab may still look up: those it already asked about, then new ones up to its budget. */
function withinBudget(used: Set<string>, questions: QuestionData[]): QuestionData[] {
  return questions.filter((question) => {
    if (used.has(question.key)) return true;
    if (used.size >= MAX_LOOKUPS_PER_TAB) return false;
    used.add(question.key);
    return true;
  });
}

async function rescheduleAll(): Promise<void> {
  if (!enabled) return;
  for (const [frameKey, report] of frames) await schedule(frameKey, report.questions);
}

function tabEntries(tabId: number): AnswerKeyEntry[] {
  const entries: AnswerKeyEntry[] = [];
  const seen = new Set<string>();
  const tabFrames = [...frames.entries()]
    .filter(([frameKey]) => frameKey.startsWith(`${tabId}:`))
    .sort(([a], [b]) => Number(a.split(':')[1]) - Number(b.split(':')[1]));
  for (const [, report] of tabFrames) {
    for (const question of report.questions) {
      if (seen.has(question.key)) continue;
      seen.add(question.key);
      entries.push({
        question,
        answer: answers.get(question.key) ?? null,
        pending: scheduler.isPending(question.key),
        extractMs: report.extractMs,
        displayMs: report.displayMs[question.key] ?? null,
      });
    }
  }
  return entries;
}

function startKeepAlive(): void {
  // Long AI requests must not be cut off by the service worker's idle timeout.
  keepAlive ??= setInterval(() => void chrome.runtime.getPlatformInfo(), KEEPALIVE_MS);
}

function stopKeepAlive(): void {
  if (keepAlive) clearInterval(keepAlive);
  keepAlive = null;
}

/**
 * Runs Quieasy in a tab the user just invoked it on (shortcut or toolbar popup). Chrome grants
 * temporary access to that tab (activeTab) at that moment, so Quieasy works on any site without
 * permanent access to it. Frames from other sites stay out of reach unless the user allowed them.
 */
async function injectTab(tabId: number): Promise<boolean> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url || !/^https?:\/\//.test(tab.url)) return false;
  try {
    await chrome.scripting.insertCSS({ target: { tabId, allFrames: true }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
  } catch {
    // Some frame refused (for example a cross-site frame); fall back to the page itself.
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    } catch {
      return false;
    }
  }
  return true;
}

async function turnOnInTab(tabId: number | undefined): Promise<void> {
  await setEnabled(true);
  if (tabId !== undefined) await injectTab(tabId);
}

async function handleUiMessage(message: UiMessage): Promise<unknown> {
  switch (message.type) {
    case 'setEnabled':
      if (message.enabled && typeof message.tabId === 'number') await turnOnInTab(message.tabId);
      else await setEnabled(Boolean(message.enabled));
      return { enabled };
    case 'answerKey': {
      const setup = await providerSetup();
      const entries = tabEntries(message.tabId);
      const response: AnswerKeyResponse = {
        enabled,
        setupNeeded: 'missing' in setup ? setup.missing : null,
        lookupLimitReached:
          (lookupsByTab.get(message.tabId)?.size ?? 0) >= MAX_LOOKUPS_PER_TAB &&
          entries.some((entry) => !entry.answer && !entry.pending),
        entries,
      };
      return response;
    }
    case 'retry':
      answers.delete(message.key);
      await chrome.storage.session.remove(answerStorageKey(message.key));
      await rescheduleAll();
      return { ok: true };
    case 'settingsChanged':
      await dropFailedAnswers();
      await syncCustomSites();
      await rescheduleAll();
      return { ok: true };
    case 'injectTab':
      await syncCustomSites();
      return { ok: await injectTab(message.tabId) };
    default:
      return { error: 'unknown message' };
  }
}

chrome.runtime.onMessage.addListener((message: ContentMessage | UiMessage, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const work = (async (): Promise<unknown> => {
    await ready;
    const tabId = sender.tab?.id;
    if (message.type === 'questions' || message.type === 'displayed') {
      if (tabId === undefined || sender.frameId === undefined) return null;
      if (message.type === 'questions') await handleQuestions(tabId, sender.frameId, message);
      else {
        const report = frames.get(`${tabId}:${sender.frameId}`);
        const known = report?.questions.some((question) => question.key === message.key);
        if (report && known && typeof message.displayMs === 'number' && Number.isFinite(message.displayMs)) {
          report.displayMs[message.key] = message.displayMs;
          await chrome.storage.session.set({ [frameStorageKey(tabId, sender.frameId)]: report });
        }
      }
      return null;
    }
    // Only Quieasy's own extension pages (popup, settings) may control it.
    if (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(''))) return { error: 'not allowed' };
    return handleUiMessage(message);
  })();
  work.then(sendResponse, (error: unknown) => sendResponse({ error: String(error) }));
  return true;
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'enable') void turnOnInTab(tab?.id);
  if (command === 'disable') void setEnabled(false);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    await ready;
    const removed = [...frames.keys()].filter((frameKey) => frameKey.startsWith(`${tabId}:`));
    removed.forEach((frameKey) => frames.delete(frameKey));
    lookupsByTab.delete(tabId);
    scheduler.releaseWhere((subscriber) => subscriber.startsWith(`${tabId}:`));
    await chrome.storage.session.remove([...removed.map((frameKey) => `${SESSION_KEYS.framePrefix}${frameKey}`), lookupStorageKey(tabId)]);
  })();
});

// Keep the in-memory mirrors in step with removals made elsewhere (for example a cleared session).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  for (const [key, change] of Object.entries(changes)) {
    if (change.newValue !== undefined) continue;
    if (key.startsWith(SESSION_KEYS.answerPrefix)) answers.delete(key.slice(SESSION_KEYS.answerPrefix.length));
    else if (key.startsWith(SESSION_KEYS.framePrefix)) frames.delete(key.slice(SESSION_KEYS.framePrefix.length));
  }
});

chrome.runtime.onInstalled.addListener(() => void syncCustomSites());
chrome.permissions.onAdded.addListener(() => void syncCustomSites());
chrome.permissions.onRemoved.addListener(() => void syncCustomSites());
