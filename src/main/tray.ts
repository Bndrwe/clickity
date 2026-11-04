// Menu-bar / system-tray icon and its lowercase menu.
import fs from 'node:fs';
import path from 'node:path';
import { Menu, Tray, nativeImage, nativeTheme, type NativeImage } from 'electron';
import { PROVIDER_META } from '../shared/types';
import { getSettings, updateSettings } from './settings-store';
import { hotkeyLabel } from './hotkey';

export interface TrayActions {
  openSettings(): void;
  isPaused(): boolean;
  setPaused(paused: boolean): void;
  clearConversation(): void;
  quit(): void;
}

const isMac = process.platform === 'darwin';

// 32x32 @2x fallback glyphs (the companion's soft triangle), used when assets/ has no tray icon.
const FALLBACK_BLACK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA1ElEQVR4nO2WXQ3DIBSFPwmVMAmTMAmVUAmVgINJQEIlIGESKqESujS5JGShG6PAfeFL7luTc3o4/ECnE8cCEzBoGTjEd2ADnsCttYFBDITjxFgzbMSET8W0SOVxYiCcBRhrmlgTTOzynalR2jnRQDhW0itCrIyps8oPXE5luWDCl/ZI5Z5rYLxoIFyabFLLWEX8wGiKI4dOjrgrIe75t4yv0ufCpCnu2TTFkav5157P3u8pfCtjdXGP0xTnpIzFLp8Uho8yNn0leaymOLLeauKdTlHeu9TTznpyHEYAAAAASUVORK5CYII=';
const FALLBACK_WHITE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA8klEQVR4nO2WWw2EMBBFKwEJSEDCSkACElZCHSChEpCAhJWABCTcTZMhIbtQ5gX8MEm/KJzD5A40AAh3rlvhj0BJIAHoAFR3CWR4rhlAD6C+WqDCf40kdlkG0obE0pXo1ZXSxdeOwLoGAO1ZAnlNDAnQvqgJ7dGGN1NgXYm65yKwFUZuTfQCxa5wLAeDBCi0uSuNVqA1CiyVtAKSMIrgEoF4BlwiUCvho3UKLGH8cL4LEoGOARXBpQKBRsoNrhHoD+Dz3rx7CZTCKIZrBAIl2wWuFdgKI/vn4yFQ/YTRdErS3pg84BaBxut8aH7AI/AIWNcXnBnIgtCeY7QAAAAASUVORK5CYII=';

let tray: Tray | null = null;
let actions: TrayActions | null = null;

function loadIcon(): NativeImage {
  const assets = path.join(__dirname, '../assets');
  const candidates = isMac ? ['tray-template.png', 'tray.png'] : ['tray.png', 'tray-template.png'];
  for (const name of candidates) {
    const file = path.join(assets, name);
    if (!fs.existsSync(file)) continue;
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) continue;
    if (isMac && name === 'tray-template.png') img.setTemplateImage(true);
    return img;
  }
  // Fallback: black template on mac (the OS tints it); otherwise pick a color that
  // stays visible on the (usually dark) taskbar.
  const dataUrl = isMac || !nativeTheme.shouldUseDarkColors ? FALLBACK_BLACK : FALLBACK_WHITE;
  const png = Buffer.from(dataUrl.split(',')[1], 'base64');
  const img = nativeImage.createFromBuffer(png, { scaleFactor: 2 });
  if (isMac) img.setTemplateImage(true);
  return img;
}

function buildMenu(a: TrayActions): Menu {
  const s = getSettings();
  const meta = PROVIDER_META[s.provider];
  const model = s.models[s.provider] || meta.defaultModel;
  const paused = a.isPaused();
  return Menu.buildFromTemplate([
    { label: `hold ${hotkeyLabel(s.hotkeys.talk, process.platform)} to talk`, enabled: false },
    { label: `${meta.label} · ${model}`, enabled: false },
    { type: 'separator' },
    { label: 'settings…', accelerator: isMac ? 'Command+,' : undefined, click: () => a.openSettings() },
    {
      label: 'pause companion',
      type: 'checkbox',
      checked: paused,
      click: () => a.setPaused(!a.isPaused()),
    },
    {
      label: 'appearance',
      submenu: (['system', 'light', 'dark'] as const).map((t) => ({
        label: t,
        type: 'radio' as const,
        checked: s.theme === t,
        click: () => updateSettings({ theme: t }),
      })),
    },
    { label: 'clear conversation', click: () => a.clearConversation() },
    { type: 'separator' },
    { label: 'quit', accelerator: isMac ? 'Command+Q' : undefined, click: () => a.quit() },
  ]);
}

export function createTray(a: TrayActions): Tray {
  actions = a;
  if (tray && !tray.isDestroyed()) return tray;
  tray = new Tray(loadIcon());
  tray.setToolTip('clicky');
  refreshTray();
  // Windows: left click should open the menu too (mac/linux already do).
  if (process.platform === 'win32') tray.on('click', () => tray?.popUpContextMenu());
  return tray;
}

/** Rebuild the menu (settings or pause state changed). */
export function refreshTray(): void {
  if (!tray || tray.isDestroyed() || !actions) return;
  tray.setContextMenu(buildMenu(actions));
  tray.setToolTip(actions.isPaused() ? 'clicky (paused)' : 'clicky');
}

export function destroyTray(): void {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
}
