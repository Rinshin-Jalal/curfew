// The one thing every device agrees on. Devices enforce from their cached copy + their own clock;
// the server only mirrors it so taps, unlocks and the shame counter are shared.

export type Schedule = {
  start: string; // "HH:MM" local
  end: string; // "HH:MM" local; end <= start means the window crosses midnight
  days: number[]; // days a window STARTS on, 0 = Sunday
};

export type SleepState = {
  userId: number;
  // "manual": locked until activeUntil. "scheduled": just follow the schedule. An expired manual is the same as
  // scheduled. ("off" is from before breaks existed and now means scheduled.)
  mode: "off" | "scheduled" | "manual";
  activeUntil: string | null; // ISO
  schedule: Schedule;
  tz: string; // used by the server for taps that don't say until when (iPhone Shortcut)
  allowlist: string[]; // Android package names and Mac bundle ids in one list; each device ignores the other's
  earlyUnlocks: number; // the shame counter
  emergencyUnlocks?: number; // unlocks the AI judge approved
  // Unlocking is a break, never the rest of the night: until breakUntil nothing is enforced, then whatever lock
  // was running (a tap or the night's window) is simply still there.
  breakUntil?: string | null; // ISO
  // set by the judge: the break opens only these (Android package names, "computer" for the Mac). null = everything
  breakApps?: string[] | null;
  breaks?: string[]; // ISO starts of recent phrase breaks, to cap them per night
  phrase?: string | null; // shown on every unlock screen: you don't have to remember it, you have to type it
  phraseSalt: string | null; // hex; devices check sha256(salt + phrase) offline
  phraseHash: string | null; // hex; null = no phrase yet = nothing is enforced
  updatedAt: string; // ISO
};
