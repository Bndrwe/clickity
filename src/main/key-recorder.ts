// Main-process keybind recorder for settings › keys. Uses the native hook (uiohook + the
// mac fn helper), so it sees keys the browser can't (fn) and matches what the hotkey engine hears.
import type { KeyRecordEvent } from '../shared/ipc';
import type { KeyName } from '../shared/types';
import { orderKeys } from './hotkey';

/** Pure chord recorder: feed it key down/up, it reports held keys and the peak chord. */
export class KeyRecorder {
  private held = new Set<KeyName>();
  private peak: KeyName[] = [];

  constructor(private emit: (e: KeyRecordEvent) => void) {}

  key(k: KeyName, down: boolean): void {
    if (down) {
      if (this.held.has(k)) return; // autorepeat
      if (k === 'Escape' && this.held.size === 0 && this.peak.length === 0) {
        this.emit({ held: [], chord: ['Escape'], done: true });
        return;
      }
      this.held.add(k);
      if (this.held.size >= this.peak.length) this.peak = orderKeys(this.held);
      this.emit({ held: orderKeys(this.held), chord: this.peak, done: false });
      return;
    }
    if (!this.held.delete(k)) return; // released a key pressed before recording started
    if (this.held.size > 0) {
      this.emit({ held: orderKeys(this.held), chord: this.peak, done: false });
      return;
    }
    const chord = this.peak;
    this.peak = [];
    this.emit({ held: [], chord, done: true });
  }

  reset(): void {
    this.held.clear();
    this.peak = [];
  }
}
