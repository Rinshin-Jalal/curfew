// Sync only. One Durable Object holds the state and every device's socket; devices enforce on their own.
import { DurableObject } from "cloudflare:workers";
import type { SleepState } from "../../shared/sleep.ts";
import { emergency, initialState, localParts, lockedUntil, put, tap, unlock, type Put, appealBlocked, breaksTonight, BREAKS_PER_NIGHT, nightStart } from "./logic.ts";
import { judge, type Appeal } from "./judge.ts";

export interface Env {
  SLEEP: DurableObjectNamespace<SleepRoom>;
  APP_TOKEN: string;
  AI: Ai; // Workers AI: the emergency judge
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export class SleepRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // clients ping every 30s; answered without waking the object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async load() {
    return (await this.ctx.storage.get<SleepState>("state")) ?? initialState(Date.now());
  }

  async commit(s: SleepState) {
    await this.ctx.storage.put("state", s);
    const msg = JSON.stringify(s);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch { /* closing; it reconnects and GETs */ }
    }
    return s;
  }

  async fetch(req: Request) {
    const path = new URL(req.url).pathname;
    const st = await this.load();
    const body = async () => (await req.json().catch(() => ({}))) as Record<string, unknown>;

    if (path === "/sleep/stream") {
      if (req.headers.get("upgrade") !== "websocket") return json({ error: "expected websocket" }, 426);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify(st));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (path === "/sleep" && req.method === "GET") return json(st);
    if (path === "/sleep" && req.method === "PUT") {
      const r = await put(st, (await body()) as Put, Date.now());
      return "state" in r ? json(await this.commit(r.state)) : json({ error: r.error }, r.status);
    }
    if (path === "/sleep/tap" && req.method === "POST") {
      if (!st.phraseHash) return json({ error: "set an unlock phrase first" }, 409); // nothing to enforce, nothing to remember
      return json(await this.commit(tap(st, Date.now(), (await body()).until)));
    }
    if (path === "/sleep/unlock" && req.method === "POST") {
      if (!st.phraseHash) return json({ error: "no phrase set" }, 409);
      // the words are new every time and only the device that showed them can check the typing
      const now = Date.now();
      if (!lockedUntil(st, st.tz, now)) return json({ error: "not locked" }, 409);
      const next = unlock(st, now);
      if (!next) return json({ error: `That's both breaks for tonight. The lock stays until ${localParts(lockedUntil(st, st.tz, now)!, st.tz).time}.` }, 429);
      return json(await this.commit(next));
    }
    if (path === "/sleep/appeal" && req.method === "POST") return this.appeal(st, String((await body()).reason ?? ""));
    return json({ error: "not found" }, 404);
  }

  /** After both breaks, an open model on Workers AI decides if it's real. One ask per 10 minutes, 3 a night, and it sees the past week. */
  async appeal(st: SleepState, raw: string) {
    const now = Date.now();
    const lockEnds = lockedUntil(st, st.tz, now);
    if (!lockEnds) return json({ error: "Nothing is locked right now." }, 409);
    const reason = raw.trim().slice(0, 1000);
    if (reason.length < 10) return json({ error: "Say what's happening and why it can't wait." }, 400);
    const log = (await this.ctx.storage.get<Appeal[]>("appeals")) ?? [];
    const blocked = appealBlocked(log, now, BREAKS_PER_NIGHT - breaksTonight(st, now), nightStart(st.tz, now));
    if (blocked) return json({ error: blocked }, 429);
    // the judge sees the past week, so a story that keeps coming back, or keeps changing, gets caught
    const week = log.filter((a) => now - a.at < 7 * 24 * 3600_000);
    let v;
    try {
      v = await judge(this.env.AI, reason, week, now, lockEnds, st.tz);
    } catch (e) {
      console.error("judge failed", e);
      return json({ error: "The judge didn't answer. Try again in a minute." }, 502);
    }
    await this.ctx.storage.put("appeals", [...log, { at: now, reason, ...v }].slice(-30));
    if (!v.approved) return json(v);
    return json({ ...v, state: await this.commit(emergency(st, now, v.minutes)) });
  }

  webSocketMessage() { /* nothing but pings, which never get here */ }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== "/sleep" && !url.pathname.startsWith("/sleep/")) return json({ error: "not found" }, 404);
    // single user: every device carries the same token (header, or ?t= for the socket)
    const authed = env.APP_TOKEN && (req.headers.get("authorization") === `Bearer ${env.APP_TOKEN}` || url.searchParams.get("t") === env.APP_TOKEN);
    if (!authed) return json({ error: "unauthorized" }, 401);
    return env.SLEEP.get(env.SLEEP.idFromName("me")).fetch(req);
  },
} satisfies ExportedHandler<Env>;
