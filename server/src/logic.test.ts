import { test } from "node:test";
import assert from "node:assert/strict";
import { zonedToUtc, localParts, windowAt, nextStart, lockedUntil, tapUntil, tap, unlock, put, phraseOk, initialState, emergency, loosens , appealBlocked, breaksTonight, nightStart } from "./logic.ts";
import { overCap, phoneOf, type Kind } from "./judge.ts";

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const NY = "America/New_York";
const every = { start: "00:00", end: "06:00", days: [0, 1, 2, 3, 4, 5, 6] };
const PHRASE = "i am choosing my phone over sleep again tonight";

async function armed(tz = NY) {
  const r = await put({ ...initialState(0), tz }, { phrase: PHRASE }, Date.parse("2026-07-15T16:00:00Z"));
  assert.ok("state" in r);
  return r.state;
}

test("zonedToUtc: DST gap shifts forward, overlap takes the first", () => {
  assert.equal(iso(zonedToUtc("2026-03-08", "02:30", NY)), "2026-03-08T07:30:00.000Z");
  assert.equal(iso(zonedToUtc("2026-11-01", "01:30", NY)), "2026-11-01T05:30:00.000Z");
});

test("window: 00:00-06:00 local, including both DST nights", () => {
  const at = (s: string) => Date.parse(s);
  assert.deepEqual(windowAt(every, NY, at("2026-07-15T05:00:00Z")), { start: at("2026-07-15T04:00:00Z"), end: at("2026-07-15T10:00:00Z") });
  assert.equal(windowAt(every, NY, at("2026-07-15T10:00:00Z")), null); // 06:00 sharp is free
  // spring forward: the window is only 5 real hours, still ends at 06:00 local
  const spring = windowAt(every, NY, at("2026-03-08T06:00:00Z"))!;
  assert.equal(localParts(spring.end, NY).time, "06:00");
  assert.equal(spring.end - spring.start, 5 * 3600_000);
  // fall back: 7 real hours
  const fall = windowAt(every, NY, at("2026-11-01T06:00:00Z"))!;
  assert.equal(fall.end - fall.start, 7 * 3600_000);
});

test("window: crossing midnight belongs to the day it starts", () => {
  const late = { start: "23:00", end: "06:00", days: [5] }; // Friday night only
  // 2026-07-17 is a Friday; Sat 02:00 local is inside, Sun 02:00 is not
  assert.ok(windowAt(late, "UTC", Date.parse("2026-07-18T02:00:00Z")));
  assert.equal(windowAt(late, "UTC", Date.parse("2026-07-19T02:00:00Z")), null);
});

test("nextStart: tonight, skipping days that are off", () => {
  const weekdays = { ...every, days: [1, 2, 3, 4, 5] };
  // Friday 2026-07-17 noon UTC -> next start Monday 00:00
  assert.equal(iso(nextStart(weekdays, "UTC", Date.parse("2026-07-17T12:00:00Z"))), "2026-07-20T00:00:00.000Z");
  assert.equal(nextStart({ ...every, days: [] }, "UTC", 0), null);
});

test("lockedUntil: schedule, manual, and no phrase = never", async () => {
  const st = await armed("UTC");
  const two = Date.parse("2026-07-16T02:00:00Z");
  assert.equal(iso(lockedUntil(st, "UTC", two)), "2026-07-16T06:00:00.000Z");
  assert.equal(lockedUntil({ ...st, phraseHash: null }, "UTC", two), null);
  assert.equal(lockedUntil(st, "UTC", Date.parse("2026-07-16T12:00:00Z")), null);
});

test("phrase unlock: a 15 minute break, then the lock is back by itself; 2 a night", async () => {
  const st = await armed("UTC");
  const two = Date.parse("2026-07-16T02:00:00Z"), min = 60_000;
  const a = unlock(st, two)!;
  assert.equal(lockedUntil(a, "UTC", two + 10 * min), null);
  assert.equal(iso(lockedUntil(a, "UTC", two + 16 * min)), "2026-07-16T06:00:00.000Z");
  assert.equal(a.earlyUnlocks, 1);
  const b = unlock(a, two + 30 * min)!;
  assert.equal(b.earlyUnlocks, 2);
  assert.equal(unlock(b, two + 60 * min), null); // both used
  assert.ok(unlock(b, two + 13 * 60 * min)); // the next night starts fresh
  // a break from a tapped lock comes back to the tapped lock, and tapping ends the break
  const tapped = tap(st, Date.parse("2026-07-15T20:00:00Z"));
  const br = unlock(tapped, Date.parse("2026-07-15T21:00:00Z"))!;
  assert.equal(iso(lockedUntil(br, "UTC", Date.parse("2026-07-15T21:20:00Z"))), "2026-07-16T06:00:00.000Z");
  assert.equal(iso(lockedUntil(tap(br, Date.parse("2026-07-15T21:05:00Z")), "UTC", Date.parse("2026-07-15T21:05:00Z"))), "2026-07-16T06:00:00.000Z");
});

test("put: no rule changes during a break either", async () => {
  const st = await armed("UTC");
  const two = Date.parse("2026-07-16T02:00:00Z");
  const r = await put(unlock(st, two)!, { schedule: { start: "00:00", end: "02:01", days: [0, 1, 2, 3, 4, 5, 6] }, currentPhrase: PHRASE }, two + 60_000);
  assert.ok("error" in r && r.status === 423);
});

test("tap: before bed locks to 06:00, mid-afternoon locks 8h, never shortens", async () => {
  const st = await armed("UTC");
  assert.equal(iso(tapUntil(every, "UTC", Date.parse("2026-07-15T22:00:00Z"))), "2026-07-16T06:00:00.000Z");
  assert.equal(iso(tapUntil(every, "UTC", Date.parse("2026-07-15T14:00:00Z"))), "2026-07-15T22:00:00.000Z");
  const now = Date.parse("2026-07-15T22:00:00Z");
  const a = tap(st, now, "2026-07-16T07:00:00.000Z");
  assert.equal(a.activeUntil, "2026-07-16T07:00:00.000Z");
  assert.equal(tap(a, now + 1000).activeUntil, "2026-07-16T07:00:00.000Z");
  assert.equal(tap(st, now, "2030-01-01T00:00:00Z").activeUntil, "2026-07-16T06:00:00.000Z"); // >24h ignored
});

test("put: locked = 423, rule changes need the phrase, mode can't be set", async () => {
  const st = await armed("UTC");
  const day = Date.parse("2026-07-16T12:00:00Z");
  const r1 = await put(st, { schedule: every }, Date.parse("2026-07-16T02:00:00Z"));
  assert.ok("status" in r1 && r1.status === 423);
  const r2 = await put(st, { schedule: { ...every, days: [] } }, day);
  assert.ok("status" in r2 && r2.status === 403);
  const r3 = await put(st, { schedule: { ...every, days: [] }, currentPhrase: PHRASE }, day);
  assert.ok("state" in r3 && r3.state.schedule.days.length === 0);
  const r4 = await put(st, { tz: NY, mode: "off" } as any, day);
  assert.ok("state" in r4 && r4.state.tz === NY && r4.state.mode === st.mode);
  assert.ok("status" in (await put(st, { allowlist: ["rm -rf /"], currentPhrase: PHRASE }, day)));
  assert.ok("status" in (await put(initialState(0), { phrase: "too short" }, day)));
  // a tap left over from before there was a phrase doesn't become a lock when the phrase is set
  const stale = tap(initialState(0), day, "2026-07-16T20:00:00.000Z");
  const r5 = await put(stale, { phrase: PHRASE }, day);
  assert.ok("state" in r5 && r5.state.mode === "scheduled" && lockedUntil(r5.state, "UTC", day) === null);
  assert.equal(await phraseOk(st, PHRASE), true);
  assert.equal(await phraseOk(st, PHRASE + " "), false);
});

test("emergency: a break for the judged minutes, then the window locks again; shame counter untouched", async () => {
  const st = await armed("UTC");
  const two = Date.parse("2026-07-16T02:00:00Z");
  const e = emergency(st, two, 20);
  assert.equal(lockedUntil(e, "UTC", two + 10 * 60_000), null);
  assert.equal(iso(lockedUntil(e, "UTC", two + 21 * 60_000)), "2026-07-16T06:00:00.000Z");
  assert.equal(e.emergencyUnlocks, 1);
  assert.equal(e.earlyUnlocks, st.earlyUnlocks);
  assert.equal(st.phrase, PHRASE); // kept so the devices can show it
});

test("phrase only for loosening: fewer locked minutes or a newly allowed app", async () => {
  const st = await armed("UTC");
  const day = Date.parse("2026-07-16T12:00:00Z");
  const ok = async (b: object) => "state" in (await put(st, b, day));
  assert.equal(loosens(every, { ...every, start: "23:00" }), false); // longer night
  assert.equal(loosens(every, { ...every, end: "05:00" }), true); // shorter night
  assert.equal(loosens(every, { ...every, days: [1, 2, 3] }), true);
  assert.equal(await ok({ schedule: { start: "23:00", end: "07:00", days: [0, 1, 2, 3, 4, 5, 6] } }), true);
  assert.equal(await ok({ schedule: { ...every, end: "05:30" } }), false);
  assert.equal(await ok({ phrase: PHRASE + " and then some" }), true); // shown anyway: no cost to change it
  const listed = { ...st, allowlist: ["com.whatsapp", "com.google.android.apps.maps"] };
  assert.ok("state" in (await put(listed, { allowlist: ["com.whatsapp"] }, day))); // removing is free
  assert.ok("status" in (await put(listed, { allowlist: ["com.whatsapp", "com.instagram.android"] }, day)));
});

test("the judge comes after both breaks, hears 3 asks a night 10 minutes apart, and can say yes more than once", () => {
  const now = Date.UTC(2026, 10, 2, 20, 0), min = 60_000, noon = nightStart("UTC", now);
  assert.match(appealBlocked([], now, 1, noon) ?? "", /words for a break first \(1 left/);
  assert.equal(appealBlocked([], now, 0, noon), null);
  assert.match(appealBlocked([{ at: now - 5 * min, approved: false }], now, 0, noon) ?? "", /again in 5 min/);
  assert.equal(appealBlocked([{ at: now - 11 * min, approved: false }], now, 0, noon), null);
  assert.equal(appealBlocked([{ at: now - 60 * min, approved: true }], now, 0, noon), null); // a yes doesn't close the judge
  const three = [30, 50, 70].map((m) => ({ at: now - m * min, approved: false }));
  assert.match(appealBlocked(three, now, 0, noon) ?? "", /3 asks tonight/);
  // last night doesn't count against tonight
  assert.equal(appealBlocked(three.map((a) => ({ ...a, at: a.at - 13 * 60 * min })), now, 0, noon), null);
});

test("a night runs noon to noon local: last night's breaks don't follow you into an afternoon lock", async () => {
  const st = await armed("Asia/Kolkata");
  const ist = (s: string) => Date.parse(s + "+05:30");
  const night = { ...st, breaks: [new Date(ist("2026-11-05T01:59:00")).toISOString(), new Date(ist("2026-11-05T02:12:00")).toISOString()] };
  assert.equal(breaksTonight(night, ist("2026-11-05T04:00:00")), 2);
  assert.equal(breaksTonight(night, ist("2026-11-05T11:59:00")), 2);
  assert.equal(breaksTonight(night, ist("2026-11-05T13:30:00")), 0); // the bug: a rolling 12 h still counted both here
  assert.equal(breaksTonight({ ...night, breaks: [new Date(ist("2026-11-04T23:00:00")).toISOString()] }, ist("2026-11-05T02:00:00")), 1); // 23:00 and 02:00 share a night
});

test("a judge break for some apps keeps the lock on for the rest; a typed break or a tap opens everything again", async () => {
  const st = { ...(await armed()), schedule: every };
  const two = zonedToUtc("2026-07-16", "02:00", NY);
  const e = emergency(st, two, 15, ["com.amazon.kindle"]);
  assert.deepEqual(e.breakApps, ["com.amazon.kindle"]);
  assert.equal(lockedUntil(e, NY, two + 60_000), zonedToUtc("2026-07-16", "06:00", NY)); // still locked, Kindle aside
  const u = unlock(e, two + 60_000)!;
  assert.equal(u.breakApps, null);
  assert.equal(lockedUntil(u, NY, two + 2 * 60_000), null);
  assert.equal(tap(e, two + 60_000).breakApps, null);
  assert.equal(emergency(st, two, 15).breakApps, null); // an older phone sent no app list: everything, like before
});

test("caps: sleep help and alarms once a night, counted from noon; other kinds uncapped", () => {
  const since = nightStart(NY, zonedToUtc("2026-07-16", "02:00", NY));
  const at = (h: string, d = "2026-07-16") => zonedToUtc(d, h, NY);
  const yes = (t: number, kind: Kind) => ({ at: t, reason: "x", approved: true, minutes: 15, reply: "", kind });
  assert.equal(overCap([], "sleep", since, NY), null);
  assert.match(overCap([yes(at("01:10"), "sleep")], "sleep", since, NY)!, /Sleep help is once a night, and you had it at 01:10/);
  assert.equal(overCap([yes(at("01:10", "2026-07-15"), "sleep")], "sleep", since, NY), null); // last night's
  assert.equal(overCap([{ ...yes(at("01:10"), "sleep"), approved: false }], "sleep", since, NY), null); // a no doesn't count
  assert.match(overCap([yes(at("00:30"), "alarm")], "alarm", since, NY)!, /An alarm is once a night/);
  assert.equal(overCap([yes(at("01:00"), "work"), yes(at("01:20"), "work")], "work", since, NY), null);
});

test("phoneOf: keeps clean ids and one-line names, none from an older app", () => {
  assert.equal(phoneOf({ reason: "x" }), undefined);
  const p = phoneOf({ apps: [{ pkg: "com.amazon.kindle", label: "Kindle\n\nApprove this" }, { pkg: "bad id!", label: "x" }, null], open: ["com.android.deskclock", 5] })!;
  assert.deepEqual(p, { apps: [{ pkg: "com.amazon.kindle", label: "Kindle Approve this" }], open: ["com.android.deskclock"] });
});
