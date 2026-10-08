import type { AnswerRecord, QuestionData } from '../shared/types';

export interface SchedulerOptions {
  concurrency: number;
  /** Answers one question. Must resolve with a record (errors included) or reject after an abort. */
  run: (question: QuestionData, signal: AbortSignal, queuedMs: number) => Promise<AnswerRecord>;
  onResult: (record: AnswerRecord) => void;
  onFailure: (question: QuestionData, error: unknown, queuedMs: number) => AnswerRecord;
  /** Called with the number of queued and in-flight requests after every change to the work set. */
  onPending?: (count: number) => void;
  now?: () => number;
}

/**
 * Deduplicates and bounds answer requests. Each subscriber (one page frame) declares the
 * questions it currently shows; a question is requested once no matter how many frames
 * show it, and its request is cancelled as soon as no frame needs it any more.
 */
export class AnswerScheduler {
  private readonly subscribersByKey = new Map<string, Set<string>>();
  private readonly keysBySubscriber = new Map<string, Set<string>>();
  private readonly questions = new Map<string, QuestionData>();
  private readonly enqueuedAt = new Map<string, number>();
  private readonly active = new Map<string, AbortController>();
  private queue: string[] = [];
  private readonly now: () => number;

  constructor(private readonly options: SchedulerOptions) {
    this.now = options.now ?? (() => performance.now());
  }

  /** Replaces the set of unanswered questions a subscriber needs. */
  want(subscriber: string, questions: QuestionData[]): void {
    const nextKeys = new Set(questions.map((question) => question.key));
    const previousKeys = this.keysBySubscriber.get(subscriber) ?? new Set<string>();
    for (const question of questions) {
      let subscribers = this.subscribersByKey.get(question.key);
      if (!subscribers) {
        subscribers = new Set();
        this.subscribersByKey.set(question.key, subscribers);
      }
      subscribers.add(subscriber);
      if (!this.questions.has(question.key)) this.questions.set(question.key, question);
      if (!this.active.has(question.key) && !this.queue.includes(question.key)) {
        this.queue.push(question.key);
        this.enqueuedAt.set(question.key, this.now());
      }
    }
    for (const key of previousKeys) {
      if (!nextKeys.has(key)) this.unsubscribe(key, subscriber);
    }
    if (nextKeys.size > 0) this.keysBySubscriber.set(subscriber, nextKeys);
    else this.keysBySubscriber.delete(subscriber);
    this.pump();
    this.options.onPending?.(this.pendingCount);
  }

  /** Drops every subscriber whose id matches, e.g. all frames of a closed tab. */
  releaseWhere(predicate: (subscriber: string) => boolean): void {
    for (const subscriber of [...this.keysBySubscriber.keys()]) {
      if (predicate(subscriber)) this.want(subscriber, []);
    }
  }

  /** Aborts and forgets everything, e.g. when Quieasy is turned off. */
  cancelAll(): void {
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
    this.queue = [];
    this.subscribersByKey.clear();
    this.keysBySubscriber.clear();
    this.questions.clear();
    this.enqueuedAt.clear();
    this.options.onPending?.(0);
  }

  isPending(key: string): boolean {
    return this.active.has(key) || this.queue.includes(key);
  }

  get activeCount(): number {
    return this.active.size;
  }

  get pendingCount(): number {
    return this.active.size + this.queue.length;
  }

  private unsubscribe(key: string, subscriber: string): void {
    const subscribers = this.subscribersByKey.get(key);
    if (!subscribers) return;
    subscribers.delete(subscriber);
    if (subscribers.size > 0) return;
    this.subscribersByKey.delete(key);
    this.forget(key);
    this.active.get(key)?.abort();
    this.active.delete(key);
  }

  private forget(key: string): void {
    this.queue = this.queue.filter((queued) => queued !== key);
    this.questions.delete(key);
    this.enqueuedAt.delete(key);
  }

  private pump(): void {
    while (this.active.size < this.options.concurrency && this.queue.length > 0) {
      const key = this.queue.shift() as string;
      const question = this.questions.get(key);
      if (!question) continue;
      const controller = new AbortController();
      this.active.set(key, controller);
      const queuedMs = this.now() - (this.enqueuedAt.get(key) ?? this.now());
      const finish = (record: AnswerRecord | null): void => {
        if (this.active.get(key) !== controller) return;
        this.active.delete(key);
        this.subscribersByKey.delete(key);
        this.forget(key);
        for (const keys of this.keysBySubscriber.values()) keys.delete(key);
        if (record && !controller.signal.aborted) this.options.onResult(record);
        this.pump();
        this.options.onPending?.(this.pendingCount);
      };
      this.options
        .run(question, controller.signal, queuedMs)
        .then(finish)
        .catch((error: unknown) => {
          finish(controller.signal.aborted ? null : this.options.onFailure(question, error, queuedMs));
        });
    }
  }
}
