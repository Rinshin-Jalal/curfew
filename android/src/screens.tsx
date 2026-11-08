import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, AppState, Easing, Pressable, TextInput, useWindowDimensions, View } from "react-native";
import { Sleep, type Perm, type Snapshot, type Update, type Verdict } from "../modules/sleep-native";
import { moon } from "./moon";
import { words } from "./words";
import { C, DAY_NAMES, DAYS, F, Field, Key, Link, Phrase, PhraseInput, Row, Screen, Section, T, cap, fromNow, hhmm, nights, typo } from "./ui";

export type Route = "home" | "schedule" | "allowlist" | "unlock" | "permissions";

export function Home({ snap, go }: { snap: Snapshot; go: (r: Route) => void }) {
  const { state, lockedUntil, nextStart, tapUntil } = snap;
  const onBreak = !!snap.breakEnd;
  const armed = !!state.phraseHash;
  const missing = Object.values(Sleep.permissions()).filter((ok) => !ok).length;
  const s = state.schedule;
  const apps = state.allowlist?.length || snap.defaults.length;
  const early = state.earlyUnlocks ?? 0, judged = state.emergencyUnlocks ?? 0;
  const { width } = useWindowDimensions();
  const tonight = moon();
  const size = width * 0.96;
  // the one entrance on the screen: the moon comes up slowly, once
  const rise = useRef(new Animated.Value(0)).current;
  useEffect(() => { Animated.timing(rise, { toValue: 1, duration: 900, easing: Easing.bezier(0.22, 1, 0.36, 1), useNativeDriver: true }).start(); }, [rise]);

  // the headline is the next thing that happens, the subhead is when and for how long
  const headline = !armed ? "Curfew is off"
    : onBreak ? `On a break until ${hhmm(snap.breakEnd!)}`
    : snap.appBreak ? `${snap.appBreak.labels.join(", ")} open till ${hhmm(snap.appBreak.until)}`
    : lockedUntil ? `Lights on at ${hhmm(lockedUntil)}`
    : nextStart ? `Lights out at ${hhmm(nextStart)}`
    : "No nights scheduled";
  const sub = !armed ? "Pick your nights and save. From then on your phone and Mac lock on schedule"
    : onBreak ? `In ${fromNow(snap.breakEnd!)} the lock comes back by itself. ${snap.breaksLeft ? `${snap.breaksLeft} break${snap.breaksLeft > 1 ? "s" : ""} left tonight` : "After this, only the judge can let you out"}`
    : snap.appBreak && lockedUntil ? `The judge opened just that. Everything else stays locked for ${fromNow(lockedUntil)}`
    : lockedUntil ? `Your phone and Mac are locked for ${fromNow(lockedUntil)}. ${snap.breaksLeft ? `${snap.breaksLeft} break${snap.breaksLeft > 1 ? "s" : ""} left tonight` : "Both breaks are used tonight, so only the judge can let you out"}`
    : nextStart && s ? `In ${fromNow(nextStart)}, your phone and Mac lock until ${s.end}`
    : "Pick some nights in Schedule";
  const shame = !early && !judged ? "No early unlocks yet"
    : [early && `${early} early unlock${early > 1 ? "s" : ""}`, judged && `${judged} judge approval${judged > 1 ? "s" : ""}`].filter(Boolean).join(", ") + " in all";

  return (
    <Screen>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <T serif size={26}>Curfew</T>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ width: 6, height: 6, borderRadius: 999, backgroundColor: snap.connected ? C.accent : C.rule }} />
          <T size={13} color={C.soft}>{snap.connected ? "Synced" : snap.configured ? "Offline, still locks on schedule" : "No server set up"}</T>
        </View>
      </View>

      {/* tonight's real moon is the one rich thing on the screen; it runs off the right edge like the photo on profiles.fm */}
      <Animated.Image source={tonight.image} accessibilityLabel={`${tonight.name}, ${tonight.lit}% lit`}
        style={{ width: size, height: size, alignSelf: "flex-end", marginRight: -size * 0.3, marginTop: -8, marginBottom: -16,
          opacity: rise, transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] }} />

      <View style={{ gap: 16 }}>
        <T size={13} color={C.soft}>{tonight.name} tonight, {tonight.lit}% lit</T>
        <T serif size={56}>{headline}</T>
        <T size={18} color={C.soft} style={{ lineHeight: 28 }}>{sub}</T>
      </View>

      {!armed ? <Key lit label="Set up Curfew" onPress={() => go("schedule")} />
        : onBreak ? <Key lit label="Lock again now" onPress={() => Sleep.tap()} />
        : lockedUntil ? <Key label={snap.breaksLeft ? "Unlock early" : "Ask the judge"} onPress={() => go("unlock")} />
        : <Key lit label={tapUntil ? `Sleep until ${hhmm(tapUntil)}` : "Sleep now"} onPress={() => Sleep.tap()} />}

      {lockedUntil || onBreak ? null : (
        <View style={{ borderTopWidth: 1, borderTopColor: C.line, marginTop: 16 }}>
          <Row meta={s ? `${s.start} to ${s.end}, ${nights(s.days)}` : undefined} title="Schedule" onPress={() => go("schedule")} />
          <Row meta={`${apps} apps stay usable`} title="Allowed apps" onPress={() => go("allowlist")} />
          <Row meta={missing ? `${missing} missing` : "All set"} title="Permissions" onPress={() => go("permissions")} />
        </View>
      )}
      {armed ? <T size={13} color={early ? C.bad : C.mute}>{shame}</T> : null}
      {snap.pending ? <T size={13} color={C.mute}>A tap or unlock from this phone is waiting to sync</T> : null}
    </Screen>
  );
}

/**
 * Tightening is free. If the server says a change loosens the lock, ask for fresh words to be typed and save again;
 * typed right, the stored phrase goes along for the server's check.
 */
function useSave(phrase?: string | null) {
  const [ask, setAsk] = useState(false);
  const [w, setW] = useState(words);
  const [current, setCurrent] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async (b: Update, done: string) => {
    setMsg(null);
    try {
      await Sleep.update(ask ? { ...b, currentPhrase: current === w ? phrase ?? "" : "" } : b);
      setAsk(false);
      setCurrent("");
      setMsg({ ok: true, text: done });
      return true;
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      if (/loosens/.test(text)) {
        setMsg({ ok: false, text: ask ? "That's not it. Here are new words" : "This loosens the lock. Type the words above, then save again." });
        setAsk(true);
        setW(words());
        setCurrent("");
      } else {
        setMsg({ ok: false, text: cap(text) });
      }
      return false;
    }
  };
  const field = ask ? (
    <Section title="Type these words">
      <Phrase text={w} typed={typo(current, w) ? typo(current, w) - 1 : current.length} />
      <PhraseInput value={current} onChange={setCurrent} autoFocus />
    </Section>
  ) : null;
  const note = msg ? <T size={15} color={msg.ok ? C.soft : C.bad}>{msg.text}</T> : null;
  return { save, field, note };
}

export function ScheduleScreen({ snap, back }: { snap: Snapshot; back: () => void }) {
  const s = snap.state.schedule ?? { start: "00:00", end: "06:00", days: [0, 1, 2, 3, 4, 5, 6] };
  const armed = !!snap.state.phraseHash;
  const [start, setStart] = useState(s.start);
  const [end, setEnd] = useState(s.end);
  const [days, setDays] = useState<number[]>(s.days);
  const { save, field, note } = useSave(snap.state.phrase);
  const toggle = (d: number) => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort());

  return (
    <Screen title="Schedule" onBack={back}>
      <View style={{ flexDirection: "row", gap: 24 }}>
        <TimeField label="Lights out" value={start} onChange={setStart} />
        <TimeField label="Lights on" value={end} onChange={setEnd} />
      </View>

      <Section title="Nights" note="A night belongs to the day it starts on">
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          {DAYS.map((d, i) => {
            const on = days.includes(i);
            return (
              <Pressable key={i} onPress={() => toggle(i)} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={DAY_NAMES[i]}
                style={({ pressed }) => ({
                  width: 40, height: 40, borderRadius: 999, alignItems: "center", justifyContent: "center",
                  backgroundColor: on ? C.raised : "transparent", borderWidth: 1, borderColor: on ? C.rule : "transparent", opacity: pressed ? 0.6 : 1,
                })}>
                <T medium size={15} color={on ? C.ink : C.mute}>{d}</T>
              </Pressable>
            );
          })}
        </View>
      </Section>

      {field}
      <Key lit label={armed ? "Save schedule" : "Turn on Curfew"} onPress={() =>
        // the server needs a secret to arm; unlocking never uses it, so it's words nobody has to know
        save({ schedule: { start, end, days }, ...(armed ? {} : { phrase: words(10) }) },
          `${armed ? "Saved" : "Curfew is on"}. ${days.length ? `Locks ${start} to ${end}, ${nights(days)}` : "No nights are locked now"}`)} />
      {note}
    </Screen>
  );
}

function TimeField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ flex: 1, gap: 4 }}>
      <T size={13} color={C.soft}>{label}</T>
      <TextInput value={value} onChangeText={onChange} maxLength={5} keyboardType="numbers-and-punctuation" accessibilityLabel={label}
        cursorColor={C.accent} selectionColor={C.accent} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        style={{ fontFamily: F.light, fontSize: 48, letterSpacing: -1.4, fontVariant: ["tabular-nums"], color: C.ink, paddingHorizontal: 0, paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: focused ? C.ink : C.rule }} />
    </View>
  );
}

export function Allowlist({ snap, back }: { snap: Snapshot; back: () => void }) {
  const saved = snap.state.allowlist ?? [];
  const [sel, setSel] = useState(() => new Set(saved.length ? saved : snap.defaults));
  // Settings is never allowed: it's how you'd switch the blocker off.
  // Allowed apps first, as they were on opening, so rows don't jump while you tap.
  const apps = useMemo(() => Sleep.apps().filter((a) => a.pkg !== "com.android.settings")
    .sort((a, b) => +sel.has(b.pkg) - +sel.has(a.pkg)), []);
  const [q, setQ] = useState("");
  const { save, field, note } = useSave(snap.state.phrase);
  const shown = apps.filter((a) => `${a.label} ${a.pkg}`.toLowerCase().includes(q.toLowerCase()));
  const flip = (pkg: string) => { const n = new Set(sel); n.has(pkg) ? n.delete(pkg) : n.add(pkg); setSel(n); };
  const foreign = saved.filter((id) => !apps.some((a) => a.pkg === id)); // the list is shared with the Mac: keep its ids

  return (
    <Screen title="Allowed apps" onBack={back}>
      <T size={15} color={C.soft}>These stay usable during curfew. Calls, the keyboard and Curfew itself always work. Settings never does.</T>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
        <Field value={q} onChangeText={setQ} placeholder="Search apps" autoCorrect={false} style={{ flex: 1 }} />
        {q ? <Link label="Clear" onPress={() => setQ("")} style={{ alignSelf: "center" }} /> : null}
      </View>
      {field}
      <Key lit label={`Save ${sel.size} apps`} onPress={() => save({ allowlist: [...sel, ...foreign] }, `Saved. ${sel.size} apps stay usable while locked`)} />
      {note}
      <View style={{ borderTopWidth: 1, borderTopColor: C.line }}>
        {shown.map((a) => <Row key={a.pkg} plain title={a.label} dot={sel.has(a.pkg)} onPress={() => flip(a.pkg)} />)}
      </View>
      {shown.length ? null : (
        <View style={{ gap: 12 }}>
          <T color={C.soft}>{`No apps match "${q}"`}</T>
          <Link label="Clear search" onPress={() => setQ("")} />
        </View>
      )}
    </Screen>
  );
}

export function Unlock({ snap, back }: { snap: Snapshot; back: () => void }) {
  const [w, setW] = useState(words); // new words every time this screen opens, so there's nothing to remember
  const [p, setP] = useState("");
  const [wrong, setWrong] = useState<string | null>(null);
  const [why, setWhy] = useState("");
  const [asking, setAsking] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const n = snap.state.earlyUnlocks ?? 0;
  const at = typo(p, w);
  const reply = verdict ? (
    <View style={{ gap: 4 }}>
      <T medium color={verdict.approved ? C.ink : C.bad}>{verdict.approved ? `${verdict.labels?.length ? `${verdict.labels.join(", ")} open` : "Approved"} for ${verdict.minutes} minutes` : "Denied"}</T>
      <T color={C.soft}>{verdict.reply}</T>
    </View>
  ) : null;

  if (!snap.lockedUntil) {
    return <Screen title="Unlocked" onBack={back}>{reply ?? <T color={C.soft}>Nothing is locked right now</T>}</Screen>;
  }
  // two typed breaks a night, then only the judge
  if (snap.breaksLeft > 0) {
    return (
      <Screen title="Unlock early" onBack={back}>
        <Section note={`Type these words exactly. They're new every time. You get 15 minutes, then the lock comes back by itself. ${snap.breaksLeft === 1 ? "Your last break" : "1 of 2 breaks"} tonight, and it counts as early unlock number ${n + 1}. After both, only the judge can let you out.`}>
          <Phrase text={w} typed={at ? at - 1 : p.length} />
          <PhraseInput value={p} onChange={(v) => { setP(v); setWrong(null); }} placeholder="Start typing" />
          <T size={13} color={wrong || at ? C.bad : C.mute}>{wrong ?? (at ? `Typo at character ${at}` : `${p.length} of ${w.length} typed`)}</T>
          <Key lit label="Take a 15 minute break" disabled={p !== w} onPress={async () => {
            const why = await Sleep.unlock();
            if (!why) return back();
            setWrong(why);
            setP("");
            setW(words());
          }} />
        </Section>
      </Screen>
    );
  }
  return (
    <Screen title="Ask the judge" onBack={back}>
      <T size={18} color={C.soft} style={{ lineHeight: 28 }}>
        {`Both breaks are used tonight, so the judge decides. The lock stays until ${hhmm(snap.lockedUntil)} unless it lets you out. Calls, texts, maps and the clock still work.`}
      </T>
      <Section note="Say what's happening and why it can't wait. It hears 3 asks a night, 10 minutes apart. A yes opens just the apps it takes, for a short while, and doesn't count as an early unlock.">
        <Field value={why} onChangeText={setWhy} multiline placeholder="What's going on" style={{ minHeight: 88, textAlignVertical: "top" }} />
        <Key label={asking ? "Asking the judge" : "Ask the judge"} disabled={asking || why.trim().length < 10} onPress={async () => {
          setAsking(true);
          setAskError(null);
          try { setVerdict(await Sleep.appeal(why.trim())); }
          catch (e) { setAskError(cap(e instanceof Error ? e.message : String(e))); }
          finally { setAsking(false); }
        }} />
        {asking ? <T size={13} color={C.mute}>It's reading what you wrote. Usually a few seconds.</T> : null}
        {reply}
        {askError ? <T color={C.bad}>{askError}</T> : null}
      </Section>
    </Screen>
  );
}

const PERMS: [Perm, string, string][] = [
  ["accessibility", "Accessibility", "The main blocker: sees which app opens and sends you home. Greyed out? App info, then the menu, then Allow restricted settings."],
  ["overlay", "Display over other apps", "Shows the lock screen when accessibility is off"],
  ["usage", "Usage access", "Backup blocker if accessibility gets switched off mid-lock"],
  ["admin", "Device admin", "Turns the screen off 8 seconds after the lock appears"],
  ["notifications", "Notifications", "The notification that keeps Curfew running, with a Sleep now button"],
  ["quiet", "Notification access", "Keeps other apps quiet during the lock and hands their notifications over when it ends"],
  ["exactAlarm", "Alarms and reminders", "Locks on the minute, even when the phone is idle"],
  ["battery", "Unrestricted battery", "Keeps the connection to your Mac alive overnight"],
];

export function Permissions({ back }: { back: () => void }) {
  const [status, setStatus] = useState(Sleep.permissions);
  useEffect(() => {
    const t = setInterval(() => setStatus(Sleep.permissions()), 1500);
    const sub = AppState.addEventListener("change", () => setStatus(Sleep.permissions()));
    return () => { clearInterval(t); sub.remove(); };
  }, []);
  const missing = Object.values(status).filter((ok) => !ok).length;
  return (
    <Screen title="Permissions" onBack={back}>
      <T size={15} color={C.soft}>{missing ? `${missing} still off. Tap one to open its setting, switch Curfew on, then come back.` : "All set. Curfew can lock this phone properly."}</T>
      <View style={{ borderTopWidth: 1, borderTopColor: C.line }}>
        {PERMS.map(([key, title, why]) => (
          <Row key={key} plain title={title} sub={status[key] ? undefined : why} dot={status[key]}
            value={status[key] ? "On" : "Turn on"} valueColor={status[key] ? C.mute : C.accent} onPress={() => Sleep.openPermission(key)} />
        ))}
      </View>
    </Screen>
  );
}
