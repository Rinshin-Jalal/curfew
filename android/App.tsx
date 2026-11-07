import { useEffect, useRef, useState } from "react";
import { AppState, BackHandler, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
// per-weight imports: the package root bundles every weight
import { Newsreader_300Light } from "@expo-google-fonts/newsreader/300Light";
import { Newsreader_400Regular } from "@expo-google-fonts/newsreader/400Regular";
import { InstrumentSans_400Regular } from "@expo-google-fonts/instrument-sans/400Regular";
import { InstrumentSans_500Medium } from "@expo-google-fonts/instrument-sans/500Medium";
import { Sleep, type Snapshot } from "./modules/sleep-native";
import { C } from "./src/ui";
import { Allowlist, Home, Permissions, ScheduleScreen, Unlock, type Route } from "./src/screens";

// Single user: the app hands the server URL + shared token to the native side once; it does all syncing.
const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? "").replace(/\/$/, "");
const TOKEN = process.env.EXPO_PUBLIC_APP_TOKEN ?? "";

export default function App() {
  const [fonts] = useFonts({ Newsreader_300Light, Newsreader_400Regular, InstrumentSans_400Regular, InstrumentSans_500Medium });
  const [snap, setSnap] = useState<Snapshot>(Sleep.snapshot);
  const [route, setRouteState] = useState<Route>("home");
  const routeRef = useRef<Route>("home");
  const setRoute = (r: Route) => { routeRef.current = r; setRouteState(r); };

  useEffect(() => {
    if (API_URL) void Sleep.configure(API_URL, TOKEN);
    const refresh = () => setSnap(Sleep.snapshot());
    // "unlock early" on the overlay opens the app straight on the unlock screen
    const land = () => { if (Sleep.takeRoute() === "unlock") setRoute("unlock"); refresh(); };
    land();
    const change = Sleep.onChange(refresh);
    const app = AppState.addEventListener("change", (s) => s === "active" && land());
    const backBtn = BackHandler.addEventListener("hardwareBackPress", () => {
      if (routeRef.current === "home") return false;
      setRoute("home");
      return true;
    });
    const t = setInterval(refresh, 30_000); // countdowns
    return () => { change.remove(); app.remove(); backBtn.remove(); clearInterval(t); };
  }, []);

  const home = () => setRoute("home");
  let screen;
  if (!fonts) screen = <View style={{ flex: 1, backgroundColor: C.night }} />;
  else if (route === "schedule") screen = <ScheduleScreen snap={snap} back={home} />;
  else if (route === "allowlist") screen = <Allowlist snap={snap} back={home} />;
  else if (route === "unlock") screen = <Unlock snap={snap} back={home} />;
  else if (route === "permissions") screen = <Permissions back={home} />;
  else screen = <Home snap={snap} go={setRoute} />;

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {screen}
    </SafeAreaProvider>
  );
}
