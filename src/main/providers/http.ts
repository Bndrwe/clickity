// Shared HTTP helpers for the API providers: fetch with abort + friendly errors, SSE parsing.

export class AbortedError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'AbortError';
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortedError();
}

/** Combine an optional parent signal with a timeout. */
export function withTimeout(ms: number, parent?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return parent ? AbortSignal.any([parent, t]) : t;
}

const STATUS_TEXT: Record<number, string> = {
  400: 'bad request',
  401: 'invalid api key',
  402: 'out of credits',
  403: 'access denied',
  404: 'not found',
  408: 'request timed out',
  413: 'request too large',
  429: 'rate limited',
  500: 'server error',
  502: 'bad gateway',
  503: 'service unavailable',
  504: 'gateway timeout',
  529: 'overloaded',
};

export function shorten(s: string, max = 140): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

function extractApiMessage(body: string): string {
  try {
    const j: any = JSON.parse(body);
    const e = Array.isArray(j) ? j[0]?.error : j?.error;
    const m =
      (typeof e === 'string' ? e : undefined) ??
      e?.message ??
      j?.message ??
      j?.detail ??
      (typeof j?.error?.metadata?.raw === 'string' ? j.error.metadata.raw : undefined);
    return typeof m === 'string' ? m : '';
  } catch {
    return body.trim().startsWith('<') ? '' : body;
  }
}

/** Build "anthropic api: invalid api key (401)" style errors. */
export async function httpError(name: string, res: Response): Promise<Error> {
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  const apiMsg = shorten(extractApiMessage(body)).toLowerCase();
  const known = STATUS_TEXT[res.status];
  let text: string;
  if (res.status === 401 || res.status === 403 || res.status === 429) text = known!;
  else if (res.status === 404) text = apiMsg || 'not found (check the model id or base url)';
  else text = apiMsg || known || 'request failed';
  if ((res.status === 400 || res.status === 404) && apiMsg) text = apiMsg;
  return new Error(`${name}: ${text} (${res.status})`);
}

function networkError(name: string, url: string, err: unknown): Error {
  const e = err as any;
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
    if (e?.name === 'TimeoutError') return new Error(`${name}: timed out`);
    return new AbortedError();
  }
  const code: string = e?.cause?.code ?? e?.code ?? '';
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* ignore */
  }
  if (code === 'ECONNREFUSED') return new Error(`${name}: can't reach ${host} (connection refused)`);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new Error(`${name}: can't resolve ${host} (offline?)`);
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return new Error(`${name}: ${host} timed out`);
  return new Error(`${name}: network error${code ? ` (${code.toLowerCase()})` : ''}`);
}

/** fetch() that maps network failures and non-2xx statuses to short lowercase errors. */
export async function request(
  name: string,
  url: string,
  init: RequestInit & { signal?: AbortSignal },
): Promise<Response> {
  throwIfAborted(init.signal ?? undefined);
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (init.signal?.aborted && (init.signal.reason as any)?.name !== 'TimeoutError') throw new AbortedError();
    throw networkError(name, url, err);
  }
  if (!res.ok) throw await httpError(name, res);
  return res;
}

export async function getJson<T = any>(
  name: string,
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  const res = await request(name, url, { method: 'GET', headers, signal: withTimeout(10_000, signal) });
  return (await res.json()) as T;
}

export interface SseEvent {
  event: string;
  data: string;
}

/** Parse a text/event-stream body into events. Respects the signal. */
export async function* sse(res: Response, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event = '';
  let data: string[] = [];
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (signal?.aborted) throw new AbortedError();
        throw new Error('connection dropped while streaming');
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          if (data.length) yield { event: event || 'message', data: data.join('\n') };
          event = '';
          data = [];
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
    }
    throwIfAborted(signal);
    if (data.length) yield { event: event || 'message', data: data.join('\n') };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock?.();
  }
}

export function parseJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, '');
}
