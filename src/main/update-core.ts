// In-app updater, the parts that don't need electron: version compare, release parsing, asset choice,
// streaming download and the linux AppImage swap. Pure node (type imports only from shared) so it can be
// unit tested with `node --experimental-strip-types --test`; updater.ts wires it into the app.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const DEFAULT_API = 'https://api.github.com/repos/Bndrwe/clickity';
export const USER_AGENT = 'clickity-updater';

export interface ReleaseAsset {
  name: string;
  size: number;
  url: string; // browser_download_url
}

export interface ReleaseInfo {
  /** "1.0.42" (tag_name without the leading v) */
  version: string;
  tag: string;
  notes: string;
  assets: ReleaseAsset[];
  /** the release page, for "open on github" fallbacks */
  page?: string;
}

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

/* ───────────── versions ───────────── */

/** "v1.2.3-beta.1" → [1, 2, 3]; null when there's no leading number. Pre-release tails are ignored. */
export function parseVersion(v: string): number[] | null {
  const m = /^\s*v?(\d+(?:\.\d+)*)/i.exec(String(v ?? ''));
  if (!m) return null;
  return m[1]!.split('.').map((n) => parseInt(n, 10));
}

/** Numeric compare: 1 when a > b, -1 when a < b, 0 when equal (missing parts count as 0). Unparsable sorts lowest. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function isNewer(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}

/* ───────────── assets ───────────── */

/**
 * The asset this machine installs from. mac: the .zip for this arch (the .app inside replaces ours);
 * windows: the NSIS .exe; linux: the .AppImage when running as one, else the .deb.
 */
export function pickAsset(
  assets: ReleaseAsset[],
  platform: NodeJS.Platform | string,
  arch: string,
  appImage?: string | null,
): ReleaseAsset | null {
  const find = (re: RegExp) => assets.find((a) => re.test(a.name)) ?? null;
  if (platform === 'darwin') {
    if (arch !== 'arm64' && arch !== 'x64') return null;
    return find(new RegExp(`-mac-${arch}\\.zip$`, 'i'));
  }
  if (platform === 'win32') {
    if (arch !== 'x64') return null;
    return find(/-win-x64\.exe$/i) ?? find(/\.exe$/i);
  }
  if (platform === 'linux') {
    if (arch !== 'x64') return null;
    return appImage ? find(/x86_64\.AppImage$/i) : find(/amd64\.deb$/i);
  }
  return null;
}

/* ───────────── release json ───────────── */

/** Release notes from the body: the part before the install instructions (`<!-- install -->`), as plain lines. */
export function notesFromBody(body: unknown): string {
  if (typeof body !== 'string') return '';
  const cut = body.split(/<!--\s*install\s*-->|^download the installer/im)[0] ?? '';
  return cut
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .filter((l) => l && !/^changes:?$/i.test(l))
    .slice(0, 12)
    .join('\n');
}

/** GitHub's /releases/latest json → ReleaseInfo. Throws a short message when it isn't usable. */
export function parseRelease(json: any): ReleaseInfo {
  const tag = typeof json?.tag_name === 'string' ? json.tag_name : '';
  const version = tag.replace(/^v/i, '');
  if (!parseVersion(version)) throw new Error(`latest release has no version (${tag || 'no tag'})`);
  const assets: ReleaseAsset[] = Array.isArray(json?.assets)
    ? json.assets
        .filter((a: any) => a && typeof a.name === 'string' && typeof a.browser_download_url === 'string')
        .map((a: any) => ({ name: a.name, size: Number(a.size) || 0, url: a.browser_download_url }))
    : [];
  return { version, tag, notes: notesFromBody(json?.body), assets, page: typeof json?.html_url === 'string' ? json.html_url : undefined };
}

/* ───────────── network ───────────── */

function isOffline(err: unknown): boolean {
  const e = err as { cause?: { code?: string }; code?: string; message?: string };
  const code = e?.cause?.code ?? e?.code ?? '';
  return /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK|ERR_CONNECTION|fetch failed|bad port/i.test(
    `${code} ${e?.message ?? ''}`,
  );
}

/** Short lowercase message for anything that went wrong talking to github. */
export function networkError(err: unknown): Error {
  if (err instanceof Error && (err as any).short) return err;
  if ((err as Error)?.name === 'AbortError' || (err as Error)?.name === 'TimeoutError') return short('update check timed out');
  if (isOffline(err)) return short("can't reach github, are you offline?");
  const msg = err instanceof Error ? err.message : String(err);
  return short(msg.split('\n')[0]!.toLowerCase());
}

function short(message: string): Error {
  const e = new Error(message);
  (e as any).short = true;
  return e;
}

/** GET {api}/releases/latest, plus build.json's notes when the release carries one. */
export async function fetchLatestRelease(apiBase = DEFAULT_API, fetchImpl: FetchLike = fetch as FetchLike): Promise<ReleaseInfo> {
  let res: Response;
  try {
    res = await fetchImpl(`${apiBase.replace(/\/+$/, '')}/releases/latest`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw networkError(err);
  }
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const mins = reset ? Math.max(1, Math.round((reset * 1000 - Date.now()) / 60_000)) : 0;
    throw short(mins ? `github is rate limiting update checks, try again in ${mins} min` : 'github is rate limiting update checks, try again later');
  }
  if (res.status === 404) throw short('no releases yet');
  if (!res.ok) throw short(`github said ${res.status}`);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw short('github sent something unexpected');
  }
  const info = parseRelease(json);
  const build = info.assets.find((a) => a.name === 'build.json');
  if (build) {
    try {
      const r = await fetchImpl(build.url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(10_000) });
      if (r.ok) {
        const b = (await r.json()) as { notes?: unknown };
        if (typeof b?.notes === 'string' && b.notes.trim()) info.notes = b.notes.trim().split('\n').slice(0, 12).join('\n');
      }
    } catch {
      /* optional */
    }
  }
  return info;
}

/** The installers every release carries (names never include the version). */
export const RELEASE_ASSET_NAMES = [
  'Clickity-mac-arm64.zip',
  'Clickity-mac-x64.zip',
  'Clickity-mac-arm64.dmg',
  'Clickity-mac-x64.dmg',
  'Clickity-win-x64.exe',
  'Clickity-linux-x86_64.AppImage',
  'Clickity-linux-amd64.deb',
];

/** "https://api.github.com/repos/o/r" → "https://github.com/o/r" */
export function repoPageFromApi(apiBase: string): string {
  const m = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)/.exec(apiBase.replace(/\/+$/, ''));
  return m ? `https://github.com/${m[1]}/${m[2]}` : apiBase.replace(/\/+$/, '');
}

/**
 * Check without the GitHub API (which allows only 60 unauthenticated requests an hour per network,
 * so checks failed "sometimes"): /releases/latest/download/<file> is a plain redirect to the asset
 * and isn't rate limited. build.json carries the version + notes; asset URLs follow the same pattern
 * (sizes unknown, so the download checks content-length instead).
 */
export async function fetchLatestViaDownloads(apiBase = DEFAULT_API, fetchImpl: FetchLike = fetch as FetchLike): Promise<ReleaseInfo> {
  const base = `${repoPageFromApi(apiBase)}/releases/latest/download`;
  let res: Response;
  try {
    res = await fetchImpl(`${base}/build.json`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw networkError(err);
  }
  if (res.status === 404) throw short('no releases yet');
  if (!res.ok) throw short(`github said ${res.status}`);
  let b: { version?: unknown; notes?: unknown };
  try {
    b = (await res.json()) as typeof b;
  } catch {
    throw short('github sent something unexpected');
  }
  const version = typeof b?.version === 'string' ? b.version.replace(/^v/i, '') : '';
  if (!parseVersion(version)) throw short('latest release has no version');
  const notes = typeof b?.notes === 'string' ? b.notes.trim().split('\n').slice(0, 12).join('\n') : '';
  return {
    version,
    tag: `v${version}`,
    notes,
    assets: RELEASE_ASSET_NAMES.map((name) => ({ name, size: 0, url: `${base}/${name}` })),
    page: `${repoPageFromApi(apiBase)}/releases/latest`,
  };
}

/** API first (exact sizes); on rate limits or API errors, the download-link route. */
export async function fetchLatest(apiBase = DEFAULT_API, fetchImpl: FetchLike = fetch as FetchLike): Promise<ReleaseInfo> {
  try {
    return await fetchLatestRelease(apiBase, fetchImpl);
  } catch (apiErr) {
    if (/offline|can't reach/.test((apiErr as Error).message)) throw apiErr;
    try {
      return await fetchLatestViaDownloads(apiBase, fetchImpl);
    } catch {
      throw apiErr;
    }
  }
}

/** downloadAsset with retries (2s, 5s backoff) for flaky connections. */
export async function downloadWithRetry(
  asset: ReleaseAsset,
  dest: string,
  onProgress: (fraction: number) => void = () => {},
  fetchImpl: FetchLike = fetch as FetchLike,
  attempts = 3,
): Promise<string> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await downloadAsset(asset, dest, onProgress, fetchImpl);
    } catch (err) {
      last = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, i === 0 ? 2000 : 5000));
    }
  }
  throw last;
}

/** Stream an asset to `dest` (via dest.part), reporting 0..1 progress; checks the size github reported. */
export async function downloadAsset(
  asset: ReleaseAsset,
  dest: string,
  onProgress: (fraction: number) => void = () => {},
  fetchImpl: FetchLike = fetch as FetchLike,
  signal?: AbortSignal,
): Promise<string> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let res: Response;
  try {
    res = await fetchImpl(asset.url, { headers: { 'User-Agent': USER_AGENT }, signal });
  } catch (err) {
    throw networkError(err);
  }
  if (!res.ok || !res.body) throw short(`download failed (${res.status})`);
  const total = asset.size || Number(res.headers.get('content-length')) || 0;
  const part = `${dest}.part`;
  const out = fs.createWriteStream(part);
  let got = 0;
  let lastReport = -1;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.byteLength;
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
      if (total) {
        const f = Math.min(1, got / total);
        if (f - lastReport >= 0.01 || f === 1) {
          lastReport = f;
          onProgress(f);
        }
      }
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw networkError(err);
  }
  const expected = asset.size || Number(res.headers.get('content-length')) || 0;
  if (expected && got !== expected) {
    fs.rmSync(part, { force: true });
    throw short(`download incomplete (${got} of ${expected} bytes)`);
  }
  if (!got) {
    fs.rmSync(part, { force: true });
    throw short('download was empty');
  }
  fs.renameSync(part, dest);
  onProgress(1);
  return dest;
}

/* ───────────── linux AppImage swap ───────────── */

/** sh single-quote */
export function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Put the downloaded AppImage in place of the running one (copy next to it, chmod +x, rename over).
 * Renaming over a running AppImage is fine: the mounted old one keeps its inode until it exits.
 */
export function swapAppImage(downloaded: string, appImage: string): void {
  const dir = path.dirname(appImage);
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    throw short(`can't write to ${dir}`);
  }
  const staged = path.join(dir, `.${path.basename(appImage)}.update`);
  fs.copyFileSync(downloaded, staged);
  fs.chmodSync(staged, 0o755);
  fs.renameSync(staged, appImage);
}

/**
 * Start `cmd` once process `pid` has exited (a new instance would otherwise lose the single-instance
 * lock to us and quit). Detached, so it outlives this app.
 */
export function relaunchAfterExit(pid: number, cmd: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env): void {
  const line = [cmd, ...args].map(shq).join(' ');
  const script = `i=0; while kill -0 ${pid} 2>/dev/null && [ $i -lt 600 ]; do sleep 0.2; i=$((i+1)); done; exec ${line}`;
  const child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore', env });
  child.unref();
}

/** AppImage runtime variables of the running image: the new one sets its own. */
export function cleanAppImageEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD']) delete out[k];
  return out;
}

/* ───────────── mac bundle swap ───────────── */

/**
 * The detached script that replaces the running .app once we've quit: move the old bundle aside,
 * ditto the new one into place (restoring the old one if that fails), strip quarantine, reopen.
 */
export function macSwapScript(pid: number, newApp: string, bundle: string, logFile: string, asAdmin = false): string {
  const B = shq(bundle);
  const OLD = shq(`${bundle}.old-update`);
  // the replace step on its own, so it can run with administrator rights when the folder isn't ours
  const swap = [
    `rm -rf ${OLD}`,
    `if mv ${B} ${OLD} && ditto ${shq(newApp)} ${B}; then rm -rf ${OLD}; else rm -rf ${B}; mv ${OLD} ${B}; exit 1; fi`,
  ].join('; ');
  const runSwap = asAdmin
    ? `/usr/bin/osascript -e ${shq(`do shell script ${JSON.stringify(swap)} with administrator privileges with prompt "Clickity needs your password to install its update."`)}`
    : `sh -c ${shq(swap)}`;
  return [
    '#!/bin/sh',
    `exec >>${shq(logFile)} 2>&1`,
    `echo "$(date -u +%FT%TZ) [update] waiting for ${pid}"`,
    // wait for clickity to quit; if it's still running after 30s, ask it to quit, then stop waiting at 60s
    `i=0; while kill -0 ${pid} 2>/dev/null && [ $i -lt 300 ]; do sleep 0.2; i=$((i+1)); [ $i -eq 150 ] && kill ${pid} 2>/dev/null; done`,
    `if ${runSwap}; then`,
    `  echo "$(date -u +%FT%TZ) [update] replaced ${bundle}"`,
    'else',
    `  echo "$(date -u +%FT%TZ) [update] replace failed, kept the old version"`,
    'fi',
    // no quarantine flag = no Gatekeeper prompt and no translocation from now on
    `xattr -dr com.apple.quarantine ${B} 2>/dev/null`,
    `open ${B}`,
    '',
  ].join('\n');
}

/**
 * Where the real app lives. A quarantined app opened via "open anyway" runs from a read-only
 * AppTranslocation copy, so the running bundle path can't be replaced; the installed copy is usually
 * /Applications/Clickity.app (or ~/Applications).
 */
export function realMacBundle(running: string, home: string, exists: (p: string) => boolean = fs.existsSync): string | null {
  const translocated = running.includes('/AppTranslocation/') || running.startsWith('/Volumes/');
  if (!translocated) return running;
  const name = path.basename(running);
  for (const dir of ['/Applications', path.join(home, 'Applications')]) {
    const p = path.join(dir, name);
    if (exists(p)) return p;
  }
  return null;
}
