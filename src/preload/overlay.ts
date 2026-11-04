// Preload for the overlay windows: exposes `window.overlay` (OverlayApi) over IPC.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type OverlayApi } from '../shared/ipc';

/** Subscribe to a main → renderer channel, dropping the Electron event argument. */
function on<T>(channel: string, cb: (payload: T) => void): void {
  ipcRenderer.on(channel, (_e: IpcRendererEvent, payload: T) => cb(payload));
}

const api: OverlayApi = {
  onConfig: (cb) => on(IPC.overlayConfig, cb),
  onCursor: (cb) => on(IPC.overlayCursor, cb),
  onState: (cb) => on(IPC.overlayState, cb),
  onPoint: (cb) => on(IPC.overlayPoint, cb),
  onPttStart: (cb) => on<void>(IPC.overlayPttStart, () => cb()),
  onPttStop: (cb) => on(IPC.overlayPttStop, cb),
  onPttCancel: (cb) => on<void>(IPC.overlayPttCancel, () => cb()),
  onSpeak: (cb) => on(IPC.overlaySpeak, cb),
  onStopSpeaking: (cb) => on<void>(IPC.overlayStopSpeaking, () => cb()),
  onTextInput: (cb) => on(IPC.overlayTextInput, cb),
  onClick: (cb) => on(IPC.overlayClick, cb),
  sendPttResult: (r) => ipcRenderer.send(IPC.pttResult, r),
  speechDone: () => ipcRenderer.send(IPC.speechDone),
  submitText: (text) => ipcRenderer.send(IPC.textSubmit, text),
  cancelText: () => ipcRenderer.send(IPC.textCancel),
  setInteractive: (on: boolean) => ipcRenderer.send(IPC.overlaySetInteractive, !!on),
  ready: () => ipcRenderer.send(IPC.overlayReady),
  log: (entry) => ipcRenderer.send(IPC.overlayLog, entry),
  pttProgress: (note) => ipcRenderer.send(IPC.pttProgress, note),
};

contextBridge.exposeInMainWorld('overlay', api);
