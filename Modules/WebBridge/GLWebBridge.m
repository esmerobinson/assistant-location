#import "GLWebBridge.h"

#import <AVFoundation/AVFoundation.h>
#import <CoreLocation/CoreLocation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <Photos/Photos.h>
#import <UIKit/UIKit.h>

#import "BakedConfig.h"
#import "GLApiTokenPolicy.h"
#import "GLCrashReporter.h"
#import "GLDefaultsKeys.h"
#import "GLDurableOutboxShared.h"
#import "GLEndpoints.h"
#import "EsmeModule.h"
#import "GLEsmeReminderScheduling.h"
#import "GLManager.h"
#import "GLModuleRegistry.h"
#import "GrowthModule.h"
#import "GLTheme.h"
#import "GLTodoOutbox.h"
#import "RecentRecordingsViewController.h"

typedef void (^GLWebBridgeReplyBlock)(NSDictionary *_Nullable result, NSString *_Nullable error);

// Same theme-server host/port every other file in this app builds directly
// from GL_BAKED_HOST (GLTheme.m, SettingsViewController.m, GLAppStateReporter.m,
// EventsViewController.m) -- duplicated rather than shared, matching that
// existing convention, since GLEndpointURL() raises when GL_BAKED_HOST is
// unbaked (true for every sim-test CI build) and every one of those files
// needs to fail through NSURLSession's ordinary error path instead.
static NSInteger const kGLWebBridgeThemeServerPort = 8304;

static NSURL *_Nullable GLWebBridgeThemeServerURL(NSString *path) {
    NSString *urlString = [NSString stringWithFormat:@"http://%@:%ld%@", GL_BAKED_HOST, (long)kGLWebBridgeThemeServerPort, path];
    return [NSURL URLWithString:urlString];
}

// Shared success/parse gate, matching SettingsViewController.m's
// JSONFromResponse:expectedClass: / GLTheme.m's GLThemeJSONFromResponse.
static id _Nullable GLWebBridgeJSONFromResponse(NSURLResponse *response, NSData *data, NSError *error, Class expectedClass) {
    if (error || data.length == 0) return nil;
    NSInteger status = ((NSHTTPURLResponse *)response).statusCode;
    if (status < 200 || status > 299) return nil;
    NSError *jsonError = nil;
    id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&jsonError];
    if (jsonError || ![parsed isKindOfClass:expectedClass]) return nil;
    return parsed;
}

@interface GLWebBridge () <AVAudioRecorderDelegate>
@property(nonatomic, weak) UIViewController *hostViewController;
// A single-shot recorder for the Sessions "New Session (voice)" flow --
// deliberately NOT the segmented multi-pause recorder AutoJournalViewController
// owns (its whole reason to exist is a long journal entry you pause/resume/
// retry over minutes). A session voice prompt is one short capture: tap to
// start, tap to stop, transcribe, done. Reusing AutoJournalViewController's
// machinery here would drag in its draft-persistence/segment-stitching
// concerns for a feature that needs none of them.
@property(nonatomic, strong, nullable) AVAudioRecorder *voiceRecorder;
@property(nonatomic, copy, nullable) NSURL *voiceRecordingURL;
// Set true when -voiceStartWithReply: begins and false once the recorder
// has actually finished writing (delegate callback OR an interruption-
// driven -stop) -- voiceStopWithReply: uses this to tell "stop was called
// before any audio was captured" apart from "a session interruption already
// stopped us, the file is already final".
@property(nonatomic, assign) BOOL voiceRecordingInFlight;

@end

NSString *const GLWebBridgeWillOpenModuleNotification = @"GLWebBridgeWillOpenModuleNotification";

@implementation GLWebBridge

- (instancetype)initWithHostViewController:(UIViewController *)hostViewController {
    self = [super init];
    if (self) {
        _hostViewController = hostViewController;
        // AVAudioSessionInterruptionNotification (a phone call, Siri, another
        // app taking the mic) is the one way a recording can be torn down out
        // from under this bridge with no user tap involved -- without this
        // observer, voiceStop would evaluateJavaScript into a WKWebView that
        // never gets a reply because the recorder object it expects to stop
        // was already invalidated by the OS. -audioSessionInterrupted: calls
        // -stop (never -pause), same reasoning as
        // AutoJournalViewController's pauseRecording comment: -stop finalizes
        // a real, valid, durable m4a immediately, so whatever was captured
        // before the interruption is still transcribable.
        [[NSNotificationCenter defaultCenter] addObserver:self
                                                   selector:@selector(audioSessionInterrupted:)
                                                       name:AVAudioSessionInterruptionNotification
                                                     object:nil];
    }
    return self;
}

- (void)dealloc {
    [[NSNotificationCenter defaultCenter] removeObserver:self];
}

#pragma mark - WKScriptMessageHandler

// Every method below calls `reply` on exactly one path: the ones with no
// network/async step (listModules, openModule, goBack, getMode, setMode,
// locationPermission, requestLocationPermission, configureWifiZone,
// getApiToken, getPref, setPref, unknown-method) call it synchronously,
// inline, on this same (main-thread) call; getThemeState, setTheme and authenticate (LocalAuthentication) hand
// `reply` into a network or LocalAuthentication completion handler that dispatches back to the main
// queue before calling it exactly once. -sendReplyToWebView:... itself
// dispatches to the main queue too, so evaluateJavaScript is always called
// on it regardless of which of those two paths a given call took.
- (void)userContentController:(WKUserContentController *)userContentController
       didReceiveScriptMessage:(WKScriptMessage *)message {
    NSDictionary *body = [message.body isKindOfClass:[NSDictionary class]] ? message.body : nil;
    NSString *requestId = [body[@"id"] isKindOfClass:[NSString class]] ? body[@"id"] : nil;
    NSString *methodName = [body[@"method"] isKindOfClass:[NSString class]] ? body[@"method"] : nil;
    NSDictionary *params = [body[@"params"] isKindOfClass:[NSDictionary class]] ? body[@"params"] : @{};
    WKWebView *webView = message.webView;

    if (requestId.length == 0 || methodName.length == 0 || webView == nil) {
        // No id (or no webView to reply on) means there is no channel to
        // signal an error back on -- nothing to do but drop the message.
        return;
    }

    GLWebBridgeReplyBlock reply = ^(NSDictionary *_Nullable result, NSString *_Nullable error) {
        [self sendReplyToWebView:webView requestId:requestId result:result error:error];
    };

    // Breadcrumb for the Events-tile crash investigation (see
    // GLCrashReporter.h): every bridge call from the web page is a
    // candidate last-thing-that-happened before a crash, and `identifier`
    // specifically is the param `openModule` sends -- the exact call the
    // crash is suspected to be in. Other methods' params are omitted here
    // (not all of them are strings, and only `identifier` matters for this
    // investigation); add more param keys if a future investigation needs
    // them.
    [GLCrashReporter addBreadcrumb:[NSString stringWithFormat:
        @"GLWebBridge dispatch method=%@ identifier=%@",
        methodName, params[@"identifier"] ?: @"(none)"]];

    if ([methodName isEqualToString:@"listModules"]) {
        reply(@{@"modules": [GLModuleRegistry overflowModuleDescriptors]}, nil);

    } else if ([methodName isEqualToString:@"openModule"]) {
        NSString *identifier = [params[@"identifier"] isKindOfClass:[NSString class]] ? params[@"identifier"] : nil;
        if (identifier != nil) {
            BOOL demo = [params[@"demo"] isKindOfClass:[NSNumber class]] && [params[@"demo"] boolValue];
            [[NSNotificationCenter defaultCenter] postNotificationName:GLWebBridgeWillOpenModuleNotification
                                                                object:self
                                                              userInfo:@{@"identifier": identifier, @"demo": @(demo)}];
        }
        BOOL opened = identifier != nil && [GLModuleRegistry openOverflowModuleWithIdentifier:identifier];
        // End-to-end proof this call actually reached native code, for
        // sim-test.yml's web-tap targets (UITEST_MORE_TILE_TAP): a hook that
        // never fires this bridge message (e.g. the page never rendered a
        // tappable tile) is a different failure than one that fires it and
        // gets NO back (the module lookup/open itself failed) -- both look
        // identical from a screenshot alone.
        NSLog(@"GLWebBridge: openModule identifier=%@ opened=%@", identifier, opened ? @"YES" : @"NO");
        reply(@{@"opened": @(opened)}, nil);

    } else if ([methodName isEqualToString:@"selectTab"]) {
        // For a module jumping straight to another VISIBLE tab (e.g.
        // Growth's session gate sending the user to Todos) -- unlike
        // openModule above, this is not limited to the More overflow.
        NSString *identifier = [params[@"identifier"] isKindOfClass:[NSString class]] ? params[@"identifier"] : nil;
        BOOL selected = identifier != nil &&
            [GLModuleRegistry showModuleWithIdentifier:identifier];
        NSLog(@"GLWebBridge: selectTab identifier=%@ selected=%@", identifier, selected ? @"YES" : @"NO");
        reply(@{@"selected": @(selected)}, nil);

    } else if ([methodName isEqualToString:@"goBack"]) {
        [self.hostViewController.navigationController popViewControllerAnimated:YES];
        reply(@{}, nil);

    } else if ([methodName isEqualToString:@"growthReviewed"]) {
        // growth-quiet-window brief: the web page fires this from respond()
        // on EVERY successful review gesture (see growth/public/app.js).
        // GrowthModule owns the storage key and the quiet-window math (see
        // its own comments) -- this bridge deliberately doesn't touch
        // NSUserDefaults directly, matching how selectTab above defers to
        // GLModuleRegistry instead of reaching into tab-selection internals
        // itself.
        // Optional quietSeconds: a tile pick asks for a longer window (4h);
        // absent means the 30-minute default. A present non-number is a page bug.
        id quietSeconds = params[@"quietSeconds"];
        if (quietSeconds && ![quietSeconds isKindOfClass:[NSNumber class]]) {
            reply(nil, @"growthReviewed: quietSeconds must be a number");
            return;
        }
        [GrowthModule noteReviewCompletedWithQuietSeconds:quietSeconds];
        reply(@{}, nil);

    } else if ([methodName isEqualToString:@"esmeCheckinDone"]) {
        // Esme's web page fires this when today's DAILY check-in is done
        // (never for ad-hoc ones). EsmeModule persists the day and cancels
        // that day's pending/delivered reminder.
        NSString *date = [params[@"date"] isKindOfClass:[NSString class]] ? params[@"date"] : nil;
        if (![GLEsmeReminderScheduling isValidDayKey:date ?: @""]) {
            reply(nil, @"esmeCheckinDone: date must be YYYY-MM-DD");
        } else {
            [EsmeModule noteCheckinCompletedForDay:date];
            reply(@{}, nil);
        }

    } else if ([methodName isEqualToString:@"getMode"]) {
        reply(@{@"mode": @((NSInteger)[GLTheme currentMode])}, nil);

    } else if ([methodName isEqualToString:@"setMode"]) {
        NSInteger raw = [params[@"mode"] integerValue];
        [GLTheme setCurrentMode:(GLThemeMode)raw];
        reply(@{}, nil);

    } else if ([methodName isEqualToString:@"getThemeState"]) {
        [self fetchThemeStateWithReply:reply];

    } else if ([methodName isEqualToString:@"setTheme"]) {
        NSString *themeId = [params[@"id"] isKindOfClass:[NSString class]] ? params[@"id"] : nil;
        [self setThemeId:themeId reply:reply];

    } else if ([methodName isEqualToString:@"locationPermission"]) {
        reply(@{@"status": [self locationPermissionStatusString]}, nil);

    } else if ([methodName isEqualToString:@"requestLocationPermission"]) {
        [self requestLocationPermission];
        reply(@{}, nil);

    } else if ([methodName isEqualToString:@"configureWifiZone"]) {
        [self presentWifiZoneConfiguration];
        reply(@{}, nil);

    } else if ([methodName isEqualToString:@"getApiToken"]) {
        [self replyWithApiTokenForFrameURL:message.frameInfo.request.URL reply:reply];

    } else if ([methodName isEqualToString:@"getPref"]) {
        [self getPrefWithParams:params reply:reply];

    } else if ([methodName isEqualToString:@"setPref"]) {
        [self setPrefWithParams:params reply:reply];

    } else if ([methodName isEqualToString:@"recentPhotos"]) {
        NSInteger limit = [params[@"limit"] isKindOfClass:[NSNumber class]] ? [params[@"limit"] integerValue] : 8;
        [self recentPhotosWithLimit:limit reply:reply];

    } else if ([methodName isEqualToString:@"photoData"]) {
        NSString *photoId = [params[@"id"] isKindOfClass:[NSString class]] ? params[@"id"] : nil;
        if (photoId.length == 0) {
            reply(nil, @"photoData: id must be a string");
        } else {
            [self photoDataForIdentifier:photoId reply:reply];
        }

    } else if ([methodName isEqualToString:@"voiceStart"]) {
        [self voiceStartWithReply:reply];

    } else if ([methodName isEqualToString:@"voiceStop"]) {
        [self voiceStopWithParams:params reply:reply];

    } else if ([methodName isEqualToString:@"voiceCancel"]) {
        [self voiceCancelWithReply:reply];

    } else if ([methodName isEqualToString:@"voicePending"]) {
        [self voicePendingWithReply:reply];

    } else if ([methodName isEqualToString:@"voiceAudio"]) {
        [self voiceAudioWithParams:params reply:reply];

    } else if ([methodName isEqualToString:@"voiceRetry"]) {
        [self voiceRetryWithParams:params reply:reply];

    } else if ([methodName isEqualToString:@"voiceAck"]) {
        if (![params[@"id"] isKindOfClass:[NSString class]]) {
            reply(nil, @"voiceAck needs a string id");
        } else {
            [[GLDurableOutbox shared] removeItemID:params[@"id"]];
            reply(@{}, nil);
        }

    } else if ([methodName isEqualToString:@"outboxHandoff"]) {
        [self outboxHandoffWithParams:params reply:reply];

    } else if ([methodName isEqualToString:@"outboxReclaim"]) {
        reply([[GLTodoOutbox sharedOutbox] reclaim], nil);

    } else if ([methodName isEqualToString:@"authenticate"]) {
        [self authenticateWithParams:params reply:reply];

    } else {
        reply(nil, [NSString stringWithFormat:@"unknown method %@", methodName]);
    }
}

#pragma mark - Authenticate (private journal entries)

// Face ID / passcode gate for the Recent page's private entries. Policy is
// DeviceOwnerAuthentication (not ...WithBiometrics) so iOS itself offers the
// device passcode when Face ID fails or is not enrolled -- the page never has
// to handle a "no biometrics" dead end. Replies exactly once: LocalAuthentication
// calls the evaluatePolicy handler exactly once, on an arbitrary queue, so the
// reply hops to the main queue first (the bridge's other async paths do the
// same). Errors: user/system/app cancel -> "cancelled" (page stays locked
// silently); everything else -> "failed: <description>" (page also stays locked).
- (void)authenticateWithParams:(NSDictionary *)params reply:(GLWebBridgeReplyBlock)reply {
    NSString *reason = [params[@"reason"] isKindOfClass:[NSString class]] && [params[@"reason"] length] > 0
        ? params[@"reason"] : @"Unlock private entries";
    LAContext *context = [[LAContext alloc] init];
    NSError *policyError = nil;
    if (![context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&policyError]) {
        reply(nil, [NSString stringWithFormat:@"failed: %@", policyError.localizedDescription ?: @"authentication unavailable"]);
        return;
    }
    [context evaluatePolicy:LAPolicyDeviceOwnerAuthentication
            localizedReason:reason
                      reply:^(BOOL success, NSError *_Nullable error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (success) {
                reply(@{@"ok": @YES}, nil);
            } else if (error.code == LAErrorUserCancel || error.code == LAErrorSystemCancel || error.code == LAErrorAppCancel) {
                reply(nil, @"cancelled");
            } else {
                reply(nil, [NSString stringWithFormat:@"failed: %@", error.localizedDescription ?: @"unknown"]);
            }
        });
    }];
}

#pragma mark - Photos

// Calls `done` on the main queue with YES once Photos read access is granted
// (full or limited), NO when denied/restricted.
- (void)withPhotoLibraryAccess:(void (^)(BOOL granted))done {
    // sim-test sets this: the launcher asks for the library on every load, and the unanswered system alert covers
    // every later deep-link launch. `simctl privacy grant photos` does not satisfy a read-write request on the CI
    // simulator (run 42507929752 still showed the full-access alert), so skip the request like UITestSkipNotificationPrompt.
    if ([[NSUserDefaults standardUserDefaults] boolForKey:@"UITestSkipPhotoPrompt"]) { done(NO); return; }
    PHAuthorizationStatus status = [PHPhotoLibrary authorizationStatusForAccessLevel:PHAccessLevelReadWrite];
    if (status == PHAuthorizationStatusNotDetermined) {
        [PHPhotoLibrary requestAuthorizationForAccessLevel:PHAccessLevelReadWrite
                                                   handler:^(PHAuthorizationStatus newStatus) {
            dispatch_async(dispatch_get_main_queue(), ^{
                done(newStatus == PHAuthorizationStatusAuthorized || newStatus == PHAuthorizationStatusLimited);
            });
        }];
        return;
    }
    done(status == PHAuthorizationStatusAuthorized || status == PHAuthorizationStatusLimited);
}

// Renders `asset` to JPEG data no larger than maxDimension on a side. Blocks
// (synchronous request), so call it off the main queue. Returns nil and sets
// *errorOut on failure; iCloud originals are downloaded when needed.
- (NSData *)jpegDataForAsset:(PHAsset *)asset
                maxDimension:(CGFloat)maxDimension
                     quality:(CGFloat)quality
                       error:(NSString **)errorOut {
    PHImageRequestOptions *options = [[PHImageRequestOptions alloc] init];
    options.synchronous = YES;
    options.networkAccessAllowed = YES;
    options.deliveryMode = PHImageRequestOptionsDeliveryModeHighQualityFormat;
    options.resizeMode = PHImageRequestOptionsResizeModeExact;
    __block UIImage *image = nil;
    __block NSString *failure = nil;
    [[PHImageManager defaultManager] requestImageForAsset:asset
                                               targetSize:CGSizeMake(maxDimension, maxDimension)
                                              contentMode:PHImageContentModeAspectFit
                                                  options:options
                                            resultHandler:^(UIImage *result, NSDictionary *info) {
        image = result;
        NSError *err = info[PHImageErrorKey];
        if (err) failure = err.localizedDescription;
    }];
    NSData *jpeg = image ? UIImageJPEGRepresentation(image, quality) : nil;
    if (jpeg == nil && errorOut) *errorOut = failure ?: @"image unavailable";
    return jpeg;
}

- (void)recentPhotosWithLimit:(NSInteger)limit reply:(GLWebBridgeReplyBlock)reply {
    [self withPhotoLibraryAccess:^(BOOL granted) {
        if (!granted) {
            reply(nil, @"photos access denied");
            return;
        }
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            PHFetchOptions *fetchOptions = [[PHFetchOptions alloc] init];
            fetchOptions.sortDescriptors = @[[NSSortDescriptor sortDescriptorWithKey:@"creationDate" ascending:NO]];
            fetchOptions.fetchLimit = (NSUInteger)MAX(limit, 1);
            PHFetchResult<PHAsset *> *assets = [PHAsset fetchAssetsWithMediaType:PHAssetMediaTypeImage options:fetchOptions];
            NSMutableArray *photos = [NSMutableArray array];
            NSString *failure = nil;
            for (PHAsset *asset in assets) {
                NSString *err = nil;
                NSData *jpeg = [self jpegDataForAsset:asset maxDimension:240 quality:0.7 error:&err];
                if (jpeg == nil) { failure = err; break; }
                [photos addObject:@{
                    @"id": asset.localIdentifier,
                    @"thumb": [jpeg base64EncodedStringWithOptions:0],
                    @"created": @((long long)([asset.creationDate timeIntervalSince1970] * 1000.0)),
                }];
            }
            dispatch_async(dispatch_get_main_queue(), ^{
                if (failure) {
                    reply(nil, [NSString stringWithFormat:@"recentPhotos: %@", failure]);
                } else {
                    reply(@{@"photos": photos}, nil);
                }
            });
        });
    }];
}

- (void)photoDataForIdentifier:(NSString *)identifier reply:(GLWebBridgeReplyBlock)reply {
    [self withPhotoLibraryAccess:^(BOOL granted) {
        if (!granted) {
            reply(nil, @"photos access denied");
            return;
        }
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            PHAsset *asset = [PHAsset fetchAssetsWithLocalIdentifiers:@[identifier] options:nil].firstObject;
            NSString *err = nil;
            NSData *jpeg = asset ? [self jpegDataForAsset:asset maxDimension:2048 quality:0.85 error:&err] : nil;
            dispatch_async(dispatch_get_main_queue(), ^{
                if (jpeg) {
                    reply(@{@"data": [jpeg base64EncodedStringWithOptions:0]}, nil);
                } else {
                    reply(nil, [NSString stringWithFormat:@"photoData: %@", asset ? err : @"photo not found"]);
                }
            });
        });
    }];
}

#pragma mark - Reply plumbing

// NSJSONSerialization end to end -- the reply is built as a plain
// array/dictionary/string/number/NSNull tree and handed to
// dataWithJSONObject:, never string-formatted from page/user content
// directly into the evaluated script. The only literal text in the script
// itself is the fixed wrapper around the JSON blob.
- (void)sendReplyToWebView:(WKWebView *)webView
                  requestId:(NSString *)requestId
                     result:(nullable NSDictionary *)result
                      error:(nullable NSString *)error {
    NSArray *args = @[requestId, result ?: [NSNull null], error ?: [NSNull null]];
    NSError *jsonError = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:args options:0 error:&jsonError];
    if (jsonError || data == nil) {
        NSLog(@"GLWebBridge: failed to serialize reply for request %@: %@", requestId, jsonError.localizedDescription);
        return;
    }
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    NSString *script = [NSString stringWithFormat:
        @"(function(a){window.__glReply(a[0], a[1], a[2]);})(%@);", json];
    dispatch_async(dispatch_get_main_queue(), ^{
        [webView evaluateJavaScript:script completionHandler:nil];
    });
}

#pragma mark - Theme

- (void)fetchThemeStateWithReply:(GLWebBridgeReplyBlock)reply {
    NSURL *themesURL = GLWebBridgeThemeServerURL(@"/themes.json");
    if (!themesURL) {
        reply(@{@"selectedId": [NSNull null], @"themes": [NSNull null], @"error": @"invalid theme server URL"}, nil);
        return;
    }

    NSURLSessionDataTask *themesTask = [[NSURLSession sharedSession]
        dataTaskWithURL:themesURL
      completionHandler:^(NSData *themesData, NSURLResponse *themesResponse, NSError *themesError) {
        NSArray *themes = GLWebBridgeJSONFromResponse(themesResponse, themesData, themesError, [NSArray class]);
        if (!themes) {
            dispatch_async(dispatch_get_main_queue(), ^{
                reply(@{@"selectedId": [NSNull null], @"themes": [NSNull null],
                        @"error": @"couldn't reach the theme server"}, nil);
            });
            return;
        }

        NSURL *currentURL = GLWebBridgeThemeServerURL(@"/api/theme");
        NSURLSessionDataTask *currentTask = [[NSURLSession sharedSession]
            dataTaskWithURL:currentURL
          completionHandler:^(NSData *currentData, NSURLResponse *currentResponse, NSError *currentError) {
            NSDictionary *parsed = GLWebBridgeJSONFromResponse(currentResponse, currentData, currentError, [NSDictionary class]);
            dispatch_async(dispatch_get_main_queue(), ^{
                if (!parsed) {
                    reply(@{@"selectedId": [NSNull null], @"themes": [NSNull null],
                            @"error": @"couldn't reach the theme server"}, nil);
                    return;
                }
                id themeValue = parsed[@"theme"];
                NSString *selectedId = [themeValue isKindOfClass:[NSString class]] ? themeValue : nil;
                reply(@{@"selectedId": selectedId ?: [NSNull null], @"themes": themes, @"error": [NSNull null]}, nil);
            });
        }];
        [currentTask resume];
    }];
    [themesTask resume];
}

- (void)setThemeId:(nullable NSString *)themeId reply:(GLWebBridgeReplyBlock)reply {
    NSURL *url = GLWebBridgeThemeServerURL(@"/api/theme");
    if (!url) {
        reply(@{@"ok": @NO, @"error": @"invalid theme server URL"}, nil);
        return;
    }
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    request.HTTPMethod = @"PUT";
    [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
    request.HTTPBody = [NSJSONSerialization dataWithJSONObject:@{@"theme": themeId ?: [NSNull null]}
                                                        options:0
                                                          error:nil];

    NSURLSessionDataTask *task = [[NSURLSession sharedSession]
        dataTaskWithRequest:request
          completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            NSInteger status = [response isKindOfClass:[NSHTTPURLResponse class]] ? ((NSHTTPURLResponse *)response).statusCode : 0;
            if (error || status < 200 || status > 299) {
                reply(@{@"ok": @NO, @"error": error.localizedDescription ?: @"PUT /api/theme failed"}, nil);
                return;
            }
            // Re-themes the native chrome immediately, same as
            // SettingsViewController.m's own successful-PUT path -- without
            // this, picking a theme here would only re-theme THIS page (the
            // one place that already re-fetches /api/theme itself) and leave
            // the tab bar/nav bars showing the previous palette until the
            // app is force-quit and relaunched.
            [GLTheme refreshPaletteFromServer];
            reply(@{@"ok": @YES, @"error": [NSNull null]}, nil);
        });
    }];
    [task resume];
}

#pragma mark - Location

- (NSString *)locationPermissionStatusString {
    switch ([GLManager sharedManager].locationManager.authorizationStatus) {
        case kCLAuthorizationStatusAuthorizedAlways: return @"always";
        case kCLAuthorizationStatusAuthorizedWhenInUse: return @"whenInUse";
        case kCLAuthorizationStatusDenied: return @"denied";
        case kCLAuthorizationStatusRestricted: return @"restricted";
        case kCLAuthorizationStatusNotDetermined: return @"notDetermined";
    }
    return @"notDetermined";
}

- (void)requestLocationPermission {
    CLAuthorizationStatus status = [GLManager sharedManager].locationManager.authorizationStatus;
    if (status == kCLAuthorizationStatusNotDetermined) {
        [[GLManager sharedManager] requestAuthorizationPermission];
        return;
    }
    if (status == kCLAuthorizationStatusDenied || status == kCLAuthorizationStatusRestricted) {
        // iOS will not re-prompt once denied/restricted -- Settings is the
        // only way back, same as SettingsViewController's own handling.
        NSURL *settingsURL = [NSURL URLWithString:UIApplicationOpenSettingsURLString];
        if (settingsURL) {
            [[UIApplication sharedApplication] openURL:settingsURL options:@{} completionHandler:nil];
        }
    }
}

#pragma mark - Wifi zone

- (void)presentWifiZoneConfiguration {
    UIStoryboard *storyboard = [UIStoryboard storyboardWithName:@"Location" bundle:nil];
    UIViewController *wifiZoneViewController =
        [storyboard instantiateViewControllerWithIdentifier:@"WifiZoneViewController"];
    [self.hostViewController presentViewController:wifiZoneViewController animated:YES completion:nil];
}

#pragma mark - Sessions voice capture

// `voiceStart {}` -> `{}` on success, bridge-level error string on failure
// (mic denied, audio session error) -- see GLWebBridge.h's protocol doc
// block for why these two are the one pair of methods in this file that
// isn't documented there yet (this task adds them; the header comment above
// is updated in the same commit).
- (void)voiceStartWithReply:(GLWebBridgeReplyBlock)reply {
    if (self.voiceRecordingInFlight) {
        // A second voiceStart while one is already running -- the page's
        // own `recording` flag is meant to prevent this (session.html's
        // startVoiceCapture guards on `if (recording || starting) return`),
        // but that guard only holds while the page and native agree on
        // state. Before this task's timeoutMs fix, a voiceStart stuck
        // behind a slow mic-permission prompt could blow past
        // GLBridge.call's old fixed 5s timeout, which reset the page's
        // `recording` flag to false while native was STILL waiting on the
        // permission dialog -- a second tap then reached here with a first
        // recorder already live. REPLACE (not refuse): discard the stale
        // recorder/file and start clean, since the old one is almost
        // certainly the orphan from that exact race, not audio the user
        // still wants.
        NSLog(@"GLWebBridge: voiceStart called while already recording -- discarding the in-flight recording and starting fresh");
        [self.voiceRecorder stop];
        [[NSFileManager defaultManager] removeItemAtURL:self.voiceRecordingURL error:NULL];
        self.voiceRecorder = nil;
        self.voiceRecordingURL = nil;
        self.voiceRecordingInFlight = NO;
    }

    AVAudioSession *session = [AVAudioSession sharedInstance];
    if (session.recordPermission == AVAudioSessionRecordPermissionDenied) {
        // iOS will not re-prompt once denied -- same dead end
        // AutoJournalViewController's beginRecordingFlow hits, but that
        // screen has its own inline "enable it in Settings" label to steer
        // the user; this bridge has no UI of its own, so it just reports
        // the code and lets session.html show the message (see that page's
        // startVoiceCapture -> .catch handling).
        reply(nil, @"mic_denied");
        return;
    }

    void (^begin)(void) = ^{
        NSError *error = nil;
        [session setCategory:AVAudioSessionCategoryPlayAndRecord error:&error];
        if (!error) [session setActive:YES error:&error];
        if (error) {
            reply(nil, [NSString stringWithFormat:@"audio session error: %@", error.localizedDescription]);
            return;
        }

        NSURL *url = [[NSURL fileURLWithPath:NSTemporaryDirectory() isDirectory:YES]
            URLByAppendingPathComponent:[NSString stringWithFormat:@"session-voice-%@.m4a", NSUUID.UUID.UUIDString]];
        // Same settings AutoJournalViewController's startRecording uses --
        // Azure's Fast Transcription API (server-side) takes m4a directly,
        // no format negotiation needed on this end.
        NSDictionary *settings = @{
            AVFormatIDKey : @(kAudioFormatMPEG4AAC),
            AVSampleRateKey : @(44100),
            AVNumberOfChannelsKey : @(1),
            AVEncoderAudioQualityKey : @(AVAudioQualityHigh),
        };
        NSError *recorderError = nil;
        AVAudioRecorder *recorder = [[AVAudioRecorder alloc] initWithURL:url settings:settings error:&recorderError];
        if (!recorder || recorderError) {
            reply(nil, [NSString stringWithFormat:@"could not create recorder: %@", recorderError.localizedDescription]);
            return;
        }
        recorder.delegate = self;
        self.voiceRecorder = recorder;
        self.voiceRecordingURL = url;
        self.voiceRecordingInFlight = YES;
        if (![recorder record]) {
            self.voiceRecorder = nil;
            self.voiceRecordingURL = nil;
            self.voiceRecordingInFlight = NO;
            reply(nil, @"could not start recording");
            return;
        }
        // The mic is live: a tap the user feels (navigator.vibrate is a no-op
        // in WKWebView). This runs on the main thread -- both the granted
        // path and the permission callback above hop to it.
        [[[UINotificationFeedbackGenerator alloc] init] notificationOccurred:UINotificationFeedbackTypeSuccess];
        reply(@{}, nil);
    };

    if (session.recordPermission == AVAudioSessionRecordPermissionGranted) {
        begin();
        return;
    }
    // notDetermined -- ask, same as AutoJournalViewController's
    // beginRecordingFlow, but voiceStart's caller (session.html) is already
    // waiting on this one promise rather than a separate auto-start flag,
    // so the permission callback just proceeds or replies the denial
    // directly instead of setting a resume-later flag.
    [session requestRecordPermission:^(BOOL granted) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (!granted) {
                reply(nil, @"mic_denied");
                return;
            }
            begin();
        });
    }];
}

// `voiceStop {}` -> `{text: string}` on a real transcript, `{code:
// "empty_transcript"}` for genuinely-silent audio (server 422), or a
// bridge-level error string for anything else (network/upload/ASR-backend
// failure) -- see session.html's voiceStop .then/.catch split, which relies
// on exactly this three-way split to tell "try again, nothing was heard"
// apart from "something actually broke".
- (void)voiceStopWithParams:(NSDictionary *)params reply:(GLWebBridgeReplyBlock)reply {
    AVAudioRecorder *recorder = self.voiceRecorder;
    NSURL *url = self.voiceRecordingURL;
    if (!recorder || !url) {
        reply(nil, @"no recording in progress");
        return;
    }
    // -stop (not -pause) finalizes the m4a container immediately -- see the
    // -stop comment on AutoJournalViewController's pauseRecording for why
    // this is the only call that guarantees a playable file. Safe to call
    // even if an interruption already stopped the recorder (AVAudioRecorder
    // tolerates a redundant -stop).
    [recorder stop];
    self.voiceRecorder = nil;
    self.voiceRecordingInFlight = NO;

    NSError *deactivateError = nil;
    [[AVAudioSession sharedInstance] setActive:NO
                                    withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation
                                          error:&deactivateError];
    // A failed deactivate is logged, never surfaced to the page -- the
    // recording itself is fine either way, and session.html has no use for
    // "the audio session didn't tear down cleanly" as an error state.
    if (deactivateError) {
        NSLog(@"GLWebBridge: voiceStop audio session deactivate failed: %@", deactivateError.localizedDescription);
    }

    NSData *audio = [NSData dataWithContentsOfURL:url];
    if (audio.length == 0) {
        [[NSFileManager defaultManager] removeItemAtURL:url error:NULL];
        reply(@{@"code": @"empty_transcript"}, nil);
        return;
    }

    // The recording goes into the durable outbox BEFORE the temp file is
    // deleted, and stays there until the page removes it (voiceAck) once the
    // session it became is confirmed started, or the user discards it. A
    // transport failure or a transient server answer (5xx/429/408) leaves it
    // queued and retried automatically; the page picks the transcript up later
    // via voicePending. 422 (server: no speech detected) is an answer, not a
    // rejection. launchId is the page's id for the Recent row this send owns,
    // kept in meta so the page can match the item after a reload.
    NSError *enqueueError = nil;
    GLDurableOutbox *outbox = [GLDurableOutbox shared];
    NSString *itemID = [outbox enqueueKind:@"session-voice"
                                       // Baked into the queued item's path so audio recorded offline
                                       // still gets the code-switching transcriber on replay.
                                       path:([params[@"lang"] isEqual:@"multi"] ? @"/sessions/transcribe?lang=multi" : @"/sessions/transcribe")
                                    headers:@{@"Content-Type": @"audio/m4a"}
                                       body:audio
                                       meta:@{@"launchId": [params[@"launchId"] isKindOfClass:[NSString class]] ? params[@"launchId"] : @""}
                                 keepResult:YES
                           acceptedStatuses:@[@422]
                             retryTransient:YES
                                      error:&enqueueError];
    if (!itemID) {
        reply(nil, [NSString stringWithFormat:@"couldn't save the recording: %@", enqueueError.localizedDescription]);
        return;
    }
    [[NSFileManager defaultManager] removeItemAtURL:url error:NULL];

    [outbox flushWithCompletion:^{
        NSDictionary *item = [outbox itemWithID:itemID];
        NSString *state = item[@"state"];
        if ([state isEqualToString:GLDurableOutboxStatePending]) {
            reply(@{@"code": @"queued", @"id": itemID}, nil);
            return;
        }
        if ([state isEqualToString:GLDurableOutboxStateRejected]) {
            // The box answered and refused. The recording stays queued (the page
            // shows it as Failed with Retry/Discard); only the page's discard
            // or a confirmed start deletes it.
            reply(@{@"code": @"failed", @"id": itemID, @"error": [NSString stringWithFormat:@"transcription failed (HTTP %@)", item[@"rejectedStatus"]]}, nil);
            return;
        }
        NSDictionary *result = [self voiceResultForCompletedItem:item outbox:outbox];
        reply(result, nil);
    }];
}

// `voiceCancel {}` -> `{}`: stops the recording and deletes it, uploading nothing.
- (void)voiceCancelWithReply:(GLWebBridgeReplyBlock)reply {
    if (!self.voiceRecorder || !self.voiceRecordingURL) {
        reply(nil, @"no recording in progress");
        return;
    }
    [self.voiceRecorder stop];
    [[NSFileManager defaultManager] removeItemAtURL:self.voiceRecordingURL error:NULL];
    self.voiceRecorder = nil;
    self.voiceRecordingURL = nil;
    self.voiceRecordingInFlight = NO;
    NSError *deactivateError = nil;
    [[AVAudioSession sharedInstance] setActive:NO
                                    withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation
                                          error:&deactivateError];
    if (deactivateError) {
        NSLog(@"GLWebBridge: voiceCancel audio session deactivate failed: %@", deactivateError.localizedDescription);
    }
    reply(@{}, nil);
}

/// {id, text} for a transcript, {code: "empty_transcript", id} for no speech.
/// Either way the item (and its recording) stays until voiceAck.
- (NSDictionary *)voiceResultForCompletedItem:(NSDictionary *)item outbox:(GLDurableOutbox *)outbox {
    NSString *itemID = item[@"id"];
    if ([item[@"resultStatus"] integerValue] == 422) return @{@"code": @"empty_transcript", @"id": itemID};
    NSData *body = [outbox resultDataForItemID:itemID];
    NSDictionary *parsed = body.length > 0 ? [NSJSONSerialization JSONObjectWithData:body options:0 error:NULL] : nil;
    NSString *text = [parsed isKindOfClass:[NSDictionary class]] && [parsed[@"text"] isKindOfClass:[NSString class]] ? parsed[@"text"] : nil;
    if (text.length == 0) return @{@"code": @"empty_transcript", @"id": itemID};
    return @{@"text": text, @"id": itemID};
}

// `voicePending {}` -> `{ready: [{id, text, launchId}], failed: [{id, error, launchId}],
// pending: [{id, launchId}], waiting: n}`: transcripts that finished after
// voiceStop already replied "queued", voice notes the box refused or found
// empty, and those still waiting for the box. Nothing is deleted by reading:
// the page calls `voiceAck {id}` once the session it became is confirmed started
// (or the user discards it), `voiceAudio {id}` to play the clip, `voiceRetry {id}`
// to resend a failed one.
- (void)voicePendingWithReply:(GLWebBridgeReplyBlock)reply {
    GLDurableOutbox *outbox = [GLDurableOutbox shared];
    NSMutableArray *ready = [NSMutableArray array];
    NSMutableArray *failed = [NSMutableArray array];
    NSMutableArray *pending = [NSMutableArray array];
    NSInteger waiting = 0;
    for (NSDictionary *item in outbox.items) {
        if (![item[@"kind"] isEqualToString:@"session-voice"]) continue;
        NSString *launchId = item[@"meta"][@"launchId"] ?: @"";
        NSString *state = item[@"state"];
        if ([state isEqualToString:GLDurableOutboxStatePending]) {
            waiting++;
            [pending addObject:@{@"id": item[@"id"], @"launchId": launchId}];
        } else if ([state isEqualToString:GLDurableOutboxStateRejected]) {
            [failed addObject:@{@"id": item[@"id"], @"launchId": launchId, @"error": item[@"lastError"] ?: @"rejected"}];
        } else {
            NSMutableDictionary *result = [[self voiceResultForCompletedItem:item outbox:outbox] mutableCopy];
            result[@"launchId"] = launchId;
            if (result[@"text"]) [ready addObject:result];
            else [failed addObject:@{@"id": item[@"id"], @"launchId": launchId, @"error": @"No speech detected"}];
        }
    }
    reply(@{@"ready": ready, @"failed": failed, @"pending": pending, @"waiting": @(waiting)}, nil);
}

// `voiceAudio {id}` -> `{base64, mime}`: the queued recording, for the page's play button.
- (void)voiceAudioWithParams:(NSDictionary *)params reply:(GLWebBridgeReplyBlock)reply {
    NSString *itemID = params[@"id"];
    NSData *audio = [itemID isKindOfClass:[NSString class]] ? [[GLDurableOutbox shared] bodyDataForItemID:itemID] : nil;
    if (audio.length == 0) {
        reply(nil, @"voiceAudio: no recording for that id");
        return;
    }
    reply(@{@"base64": [audio base64EncodedStringWithOptions:0], @"mime": @"audio/mp4"}, nil);
}

// `voiceRetry {id}` -> `{}`: puts a failed recording back in the queue and flushes it.
- (void)voiceRetryWithParams:(NSDictionary *)params reply:(GLWebBridgeReplyBlock)reply {
    if (![params[@"id"] isKindOfClass:[NSString class]]) {
        reply(nil, @"voiceRetry needs a string id");
        return;
    }
    GLDurableOutbox *outbox = [GLDurableOutbox shared];
    [outbox retryRejectedItemID:params[@"id"]];
    [outbox flushWithCompletion:nil];
    reply(@{}, nil);
}

- (void)audioSessionInterrupted:(NSNotification *)notification {
    if (!self.voiceRecordingInFlight) return;
    NSNumber *typeValue = notification.userInfo[AVAudioSessionInterruptionTypeKey];
    if (typeValue.unsignedIntegerValue != AVAudioSessionInterruptionTypeBegan) return;
    // Stop (finalize the file) and leave it in place -- a subsequent
    // voiceStop call still finds a valid recording at self.voiceRecordingURL
    // and transcribes whatever was captured before the interruption, rather
    // than a corrupt/truncated file. We do NOT clear voiceRecorder/
    // voiceRecordingURL here: voiceStop's own -stop call on an
    // already-stopped AVAudioRecorder is a safe no-op, and clearing state
    // from two different call sites invites a race between this
    // notification handler and a voiceStop that's already in flight.
    [self.voiceRecorder stop];
    self.voiceRecordingInFlight = NO;
}

#pragma mark - AVAudioRecorderDelegate

- (void)audioRecorderDidFinishRecording:(AVAudioRecorder *)recorder successfully:(BOOL)flag {
    // No action needed on the happy path -- voiceStop drives -stop itself
    // and reads the file synchronously afterwards. This delegate method
    // exists only so a recorder-internal failure (disk full, etc, flag=NO)
    // is logged instead of silently leaving a truncated file for voiceStop
    // to try to upload.
    if (!flag) {
        NSLog(@"GLWebBridge: voice recording finished unsuccessfully at %@", recorder.url);
    }
}

#pragma mark - API token

// The actual allow/deny decision -- scheme + host + PORT, not host alone --
// lives in Shared/GLApiTokenPolicy.h's GLApiTokenAllowedForFrameURL(), a
// header-only pure predicate so SharedTests can exercise every branch (incl.
// the funnelled :443 denial) with no WebKit and no host app. This method is
// just that predicate plus the reply plumbing.
- (void)replyWithApiTokenForFrameURL:(nullable NSURL *)frameURL reply:(GLWebBridgeReplyBlock)reply {
    if (GLApiTokenAllowedForFrameURL(frameURL, GL_BAKED_HOST)) {
        reply(@{@"token": GL_BAKED_TOKEN}, nil);
    } else {
        reply(nil, @"getApiToken denied: requesting page is not file:// and is not http(s) on GL_BAKED_HOST at an app-served port");
    }
}

#pragma mark - Prefs

- (nullable NSString *)defaultsKeyForPrefKey:(NSString *)key {
    if ([key isEqualToString:@"moreOrder"]) return GLMoreGridOrderDefaultsName;
    if ([key isEqualToString:@"moreHeroes"]) return GLMoreGridHeroesDefaultsName;
    if ([key isEqualToString:@"cleanTranscripts"]) return GLJournalCleanedTranscriptsDefaultsName;
    return nil;
}

- (void)getPrefWithParams:(NSDictionary *)params reply:(GLWebBridgeReplyBlock)reply {
    NSString *key = [params[@"key"] isKindOfClass:[NSString class]] ? params[@"key"] : nil;
    NSString *defaultsKey = key ? [self defaultsKeyForPrefKey:key] : nil;
    if (!defaultsKey) {
        reply(nil, [NSString stringWithFormat:@"unknown pref key %@", key ?: @"(missing)"]);
        return;
    }
    id value = [[NSUserDefaults standardUserDefaults] objectForKey:defaultsKey];
    reply(@{@"value": value ?: [NSNull null]}, nil);
}

- (void)setPrefWithParams:(NSDictionary *)params reply:(GLWebBridgeReplyBlock)reply {
    NSString *key = [params[@"key"] isKindOfClass:[NSString class]] ? params[@"key"] : nil;
    NSString *defaultsKey = key ? [self defaultsKeyForPrefKey:key] : nil;
    if (!defaultsKey) {
        reply(nil, [NSString stringWithFormat:@"unknown pref key %@", key ?: @"(missing)"]);
        return;
    }
    id value = params[@"value"];
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    if (value == nil || [value isKindOfClass:[NSNull class]]) {
        [defaults removeObjectForKey:defaultsKey];
    } else {
        [defaults setObject:value forKey:defaultsKey];
    }
    reply(@{}, nil);
}

#pragma mark - Todo outbox

- (void)outboxHandoffWithParams:(NSDictionary *)params reply:(GLWebBridgeReplyBlock)reply {
    NSArray *rawOps = [params[@"ops"] isKindOfClass:[NSArray class]] ? params[@"ops"] : @[];
    NSMutableArray<GLTodoOutboxOp *> *ops = [NSMutableArray arrayWithCapacity:rawOps.count];
    for (id entry in rawOps) {
        GLTodoOutboxOp *op = [GLTodoOutboxOp opFromDictionary:entry];
        // A malformed op is dropped, not a bridge-level error -- see
        // GLWebBridge.h's outboxHandoff doc comment: `accepted` in the
        // result is what tells the page how many actually got queued.
        if (op != nil) [ops addObject:op];
    }
    NSInteger accepted = [[GLTodoOutbox sharedOutbox] handoffWithOps:ops];
    reply(@{@"accepted": @(accepted)}, nil);
}

@end
