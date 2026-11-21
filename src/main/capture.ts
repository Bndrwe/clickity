// Screen capture: grabs every display, downscales to the model's size limit, writes JPEG temp files.
import { desktopCapturer, nativeImage, screen, systemPreferences, type Display, type NativeImage, type DesktopCapturerSource, type Point, type Rectangle } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ImageInput } from '../shared/types';
import { PrivacySkip, blurMode, screenVerdict } from './privacy';
import { blurWidth, pasteRect, sharpRect } from './privacy-match';

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

/**
 * Draws on a screenshot before it is encoded (the talk gesture's ink stroke). Gets the raw
 * BGRA bitmap of the downscaled image; returns true when it changed it.
 */
export type CaptureAnnotator = (
  screen: { index: number; bounds: Rectangle; image: { width: number; height: number } },
  bitmap: Buffer,
) => boolean;

/** Raw thumbnails of every display, taken as early as possible (talk key down); encoded later. */
export interface ScreenGrab {
  at: number;
  ms: number;
  items: Array<{ display: Display; thumb: NativeImage }>;
  /** tiny grey thumbnails per display id, for screensChanged() */
  sig: Map<number, Buffer>;
  /** a screen was left out for privacy ("didn't look at one screen — 1password is open there") */
  privacy?: string;
}

/** Screenshots of a turn; `privacy` says why some / all screens were left out (settings › privacy). */
export type Screens = CapturedScreen[] & { privacy?: string };

/** No screenshots, because of the never-capture list / private mode: the bubble line rides along. */
export function privacyScreens(line: string): Screens {
  return Object.assign([] as CapturedScreen[], { privacy: line });
}

/** The privacy line of a turn's screenshots ('' = nothing was left out). */
export function privacyOf(screens: CapturedScreen[] | null | undefined): string {
  return (screens as Screens | null | undefined)?.privacy ?? '';
}

const PERMISSION_MSG = 'screen recording permission needed — open settings › permissions';
const SIG_WIDTH = 96;

/** Tiny greyscale signature of a thumbnail (for a cheap "did the screen change?" check). */
function signature(img: NativeImage): Buffer {
  try {
    const bmp = img.resize({ width: SIG_WIDTH, quality: 'good' }).toBitmap(); // BGRA
    const out = Buffer.alloc(bmp.length / 4);
    for (let i = 0, o = 0; i + 3 < bmp.length; i += 4, o++) out[o] = (bmp[i]! + 2 * bmp[i + 1]! + bmp[i + 2]!) >> 2;
    return out;
  } catch {
    return Buffer.alloc(0);
  }
}

/** Grab every display's pixels now (no resize / encode yet). Throws the permission message. */
export async function grabScreens(): Promise<ScreenGrab> {
  const t0 = Date.now();
  const displays = screen.getAllDisplays();
  const thumbnailSize = {
    width: Math.max(...displays.map((d) => Math.round(d.bounds.width * d.scaleFactor))),
    height: Math.max(...displays.map((d) => Math.round(d.bounds.height * d.scaleFactor))),
  };
  // privacy (never-capture apps, private mode) is checked while the pixels are fetched
  const [sources, verdict] = await Promise.all([desktopCapturer.getSources({ types: ['screen'], thumbnailSize, fetchWindowIcons: false }), screenVerdict()]);
  if (verdict.all) throw new PrivacySkip(verdict.all);
  const pairs = matchSources(displays, sources);
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
  const items = displays
    .filter((d) => pairs.has(d))
    .map((d) => ({ display: d, thumb: pairs.get(d)!.thumbnail }))
    .filter(({ thumb }) => !thumb.isEmpty() && !(process.platform === 'darwin' && isBlack(thumb)));
  if (items.length === 0) throw new Error(PERMISSION_MSG);
  const kept = items.filter((it) => !verdict.displays.has(it.display.id));
  const privacy = kept.length < items.length ? verdict.displays.get(items.find((it) => verdict.displays.has(it.display.id))!.display.id) : undefined;
  if (!kept.length) throw new PrivacySkip(privacy ?? "didn't look");
  const sig = new Map<number, Buffer>();
  for (const it of kept) sig.set(it.display.id, signature(it.thumb));
  return { at: t0, ms: Date.now() - t0, items: kept, sig, privacy };
}

/**
 * Has anything on screen visibly changed since the grab? Compares tiny thumbnails: a window
 * opening or a page scrolling changes many blocks; the companion and the ink trail don't.
 */
export async function screensChanged(grab: ScreenGrab): Promise<boolean> {
  const displays = screen.getAllDisplays();
  if (displays.length !== grab.items.length || displays.some((d) => !grab.sig.has(d.id))) return true;
  const maxW = Math.max(...displays.map((d) => Math.round(d.bounds.width * d.scaleFactor)));
  const maxH = Math.max(...displays.map((d) => Math.round(d.bounds.height * d.scaleFactor)));
  // ask for roughly the signature size directly (the os scales it down)
  const scale = (SIG_WIDTH * 2) / maxW;
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(maxW * scale), height: Math.round(maxH * scale) }, fetchWindowIcons: false });
  const pairs = matchSources(displays, sources);
  for (const d of displays) {
    const before = grab.sig.get(d.id)!;
    const src = pairs.get(d);
    if (!src || src.thumbnail.isEmpty()) return true;
    const now = signature(src.thumbnail);
    if (now.length !== before.length || !now.length) return true;
    let changed = 0;
    for (let i = 0; i < now.length; i++) if (Math.abs(now[i]! - before[i]!) > 24) changed++;
    if (changed / now.length > 0.03) return true;
  }
  return false;
}

/** Downscale, annotate (ink stroke) and JPEG-encode a grab. The cursor's display comes first. */
export async function encodeScreens(grab: ScreenGrab, cursor: Point, annotate?: CaptureAnnotator): Promise<Screens> {
  const cursorDisplay = screen.getDisplayNearestPoint(cursor);
  const usable = [...grab.items].sort((a, b) => {
    if (a.display.id === cursorDisplay.id) return -1;
    if (b.display.id === cursorDisplay.id) return 1;
    return a.display.bounds.x - b.display.bounds.x;
  });
  await fs.promises.mkdir(TEMP_DIR, { recursive: true });
  const screens: Screens = [];
  if (grab.privacy) screens.privacy = grab.privacy;
  const blur = blurMode();
  for (const [i, { display, thumb }] of usable.entries()) {
    const index = i + 1;
    const isCursorScreen = display.id === cursorDisplay.id;
    const size = thumb.getSize();
    const scale = Math.min(1, MAX_SIDE / Math.max(size.width, size.height));
    let img =
      scale < 1
        ? thumb.resize({
            width: Math.round(size.width * scale),
            height: Math.round(size.height * scale),
            quality: 'good',
          })
        : thumb;
    const { width, height } = img.getSize();
    // settings › privacy › blur before sending: heavy blur (a tiny downscale, scaled back up),
    // the box around the cursor kept sharp ('cursor'); other screens are blurred all over
    let blurred = '';
    if (blur !== 'off') {
      try {
        img = blurImage(img, width, height, blur === 'cursor' ? sharpRect({ width, height }, display.bounds, cursor) : null);
        blurred = blur === 'cursor' && isCursorScreen ? ' · blurred except around the cursor' : ' · blurred on purpose (privacy)';
      } catch (err) {
        console.warn('[capture] blur failed:', err);
      }
    }
    if (annotate) {
      try {
        const bitmap = img.toBitmap();
        if (bitmap.length === width * height * 4 && annotate({ index, bounds: display.bounds, image: { width, height } }, bitmap)) {
          img = nativeImage.createFromBitmap(bitmap, { width, height });
        }
      } catch (err) {
        console.warn('[capture] annotate failed:', err);
      }
    }
    const data = img.toJPEG(JPEG_QUALITY);
    const file = path.join(TEMP_DIR, `screen-${index}-${Date.now()}.jpg`);
    await fs.promises.writeFile(file, data);
    written.set(file, Date.now());

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
        label: `screen ${index}${isCursorScreen ? ' (cursor is here)' : ''} · ${width}x${height}px${blurred}`,
        width,
        height,
      },
    });
  }
  return screens;
}

/** Heavy blur, optionally keeping `sharp` (image pixels) as it was. Cheap: two resizes and a row copy. */
function blurImage(img: NativeImage, width: number, height: number, sharp: { x: number; y: number; width: number; height: number } | null): NativeImage {
  const soft = img.resize({ width: blurWidth(width), quality: 'good' }).resize({ width, height, quality: 'good' });
  if (!sharp) return soft;
  const dst = soft.toBitmap();
  const src = img.toBitmap();
  if (dst.length !== width * height * 4 || src.length !== dst.length) return soft;
  return nativeImage.createFromBitmap(pasteRect(dst, src, width, sharp), { width, height });
}

/** Captures every display. The cursor's display comes first, then the rest left to right. */
export async function captureScreens(cursor: Point, annotate?: CaptureAnnotator): Promise<Screens> {
  cleanupCaptures();
  return encodeScreens(await grabScreens(), cursor, annotate);
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
  written.set(file, Date.now());
  return file;
}

/**
 * Delete the temp files of finished screenshots right away (the turn — and any agent loop or
 * nudge that re-sent them — is over). cleanupCaptures' two-minute sweep stays as a backstop.
 */
export function deleteCaptureFiles(paths: Iterable<string | undefined>): void {
  for (const file of [...paths]) {
    if (!file || path.dirname(file) !== TEMP_DIR) continue;
    written.delete(file);
    fs.promises.unlink(file).catch(() => undefined);
  }
}

/** temp files we wrote (screenshots, attachment images) → when */
const written = new Map<string, number>();

/** Temp files written at or after `since` (a turn's screenshots, incl. agent-step re-captures). */
export function capturedSince(since: number): string[] {
  const out: string[] = [];
  for (const [file, at] of written) if (at >= since) out.push(file);
  return out;
}
