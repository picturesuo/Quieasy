import { endpointUrl, PROVIDERS, type ProviderConfig } from '../shared/providers';
import { choiceLetter, normalizeText, truncate } from '../shared/text';
import type { AnswerRecord, Confidence, QuestionData, Source } from '../shared/types';
import { askAnthropic } from './providers/anthropic';
import { ProviderError } from './providers/http';
import { urlKey } from './providers/parse';
import type { ProviderReply } from './providers/prompt';
import { askResponses } from './providers/responses';

const TIMEOUT_MS = 90_000;
const MAX_EXPLANATION_CHARS = 600;
const MAX_SEARCHED_SOURCES = 5;
const MAX_FALLBACK_CITATIONS = 3;

/** Asks the selected service, with web search, for the answer to one question. Rejects only when aborted. */
export async function answerQuestion(
  question: QuestionData,
  config: ProviderConfig,
  signal: AbortSignal,
  queuedMs: number,
  /** Overrides the HTTP client; used by tests. */
  fetchImpl?: typeof fetch,
): Promise<AnswerRecord> {
  const options = { signal, timeoutMs: TIMEOUT_MS, ...(fetchImpl ? { fetch: fetchImpl } : {}) };
  const started = performance.now();
  let reply: ProviderReply;
  try {
    reply =
      config.provider === 'anthropic'
        ? await askAnthropic(question, config, options)
        : await askResponses(question, config, options);
  } catch (error) {
    if (signal.aborted) throw error;
    return errorRecord(question, modelName(config), describeError(error, config), queuedMs, performance.now() - started);
  }
  return toAnswerRecord(question, reply, queuedMs, performance.now() - started);
}

/**
 * Checks a reply and turns it into what the answer key and the hover dot use. Anything malformed
 * becomes an error; only high or medium confidence with a valid choice set counts as answered.
 */
export function toAnswerRecord(question: QuestionData, reply: ProviderReply, queuedMs: number, providerMs: number): AnswerRecord {
  const base = {
    key: question.key,
    model: reply.model,
    searches: reply.searches,
    searched: reply.searched.slice(0, MAX_SEARCHED_SOURCES),
    timing: { queuedMs, providerMs },
    at: Date.now(),
  };
  if (reply.refused) {
    return { ...base, ...emptyAnswer(), status: 'error', error: 'The AI declined to answer this question.' };
  }
  const parsed = parseAnswer(reply.answer, question);
  if (!parsed) {
    return { ...base, ...emptyAnswer(), status: 'error', error: 'The AI did not return an answer.' };
  }

  // Only pages the searches actually returned or the service cited; never a URL the model wrote itself.
  const known = new Map<string, Source>();
  for (const source of [...reply.searched, ...reply.cited]) if (!known.has(urlKey(source.url))) known.set(urlKey(source.url), source);
  const sources: Source[] = [];
  for (const url of parsed.sourceUrls) {
    const source = known.get(urlKey(url));
    if (source && !sources.includes(source)) sources.push(source);
  }
  if (sources.length === 0) sources.push(...reply.cited.slice(0, MAX_FALLBACK_CITATIONS));

  const definite =
    parsed.confidence !== 'low' &&
    parsed.letters.length > 0 &&
    (question.kind === 'multiple' || parsed.letters.length === 1);
  return {
    ...base,
    status: definite ? 'answered' : 'unsure',
    correct: definite
      ? parsed.letters.map((letter) => normalizeText(question.choices[letter.charCodeAt(0) - 65] ?? ''))
      : [],
    confidence: parsed.confidence,
    explanation: parsed.explanation,
    sources,
    error: null,
  };
}

interface ParsedAnswer {
  letters: string[];
  confidence: Confidence;
  explanation: string;
  sourceUrls: string[];
}

function parseAnswer(input: unknown, question: QuestionData): ParsedAnswer | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  if (!Array.isArray(value.letters)) return null;
  const valid = new Set(question.choices.map((_, index) => choiceLetter(index)));
  const letters = [...new Set(value.letters.filter((letter): letter is string => typeof letter === 'string'))];
  if (letters.some((letter) => !valid.has(letter))) return null;
  const confidence: Confidence =
    value.confidence === 'high' || value.confidence === 'medium' ? value.confidence : 'low';
  const explanation = typeof value.explanation === 'string' ? truncate(value.explanation.trim(), MAX_EXPLANATION_CHARS) : '';
  const sourceUrls = Array.isArray(value.source_urls)
    ? value.source_urls.filter((url): url is string => typeof url === 'string')
    : [];
  return { letters: letters.sort(), confidence, explanation, sourceUrls };
}

function emptyAnswer(): Pick<AnswerRecord, 'correct' | 'confidence' | 'explanation' | 'sources'> {
  return { correct: [], confidence: null, explanation: '', sources: [] };
}

export function errorRecord(
  question: QuestionData,
  model: string,
  message: string,
  queuedMs: number,
  providerMs: number,
): AnswerRecord {
  return {
    key: question.key,
    status: 'error',
    ...emptyAnswer(),
    searched: [],
    searches: 0,
    model,
    error: message,
    timing: { queuedMs, providerMs },
    at: Date.now(),
  };
}

export function modelName(config: ProviderConfig): string {
  switch (config.provider) {
    case 'anthropic':
      return config.model.id;
    case 'azure':
      return config.deployment;
    default:
      return config.model;
  }
}

/** A fixed message per failure. Service error text is never shown or stored: it can quote key fragments. */
export function describeError(error: unknown, config: ProviderConfig): string {
  const { label } = PROVIDERS[config.provider];
  if (!(error instanceof ProviderError)) return 'The AI request failed.';
  switch (error.kind) {
    case 'timeout':
      return 'The AI request timed out.';
    case 'network':
      return `Could not reach ${new URL(endpointUrl(config)).host}.`;
    case 'invalid-response':
      return `${label} sent a reply Quieasy could not read.`;
    case 'http':
      break;
  }
  switch (error.status) {
    case 400:
      return `${label} rejected the request (HTTP 400). Check that web search is enabled for your account and model.`;
    case 401:
      return `${label} rejected the API key. Check it in Quieasy settings.`;
    case 403:
      return `This ${label} key is not allowed to use this model or web search.`;
    case 404:
      return `${label} could not find this model or deployment. Check Quieasy settings.`;
    case 429:
      return `${label} rate limit or quota reached. Retry in a moment.`;
    default:
      return `The AI request failed (HTTP ${error.status}).`;
  }
}
