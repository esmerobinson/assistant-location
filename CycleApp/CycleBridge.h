#import <Foundation/Foundation.h>

@class CycleStore, CycleNotifier;

/// Native side of the page <-> shell contract (handler name `cycle`).
/// JS -> native: {id, cmd, args}. Native answers with window.__cycleReply(id, result, error).
/// Commands: store.get/set/keys, notify.permission/status/schedule/cancel, app.openSettings, app.info, app.openURL, speech.start/speech.stop/speech.cancel, haptic, share, share.text, clipboard.set, lock.get/set,
/// creds.set/get/clear (Keychain), ready.
/// Native -> JS: window.cycleNative.route(route) (queued until the page sends `ready`) and
/// window.cycleNative.foreground() (only once the page is ready), window.cycleNative.pushToken(hex) (on `ready` and when a token arrives),
/// window.cycleNative.speechSilence() and window.cycleNative.speechError(message) while speech.start is recording.
/// Everything runs on the main thread; script evaluation goes through `evaluateJS` so the bridge
/// has no WebKit dependency.
@interface CycleBridge : NSObject

@property (nonatomic, copy) void (^evaluateJS)(NSString *js);
/// Presents the system share sheet for these activity items (an NSURL for `share`, an NSString for `share.text`). Wired by the view controller.
@property (nonatomic, copy) void (^presentItems)(NSArray *items);

/// Puts a string on the system pasteboard (the `clipboard.set` command). Wired by the view controller.
@property (nonatomic, copy) void (^setClipboard)(NSString *text);

/// Fired on the main thread after lock.set changes the Face ID flag. Wired by the view controller.
@property (nonatomic, copy) void (^lockChanged)(void);

/// Opens this app's page in iOS Settings (the `app.openSettings` command). Wired by the view controller.
@property (nonatomic, copy) void (^openSettings)(void);

/// This build's Info.plist values for the `app.info` command ({shell, native}); defaults to the main bundle's, tests inject their own.
@property (nonatomic, copy) NSDictionary *bundleInfo;

/// Opens an https URL outside the app (the `app.openURL` command, used for the install page). Wired by the view controller.
@property (nonatomic, copy) void (^openURL)(NSURL *url);

/// Starts recording (the `speech.start` command); `done(nil)` once recording, else a short reason ("Mic off" when denied).
/// Wired by the view controller. The page, not native, uploads the clip for transcription.
@property (nonatomic, copy) void (^speechStart)(void (^done)(NSString *error));
/// Stops recording and returns the m4a bytes, nil when nothing was recorded (the `speech.stop` command, which replies
/// `{audio: base64, mime}` or null). Wired by the view controller.
@property (nonatomic, copy) NSData *(^speechStop)(void);
/// Stops recording and discards it (the `speech.cancel` command). Wired by the view controller.
@property (nonatomic, copy) void (^speechCancel)(void);
/// The app went to the background (see -speechInterrupted). Wired by the view controller.
@property (nonatomic, copy) void (^speechInterrupt)(void);

/// The Face ID app-lock flag (NSUserDefaults, default ON).
+ (BOOL)lockEnabled;

/// YES until the first successful Face ID unlock; lock.set resets it, so turning the lock on asks once more.
+ (BOOL)lockNeedsAuth;
+ (void)markLockPassed;

- (instancetype)initWithStore:(CycleStore *)store notifier:(CycleNotifier *)notifier;

/// A script message body from the page; the reply goes out through `evaluateJS` on the main queue.
- (void)handleMessage:(id)body;
/// Runs one command; `done(result, error)` fires exactly once (error nil = success), possibly
/// asynchronously. handleMessage: wraps this with the reply plumbing.
- (void)dispatchCommand:(NSString *)cmd args:(NSDictionary *)args completion:(void (^)(id result, NSString *error))done;
/// A notification was tapped: deliver now if the page is ready, else queue.
- (void)deliverRoute:(NSString *)route;
/// The APNs device token (hex): remembered, and handed to the page as cycleNative.pushToken(hex) whenever it is
/// ready (now, and again after each page reload), so the page can register it with the box.
- (void)deliverPushToken:(NSString *)hex;
/// Speech then silence heard while recording -> window.cycleNative.speechSilence().
- (void)deliverSpeechSilence;
/// A running recording failed -> window.cycleNative.speechError(message).
- (void)deliverSpeechError:(NSString *)message;
/// The app is leaving the foreground: iOS stops the microphone, so the recording is finalized but kept for the page's
/// pending speech.stop, and the page hears speechSilence (Talk ends its turn; a dictated field waits for its mic tap).
- (void)speechInterrupted;
/// The app became active.
- (void)foreground;
/// The web view started a new navigation: the new page must send `ready` again.
- (void)pageWillReload;

@end
