// Pure logic: timezone + schedule math and state transitions. No I/O so node --test can run it.
// The Android (Schedule.kt) and Mac (Schedule.swift) copies follow the same rules; keep them in step.
import type { Schedule, SleepState } from "../../shared/sleep.ts";

const H = 3600_000;
const DAY = 24 * H;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a timezone. */
export function localParts(ms: number, tz: string) {
  const p = Object.fromEntries(fmt(tz).formatToParts(ms).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

function offsetAt(ms: number, tz: string) {
  const p = Object.fromEntries(fmt(tz).formatToParts(ms).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(ms / 60000) * 60000;
}

/**
 * The UTC instant for a local date + HH:MM in tz.
 * DST gap (time doesn't exist): shifted forward by the gap. DST overlap: the first occurrence.
 */
export function zonedToUtc(date: string, hhmm: string, tz: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const t1 = guess - offsetAt(guess, tz);
  const t2 = guess - offsetAt(t1, tz);
  const ok = (t: number) => { const l = localParts(t, tz); return l.date === date && l.time === hhmm; };
  if (ok(Math.min(t1, t2))) return Math.min(t1, t2);
  if (ok(Math.max(t1, t2))) return Math.max(t1, t2);
  return Math.max(t1, t2); // in the gap
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Every window from the one that started yesterday to a week out, in order. */
export function windows(s: Schedule, tz: string, now: number) {
  const today = localParts(now, tz).date;
  const out: { start: number; end: number }[] = [];
  for (let i = -1; i <= 7; i++) {
    const d = addDays(today, i);
    if (!s.days.includes(weekday(d))) continue;
    out.push({ start: zonedToUtc(d, s.start, tz), end: zonedToUtc(s.end <= s.start ? addDays(d, 1) : d, s.end, tz) });
  }
  return out;
}

export const windowAt = (s: Schedule, tz: string, now: number) => windows(s, tz, now).find((w) => w.start <= now && now < w.end) ?? null;
export const nextStart = (s: Schedule, tz: string, now: number) => windows(s, tz, now).find((w) => w.start > now)?.start ?? null;

/** The lock that's running, break or not (ms epoch), or null. Nothing is enforced until a phrase exists. */
export function lockUnderway(st: SleepState, tz: string, now: number): number | null {
  if (!st.phraseHash) return null;
  const until = st.activeUntil ? Date.parse(st.activeUntil) : 0;
  const manual = st.mode === "manual" && until > now ? until : 0;
  return Math.max(manual, windowAt(st.schedule, tz, now)?.end ?? 0) || null;
}

/** Locked until when (ms epoch), or null: the lock underway, unless you're on a break from it. */
export function lockedUntil(st: SleepState, tz: string, now: number): number | null {
  return onBreak(st, now) ? null : lockUnderway(st, tz, now);
}

export const onBreak = (st: SleepState, now: number) => !!st.breakUntil && Date.parse(st.breakUntil) > now;

/** SLEEP tapped without an explicit end: the coming 06:00 if it's within 12h, else 8h from now. */
export function tapUntil(s: Schedule, tz: string, now: number) {
  const end = windowAt(s, tz, now)?.end ?? windows(s, tz, now).find((w) => w.start > now)?.end;
  return end && end - now <= 12 * H ? end : now + 8 * H;
}

export const initialState = (now: number): SleepState => ({
  userId: 1, mode: "scheduled", activeUntil: null,
  schedule: { start: "00:00", end: "06:00", days: [0, 1, 2, 3, 4, 5, 6] },
  tz: "UTC", allowlist: [], earlyUnlocks: 0, emergencyUnlocks: 0, phrase: null, phraseSalt: null, phraseHash: null,
  updatedAt: new Date(now).toISOString(),
});

export const APPEAL_COOLDOWN_MS = 10 * 60_000;
export const ASKS_PER_NIGHT = 3;

/** When tonight started: the latest local noon, so one night's breaks and asks never spill into the next lock. */
export function nightStart(tz: string, now: number) {
  const { date, time } = localParts(now, tz);
  const day = time >= "12:00" ? date : new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return zonedToUtc(day, "12:00", tz);
}

/**
 * Why the judge won't even hear this appeal, or null. Tonight began at `since` (see nightStart).
 * The typed breaks come first; after those the judge decides, each ask on its merits.
 */
export function appealBlocked(log: { at: number; approved: boolean }[], now: number, breaksLeft: number, since: number): string | null {
  if (breaksLeft > 0) return `Type the words for a break first (${breaksLeft} left tonight). The judge is for after those.`;
  const night = log.filter((a) => a.at >= since);
  if (night.length >= ASKS_PER_NIGHT) return `That's ${ASKS_PER_NIGHT} asks tonight, no more. The lock stays.`;
  const last = log.at(-1);
  if (last && now - last.at < APPEAL_COOLDOWN_MS) return `The judge already ruled. Ask again in ${Math.ceil((last.at + APPEAL_COOLDOWN_MS - now) / 60_000)} min.`;
  return null;
}

export const BREAK_MIN = 15; // a phrase unlock is a break this long
export const BREAKS_PER_NIGHT = 2;

/** The judge said yes: a break of that many minutes, then the lock is back. Doesn't touch the shame counter. */
export function emergency(st: SleepState, now: number, minutes: number): SleepState {
  return { ...st, breakUntil: iso(now + minutes * 60_000), emergencyUnlocks: (st.emergencyUnlocks ?? 0) + 1, updatedAt: iso(now) };
}

/** Phrase breaks started in the last 12 hours. */
export const breaksTonight = (st: SleepState, now: number) => (st.breaks ?? []).filter((t) => Date.parse(t) >= nightStart(st.tz, now)).length;

const iso = (ms: number) => new Date(ms).toISOString();

export function tap(st: SleepState, now: number, requested?: unknown): SleepState {
  const r = typeof requested === "string" ? Date.parse(requested) : NaN;
  let until = r > now && r <= now + DAY ? r : tapUntil(st.schedule, st.tz, now);
  // a tap never shortens a lock that's already running, and it ends a break
  if (st.mode === "manual" && st.activeUntil) until = Math.max(until, Date.parse(st.activeUntil));
  return { ...st, mode: "manual", activeUntil: iso(until), breakUntil: null, updatedAt: iso(now) };
}

/** Call only after the phrase checked out. A 15 minute break that counts, at most 2 a night; null when they're used up. */
export function unlock(st: SleepState, now: number): SleepState | null {
  if (breaksTonight(st, now) >= BREAKS_PER_NIGHT) return null;
  return {
    ...st, breakUntil: iso(now + BREAK_MIN * 60_000), breaks: [...(st.breaks ?? []), iso(now)].slice(-10),
    earlyUnlocks: st.earlyUnlocks + 1, updatedAt: iso(now),
  };
}

export async function hashPhrase(salt: string, phrase: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + phrase));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function phraseOk(st: SleepState, phrase: unknown) {
  return !!st.phraseHash && typeof phrase === "string" && (await hashPhrase(st.phraseSalt ?? "", phrase)) === st.phraseHash;
}

export const MIN_PHRASE = 40;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID = /^[A-Za-z0-9_.-]{1,200}$/;

export type Put = { schedule?: Schedule; allowlist?: string[]; tz?: string; phrase?: string; currentPhrase?: string };

/** Which minutes of a wall-clock week a schedule locks (index = day * 1440 + minute). */
function weekMask(s: Schedule) {
  const m = new Uint8Array(7 * 1440);
  const min = (hhmm: string) => { const [h, mi] = hhmm.split(":").map(Number); return h * 60 + mi; };
  const a = min(s.start), e = min(s.end), b = e <= a ? e + 1440 : e;
  for (const d of s.days) for (let t = a; t < b; t++) m[(d * 1440 + t) % m.length] = 1;
  return m;
}

/** True if the new schedule frees any minute the old one locked. */
export function loosens(before: Schedule, after: Schedule) {
  const x = weekMask(before), y = weekMask(after);
  return x.some((v, i) => v === 1 && y[i] === 0);
}

/**
 * PUT /sleep. Mode is not settable here (tap and unlock own it), nothing changes while locked, and only
 * loosening costs the phrase: dropping locked minutes or adding an allowed app. Tightening is free.
 */
export async function put(st: SleepState, b: Put, now: number): Promise<{ state: SleepState } | { error: string; status: number }> {
  // a break doesn't count as unlocked here: with the phrase on screen it would be a way to delete the night
  const until = lockUnderway(st, st.tz, now);
  if (until) return { error: `Rules can't change during a lock or a break. Try again after ${localParts(until, st.tz).time}.`, status: 423 };

  const next = { ...st, updatedAt: iso(now) };
  if (b.tz !== undefined) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: b.tz }); } catch { return { error: "bad tz", status: 400 }; }
    next.tz = b.tz;
  }
  if (b.schedule !== undefined) {
    const s = b.schedule;
    if (!s || !HHMM.test(s.start) || !HHMM.test(s.end) || !Array.isArray(s.days)
      || s.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return { error: "Times are 24-hour, like 01:30 or 05:14", status: 400 };
    next.schedule = { start: s.start, end: s.end, days: [...new Set(s.days)].sort() };
  }
  if (b.allowlist !== undefined) {
    if (!Array.isArray(b.allowlist) || b.allowlist.length > 300 || b.allowlist.some((x) => typeof x !== "string" || !ID.test(x))) {
      return { error: "allowlist must be package names / bundle ids", status: 400 };
    }
    next.allowlist = [...new Set(b.allowlist)];
  }
  if (b.phrase !== undefined) {
    if (typeof b.phrase !== "string" || b.phrase.length < MIN_PHRASE || b.phrase.length > 200) {
      return { error: `phrase must be at least ${MIN_PHRASE} characters`, status: 400 };
    }
    next.phraseSalt = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");
    next.phraseHash = await hashPhrase(next.phraseSalt, b.phrase);
    next.phrase = b.phrase;
    // the first phrase arms the schedule; it must not wake up some old tap made while nothing was enforced
    if (!st.phraseHash) Object.assign(next, { mode: "scheduled", activeUntil: null });
  }
  // an empty list means "this device's defaults", so the first save can't be judged and goes through
  const loosening = (b.schedule !== undefined && loosens(st.schedule, next.schedule))
    || (b.allowlist !== undefined && st.allowlist.length > 0 && next.allowlist.some((x) => !st.allowlist.includes(x)));
  if (loosening && st.phraseHash && !(await phraseOk(st, b.currentPhrase))) return { error: "that loosens the lock: type the phrase", status: 403 };
  return { state: next };
}
