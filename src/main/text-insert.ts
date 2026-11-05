// Put dictated / drafted text into the focused app: typed with the native input backend, or —
// for long or non-ascii text on macOS — pasted through the clipboard, which is saved first and
// restored afterwards. Inserts are serialised; our own synthetic keys never reach the chord engine.
import { ClipboardItem, clipboard } from 'electron';
import { performActions } from './agent-input';
import { heldKeyCount, setAgentKeysSuspended } from './hotkey';
import { log } from './log';

const PASTE_RESTORE_MS = 450;
const LONG_TEXT = 60;

let chain: Promise<unknown> = Promise.resolve();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait (up to maxMs) until the user has let go of every key, so held modifiers don't turn letters into shortcuts. */
export async function waitForKeysUp(maxMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (heldKeyCount() > 0 && Date.now() - t0 < maxMs) await sleep(25);
}

/** Every entry and format on the clipboard, materialised (Electron's async clipboard API). */
type SavedClipboard = Array<Record<string, Blob | Electron.ClipboardBookmark>>;

async function saveClipboard(): Promise<SavedClipboard> {
  const saved: SavedClipboard = [];
  try {
    for (const item of await clipboard.read()) {
      const entry: Record<string, Blob | Electron.ClipboardBookmark> = {};
      for (const type of item.types) {
        try {
          entry[type] = await item.getType(type);
        } catch {
          /* a format that can't be read back */
        }
      }
      if (Object.keys(entry).length) saved.push(entry);
    }
  } catch (err) {
    log('dictation', 'could not read the clipboard:', err);
  }
  return saved;
}

async function restoreClipboard(saved: SavedClipboard): Promise<void> {
  try {
    if (!saved.length) {
      clipboard.clear();
      return;
    }
    await clipboard.write(saved.map((e) => new ClipboardItem(e as Record<string, Blob>)));
  } catch (err) {
    log('dictation', 'could not restore the clipboard:', err);
  }
}

export function shouldPaste(text: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' && (text.length > LONG_TEXT || /[^\x00-\x7f]/.test(text));
}

async function insertNow(text: string, signal?: AbortSignal): Promise<'typed' | 'pasted'> {
  await waitForKeysUp();
  setAgentKeysSuspended(true);
  try {
    if (shouldPaste(text)) {
      const saved = await saveClipboard();
      await clipboard.writeText(text);
      try {
        await performActions([{ type: 'key', keys: [process.platform === 'darwin' ? 'Meta' : 'Control', 'KeyV'] }], signal);
        await sleep(PASTE_RESTORE_MS); // let the app read the clipboard before we put the old one back
      } finally {
        await restoreClipboard(saved);
      }
      return 'pasted';
    }
    await performActions([{ type: 'type', text }], signal);
    return 'typed';
  } finally {
    setAgentKeysSuspended(false);
  }
}

/** Insert text into whatever has keyboard focus. Serialised with other inserts. */
export function insertText(text: string, signal?: AbortSignal): Promise<'typed' | 'pasted'> {
  const run = () => insertNow(text, signal);
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  return p;
}

/** Copy an answer to the clipboard (voice off: "copied"). */
export function copyText(text: string): void {
  clipboard.writeText(text).catch(() => undefined);
}

