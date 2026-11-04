// Screen capture: grabs every display, downscales to the model's size limit, writes JPEG temp files.
import { desktopCapturer, screen, systemPreferences, type Display, type NativeImage, type DesktopCapturerSource, type Point, type Rectangle } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ImageInput } from '../shared/types';

const MAX_SIDE = 1568;
const JPEG_QUALITY = 80;
const MAX_AGE_MS = 2 * 60 * 1000;
const TEMP_DIR = path.join(os.tmpdir(), 'clickity-captures');

export interface CapturedScreen {
  index: number; // 1-based, order sent to the model
  displayId: number;
  isCursorScreen: boolean;
  bounds: Rectangle; // global DIP
  scaleFactor: number;
  image: ImageInput; // jpeg, longest side ≤ 1568px, written to a temp file too
}

/** Pairs each display with its capture source: by display_id, else by order among the leftovers. */
function matchSources(displays: Display[], sources: DesktopCapturerSource[]): Map<Display, DesktopCapturerSource> {
  const pairs = new Map<Display, DesktopCapturerSource>();
  for (const d of displays) {
    const s = sources.find((src) => src.display_id === String(d.id));
    if (s) pairs.set(d, s);
  }
  const leftovers = sources.filter((s) => ![...pairs.values()].includes(s));
  const unpaired = displays.filter((d) => !pairs.has(d));
  unpaired.forEach((d, i) => {
    const s = leftovers[i];
    if (s) pairs.set(d, s);
  });
  return pairs;
}

/** True when a thumbnail is (almost) pure black: checked on a tiny downscale, so it's cheap. */
function isBlack(img: NativeImage): boolean {
  try {
    const bmp = img.resize({ width: 24, quality: 'good' }).toBitmap(); // BGRA
    for (let i = 0; i + 2 < bmp.length; i += 4) {
      if (bmp[i] > 12 || bmp[i + 1] > 12 || bmp[i + 2] > 12) return false;
    }
    return bmp.length > 0;
  } catch {
    return false;
  }
}

/** Captures every display. The cursor's display comes first, then the rest left to right. */
export async function captureScreens(cursor: Point): Promise<CapturedScreen[]> {
  cleanupCaptures();

  const displays = screen.getAllDisplays();
  const cursorDisplay = screen.getDisplayNearestPoint(cursor);
  const thumbnailSize = {
    width: Math.max(...displays.map((d) => Math.round(d.bounds.width * d.scaleFactor))),
    height: Math.max(...displays.map((d) => Math.round(d.bounds.height * d.scaleFactor))),
  };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize, fetchWindowIcons: false });
  const pairs = matchSources(displays, sources);

  const ordered = displays
    .filter((d) => pairs.has(d))
    .sort((a, b) => {
      if (a.id === cursorDisplay.id) return -1;
      if (b.id === cursorDisplay.id) return 1;
      return a.bounds.x - b.bounds.x;
    });

  const PERMISSION_MSG = 'screen recording permission needed — open settings › permissions';
  // macOS 14/15 without screen-recording permission (or with a stale grant for an older
  // ad-hoc build) still returns thumbnails, just wallpaper-only or black ones. Sending those
  // makes the model describe/point at a desktop that isn't there, so treat it as "no capture".
  // The getSources call above has already triggered the system prompt the first time.
  if (process.platform === 'darwin') {
    let st = 'unknown';
    try {
      st = systemPreferences.getMediaAccessStatus('screen');
    } catch {
      /* keep unknown */
    }
    if (st === 'denied' || st === 'restricted') throw new Error(PERMISSION_MSG);
  }
  // Empty (older macOS without permission) and, on mac, all-black thumbnails are unusable.
  const usable = ordered
    .map((d) => ({ display: d, thumb: pairs.get(d)!.thumbnail }))
    .filter(({ thumb }) => !thumb.isEmpty() && !(process.platform === 'darwin' && isBlack(thumb)));
  if (usable.length === 0) throw new Error(PERMISSION_MSG);

  await fs.promises.mkdir(TEMP_DIR, { recursive: true });
  const screens: CapturedScreen[] = [];
  for (const [i, { display, thumb }] of usable.entries()) {
    const index = i + 1;
    const isCursorScreen = display.id === cursorDisplay.id;
    const size = thumb.getSize();
    const scale = Math.min(1, MAX_SIDE / Math.max(size.width, size.height));
    const img =
      scale < 1
        ? thumb.resize({
            width: Math.round(size.width * scale),
            height: Math.round(size.height * scale),
            quality: 'good',
          })
        : thumb;
    const { width, height } = img.getSize();
    const data = img.toJPEG(JPEG_QUALITY);
    const file = path.join(TEMP_DIR, `screen-${index}-${Date.now()}.jpg`);
    await fs.promises.writeFile(file, data);

    screens.push({
      index,
      displayId: display.id,
      isCursorScreen,
      bounds: display.bounds,
      scaleFactor: display.scaleFactor,
      image: {
        mime: 'image/jpeg',
        base64: data.toString('base64'),
        path: file,
        label: `screen ${index}${isCursorScreen ? ' (cursor is here)' : ''} · ${width}x${height}px`,
        width,
        height,
      },
    });
  }
  return screens;
}

/** Maps a point in the screenshot's pixel space to global DIP, clamped inside the display. */
export function screenshotToGlobal(s: CapturedScreen, x: number, y: number): Point {
  const { bounds, image } = s;
  const gx = bounds.x + (x * bounds.width) / image.width;
  const gy = bounds.y + (y * bounds.height) / image.height;
  const maxX = bounds.x + bounds.width - 1;
  const maxY = bounds.y + bounds.height - 1;
  return {
    x: Math.round(Math.min(maxX, Math.max(bounds.x, gx))),
    y: Math.round(Math.min(maxY, Math.max(bounds.y, gy))),
  };
}

/** Deletes capture temp files older than two minutes. Errors are ignored. */
export function cleanupCaptures(): void {
  let names: string[];
  try {
    names = fs.readdirSync(TEMP_DIR);
  } catch {
    return;
  }
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const name of names) {
    const file = path.join(TEMP_DIR, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {
      // ignore: file vanished or is locked
    }
  }
}

/** Writes an image (e.g. a chats-window attachment) to the capture temp dir so CLI providers get a path. */
export async function writeTempImage(data: Buffer, ext: 'png' | 'jpg', tag = 'attachment'): Promise<string> {
  await fs.promises.mkdir(TEMP_DIR, { recursive: true });
  const file = path.join(TEMP_DIR, `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  await fs.promises.writeFile(file, data);
  return file;
}
