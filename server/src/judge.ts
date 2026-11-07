// The emergency judge: an open model on Workers AI decides whether a mid-lock "I need my phone" is real.
import { localParts, nightStart } from "./logic.ts";

export type Appeal = { at: number; reason: string; approved: boolean; minutes: number; reply: string };
export type Verdict = Pick<Appeal, "approved" | "minutes" | "reply">;

// GPT-OSS 120B: in a benchmark of five Workers AI models it was the strictest and the fastest (2-5 s).
// DeepSeek V4 Pro took 12-24 s, longer than the phone would wait.
export const MODEL = "@cf/openai/gpt-oss-120b";

const SYSTEM = `You decide whether to lift someone's overnight phone-and-computer lock early. They set the lock themselves, while rested, so that at night their devices stop being useful and they go to sleep. They've already used tonight's two 15 minute breaks, so you're the last way out. The rested version of them wants you to be fair: yes to a real need, no to an impulse.

Say yes when there's a concrete task that has to happen before the lock ends and needs the phone or computer itself:
- work that is actually on fire: an outage or failing production system, an on-call page, a deploy or rollback only they can do
- getting home safely: booking or finding a ride, a driver who can't find them
- money or access that can't wait: a one-time or two-factor code, a payment, a booking that closes tonight
- someone who needs them right now and can only reach them in a blocked app

Say no to anything that can wait until the lock ends or is just wanting the phone: social media, videos, news, email, chats, browsing, looking something up, not being able to sleep, boredom, "just checking", and deadlines in the morning or later.

How to judge:
- You can't verify anything, so never ask for proof and never say no because something can't be verified. Judge whether the story is specific and hangs together. Swearing, typos and panic are normal at 2am, not signs of lying.
- Calls and texts keep working during the lock. If the whole problem is reaching a person, say no and tell them to call or text. If the task itself needs an app or the computer (deploying, paying, booking, a ride app), a call doesn't solve it, so don't send them to one.
- The request holds everything they've written tonight, oldest first; later messages add detail to the same situation, so judge it all as one story. What should make you suspicious is the same kind of emergency on other nights this week, above all one you already let them out for: a story that keeps coming back night after night is how a tired person games you. Say no to it unless something is clearly new, and say that's why. Details that contradict each other count the same way.
- A vague ask ("emergency", "something important") gets a no, with what you'd need to hear.

If you approve, give the shortest window that covers the task: 5 to 30 minutes, usually 10 to 15, longer only for real work like a deploy. Reply in one or two plain sentences, like a fair friend. If you say no, say why and what would change your mind.`;

const SCHEMA = {
  type: "object",
  properties: {
    approved: { type: "boolean" },
    minutes: { type: "integer", description: "Unlock length if approved (5-30), else 0" },
    reply: { type: "string", description: "One or two sentences to the person" },
  },
  required: ["approved", "minutes", "reply"],
  additionalProperties: false,
};

export function appealPrompt(reason: string, earlier: Appeal[], now: number, lockEnds: number, tz: string) {
  const t = (ms: number) => { const p = localParts(ms, tz); return `${p.date} ${p.time}`; };
  // Tonight's messages go in as one request: shown an earlier "denied" tonight, the model calls the follow-up a repeat
  // and says no again. Other nights keep their verdicts, since a made-up emergency shows up as one that keeps coming back.
  const since = nightStart(tz, now);
  const before = earlier.filter((a) => a.at < since);
  const tonight = [...earlier.filter((a) => a.at >= since).map((a) => `[${localParts(a.at, tz).time}] ${a.reason}${a.approved ? ` (you let them out for ${a.minutes} min after this)` : ""}`), `[${localParts(now, tz).time}] ${reason}`];
  const past = before.length
    ? before.map((a) => `- ${t(a.at)}: "${a.reason}" → ${a.approved ? `approved for ${a.minutes} min` : "denied"}`).join("\n")
    : "none";
  return `It's ${t(now)} where they are; the lock ends at ${localParts(lockEnds, tz).time}.
Requests on other nights this week:
${past}

Their request tonight, in their words, oldest message first:
<request>
${tonight.join("\n")}
</request>`;
}

type ChatOut = { choices?: { message?: { content?: string | null } }[] };

export async function judge(ai: Ai, reason: string, earlier: Appeal[], now: number, lockEnds: number, tz: string): Promise<Verdict> {
  // GPT-OSS now and then derails into its own reasoning instead of JSON. Ask once more, then throw: the caller
  // answers 502 and doesn't log it, so a broken reply never uses up one of the night's asks.
  for (let attempt = 0; ; attempt++) {
    // the model is newer than the installed binding types, hence the cast
    const res = (await ai.run(MODEL as Parameters<Ai["run"]>[0], {
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: appealPrompt(reason, earlier, now, lockEnds, tz) }],
      response_format: { type: "json_schema", json_schema: { name: "verdict", schema: SCHEMA, strict: true } },
      reasoning_effort: "low",
      max_tokens: 2000,
    } as never)) as ChatOut;
    const content = res.choices?.[0]?.message?.content ?? "";
    let v: Verdict | null = null;
    try { v = JSON.parse(content); } catch { /* derailed */ }
    if (v && typeof v.approved === "boolean") {
      return v.approved
        ? { approved: true, minutes: Math.min(30, Math.max(5, Math.round(v.minutes))), reply: v.reply }
        : { approved: false, minutes: 0, reply: v.reply };
    }
    if (attempt === 1) throw new Error(`no verdict: ${content.slice(0, 200)}`);
  }
}
