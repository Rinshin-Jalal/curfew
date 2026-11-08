// The emergency judge: an open model on Workers AI decides whether a mid-lock "I need my phone" is real.
import { ID, localParts, nightStart } from "./logic.ts";

export const KINDS = ["alarm", "sleep", "work", "ride", "money", "person", "other"] as const;
export type Kind = (typeof KINDS)[number];
/** The most yeses a kind gets per night. In code, so no story talks the judge past it. */
export const CAPS: Partial<Record<Kind, number>> = { alarm: 1, sleep: 1 };
const CAP_NAME: Partial<Record<Kind, string>> = { alarm: "An alarm", sleep: "Sleep help" };

export type PhoneApp = { pkg: string; label: string };
/** What the phone sends: its apps, and the ones usable during the lock anyway. None = an older app, where a yes opens everything. */
export type Phone = { apps: PhoneApp[]; open: string[] };

// apps: what a yes opened (package names, "computer" for the Mac); null = everything
export type Appeal = { at: number; reason: string; approved: boolean; minutes: number; reply: string; kind?: Kind; apps?: string[] | null };
export type Verdict = Pick<Appeal, "approved" | "minutes" | "reply"> & { kind: Kind; apps: string[] | null };

// GPT-OSS 120B: in a benchmark of five Workers AI models it was the strictest and the fastest (2-5 s).
// DeepSeek V4 Pro took 12-24 s, longer than the phone would wait.
export const MODEL = "@cf/openai/gpt-oss-120b";

const SYSTEM = `You decide whether to lift someone's overnight phone-and-computer lock early. They set the lock themselves, while rested, so that at night their devices stop being useful and they go to sleep. They've already used tonight's two 15 minute breaks, so you're the last way out. The rested version of them wants you to be fair: yes to a real need, no to an impulse.

Say yes when there's a concrete task that has to happen before the lock ends and needs the phone or computer itself:
- work that is actually on fire: an outage or failing production system, an on-call page, a deploy or rollback only they can do
- their job at a fixed time inside the lock: a scheduled meeting or call with a client or team, a shift. The lock must never cost them their job.
- getting home safely: booking or finding a ride, a driver who can't find them
- money or access that can't wait: a one-time or two-factor code, a payment, a booking that closes tonight
- someone who needs them right now and can only reach them in a blocked app
- sleep itself, which is the whole point of the lock: setting or fixing an alarm (5 minutes; but if the clock already works during the lock, say no and tell them to open it), or reading a book, sleep sounds or a meditation app because they can't fall asleep (15 to 20 minutes). These are yes even if they ask most nights.

"Do it when the lock ends" is never an answer for something that happens at a fixed time before then (a meeting, a check-in that closes) or has to be ready while they sleep (an alarm): they'll be asleep when the lock ends.

Say no to anything that can wait until the lock ends or is just wanting the phone: social media, videos, news, email, chats, browsing, looking something up, boredom, "just checking" that something is fine when nothing is known to be wrong (a deploy that went out fine, messages, a delivery), and deadlines in the morning or later. Not being able to sleep gets a book or sleep sounds, never videos or feeds. A yes opens only one or two apps, but that doesn't make any of these fine: an email app, a chat, or a feed (Reddit, Instagram, X, YouTube, even "just to read") stays a no even on its own. A story you already let them out for on other nights stays a no too, whatever apps it would take.

A yes opens only the apps you pick from their phone's list, by id. Pick the fewest that cover the task: the book app for a book, the ride app for a ride, Slack for a work page. Match the need to whatever app on the list does it, even if they didn't name it (an airline's app for check-in, a bank's app for a payment). You can open their laptop too: set computer to true when the task needs it (a deploy, a rollback, real work), even if no phone app fits. If they also want something from the no list ("and check my status quick"), open only what the real need takes and say the rest stays locked. Never pick apps that already work during the lock. If nothing on the list fits the need, say no and say what's missing.

Also say what kind of ask it is: alarm, sleep (a book, sleep sounds, meditation), work, ride, money, person (someone who needs them), or other.

How to judge:
- Used-up breaks are never a reason to say no: they're the reason the ask is with you.
- You can't verify anything, so never ask for proof and never say no because something can't be verified. Judge whether the story is specific and hangs together. Swearing, typos and panic are normal at 2am, not signs of lying.
- Calls and texts keep working during the lock. If the whole problem is reaching a person, say no and tell them to call or text. If the task itself needs an app or the computer (deploying, paying, booking, a ride app), a call doesn't solve it, so don't send them to one.
- The request holds everything they've written tonight, oldest first; later messages add detail to the same situation, so judge it all as one story. What should make you suspicious is the same kind of emergency on other nights this week, above all one you already let them out for: a story that keeps coming back night after night is how a tired person games you. Say no to it unless something is clearly new, and say that's why. Sleep help (an alarm, a book, sleep sounds) is exempt: asking for it on many nights is fine, and short asks like "need book cant sleep" are specific enough. Details that contradict each other count the same way.
- A vague ask ("emergency", "something important") gets a no, with what you'd need to hear.

If you approve, give the shortest window that covers the task: 5 to 30 minutes, usually 10 to 15, 5 for an alarm, longer only for real work like a deploy. Reply in one or two plain sentences, like a fair friend. If you say no, say why and what would change your mind.`;

const SCHEMA = {
  type: "object",
  properties: {
    approved: { type: "boolean" },
    minutes: { type: "integer", description: "Unlock length if approved (5-30), else 0" },
    reply: { type: "string", description: "One or two sentences to the person" },
    kind: { type: "string", enum: KINDS },
    apps: { type: "array", items: { type: "string" }, description: "Ids of the phone apps to open if approved, else empty" },
    computer: { type: "boolean", description: "Open their laptop too, if approved" },
  },
  required: ["approved", "minutes", "reply", "kind", "apps", "computer"],
  additionalProperties: false,
};

/** The phone's part of an appeal body, cleaned up, or undefined when it sent none (an older app). */
export function phoneOf(b: Record<string, unknown>): Phone | undefined {
  if (!Array.isArray(b.apps) || !Array.isArray(b.open)) return undefined;
  const apps = (b.apps as Partial<PhoneApp>[]).filter((a) => typeof a?.pkg === "string" && ID.test(a.pkg) && typeof a.label === "string")
    .slice(0, 500).map((a) => ({ pkg: a.pkg!, label: a.label!.replace(/\s+/g, " ").trim().slice(0, 60) }));
  return { apps, open: (b.open as unknown[]).filter((x): x is string => typeof x === "string" && ID.test(x)).slice(0, 300) };
}

/** The phone apps the judge may open: the ones the lock blocks. */
const pickable = (p: Phone) => new Set(p.apps.map((a) => a.pkg).filter((x) => !p.open.includes(x)));

/** Why a yes would go over its kind's nightly cap, or null. */
export function overCap(log: Appeal[], kind: Kind, since: number, tz: string): string | null {
  const cap = CAPS[kind];
  const had = log.filter((a) => a.at >= since && a.approved && a.kind === kind);
  if (cap === undefined || had.length < cap) return null;
  return `${CAP_NAME[kind]} is ${cap === 1 ? "once" : `${cap} times`} a night, and you had it at ${localParts(had.at(-1)!.at, tz).time}.`;
}

export function appealPrompt(reason: string, earlier: Appeal[], now: number, lockEnds: number, tz: string, phone?: Phone) {
  const t = (ms: number) => { const p = localParts(ms, tz); return `${p.date} ${p.time}`; };
  // Tonight's messages go in as one request: shown an earlier "denied" tonight, the model calls the follow-up a repeat
  // and says no again. Other nights keep their verdicts, since a made-up emergency shows up as one that keeps coming back.
  const since = nightStart(tz, now);
  const before = earlier.filter((a) => a.at < since);
  const tonight = [...earlier.filter((a) => a.at >= since).map((a) => `[${localParts(a.at, tz).time}] ${a.reason}${a.approved ? ` (you let them out for ${a.minutes} min after this)` : ""}`), `[${localParts(now, tz).time}] ${reason}`];
  const past = before.length
    ? before.map((a) => `- ${t(a.at)}: "${a.reason}" → ${a.approved ? `approved for ${a.minutes} min` : "denied"}`).join("\n")
    : "";
  const ok = phone && pickable(phone);
  const apps = phone && ok
    ? `Apps on their phone you can open (name: id):
${phone.apps.filter((a) => ok.has(a.pkg)).map((a) => `${a.label}: ${a.pkg}`).join("\n")}
You can also open their laptop: set computer to true.
Already usable during the lock, never pick these: ${phone.apps.filter((a) => phone.open.includes(a.pkg)).map((a) => a.label).join(", ") || "calls and texts"}.`
    : `Their phone didn't send its app list, so a yes opens the whole phone and computer: if they also want something from the no list, say no. Leave apps empty.`;
  return `It's ${t(now)} where they are; the lock ends at ${localParts(lockEnds, tz).time}.
${past ? `Requests on other nights this week. The same kind of emergency you already approved here is a repeat: say no unless something is clearly new. Sleep help like a book, sleep sounds or an alarm never counts as a repeat:
${past}` : "No requests on other nights this week, so nothing tonight is a repeat."}

Their request tonight, in their words, oldest message first:
<request>
${tonight.join("\n")}
</request>

${apps}`;
}

type ChatOut = { choices?: { message?: { content?: string | null } }[] };

export async function judge(ai: Ai, reason: string, earlier: Appeal[], now: number, lockEnds: number, tz: string, phone?: Phone): Promise<Verdict> {
  const ok = phone && pickable(phone);
  // GPT-OSS now and then derails into its own reasoning instead of JSON. Ask once more, then throw: the caller
  // answers 502 and doesn't log it, so a broken reply never uses up one of the night's asks.
  for (let attempt = 0; ; attempt++) {
    // the model is newer than the installed binding types, hence the cast
    const res = (await ai.run(MODEL as Parameters<Ai["run"]>[0], {
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: appealPrompt(reason, earlier, now, lockEnds, tz, phone) }],
      response_format: { type: "json_schema", json_schema: { name: "verdict", schema: SCHEMA, strict: true } },
      reasoning_effort: "low",
      max_tokens: 2000,
    } as never)) as ChatOut;
    const content = res.choices?.[0]?.message?.content ?? "";
    let v: (Omit<Verdict, "apps"> & { apps?: unknown; computer?: boolean }) | null = null;
    try { v = JSON.parse(content); } catch { /* derailed */ }
    const kind = KINDS.includes(v?.kind as Kind) ? v!.kind : "other";
    // only ids it was offered; a yes that names none of them is as broken as no JSON
    const byName = (x: string) => phone?.apps.find((a) => a.label.toLowerCase() === x.toLowerCase())?.pkg ?? x; // now and then it answers with the name
    const apps = ok ? [...new Set((Array.isArray(v?.apps) ? v.apps : []).map(String).map(byName).filter((x) => ok.has(x))), ...(v?.computer ? ["computer"] : [])] : null;
    // a yes that opens nothing means what they need already works (the clock, calls): tell them so
    if (v && v.approved && apps?.length === 0 && attempt === 1) return { approved: false, minutes: 0, reply: "That already works during the lock: open it from the lock screen.", kind, apps: null };
    if (v && typeof v.approved === "boolean" && !(v.approved && apps?.length === 0)) {
      return v.approved
        ? { approved: true, minutes: Math.min(30, Math.max(5, Math.round(v.minutes))), reply: v.reply, kind, apps }
        : { approved: false, minutes: 0, reply: v.reply, kind, apps: null };
    }
    if (attempt === 1) throw new Error(`no verdict: ${content.slice(0, 200)}`);
  }
}
