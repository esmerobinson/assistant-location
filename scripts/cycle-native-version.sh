#!/bin/bash
# Prints Cycle's native build stamp: the commit time of the last change to anything that ends up in the Cycle binary.
# ota-cycle.yml and testflight-cycle.yml write it into Info.plist as CycleNativeVersion, and the box reports the one on the
# install page as `native` in /app/manifest.json, so a phone with an older stamp shows the "New version" bar.
# Web-only changes (CycleApp/web) are excluded on purpose: they arrive through the web OTA and must never trigger it.
# Needs full git history (checkout with fetch-depth: 0). This list is the ONE place that decides what counts as native.
set -euo pipefail
cd "$(dirname "$0")/.."
stamp="$(git log -1 --format=%ct -- CycleApp ':(exclude)CycleApp/web' CycleNSE Overland.xcodeproj/project.pbxproj scripts/add_cycle_app.rb scripts/add_cycle_nse.rb fastlane)"
test -n "$stamp" || { echo "cycle-native-version: no native commit found (shallow clone?)" >&2; exit 1; }
echo "$stamp"
