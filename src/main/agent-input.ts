// Agent mode's door to the native input backend (input.ts). CLICKITY_FAKE_INPUT=1 swaps it for a
// logger, so end-to-end tests (and curious developers) can watch what clickity would do without
// it touching the mouse or keyboard.
import type { InputAction, InputStatus } from '../shared/types';
import { inputStatus as nativeStatus, perform as nativePerform } from './input';
import { log } from './log';

const fake = (): boolean => process.env.CLICKITY_FAKE_INPUT === '1';

/** Batches "performed" while faking (newest last), for tests. */
export const fakeInputLog: InputAction[][] = [];

export async function performActions(actions: InputAction[], signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  }
  if (fake()) {
    // take about as long as the real thing (waits wait, typing ~30ms a character), so tests can
    // press the stop key mid-action; logged once done
    const ms = actions.reduce((n, a) => n + (a.type === 'wait' ? a.ms : a.type === 'type' ? a.text.length * 30 : 0), 0);
    if (ms > 0) await new Promise((r) => setTimeout(r, Math.min(ms, 10_000)));
    fakeInputLog.push(actions.map((a) => ({ ...a })));
    log('agent', `fake input: ${JSON.stringify(actions)}`);
    return;
  }
  await nativePerform(actions, signal);
}

export async function agentInputStatus(): Promise<InputStatus> {
  if (fake()) return { ok: true, backend: 'fake', detail: 'fake input (CLICKITY_FAKE_INPUT=1): actions are only logged' };
  try {
    return await nativeStatus();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, backend: 'none', detail: msg.split('\n')[0].toLowerCase().slice(0, 160) || 'input control unavailable' };
  }
}
