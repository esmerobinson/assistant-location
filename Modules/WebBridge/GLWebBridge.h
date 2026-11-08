// The native side of the GL native<->web bridge protocol v1 -- the WKWebView
// message handler shared by every GLWebModuleViewController-hosted page
// (bundled or HTTP), attached under WKUserContentController name "gl". This
// header is the frozen protocol contract; the pages under Modules/WebPages/
// (settings.html, more.html, and gl-bridge.js's client-side wrapper) were
// written against this exact wire shape and must not change independently of
// it.
//
// Page -> native: `window.webkit.messageHandlers.gl.postMessage({id, method,
// params})` -- `id` a string, `params` a plain object.
//
// Native -> page: `window.__glReply(id, result, error)` -- `result` an
// object or null, `error` a string or null. GLWebBridge replies EXACTLY ONCE
// per request, on the main queue, for every method below (see
// GLWebBridge.m's -userContentController:didReceiveScriptMessage: for the
// per-branch proof).
//
// Boot injection (a WKUserScript, document-start, rebuilt on every page
// load by GLWebModuleViewController -- see -installBootUserScript there,
// NOT this file):
//
//     window.GL_BOOT = {palette: <object|null>, mode: "light"|"dark",
//                        themeId: <string|null>, platform: "ios"};
//     document.documentElement.dataset.theme = <same mode>;
//
// `palette` is the current native palette leaf (+[GLTheme
// currentPaletteColors]): keys "bg", "surface", "text", "text-dim", "accent",
// "danger" (hex strings) plus an optional "bg-gradient", and an optional
// "surface-translucent"/"backdrop-blur" pair (color.surface's true
// alpha-preserving "rgba(...)" value + fx.backdrop-blur's raw CSS value,
// present only for themes that opt into glass tiles -- see design-tokens/
// build.mjs's NATIVE_COLOR_KEYS comment block), exactly as cached by
// GLTheme; null when no palette is cached yet (first-ever launch, offline).
//
// Theme push into a LIVE page (no reload), from GLWebModuleViewController on
// GLThemeDidChangeNotification / GLPaletteDidChangeNotification:
//
//     window.__glThemeChanged({palette, mode, themeId})
//
// via evaluateJavaScript, sent only if the page defines it (guarded with
// `typeof window.__glThemeChanged === 'function' &&`).
//
// Methods (all dispatched through -userContentController:didReceiveScriptMessage:):
//
// - `listModules` -> `{modules: [{identifier, title}]}` -- overflow modules
//   only (those past the first 4 by +moduleOrder), in module order.
//   `identifier` is the GLModule registry identifier (e.g.
//   "GLModule.AutoJournalModule"), `title` is the module's display title.
//
// - `openModule {identifier}` -> `{opened: bool}` -- replicates
//   GLMoreGridViewController's former -openModuleViewController: logic (now
//   GLModuleRegistry's +openModuleViewController:ontoNavigationController:):
//   a module wrapped in a UINavigationController (Journal) is SELECTED,
//   never pushed -- pushing a nav controller raises
//   NSInvalidArgumentException. Optional `demo: bool` (more.html sends it
//   on every open) is forwarded via GLWebBridgeWillOpenModuleNotification;
//   only GrowthViewController acts on it.
//
// - `selectTab {identifier}` -> `{selected: bool}` -- shows the module
//   carrying this restoration identifier, visible tab or More overflow,
//   via GLModuleRegistry's +showModuleWithIdentifier:. For a module
//   jumping straight to another one, e.g. Growth's session gate sending
//   the user to Todos.
//
// - `growthReviewed {quietSeconds?}` -> `{}` -- Growth's web page fires this
//   from respond() on every successful review gesture (growth-quiet-window
//   brief), and from pickTile() with `quietSeconds: 14400` (a tile pick
//   keeps Growth from auto-opening for 4 hours). Records quiet-until =
//   max(existing, now + quietSeconds, default 30 minutes) via
//   +[GrowthModule noteReviewCompletedWithQuietSeconds:], so a shorter
//   window never shortens a longer one. +[GrowthModule isWithinQuietWindow]
//   (read by +[GrowthModule moduleIsDefaultTab]) then makes the next cold
//   launch / long-absence resume open Todos instead of bouncing straight
//   back into Growth. Purely a native-side timestamp write -- nothing in the
//   result payload for the page to act on.
//
// - `esmeCheckinDone {date}` -> `{}` -- Esme's page fires this when the
//   DAILY check-in for local day `date` ("YYYY-MM-DD", else a bridge-level
//   error) is completed. Native records the day (so the reminder top-up never
//   re-adds it) and removes that day's pending and delivered reminder.
//
// - `goBack {}` -> `{}` -- pops the containing navigation controller.
//
// - `getMode` -> `{mode: 0|1|2}`; `setMode {mode}` -> `{}` (calls
//   +[GLTheme setCurrentMode:]).
//
// - `getThemeState` -> `{selectedId: string|null, themes: array|null,
//   error: string|null}` -- native performs GET
//   http://GL_BAKED_HOST:8304/themes.json and GET /api/theme (see
//   SettingsViewController.m for the reference implementation of these same
//   requests/response shapes); `themes` is passed through verbatim. Unbaked
//   host or network failure -> `themes` null + `error` a string, all inside
//   the RESULT object (the bridge-level reply error stays nil -- the RPC
//   itself succeeded, it's the reported state that's unavailable).
//
// - `setTheme {id: string|null}` -> `{ok: bool, error: string|null}` --
//   native PUT /api/theme (same body shape as SettingsViewController.m) then
//   +[GLTheme refreshPaletteFromServer] on success. Same error-placement rule
//   as `getThemeState`: `error` lives inside the result, not the bridge reply.
//
// - `locationPermission` -> `{status: "always"|"whenInUse"|"denied"|
//   "restricted"|"notDetermined"}` (from GLManager's
//   locationManager.authorizationStatus).
//
// - `requestLocationPermission` -> `{}` -- if status is notDetermined, calls
//   +[[GLManager sharedManager] requestAuthorizationPermission]; if
//   denied/restricted, opens UIApplicationOpenSettingsURLString (iOS won't
//   re-prompt).
//
// - `configureWifiZone` -> `{}` -- presents the wifi-zone screen MODALLY
//   (its Save/Reset call dismissViewControllerAnimated:; a push would strand
//   it). Instantiated from Location.storyboard's "WifiZoneViewController"
//   scene (storyboardIdentifier added for exactly this).
//
// - `getApiToken` -> `{token: string}` -- GL_BAKED_TOKEN. Gated: replies with
//   the token only when the REQUESTING FRAME's URL is file://, OR its
//   scheme is http(s), its host equals GL_BAKED_HOST, AND its port is one of
//   the app's own served ports (see Shared/GLApiTokenPolicy.h -- host alone
//   is not enough, since GL_BAKED_HOST also answers on other ports,
//   including the Tailscale-Funnel-exposed :443); otherwise a bridge-level
//   error reply, never the token.
//
// - `getPref {key}` -> `{value: <json|null>}`; `setPref {key, value}` ->
//   `{}` -- whitelist ONLY: "moreOrder" <-> GLMoreGridOrderDefaultsName,
//   "moreHeroes" <-> GLMoreGridHeroesDefaultsName, "cleanTranscripts" <->
//   GLJournalCleanedTranscriptsDefaultsName (RecentRecordingsViewController.h).
//   An unknown key is a bridge-level error reply, never silent success.
//
// - `voiceStart {}` -> `{}` on success, bridge-level error string
//   ("mic_denied", or an audio-session/recorder error message) on failure --
//   starts a single-shot m4a recording (Modules/Sessions' "New Session
//   (voice)" flow; NOT AutoJournalViewController's segmented recorder,
//   which is a different, longer-form capture). Requests mic permission
//   first if not yet determined.
//
// - `voiceStop {launchId, lang}` (`lang: "multi"` = Portuguese-practice todos,
//   an English speaker attempting Portuguese: code-switching transcription
//   instead of en-US) -> `{text, id}` for a real transcript, `{code:
//   "empty_transcript", id}` for genuinely-silent audio, `{code: "failed", id,
//   error}` when the box refused it, `{code: "queued", id}` when the box is
//   unreachable or answering 5xx/429/408 (retried automatically), or a
//   bridge-level error string when the recording could not be saved at all.
//   Stops the recorder started by `voiceStart`, writes the m4a to the durable
//   outbox (GLDurableOutbox, meta.launchId = the page's row id) BEFORE the temp
//   file is deleted, uploads it to location-server's `POST /sessions/transcribe`,
//   and deactivates the audio session. The recording is never deleted by a
//   failure: only `voiceAck`. An AVAudioSessionInterruptionNotification (a
//   call, Siri) arriving mid-recording stops the recorder early and keeps
//   whatever was captured.
//
// - `voiceCancel {}` -> `{}` stops the recorder and deletes the recording
//   without uploading it.
//
// - `voicePending {}` -> `{ready: [{id, text, launchId}], failed: [{id, error,
//   launchId}], pending: [{id, launchId}], waiting: <int>}` -- every queued
//   recording by state; reading deletes nothing.
//   `voiceAck {id}` -> `{}` deletes an entry (the session it became is
//   confirmed started, or the user discarded it).
//   `voiceAudio {id}` -> `{base64, mime}` the queued recording, for playback.
//   `voiceRetry {id}` -> `{}` re-queues a failed recording and flushes.
//
// - `outboxHandoff {ops: [{opId, path, body}]}` -> `{accepted: <int>}` --
//   hands the Todos tab's offline write queue to native (see
//   Shared/GLTodoOutbox.h for the full design). REPLACES the stored outbox
//   with exactly these ops, in order, and starts/resumes draining them via
//   a background NSURLSession -- native then keeps retrying them (even
//   while the app is suspended or has been relaunched by the OS) until one
//   fails or the page calls `outboxReclaim`. A malformed op (missing/wrong-
//   typed opId, path, or body) is dropped rather than accepted -- `accepted`
//   reports how many of `ops` actually got queued. Idempotent: calling this
//   twice in a row with the same ops (the `hidden` + `pagehide` double-fire
//   case) is a no-op the second time, never a second concurrent upload.
//
// - `outboxReclaim {}` -> `{sent: [opId, ...], remaining: [{opId, path,
//   body}, ...], failed: {opId, status}|null}` -- the page reclaiming
//   ownership of the queue (e.g. becoming visible again). Halts native's
//   upload chain (cancelling any in-flight request), clears its store, and
//   reports which ops it got sent, which are still unsent, and the failure
//   (if any) that stopped the chain. The web side is the owner again once
//   this returns -- it decides what to do with `remaining`/`failed` (retry,
//   drop, surface a conflict), native does not retry or arbitrate for it.
//
// - `authenticate {reason}` -> `{ok: true}` after Face ID (or the device
//   passcode, via iOS's own fallback); error "cancelled" if the user backed
//   out, "failed: <description>" for anything else. Used by the Recent page
//   to unlock private journal entries; the page treats every error as
//   "stay locked".
//
// - Any other method name -> bridge-level error reply
//   "unknown method <name>".

#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>

NS_ASSUME_NONNULL_BEGIN

/// Posted synchronously by `openModule`, BEFORE the module is opened, with
/// userInfo @{@"identifier": NSString, @"demo": NSNumber(BOOL)}. Lets a
/// module react to per-open options (GrowthViewController's demo mode)
/// without the bridge knowing about any specific module.
extern NSString *const GLWebBridgeWillOpenModuleNotification;

@interface GLWebBridge : NSObject <WKScriptMessageHandler>

/// `hostViewController` is the GLWebModuleViewController this bridge is
/// attached to -- used for `goBack` (pops its navigationController) and
/// `configureWifiZone` (presents modally from it). Held weakly: the
/// WKUserContentController holds a STRONG reference to this bridge, so a
/// strong back-reference here would be a retain cycle.
- (instancetype)initWithHostViewController:(UIViewController *)hostViewController;

/// YES from a voiceStart until its voiceStop/voiceCancel. Reloading the page
/// in this window strands the recorder: the new page has no `recording`
/// state, so nothing ever stops or sends the clip.
@property(nonatomic, readonly) BOOL voiceCaptureActive;

@end

NS_ASSUME_NONNULL_END
