import { chromium, type BrowserContext, type Locator, type Page, type Worker } from '@playwright/test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from 'selfsigned';

const ROOT = join(import.meta.dirname, '..', '..');
/** The built extension under test; QUIEASY_DIST points at another build, such as an older release. */
const DIST = process.env.QUIEASY_DIST ?? join(ROOT, 'dist');
const FIXTURES = join(ROOT, 'tests', 'fixtures');

/**
 * Test-only stand-ins for the AI services (api.anthropic.com, api.openai.com, an Azure OpenAI
 * resource and an Amazon Bedrock endpoint). They never run in the extension: Chromium is pointed at
 * them with --host-resolver-rules, so the unmodified production build is tested.
 */
export const AZURE_ENDPOINT = 'https://contoso.openai.azure.com';
export const BEDROCK_HOST = 'bedrock-mantle.us-east-1.api.aws';
const RESPONSES_HOSTS = ['api.openai.com', new URL(AZURE_ENDPOINT).host, BEDROCK_HOST];
const MOCK_HOSTS = ['*.instructure.com', '*.example.com', 'api.anthropic.com', ...RESPONSES_HOSTS];

export interface MockAnswer {
  match: RegExp;
  /** Correct choice texts; empty means the mock model is not sure. */
  correct: string[];
  confidence?: 'high' | 'medium' | 'low';
  delayMs?: number;
  status?: number;
  refuse?: boolean;
}

export interface CapturedRequest {
  host: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

export const SEARCH_RESULT_URL = 'https://en.wikipedia.org/wiki/Mock_search_result';
export const INVENTED_URL = 'https://invented.example/not-a-search-result';

export class TestEnv {
  readonly requests: CapturedRequest[] = [];
  readonly submissions: string[] = [];
  answers: MockAnswer[] = [];
  context!: BrowserContext;
  worker!: Worker;
  extensionId = '';
  private server!: Server;
  private tempDir = '';
  private control: Page | null = null;

  async start(): Promise<void> {
    this.tempDir = mkdtempSync(join(tmpdir(), 'quieasy-e2e-'));
    const pems = await generate([{ name: 'commonName', value: 'quieasy-test' }], {
      notAfterDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames: MOCK_HOSTS.map((host) => ({ type: 2, value: host })) }],
    });
    this.server = createServer({ key: pems.private, cert: pems.cert }, (req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const extension = prepareExtension(this.tempDir);
    this.context = await chromium.launchPersistentContext(join(this.tempDir, 'profile'), {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1000, height: 900 },
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        `--host-resolver-rules=${MOCK_HOSTS.map((host) => `MAP ${host} 127.0.0.1:${port}`).join(', ')}`,
        '--ignore-certificate-errors',
      ],
    });
    this.worker = this.context.serviceWorkers()[0] ?? (await this.context.waitForEvent('serviceworker'));
    this.extensionId = new URL(this.worker.url()).host;
  }

  async stop(): Promise<void> {
    await this.context?.close();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    if (this.tempDir) rmSync(this.tempDir, { recursive: true, force: true });
  }

  extensionUrl(path: string): string {
    return `chrome-extension://${this.extensionId}/${path}`;
  }

  /** Sends a message the way Quieasy's own popup does. */
  async ui(message: Record<string, unknown>): Promise<unknown> {
    if (!this.control || this.control.isClosed()) {
      this.control = await this.context.newPage();
      await this.control.goto(this.extensionUrl('options.html'));
    }
    return this.control.evaluate((m) => chrome.runtime.sendMessage(m), message);
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.ui({ type: 'setEnabled', enabled });
  }

  /**
   * Turns Quieasy on in one tab, the same call the On shortcut and the popup's On button make.
   * Chrome grants activeTab only for a real key press or toolbar click, which headless tests
   * cannot make; the test build's extra host permission stands in for that grant.
   */
  async turnOnInTab(page: Page): Promise<void> {
    const url = page.url();
    const tabId = await this.worker.evaluate(async (target) => {
      const [tab] = await chrome.tabs.query({ url: target });
      return tab?.id ?? -1;
    }, url);
    await this.ui({ type: 'setEnabled', enabled: true, tabId });
  }

  /** Selects Claude with this key, as saving it in Quieasy's settings does; null removes all AI settings. */
  async setApiKey(apiKey: string | null): Promise<void> {
    await this.setAiSettings(apiKey === null ? null : { provider: 'anthropic', anthropic: { apiKey, model: 'claude-opus-5-5' } });
  }

  async setAiSettings(settings: Record<string, unknown> | null): Promise<void> {
    await this.worker.evaluate(async (value) => {
      if (value === null) await chrome.storage.local.remove(['ai', 'apiKey', 'model']);
      else await chrome.storage.local.set({ ai: value });
    }, settings);
    await this.ui({ type: 'settingsChanged' });
  }

  async storedLocal(): Promise<Record<string, unknown>> {
    return this.worker.evaluate(() => chrome.storage.local.get(null));
  }

  /**
   * Reloads Quieasy the way the extensions page does (or an update does); tabs already open keep
   * the old content script, now cut off from the extension. `worker` then points at the new one.
   */
  async reloadExtension(): Promise<void> {
    const stale = this.worker;
    const closed = new Promise((resolve) => stale.once('close', resolve));
    // Registered before the reload: the new copy's service worker usually starts during it.
    const started = this.context.waitForEvent('serviceworker', (worker) => worker !== stale);
    // The extensions page's own Reload button; developer mode keeps the unpacked copy enabled.
    const extensions = await this.context.newPage();
    await extensions.goto('chrome://extensions');
    await extensions.evaluate(async (id) => {
      const developer = (chrome as unknown as { developerPrivate: DeveloperPrivate }).developerPrivate;
      await developer.updateProfileConfiguration({ inDeveloperMode: true });
      await developer.reload(id);
    }, this.extensionId);
    await closed;
    await extensions.close();
    this.control = null;
    // Otherwise it starts on its first event, such as opening a Quieasy page.
    if (!this.context.serviceWorkers().some((worker) => worker !== stale)) await this.ui({ type: 'answerKey', tabId: -1 });
    this.worker = await started;
  }

  /**
   * Stops Quieasy's service worker the way Chrome does when it has been idle, without reloading the
   * extension; the next message from a page or a Quieasy page starts a fresh one. `worker` keeps
   * working against the new instance.
   */
  async stopServiceWorker(): Promise<void> {
    const scriptUrl = this.extensionUrl('background.js');
    const page = await this.context.newPage();
    const cdp = await this.context.newCDPSession(page);
    const whenStatus = (runningStatus: string, versionId?: string) =>
      new Promise<string>((resolve) => {
        cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
          const version = versions.find(
            (candidate) => candidate.scriptURL === scriptUrl && candidate.runningStatus === runningStatus && (!versionId || candidate.versionId === versionId),
          );
          if (version) resolve(version.versionId);
        });
      });
    const running = whenStatus('running');
    await cdp.send('ServiceWorker.enable');
    const versionId = await running;
    const stopped = whenStatus('stopped', versionId);
    await cdp.send('ServiceWorker.stopWorker', { versionId });
    await stopped;
    await cdp.detach();
    await page.close();
  }

  async resetSession(): Promise<void> {
    await this.setEnabled(false);
    await this.worker.evaluate(() => chrome.storage.session.clear());
    this.requests.length = 0;
    this.submissions.length = 0;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = (req.headers.host ?? '').split(':')[0] ?? '';
    const body = await readBody(req);
    if (host === 'api.anthropic.com') return this.handleApi(req, res, body);
    if (RESPONSES_HOSTS.includes(host)) return this.handleResponsesApi(req, res, body);
    if (req.method === 'POST' && req.url === '/submit') {
      this.submissions.push(body);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>Submitted</h1>');
      return;
    }
    const routes: Record<string, string> = {
      'practice.example.com/biology/quiz-3': 'practice-quiz.html',
      'practice.example.com/biology/quiz-3/question-5': 'practice-quiz-frame.html',
      'practice.example.com/account/settings': 'account-settings.html',
      'trivia.example.com/games/abcd': 'trivia-game.html',
      'law.example.com/sample-questions': 'sample-questions.html',
      'lms.example.com/mod/quiz/attempt': 'lms-quiz.html',
      'notes.example.com/chapter-5': 'chapter-review.html',
      'school.instructure.com/courses/1/quizzes/2/take': 'classic-quiz.html',
      'school.instructure.com/courses/1/assignments/3': 'new-quizzes-host.html',
      'school.quiz-lti-iad-prod.instructure.com/lti/launch': 'new-quizzes-frame.html',
      'school.quiz-lti-iad-prod.instructure.com/lti/custom': 'new-quizzes-custom.html',
      'school.instructure.com/profile/communication': 'canvas-notifications.html',
    };
    const file = routes[`${host}${(req.url ?? '').split('?')[0]}`];
    if (!file) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(join(FIXTURES, file)));
  }

  /** Records a request and finds the mock answer for its prompt; null when it already replied with an error. */
  private async mockAnswer(req: IncomingMessage, res: ServerResponse, raw: string, prompt: (body: Record<string, unknown>) => string) {
    const body = JSON.parse(raw) as Record<string, unknown>;
    const [host = '', path = ''] = [(req.headers.host ?? '').split(':')[0], req.url];
    this.requests.push({ host, path, headers: req.headers, body });
    const text = prompt(body);
    const choices = [...text.matchAll(/^([A-Z])\. (.*)$/gm)].map((match) => ({ letter: match[1], text: match[2] }));
    const answer = this.answers.find((candidate) => candidate.match.test(text));
    if (answer?.delayMs) await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
    if (answer?.status) {
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `mock failure for ${String(req.headers['x-api-key'] ?? req.headers['api-key'] ?? req.headers.authorization)}` } }));
      return null;
    }
    const letters = (answer?.correct ?? [])
      .map((correct) => choices.find((choice) => choice.text === correct)?.letter)
      .filter(Boolean);
    return { body, answer, letters };
  }

  private async handleApi(req: IncomingMessage, res: ServerResponse, raw: string): Promise<void> {
    const mocked = await this.mockAnswer(req, res, raw, (body) => (body.messages as { content: string }[])[0]?.content ?? '');
    if (!mocked) return;
    const { body, answer, letters } = mocked;
    const content: unknown[] = [
      { type: 'server_tool_use', id: 'srvtoolu_mock', name: 'web_search', input: { query: 'mock query' } },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_mock',
        content: [
          { type: 'web_search_result', url: SEARCH_RESULT_URL, title: 'Mock search result', encrypted_content: 'x', page_age: null },
        ],
      },
    ];
    if (!answer?.refuse) {
      content.push({
        type: 'tool_use',
        id: 'toolu_mock',
        name: 'record_answer',
        input: {
          letters,
          confidence: answer ? (answer.confidence ?? 'high') : 'low',
          explanation: answer ? 'Mock explanation from the test server.' : 'Mock model is not sure.',
          source_urls: [SEARCH_RESULT_URL, INVENTED_URL],
        },
      });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content,
        stop_reason: answer?.refuse ? 'refusal' : 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 40, server_tool_use: { web_search_requests: 1 } },
      }),
    );
  }

  /** The OpenAI Responses API as OpenAI, Azure OpenAI and Amazon Bedrock serve it. */
  private async handleResponsesApi(req: IncomingMessage, res: ServerResponse, raw: string): Promise<void> {
    const mocked = await this.mockAnswer(req, res, raw, (body) => (body.input as { content: string }[])[0]?.content ?? '');
    if (!mocked) return;
    const { body, answer, letters } = mocked;
    const message = answer?.refuse
      ? { type: 'refusal', refusal: 'Mock refusal.' }
      : {
          type: 'output_text',
          text: JSON.stringify({
            letters,
            confidence: answer ? (answer.confidence ?? 'high') : 'low',
            explanation: answer ? 'Mock explanation from the test server.' : 'Mock model is not sure.',
            source_urls: [SEARCH_RESULT_URL, INVENTED_URL],
          }),
          annotations: [{ type: 'url_citation', url: SEARCH_RESULT_URL, title: 'Mock search result', start_index: 0, end_index: 1 }],
        };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'resp_mock',
        object: 'response',
        status: 'completed',
        model: body.model,
        output: [
          { type: 'web_search_call', id: 'ws_mock', status: 'completed', action: { type: 'search', query: 'mock query', sources: [{ type: 'url', url: SEARCH_RESULT_URL }] } },
          { type: 'message', id: 'msg_mock', status: 'completed', role: 'assistant', content: [message] },
        ],
      }),
    );
  }
}

/**
 * Copies the build and adds host access to the test-only *.example.com sites, standing in for the
 * temporary activeTab access Chrome grants on a real shortcut press, and to the mock OpenAI, Azure
 * and Bedrock endpoints, standing in for the user confirming Chrome's prompt when saving settings.
 * Nothing else changes, and Quieasy still runs on the test sites only when turned on in the tab:
 * there is no content script for them.
 */
function prepareExtension(tempDir: string): string {
  const target = join(tempDir, 'extension');
  cpSync(DIST, target, { recursive: true });
  const manifestPath = join(target, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { host_permissions: string[] };
  manifest.host_permissions.push('https://*.example.com/*', ...RESPONSES_HOSTS.map((host) => `https://${host}/*`));
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return target;
}

/** The part of the extensions page's private API that its Reload button uses. */
interface DeveloperPrivate {
  updateProfileConfiguration(update: { inDeveloperMode: boolean }): Promise<void>;
  reload(id: string): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

export const DOT_COLOR = 'rgba(55, 55, 55, 0.6)';

export interface DotState {
  /** Where a Quieasy dot is drawn for this choice right now, or null when none is visible. */
  placement: 'native' | 'adjacent' | null;
  /** The choice's own background, which Quieasy must never change. */
  background: string;
}

/**
 * Reads what the user currently sees on one choice: the 3px gray ::after dot on the element
 * Quieasy chose to draw it on (the choice itself, a control inside it, or a label's control).
 */
export async function dotOf(choice: Locator): Promise<DotState> {
  return choice.evaluate((element, color) => {
    const candidates = [element, ...Array.from(element.querySelectorAll('[data-quieasy-dot]'))];
    if (element instanceof HTMLLabelElement && element.control) candidates.push(element.control);
    let placement: DotState['placement'] = null;
    for (const candidate of candidates) {
      const dot = getComputedStyle(candidate, '::after');
      const drawn = dot.content !== 'none' && dot.width === '3px' && dot.height === '3px' && dot.backgroundColor === color;
      if (drawn) placement = candidate.getAttribute('data-quieasy-dot') as DotState['placement'];
    }
    return { placement, background: getComputedStyle(element).backgroundColor };
  }, DOT_COLOR);
}
