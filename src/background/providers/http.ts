import { asRecord } from './parse';

/**
 * Service error codes Quieasy explains. Amazon Bedrock answers a valid key on an account that
 * may not use the model with HTTP 401 and `access_denied`; a bad key gets `invalid_api_key`.
 */
export type ProviderErrorCode = 'access_denied';

/** Why a request to the AI service failed. Holds no response text, so it can never echo a key. */
export class ProviderError extends Error {
  constructor(
    readonly kind: 'http' | 'network' | 'timeout' | 'invalid-response',
    readonly status: number | null = null,
    readonly code: ProviderErrorCode | null = null,
  ) {
    super(kind === 'http' ? `HTTP ${status}` : kind);
    this.name = 'ProviderError';
  }
}

export interface PostOptions {
  signal: AbortSignal;
  timeoutMs: number;
  /** Overrides the HTTP client; used by tests. */
  fetch?: typeof fetch;
}

const RETRY_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const MAX_RETRY_WAIT_MS = 10_000;

/**
 * POSTs a JSON body and returns the parsed JSON reply. Retries once after a rate limit, overload
 * or dropped connection. Rejects with the abort reason when the caller aborts, and otherwise only
 * with a ProviderError.
 */
export async function postJson(url: string, headers: Record<string, string>, body: unknown, options: PostOptions): Promise<unknown> {
  const send = options.fetch ?? fetch;
  for (let attempt = 0; ; attempt += 1) {
    const timeout = AbortSignal.timeout(options.timeoutMs);
    let response: Response;
    try {
      response = await send(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.any([options.signal, timeout]),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
    } catch {
      options.signal.throwIfAborted();
      if (timeout.aborted) throw new ProviderError('timeout');
      if (attempt === 0) {
        await wait(1000, options.signal);
        continue;
      }
      throw new ProviderError('network');
    }
    if (!response.ok) {
      if (attempt === 0 && RETRY_STATUSES.has(response.status)) {
        await wait(retryDelay(response.headers.get('retry-after')), options.signal);
        continue;
      }
      throw new ProviderError('http', response.status, await errorCode(response, options.signal));
    }
    try {
      return await response.json();
    } catch {
      options.signal.throwIfAborted();
      if (timeout.aborted) throw new ProviderError('timeout');
      throw new ProviderError('invalid-response');
    }
  }
}

/** The reply's `error.code` when it is one Quieasy explains, else null. Keeps nothing else from the reply. */
async function errorCode(response: Response, signal: AbortSignal): Promise<ProviderErrorCode | null> {
  try {
    const code = asRecord(asRecord(await response.json()).error).code;
    return code === 'access_denied' ? code : null;
  } catch {
    signal.throwIfAborted();
    return null;
  }
}

/** Waits as long as the service asks (retry-after, in seconds), within limits; one second otherwise. */
function retryDelay(retryAfter: string | null): number {
  const seconds = retryAfter === null || retryAfter.trim() === '' ? NaN : Number(retryAfter);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_RETRY_WAIT_MS) : 1000;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}
