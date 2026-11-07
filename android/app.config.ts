import type { ExpoConfig } from "expo/config";

// All the native pieces (accessibility service, overlay, device admin, tile, widget, alarms) live in
// modules/sleep-native and merge in through its own AndroidManifest.xml: no config plugin needed.
const config: ExpoConfig = {
  name: "Curfew",
  slug: "sleep",
  scheme: "sleep",
  version: "1.0.0",
  orientation: "portrait",
  userInterfaceStyle: "dark",
  backgroundColor: "#000000",
  icon: "./assets/icon.png",
  android: {
    package: "com.noexcuselabs.sleep",
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-foreground.png",
      monochromeImage: "./assets/adaptive-monochrome.png",
      backgroundColor: "#000000",
    },
  },
  plugins: [
    // dev server over adb reverse is plain http; minSdk 31 because it's one phone and it saves a pile of version checks
    ["expo-build-properties", { android: { usesCleartextTraffic: true, minSdkVersion: 31 } }],
  ],
};

export default config;
