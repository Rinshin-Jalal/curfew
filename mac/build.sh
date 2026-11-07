#!/bin/sh
# Builds build/Curfew.app (menu-bar only, ad-hoc signed).
set -eu
cd "$(dirname "$0")"
xcrun swift build -c release
rm -rf build/Curfew.app
mkdir -p build/Curfew.app/Contents/MacOS build/Curfew.app/Contents/Resources
cp .build/release/Sleep build/Curfew.app/Contents/MacOS/Curfew
cp Info.plist build/Curfew.app/Contents/Info.plist
cp ../shared/fonts/*.ttf ../shared/moon/*.jpg Sleep.icns build/Curfew.app/Contents/Resources/
codesign --force -s - build/Curfew.app
echo "built $(pwd)/build/Curfew.app"
