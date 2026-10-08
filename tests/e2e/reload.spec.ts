import { expect, test } from '@playwright/test';
import { dotOf, TestEnv } from './harness';

// Every answer here comes from the mock Claude API in harness.ts, not from Anthropic.
const PRACTICE_URL = 'https://practice.example.com/biology/quiz-3';

const env = new TestEnv();

test.beforeAll(async () => {
  await env.start();
});

test.afterAll(async () => {
  await env.stop();
});

/** Question counts the service worker holds for one tab, as the popup's answer key reads them. */
async function questionsRead(url: string): Promise<number> {
  return env.worker.evaluate(async (target) => {
    const [tab] = await chrome.tabs.query({ url: target });
    const stored = await chrome.storage.session.get(null);
    return Object.entries(stored)
      .filter(([key]) => key.startsWith(`f:${tab?.id}:`))
      .reduce((total, [, report]) => total + (report as { questions: unknown[] }).questions.length, 0);
  }, url);
}

test('turning Quieasy on works in a tab that was open before Quieasy was reloaded or updated', async () => {
  await env.setApiKey('sk-ant-test-key');
  env.answers = [{ match: /powerhouse of the cell/, correct: ['Mitochondria'] }];
  const page = await env.context.newPage();
  await page.goto(PRACTICE_URL);
  await env.turnOnInTab(page);
  await expect.poll(() => questionsRead(PRACTICE_URL)).toBeGreaterThan(0);
  await env.setEnabled(false);

  await env.reloadExtension();
  await env.turnOnInTab(page);
  await expect.poll(() => questionsRead(PRACTICE_URL)).toBe(5);
  await page.hover('#q1 label:nth-of-type(2)');
  await expect.poll(async () => (await dotOf(page.locator('#q1 label:nth-of-type(2)'))).placement).not.toBeNull();
});

test('an Anthropic key saved by an earlier version keeps working after an update', async () => {
  await env.worker.evaluate(async () => {
    await chrome.storage.local.remove('ai');
    await chrome.storage.local.set({ apiKey: 'sk-ant-legacy-synthetic', model: 'claude-sonnet-5-5' });
  });
  await env.reloadExtension();
  await expect
    .poll(() => env.storedLocal())
    .toEqual({ ai: expect.objectContaining({ provider: 'anthropic', anthropic: { apiKey: 'sk-ant-legacy-synthetic', model: 'claude-sonnet-5-5' } }) });

  env.requests.length = 0;
  env.answers = [{ match: /powerhouse of the cell/, correct: ['Mitochondria'] }];
  const page = await env.context.newPage();
  await page.goto(PRACTICE_URL);
  await env.turnOnInTab(page);
  await expect.poll(() => env.requests.length).toBeGreaterThan(0);
  expect(env.requests[0]?.headers['x-api-key']).toBe('sk-ant-legacy-synthetic');
  expect(env.requests[0]?.body.model).toBe('claude-sonnet-5-5');
});
