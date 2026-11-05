#import <Foundation/Foundation.h>

/// Voice capture for a page field or Talk (bridge `speech.start` / `speech.stop` / `speech.cancel`): records the microphone
/// to a temp m4a (AAC, 16 kHz mono). The page uploads the clip to the Cycle box, which transcribes it with Deepgram, so no
/// recognition happens on the device. The recording lives only in the temp file until `finish` or `cancel` deletes it.
@interface CycleSpeech : NSObject

/// Main queue. Once speech has been heard and then silence has held for a while (thresholds are guesses, see the .m).
@property (nonatomic, copy) void (^onSilence)(void);
/// Main queue. A short user-facing reason a running recording failed.
@property (nonatomic, copy) void (^onError)(NSString *message);

/// Asks for the microphone permission on first use, then starts recording. `done(nil)` once recording, else
/// `done(@"Mic off")` when denied or `done(<short reason>)` ("Mic busy"). Main queue, exactly once.
- (void)startWithCompletion:(void (^)(NSString *error))done;
/// Stops recording, deletes the file and returns its bytes; nil when nothing was recording (or it was empty).
/// Releases the microphone and the audio session.
- (NSData *)finish;
/// Stops recording and deletes the file. Safe when idle.
- (void)cancel;
/// The app went to the background: iOS stops the microphone, so finalize the file and keep it for the pending `finish`,
/// and report silence so Talk ends its turn. A dictated field keeps its mic lit until the person taps it.
- (void)interrupt;

@end
