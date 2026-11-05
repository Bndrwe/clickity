// Fetch a web page the user mentioned and turn it into readable text for the model.
// http/https only; every hop (redirects included) is resolved and refused when it points at a
// loopback / private / link-local address; 10 s and 2 MB caps.
import dns from 'node:dns/promises';
import net from 'node:net';
import { extractUrls, htmlToText, isLocalHostname, isPrivateAddress, wrapPage } from './web-text';
import { log } from './log';

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const PAGE_CHARS = 30_000;

/** Tests serve pages from 127.0.0.1: allowed only with CLICKITY_TEST=1 + this flag. */
const allowLocal = (): boolean => process.env.CLICKITY_TEST === '1' && process.env.CLICKITY_TEST_LOCAL_URLS === '1';

async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http and https links can be read');
  if (url.username || url.password) throw new Error('links with passwords are not read');
  if (allowLocal()) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('that link points at a private address');
    return;
  }
  if (isLocalHostname(host)) throw new Error('that link points at a local name');
  const addrs = await dns.lookup(host, { all: true, verbatim: true });
  if (!addrs.length) throw new Error(`couldn't find ${host}`);
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error('that link points at a private address');
}

async function readCapped(res: Response, signal: AbortSignal): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    if (signal.aborted) throw new Error('timed out');
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      chunks.push(value.subarray(0, value.byteLength - (total - MAX_BYTES)));
      void reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks);
  const charset = /charset=([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1];
  try {
    return new TextDecoder(charset || 'utf-8').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
}

export async function fetchPage(raw: string, outer?: AbortSignal): Promise<FetchedPage> {
  const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(outer ? [outer] : [])]);
  let url = new URL(raw);
  for (let hop = 0; ; hop++) {
    await assertPublic(url);
    const res = await fetch(url, {
      redirect: 'manual',
      signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Clickity/1.0; +https://github.com/Bndrwe/clickity)', accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
      url = new URL(res.headers.get('location')!, url);
      void res.body?.cancel().catch(() => undefined);
      continue;
    }
    if (!res.ok) throw new Error(`the page answered ${res.status}`);
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (type && !/text\/|html|xml|json/.test(type)) throw new Error(`not a web page (${type.split(';')[0]})`);
    const body = await readCapped(res, signal);
    if (/html|xml/.test(type) || /^\s*<(!doctype|html)/i.test(body)) {
      const { title, text } = htmlToText(body, PAGE_CHARS);
      return { url: url.href, title, text };
    }
    return { url: url.href, title: '', text: body.length > PAGE_CHARS ? `${body.slice(0, PAGE_CHARS)}\n… (truncated)` : body };
  }
}

/**
 * Pages for the links in a user message, wrapped as untrusted context for the model text.
 * Failures become a one-line note so the model can say it couldn't open the link.
 */
export async function pagesForMessage(text: string, signal?: AbortSignal): Promise<string[]> {
  const urls = extractUrls(text);
  if (!urls.length) return [];
  return Promise.all(
    urls.map(async (u) => {
      const t0 = Date.now();
      try {
        const page = await fetchPage(u, signal);
        log('web', `read ${u}: ${page.text.length} chars in ${Date.now() - t0}ms`);
        return wrapPage(page.url, page.title, page.text || '(the page had no readable text)');
      } catch (err) {
        const msg = err instanceof Error ? err.message.split('\n')[0].toLowerCase() : String(err);
        log('web', `couldn't read ${u}: ${msg}`);
        return `web page: ${u}\n(couldn't open it: ${msg})`;
      }
    }),
  );
}
