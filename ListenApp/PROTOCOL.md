# Listen native<->web protocol v1

The Listen app (standalone, bundle com.oliverullman.listen) hosts a plain WKWebView loading
`https://GL_BAKED_HOST:9315/` (tailnet-only `tailscale serve` HTTPS front for the server on 8315; HTTPS because the Voice tab needs getUserMedia). Playback is NATIVE (AVQueuePlayer) because a
WKWebView cannot reliably start audio while the screen is locked. The page
owns all data (library, sections, cards, settings via the :8315 API); native
owns the audio engine, Now Playing, pocket mode and voice commands.

Transport: the Listen view controller registers its OWN WKScriptMessageHandler
named `listen` on the web view's user content controller. Wire shape:

- page -> native: `window.webkit.messageHandlers.listen.postMessage({id, method, params})`
- native -> page reply: `window.__listenReply(id, result, error)` exactly once per request, main queue; `error` is a string or null.
- native -> page events: `window.__listenEvent(name, payload)` (guarded with typeof === 'function').
- Page detects native with `!!window.webkit?.messageHandlers?.listen`; absent (desktop browser, tests) it uses its own JS `<audio>` engine with identical semantics.

Reload reason: when the web content process is killed (iOS does this to an app left in the background), native reloads the saved shell and injects a document-start user script `window.__listenReloadReason = 'webcontent-terminated'` for that one load (removed at didFinishNavigation). The page's boot trace (`window.__listenBoot.reason`, posted to `api/boot-log`) records it; absent on every other load.

## Types

```
Section = {idx:int, start:number, end:number, text:string, translation:string,
           difficulty:int, repeat?:bool (absent = false; a repeated line of a song, see Song modes), vocab:[{term,lemma,gloss}],
           audio:{original:url, clear:url, translation:url, vocab:{target:locale, native:locale}|url|null}}
  // `original` is the FULL episode mp3 URL (supports Range); native plays only [start,end].
Settings = {steps:["vocab","clear","translation","original"] (ordered subset),
            autoAdvance:bool, holdAfter?:[int] (section indexes after which the step loop pauses as if autoAdvance were off; Listen & speak stops), speakStops?:[{afterIdx:int>=0, kind:"repeat"|"summary", from:int>=0, to:int>=from}] (the full Listen & speak plan; the stop after section afterIdx; native runs it hands-free when the page cannot, see Speak turn), rate:number (0.5-1.5, applies to `original` only),
            englishRate:number (0.5-1.5, applies to `translation` only),
            clearRate?:number (0.5-1.5, applies to `clear` only; absent = 1),
            times?:{vocab|clear|translation|original: int 1-3} (absent or a missing step = once), pocketDoublePress:"voice"|"next",
            pocketReplaySlowdown:int (0-50, percent),
            revisitSteps?:"original"|"all" (absent = "original"; see step loop semantics),
            skipRepeats?:bool (absent = false; see Song modes), continuous?:bool (absent = false; see Song modes),
            rewinds?:[{steps:[kind...], slow:int 0-50}] (1-4 presets; kind in vocab|clear|translation|original; absent = [{steps:["translation","original"], slow:0}])}
State = {itemId:string|null, idx:int, step:"vocab"|"clear"|"translation"|"original"|null,
         stepIndex:int, stepCount:int, playing:bool, position:number, duration:number,
         pocket:bool, listening:bool, loop:bool, loopRange:{start,end}|null, clipStart:number|null, error:string|null,
         speakTurn:null|"prompt"|"recording"|"grading"|"feedback"}  // non-null while the native speak turn runs; the page must leave the stop alone
```

## Methods (page -> native)

- `load {itemId, title, artwork?:string|null, sections:[Section], settings:Settings, startIdx:int}` -> `{}`; replaces the queue, does not start playing. `artwork` is an absolute http(s) URL of the item's picture (the page sends `/api/items/<id>/image`) for the lock-screen card; absent or null shows the app icon. Any other value is an error.
- `play {}` / `pause {}` / `toggle {}` -> `{}`
- `next {}` / `prev {}` / `goto {idx}` -> `{}`; moves to that section, restarts its step loop at step 0.
- `replay {kind}` kind in original|clear|translation|vocab -> `{}`; plays that clip for the current section once, then resumes the loop where it was (if it was playing).
- `rewind {steps:[kind...], slow:int 0-50, after?:"resume"|"advance"}` -> `{}`; interrupts, plays the current section's clips in `steps` order (`vocab` skipped when the section has none; empty/unknown steps or no playable step -> error), `original` clips at `rate * (1 - slow/100)`, others at their normal rate, then, with `after` "resume" (the default; pocket gestures, remote commands and voice always use it), resumes the interrupted step from its beginning (if it was playing). With `after` "advance" it instead continues as if the current section's last step had just finished (if it was playing): autoAdvance moves to the next section at step 0, otherwise it pauses with step null; with loop on it returns to looping the current section. A paused player stays paused either way. Any other `after` value is an error. `replay {kind}` is `rewind {steps:[kind], slow:0}` (resume).
- `loop {on:bool, start?:number, end?:number}` -> `{}`; session-only (State.loop and State.loopRange, reset by `load`). `start`/`end` (absolute episode seconds, both or neither, finite, start < end, `on:true` only) restrict the loop to that slice of the section. See step loop semantics.
- `setSettings {settings}` -> `{}`; applies to the current and later sections.
- `getState {}` -> State
- `pocketMode {on:bool}` -> `{}`; native shows/hides its pocket overlay (see below).
- `download {items:[{itemId:string, urls:[string]}]}` -> `{}` immediately. Offline cache: each call REPLACES the target set. Audio of any item not listed is deleted; every listed url not yet on disk is queued and fetched one at a time (a newer call replaces the pending queue; an in-flight fetch may finish). Only `http(s)` urls whose path starts with `/audio/` and has no `..` are accepted (anything else is an error for the whole call). The file is stored at `Application Support/ListenAudio/<url path>` (so `http://host:8315/audio/<id>/tts/12-clear.mp3` -> `.../ListenAudio/audio/<id>/tts/12-clear.mp3`, excluded from iCloud backup) and `load`ed sections whose url is on disk play from the file. Only a 2xx response with a non-empty body is saved; failures are logged and skipped, the next `download` call retries them.
- `getDownloads {}` -> `{root:string, items:{<itemId>:{have:int, total:int, bytes:int}}, pending:int}`; for verification. `have`/`total` count the urls of the last `download` call (on disk / listed), `pending` is queued + in-flight fetches.
- `chime {itemId, kind}` -> `{}`; plays the Listen & speak stop chime (GET `/api/speak/prompt.mp3?item&kind`, the one chime file for every item and kind, fetched once per launch) through AVAudioPlayer. The page never creates an AudioContext inside the app: one takes the audio session from the player, which pauses for the interruption and resumes when it ends. A failed fetch or decode is an `error` event.
- `voice {on:bool}` -> `{}`; starts/stops the in-app voice command listener for ~4 s (`on:true`) or cancels it.
- `locationStart {}` / `locationStop {}` -> `{}`; Ride map position feed. `locationStart` asks for when-in-use authorization (first call prompts) and starts CLLocationManager at best-for-navigation accuracy; fixes arrive as `location` events until `locationStop`. Foreground only, no background updates; the page calls `locationStop` when the Ride overlay closes. `locationStart` errors when access is already denied/restricted.

## Events (native -> page)

- `state` State — on every change and at 4 Hz while playing.
- `command {name, idx}` — an action the PAGE must execute because it owns the data: `save` (save current section as a card), `reveal` (show transcript). Raised by voice or pocket gestures.
- `heard {transcript, matched:string|null}` — what the voice listener recognised (for the page to show briefly).
- `location {lat, lng, accuracy, heading:number|null, speed:number|null}` — one fix while location is started (degrees/metres/m·s⁻¹). `heading` is GPS course while moving, else the compass heading, `null` if neither; `speed` `null` if unknown.
- `speakResult {...}` — the grade JSON from POST /api/speak/grade for a native speak turn (score, feedback, corrections, transcript, kind, from, to, feedbackAudioUrl), emitted as soon as it is back, before the feedback is spoken.
- `open {target:'practice', at}` — the lock-screen Practice Control was pressed (`at` = press time, epoch ms). Native also installs a document-start script setting `window.__listenOpen` to the same payload (self-expiring after 20 s) and re-sends both after each navigation within 20 s. The page opens Practice once per `at`, ahead of launch/resume/restore.
- `error {message}` — playback/audio-session failures, with the real underlying message. Also every failure of a native speak turn.

## Step loop semantics (identical in native and the JS fallback)

For section i, for each step in settings.steps in order: play that clip (skip `vocab` when `audio.vocab` is null; the vocab step is not an audio file: the player speaks the section's `vocab` list with the device voices, each `term` in the `target` locale voice, ~350 ms, its `gloss` in the `native` locale voice, ~700 ms, e.g. `{target:"pt-BR", native:"en-US"}`; `audio.vocab` as a URL string, the pre-device-speech shape, is still played as an mp3 clip); each step is played `settings.times[step]` times (default 1); `original` plays at `rate`. After the last step: if autoAdvance and i is not in holdAfter, go to i+1 and continue; else pause with idx = i, step = null. `replay` interrupts, plays the clip, then resumes the interrupted step from its beginning. Gaps between clips are ~0.4 s. Position/duration in State describe the CURRENT clip.

Loop (`loop {on:true}`): the current section plays only its `original` clip at `rate`, repeatedly with the normal gap, and never advances; next/prev/goto keep looping the new section. `on:true` while playing interrupts and starts the original from its start; while paused it only sets the flag (play then loops). `on:false` while playing does not interrupt: the clip in flight (and its gap) finishes, then the section counts as finished (advance or pause per autoAdvance). A `rewind` with `after:"advance"` while loop is on returns to looping instead of advancing. State.stepCount is 1 while looping. With a range (`loop {on:true, start, end}`, used by the word popup) only `[max(start, section.start), min(end, section.end)]` of the original repeats at `rate`, with the normal gap, and State.position/duration are relative to that slice; State.loopRange carries the clamped range (null when none). A range outside the section is an error. Calling `loop {on:true}` again while on with a different range, or none, applies it immediately (interrupting a playing clip). `loop {on:false}` during a range loop never skips the rest of the section: the original in flight runs on to the section end (or, if it had already ended, the next clip plays from the range end to the section end), then the section counts as finished. State.clipStart is the absolute episode second where the original clip in flight begins (null for other kinds), so position + clipStart is the episode time. The range is cleared by `loop {on:false}`, `load` and any section index change (next/prev/goto/advance), while the loop flag itself keeps the semantics above. `rewind`/`replay` clips ignore the range.

Revisit: the engine tracks `furthest`, the highest section idx entered this session (startIdx on load, updated on every idx change). With `settings.revisitSteps` "original" (also when absent), a section with idx < furthest plays only `["original"]`, exactly once (times ignored); "all" plays the normal steps. State.stepCount reflects loop and revisit. Note the JS fallback (listen/public/engine.js) treats an absent revisitSteps as "all"; the page always sends it.

Song modes (both optional, absent = false; non-bool values are rejected like other settings):

- `settings.skipRepeats` with `section.repeat` true: that section plays only its `original`, exactly once (times ignored), exactly like the revisit rule, but only when `"original"` is among `settings.steps` (otherwise the normal steps play). `loop` still overrides (original, repeated). State.stepCount reflects it.
- `settings.continuous`: plays the song as ONE uninterrupted original clip. (1) Every section's effective steps are `["original"]` played once (settings.steps/times/revisitSteps/skipRepeats are ignored), and the gap between clips is 0. (2) In the normal step loop (not loop mode, not a rewind/replay) with `autoAdvance` on, the `original` clip is started with its end at the LAST section's end (one AVPlayerItem from the current section to the end of the song; nothing is re-created or re-seeked at line boundaries). When playback reaches a later section's start, the engine enters it (idx, furthest, stepIndex 0, step "original", state published); a clip that ends enters any section not yet entered. When the clip ends, the engine continues as if the last section's original had finished (the song is over: pause, ended). State.clipStart stays the first section's start, so position + clipStart is the true episode time; State.position/duration describe the whole run (first section start to song end). With `autoAdvance` off the clip stops at the section end. Pause, next/prev/goto, loop and rewind/replay interrupt the run as they interrupt any clip; resuming plays on from the current section to the song end (the web engine restarts the clip at the current section's start, native resumes the paused item in place).

## Now Playing / remote commands (native)

Title = item title; artist = "<step label> · <section idx+1>/<count>" (labels: Vocab, Clear, English, Original; "Done" once ended); album = "Listen"; artwork = the `load` artwork once fetched (URLSession's cache keeps it for offline), else the app icon. Enabled commands: play, pause, togglePlayPause (AirPods send play/pause, not toggle), nextTrack (= next), previousTrack (= replay original), skipForward 15 (= next), skipBackward 15 (= replay original). No others.

The audio session is never deactivated once playback has started (pause, episode end, clip error, a new `load`, a voice command or speak turn while paused), because iOS drops the lock-screen card the moment it goes inactive and refuses to start background audio on an inactive session. Other apps' audio therefore does not auto-resume when Listen stops.

## Pocket mode (native)

Full-screen black overlay above the web view: proximity monitoring on (iOS blanks the screen when covered), idle timer disabled, brightness kept at max(current, 0.5) for the first 10 s so the labels are readable, then dropped to minimum (restored on exit), touches ignored except: long-press (0.3 s) anywhere = toggle play/pause; two-finger tap = replay original `pocketReplaySlowdown`% slower than `rate`; two-finger double tap = run `settings.rewinds[0]` (default English then original at normal `rate`); the English-then-again zone label shows that preset's name ("English → Original", "Original 20% slower", ...) and refreshes when settings change; swipe left = next; swipe right = prev; three-finger tap = `command save`. Four giant labelled zones are drawn faintly for when the phone is out of the pocket. Exit: a visible "Exit pocket mode" button needing a 1 s long-press. While in pocket mode, the AirPods double-press (nextTrack) means `voice on` if settings.pocketDoublePress == "voice", else next.

## Speak turn (native)

When the run parks at a section listed in `settings.speakStops` and the page cannot show the stop (app not active, i.e. screen locked, OR the pocket view is up), native runs the turn itself. With the app active and no pocket view nothing changes: the page shows its sheet.

Listening run: a `play` after more than 2 min paused starts a new run at the current section. A summary stop whose range contains that section (past its `from`) is dropped: no hold, no turn. The next summary stop has its `from` lowered to the run start before the turn uses it (the grade request's `from`), so the next ask comes at least one full block after the resume and never covers audio heard before the pause. The page applies the same rule to the speakStops it sends (public/speak.js runStops); native repeats it because the page is suspended while the screen is locked. `load` clears the run.

1. `State.speakTurn` = "prompt": GET `/api/speak/prompt.mp3?item&kind` (spoken in the item's language) and play it.
2. "recording": AVAudioRecorder, AAC .m4a mono, metering on. Gives up after 8 s without speech (not an error) and parks paused as in step 5. Once speech has started, a `repeat` stops after ~1.8 s of silence or at 20 s. On-device speech recognition (en-US, fed by an AVAudioEngine tap beside the recorder) runs for both kinds and listens for two control words. A `summary` stops when it hears the answer END with "I'm done" / "I am done"; 12 s of silence and the 180 s cap are only backstops. Saying just "continue" (nothing else) at either kind skips the stop: the recording is dropped unsent, nothing is graded or spoken, and playback RESUMES from afterIdx + 1 (the one ending that plays by itself, since the word is the listener's play press). If speech auth is denied or the recognizer is unavailable the reason is logged, the silence backstops alone end the answer, and "continue" is not heard. The metering threshold (-38 dBFS) is a guess.
3. "grading": POST the recording (`Content-Type: audio/mp4`) to `/api/speak/grade?item&kind&from&to&opId&speak=1`; emit `speakResult`.
4. "feedback": play the returned `feedbackAudioUrl` mp3. A pocket/lock-screen double-press (nextTrack) during this phase re-runs from step 2 (retry); in other phases it keeps its usual meaning.
5. Park: goto afterIdx + 1 and stay PAUSED (`playing` false, step null) with the session switched back to playback; the listener continues with `play` (lock-screen play, the in-app button). Playback never restarts by itself after a stop, whatever way the turn ended. If the stop was the last section, stay ended.

Any failure (mic permission denied, network, HTTP error such as "no speech was recognised", TTS) emits `error` with the real reason and parks as in step 5. `play` is refused while a turn runs. `load` cancels a running turn.

The audio session is still active when the run parks at a stop that starts a turn (a backgrounded app can only begin recording on an already-active session); it is switched to playAndRecord for the turn and back to playback at step 5.

## Voice commands (native)

On-device SFSpeechRecognizer, locale from a small table; mic opened only for the listening window, audio session returns to playback-only afterwards. Vocabulary (either language): again/otra vez -> replay original; english/inglés -> replay translation; clear/claro -> replay clear; vocab/vocabulario -> replay vocab; next/siguiente; back/atrás -> prev; save/guardar -> command save; pause/pausa; play/sigue; slower/más lento (rate -0.1); faster/más rápido (rate +0.1). Unmatched -> `heard` with matched null, nothing else.
