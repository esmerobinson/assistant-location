#!/bin/bash
# Host side of UITests/SubwayLiveActivityUITest.swift. Usage: subway_sim_driver.sh <simulator udid>
# Screenshots with simctl when the test writes /tmp/subway-out/stage-<name>, and delivers the server's real APNs
# payload by dropping it where the app hook decodes it. push.done records whether the activity changed.
UDID=$1
IN=/tmp/subway-in
OUT=/tmp/subway-out
BUNDLE=com.oliverullman.assistantlocation
LOG=$OUT/driver.log
log() { echo "$(date +%T) $*" >> "$LOG"; }
waitfor() { for _ in $(seq 1 "$2"); do [ -e "$1" ] && return 0; sleep 0.5; done; return 1; }
shot() { xcrun simctl io "$UDID" screenshot "$OUT/sim_$1.png" >> "$LOG" 2>&1; touch "$OUT/ack-$1"; log "shot $1"; }

EXPECTED=$(jq -r '"rows=" + ([.aps."content-state".rows[] | "\(.line):\(.mins)"] | join(","))' "$IN/apns_update.json")
log "expected update $EXPECTED"

for s in island lock_before; do
  waitfor "$OUT/stage-$s" 480 && shot "$s" || { log "no stage $s"; exit 1; }
done
waitfor "$OUT/stage-push" 480 || { log "no stage push"; exit 1; }

# `simctl push` supports only application remote notifications, not Live Activity updates (run 42526138142), so
# the payload goes through the app hook, which decodes aps.content-state strictly into SubwayState.
cp "$IN/apns_update.json" "$IN/payload.json"
METHOD=none
for _ in $(seq 1 30); do
  if grep -q "update $EXPECTED" "$OUT/activity.log" 2>/dev/null; then METHOD=file-hook; break; fi
  sleep 1
done
echo "$METHOD" > "$OUT/push.done"
log "push method: $METHOD"
waitfor "$OUT/stage-lock_after" 120 && shot lock_after || log "no stage lock_after"
