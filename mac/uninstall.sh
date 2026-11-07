#!/bin/sh
# Removes everything install.sh added, and takes the hosts block out if it's there.
set -eu
LABEL=com.noexcuselabs.sleep
HELPER=/Library/PrivilegedHelperTools/$LABEL-hosts
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
[ -x "$HELPER" ] && sudo "$HELPER" off
sudo rm -f "$HELPER" /etc/sudoers.d/$LABEL /etc/sudoers.d/noexcuselabs-sleep
rm -rf /Applications/Curfew.app /Applications/Sleep.app
defaults delete $LABEL 2>/dev/null || true
echo "Curfew removed."
