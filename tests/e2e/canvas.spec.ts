import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dotOf, INVENTED_URL, SEARCH_RESULT_URL, TestEnv, type DotState } from './harness';

const QUIZ_URL = 'https://school.instructure.com/courses/1/quizzes/2/take';
const NEW_QUIZZES_URL = 'https://school.instructure.com/courses/1/assignments/3';
const NOTIFICATIONS_URL = 'https://school.instructure.com/profile/communication';
const CUSTOM_CHOICES_URL = 'https://school.quiz-lti-iad-prod.instructure.com/lti/custom';
const choice = (question: number, index: number): string =>
  `#question_${question} .answer:nth-of-type(${index})`;
const EVIDENCE_DIR = process.env.QUIEASY_EVIDENCE_DIR;

const env = new TestEnv();

async function evidence(page: Page, name: string, clip?: Locator): Promise<void> {
  if (!EVIDENCE_DIR) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const path = join(EVIDENCE_DIR, `${name}.png`);
  if (clip) await clip.screenshot({ path });
  else await page.screenshot({ path });
}

/** The dot placement the user sees on a choice right now; null means nothing is shown. */
async function dot(page: Page, selector: string): Promise<DotState['placement']> {
  return (await dotOf(page.locator(selector))).placement;
}

/** Quieasy adds no label, badge or logo of its own to the page, in any state. */
async function expectNoInjectedUi(page: Page): Promise<void> {
  expect(await page.evaluate(() => Array.from(document.documentElement.children, (element) => element.tagName))).toEqual(['HEAD', 'BODY']);
  // Only the two marker attributes may appear; no element, id, class or shadow root of Quieasy's own.
  const foreign = await page.evaluate(() =>
    Array.from(document.querySelectorAll('*')).filter(
      (element) =>
        element.shadowRoot !== null ||
        /quieasy/i.test(`${element.tagName} ${element.id} ${element.getAttribute('class') ?? ''}`) ||
        element.getAttributeNames().some((name) => name.startsWith('data-quieasy') && name !== 'data-quieasy' && name !== 'data-quieasy-dot'),
    ).length,
  );
  expect(foreign).toBe(0);
}

async function openQuiz(url = QUIZ_URL): Promise<Page> {
  const page = await env.context.newPage();
  await page.goto(url);
  return page;
}

async function tabIdOf(url: string): Promise<number> {
  return env.worker.evaluate(async (target) => {
    const [tab] = await chrome.tabs.query({ url: target });
    return tab?.id ?? -1;
  }, url);
}

function requestsMatching(pattern: RegExp): number {
  return env.requests.filter((request) => pattern.test(JSON.stringify(request.body.messages))).length;
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
  await env.setApiKey('sk-ant-test-key');
  env.answers = [
    { match: /capital of Australia/, correct: ['Canberra'] },
    { match: /prime numbers/, correct: ['2', '11'] },
    { match: /largest in our solar system/, correct: ['Jupiter'] },
    { match: /chemical symbol for gold/, correct: ['Au'] },
  ];
});

test('is off by default: nothing is read, sent or marked', async () => {
  const page = await openQuiz();
  await page.waitForTimeout(1000);
  await page.hover(choice(101, 2));
  expect(await dot(page, choice(101, 2))).toBeNull();
  expect(env.requests).toHaveLength(0);
  await expect(page.locator('[data-quieasy]')).toHaveCount(0);
  await expectNoInjectedUi(page);
  expect(await env.worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('');
});

test('shows a faint dot only while the user hovers the correct choice', async () => {
  const page = await openQuiz();
  const backgroundOff = (await dotOf(page.locator(choice(101, 2)))).background;
  await env.setEnabled(true);
  await expect(page.locator('#question_101 [data-quieasy="correct"]')).toHaveCount(1);
  await expect(page.locator('#question_102 [data-quieasy="correct"]')).toHaveCount(2);
  await expect.poll(() => env.requests.length).toBe(3);
  await expectNoInjectedUi(page);
  expect(await env.worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('ON');

  await page.mouse.move(5, 5);
  expect(await dot(page, choice(101, 2))).toBeNull();
  await page.hover(choice(101, 1));
  expect(await dot(page, choice(101, 1))).toBeNull();
  await page.hover(choice(101, 2));
  expect(await dotOf(page.locator(choice(101, 2)))).toEqual({ placement: 'native', background: backgroundOff });
  await evidence(page, 'dot-1-native-on-hover', page.locator('#question_101'));
  await page.mouse.move(5, 5);
  expect(await dot(page, choice(101, 2))).toBeNull();
  await evidence(page, 'dot-2-native-gone-on-leave', page.locator('#question_101'));
  await page.hover(choice(102, 3));
  expect(await dot(page, choice(102, 3))).toBe('native');
  await page.hover(choice(102, 2));
  expect(await dot(page, choice(102, 2))).toBeNull();

  // The mock model is not sure about question 3, so nothing there may show a dot.
  await expect(page.locator('#question_103 [data-quieasy]')).toHaveCount(0);
  for (const index of [1, 2]) {
    await page.hover(choice(103, index));
    expect(await dot(page, choice(103, index))).toBeNull();
  }
});

test('sends only the question and choices, with the API key only to Anthropic', async () => {
  const page = await openQuiz();
  await env.setEnabled(true);
  await expect.poll(() => env.requests.length).toBe(3);
  for (const request of env.requests) {
    const body = JSON.stringify(request.body);
    expect(request.headers.cookie).toBeUndefined();
    expect(request.headers['x-api-key']).toBe('sk-ant-test-key');
    expect(body).not.toContain('instructure');
    expect(body).not.toContain('Open notes and open internet');
    expect(body).not.toContain('Week 3 Check-in');
    expect(Object.keys(request.body).sort()).toEqual(
      ['fallbacks', 'max_tokens', 'messages', 'model', 'output_config', 'system', 'tool_choice', 'tools'].sort(),
    );
    const tools = request.body.tools as { name: string; type?: string }[];
    expect(tools.find((tool) => tool.name === 'web_search')?.type).toBe('web_search_20250305');
  }
  await page.close();
});

test('answer key lists answers with explanations and only real search sources', async () => {
  const page = await openQuiz();
  await env.setEnabled(true);
  await expect(page.locator('[data-quieasy="correct"]')).toHaveCount(3);
  await expect.poll(() => env.requests.length).toBe(3);
  const tabId = await tabIdOf(QUIZ_URL);
  const key = await env.context.newPage();
  await key.goto(env.extensionUrl(`popup.html?tabId=${tabId}`));
  const entries = key.locator('.entry');
  await expect(entries).toHaveCount(3);
  await expect(entries.nth(0)).toContainText('B. Canberra');
  await expect(entries.nth(0)).toContainText('Mock explanation from the test server.');
  await expect(entries.nth(1)).toContainText('A. 2');
  await expect(entries.nth(1)).toContainText('C. 11');
  await expect(entries.nth(2)).toContainText('not sure');
  await expect(entries.nth(0).locator(`a[href="${SEARCH_RESULT_URL}"]`)).toHaveCount(1);
  await expect(key.locator(`a[href="${INVENTED_URL}"]`)).toHaveCount(0);
  await expect(entries.nth(0).locator('.timing')).toContainText('web search + AI');
  await expect(key.locator('body')).toContainText('AI answers can be wrong');
  await evidence(key, '02-answer-key');
});

test('answer key follows shuffled choices when a cached answer is reused', async () => {
  const page = await openQuiz();
  await env.setEnabled(true);
  await expect(page.locator(`${choice(101, 2)}[data-quieasy="correct"]`)).toHaveCount(1);
  await expect.poll(() => env.requests.length).toBe(3);
  await page.evaluate(() => {
    const labels = document.querySelectorAll('#question_101 .answer_label');
    ['Melbourne', 'Sydney', 'Canberra'].forEach((text, index) => {
      labels[index]!.textContent = text;
    });
  });
  await expect(page.locator(`${choice(101, 3)}[data-quieasy="correct"]`)).toHaveCount(1);
  await page.hover(choice(101, 3));
  expect(await dot(page, choice(101, 3))).toBe('native');
  await page.hover(choice(101, 2));
  expect(await dot(page, choice(101, 2))).toBeNull();
  expect(env.requests).toHaveLength(3);
  const tabId = await tabIdOf(QUIZ_URL);
  const key = await env.context.newPage();
  await key.goto(env.extensionUrl(`popup.html?tabId=${tabId}`));
  const first = key.locator('.entry').nth(0);
  await expect(first).toContainText('C. Canberra');
  await expect(first).not.toContainText('B. Sydney');
});

test('selection, focus, layout and submission are unchanged', async () => {
  const fill = async (page: Page): Promise<void> => {
    await page.click(choice(101, 2));
    await page.click(choice(102, 1));
    await page.click(choice(102, 3));
  };
  const submit = async (page: Page): Promise<string> => {
    await Promise.all([page.waitForURL(/\/submit$/), page.click('#submit_quiz_button')]);
    return env.submissions.at(-1) ?? '';
  };
  const rects = (page: Page): Promise<string> =>
    page.$$eval('.display_question, .answer', (elements) =>
      JSON.stringify(elements.map((element) => element.getBoundingClientRect().toJSON())),
    );

  const off = await openQuiz();
  const layoutOff = await rects(off);
  await fill(off);
  const submittedOff = await submit(off);

  const on = await openQuiz();
  await on.focus('#question_101_answer_1011');
  await env.setEnabled(true);
  await expect(on.locator('[data-quieasy="correct"]')).toHaveCount(3);
  expect(await on.evaluate(() => document.activeElement?.id)).toBe('question_101_answer_1011');
  expect(await on.$$eval('input:checked', (inputs) => inputs.length)).toBe(0);
  await on.hover(choice(101, 2));
  expect(await rects(on)).toBe(layoutOff);
  await fill(on);
  expect(await on.$$eval('input:checked', (inputs) => inputs.map((input) => input.id))).toEqual([
    'question_101_answer_1012',
    'question_102_answer_1021',
    'question_102_answer_1023',
  ]);
  const submittedOn = await submit(on);
  expect(submittedOn).toBe(submittedOff);
  expect(submittedOn).toContain('question_101=1012');
});

test('turning off removes marks at once and discards answers still in flight', async () => {
  env.answers[0] = { match: /capital of Australia/, correct: ['Canberra'], delayMs: 2500 };
  const page = await openQuiz();
  await env.setEnabled(true);
  await expect(page.locator('#question_102 [data-quieasy="correct"]')).toHaveCount(2);
  await expect(page.locator('#question_101 [data-quieasy]')).toHaveCount(0);
  await expectNoInjectedUi(page);
  await env.setEnabled(false);
  await expect(page.locator('[data-quieasy]')).toHaveCount(0, { timeout: 500 });
  await page.waitForTimeout(3500);
  await expect(page.locator('[data-quieasy]')).toHaveCount(0);
  await page.hover(choice(102, 1));
  expect(await dot(page, choice(102, 1))).toBeNull();
  const storedCapital = await env.worker.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    return Object.values(all).some((value) => JSON.stringify(value).includes('canberra'));
  });
  expect(storedCapital).toBe(false);

  // Turning back on reuses the cached prime-number answer instead of asking again.
  const primeRequests = requestsMatching(/prime numbers/);
  env.answers[0] = { match: /capital of Australia/, correct: ['Canberra'] };
  await env.setEnabled(true);
  await expect(page.locator('[data-quieasy="correct"]')).toHaveCount(3);
  expect(requestsMatching(/prime numbers/)).toBe(primeRequests);
});

test('a question changed in place never shows the previous answer', async () => {
  env.answers[3] = { match: /chemical symbol for gold/, correct: ['Au'], delayMs: 1500 };
  const page = await openQuiz();
  await env.setEnabled(true);
  await expect(page.locator(`${choice(101, 2)}[data-quieasy="correct"]`)).toHaveCount(1);
  await page.evaluate(() =>
    (window as unknown as { replaceFirstQuestion: (s: string, c: string[]) => void }).replaceFirstQuestion(
      'What is the chemical symbol for gold?',
      ['Au', 'Ag', 'Fe'],
    ),
  );
  await expect(page.locator('#question_101 [data-quieasy]')).toHaveCount(0, { timeout: 100 });
  await page.hover(choice(101, 2));
  expect(await dot(page, choice(101, 2))).toBeNull();
  await expect(page.locator(`${choice(101, 1)}[data-quieasy="correct"]`)).toHaveCount(1, { timeout: 5000 });
  await page.hover(choice(101, 1));
  expect(await dot(page, choice(101, 1))).toBe('native');
});

test('reloading or navigating reuses cached answers without new requests', async () => {
  const page = await openQuiz();
  await env.setEnabled(true);
  await expect(page.locator('[data-quieasy="correct"]')).toHaveCount(3);
  await expect.poll(() => env.requests.length).toBe(3);
  await page.reload();
  await expect(page.locator('[data-quieasy="correct"]')).toHaveCount(3);
  await page.waitForTimeout(500);
  expect(env.requests).toHaveLength(3);
});

test('failed and refused requests never show a dot', async () => {
  env.answers[0] = { match: /capital of Australia/, correct: ['Canberra'], status: 500 };
  env.answers[1] = { match: /prime numbers/, correct: ['2', '11'], refuse: true };
  const page = await openQuiz();
  await env.setEnabled(true);
  const tabId = await tabIdOf(QUIZ_URL);
  const key = await env.context.newPage();
  await key.goto(env.extensionUrl(`popup.html?tabId=${tabId}`));
  await expect(key.locator('.status.error')).toHaveCount(2, { timeout: 15_000 });
  await expect(key.locator('.entry').nth(0)).toContainText('HTTP 500');
  await expect(key.locator('.entry').nth(1)).toContainText('declined');
  await expectNoInjectedUi(page);
  await expect(page.locator('[data-quieasy]')).toHaveCount(0);
  for (const index of [1, 2, 3]) {
    await page.hover(choice(101, index));
    expect(await dot(page, choice(101, index))).toBeNull();
  }
});

test('without an API key nothing is sent and the status says so', async () => {
  await env.setApiKey(null);
  const page = await openQuiz();
  await env.setEnabled(true);
  await page.waitForTimeout(1000);
  expect(env.requests).toHaveLength(0);
  await expect(page.locator('[data-quieasy]')).toHaveCount(0);
  await expectNoInjectedUi(page);
  const tabId = await tabIdOf(QUIZ_URL);
  const key = await env.context.newPage();
  await key.goto(env.extensionUrl(`popup.html?tabId=${tabId}`));
  await expect(key.locator('.notice')).toContainText('Add your Anthropic API key');
});

test('marks answers inside a New Quizzes style frame', async () => {
  const page = await openQuiz(NEW_QUIZZES_URL);
  const frame = page.frameLocator('#quiz-frame');
  await expect(frame.locator('label[for="c1"]')).toBeVisible();
  await env.setEnabled(true);
  await expect(frame.locator('[data-quieasy="correct"]')).toHaveCount(1);
  await frame.locator('label[for="c2"]').hover();
  expect((await dotOf(frame.locator('[data-quieasy="correct"]'))).placement).toBe('native');
  await expect(frame.locator('[data-quieasy="correct"]')).toContainText('Jupiter');
  await frame.locator('label[for="c1"]').hover();
  expect((await dotOf(frame.locator('[data-quieasy="correct"]'))).placement).toBeNull();
});

test('the native dot is a centered 3px point inside the radio or checkbox and checks nothing', async () => {
  const page = await openQuiz();
  await env.setEnabled(true);
  await expect(page.locator('[data-quieasy="correct"]')).toHaveCount(3);
  await expect(page.locator('[data-quieasy-dot]')).toHaveCount(3);
  for (const target of [choice(101, 2), choice(102, 1), choice(102, 3)]) {
    await page.hover(target);
    const geometry = await page.locator(`${target} [data-quieasy-dot]`).evaluate((input) => {
      const box = input.getBoundingClientRect();
      const dotStyle = getComputedStyle(input, '::after');
      return {
        dot: input.getAttribute('data-quieasy-dot'),
        position: dotStyle.position,
        // The ::after box is centered on the control: 50%/50% offsets, pulled back by half its size.
        offsets: [dotStyle.left, dotStyle.top].map((value) => Math.round(parseFloat(value))),
        expected: [box.width / 2, box.height / 2].map(Math.round),
        transform: dotStyle.transform,
        pointerEvents: dotStyle.pointerEvents,
      };
    });
    expect(geometry).toEqual({
      dot: 'native',
      position: 'absolute',
      offsets: geometry.expected,
      expected: geometry.expected,
      transform: 'matrix(1, 0, 0, 1, -1.5, -1.5)',
      pointerEvents: 'none',
    });
  }
  expect(await page.$$eval('input:checked', (inputs) => inputs.length)).toBe(0);
  await page.hover(choice(102, 1));
  await evidence(page, 'dot-3-native-checkbox-on-hover', page.locator('#question_102'));

  // A choice the user already checked keeps its own look; the dot sits on top only while hovered.
  await page.click(choice(101, 2));
  expect(await dot(page, choice(101, 2))).toBe('native');
  expect(await page.$$eval('input:checked', (inputs) => inputs.map((input) => input.id))).toEqual(['question_101_answer_1012']);
  await env.setEnabled(false);
  await expect(page.locator('[data-quieasy], [data-quieasy-dot]')).toHaveCount(0);
  expect(await dot(page, choice(101, 2))).toBeNull();
  await evidence(page, 'dot-4-off-none-while-hovered', page.locator('#question_101'));
});

test('custom choices without a visible native control get a faint dot just after the choice', async () => {
  env.answers.push({ match: /largest in our solar system/, correct: ['Jupiter'] });
  const page = await openQuiz(CUSTOM_CHOICES_URL);
  const aria = (index: number): string => `#aria-question [role="radio"]:nth-child(${index})`;
  const hidden = (index: number): string => `#hidden-input-question label:nth-of-type(${index})`;
  const backgroundOff = (await dotOf(page.locator(aria(2)))).background;
  await env.setEnabled(true);
  await expect(page.locator('[data-quieasy="correct"]')).toHaveCount(2);
  await expect(page.locator('[data-quieasy-dot]')).toHaveCount(2);

  await page.mouse.move(5, 5);
  expect(await dot(page, aria(2))).toBeNull();
  await page.hover(aria(1));
  expect(await dot(page, aria(1))).toBeNull();
  await page.hover(aria(2));
  expect(await dotOf(page.locator(aria(2)))).toEqual({ placement: 'adjacent', background: backgroundOff });
  await evidence(page, 'dot-5-custom-aria-on-hover', page.locator('#aria-question'));
  // The page's own ::before circle is untouched.
  expect(await page.locator(aria(2)).evaluate((element) => getComputedStyle(element, '::before').borderTopWidth)).toBe('2px');
  await page.mouse.move(5, 5);
  expect(await dot(page, aria(2))).toBeNull();

  // Native inputs hidden off screen cannot show a dot inside them, so it goes after the label text.
  await page.hover(hidden(2));
  expect(await dot(page, hidden(2))).toBe('adjacent');
  await evidence(page, 'dot-6-custom-hidden-input-on-hover', page.locator('#hidden-input-question'));
  await page.hover(hidden(1));
  expect(await dot(page, hidden(1))).toBeNull();

  expect(await page.$$eval('[aria-checked="true"], input:checked', (elements) => elements.length)).toBe(0);
  await expectNoInjectedUi(page);
  await env.setEnabled(false);
  await page.hover(aria(2));
  expect(await dot(page, aria(2))).toBeNull();
});

test('reads and sends nothing from a non-quiz Canvas page while on', async () => {
  const page = await openQuiz(NOTIFICATIONS_URL);
  await env.setEnabled(true);
  await page.waitForTimeout(1000);
  expect(env.requests).toHaveLength(0);
  await expect(page.locator('[data-quieasy]')).toHaveCount(0);
  await page.hover('label[for="announcements-daily"]');
  expect(await dot(page, 'label[for="announcements-daily"]')).toBeNull();
  const tabId = await tabIdOf(NOTIFICATIONS_URL);
  const key = await env.context.newPage();
  await key.goto(env.extensionUrl(`popup.html?tabId=${tabId}`));
  await expect(key.locator('.entry')).toHaveCount(0);
});

test('declares separate on and off keyboard shortcuts', async () => {
  const commands = await env.worker.evaluate(() => chrome.commands.getAll());
  const shortcut = (name: string): string => commands.find((command) => command.name === name)?.shortcut ?? '';
  expect(shortcut('enable')).not.toBe('');
  expect(shortcut('disable')).not.toBe('');
  expect(shortcut('enable')).not.toBe(shortcut('disable'));
});

// Last on purpose: the reload leaves env.worker stale for any later test.
test('after Quieasy is reloaded, an open quiz tab drops its dots and throws nothing', async () => {
  const page = await env.context.newPage();
  const exceptions: string[] = [];
  const cdp = await env.context.newCDPSession(page);
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) =>
    exceptions.push(exceptionDetails.exception?.description ?? exceptionDetails.text),
  );
  await cdp.send('Runtime.enable');
  await page.goto(QUIZ_URL);
  await env.setEnabled(true);
  await expect(page.locator('[data-quieasy="correct"]')).toHaveCount(3);
  await page.hover(choice(101, 2));
  expect(await dot(page, choice(101, 2))).toBe('native');
  await evidence(page, 'reload-1-dot-before-reload', page.locator('#question_101'));

  await env.reloadExtension();
  await page.evaluate(() =>
    (window as unknown as { replaceFirstQuestion: (s: string, c: string[]) => void }).replaceFirstQuestion(
      'What is the chemical symbol for gold?',
      ['Au', 'Ag', 'Fe'],
    ),
  );
  // Long enough for the old copy's debounced rescan to run on the still-open page.
  await page.waitForTimeout(1000);
  await expect(page.locator('[data-quieasy], [data-quieasy-dot]')).toHaveCount(0);
  await page.hover(choice(102, 1));
  expect(await dot(page, choice(102, 1))).toBeNull();
  await evidence(page, 'reload-2-no-dot-after-reload', page.locator('#question_102'));

  await page.goto(NOTIFICATIONS_URL);
  await page.waitForTimeout(300);
  expect(exceptions).toEqual([]);
});
