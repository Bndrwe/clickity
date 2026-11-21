// Quiz mode: the live quiz (one at a time, in one chat) and the per-clicky review list of things the
// user missed, in userData/quiz.json. Tags and scoring are pure in quiz-tags.ts. conversation.ts
// calls quizAfterReply from finishReply, quizEscape from esc; turn-extras adds quizPromptParts.
// Settings › memory shows the review list ("to review", clear).
import { app, ipcMain, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { IPC } from '../shared/ipc';
import type { QuizReviewItem } from '../shared/types';
import { DEFAULT_CLICKY_ID } from '../shared/clickys';
import { addReview, applyQuiz, quizFooter, quizPrompt, resolveReview, type ParsedQuiz, type QuizState, type ReviewItem } from './quiz-tags';
import { getSettings } from './settings-store';
import { sendToSettings } from './settings-window';
import { log } from './log';

/** a quiz waits this long for an answer */
const QUIZ_TIMEOUT_MS = 30 * 60_000;

interface Live {
  state: QuizState;
  clickyId: string;
  overlay: BrowserWindow | null;
  timer: NodeJS.Timeout;
}

let live: Live | null = null;

/* ───────── review store ───────── */

interface StoreFile {
  version: 1;
  clickys: Record<string, { review: ReviewItem[]; history: { at: number; right: number; total: number }[] }>;
}

let cache: StoreFile | null = null;
const file = (): string => path.join(app.getPath('userData'), 'quiz.json');
const scope = (id?: string): string => {
  const c = id || getSettings().activeClicky || DEFAULT_CLICKY_ID;
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(c) ? c : DEFAULT_CLICKY_ID;
};

function load(): StoreFile {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<StoreFile>;
    const clickys: StoreFile['clickys'] = {};
    for (const [id, v] of Object.entries(raw.clickys ?? {})) {
      const review = Array.isArray(v?.review) ? v.review.filter((r): r is ReviewItem => !!r && typeof r.text === 'string' && typeof r.misses === 'number' && typeof r.lastMissedAt === 'number') : [];
      const history = Array.isArray(v?.history) ? v.history.filter((h) => h && typeof h.right === 'number' && typeof h.total === 'number').slice(-50) : [];
      clickys[id] = { review, history };
    }
    cache = { version: 1, clickys };
  } catch {
    cache = { version: 1, clickys: {} };
  }
  return cache;
}

function save(): void {
  const data = load();
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    const tmp = `${file()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file());
  } catch (err) {
    log('quiz', 'could not save quiz.json:', err);
  }
}

function entry(id: string): StoreFile['clickys'][string] {
  const d = load();
  return (d.clickys[id] ??= { review: [], history: [] });
}

function changed(id: string): void {
  if (id === scope()) sendToSettings(IPC.quizReviewChanged, listReview());
}

export function listReview(clickyId?: string): QuizReviewItem[] {
  return entry(scope(clickyId)).review.map((r) => ({ ...r }));
}

export function clearReview(clickyId?: string): void {
  const id = scope(clickyId);
  entry(id).review = [];
  save();
  changed(id);
  log('quiz', `review list cleared (${id})`);
}

export function removeReview(text: unknown, clickyId?: string): QuizReviewItem[] {
  const id = scope(clickyId);
  if (typeof text === 'string') {
    const e = entry(id);
    e.review = e.review.filter((r) => r.text !== text);
    save();
    changed(id);
  }
  return listReview(id);
}

/* ───────── the live quiz ───────── */

export function quizRunningIn(chatId: string | null | undefined): boolean {
  return !!live && !!chatId && live.state.chatId === chatId;
}

/** The test hook / logs: what's running. */
export function quizSnapshot(): QuizState | null {
  return live ? { ...live.state, missed: [...live.state.missed] } : null;
}

function stop(reason: string): void {
  if (!live) return;
  clearTimeout(live.timer);
  log('quiz', `ended (${reason}) at question ${live.state.n} of ${live.state.total}, ${live.state.right} right, ${live.state.wrong} wrong`);
  live = null;
}

/**
 * After a reply in `chatId` (its quiz tags, if any): update the score, save missed items, and
 * return the bubble footer and whether the bubble should stay up for the answer.
 */
export function quizAfterReply(chatId: string, tags: ParsedQuiz | null, reply: string, clickyId: string, overlay: BrowserWindow | null): { step: string; hold: boolean } | null {
  const running = live && live.state.chatId === chatId ? live.state : null;
  if (!tags) {
    // a reply in the quiz chat without any quiz tag: they moved on
    if (running) stop('moved on');
    return null;
  }
  const res = applyQuiz(running, tags, reply, chatId);
  const id = scope(clickyId);
  if (res.missed) {
    const e = entry(id);
    e.review = addReview(e.review, res.missed);
    save();
    changed(id);
  }
  if (res.reviewed) {
    const e = entry(id);
    const next = resolveReview(e.review, res.reviewed);
    if (next.length !== e.review.length) {
      e.review = next;
      save();
      changed(id);
      log('quiz', 'a review item was answered right');
    }
  }
  if (res.event === 'ended') {
    if (res.score?.total) {
      entry(id).history = [...entry(id).history, { at: Date.now(), right: res.score.right, total: res.score.total }].slice(-50);
      save();
    }
    log('quiz', `finished: ${res.score?.right ?? 0} of ${res.score?.total ?? 0} right`);
    if (live) clearTimeout(live.timer);
    live = null;
    return { step: quizFooter(res), hold: false };
  }
  if (!res.state) return null;
  if (live) clearTimeout(live.timer);
  live = { state: res.state, clickyId: id, overlay, timer: setTimeout(() => stop('timeout'), QUIZ_TIMEOUT_MS) };
  log('quiz', `${res.event}: question ${res.state.n} of ${res.state.total}, score ${res.state.right}/${res.state.right + res.state.wrong}${res.missed ? ' (missed one, saved for review)' : ''}`);
  return { step: quizFooter(res), hold: !res.state.graded };
}

/** Esc / the bubble's ×: end the running quiz. Returns its chat and overlay, or null. */
export function quizEscape(): { chatId: string; overlay: BrowserWindow | null } | null {
  if (!live) return null;
  const out = { chatId: live.state.chatId, overlay: live.overlay };
  stop('escape');
  return out;
}

/** The system prompt parts (stable: protocol + review items; dynamic: the live score in this chat). */
export function quizPromptParts(clickyId: string | undefined, chatId: string | null | undefined): { stable: string; dynamic: string } {
  const id = scope(clickyId);
  return quizPrompt(entry(id).review, live && chatId && live.state.chatId === chatId ? live.state : null);
}

export function registerQuizIpc(): void {
  ipcMain.handle(IPC.quizReviewList, () => listReview());
  ipcMain.handle(IPC.quizReviewClear, () => clearReview());
  ipcMain.handle(IPC.quizReviewRemove, (_e, text: unknown) => removeReview(text));
}
