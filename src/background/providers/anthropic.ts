import { MAX_SEARCHES_PER_QUESTION } from '../../shared/settings';
import { endpointUrl, type AnthropicModel, type ProviderConfig } from '../../shared/providers';
import type { QuestionData, Source } from '../../shared/types';
import { postJson, type PostOptions } from './http';
import { addSource, asArray, asRecord } from './parse';
import { ANSWER_NAME, answerSchema, systemPrompt, userPrompt, type ProviderReply } from './prompt';

/** Claude Messages API with Anthropic's server-side web search tool. */
const API_VERSION = '2023-06-01';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** A long search turn can pause; it is resumed at most this many times. */
const MAX_PAUSE_CONTINUATIONS = 2;

interface Message {
  role: 'user' | 'assistant';
  content: unknown;
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system: string;
  tools: unknown[];
  tool_choice: { type: 'auto' };
  messages: Message[];
  output_config?: { effort: 'low' | 'medium' };
  fallbacks?: 'default';
}

/** The exact request body sent for one question. Contains only the question itself. */
export function anthropicRequest(question: QuestionData, model: AnthropicModel): AnthropicRequest {
  const request: AnthropicRequest = {
    model: model.id,
    max_tokens: 4096,
    system: systemPrompt(`call ${ANSWER_NAME} exactly once.`),
    tools: [
      { type: 'web_search_20250305', name: 'web_search', max_uses: MAX_SEARCHES_PER_QUESTION },
      {
        name: ANSWER_NAME,
        description: 'Record the final answer to the quiz question. Call exactly once, after any web searches.',
        strict: true,
        input_schema: answerSchema(question),
      },
    ],
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: userPrompt(question) }],
  };
  if (model.effort) request.output_config = { effort: model.effort };
  if (model.serverFallback) request.fallbacks = 'default';
  return request;
}

export function anthropicHeaders(apiKey: string, model: AnthropicModel): Record<string, string> {
  return {
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
    // Required by the API for requests made from a browser context such as an extension.
    'anthropic-dangerous-direct-browser-access': 'true',
    ...(model.serverFallback ? { 'anthropic-beta': FALLBACK_BETA } : {}),
  };
}

export type AnthropicConfig = Extract<ProviderConfig, { provider: 'anthropic' }>;

export async function askAnthropic(question: QuestionData, config: AnthropicConfig, options: PostOptions): Promise<ProviderReply> {
  const { apiKey, model } = config;
  const request = anthropicRequest(question, model);
  const headers = anthropicHeaders(apiKey, model);
  const replies: unknown[] = [];
  let messages = request.messages;
  for (let turn = 0; turn <= MAX_PAUSE_CONTINUATIONS; turn += 1) {
    const reply = await postJson(endpointUrl(config), headers, { ...request, messages }, options);
    replies.push(reply);
    const message = asRecord(reply);
    if (message.stop_reason !== 'pause_turn') break;
    // A paused turn is resumed by sending its content back unchanged.
    messages = [...messages, { role: 'assistant', content: message.content }];
  }
  return readAnthropicReplies(replies, model.id);
}

/** Collects the answer, searches and citations from one or more Messages API replies. */
export function readAnthropicReplies(replies: unknown[], requestedModel: string): ProviderReply {
  const searched = new Map<string, Source>();
  const cited = new Map<string, Source>();
  let reported = 0;
  let counted = 0;
  let refused = false;
  let answer: unknown = null;
  let model = requestedModel;

  for (const reply of replies) {
    const message = asRecord(reply);
    if (typeof message.model === 'string') model = message.model;
    if (message.stop_reason === 'refusal') refused = true;
    const usage = asRecord(asRecord(message.usage).server_tool_use);
    if (typeof usage.web_search_requests === 'number') reported += usage.web_search_requests;
    for (const value of asArray(message.content)) {
      const block = asRecord(value);
      if (block.type === 'server_tool_use' && block.name === 'web_search') counted += 1;
      if (block.type === 'web_search_tool_result') {
        for (const result of asArray(block.content)) {
          const { url, title } = asRecord(result);
          addSource(searched, url, title);
        }
      }
      if (block.type === 'text') {
        for (const citation of asArray(block.citations)) {
          const { type, url, title } = asRecord(citation);
          if (type === 'web_search_result_location') addSource(cited, url, title);
        }
      }
      if (block.type === 'tool_use' && block.name === ANSWER_NAME) answer = block.input ?? null;
    }
  }
  return {
    model,
    answer,
    refused,
    searched: [...searched.values()],
    cited: [...cited.values()],
    searches: Math.max(reported, counted),
  };
}
