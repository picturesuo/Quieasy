import { describe, expect, it } from 'vitest';
import { correctChoiceIndexes } from '../../src/shared/answer';
import type { AnswerRecord } from '../../src/shared/types';

const record = (status: AnswerRecord['status'], correct: string[]): AnswerRecord => ({
  key: 'q', status, correct, confidence: 'high', explanation: '', sources: [], searched: [],
  searches: 1, model: 'm', error: null, timing: { queuedMs: 0, providerMs: 0 }, at: 0,
});

describe('which choices get the gray hover dot', () => {
  it('marks the one correct choice of a single-answer question by text', () => {
    expect(correctChoiceIndexes('single', ['Sydney', 'Canberra'], record('answered', ['canberra']))).toEqual([1]);
  });

  it('marks every correct choice of a select-all question', () => {
    expect(correctChoiceIndexes('multiple', ['2', '9', '11'], record('answered', ['11', '2']))).toEqual([0, 2]);
  });

  it('shows nothing for unsure, failed, missing or ambiguous answers', () => {
    expect(correctChoiceIndexes('single', ['A', 'B'], record('unsure', ['a']))).toEqual([]);
    expect(correctChoiceIndexes('single', ['A', 'B'], record('error', ['a']))).toEqual([]);
    expect(correctChoiceIndexes('single', ['A', 'B'], null)).toEqual([]);
    expect(correctChoiceIndexes('single', ['A', 'B'], record('answered', ['a', 'b']))).toEqual([]);
    expect(correctChoiceIndexes('single', ['A', 'A'], record('answered', ['a']))).toEqual([]);
    expect(correctChoiceIndexes('multiple', ['A', 'B'], record('answered', ['a', 'c']))).toEqual([]);
  });
});
