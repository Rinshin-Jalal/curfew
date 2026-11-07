#!/bin/sh
# Installs Curfew.app, keeps it running with a LaunchAgent (quit it and it's back in ~2s),
# and lets it toggle the /etc/hosts block without a password. Asks for your password once.
#   ./install.sh https://sleep-sync.<you>.workers.dev <APP_TOKEN>
set -eu
cd "$(dirname "$0")"
URL=${1:?usage: ./install.sh <server url> <app token>}
TOKEN=${2:?usage: ./install.sh <server url> <app token>}
LABEL=com.noexcuselabs.sleep
APP=/Applications/Curfew.app
AGENT=$HOME/Library/LaunchAgents/$LABEL.plist
HELPER=/Library/PrivilegedHelperTools/$LABEL-hosts # root-owned dir: nobody but root can swap the script

./build.sh
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -rf "$APP" /Applications/Sleep.app # its old name
cp -R build/Curfew.app "$APP"
defaults write $LABEL apiURL "$URL"
defaults write $LABEL apiToken "$TOKEN"

sudo install -m 755 -o root -g wheel sleep-hosts "$HELPER"
rule=$(mktemp)
echo "$(id -un) ALL=(root) NOPASSWD: $HELPER on, $HELPER off" >"$rule"
sudo visudo -cf "$rule" >/dev/null
# sudo skips sudoers.d files with a dot in the name, so not $LABEL
sudo rm -f /etc/sudoers.d/$LABEL
sudo install -m 440 -o root -g wheel "$rule" /etc/sudoers.d/noexcuselabs-sleep
rm -f "$rule"

mkdir -p "$(dirname "$AGENT")"
cat >"$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$APP/Contents/MacOS/Curfew</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>2</integer>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
PLIST
launchctl bootstrap "gui/$(id -u)" "$AGENT"
echo "Curfew is running: moon in the menu bar, ⌃⌥⌘S to lock now."
echo "Really stop it (outside the lock window):  launchctl bootout gui/\$(id -u)/$LABEL"
