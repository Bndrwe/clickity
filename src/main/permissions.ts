// OS permission status/requests (microphone, screen recording, accessibility) and
// the Chromium permission handlers that let our own pages use the microphone.
import { desktopCapturer, session, shell, systemPreferences } from 'electron';
import type { PermissionKind, PermissionState, PermissionsStatus } from '../shared/types';
import { log } from './log';

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

const SCREEN_PREFS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
const ACCESSIBILITY_PREFS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const MIC_PREFS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';

function mediaStatus(kind: 'microphone' | 'screen'): PermissionState {
  try {
    return systemPreferences.getMediaAccessStatus(kind) as PermissionState;
  } catch {
    return 'unknown';
  }
}

export function getPermissions(): PermissionsStatus {
  return {
    microphone: isMac || isWin ? mediaStatus('microphone') : 'granted',
    screen: isMac ? mediaStatus('screen') : 'granted',
    accessibility: isMac ? (systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied') : 'granted',
  };
}

export async function requestPermission(kind: PermissionKind): Promise<PermissionsStatus> {
  if (!isMac) return getPermissions();
  try {
    switch (kind) {
      case 'microphone': {
        // askForMediaAccess only prompts once; afterwards the user must flip it in settings.
        const status = mediaStatus('microphone');
        if (status === 'denied' || status === 'restricted') await shell.openExternal(MIC_PREFS_URL);
        else await systemPreferences.askForMediaAccess('microphone');
        break;
      }
      case 'screen': {
        // Touch the capture API once so the app shows up in the screen recording list.
        await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => []);
        if (mediaStatus('screen') !== 'granted') await shell.openExternal(SCREEN_PREFS_URL);
        break;
      }
      case 'accessibility':
        // Shows the system prompt the first time; afterwards open the list directly.
        if (!systemPreferences.isTrustedAccessibilityClient(true)) await shell.openExternal(ACCESSIBILITY_PREFS_URL);
        break;
    }
  } catch (err) {
    console.warn(`[permissions] request ${kind} failed:`, err);
  }
  return getPermissions();
}

export interface MicAccess {
  ok: boolean;
  /** the OS permission prompt was shown just now */
  prompted: boolean;
  status: PermissionState;
  /** what to tell the user when !ok */
  message?: string;
}

const MIC_BLOCKED_MAC = 'microphone blocked — allow clickity in system settings › privacy & security › microphone, then restart it';
const MIC_BLOCKED_WIN = 'microphone blocked — allow microphone access in windows settings › privacy › microphone';

/**
 * Make sure the OS lets us record before the overlay calls getUserMedia. On macOS a
 * 'not-determined' status shows the system prompt (getUserMedia alone doesn't reliably).
 */
export async function ensureMicrophoneAccess(): Promise<MicAccess> {
  if (!isMac && !isWin) return { ok: true, prompted: false, status: 'granted' };
  const status = mediaStatus('microphone');
  if (status === 'granted' || status === 'unknown') return { ok: true, prompted: false, status };
  if (isMac && status === 'not-determined') {
    let granted = false;
    try {
      granted = await systemPreferences.askForMediaAccess('microphone');
    } catch (err) {
      log('perm', 'askForMediaAccess failed:', err);
    }
    log('perm', `microphone prompt answered: ${granted ? 'granted' : 'denied'}`);
    return granted
      ? { ok: true, prompted: true, status: 'granted' }
      : { ok: false, prompted: true, status: 'denied', message: MIC_BLOCKED_MAC };
  }
  if (isWin && status === 'not-determined') return { ok: true, prompted: false, status };
  return { ok: false, prompted: false, status, message: isMac ? MIC_BLOCKED_MAC : MIC_BLOCKED_WIN };
}

/** Synchronous status check for the hot path (talk key down). */
export function microphoneStatus(): PermissionState {
  return isMac || isWin ? mediaStatus('microphone') : 'granted';
}

/**
 * Allow microphone (and screen) media requests from our own file:// pages; deny everything else.
 * Chromium reports file:// origins inconsistently ('file:///…', 'file:///', 'null' or ''), so the
 * requesting webContents' own URL is checked too.
 */
export function installPermissionHandlers(): void {
  const ses = session.defaultSession;
  const isFile = (url: string | undefined | null): boolean => !!url && url.startsWith('file://');
  const allowed = new Set(['media', 'speaker-selection', 'clipboard-sanitized-write']);
  const ownPage = (wc: Electron.WebContents | null, url: string | undefined): boolean => {
    if (isFile(url)) return true;
    let wcUrl = '';
    try {
      wcUrl = wc && !wc.isDestroyed() ? wc.getURL() : '';
    } catch {
      wcUrl = '';
    }
    if (isFile(wcUrl)) return !url || url === 'null' || url === 'file:///' || isFile(url);
    return false;
  };

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = details.requestingUrl;
    const ok = allowed.has(permission) && ownPage(wc, url);
    if (permission === 'media' || !ok) {
      const media = (details as { mediaTypes?: string[] }).mediaTypes;
      log('perm', `request ${permission}${media ? ` ${media.join('+')}` : ''} from ${url || wc?.getURL() || '?'} → ${ok ? 'allowed' : 'denied'}`);
    }
    callback(ok);
  });
  ses.setPermissionCheckHandler((wc, permission, origin, details) => {
    const url = details.requestingUrl || origin;
    if (!allowed.has(permission)) return false;
    return ownPage(wc, url) || url === 'file:///' || url === 'null' || url === '';
  });
}
