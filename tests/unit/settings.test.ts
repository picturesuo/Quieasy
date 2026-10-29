import { describe, expect, it } from 'vitest';
import { responsesRequest, type ResponsesConfig } from '../../src/background/providers/responses';
import {
  awsAccessKeyProblem,
  azureOrigin,
  BEDROCK_MODELS,
  defaultAiSettings,
  endpointPermission,
  endpointUrl,
  keyHint,
  providerConfig,
  readAiSettings,
  type AiSettings,
} from '../../src/shared/providers';
import type { QuestionData } from '../../src/shared/types';

// Synthetic credentials only.
const KEY = 'test-key-not-real-0000';

const question: QuestionData = {
  key: 'q1', kind: 'single', stem: 'What is the capital of Australia?', choices: ['Sydney', 'Canberra', 'Melbourne'],
  hasImages: false, label: 'Question 1', source: 'canvas-classic',
};

describe('stored settings', () => {
  it('keeps an Anthropic key and model saved before other services were supported', () => {
    const settings = readAiSettings({ apiKey: ` ${KEY} `, model: 'claude-sonnet-5-5' });
    expect(settings.provider).toBe('anthropic');
    expect(settings.anthropic).toEqual({ apiKey: KEY, model: 'claude-sonnet-5-5' });
    expect(providerConfig(settings)).toMatchObject({ config: { provider: 'anthropic', apiKey: KEY, model: { id: 'claude-sonnet-5-5' } } });
  });

  it('starts on Anthropic with nothing saved and says what is missing', () => {
    expect(readAiSettings({})).toEqual(defaultAiSettings());
    expect(providerConfig(readAiSettings({}))).toEqual({ missing: 'Add your Anthropic API key in Quieasy settings.' });
  });

  it('falls back to defaults for unknown services, models and regions', () => {
    const settings = readAiSettings({
      ai: { provider: 'evil', openai: { apiKey: 1, model: 'gpt-unknown' }, bedrock: { region: 'xx-moon-1', model: 'anthropic.claude' } },
    });
    expect(settings.provider).toBe('anthropic');
    expect(settings.openai).toEqual({ apiKey: '', model: 'gpt-6-astra' });
    expect(settings.bedrock).toMatchObject({ region: 'us-east-1', model: 'openai.gpt-5.6-sol' });
  });

  it('builds the request settings and the one endpoint for each service', () => {
    const base = defaultAiSettings();
    const cases: [AiSettings, string, string][] = [
      [{ ...base, provider: 'anthropic', anthropic: { apiKey: KEY, model: 'claude-opus-5-5' } }, 'https://api.anthropic.com/v1/messages', 'https://api.anthropic.com/*'],
      [{ ...base, provider: 'openai', openai: { apiKey: KEY, model: 'gpt-6-luna' } }, 'https://api.openai.com/v1/responses', 'https://api.openai.com/*'],
      [
        { ...base, provider: 'azure', azure: { apiKey: KEY, endpoint: 'https://Contoso.openai.azure.com/openai/v1/', deployment: 'gpt-5-5' } },
        'https://contoso.openai.azure.com/openai/v1/responses',
        'https://contoso.openai.azure.com/*',
      ],
      [
        { ...base, provider: 'bedrock', bedrock: { apiKey: KEY, region: 'us-east-2', model: 'openai.gpt-5.6-luna' } },
        'https://bedrock-mantle.us-east-2.api.aws/openai/v1/responses',
        'https://bedrock-mantle.us-east-2.api.aws/*',
      ],
    ];
    for (const [settings, url, permission] of cases) {
      const result = providerConfig(settings);
      if (!('config' in result)) throw new Error(result.missing);
      expect(endpointUrl(result.config)).toBe(url);
      expect(endpointPermission(settings)).toBe(permission);
    }
  });

  it('keeps a saved Bedrock choice as stored and sends its exact model ID', () => {
    // The shape the options page saves, field order included.
    const stored = { ai: { ...defaultAiSettings(), provider: 'bedrock', bedrock: { apiKey: KEY, model: 'openai.gpt-5.6-sol', region: 'us-east-2' } } };
    const settings = readAiSettings(structuredClone(stored));
    expect(settings).toEqual(stored.ai);
    const result = providerConfig(settings);
    if (!('config' in result)) throw new Error(result.missing);
    expect(responsesRequest(question, result.config as ResponsesConfig).model).toBe('openai.gpt-5.6-sol');
    for (const { id } of BEDROCK_MODELS) {
      const config = providerConfig({ ...settings, bedrock: { ...settings.bedrock, model: id } });
      if (!('config' in config)) throw new Error(config.missing);
      expect(responsesRequest(question, config.config as ResponsesConfig).model).toBe(id);
    }
  });

  it('asks for every Azure field', () => {
    const settings: AiSettings = { ...defaultAiSettings(), provider: 'azure', azure: { apiKey: KEY, endpoint: 'https://contoso.openai.azure.com', deployment: '' } };
    expect(providerConfig(settings)).toEqual({ missing: 'Add your Azure OpenAI endpoint, deployment name and API key in Quieasy settings.' });
  });
});

describe('input checks', () => {
  it('accepts only Azure OpenAI and Foundry resource hosts over https', () => {
    expect(azureOrigin('contoso.openai.azure.com')).toBe('https://contoso.openai.azure.com');
    expect(azureOrigin('https://contoso.cognitiveservices.azure.com/')).toBe('https://contoso.cognitiveservices.azure.com');
    expect(azureOrigin('https://contoso.services.ai.azure.com/api/projects/p')).toBe('https://contoso.services.ai.azure.com');
    for (const bad of ['', 'http://contoso.openai.azure.com', 'https://openai.azure.com', 'https://evil.example/contoso.openai.azure.com',
      'https://contoso.openai.azure.com.evil.example', 'https://user:pw@contoso.openai.azure.com', 'https://contoso.openai.azure.com:8443']) {
      expect(azureOrigin(bad)).toBeNull();
    }
  });

  it('refuses AWS access keys where a Bedrock API key belongs', () => {
    expect(awsAccessKeyProblem('AKIAIOSFODNN7EXAMPLE')).toContain('AWS access key ID');
    expect(awsAccessKeyProblem('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')).toContain('secret access key');
    expect(awsAccessKeyProblem('bedrock-api-key-c3ludGhldGljLXRlc3QtdmFsdWU=')).toBeNull();
  });

  it('hints at a saved key by its last four characters only', () => {
    expect(keyHint(KEY)).toBe('0000');
    expect(keyHint('short')).toBe('');
  });
});
