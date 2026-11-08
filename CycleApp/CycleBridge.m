#import "CycleBridge.h"

#import <Security/Security.h>
#import <UIKit/UIKit.h>

#import "CycleNotifier.h"
#import "CycleStore.h"

typedef void (^CycleResult)(id result, NSString *error);

@interface CycleBridge ()
@property (nonatomic, strong) CycleStore *store;
@property (nonatomic, strong) CycleNotifier *notifier;
@property (nonatomic, assign) BOOL ready;
@property (nonatomic, strong) NSMutableArray<NSString *> *queuedRoutes;
@property (nonatomic, copy) NSString *pushToken;
// The last route handed to a ready page, kept so a reload right after a notification tap (a fresh web copy activating
// on open, a long-absence reload, a killed web process) re-delivers it to the new page instead of booting on Home.
@property (nonatomic, copy) NSString *lastRoute;
@property (nonatomic, strong) NSDate *lastRouteAt;
@property (nonatomic, copy) NSString *replayRoute; // lastRoute, carried across a reload; a newer queued tap wins
@end

static const NSTimeInterval CycleRouteRedeliverWindow = 60;

static NSString *const CycleLockDefaultsKey = @"cycle.lockEnabled";
static NSString *const CycleLockPassedDefaultsKey = @"cycle.lockPassed";
static NSString *const CycleCredsService = @"com.oliverullman.cycle.auth";

@implementation CycleBridge

+ (BOOL)lockEnabled {
    id v = [NSUserDefaults.standardUserDefaults objectForKey:CycleLockDefaultsKey];
    return v ? [v boolValue] : YES;
}

+ (BOOL)lockNeedsAuth {
    return [self lockEnabled] && ![NSUserDefaults.standardUserDefaults boolForKey:CycleLockPassedDefaultsKey];
}

+ (void)markLockPassed {
    [NSUserDefaults.standardUserDefaults setBool:YES forKey:CycleLockPassedDefaultsKey];
}

static NSMutableDictionary *CycleCredsQuery(void) {
    return [@{ (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
               (__bridge id)kSecAttrService: CycleCredsService } mutableCopy];
}

static NSString *CycleKeychainError(NSString *op, OSStatus st) {
    return [NSString stringWithFormat:@"%@: keychain OSStatus %d", op, (int)st];
}

- (instancetype)initWithStore:(CycleStore *)store notifier:(CycleNotifier *)notifier {
    if ((self = [super init])) {
        _store = store;
        _notifier = notifier;
        _queuedRoutes = [NSMutableArray array];
    }
    return self;
}

- (void)callNative:(NSString *)method arguments:(NSArray *)arguments {
    NSData *json = [NSJSONSerialization dataWithJSONObject:arguments options:0 error:NULL];
    NSString *args = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
    self.evaluateJS([NSString stringWithFormat:@"window.cycleNative.%@.apply(window.cycleNative, %@)", method, args]);
}

- (void)reply:(id)ident result:(id)result error:(NSString *)error {
    NSData *json = [NSJSONSerialization dataWithJSONObject:@[ident ?: NSNull.null, result ?: NSNull.null, error ?: NSNull.null] options:0 error:NULL];
    NSString *args = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
    self.evaluateJS([NSString stringWithFormat:@"window.__cycleReply.apply(null, %@)", args]);
}

- (void)handleMessage:(id)body {
    NSAssert([body isKindOfClass:NSDictionary.class], @"bridge message is not a dictionary: %@", body);
    NSDictionary *msg = body;
    id ident = msg[@"id"];
    NSString *cmd = msg[@"cmd"];
    NSDictionary *args = [msg[@"args"] isKindOfClass:NSDictionary.class] ? msg[@"args"] : @{};
    __weak typeof(self) weakSelf = self;
    [self dispatchCommand:cmd args:args completion:^(id result, NSString *error) {
        if (error) NSLog(@"[Cycle] %@ failed: %@", cmd, error);
        dispatch_async(dispatch_get_main_queue(), ^{ [weakSelf reply:ident result:result error:error]; });
    }];
}

- (void)dispatchCommand:(NSString *)cmd args:(NSDictionary *)args completion:(CycleResult)done {
    NSError *nsError = nil;
    // The app delegate's NSAssert on store creation is compiled out in Release, which leaves a nil store; messaging nil
    // would report success for a write that went nowhere. Say so instead so the page shows "not saved".
    if (!self.store && [cmd hasPrefix:@"store."]) { done(nil, @"Storage unavailable: nothing was saved"); return; }
    if ([cmd isEqualToString:@"store.get"]) {
        NSString *key = args[@"key"];
        if (![key isKindOfClass:NSString.class]) { done(nil, @"store.get: 'key' must be a string"); return; }
        done([self.store valueForKey:key], nil);
    } else if ([cmd isEqualToString:@"store.set"]) {
        NSString *key = args[@"key"];
        id value = args[@"value"];
        if (![key isKindOfClass:NSString.class]) { done(nil, @"store.set: 'key' must be a string"); return; }
        if (value == NSNull.null || value == nil) value = nil;
        else if (![value isKindOfClass:NSString.class]) { done(nil, @"store.set: 'value' must be a string or null"); return; }
        if ([self.store setValue:value forKey:key error:&nsError]) done(NSNull.null, nil);
        else done(nil, nsError.localizedDescription);
    } else if ([cmd isEqualToString:@"store.keys"]) {
        NSString *prefix = args[@"prefix"];
        if (![prefix isKindOfClass:NSString.class]) { done(nil, @"store.keys: 'prefix' must be a string"); return; }
        done([self.store keysWithPrefix:prefix], nil);
    } else if ([cmd isEqualToString:@"notify.permission"]) {
        [self.notifier permissionWithCompletion:^(BOOL granted) { done(@(granted), nil); }];
    } else if ([cmd isEqualToString:@"notify.status"]) {
        [self.notifier statusWithCompletion:^(NSString *status) { done(status, nil); }];
    } else if ([cmd isEqualToString:@"app.openSettings"]) {
        self.openSettings();
        done(NSNull.null, nil);
    } else if ([cmd isEqualToString:@"app.info"]) {
        // CycleNativeVersion is stamped into Info.plist by the ota/testflight workflows; a local dev build has none, reported as 0
        // so the page never shows an update bar for it.
        NSDictionary *info = self.bundleInfo ?: NSBundle.mainBundle.infoDictionary;
        done(@{ @"shell": info[@"CycleShellVersion"] ?: @0, @"native": info[@"CycleNativeVersion"] ?: @0 }, nil);
    } else if ([cmd isEqualToString:@"app.openURL"]) {
        // https only: the page hands us the install page url, and nothing else may be opened from here.
        NSString *raw = args[@"url"];
        NSURL *url = [raw isKindOfClass:NSString.class] ? [NSURL URLWithString:raw] : nil;
        if (![url.scheme isEqualToString:@"https"] || !url.host.length) { done(nil, @"app.openURL: 'url' must be an https url"); return; }
        if (!self.openURL) { done(nil, @"app.openURL: no opener wired"); return; }
        self.openURL(url);
        done(NSNull.null, nil);
    } else if ([cmd isEqualToString:@"speech.start"]) {
        if (!self.speechStart) { done(nil, @"speech.start: no speech handler wired"); return; }
        self.speechStart(^(NSString *error) { if (error) done(nil, error); else done(NSNull.null, nil); });
    } else if ([cmd isEqualToString:@"speech.stop"]) {
        if (!self.speechStop) { done(nil, @"speech.stop: no speech handler wired"); return; }
        NSData *audio = self.speechStop();
        done(audio ? @{ @"audio": [audio base64EncodedStringWithOptions:0], @"mime": @"audio/mp4" } : NSNull.null, nil);
    } else if ([cmd isEqualToString:@"speech.cancel"]) {
        if (!self.speechCancel) { done(nil, @"speech.cancel: no speech handler wired"); return; }
        self.speechCancel();
        done(NSNull.null, nil);
    } else if ([cmd isEqualToString:@"notify.schedule"]) {
        [self.notifier scheduleArgs:args now:[NSDate date] completion:^(NSError *error) {
            if (error) done(nil, error.localizedDescription); else done(NSNull.null, nil);
        }];
    } else if ([cmd isEqualToString:@"notify.cancel"]) {
        NSString *ident = args[@"id"];
        if (![ident isKindOfClass:NSString.class]) { done(nil, @"notify.cancel: 'id' must be a string"); return; }
        [self.notifier cancelID:ident];
        done(NSNull.null, nil);
    } else if ([cmd isEqualToString:@"haptic"]) {
        NSString *kind = args[@"kind"];
        if ([kind isEqualToString:@"light"]) {
            [[[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleLight] impactOccurred];
        } else if ([kind isEqualToString:@"success"]) {
            [[[UINotificationFeedbackGenerator alloc] init] notificationOccurred:UINotificationFeedbackTypeSuccess];
        } else if ([kind isEqualToString:@"warning"]) {
            [[[UINotificationFeedbackGenerator alloc] init] notificationOccurred:UINotificationFeedbackTypeWarning];
        } else {
            done(nil, [NSString stringWithFormat:@"haptic: unknown kind %@", kind]);
            return;
        }
        done(NSNull.null, nil);
    } else if ([cmd isEqualToString:@"share"]) {
        NSString *filename = args[@"filename"];
        NSString *text = args[@"text"];
        if (![filename isKindOfClass:NSString.class] || filename.length == 0) { done(nil, @"share: 'filename' must be a non-empty string"); return; }
        if (![text isKindOfClass:NSString.class]) { done(nil, @"share: 'text' must be a string"); return; }
        if ([filename containsString:@"/"] || [filename isEqualToString:@"."] || [filename isEqualToString:@".."]) {
            done(nil, [NSString stringWithFormat:@"share: 'filename' %@ must not contain a path", filename]);
            return;
        }
        NSURL *url = [NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:filename]];
        if (![text writeToURL:url atomically:YES encoding:NSUTF8StringEncoding error:&nsError]) {
            done(nil, [NSString stringWithFormat:@"share: could not write %@: %@", filename, nsError.localizedDescription]);
            return;
        }
        self.presentItems(@[url]);
        done(@YES, nil);
    } else if ([cmd isEqualToString:@"share.text"]) {
        NSString *text = args[@"text"];
        if (![text isKindOfClass:NSString.class] || text.length == 0) { done(nil, @"share.text: 'text' must be a non-empty string"); return; }
        self.presentItems(@[text]);
        done(@YES, nil);
    } else if ([cmd isEqualToString:@"clipboard.set"]) {
        NSString *text = args[@"text"];
        if (![text isKindOfClass:NSString.class] || text.length == 0) { done(nil, @"clipboard.set: 'text' must be a non-empty string"); return; }
        self.setClipboard(text);
        done(@YES, nil);
    } else if ([cmd isEqualToString:@"lock.get"]) {
        done(@([CycleBridge lockEnabled]), nil);
    } else if ([cmd isEqualToString:@"lock.set"]) {
        id on = args[@"on"];
        if (![on isKindOfClass:NSNumber.class]) { done(nil, @"lock.set: 'on' must be a boolean"); return; }
        [NSUserDefaults.standardUserDefaults setBool:[on boolValue] forKey:CycleLockDefaultsKey];
        [NSUserDefaults.standardUserDefaults removeObjectForKey:CycleLockPassedDefaultsKey];
        if (self.lockChanged) self.lockChanged();
        done(NSNull.null, nil);
    } else if ([cmd isEqualToString:@"creds.set"]) {
        NSString *email = args[@"email"], *password = args[@"password"];
        if (![email isKindOfClass:NSString.class] || ![password isKindOfClass:NSString.class]) { done(nil, @"creds.set: 'email' and 'password' must be strings"); return; }
        NSData *blob = [NSJSONSerialization dataWithJSONObject:@{ @"email": email, @"password": password } options:0 error:NULL];
        NSMutableDictionary *add = CycleCredsQuery();
        add[(__bridge id)kSecValueData] = blob;
        add[(__bridge id)kSecAttrAccessible] = (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;
        OSStatus st = SecItemAdd((__bridge CFDictionaryRef)add, NULL);
        if (st == errSecDuplicateItem) {
            st = SecItemUpdate((__bridge CFDictionaryRef)CycleCredsQuery(),
                               (__bridge CFDictionaryRef)@{ (__bridge id)kSecValueData: blob,
                                                            (__bridge id)kSecAttrAccessible: (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly });
        }
        if (st == errSecSuccess) done(NSNull.null, nil); else done(nil, CycleKeychainError(@"creds.set", st));
    } else if ([cmd isEqualToString:@"creds.get"]) {
        NSMutableDictionary *q = CycleCredsQuery();
        q[(__bridge id)kSecReturnData] = @YES;
        q[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
        CFTypeRef out = NULL;
        OSStatus st = SecItemCopyMatching((__bridge CFDictionaryRef)q, &out);
        if (st == errSecItemNotFound) { done(NSNull.null, nil); return; }
        if (st != errSecSuccess) { done(nil, CycleKeychainError(@"creds.get", st)); return; }
        id parsed = [NSJSONSerialization JSONObjectWithData:CFBridgingRelease(out) options:0 error:&nsError];
        if (![parsed isKindOfClass:NSDictionary.class]) { done(nil, [NSString stringWithFormat:@"creds.get: stored item is not JSON: %@", nsError]); return; }
        done(parsed, nil);
    } else if ([cmd isEqualToString:@"creds.clear"]) {
        OSStatus st = SecItemDelete((__bridge CFDictionaryRef)CycleCredsQuery());
        if (st == errSecSuccess || st == errSecItemNotFound) done(NSNull.null, nil); else done(nil, CycleKeychainError(@"creds.clear", st));
    } else if ([cmd isEqualToString:@"ready"]) {
        done(NSNull.null, nil);
        self.ready = YES;
        NSArray *queued = self.queuedRoutes.count ? [self.queuedRoutes copy] : (self.replayRoute ? @[self.replayRoute] : @[]);
        [self.queuedRoutes removeAllObjects];
        self.replayRoute = nil;
        for (NSString *route in queued) [self deliverRoute:route];
        if (self.pushToken) [self callNative:@"pushToken" arguments:@[self.pushToken]];
    } else {
        done(nil, [NSString stringWithFormat:@"unsupported bridge command %@", cmd]);
    }
}

- (void)deliverRoute:(NSString *)route {
    if (!self.ready) { [self.queuedRoutes addObject:route]; return; }
    [self callNative:@"route" arguments:@[route]];
    self.lastRoute = route;
    self.lastRouteAt = [NSDate date];
}

- (void)deliverPushToken:(NSString *)hex {
    self.pushToken = hex;
    if (self.ready) [self callNative:@"pushToken" arguments:@[hex]];
}

- (void)deliverSpeechSilence {
    if (self.ready) [self callNative:@"speechSilence" arguments:@[]];
}

- (void)deliverShake:(NSString *)png {
    // Dropped (not queued) while the page is not ready: a shake during launch is not a complaint about a screen.
    if (self.ready) [self callNative:@"shake" arguments:@[png ?: NSNull.null]];
}

- (void)deliverSpeechError:(NSString *)message {
    if (self.ready) [self callNative:@"speechError" arguments:@[message ?: @""]];
}

- (void)speechInterrupted {
    if (self.speechInterrupt) self.speechInterrupt(); // the recorder reports speechSilence itself when it had a recording
}

- (void)foreground {
    if (self.ready) [self callNative:@"foreground" arguments:@[]];
}

- (void)pageWillReload {
    if (self.ready) self.replayRoute = self.lastRoute && -[self.lastRouteAt timeIntervalSinceNow] < CycleRouteRedeliverWindow ? self.lastRoute : nil;
    self.lastRoute = nil;
    self.ready = NO;
}

@end
