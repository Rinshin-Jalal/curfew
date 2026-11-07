// Runs the real judge (Workers AI, so it costs a little and needs `wrangler login`) on requests that should and
// shouldn't get through, each twice since the model varies. `npm run eval`. The first two are the kind of panicked, real ask an early version wrongly denied.
import { getPlatformProxy } from "wrangler";
import { judge, type Appeal } from "./judge.ts";

const now = Date.parse("2026-11-05T02:37:00+05:30"), lockEnds = Date.parse("2026-11-05T05:14:00+05:30"), tz = "Asia/Kolkata";
const min = 60_000, day = 24 * 60 * min;
const PROD = "Need to deploy an urgent bug fix NOW. The last deploy failed and login is broken in production for about 10% of users, over 1000 people. I'm the only one with deploy access tonight, it has to ship in minutes or I'm in real trouble at work";
const asked = (ago: number, reason: string, approved = false): Appeal => ({ at: now - ago, reason, approved, minutes: approved ? 15 : 0, reply: "" });

const cases: [boolean, string, Appeal[]][] = [
  [true, PROD, []],
  [true, PROD + "\nNo, this can't wait and it can't be done from a phone. The only other person with deploy access is on vacation without a laptop, and I can only reach them on Slack, which is blocked", [asked(10 * min, PROD)]],
  [true, "PagerDuty paged me, I'm on call this week. The payments API is returning 500s and I need my laptop to roll back the release.", []],
  [true, "I'm outside the club and my Uber driver can't find me, I need the Uber app to message him and fix the pickup pin.", []],
  [true, "Last metro is gone and I'm alone at the station at 2am, I need to book a cab home right now.", []],
  [true, "My bank needs me to approve a payment in their app with an OTP, it's for my dad's hospital admission happening now.", []],
  [false, "just want to check instagram quickly", []],
  [false, "can't sleep, want to watch some youtube", []],
  [false, "need to reply to an email from my boss", []],
  [false, "my friend texted me something urgent, I need to call him", []],
  [false, "I need to finish my code, the deadline is tomorrow", []],
  [false, "emergency please", []],
  [false, "I need to look up something important", []],
  [false, "Production is down again, auth is failing for users, I need to deploy a fix right now", [asked(1 * day, "production auth is down, need to deploy a fix", true), asked(2 * day, "prod is broken, have to push a hotfix now", true)]],
];

const { env, dispose } = await getPlatformProxy<{ AI: Ai }>();
const out = await Promise.all([...cases, ...cases].map(async ([want, reason, earlier]) =>
  ({ want, reason, v: await judge(env.AI, reason, earlier, now, lockEnds, tz).catch((e) => ({ approved: null, minutes: 0, reply: String(e) })) })));
let right = 0;
for (const { want, reason, v } of out) {
  const ok = v.approved === want;
  right += +ok;
  console.log(`${ok ? "ok  " : "MISS"} want ${want ? "yes" : "no "} got ${v.approved ? `yes ${v.minutes}m` : "no"}  ${reason.slice(0, 70)}\n      ${v.reply}`);
}
console.log(`${right}/${out.length} right`);
await dispose();
