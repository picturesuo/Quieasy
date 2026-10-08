import { correctChoiceIndexes } from '../shared/answer';
import { LOCAL_KEYS, MAX_LOOKUPS_PER_TAB } from '../shared/settings';
import { choiceLetter, truncate } from '../shared/text';
import type { AnswerKeyEntry, AnswerKeyResponse, UiMessage } from '../shared/types';
import { parseSiteHost, sitePattern } from '../background/sites';

const params = new URLSearchParams(location.search);
const toggle = document.getElementById('toggle') as HTMLButtonElement;
const entriesList = document.getElementById('entries') as HTMLOListElement;
const empty = document.getElementById('empty') as HTMLParagraphElement;
const notices = document.getElementById('notices') as HTMLDivElement;
const shortcuts = document.getElementById('shortcuts') as HTMLParagraphElement;

let tabId: number | null = null;
let tabUrl: string | null = null;
let enabled = false;
let renderTimer: ReturnType<typeof setTimeout> | null = null;

if (params.has('tabId')) document.body.classList.replace('popup', 'page');

function send<T>(message: UiMessage): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

async function resolveTab(): Promise<void> {
  const requested = Number(params.get('tabId'));
  if (Number.isInteger(requested) && requested > 0) {
    tabId = requested;
    tabUrl = (await chrome.tabs.get(requested).catch(() => null))?.url ?? null;
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  tabUrl = tab?.url ?? null;
}

async function render(): Promise<void> {
  if (tabId === null) return;
  const data = await send<AnswerKeyResponse>({ type: 'answerKey', tabId });
  enabled = data.enabled;
  toggle.textContent = enabled ? 'On' : 'Off';
  toggle.setAttribute('aria-pressed', String(enabled));
  toggle.title = enabled ? 'Turn Quieasy off' : 'Turn Quieasy on';
  await renderNotices(data);
  renderEntries(data.entries);
}

async function renderNotices(data: AnswerKeyResponse): Promise<void> {
  notices.replaceChildren();
  if (data.setupNeeded) {
    notices.append(notice(data.setupNeeded, 'Open settings', () => void chrome.runtime.openOptionsPage()));
  }
  if (data.lookupLimitReached && tabId !== null) {
    const tab = tabId;
    notices.append(
      notice(
        `Quieasy stopped looking up new questions in this tab after ${MAX_LOOKUPS_PER_TAB}, so a page that keeps changing cannot run up your AI bill.`,
        'Look up more',
        // Turning off and on again starts a new allowance; cached answers are kept.
        () =>
          void send({ type: 'setEnabled', enabled: false })
            .then(() => send({ type: 'setEnabled', enabled: true, tabId: tab }))
            .then(render),
      ),
    );
  }
  const host = tabUrl?.startsWith('https://') ? parseSiteHost(tabUrl) : null;
  if (data.enabled && host && tabId !== null) {
    const pattern = sitePattern(host);
    const allowed = await chrome.permissions.contains({ origins: [pattern] });
    if (!allowed) {
      notices.append(
        notice(
          `Quieasy reads ${host} only when you turn it on in this tab. After opening another page here, press the On shortcut again, or let Quieasy run here automatically.`,
          `Always allow on ${host}`,
          () => void allowSite(host),
        ),
      );
    }
  }
}

async function allowSite(host: string): Promise<void> {
  const granted = await chrome.permissions.request({ origins: [sitePattern(host)] });
  if (!granted || tabId === null) return;
  const stored = await chrome.storage.local.get(LOCAL_KEYS.customSites);
  const sites = new Set<string>(Array.isArray(stored[LOCAL_KEYS.customSites]) ? (stored[LOCAL_KEYS.customSites] as string[]) : []);
  sites.add(host);
  await chrome.storage.local.set({ [LOCAL_KEYS.customSites]: [...sites] });
  await send({ type: 'injectTab', tabId });
  await render();
}

function notice(text: string, action: string, onClick: () => void): HTMLElement {
  const box = document.createElement('div');
  box.className = 'notice';
  const message = document.createElement('div');
  message.textContent = text;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary';
  button.textContent = action;
  button.addEventListener('click', onClick);
  box.append(message, button);
  return box;
}

function renderEntries(entries: AnswerKeyEntry[]): void {
  entriesList.replaceChildren(...entries.map(renderEntry));
  empty.hidden = entries.length > 0;
  empty.textContent = enabled
    ? 'No quiz questions found on this page yet.'
    : 'Turn Quieasy on to read the quiz questions on this page.';
}

function renderEntry(entry: AnswerKeyEntry, index: number): HTMLLIElement {
  const { question, answer } = entry;
  const item = document.createElement('li');
  item.className = 'entry';
  item.dataset.key = question.key;

  const head = document.createElement('div');
  head.className = 'entry-head';
  const title = document.createElement('span');
  title.textContent = question.label || `Question ${index + 1}`;
  const status = document.createElement('span');
  const state = answer?.status ?? (entry.pending ? 'pending' : 'idle');
  status.className = `status ${state}`;
  status.textContent = {
    answered: `${answer?.confidence ?? ''} confidence`.trim(),
    unsure: 'not sure',
    error: 'failed',
    pending: 'searching',
    idle: 'not looked up',
  }[state];
  head.append(title, status);

  const stem = document.createElement('p');
  stem.className = 'stem';
  stem.textContent = truncate(question.stem, 220);
  item.append(head, stem);

  const indexes = correctChoiceIndexes(question.kind, question.choices, answer);
  if (indexes.length > 0) {
    const line = document.createElement('p');
    line.className = 'answer';
    line.textContent = indexes
      .map((index) => `${choiceLetter(index)}. ${truncate(question.choices[index] ?? '', 120)}`)
      .join('  ·  ');
    item.append(line);
  }
  if (answer?.explanation) item.append(paragraph(answer.explanation));
  if (answer?.error) item.append(paragraph(answer.error));
  if (question.hasImages) item.append(paragraph('This question has images Quieasy did not send, so the answer may miss them.', 'muted small'));

  if (answer && answer.sources.length > 0) {
    item.append(paragraph('Sources', 'small'));
    item.append(sourceList(answer.sources));
  } else if (answer && answer.searched.length > 0) {
    item.append(paragraph('No source was cited. Search results the AI saw:', 'muted small'));
    item.append(sourceList(answer.searched));
  } else if (answer && answer.status !== 'error') {
    item.append(paragraph('Answered without a web source.', 'muted small'));
  }

  if (answer && answer.status !== 'answered') {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'secondary';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => void send({ type: 'retry', key: question.key }).then(render));
    item.append(retry);
  }

  const timing = document.createElement('div');
  timing.className = 'timing';
  const parts = [`read page ${ms(entry.extractMs)}`];
  if (answer) {
    parts.push(`queue ${ms(answer.timing.queuedMs)}`, `web search + AI ${ms(answer.timing.providerMs)}`);
    if (answer.searches) parts.push(`${answer.searches} search${answer.searches === 1 ? '' : 'es'}`);
  }
  if (entry.displayMs !== null) parts.push(`show ${ms(entry.displayMs)}`);
  if (answer) parts.push(answer.model);
  timing.textContent = parts.join(' · ');
  item.append(timing);
  return item;
}

function sourceList(sources: { url: string; title: string }[]): HTMLUListElement {
  const list = document.createElement('ul');
  list.className = 'sources';
  for (const source of sources) {
    if (!/^https?:\/\//i.test(source.url)) continue;
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = truncate(source.title || source.url, 90);
    link.title = source.url;
    item.append(link);
    list.append(item);
  }
  return list;
}

function paragraph(text: string, className = 'small'): HTMLParagraphElement {
  const element = document.createElement('p');
  element.className = className;
  element.textContent = text;
  return element;
}

function ms(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
}

function scheduleRender(): void {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => void render(), 100);
}

async function renderShortcuts(): Promise<void> {
  const commands = await chrome.commands.getAll();
  const key = (name: string): string => commands.find((command) => command.name === name)?.shortcut || 'not set';
  shortcuts.textContent = `On: ${key('enable')} · Off: ${key('disable')} · Answer key: ${key('_execute_action')}`;
}

toggle.addEventListener('click', () => {
  const message: UiMessage = { type: 'setEnabled', enabled: !enabled, ...(tabId !== null ? { tabId } : {}) };
  void send(message).then(render);
});
document.getElementById('settings')?.addEventListener('click', () => void chrome.runtime.openOptionsPage());
document.getElementById('open-tab')?.addEventListener('click', () => {
  if (tabId !== null) void chrome.tabs.create({ url: chrome.runtime.getURL(`popup.html?tabId=${tabId}`) });
});
chrome.storage.onChanged.addListener(scheduleRender);

void (async () => {
  await resolveTab();
  // Opening the popup lets Quieasy into this tab, so pick up a page loaded since it was turned on.
  if (tabId !== null && !params.has('tabId')) {
    const state = await send<AnswerKeyResponse>({ type: 'answerKey', tabId });
    if (state.enabled) await send({ type: 'injectTab', tabId });
  }
  await Promise.all([render(), renderShortcuts()]);
})();
