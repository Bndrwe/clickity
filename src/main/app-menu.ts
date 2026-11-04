// The application menu (mac menu bar / keyboard shortcuts) and the mac dock menu.
// Clickity behaves like a normal app: it has a dock / taskbar icon, clicking the icon
// opens the settings window, and quitting (cmd+q, dock › quit, tray › quit) stops it.
import { app, Menu, type MenuItemConstructorOptions } from 'electron';

export interface AppMenuActions {
  openSettings(): void;
  openChats(): void;
  isPaused(): boolean;
  setPaused(paused: boolean): void;
  clearConversation(): void;
}

export function installAppMenu(a: AppMenuActions): void {
  const isMac = process.platform === 'darwin';
  const name = app.getName();

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: name,
            submenu: [
              { role: 'about', label: `about ${name.toLowerCase()}` },
              { type: 'separator' },
              { label: 'settings…', accelerator: 'Command+,', click: () => a.openSettings() },
              { label: 'chats…', accelerator: 'CommandOrControl+Shift+K', click: () => a.openChats() },
              { type: 'separator' },
              { role: 'hide', label: `hide ${name.toLowerCase()}` },
              { role: 'hideOthers', label: 'hide others' },
              { role: 'unhide', label: 'show all' },
              { type: 'separator' },
              { role: 'quit', label: `quit ${name.toLowerCase()}` },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'clickity',
      submenu: [
        ...(isMac
          ? []
          : ([
              { label: 'settings…', accelerator: 'Ctrl+,', click: () => a.openSettings() },
              { label: 'chats…', accelerator: 'CommandOrControl+Shift+K', click: () => a.openChats() },
            ] as MenuItemConstructorOptions[])),
        {
          label: 'pause companion',
          type: 'checkbox',
          checked: a.isPaused(),
          click: (item) => a.setPaused(item.checked),
        },
        { label: 'new conversation', click: () => a.clearConversation() },
        ...(isMac ? [] : ([{ type: 'separator' }, { role: 'quit', label: 'quit' }] as MenuItemConstructorOptions[])),
      ],
    },
    // Needed on mac so copy / paste / select-all work inside the settings inputs.
    { role: 'editMenu', label: 'edit' },
    { role: 'windowMenu', label: 'window' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  if (isMac && app.dock) {
    app.dock.setMenu(
      Menu.buildFromTemplate([
        { label: 'chats…', click: () => a.openChats() },
        { label: 'settings…', click: () => a.openSettings() },
        {
          label: 'pause companion',
          type: 'checkbox',
          checked: a.isPaused(),
          click: (item) => a.setPaused(item.checked),
        },
      ]),
    );
  }
}

/** True when the OS started us at login, in which case we start quietly (no window). */
export function launchedAtLogin(): boolean {
  if (process.argv.includes('--hidden')) return true;
  if (process.platform === 'darwin') {
    try {
      return app.getLoginItemSettings().wasOpenedAtLogin === true;
    } catch {
      return false;
    }
  }
  return false;
}
