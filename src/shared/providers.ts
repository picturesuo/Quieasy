/**
 * The AI services Quieasy can use, each with the user's own credentials. Every one of them runs
 * real web searches for each question; a service or model without web search is not offered.
 */
export type ProviderId = 'anthropic' | 'openai' | 'azure' | 'bedrock';

export const PROVIDER_IDS: readonly ProviderId[] = ['anthropic', 'openai', 'azure', 'bedrock'];

export interface ModelOption {
  id: string;
  label: string;
}

export interface AnthropicModel extends ModelOption {
  /** output_config.effort, or null for models that reject the parameter. */
  effort: 'low' | 'medium' | null;
  /** Whether the model accepts server-side refusal fallbacks ("fallbacks": "default"). */
  serverFallback: boolean;
}

export const ANTHROPIC_MODELS: readonly AnthropicModel[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 - most accurate (default)', effort: 'low', serverFallback: true },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 - balanced', effort: 'low', serverFallback: true },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 - fastest, least accurate', effort: 'low', serverFallback: false },
];

export const OPENAI_MODELS: readonly ModelOption[] = [
  { id: 'gpt-6-astra', label: 'GPT-6 Astra - most accurate (default)' },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol - balanced' },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna - fastest, least accurate' },
];

/** OpenAI models that Amazon Bedrock serves with its Web Search tool (bedrock-mantle, Responses API). */
export const BEDROCK_MODELS: readonly ModelOption[] = [
  { id: 'openai.gpt-5.6-sol', label: 'GPT-5.6 Sol - most accurate (default)' },
  { id: 'openai.gpt-5.6-terra', label: 'GPT-5.6 Terra - balanced' },
  { id: 'openai.gpt-5.6-luna', label: 'GPT-5.6 Luna - fastest, least accurate' },
];

/** Regions where Amazon Bedrock offers Web Search in commercial AWS. */
export const BEDROCK_REGIONS: readonly ModelOption[] = [
  { id: 'us-east-1', label: 'US East (N. Virginia) - us-east-1' },
  { id: 'us-east-2', label: 'US East (Ohio) - us-east-2' },
  { id: 'us-west-2', label: 'US West (Oregon) - us-west-2' },
];

/** Host suffixes of Azure OpenAI and Microsoft Foundry resources that serve the v1 Responses API. */
const AZURE_HOST_SUFFIXES = ['.openai.azure.com', '.cognitiveservices.azure.com', '.services.ai.azure.com'];

export interface ProviderInfo {
  label: string;
  /** Who runs the model and the web searches, as named in the privacy notes. */
  company: string;
  keyLabel: string;
  keyPlaceholder: string;
  /** Where to create a key. */
  keyUrl: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  anthropic: {
    label: 'Anthropic Claude',
    company: 'Anthropic',
    keyLabel: 'Anthropic API key',
    keyPlaceholder: 'sk-ant-...',
    keyUrl: 'https://platform.claude.com/settings/keys',
  },
  openai: {
    label: 'OpenAI API',
    company: 'OpenAI',
    keyLabel: 'OpenAI API key',
    keyPlaceholder: 'sk-...',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  azure: {
    label: 'Azure OpenAI',
    company: 'Microsoft Azure',
    keyLabel: 'Azure OpenAI API key',
    keyPlaceholder: 'Key 1 or Key 2 of your resource',
    keyUrl: 'https://ai.azure.com',
  },
  bedrock: {
    label: 'Amazon Bedrock',
    company: 'Amazon Web Services',
    keyLabel: 'Amazon Bedrock API key',
    keyPlaceholder: 'bedrock-api-key-...',
    keyUrl: 'https://console.aws.amazon.com/bedrock/home#/api-keys',
  },
};

/** What the user saved for each service; only the selected one is used. */
export interface AiSettings {
  provider: ProviderId;
  anthropic: { apiKey: string; model: string };
  openai: { apiKey: string; model: string };
  azure: { apiKey: string; endpoint: string; deployment: string };
  bedrock: { apiKey: string; region: string; model: string };
}

/** Everything needed to send one request to the selected service. */
export type ProviderConfig =
  | { provider: 'anthropic'; apiKey: string; model: AnthropicModel }
  | { provider: 'openai'; apiKey: string; model: string }
  | { provider: 'azure'; apiKey: string; origin: string; deployment: string }
  | { provider: 'bedrock'; apiKey: string; region: string; model: string };

/** chrome.storage.local key for AiSettings. Local storage is readable only by Quieasy's own pages. */
export const AI_SETTINGS_KEY = 'ai';
/** Keys used before Quieasy supported more than one service: an Anthropic key and model. */
export const LEGACY_KEYS = { apiKey: 'apiKey', model: 'model' } as const;

export function defaultAiSettings(): AiSettings {
  return {
    provider: 'anthropic',
    anthropic: { apiKey: '', model: (ANTHROPIC_MODELS[0] as AnthropicModel).id },
    openai: { apiKey: '', model: (OPENAI_MODELS[0] as ModelOption).id },
    azure: { apiKey: '', endpoint: '', deployment: '' },
    bedrock: { apiKey: '', region: (BEDROCK_REGIONS[0] as ModelOption).id, model: (BEDROCK_MODELS[0] as ModelOption).id },
  };
}

/**
 * Reads settings from raw storage, accepting the legacy Anthropic-only keys. Unknown or malformed
 * values fall back to defaults, so a damaged store can never produce a request to an odd place.
 */
export function readAiSettings(stored: Record<string, unknown>): AiSettings {
  const settings = defaultAiSettings();
  const saved = isRecord(stored[AI_SETTINGS_KEY]) ? stored[AI_SETTINGS_KEY] : null;
  if (!saved) {
    settings.anthropic.apiKey = text(stored[LEGACY_KEYS.apiKey]);
    settings.anthropic.model = choice(stored[LEGACY_KEYS.model], ANTHROPIC_MODELS, settings.anthropic.model);
    return settings;
  }
  if (PROVIDER_IDS.includes(saved.provider as ProviderId)) settings.provider = saved.provider as ProviderId;
  const anthropic = isRecord(saved.anthropic) ? saved.anthropic : {};
  const openai = isRecord(saved.openai) ? saved.openai : {};
  const azure = isRecord(saved.azure) ? saved.azure : {};
  const bedrock = isRecord(saved.bedrock) ? saved.bedrock : {};
  settings.anthropic = { apiKey: text(anthropic.apiKey), model: choice(anthropic.model, ANTHROPIC_MODELS, settings.anthropic.model) };
  settings.openai = { apiKey: text(openai.apiKey), model: choice(openai.model, OPENAI_MODELS, settings.openai.model) };
  settings.azure = { apiKey: text(azure.apiKey), endpoint: text(azure.endpoint), deployment: text(azure.deployment) };
  settings.bedrock = {
    apiKey: text(bedrock.apiKey),
    region: choice(bedrock.region, BEDROCK_REGIONS, settings.bedrock.region),
    model: choice(bedrock.model, BEDROCK_MODELS, settings.bedrock.model),
  };
  return settings;
}

/** The request settings for the selected service, or what is still missing before it can be used. */
export function providerConfig(settings: AiSettings): { config: ProviderConfig } | { missing: string } {
  const { label, keyLabel } = PROVIDERS[settings.provider];
  switch (settings.provider) {
    case 'anthropic': {
      const { apiKey, model } = settings.anthropic;
      if (!apiKey) return { missing: `Add your ${keyLabel} in Quieasy settings.` };
      const option = ANTHROPIC_MODELS.find((candidate) => candidate.id === model) ?? (ANTHROPIC_MODELS[0] as AnthropicModel);
      return { config: { provider: 'anthropic', apiKey, model: option } };
    }
    case 'openai': {
      const { apiKey, model } = settings.openai;
      if (!apiKey) return { missing: `Add your ${keyLabel} in Quieasy settings.` };
      return { config: { provider: 'openai', apiKey, model } };
    }
    case 'azure': {
      const { apiKey, endpoint, deployment } = settings.azure;
      const origin = azureOrigin(endpoint);
      if (!apiKey || !origin || !isDeploymentName(deployment)) {
        return { missing: `Add your ${label} endpoint, deployment name and API key in Quieasy settings.` };
      }
      return { config: { provider: 'azure', apiKey, origin, deployment } };
    }
    case 'bedrock': {
      const { apiKey, region, model } = settings.bedrock;
      if (!apiKey) return { missing: `Add your ${keyLabel} in Quieasy settings.` };
      return { config: { provider: 'bedrock', apiKey, region, model } };
    }
  }
}

/** The single URL a service's requests go to. Quieasy sends question data nowhere else. */
export function endpointUrl(config: ProviderConfig): string {
  switch (config.provider) {
    case 'anthropic':
      return 'https://api.anthropic.com/v1/messages';
    case 'openai':
      return 'https://api.openai.com/v1/responses';
    case 'azure':
      return `${config.origin}/openai/v1/responses`;
    case 'bedrock':
      return `${bedrockOrigin(config.region)}/openai/v1/responses`;
  }
}

/** The host permission pattern Chrome must grant before Quieasy can reach a service. */
export function endpointPermission(settings: AiSettings): string | null {
  switch (settings.provider) {
    case 'anthropic':
      return 'https://api.anthropic.com/*';
    case 'openai':
      return 'https://api.openai.com/*';
    case 'azure': {
      const origin = azureOrigin(settings.azure.endpoint);
      return origin ? `${origin}/*` : null;
    }
    case 'bedrock':
      return `${bedrockOrigin(settings.bedrock.region)}/*`;
  }
}

export function bedrockOrigin(region: string): string {
  return `https://bedrock-mantle.${region}.api.aws`;
}

/**
 * Turns a pasted Azure endpoint ("https://my-resource.openai.azure.com/" or a full request URL)
 * into its https origin, or null unless it is an Azure OpenAI or Foundry resource host.
 */
export function azureOrigin(endpoint: string): string | null {
  const trimmed = endpoint.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  if (!AZURE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length)) return null;
  return `https://${host}`;
}

/** Azure deployment names: letters, digits, dot, dash and underscore. */
export function isDeploymentName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

/**
 * Bedrock takes an Amazon Bedrock API key. AWS access keys are a different, broader credential
 * that Quieasy never accepts; returns why a pasted value is one, or null.
 */
export function awsAccessKeyProblem(value: string): string | null {
  const key = value.trim();
  if (/^(AKIA|ASIA)[A-Z0-9]{16}$/.test(key)) {
    return 'This is an AWS access key ID. Quieasy needs an Amazon Bedrock API key instead (Bedrock console, API keys).';
  }
  if (/^[A-Za-z0-9/+]{40}$/.test(key)) {
    return 'This looks like an AWS secret access key. Quieasy needs an Amazon Bedrock API key instead (Bedrock console, API keys).';
  }
  return null;
}

/** The last four characters of a saved key, for "saved key ending in ..." hints. */
export function keyHint(apiKey: string): string {
  return apiKey.length >= 12 ? apiKey.slice(-4) : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function choice(value: unknown, options: readonly ModelOption[], fallback: string): string {
  return options.some((option) => option.id === value) ? (value as string) : fallback;
}
