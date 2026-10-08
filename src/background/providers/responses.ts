import { endpointUrl, type ProviderConfig } from '../../shared/providers';
import type { QuestionData, Source } from '../../shared/types';
import { postJson, type PostOptions } from './http';
import { addSource, asArray, asRecord, urlKey } from './parse';
import { ANSWER_NAME, answerSchema, systemPrompt, userPrompt, type ProviderReply } from './prompt';

/** The OpenAI Responses API, which OpenAI, Azure OpenAI and Amazon Bedrock all serve. */
export type ResponsesConfig = Extract<ProviderConfig, { provider: 'openai' | 'azure' | 'bedrock' }>;

export interface ResponsesRequest {
  model: string;
  instructions: string;
  input: { role: 'user'; content: string }[];
  tools: Record<string, unknown>[];
  tool_choice: 'auto';
  text: { format: { type: 'json_schema'; name: string; strict: true; schema: Record<string, unknown> } };
  max_output_tokens: number;
  /** Asks the service not to keep the request and reply for later retrieval. */
  store: false;
  reasoning?: { effort: 'low' };
  include?: string[];
}

/** The exact request body sent for one question. Contains only the question itself. */
export function responsesRequest(question: QuestionData, config: ResponsesConfig): ResponsesRequest {
  const webSearch: Record<string, unknown> = { type: 'web_search' };
  // Bedrock: search Amazon's own index and page cache only, so no request data leaves AWS.
  if (config.provider === 'bedrock') webSearch.external_web_access = false;
  if (config.provider !== 'azure') webSearch.search_context_size = 'low';
  const request: ResponsesRequest = {
    model: config.provider === 'azure' ? config.deployment : config.model,
    instructions: systemPrompt('reply with the answer in the required JSON format.'),
    input: [{ role: 'user', content: userPrompt(question) }],
    tools: [webSearch],
    tool_choice: 'auto',
    text: { format: { type: 'json_schema', name: ANSWER_NAME, strict: true, schema: answerSchema(question) } },
    max_output_tokens: 8192,
    store: false,
  };
  // An Azure deployment may be any model, so it gets no reasoning setting it might reject.
  if (config.provider !== 'azure') request.reasoning = { effort: 'low' };
  // Every page the searches returned, to check the model's source URLs against.
  if (config.provider !== 'bedrock') request.include = ['web_search_call.action.sources'];
  return request;
}

/** The header each service documents for its API key: Azure's own `api-key`, a bearer token elsewhere. */
export function responsesHeaders(config: ResponsesConfig): Record<string, string> {
  return config.provider === 'azure' ? { 'api-key': config.apiKey } : { authorization: `Bearer ${config.apiKey}` };
}

export async function askResponses(question: QuestionData, config: ResponsesConfig, options: PostOptions): Promise<ProviderReply> {
  const reply = await postJson(endpointUrl(config), responsesHeaders(config), responsesRequest(question, config), options);
  return readResponsesReply(reply, config.provider === 'azure' ? config.deployment : config.model);
}

/** Collects the answer, searches and citations from a Responses API reply. */
export function readResponsesReply(reply: unknown, requestedModel: string): ProviderReply {
  const body = asRecord(reply);
  const searched = new Map<string, Source>();
  const cited = new Map<string, Source>();
  let calls = 0;
  let refused = false;
  let text = '';

  for (const value of asArray(body.output)) {
    const item = asRecord(value);
    if (item.type === 'web_search_call') {
      const action = asRecord(item.action);
      if (action.type === undefined || action.type === 'search') calls += 1;
      for (const source of asArray(action.sources)) addSource(searched, asRecord(source).url, null);
    }
    if (item.type !== 'message') continue;
    // The answer is the last message; reasoning models can write earlier ones while they work.
    let messageText = '';
    for (const part of asArray(item.content)) {
      const content = asRecord(part);
      if (content.type === 'refusal') refused = true;
      if (content.type !== 'output_text' || typeof content.text !== 'string') continue;
      messageText += content.text;
      for (const annotation of asArray(content.annotations)) {
        const { type, url, title } = asRecord(annotation);
        if (type === 'url_citation') addSource(cited, url, title);
      }
    }
    if (messageText.trim()) text = messageText;
  }
  // Search sources carry no titles; take them from citations of the same page.
  for (const source of cited.values()) {
    const match = searched.get(urlKey(source.url));
    if (match && match.title === match.url) match.title = source.title;
  }
  const usage = asRecord(asRecord(body.tool_usage).web_search);
  const reported = typeof usage.num_requests === 'number' ? usage.num_requests : 0;
  return {
    model: typeof body.model === 'string' ? body.model : requestedModel,
    answer: refused ? null : parseJson(text),
    refused,
    searched: [...searched.values()],
    cited: [...cited.values()],
    searches: Math.max(calls, reported),
  };
}

function parseJson(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
