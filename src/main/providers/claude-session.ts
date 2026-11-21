// Warm Claude Code processes: one `claude -p --input-format stream-json` per active chat that
// stays alive between turns, instead of a fresh process per turn. Stream-json input takes one
// user message per line on stdin, and the process keeps the conversation, so a follow-up turn
// skips process start-up, auth and the first-request overhead (measured ~1–1.5 s per turn).
//
//  - started with the stable part of the system prompt; each turn's changing context (screens,
//    cursor, time, focused app) goes at the top of that turn's user message
//  - a session is only reused when the chat continues where it left off (its last user message
//    is the one before the new one) and the stable prompt / model / effort are the same
//  - recycled after MAX_TURNS (screenshots pile up in its history) or IDLE_MS; killed on abort or
//    error (the next turn starts a new one); at most MAX_SESSIONS processes
//  - prewarm(): spawned while the user is still holding the talk key
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { cliEnv, killTree, makeTempDir, removeDir, spawnOpts } from './cli';
import { AbortedError, parseJson } from './http';

const IDLE_MS = 10 * 60_000;
const MAX_TURNS = 8;
const MAX_SESSIONS = 3;
const TURN_TIMEOUT_MS = 180_000;

export interface SessionSpec {
  bin: string;
  /** full argv (system prompt included) */
  args: string[];
}

interface Session {
  key: string;
  sig: string;
  child: ChildProcess;
  cwd: string;
  lines: string[];
  wake: (() => void) | null;
  exited: boolean;
  stderr: string;
  busy: boolean;
  turns: number;
  /** text of the last user message sent (to check the chat continues where it left off) */
  lastUser: string | null;
  idle: NodeJS.Timeout | null;
  startedAt: number;
}

const sessions = new Map<string, Session>();

export function specSignature(spec: SessionSpec): string {
  return createHash('sha1').update(spec.bin + '\0' + spec.args.join('\0')).digest('hex');
}

function kill(s: Session): void {
  if (s.idle) clearTimeout(s.idle);
  s.idle = null;
  if (sessions.get(s.key) === s) sessions.delete(s.key);
  try {
    s.child.stdin?.end();
  } catch {
    /* gone */
  }
  killTree(s.child);
  removeDir(s.cwd);
}

function armIdle(s: Session): void {
  if (s.idle) clearTimeout(s.idle);
  s.idle = setTimeout(() => kill(s), IDLE_MS);
  s.idle.unref?.();
}

async function start(key: string, spec: SessionSpec): Promise<Session> {
  // keep the process count bounded: drop the least recently used idle session
  if (sessions.size >= MAX_SESSIONS) {
    const idle = [...sessions.values()].filter((x) => !x.busy).sort((a, b) => a.startedAt - b.startedAt)[0];
    if (idle) kill(idle);
  }
  const env = await cliEnv();
  const cwd = makeTempDir('claude');
  const { cmd, args, opts } = spawnOpts(spec.bin, spec.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const child = spawn(cmd, args, opts);
  const s: Session = {
    key,
    sig: specSignature(spec),
    child,
    cwd,
    lines: [],
    wake: null,
    exited: false,
    stderr: '',
    busy: false,
    turns: 0,
    lastUser: null,
    idle: null,
    startedAt: Date.now(),
  };
  const wake = (): void => {
    const w = s.wake;
    s.wake = null;
    w?.();
  };
  child.stdin?.on('error', () => undefined);
  child.stderr?.on('data', (d) => {
    s.stderr += String(d);
    if (s.stderr.length > 32_000) s.stderr = s.stderr.slice(-16_000);
  });
  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  rl.on('line', (l) => {
    s.lines.push(l);
    wake();
  });
  const onExit = (): void => {
    s.exited = true;
    if (sessions.get(key) === s) sessions.delete(key);
    if (s.idle) clearTimeout(s.idle);
    removeDir(cwd);
    wake();
  };
  child.on('error', (e) => {
    s.stderr += `\n${(e as NodeJS.ErrnoException).code ?? e.message}`;
    onExit();
  });
  child.on('close', onExit);
  sessions.set(key, s);
  armIdle(s);
  return s;
}

/** Start a process for this chat now (talk key down) so the turn finds it warm. */
export async function prewarm(key: string, spec: SessionSpec): Promise<void> {
  const s = sessions.get(key);
  if (s && !s.exited && s.sig === specSignature(spec)) return;
  if (s && !s.busy) kill(s);
  if (s?.busy) return;
  await start(key, spec);
}

export interface SessionTurn {
  /** the session continues the chat: send only the new message (with this turn's context) */
  continued: boolean;
  /** the process was already running before this turn */
  warm: boolean;
  lines: AsyncGenerator<string>;
  /** ends the turn: keep the process for the next one (ok) or kill it */
  release(ok: boolean): void;
  stderr(): string;
}

/**
 * The stored history may decorate a message we sent ("… (circled an area on screen 1)") or we
 * may have sent more than is stored (a web page appended): same turn when one starts with the other.
 */
function sameMessage(sent: string | null, stored: string | null): boolean {
  const a = sent?.trim() ?? '';
  const b = stored?.trim() ?? '';
  if (!a || !b) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Get a session for the chat and send the user message built by `message(continued)`.
 * `prevUser` is the text of the user message before the new one (null = none): a session whose
 * last message differs has missed turns (another provider answered, the history was edited) and
 * is replaced.
 */
export async function openTurn(
  key: string,
  spec: SessionSpec,
  prevUser: string | null,
  newUser: string,
  message: (continued: boolean) => object,
  signal: AbortSignal,
): Promise<SessionTurn> {
  if (signal.aborted) throw new AbortedError();
  const sig = specSignature(spec);
  let s = sessions.get(key);
  let continued = false;
  let warm = false;
  if (s && (s.exited || s.busy || s.sig !== sig || s.turns >= MAX_TURNS || (s.turns > 0 && !sameMessage(s.lastUser, prevUser)))) {
    if (!s.busy) kill(s);
    s = undefined;
  }
  if (s) {
    warm = true;
    continued = s.turns > 0;
  } else {
    s = await start(key, spec);
  }
  const sess = s;
  sess.busy = true;
  if (sess.idle) clearTimeout(sess.idle);
  sess.lines = sess.lines.filter((l) => !/"type":"system"/.test(l)); // init chatter from the warm-up
  sess.child.stdin?.write(JSON.stringify(message(continued)) + '\n');

  let finished = false;
  const onAbort = (): void => {
    kill(sess);
    const w = sess.wake;
    sess.wake = null;
    w?.();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    sess.stderr += '\n__clicky_timeout__';
    onAbort();
  }, TURN_TIMEOUT_MS);

  async function* lines(): AsyncGenerator<string> {
    for (;;) {
      if (signal.aborted) throw new AbortedError();
      const l = sess.lines.shift();
      if (l !== undefined) {
        yield l;
        continue;
      }
      if (sess.exited) return;
      await new Promise<void>((r) => (sess.wake = r));
    }
  }

  return {
    continued,
    warm,
    lines: lines(),
    stderr: () => sess.stderr,
    release(ok: boolean): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      sess.busy = false;
      if (!ok || sess.exited) {
        kill(sess);
        return;
      }
      sess.turns++;
      sess.lastUser = newUser;
      sess.lines = [];
      armIdle(sess);
      // full: start a fresh one now so the next turn is warm too
      if (sess.turns >= MAX_TURNS) {
        kill(sess);
        void start(key, spec).catch(() => undefined);
      }
    },
  };
}

/** Kill every warm process (quit). */
export function closeAllSessions(): void {
  for (const s of [...sessions.values()]) kill(s);
}

/** for diagnostics / tests */
export function sessionInfo(): Array<{ key: string; turns: number; busy: boolean; ageMs: number }> {
  return [...sessions.values()].map((s) => ({ key: s.key, turns: s.turns, busy: s.busy, ageMs: Date.now() - s.startedAt }));
}

export { parseJson };
