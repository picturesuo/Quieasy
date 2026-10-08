import { normalizeText } from './text';
import type { AnswerRecord, QuestionKind } from './types';

/**
 * Returns the indexes of the choices that get the faint gray hover dot for this answer, or an
 * empty list whenever the answer is not definite. Anything ambiguous shows nothing:
 * a missing or duplicated choice text, or more than one correct choice on a
 * single-answer question.
 */
export function correctChoiceIndexes(
  kind: QuestionKind,
  choices: readonly string[],
  answer: AnswerRecord | null | undefined,
): number[] {
  if (!answer || answer.status !== 'answered' || answer.correct.length === 0) return [];
  if (kind === 'single' && answer.correct.length !== 1) return [];

  const normalizedChoices = choices.map(normalizeText);
  const indexes: number[] = [];
  for (const correctText of answer.correct) {
    const matches = normalizedChoices.flatMap((text, index) => (text === correctText ? [index] : []));
    if (matches.length !== 1) return [];
    indexes.push(matches[0] as number);
  }
  return indexes.sort((a, b) => a - b);
}
