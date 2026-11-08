#!/bin/bash
# Host side of UITests/SubwayLiveActivityUITest.swift. Usage: subway_sim_driver.sh <simulator udid>
# Screenshots with simctl when the test writes /tmp/subway-out/stage-<name>, and delivers the server's real APNs
# payload: first `simctl push` (Xcode's Live Activity push support), then, if the activity did not change, by dropping
# the payload where the app hook decodes it. push.done records which route changed the activity.
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
xcrun simctl help push >> "$LOG" 2>&1

for s in island lock_before; do
  waitfor "$OUT/stage-$s" 480 && shot "$s" || { log "no stage $s"; exit 1; }
done
waitfor "$OUT/stage-push" 480 || { log "no stage push"; exit 1; }

xcrun simctl push "$UDID" "$BUNDLE" "$IN/apns_update.json" >> "$LOG" 2>&1
log "simctl push exit $?"
METHOD=none
for _ in $(seq 1 20); do
  if grep -q "update $EXPECTED" "$OUT/activity.log" 2>/dev/null; then METHOD=simctl-push; break; fi
  sleep 1
done
if [ "$METHOD" = none ]; then
  log "simctl push did not change the activity; falling back to the file hook"
  cp "$IN/apns_update.json" "$IN/payload.json"
  for _ in $(seq 1 20); do
    if grep -q "update $EXPECTED" "$OUT/activity.log" 2>/dev/null; then METHOD=file-hook; break; fi
    sleep 1
  done
fi
echo "$METHOD" > "$OUT/push.done"
log "push method: $METHOD"
waitfor "$OUT/stage-lock_after" 120 && shot lock_after || log "no stage lock_after"
