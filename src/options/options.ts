import { parseSiteHost, sitePattern, storedSites } from '../background/sites';
import {
  AI_SETTINGS_KEY,
  ANTHROPIC_MODELS,
  awsAccessKeyProblem,
  azureOrigin,
  BEDROCK_MODELS,
  BEDROCK_REGIONS,
  endpointPermission,
  isDeploymentName,
  keyHint,
  LEGACY_KEYS,
  OPENAI_MODELS,
  PROVIDER_IDS,
  PROVIDERS,
  readAiSettings,
  type AiSettings,
  type ModelOption,
  type ProviderId,
} from '../shared/providers';
import { LOCAL_KEYS } from '../shared/settings';
import type { UiMessage } from '../shared/types';

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const providerSelect = element<HTMLSelectElement>('provider');
const providerNote = element<HTMLParagraphElement>('provider-note');
const azureFields = element<HTMLDivElement>('azure-fields');
const azureEndpoint = element<HTMLInputElement>('azure-endpoint');
const azureDeployment = element<HTMLInputElement>('azure-deployment');
const bedrockFields = element<HTMLDivElement>('bedrock-fields');
const bedrockRegion = element<HTMLSelectElement>('bedrock-region');
const modelField = element<HTMLDivElement>('model-field');
const modelSelect = element<HTMLSelectElement>('model');
const keyLabel = element<HTMLLabelElement>('api-key-label');
const keyInput = element<HTMLInputElement>('api-key');
const keyStatus = element<HTMLSpanElement>('key-status');
const keyLink = element<HTMLAnchorElement>('key-link');
const dataNote = element<HTMLParagraphElement>('data-note');
const saved = element<HTMLSpanElement>('saved');
const formError = element<HTMLParagraphElement>('form-error');
const siteInput = element<HTMLInputElement>('site');
const siteError = element<HTMLParagraphElement>('site-error');
const siteList = element<HTMLUListElement>('sites');
const shortcuts = element<HTMLParagraphElement>('shortcuts');

/** What each service is, what it costs and where its data goes, in the user's terms. */
const PROVIDER_NOTES: Record<ProviderId, string> = {
  anthropic:
    "Claude with Anthropic's web search tool. Anthropic charges $10 per 1,000 searches plus tokens. Web search must be enabled for your Anthropic organization (it is by default).",
  openai:
    'An OpenAI API key from platform.openai.com, billed per request by OpenAI, with OpenAI\'s web search tool. A ChatGPT subscription (Plus, Pro, Business) does not include API access and cannot be used here.',
  azure:
    'A model deployment in your Azure OpenAI or Microsoft Foundry resource, used through the v1 Responses API with web search (Grounding with Bing, billed by Microsoft). Microsoft notes that web search data leaves your Azure compliance and geographic boundary, and a subscription admin can turn web search off.',
  bedrock:
    'OpenAI GPT-5.6 models on Amazon Bedrock with Bedrock Web Search, which Quieasy limits to Amazon\'s own search index and page cache. Use a short-term Bedrock API key (Bedrock console, API keys, Short-term API keys): it lasts at most 12 hours and works only in the Region it was created in. AWS recommends long-term keys only for trying Bedrock out. Never paste AWS access keys here.',
};

let settings: AiSettings = readAiSettings({});
let savedTimer: ReturnType<typeof setTimeout> | null = null;

function notify(): Promise<unknown> {
  const message: UiMessage = { type: 'settingsChanged' };
  return chrome.runtime.sendMessage(message);
}

function fillSelect(select: HTMLSelectElement, options: readonly ModelOption[], value: string): void {
  select.replaceChildren(...options.map((option) => new Option(option.label, option.id)));
  select.value = value;
}

function selectedProvider(): ProviderId {
  return PROVIDER_IDS.includes(providerSelect.value as ProviderId) ? (providerSelect.value as ProviderId) : settings.provider;
}

/** Shows the fields of the service picked in the list, filled with what was saved for it. */
function renderProvider(): void {
  const provider = selectedProvider();
  const info = PROVIDERS[provider];
  providerNote.textContent = PROVIDER_NOTES[provider];
  azureFields.hidden = provider !== 'azure';
  bedrockFields.hidden = provider !== 'bedrock';
  modelField.hidden = provider === 'azure';
  if (provider === 'anthropic') fillSelect(modelSelect, ANTHROPIC_MODELS, settings.anthropic.model);
  if (provider === 'openai') fillSelect(modelSelect, OPENAI_MODELS, settings.openai.model);
  if (provider === 'bedrock') fillSelect(modelSelect, BEDROCK_MODELS, settings.bedrock.model);
  azureEndpoint.value = settings.azure.endpoint;
  azureDeployment.value = settings.azure.deployment;
  bedrockRegion.value = settings.bedrock.region;

  keyLabel.textContent = info.keyLabel;
  keyInput.value = '';
  keyInput.placeholder = info.keyPlaceholder;
  const apiKey = settings[provider].apiKey;
  const hint = keyHint(apiKey);
  keyStatus.textContent = apiKey
    ? `A key is saved${hint ? ` (ending in ${hint})` : ''}. Paste a new one to replace it.`
    : 'No key saved.';
  keyLink.href = info.keyUrl;
  renderDataNote();
  formError.hidden = true;
}

/** Names the one address the key and questions go to, following the endpoint or region as it is edited. */
function renderDataNote(): void {
  const provider = selectedProvider();
  const permission = endpointPermission({
    ...settings,
    provider,
    azure: { ...settings.azure, endpoint: azureEndpoint.value },
    bedrock: { ...settings.bedrock, region: bedrockRegion.value },
  });
  const host = permission ? hostOf(permission) : `your ${PROVIDERS[provider].label} endpoint`;
  dataNote.textContent = `The key is stored only in this browser profile and sent only to ${host}. The web pages Quieasy runs on can't read it.`;
}

function hostOf(permission: string): string {
  return new URL(permission.replace(/\/\*$/, '')).host;
}

/** The settings as they would be saved from the form, or why they cannot be. */
function draft(): { next: AiSettings } | { error: string } {
  const provider = selectedProvider();
  const next: AiSettings = structuredClone(settings);
  next.provider = provider;
  const typed = keyInput.value.trim();
  const apiKey = typed || settings[provider].apiKey;
  if (!apiKey) return { error: `Paste your ${PROVIDERS[provider].keyLabel}.` };
  if (/\s/.test(apiKey)) return { error: 'An API key has no spaces or line breaks. Paste just the key.' };
  switch (provider) {
    case 'anthropic':
      next.anthropic = { apiKey, model: modelSelect.value };
      break;
    case 'openai':
      next.openai = { apiKey, model: modelSelect.value };
      break;
    case 'azure': {
      const endpoint = azureOrigin(azureEndpoint.value);
      if (!endpoint) {
        return { error: 'Enter your resource endpoint, such as https://your-resource.openai.azure.com (Azure portal, Keys and Endpoint).' };
      }
      const deployment = azureDeployment.value.trim();
      if (!isDeploymentName(deployment)) return { error: 'Enter the deployment name of a model deployed in that resource.' };
      next.azure = { apiKey, endpoint, deployment };
      break;
    }
    case 'bedrock': {
      const problem = awsAccessKeyProblem(apiKey);
      if (problem) return { error: problem };
      next.bedrock = { apiKey, region: bedrockRegion.value, model: modelSelect.value };
      break;
    }
  }
  return { next };
}

async function store(next: AiSettings): Promise<void> {
  await chrome.storage.local.set({ [AI_SETTINGS_KEY]: next });
  settings = next;
  await notify();
  renderProvider();
  saved.hidden = false;
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (saved.hidden = true), 1500);
}

function showError(message: string): void {
  formError.textContent = message;
  formError.hidden = false;
}

async function load(): Promise<void> {
  fillSelect(providerSelect, PROVIDER_IDS.map((id) => ({ id, label: PROVIDERS[id].label })), 'anthropic');
  fillSelect(bedrockRegion, BEDROCK_REGIONS, BEDROCK_REGIONS[0]?.id ?? '');
  settings = readAiSettings(await chrome.storage.local.get([AI_SETTINGS_KEY, LEGACY_KEYS.apiKey, LEGACY_KEYS.model]));
  providerSelect.value = settings.provider;
  renderProvider();
  await renderSites();
  const commands = await chrome.commands.getAll();
  const key = (name: string): string => commands.find((command) => command.name === name)?.shortcut || 'not set';
  shortcuts.textContent = `Turn on: ${key('enable')} · Turn off: ${key('disable')} · Answer key: ${key('_execute_action')}`;
}

async function renderSites(): Promise<void> {
  const sites = await storedSites();
  siteList.replaceChildren(
    ...sites.map((host) => {
      const item = document.createElement('li');
      item.textContent = `${host} `;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'link';
      remove.textContent = 'remove';
      remove.addEventListener('click', () => void removeSite(host));
      item.append(remove);
      return item;
    }),
  );
}

async function removeSite(host: string): Promise<void> {
  const sites = (await storedSites()).filter((site) => site !== host);
  await chrome.storage.local.set({ [LOCAL_KEYS.customSites]: sites });
  await chrome.permissions.remove({ origins: [sitePattern(host)] }).catch(() => false);
  await notify();
  await renderSites();
}

providerSelect.addEventListener('change', renderProvider);
azureEndpoint.addEventListener('input', renderDataNote);
bedrockRegion.addEventListener('change', renderDataNote);

element<HTMLFormElement>('ai-form').addEventListener('submit', (event) => {
  event.preventDefault();
  formError.hidden = true;
  const result = draft();
  if ('error' in result) {
    showError(result.error);
    return;
  }
  const permission = endpointPermission(result.next);
  if (!permission) return;
  // permissions.request must run directly in the click handler. Chrome asks the user to confirm
  // access to that one service address; Anthropic's is granted at install.
  void chrome.permissions.request({ origins: [permission] }).then(async (granted) => {
    if (!granted) {
      showError(`Chrome did not allow Quieasy to reach ${hostOf(permission)}, so nothing was saved.`);
      return;
    }
    await store(result.next);
  });
});

element<HTMLButtonElement>('clear-key').addEventListener('click', () => {
  const provider = selectedProvider();
  const next: AiSettings = structuredClone(settings);
  next[provider].apiKey = '';
  void store(next);
});

element<HTMLFormElement>('site-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const host = parseSiteHost(siteInput.value);
  siteError.hidden = true;
  if (!host) {
    siteError.textContent = 'Enter a web address such as canvas.yourschool.edu.';
    siteError.hidden = false;
    return;
  }
  // permissions.request must run directly in the click handler.
  void chrome.permissions.request({ origins: [sitePattern(host)] }).then(async (granted) => {
    if (!granted) {
      siteError.textContent = 'Permission was not granted, so Quieasy will not run there.';
      siteError.hidden = false;
      return;
    }
    const sites = new Set(await storedSites());
    sites.add(host);
    await chrome.storage.local.set({ [LOCAL_KEYS.customSites]: [...sites] });
    await notify();
    siteInput.value = '';
    await renderSites();
  });
});

element<HTMLButtonElement>('edit-shortcuts').addEventListener('click', () => {
  void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

void load();
