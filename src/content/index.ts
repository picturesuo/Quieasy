import { answerStorageKey, SESSION_KEYS } from '../shared/settings';
import type { AnswerRecord, ContentMessage, QuieasyState } from '../shared/types';
import { extractQuestions, type ExtractedQuestion } from './extract';
import { applyMarks, clearAllMarks, clearMarks } from './markers';

declare global {
  interface Window {
    __quieasyLoaded?: boolean;
  }
}

const RESCAN_DELAY_MS = 150;
const RESEND_INTERVAL_MS = 15_000;

/**
 * Runs in every reachable frame of a Canvas page, an allowed site, or a tab the user turned
 * Quieasy on in. Does nothing until Quieasy is turned on.
 * While on, it reads quiz questions from the page, asks the service worker for answers
 * and marks correct choices so they show a faint gray dot under the user's own pointer.
 */
class QuieasyContent {
  private enabled = false;
  private generation = 0;
  private questions = new Map<string, ExtractedQuestion[]>();
  private answers = new Map<string, AnswerRecord>();
  private displayedAt = new Map<string, number>();
  private observer: MutationObserver | null = null;
  private rescanTimer: ReturnType<typeof setTimeout> | null = null;
  private resendTimer: ReturnType<typeof setInterval> | null = null;
  private lastReported: string | null = null;

  async start(): Promise<void> {
    chrome.storage.onChanged.addListener(this.onStorageChanged);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('pageshow', this.onPageShow);
    const stored = await chrome.storage.session.get(SESSION_KEYS.state).catch(() => ({}));
    const state = (stored as Record<string, QuieasyState | undefined>)[SESSION_KEYS.state];
    if (state?.enabled) this.activate();
  }

  private activate(): void {
    if (this.enabled) return;
    this.enabled = true;
    const generation = ++this.generation;
    this.observer = new MutationObserver(this.onMutations);
    this.observer.observe(document.body ?? document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    this.resendTimer = setInterval(() => this.resendIfPending(), RESEND_INTERVAL_MS);
    void this.scan(generation);
  }

  private deactivate(): void {
    this.enabled = false;
    this.generation += 1;
    this.observer?.disconnect();
    this.observer = null;
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    if (this.resendTimer) clearInterval(this.resendTimer);
    this.rescanTimer = null;
    this.resendTimer = null;
    clearAllMarks(document);
    this.questions.clear();
    this.answers.clear();
    this.displayedAt.clear();
    this.lastReported = null;
  }

  /**
   * After Quieasy is reloaded or updated, this copy keeps running in tabs that were already open
   * but can no longer reach the extension: chrome.* calls throw. It then removes its dots and stops.
   */
  private orphaned(): boolean {
    if (chrome.runtime?.id) return false;
    this.deactivate();
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('pageshow', this.onPageShow);
    return true;
  }

  private async scan(generation: number): Promise<void> {
    if (this.orphaned()) return;
    const started = performance.now();
    const extracted = extractQuestions(document);
    const extractMs = performance.now() - started;

    const next = new Map<string, ExtractedQuestion[]>();
    for (const question of extracted) {
      const list = next.get(question.data.key);
      if (list) list.push(question);
      else next.set(question.data.key, [question]);
    }
    clearAllMarks(document);
    this.questions = next;
    for (const key of next.keys()) this.render(key);
    this.report(extractMs, false);

    const missing = [...next.keys()].filter((key) => !this.answers.has(key));
    if (missing.length === 0) return;
    const cached = await chrome.storage.session.get(missing.map(answerStorageKey)).catch(() => ({}));
    if (generation !== this.generation || !this.enabled) return;
    for (const [storageKey, value] of Object.entries(cached as Record<string, AnswerRecord>)) {
      const key = storageKey.slice(SESSION_KEYS.answerPrefix.length);
      if (!this.answers.has(key)) {
        this.answers.set(key, value);
        this.render(key);
      }
    }
  }

  /** Applies the current answer to every copy of a question on the page. */
  private render(key: string): void {
    const entries = this.questions.get(key);
    if (!entries) return;
    const answer = this.answers.get(key);
    const started = performance.now();
    let marked = 0;
    for (const entry of entries) marked += applyMarks(entry, answer);
    const displayMs = performance.now() - started;
    if (answer && marked > 0 && this.displayedAt.get(key) !== answer.at) {
      this.displayedAt.set(key, answer.at);
      this.send({ type: 'displayed', key, displayMs });
    }
  }

  private report(extractMs: number, force: boolean): void {
    const questions = [...this.questions.values()].map((entries) => (entries[0] as ExtractedQuestion).data);
    const signature = JSON.stringify(questions);
    if (!force && signature === this.lastReported) return;
    this.lastReported = signature;
    this.send({ type: 'questions', questions, extractMs });
  }

  private resendIfPending(): void {
    if (!this.enabled || this.orphaned()) return;
    const pending = [...this.questions.keys()].some((key) => !this.answers.has(key));
    if (pending) this.report(0, true);
  }

  private send(message: ContentMessage): void {
    if (this.orphaned()) return;
    chrome.runtime.sendMessage(message).catch(() => {
      // The service worker may be restarting.
    });
  }

  private readonly onStorageChanged = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area !== 'session') return;
    const stateChange = changes[SESSION_KEYS.state];
    if (stateChange) {
      const next = stateChange.newValue as QuieasyState | undefined;
      if (next?.enabled) this.activate();
      else this.deactivate();
    }
    if (!this.enabled) return;
    for (const [storageKey, change] of Object.entries(changes)) {
      if (!storageKey.startsWith(SESSION_KEYS.answerPrefix)) continue;
      const key = storageKey.slice(SESSION_KEYS.answerPrefix.length);
      const record = change.newValue as AnswerRecord | undefined;
      if (record && record.key === key) this.answers.set(key, record);
      else this.answers.delete(key);
      this.render(key);
    }
  };

  /**
   * A change inside a question (or its removal) clears that question's marks at once,
   * so an answer can never stay attached to edited or replaced content while the
   * debounced rescan catches up. Unrelated page updates such as timers leave marks alone.
   */
  private readonly onMutations = (records: MutationRecord[]): void => {
    if (!this.enabled || this.orphaned() || records.length === 0) return;
    for (const record of records) {
      for (const entries of this.questions.values()) {
        for (const entry of entries) {
          const removed = Array.from(record.removedNodes).some((node) => node.contains(entry.root));
          if (removed || !entry.root.isConnected || entry.root.contains(record.target)) clearMarks(entry);
        }
      }
    }
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    const generation = this.generation;
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      if (generation === this.generation && this.enabled) void this.scan(generation);
    }, RESCAN_DELAY_MS);
  };

  private readonly onPageHide = (): void => {
    if (!this.enabled || this.orphaned()) return;
    this.lastReported = null;
    this.send({ type: 'questions', questions: [], extractMs: 0 });
  };

  private readonly onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted && this.enabled) void this.scan(this.generation);
  };
}

if (!window.__quieasyLoaded) {
  window.__quieasyLoaded = true;
  void new QuieasyContent().start();
}
