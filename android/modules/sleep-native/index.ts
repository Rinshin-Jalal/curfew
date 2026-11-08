// JS face of SleepCore (Kotlin). The native side owns state, sync and enforcement so it all works with the app closed.
import { requireNativeModule } from "expo";
import type { Schedule, SleepState } from "../../../shared/sleep";

export type { Schedule, SleepState };

export type Snapshot = {
  state: Partial<SleepState>; // empty until the first sync
  lockedUntil: string | null;
  nextStart: string | null;
  breakEnd: string | null; // on a break from a lock that comes back after it
  appBreak: { until: string; labels: string[] } | null; // the judge opened only these; the rest stays locked
  tapUntil: string | null; // where Sleep now would lock until
  breaksLeft: number; // phrase breaks left tonight
  connected: boolean;
  pending: boolean; // a tap/unlock the server hasn't heard about yet
  configured: boolean;
  defaults: string[]; // this phone's default allowlist (dialer, clock, messages, maps)
};

export type Perm = "accessibility" | "overlay" | "usage" | "admin" | "notifications" | "quiet" | "exactAlarm" | "battery";

export type Verdict = { approved: boolean; minutes: number; reply: string; labels?: string[] }; // labels: what a yes opened

export type Update ={ schedule?: Schedule; allowlist?: string[]; phrase?: string; currentPhrase?: string };

type Native = {
  configure(url: string, token: string): Promise<void>;
  snapshot(): string;
  tap(): Promise<void>;
  unlock(): Promise<string | null>; // why not, or null: a 15 minute break started (the app checks the typing)
  update(body: string): Promise<string>;
  appeal(reason: string): Promise<string>;
  takeRoute(): string | null;
  apps(): string;
  permissions(): Record<Perm, boolean>;
  openPermission(key: Perm): Promise<void>;
  addListener(event: "onChange", fn: () => void): { remove(): void };
};

const N = requireNativeModule<Native>("SleepNative");

export const Sleep = {
  configure: (url: string, token: string) => N.configure(url, token),
  snapshot: (): Snapshot => JSON.parse(N.snapshot()),
  tap: () => N.tap(),
  unlock: () => N.unlock(),
  update: async (b: Update): Promise<SleepState> => JSON.parse(await N.update(JSON.stringify(b))),
  appeal: async (reason: string): Promise<Verdict> => JSON.parse(await N.appeal(reason)),
  takeRoute: () => N.takeRoute(),
  apps: (): { pkg: string; label: string }[] => JSON.parse(N.apps()),
  permissions: () => N.permissions(),
  openPermission: (k: Perm) => N.openPermission(k),
  onChange: (fn: () => void) => N.addListener("onChange", fn),
};
