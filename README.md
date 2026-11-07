# Curfew

i couldn't sleep. 12am, 1am, 3am, still on my phone. every night.

so i made this. at bedtime it locks my phone and my mac. now i sleep. mostly. lol

## what it does

- bedtime hits, phone + mac lock
- want out? type 8 random words. you get 15 min. twice a night, that's it
- breaks gone? beg the AI judge. it says no to instagram
- tap SLEEP and both lock right now

## setup

you host it yourself on cloudflare. it's for one person. you.

**server**

```bash
cd server && npm install
npx wrangler deploy
TOKEN=$(openssl rand -hex 24); echo "$TOKEN"   # save this
echo "$TOKEN" | npx wrangler secret put APP_TOKEN
```

**phone** (android)

```bash
cd android && npm install
cp .env.example .env   # put your worker url + token in
npx expo prebuild --platform android
cd android && ./gradlew app:assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

open it, pick a schedule, give it every permission. accessibility greyed out? app info → ⋮ → allow restricted settings.

**mac**

```bash
cd mac && ./install.sh https://sleep-sync.<you>.workers.dev <TOKEN>
```

asks for your password once. `./uninstall.sh` if you give up.

## tests

```bash
cd server && npm test
cd android/android && ./gradlew :sleep-native:testDebugUnitTest
cd mac && xcrun swift test
```

ways to cheat it: [docs/limits.md](docs/limits.md). please don't.

## license

MIT. fonts are OFL. moon pics are NASA's.
