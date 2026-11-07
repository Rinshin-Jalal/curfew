# Accessibility API declaration (Google Play)

Not needed while it's sideloaded on one phone. If it ever ships on Play, this is the declaration text.

**Core functionality:** Curfew is a bedtime app blocker the user sets up for themselves. During the sleep window
they choose (for example 00:00–06:00), or after they tap SLEEP, it keeps them out of apps they haven't allowed.

**Why AccessibilityService:** It's the only reliable, instant way to learn which app has just come to the
foreground, so a blocked app can be closed (`GLOBAL_ACTION_HOME`) and replaced by the lock screen in under a second.

**What it accesses:** only `TYPE_WINDOW_STATE_CHANGED` events, and from them only the package name of the window
in front. `canRetrieveWindowContent` is false: it never reads text, screen content, input or anything typed. It
performs exactly two actions: Home, and closing the notification shade after the Curfew quick-settings tile is tapped.

**Data:** nothing from the service leaves the device. It isn't stored or logged, and it isn't used for ads,
analytics or anything else.

**User control:** the user turns the service on in system settings, with an in-app screen that explains this
first. It can be turned off any time outside the user's own sleep window.

**Not an accessibility tool:** `isAccessibilityTool` is not set. This is the declared app-blocking use case.
