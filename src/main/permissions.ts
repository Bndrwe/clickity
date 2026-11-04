// OS permission status/requests (microphone, screen recording, accessibility) and
// the Chromium permission handlers that let our own pages use the microphone.
import { desktopCapturer, session, shell, systemPreferences } from 'electron';
import type { PermissionKind, PermissionState, PermissionsStatus } from '../shared/types';

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

const SCREEN_PREFS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
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
        systemPreferences.isTrustedAccessibilityClient(true);
        break;
    }
  } catch (err) {
    console.warn(`[permissions] request ${kind} failed:`, err);
  }
  return getPermissions();
}

/** Allow microphone (and screen) media requests from our own file:// pages; deny everything else. */
export function installPermissionHandlers(): void {
  const ses = session.defaultSession;
  const isOwnPage = (url: string | undefined): boolean => !!url && url.startsWith('file://');
  const allowed = new Set(['media', 'speaker-selection', 'clipboard-sanitized-write']);

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = details.requestingUrl || wc?.getURL();
    callback(allowed.has(permission) && isOwnPage(url));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin, details) => {
    const url = details.requestingUrl || origin;
    return allowed.has(permission) && (isOwnPage(url) || url === 'file:///' || url === 'null' || url === '');
  });
}
