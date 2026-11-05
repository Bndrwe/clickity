// A fresh greeting for this window (src/shared/greetings.ts), rotating through its pool without
// repeats. `scope` keeps one rotation per window (stored in that window's localStorage).
import { browserStorage, pickGreeting } from '../../shared/greetings';

export function nextGreeting(scope: string, name?: string | null): string {
  return pickGreeting({ scope, name: name ?? '', storage: browserStorage() });
}
