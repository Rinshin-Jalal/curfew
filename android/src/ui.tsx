// Curfew takes its manner from profiles.fm: true black, a light editorial serif for anything worth reading
// at night, a plain sans for the interface, hairlines, pill buttons, and one orange that marks the action.
// Direction and passes follow unslop by Damir Sokolovsky (@heydamir, github.com/heydamir/unslop, CC BY 4.0).
import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from "react";
import {
  Keyboard, KeyboardAvoidingView, Pressable, ScrollView, Text, TextInput, View,
  type StyleProp, type TextInputProps, type TextStyle, type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export const C = {
  night: "#000000", // the panel is off
  ink: "#FFFFFF", // primary text
  soft: "#A0A0A0", // secondary text
  mute: "#898989", // meta, counts, captions
  line: "rgba(255,255,255,0.10)", // hairlines between rows
  rule: "rgba(255,255,255,0.28)", // field underlines and outline buttons
  hint: "rgba(255,255,255,0.40)", // placeholders
  raised: "#1A1A1A", // a selected toggle
  accent: "#FF621E", // the one action, and what's selected
  onAccent: "#1A0800",
  bad: "#E5484D", // errors and early unlocks
};
export const F = { serif: "Newsreader_400Regular", light: "Newsreader_300Light", sans: "InstrumentSans_400Regular", medium: "InstrumentSans_500Medium" };

/** Sans by default. Serif for headlines and titles, tracked tighter the bigger it gets. */
export function T({ children, size = 16, color = C.ink, serif, light, medium, style, numberOfLines }:
  { children: ReactNode; size?: number; color?: string; serif?: boolean; light?: boolean; medium?: boolean; style?: StyleProp<TextStyle>; numberOfLines?: number }) {
  const family = serif ? (light ? F.light : F.serif) : medium ? F.medium : F.sans;
  const track = serif ? (size >= 40 ? -0.03 : size >= 24 ? -0.02 : 0) * size : 0;
  return (
    <Text numberOfLines={numberOfLines}
      style={[{ fontFamily: family, fontSize: size, lineHeight: Math.round(size * (serif ? 1.1 : 1.45)), letterSpacing: track, color, fontVariant: ["tabular-nums"] }, style]}>
      {children}
    </Text>
  );
}

/** Pill buttons. The one action on a screen is solid orange; anything else is an outline. */
export function Key({ label, onPress, disabled, lit, style }:
  { label: string; onPress: () => void; disabled?: boolean; lit?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
      style={({ pressed }) => [{
        alignSelf: "flex-start", height: 48, paddingHorizontal: 24, borderRadius: 999, alignItems: "center", justifyContent: "center",
        backgroundColor: lit ? C.accent : "transparent", borderWidth: lit ? 0 : 1, borderColor: C.rule,
        opacity: disabled ? 0.4 : 1, transform: [{ scale: pressed ? 0.98 : 1 }],
      }, style]}>
      <T medium size={15} color={lit ? C.onAccent : C.ink}>{label}</T>
    </Pressable>
  );
}

/** Selected or not: a filled orange dot, or an empty ring. */
export function Dot({ on }: { on: boolean }) {
  return <View style={{ width: 10, height: 10, borderRadius: 999, backgroundColor: on ? C.accent : "transparent", borderWidth: on ? 0 : 1, borderColor: C.rule }} />;
}

/**
 * A list row, like an episode on profiles.fm: a small meta line over a serif title, hairline underneath.
 * Long lists (apps) use `plain`, a single sans line.
 */
export function Row({ title, meta, sub, value, valueColor = C.soft, dot, plain, onPress }:
  { title: string; meta?: string; sub?: string; value?: string; valueColor?: string; dot?: boolean; plain?: boolean; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} disabled={!onPress}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 16, paddingVertical: plain ? 16 : 20, borderBottomWidth: 1, borderBottomColor: C.line, opacity: pressed ? 0.6 : 1 })}>
      {dot !== undefined ? <Dot on={dot} /> : null}
      <View style={{ flex: 1, gap: 4 }}>
        {meta ? <T size={13} color={C.soft}>{meta}</T> : null}
        {plain ? <T>{title}</T> : <T serif size={26}>{title}</T>}
        {sub ? <T size={13} color={C.soft}>{sub}</T> : null}
      </View>
      {value ? <T size={15} color={valueColor}>{value}</T> : null}
    </Pressable>
  );
}

/** A quiet underlined action, for the small things next to a field. */
export function Link({ label, onPress, style }: { label: string; onPress: () => void; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable onPress={onPress} hitSlop={12} style={[{ alignSelf: "flex-start" }, style]} accessibilityRole="button">
      <T size={15} color={C.soft} style={{ textDecorationLine: "underline" }}>{label}</T>
    </Pressable>
  );
}

export function Section({ title, note, children }: { title?: string; note?: string; children?: ReactNode }) {
  return (
    <View style={{ gap: 12 }}>
      {title ? <T serif size={28}>{title}</T> : null}
      {note ? <T size={15} color={C.soft}>{note}</T> : null}
      {children}
    </View>
  );
}

/**
 * Every screen. Lifts above the keyboard and scrolls the focused field into view
 * (Android draws edge to edge now, so the window no longer resizes for the keyboard by itself).
 */
export function Screen({ children, title, onBack }: { children: ReactNode; title?: string; onBack?: () => void }) {
  const inset = useSafeAreaInsets();
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  useEffect(() => {
    const sub = Keyboard.addListener("keyboardDidShow", () => {
      const input = TextInput.State.currentlyFocusedInput();
      const content = scroll.current?.getInnerViewRef();
      if (!input || !content) return;
      input.measureLayout(content, (_x, y) => scroll.current?.scrollTo({ y: Math.max(0, y - 160), animated: true }), () => {});
    });
    return () => sub.remove();
  }, []);
  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: C.night }}>
      <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingTop: inset.top + 16, paddingBottom: inset.bottom + 48, paddingHorizontal: 24, gap: 32 }}>
        {onBack ? (
          <View style={{ gap: 24 }}>
            <Pressable onPress={onBack} hitSlop={16} style={{ alignSelf: "flex-start", paddingVertical: 4 }} accessibilityRole="button">
              <T size={15} color={C.soft}>Back</T>
            </Pressable>
            <T serif size={44}>{title}</T>
          </View>
        ) : null}
        {children}
      </ScrollView>
      {/* content scrolls under the status bar otherwise */}
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, height: inset.top, backgroundColor: C.night }} />
    </KeyboardAvoidingView>
  );
}

/** Underline fields, like the email box on profiles.fm. */
export function Field({ style, ...props }: TextInputProps) {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput placeholderTextColor={C.hint} cursorColor={C.accent} selectionColor={C.accent} {...props}
      onFocus={(e) => { setFocused(true); props.onFocus?.(e); }} onBlur={(e) => { setFocused(false); props.onBlur?.(e); }}
      style={[{ fontFamily: F.sans, fontSize: 17, color: C.ink, borderBottomWidth: 1, borderBottomColor: focused ? C.ink : C.rule, paddingHorizontal: 0, paddingVertical: 12 }, style]} />
  );
}

/** Typed, never pasted: no context menu, no suggestions, and any change of more than one character is refused. */
export function PhraseInput({ value, onChange, placeholder, autoFocus }:
  { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean }) {
  return (
    <Field value={value} placeholder={placeholder} autoFocus={autoFocus}
      onChangeText={(t) => { if (t.length - value.length <= 1) onChange(t); }}
      contextMenuHidden autoCorrect={false} autoComplete="off" autoCapitalize="none" spellCheck={false}
      importantForAutofill="no" keyboardType="visible-password" multiline submitBehavior="blurAndSubmit"
      style={{ lineHeight: 26, textAlignVertical: "top" }} />
  );
}

/** The phrase, shown as-is: nothing to remember, only to type. The part typed right so far turns orange. Not selectable, so no copying. */
export function Phrase({ text, typed = 0 }: { text: string; typed?: number }) {
  return (
    <Text selectable={false} style={{ fontFamily: F.light, fontSize: 26, lineHeight: 34, letterSpacing: -0.4, color: C.ink }}>
      <Text style={{ color: C.accent }}>{text.slice(0, typed)}</Text>{text.slice(typed)}
    </Text>
  );
}

/** Where typing has gone wrong so far (1-based), or 0. */
export function typo(typed: string, phrase: string) {
  for (let i = 0; i < typed.length; i++) if (typed[i] !== phrase[i]) return i + 1;
  return typed.length > phrase.length ? phrase.length + 1 : 0;
}

export const pad = (n: number) => String(n).padStart(2, "0");
export const hhmm = (iso: string) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export function fromNow(iso: string) {
  const m = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`;
}
export const DAYS = ["S", "M", "T", "W", "T", "F", "S"];
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function nights(days: number[] = []) {
  if (days.length === 7) return "every night";
  if (!days.length) return "no nights";
  if (days.join() === "0,1,2,3,4") return "Sunday to Thursday nights";
  return days.map((d) => DAY_NAMES[d]).join(", ");
}
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
