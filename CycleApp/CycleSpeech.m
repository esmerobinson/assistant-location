#import "CycleSpeech.h"

#import <AVFoundation/AVFoundation.h>

// Silence detection polls the recorder's average power. Both numbers are guesses (dB, 0 = full scale): speech above
// SPEECH_DB counts as heard, then SILENCE_MS below it ends the turn. Tune on a device.
static const float SPEECH_DB = -35.0f;
static const NSTimeInterval SILENCE_S = 1.8;
static const NSTimeInterval POLL_S = 0.1;

@interface CycleSpeech () <AVAudioRecorderDelegate>
@property (nonatomic, strong) AVAudioRecorder *recorder;
@property (nonatomic, strong) NSURL *url;
@property (nonatomic, strong) NSTimer *meter;
@property (nonatomic, assign) BOOL heardSpeech;
@property (nonatomic, assign) NSTimeInterval quietSince; // 0 while loud
@property (nonatomic, assign) NSUInteger generation;     // a permission prompt answered after cancel must not start a recording
@end

@implementation CycleSpeech

- (void)startWithCompletion:(void (^)(NSString *))done {
    [self cancel];
    NSUInteger gen = self.generation;
    [AVAudioSession.sharedInstance requestRecordPermission:^(BOOL granted) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (!granted) { NSLog(@"[Cycle] microphone permission denied"); done(@"Mic off"); return; }
            if (gen != self.generation) { done(@"Speech stopped"); return; }
            done([self beginRecording]);
        });
    }];
}

/// Returns nil once recording, else the short reason.
- (NSString *)beginRecording {
    NSError *error = nil;
    AVAudioSession *session = AVAudioSession.sharedInstance;
    if (![session setCategory:AVAudioSessionCategoryRecord mode:AVAudioSessionModeMeasurement options:AVAudioSessionCategoryOptionDuckOthers error:&error] ||
        ![session setActive:YES withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:&error]) {
        NSLog(@"[Cycle] audio session failed: %@ (%@ %ld)", error.localizedDescription, error.domain, (long)error.code);
        return @"Mic busy";
    }
    NSURL *url = [NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:[NSString stringWithFormat:@"cycle-voice-%@.m4a", NSUUID.UUID.UUIDString]]];
    // 48kHz mono AAC at 96kbps. 16kHz at AVAudioQualityMedium (~32kbps) cost accuracy: in a 2026-11-06 bake-off on real phone
    // voice memos, the 48k/96k variant had fewer misheard words for nearly every model (nova-3 11 -> 7, gemini-3.5-transcribe
    // 6 -> 3). About 12KB per second uploaded, far under the box's 25MB cap.
    NSDictionary *settings = @{ AVFormatIDKey: @(kAudioFormatMPEG4AAC), AVSampleRateKey: @48000, AVNumberOfChannelsKey: @1, AVEncoderBitRateKey: @96000, AVEncoderAudioQualityKey: @(AVAudioQualityHigh) };
    AVAudioRecorder *recorder = [[AVAudioRecorder alloc] initWithURL:url settings:settings error:&error];
    if (!recorder || ![recorder prepareToRecord] || ![recorder record]) {
        NSLog(@"[Cycle] recorder failed: %@ (%@ %ld)", error.localizedDescription, error.domain, (long)error.code);
        [session setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:NULL];
        return @"Mic busy";
    }
    recorder.delegate = self;
    recorder.meteringEnabled = YES;
    self.recorder = recorder; self.url = url; self.heardSpeech = NO; self.quietSince = 0;
    __weak CycleSpeech *weakSelf = self;
    self.meter = [NSTimer scheduledTimerWithTimeInterval:POLL_S repeats:YES block:^(NSTimer *t) { [weakSelf poll]; }];
    return nil;
}

- (void)poll {
    if (!self.recorder.isRecording) return;
    [self.recorder updateMeters];
    float db = [self.recorder averagePowerForChannel:0];
    NSTimeInterval now = NSProcessInfo.processInfo.systemUptime;
    if (db > SPEECH_DB) { self.heardSpeech = YES; self.quietSince = 0; return; }
    if (!self.heardSpeech) return;
    if (self.quietSince == 0) self.quietSince = now;
    if (now - self.quietSince >= SILENCE_S) {
        self.heardSpeech = NO; // once per utterance; the page decides whether to stop
        if (self.onSilence) self.onSilence();
    }
}

- (void)audioRecorderEncodeErrorDidOccur:(AVAudioRecorder *)recorder error:(NSError *)error {
    NSLog(@"[Cycle] recorder error: %@", error);
    if (recorder != self.recorder) return;
    [self cancel];
    if (self.onError) self.onError(@"Mic busy");
}

/// Ends the timer and the recorder (-stop finalizes the m4a container, -pause would not) and frees the audio session.
- (void)halt {
    [self.meter invalidate]; self.meter = nil;
    if (!self.recorder) return;
    [self.recorder stop];
    NSError *error = nil;
    if (![AVAudioSession.sharedInstance setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:&error]) {
        NSLog(@"[Cycle] could not deactivate audio session: %@", error);
    }
}

- (NSData *)finish {
    self.generation++;
    [self halt];
    NSURL *url = self.url;
    self.recorder = nil; self.url = nil;
    if (!url) return nil;
    NSData *audio = [NSData dataWithContentsOfURL:url];
    [NSFileManager.defaultManager removeItemAtURL:url error:NULL];
    return audio.length ? audio : nil;
}

- (void)cancel {
    [self finish];
}

- (void)interrupt {
    if (!self.recorder) return;
    [self halt]; // keeps self.url and the file; finish still returns it
    if (self.onSilence) self.onSilence();
}

@end
