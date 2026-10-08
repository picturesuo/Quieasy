import { describe, expect, it } from 'vitest';
import { AnswerScheduler } from '../../src/background/scheduler';
import type { AnswerRecord, QuestionData } from '../../src/shared/types';

const question = (key: string): QuestionData => ({
  key, kind: 'single', stem: `stem ${key}`, choices: ['a', 'b'], hasImages: false, label: '', source: 'canvas-classic',
});
const record = (key: string): AnswerRecord => ({
  key, status: 'answered', correct: ['a'], confidence: 'high', explanation: '', sources: [],
  searched: [], searches: 1, model: 'm', error: null, timing: { queuedMs: 0, providerMs: 0 }, at: 0,
});

function setup(concurrency = 2) {
  const started: string[] = [];
  const signals = new Map<string, AbortSignal>();
  const release = new Map<string, () => void>();
  const results: string[] = [];
  const pending: number[] = [];
  const scheduler = new AnswerScheduler({
    concurrency,
    run: (q, signal) => {
      started.push(q.key);
      signals.set(q.key, signal);
      return new Promise<AnswerRecord>((resolve, reject) => {
        release.set(q.key, () => resolve(record(q.key)));
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    },
    onResult: (r) => results.push(r.key),
    onFailure: (q) => ({ ...record(q.key), status: 'error' }),
    onPending: (count) => pending.push(count),
  });
  return { scheduler, started, signals, release, results, pending };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('AnswerScheduler', () => {
  it('bounds concurrency and requests each question once across frames', async () => {
    const { scheduler, started, release, results } = setup(2);
    scheduler.want('1:0', [question('a'), question('b'), question('c')]);
    scheduler.want('2:0', [question('a')]);
    expect(started).toEqual(['a', 'b']);
    release.get('a')!();
    await tick();
    expect(started).toEqual(['a', 'b', 'c']);
    expect(results).toEqual(['a']);
  });

  it('cancels work no frame needs any more and drops its late result', async () => {
    const { scheduler, signals, release, results } = setup(2);
    scheduler.want('1:0', [question('a')]);
    scheduler.want('1:0', []);
    expect(signals.get('a')!.aborted).toBe(true);
    release.get('a')!();
    await tick();
    expect(results).toEqual([]);
  });

  it('keeps a question running while another frame still needs it', () => {
    const { scheduler, signals } = setup(2);
    scheduler.want('1:0', [question('a')]);
    scheduler.want('2:0', [question('a')]);
    scheduler.releaseWhere((subscriber) => subscriber.startsWith('1:'));
    expect(signals.get('a')!.aborted).toBe(false);
  });

  it('cancelAll aborts everything and delivers nothing afterwards', async () => {
    const { scheduler, signals, release, results, pending } = setup(1);
    scheduler.want('1:0', [question('a'), question('b')]);
    scheduler.cancelAll();
    expect(signals.get('a')!.aborted).toBe(true);
    release.get('a')!();
    await tick();
    expect(results).toEqual([]);
    expect(scheduler.pendingCount).toBe(0);
    expect(pending.at(-1)).toBe(0);
  });

  it('reports the pending count as work is added and completed', async () => {
    const { scheduler, release, pending } = setup(1);
    scheduler.want('1:0', [question('a'), question('b')]);
    expect(pending.at(-1)).toBe(2);
    release.get('a')!();
    await tick();
    expect(pending.at(-1)).toBe(1);
    release.get('b')!();
    await tick();
    expect(pending.at(-1)).toBe(0);
  });

  it('reports no pending work when the last in-flight request is cancelled instead of completed', () => {
    const { scheduler, signals, pending } = setup(2);
    scheduler.want('1:0', [question('a')]);
    scheduler.want('1:0', []);
    expect(signals.get('a')!.aborted).toBe(true);
    expect(pending.at(-1)).toBe(0);
  });

  it('reports no pending work once every frame of a closed tab is released', () => {
    const { scheduler, pending } = setup(2);
    scheduler.want('1:0', [question('a')]);
    scheduler.want('1:1', [question('b')]);
    expect(pending.at(-1)).toBe(2);
    scheduler.releaseWhere((subscriber) => subscriber.startsWith('1:'));
    expect(pending.at(-1)).toBe(0);
  });
});
