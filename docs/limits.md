# Known bypasses

The goal is friction at midnight, not a prison. Everything below works. Most of it needs planning before
00:00, a second device, or a reboot, and that's the point: by then you've noticed what you're doing.

## Both

- **Nothing is enforced until Curfew is turned on.** Turning it on stores a secret of 10 random words in the synced
  state; nobody ever types it, it's only how the server knows Curfew is on and that a loosening change was typed for.
- **The words are shown on purpose.** An early unlock costs typing 8 fresh random words (a minute or so) plus +1 on
  the shame counter, and buys only a 15 minute break, two a night. The device that shows them checks the typing.
- **An offline break can come late.** A phone unlocked offline counts its own breaks, but the server starts its copy
  of the break when the phone reconnects, so you can get that break's 15 minutes a second time.
- **The judge can still be lied to.** It only knows what you type and can't check facts. It's told to assume
  stretching, it sees the past week of asks (so the same emergency twice gets called out), and it hears 3 asks a
  night, so a well-told lie gets at most a few 5-30 minute windows. It's only reachable once both breaks are used. The reasons stay in the server's log.
- **The judge needs the network.** It runs on Workers AI (free daily allowance, then billed per use). Offline,
  only the typed breaks and the emergency dialer work.
- **Before the window, everything is editable**: schedule, allowlist, uninstalling. Loosening the rules needs fresh
  words typed, but uninstalling the app doesn't.
- **Changing the clock or timezone** before 00:00 moves the lock. Each device trusts its own clock.
- **The APP_TOKEN is in the APK and in the Mac's defaults.** Anyone with it can tap or call `/sleep/unlock` without
  typing anything (still two breaks a night). `PUT` is refused while locked.
- **Offline unlock is local.** The device checks the typing and starts the break itself. Until it syncs, the other
  device stays locked.
- **Sync isn't the lock.** Kill Wi-Fi and the device still locks on schedule, but a SLEEP tap on the other device
  won't reach it until it reconnects.

## Android

- **Safe mode** (long-press Power off → Safe mode) starts the phone without any third-party apps, Curfew included.
- **Another user or Guest** (Quick Settings → user switcher) has no Curfew. Turn off multiple users / guest mode.
- **adb** from a computer can disable the accessibility service or force-stop the app. Turn off USB debugging if
  that matters.
- **Force stop** (Settings, outside the window) kills the alarms and can switch off the accessibility service until
  you open the app again. During the window, Settings isn't allowed.
- **The notification shade is always usable**: allowed apps' notifications show there and can be replied to inline.
  Other apps' notifications are snoozed until the lock ends, but only with Notification access granted; without it
  they all come through. A break doesn't bring snoozed ones back early.
- **Background audio keeps playing**: music, podcasts, YouTube background play. Only the app in front is blocked.
- **Allowed apps are fully usable**, including any in-app browsers or link previews they have.
- **Voice assistant** on the lock screen can answer things and play media. Anything it opens gets sent home.
- **Picture-in-picture** started before 00:00 may keep a small floating window alive.
- **After a reboot** nothing runs until you unlock with your PIN. Then the boot receiver brings the lock back
  within seconds.
- **Without Device admin** the screen doesn't turn off. **Without Accessibility**, the fallback polls every 500 ms
  and beeps every 60 s, but the overlay can lag a moment behind a newly opened app.
- **Doze can drop the sync socket overnight** on aggressive OEM builds. The schedule still fires from the exact alarm.

## Mac

- **Force Quit from Activity Monitor or `kill`** still works if you can reach a shell (SSH from another device,
  for example). Kiosk mode disables the ⌥⌘⎋ Force Quit window, but a determined `kill` wins. If you quit it, the LaunchAgent relaunches it in about 2 s.
- **`launchctl bootout gui/$(id -u)/com.noexcuselabs.sleep`** before 00:00 stops it until next login.
- **Log out or restart** isn't blocked, so a shutdown always goes through. After login it relaunches and locks
  again. **Another macOS user account** has no Curfew.
- **Recovery mode or booting another disk** gets around everything. SIP and kexts are untouched by design.
- **Apps stay open under the overlay.** Nothing gets closed, so downloads, builds and background audio keep going
  (the sound is muted). /etc/hosts blocks the listed domains for anything that's still online, but iCloud Private
  Relay, a browser's own Secure DNS/DoH, raw IPs and already-open connections can get past it.
- **The sudoers rule** lets anything running as you toggle the hosts block without a password: exactly
  `sleep-hosts on` and `off`, nothing else.
- **Messages and FaceTime keep running** (calls can ring) but sit under the overlay.
- **Display sleep** after 10 minutes is `pmset displaysleepnow`, and any key wakes it again, to the overlay.
