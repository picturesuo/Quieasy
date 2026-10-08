import { expect, test, type Page } from '@playwright/test';
import { AZURE_ENDPOINT, BEDROCK_HOST, dotOf, SEARCH_RESULT_URL, TestEnv } from './harness';

// Every answer here comes from the mock services in harness.ts. The keys are synthetic.
const QUIZ_URL = 'https://school.instructure.com/courses/1/quizzes/2/take';
const choice = (question: number, index: number): string => `#question_${question} .answer:nth-of-type(${index})`;

const env = new TestEnv();

interface ProviderCase {
  name: string;
  /** Fills Quieasy's settings form the way a user does. */
  fill: (page: Page) => Promise<void>;
  key: string;
  /** The one header the key travels in, as that service documents it. */
  auth: Record<string, string>;
  host: string;
  path: string;
  model: string;
}

const cases: ProviderCase[] = [
  {
    name: 'OpenAI API',
    key: 'sk-test-openai-synthetic',
    auth: { authorization: 'Bearer sk-test-openai-synthetic' },
    host: 'api.openai.com',
    path: '/v1/responses',
    model: 'gpt-6-luna',
    fill: async (page) => {
      await page.selectOption('#provider', 'openai');
      await page.selectOption('#model', 'gpt-6-luna');
      await page.fill('#api-key', 'sk-test-openai-synthetic');
    },
  },
  {
    name: 'Azure OpenAI',
    key: 'azure-test-synthetic-key',
    auth: { 'api-key': 'azure-test-synthetic-key' },
    host: new URL(AZURE_ENDPOINT).host,
    path: '/openai/v1/responses',
    model: 'quiz-deployment',
    fill: async (page) => {
      await page.selectOption('#provider', 'azure');
      await page.fill('#azure-endpoint', `${AZURE_ENDPOINT}/openai/v1/`);
      await page.fill('#azure-deployment', 'quiz-deployment');
      await page.fill('#api-key', 'azure-test-synthetic-key');
    },
  },
  {
    name: 'Amazon Bedrock',
    key: 'bedrock-api-key-c3ludGhldGljLXRlc3Q=',
    auth: { authorization: 'Bearer bedrock-api-key-c3ludGhldGljLXRlc3Q=' },
    host: BEDROCK_HOST,
    path: '/openai/v1/responses',
    model: 'openai.gpt-5.6-terra',
    fill: async (page) => {
      await page.selectOption('#provider', 'bedrock');
      await page.selectOption('#bedrock-region', 'us-east-1');
      await page.selectOption('#model', 'openai.gpt-5.6-terra');
      await page.fill('#api-key', 'bedrock-api-key-c3ludGhldGljLXRlc3Q=');
    },
  },
];

async function openSettings(): Promise<Page> {
  const page = await env.context.newPage();
  await page.goto(env.extensionUrl('options.html'));
  await expect(page.locator('#provider option')).toHaveCount(4);
  return page;
}

async function answerKey(url: string): Promise<Page> {
  const tabId = await env.worker.evaluate(async (target) => (await chrome.tabs.query({ url: target }))[0]?.id ?? -1, url);
  const key = await env.context.newPage();
  await key.goto(env.extensionUrl(`popup.html?tabId=${tabId}`));
  return key;
}

test.beforeAll(async () => {
  await env.start();
});

test.afterAll(async () => {
  await env.stop();
});

test.beforeEach(async () => {
  for (const page of env.context.pages()) if (!page.url().startsWith('chrome-extension://')) await page.close();
  await env.resetSession();
  await env.setAiSettings(null);
  env.answers = [
    { match: /capital of Australia/, correct: ['Canberra'] },
    { match: /prime numbers/, correct: ['2', '11'] },
  ];
});

for (const provider of cases) {
  test(`${provider.name}: set up in settings, then each question goes only to that service`, async () => {
    const settings = await openSettings();
    await provider.fill(settings);
    await expect(settings.locator('#data-note')).toContainText(`sent only to ${provider.host}`);
    await settings.click('button[type="submit"]');
    await expect(settings.locator('#saved')).toBeVisible();
    await expect(settings.locator('#key-status')).toContainText(`ending in ${provider.key.slice(-4)}`);
    await expect(settings.locator('#api-key')).toHaveValue('');

    const page = await env.context.newPage();
    await page.goto(QUIZ_URL);
    await env.setEnabled(true);
    await expect(page.locator('[data-quieasy="correct"]')).toHaveCount(3);
    await expect.poll(() => env.requests.length).toBe(3);
    for (const request of env.requests) {
      expect(request.host).toBe(provider.host);
      expect(request.path).toBe(provider.path);
      for (const header of ['authorization', 'api-key', 'x-api-key']) expect(request.headers[header]).toBe(provider.auth[header]);
      expect(request.headers.cookie).toBeUndefined();
      expect(request.body.model).toBe(provider.model);
      expect(request.body.store).toBe(false);
      expect((request.body.tools as { type: string }[])[0]?.type).toBe('web_search');
      const body = JSON.stringify(request.body);
      expect(body).not.toContain('instructure');
      expect(body).not.toContain('Open notes and open internet');
      expect(body).not.toContain(provider.key);
    }

    await page.hover(choice(101, 2));
    expect((await dotOf(page.locator(choice(101, 2)))).placement).toBe('native');
    await page.hover(choice(101, 1));
    expect((await dotOf(page.locator(choice(101, 1)))).placement).toBeNull();

    const key = await answerKey(QUIZ_URL);
    await expect(key.locator('.entry').nth(0)).toContainText('B. Canberra');
    await expect(key.locator('.entry').nth(0).locator(`a[href="${SEARCH_RESULT_URL}"]`)).toHaveCount(1);
    await expect(key.locator('.entry').nth(0).locator('.timing')).toContainText(provider.model);
  });
}

test('a rejected key shows a fixed message, never the service reply or the key', async () => {
  env.answers = [{ match: /./, correct: [], status: 401 }];
  await env.setAiSettings({ provider: 'openai', openai: { apiKey: 'sk-test-rejected-synthetic', model: 'gpt-6-astra' } });
  const page = await env.context.newPage();
  await page.goto(QUIZ_URL);
  await env.setEnabled(true);
  const key = await answerKey(QUIZ_URL);
  await expect(key.locator('.status.error')).toHaveCount(3);
  await expect(key.locator('.entry').nth(0)).toContainText('OpenAI API rejected the API key. Check it in Quieasy settings.');
  await expect(key.locator('body')).not.toContainText('sk-test-rejected-synthetic');
  await expect(key.locator('body')).not.toContainText('mock failure');
  const session = await env.worker.evaluate(() => chrome.storage.session.get(null));
  expect(JSON.stringify(session)).not.toContain('sk-test-rejected-synthetic');
  await expect(page.locator('[data-quieasy]')).toHaveCount(0);
});

test('a refusal from a Responses API service never shows a dot', async () => {
  env.answers = [{ match: /capital of Australia/, correct: ['Canberra'], refuse: true }];
  await env.setAiSettings({ provider: 'bedrock', bedrock: { apiKey: 'bedrock-api-key-synthetic', region: 'us-east-1', model: 'openai.gpt-5.6-sol' } });
  const page = await env.context.newPage();
  await page.goto(QUIZ_URL);
  await env.setEnabled(true);
  const key = await answerKey(QUIZ_URL);
  await expect(key.locator('.entry').nth(0)).toContainText('declined');
  await expect(page.locator('#question_101 [data-quieasy]')).toHaveCount(0);
});

test('settings refuse AWS access keys and incomplete Azure details, and save nothing', async () => {
  const settings = await openSettings();
  await settings.selectOption('#provider', 'bedrock');
  await expect(settings.locator('#provider-note')).toContainText('short-term Bedrock API key');
  await settings.fill('#api-key', 'AKIAIOSFODNN7EXAMPLE');
  await settings.click('button[type="submit"]');
  await expect(settings.locator('#form-error')).toContainText('AWS access key ID');

  await settings.selectOption('#provider', 'azure');
  await settings.fill('#azure-endpoint', 'https://evil.example/contoso.openai.azure.com');
  await settings.fill('#azure-deployment', 'quiz');
  await settings.fill('#api-key', 'azure-test-synthetic-key');
  await settings.click('button[type="submit"]');
  await expect(settings.locator('#form-error')).toContainText('resource endpoint');
  expect((await env.storedLocal()).ai).toBeUndefined();
});

test('the OpenAI option says it needs an API key, not a ChatGPT subscription', async () => {
  const settings = await openSettings();
  await settings.selectOption('#provider', 'openai');
  await expect(settings.locator('#provider-note')).toContainText('ChatGPT subscription');
  await expect(settings.locator('#api-key-label')).toHaveText('OpenAI API key');
  await expect(settings.locator('#key-link')).toHaveAttribute('href', 'https://platform.openai.com/api-keys');
});

test('removing a key stops all requests and the answer key says what to add', async () => {
  await env.setAiSettings({ provider: 'openai', openai: { apiKey: 'sk-test-openai-synthetic', model: 'gpt-6-astra' } });
  const settings = await openSettings();
  await expect(settings.locator('#provider')).toHaveValue('openai');
  await settings.click('#clear-key');
  await expect(settings.locator('#key-status')).toHaveText('No key saved.');
  expect(JSON.stringify((await env.storedLocal()).ai)).not.toContain('sk-test-openai-synthetic');

  const page = await env.context.newPage();
  await page.goto(QUIZ_URL);
  await env.setEnabled(true);
  await page.waitForTimeout(1000);
  expect(env.requests).toHaveLength(0);
  const key = await answerKey(QUIZ_URL);
  await expect(key.locator('.notice')).toContainText('Add your OpenAI API key in Quieasy settings.');
});
