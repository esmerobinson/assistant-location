// Bridge command dispatch, route queueing and notification-id replacement. The notification centre
// is a fake (UNUserNotificationCenter needs a signed host app); requests are built by the real
// UserNotifications classes, which is what the id/route/trigger assertions run against.
#import <XCTest/XCTest.h>
#import "CycleBridge.h"
#import "CycleNotifier.h"
#import "CycleStore.h"

@interface FakeCenter : NSObject <CycleNotificationCenter>
@property (nonatomic, strong) NSMutableDictionary<NSString *, UNNotificationRequest *> *pending;
@property (nonatomic, strong) NSMutableArray<NSString *> *removedPending;
@property (nonatomic, strong) NSMutableArray<NSString *> *removedDelivered;
@property (nonatomic, assign) UNAuthorizationStatus status;
@end

@implementation FakeCenter
- (instancetype)init {
    if ((self = [super init])) {
        _pending = [NSMutableDictionary dictionary];
        _removedPending = [NSMutableArray array];
        _removedDelivered = [NSMutableArray array];
    }
    return self;
}
// Mirrors UNUserNotificationCenter: a request with an already-pending identifier replaces it.
- (void)addNotificationRequest:(UNNotificationRequest *)request withCompletionHandler:(void (^)(NSError *))completionHandler {
    self.pending[request.identifier] = request;
    if (completionHandler) completionHandler(nil);
}
- (void)removePendingNotificationRequestsWithIdentifiers:(NSArray<NSString *> *)identifiers {
    [self.removedPending addObjectsFromArray:identifiers];
    [self.pending removeObjectsForKeys:identifiers];
}
- (void)removeDeliveredNotificationsWithIdentifiers:(NSArray<NSString *> *)identifiers {
    [self.removedDelivered addObjectsFromArray:identifiers];
}
- (void)getNotificationSettingsWithCompletionHandler:(void (^)(UNNotificationSettings *))completionHandler {
    XCTFail(@"settings are not constructible in a test; permission is not exercised here");
}
- (void)getAuthorizationStatusWithCompletionHandler:(void (^)(UNAuthorizationStatus))completionHandler {
    completionHandler(self.status);
}
- (void)requestAuthorizationWithOptions:(UNAuthorizationOptions)options completionHandler:(void (^)(BOOL, NSError *))completionHandler {
    XCTFail(@"authorization is not exercised here");
}
@end

@interface CycleBridgeTests : XCTestCase
@property (nonatomic, strong) NSURL *dir;
@property (nonatomic, strong) FakeCenter *center;
@property (nonatomic, strong) CycleBridge *bridge;
@property (nonatomic, strong) NSMutableArray<NSString *> *js;
@property (nonatomic, strong) NSMutableArray<NSArray *> *shared;
@property (nonatomic, strong) NSMutableArray<NSString *> *copied;
@end

@implementation CycleBridgeTests

- (void)setUp {
    self.dir = [NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:[NSUUID UUID].UUIDString] isDirectory:YES];
    [NSFileManager.defaultManager createDirectoryAtURL:self.dir withIntermediateDirectories:YES attributes:nil error:NULL];
    NSError *error = nil;
    CycleStore *store = [[CycleStore alloc] initWithDirectory:self.dir error:&error];
    XCTAssertNotNil(store, @"%@", error);
    self.center = [[FakeCenter alloc] init];
    self.bridge = [[CycleBridge alloc] initWithStore:store notifier:[[CycleNotifier alloc] initWithCenter:self.center]];
    self.js = [NSMutableArray array];
    self.bridge.evaluateJS = ^(NSString *js) { [self.js addObject:js]; };
    self.shared = [NSMutableArray array];
    self.bridge.presentItems = ^(NSArray *items) { [self.shared addObject:items]; };
    self.copied = [NSMutableArray array];
    self.bridge.setClipboard = ^(NSString *text) { [self.copied addObject:text]; };
}

- (void)tearDown {
    [NSFileManager.defaultManager removeItemAtURL:self.dir error:NULL];
}

// Runs one command and returns {result, error}; every command here completes synchronously.
- (NSDictionary *)run:(NSString *)cmd args:(NSDictionary *)args {
    __block NSDictionary *out = nil;
    [self.bridge dispatchCommand:cmd args:args completion:^(id result, NSString *error) {
        XCTAssertNil(out, @"completion fired twice for %@", cmd);
        out = @{@"result": result ?: NSNull.null, @"error": error ?: NSNull.null};
    }];
    XCTAssertNotNil(out, @"%@ did not complete synchronously", cmd);
    return out;
}

- (NSArray *)argsOfJS:(NSString *)js prefix:(NSString *)prefix {
    XCTAssertTrue([js hasPrefix:prefix], @"unexpected script %@", js);
    NSString *json = [js substringFromIndex:prefix.length];
    json = [json substringToIndex:json.length - 1]; // trailing ")"
    id parsed = [NSJSONSerialization JSONObjectWithData:[json dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL];
    XCTAssertTrue([parsed isKindOfClass:NSArray.class], @"args not a JSON array in %@", js);
    return parsed;
}

- (NSDictionary *)scheduleArgsWithID:(NSString *)ident title:(NSString *)title inSeconds:(double)seconds {
    return @{@"id": ident, @"at": @(([NSDate date].timeIntervalSince1970 + seconds) * 1000), @"title": title, @"body": @"b", @"route": @"checkin"};
}

// ---- store.* ----

- (void)testStoreCommandsRoundTrip {
    XCTAssertEqualObjects([self run:@"store.get" args:(@{@"key": @"k"})][@"result"], NSNull.null);
    XCTAssertEqualObjects([self run:@"store.set" args:(@{@"key": @"log:1", @"value": @"v1"})][@"error"], NSNull.null);
    [self run:@"store.set" args:@{@"key": @"log:2", @"value": @"v2"}];
    [self run:@"store.set" args:@{@"key": @"other", @"value": @"x"}];
    XCTAssertEqualObjects([self run:@"store.get" args:(@{@"key": @"log:1"})][@"result"], @"v1");
    XCTAssertEqualObjects([self run:@"store.keys" args:(@{@"prefix": @"log:"})][@"result"], (@[@"log:1", @"log:2"]));
    [self run:@"store.set" args:@{@"key": @"log:1", @"value": NSNull.null}];
    XCTAssertEqualObjects([self run:@"store.get" args:(@{@"key": @"log:1"})][@"result"], NSNull.null, @"null value deletes");
    XCTAssertEqualObjects([self run:@"store.keys" args:(@{@"prefix": @"log:"})][@"result"], (@[@"log:2"]));
}

// A nil store (the app delegate's NSAssert is compiled out in Release) must report an error, not silent success.
- (void)testNilStoreReportsErrorInsteadOfSuccess {
    CycleBridge *bare = [[CycleBridge alloc] initWithStore:nil notifier:[[CycleNotifier alloc] initWithCenter:self.center]];
    __block NSString *err = nil;
    [bare dispatchCommand:@"store.set" args:@{@"key": @"k", @"value": @"v"} completion:^(id result, NSString *error) { err = error; }];
    XCTAssertNotNil(err, @"store.set with no store must fail loudly");
    err = nil;
    [bare dispatchCommand:@"store.get" args:@{@"key": @"k"} completion:^(id result, NSString *error) { err = error; }];
    XCTAssertNotNil(err);
}

- (void)testStoreRejectsNonStringValueAndKey {
    XCTAssertNotEqualObjects([self run:@"store.set" args:(@{@"key": @"k", @"value": @5})][@"error"], NSNull.null);
    XCTAssertNotEqualObjects([self run:@"store.set" args:(@{@"value": @"v"})][@"error"], NSNull.null);
    XCTAssertEqualObjects([self run:@"store.get" args:(@{@"key": @"k"})][@"result"], NSNull.null, @"a rejected set must not write");
}

- (void)testUnknownCommandAndHapticKindAreErrors {
    XCTAssertTrue([[self run:@"nope" args:(@{})][@"error"] containsString:@"unsupported bridge command nope"]);
    XCTAssertTrue([[self run:@"haptic" args:(@{@"kind": @"boom"})][@"error"] containsString:@"unknown kind"]);
}

// ---- notify.status / app.openSettings ----

- (void)testNotifyStatusMapsAuthorizationWithoutPrompting {
    NSDictionary<NSNumber *, NSString *> *want = @{
        @(UNAuthorizationStatusNotDetermined): @"notDetermined",
        @(UNAuthorizationStatusDenied): @"denied",
        @(UNAuthorizationStatusAuthorized): @"granted",
        @(UNAuthorizationStatusProvisional): @"granted",
    };
    for (NSNumber *raw in want) {
        self.center.status = (UNAuthorizationStatus)raw.integerValue;
        NSDictionary *out = [self run:@"notify.status" args:@{}];
        XCTAssertEqualObjects(out[@"result"], want[raw], @"status %@", raw);
        XCTAssertEqualObjects(out[@"error"], NSNull.null);
    }
}

- (void)testAppOpenSettingsCallsTheOpener {
    __block int opened = 0;
    self.bridge.openSettings = ^{ opened++; };
    NSDictionary *out = [self run:@"app.openSettings" args:@{}];
    XCTAssertEqualObjects(out[@"error"], NSNull.null);
    XCTAssertEqual(opened, 1);
}

// ---- app.info / app.openURL ----

- (void)testAppInfoReportsShellAndNativeVersions {
    self.bridge.bundleInfo = @{ @"CycleShellVersion": @3, @"CycleNativeVersion": @1793976768 };
    NSDictionary *out = [self run:@"app.info" args:@{}];
    XCTAssertEqualObjects(out[@"error"], NSNull.null);
    XCTAssertEqualObjects(out[@"result"], (@{ @"shell": @3, @"native": @1793976768 }));
}

- (void)testAppInfoNativeIsZeroForAnUnstampedBuild {
    self.bridge.bundleInfo = @{ @"CycleShellVersion": @3 };
    XCTAssertEqualObjects([self run:@"app.info" args:@{}][@"result"][@"native"], @0);
}

- (void)testAppOpenURLOpensHttpsOnly {
    __block NSURL *opened = nil;
    self.bridge.openURL = ^(NSURL *url) { opened = url; };
    NSDictionary *out = [self run:@"app.openURL" args:@{ @"url": @"https://box.example/cycle/get/tok/" }];
    XCTAssertEqualObjects(out[@"error"], NSNull.null);
    XCTAssertEqualObjects(opened.absoluteString, @"https://box.example/cycle/get/tok/");
    opened = nil;
    for (NSString *bad in @[@"http://box.example/", @"itms-services://?action=download-manifest", @"javascript:alert(1)"]) {
        XCTAssertTrue([[self run:@"app.openURL" args:@{ @"url": bad }][@"error"] containsString:@"https"], @"%@", bad);
    }
    XCTAssertNil(opened);
}

// ---- share ----

- (void)testShareWritesTextToTempFileAndRepliesTrue {
    NSString *name = [NSString stringWithFormat:@"cycle-share-%@.csv", [NSUUID UUID].UUIDString];
    NSString *text = @"a,b\n\"x, \u00e9\",2\n";
    NSDictionary *out = [self run:@"share" args:(@{@"filename": name, @"text": text})];
    XCTAssertEqualObjects(out[@"result"], @YES);
    XCTAssertEqualObjects(out[@"error"], NSNull.null);
    NSString *path = [NSTemporaryDirectory() stringByAppendingPathComponent:name];
    NSError *error = nil;
    NSString *written = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:&error];
    XCTAssertEqualObjects(written, text, @"file contents (read error: %@)", error);
    XCTAssertEqual(self.shared.count, 1u, @"presenter should get exactly one file");
    XCTAssertEqualObjects(self.shared.firstObject, (@[[NSURL fileURLWithPath:path]]));
    [NSFileManager.defaultManager removeItemAtPath:path error:NULL];
}

- (void)testShareRejectsInvalidArgsWithoutPresenting {
    NSArray *bad = @[
        @{@"text": @"t"},
        @{@"filename": @"", @"text": @"t"},
        @{@"filename": @5, @"text": @"t"},
        @{@"filename": @"f.csv"},
        @{@"filename": @"f.csv", @"text": @5},
        @{@"filename": @"../escape.csv", @"text": @"t"},
        @{@"filename": @"dir/f.csv", @"text": @"t"},
        @{@"filename": @"..", @"text": @"t"},
    ];
    for (NSDictionary *args in bad) {
        NSDictionary *out = [self run:@"share" args:args];
        XCTAssertTrue([out[@"error"] isKindOfClass:NSString.class] && [out[@"error"] hasPrefix:@"share: "], @"args %@ -> %@", args, out);
        XCTAssertEqualObjects(out[@"result"], NSNull.null);
    }
    XCTAssertEqual(self.shared.count, 0u);
}

// ---- share.text / clipboard.set ----

- (void)testShareTextPresentsTheStringItself {
    NSDictionary *out = [self run:@"share.text" args:(@{@"text": @"Cycle code: AB12CD"})];
    XCTAssertEqualObjects(out[@"result"], @YES);
    XCTAssertEqualObjects(self.shared, (@[@[@"Cycle code: AB12CD"]]));
}

- (void)testShareTextRejectsBadArgsWithoutPresenting {
    for (NSDictionary *args in @[@{}, @{@"text": @""}, @{@"text": @5}, @{@"text": NSNull.null}]) {
        NSDictionary *out = [self run:@"share.text" args:args];
        XCTAssertTrue([out[@"error"] isKindOfClass:NSString.class] && [out[@"error"] hasPrefix:@"share.text: "], @"args %@ -> %@", args, out);
    }
    XCTAssertEqual(self.shared.count, 0u);
}

- (void)testClipboardSetHandsTheStringToThePasteboardWriter {
    NSDictionary *out = [self run:@"clipboard.set" args:(@{@"text": @"AB12CD"})];
    XCTAssertEqualObjects(out[@"result"], @YES);
    XCTAssertEqualObjects(self.copied, (@[@"AB12CD"]));
}

- (void)testClipboardSetRejectsBadArgsWithoutWriting {
    for (NSDictionary *args in @[@{}, @{@"text": @""}, @{@"text": @5}, @{@"text": NSNull.null}]) {
        NSDictionary *out = [self run:@"clipboard.set" args:args];
        XCTAssertTrue([out[@"error"] isKindOfClass:NSString.class] && [out[@"error"] hasPrefix:@"clipboard.set: "], @"args %@ -> %@", args, out);
    }
    XCTAssertEqual(self.copied.count, 0u);
}

// ---- reply plumbing ----

- (void)testHandleMessageRepliesThroughCycleReply {
    XCTestExpectation *replied = [self expectationWithDescription:@"reply"];
    self.bridge.evaluateJS = ^(NSString *js) { [self.js addObject:js]; [replied fulfill]; };
    [self.bridge handleMessage:@{@"id": @7, @"cmd": @"store.set", @"args": @{@"key": @"k", @"value": @"v"}}];
    [self waitForExpectationsWithTimeout:2 handler:nil];
    XCTAssertEqualObjects([self argsOfJS:self.js.firstObject prefix:@"window.__cycleReply.apply(null, "], (@[@7, NSNull.null, NSNull.null]));
}

- (void)testHandleMessageReplyCarriesErrorString {
    XCTestExpectation *replied = [self expectationWithDescription:@"reply"];
    self.bridge.evaluateJS = ^(NSString *js) { [self.js addObject:js]; [replied fulfill]; };
    [self.bridge handleMessage:@{@"id": @"abc", @"cmd": @"nope", @"args": @{}}];
    [self waitForExpectationsWithTimeout:2 handler:nil];
    NSArray *args = [self argsOfJS:self.js.firstObject prefix:@"window.__cycleReply.apply(null, "];
    XCTAssertEqualObjects(args[0], @"abc");
    XCTAssertEqualObjects(args[1], NSNull.null);
    XCTAssertTrue([args[2] containsString:@"unsupported bridge command"]);
}

// ---- notify.* ----

- (void)testRequestUsesGivenIdRouteAndFutureInterval {
    NSDate *now = [NSDate dateWithTimeIntervalSince1970:1000];
    NSError *error = nil;
    UNNotificationRequest *r = [CycleNotifier requestForArgs:@{@"id": @"checkin", @"at": @(1090000), @"title": @"T", @"body": @"B", @"route": @"checkin"} now:now error:&error];
    XCTAssertNotNil(r, @"%@", error);
    XCTAssertEqualObjects(r.identifier, @"checkin");
    XCTAssertEqualObjects(r.content.title, @"T");
    XCTAssertEqualObjects(r.content.body, @"B");
    XCTAssertEqualObjects(r.content.userInfo[CycleNotificationRouteKey], @"checkin");
    XCTAssertTrue([r.trigger isKindOfClass:UNTimeIntervalNotificationTrigger.class], @"trigger class %@", r.trigger.class);
    XCTAssertEqualWithAccuracy(((UNTimeIntervalNotificationTrigger *)r.trigger).timeInterval, 90, 0.001);
    XCTAssertFalse(r.trigger.repeats);
}

- (void)testRequestRejectsPastTimeAndBadArgsNamingTheProblem {
    NSDate *now = [NSDate dateWithTimeIntervalSince1970:1000];
    NSError *error = nil;
    XCTAssertNil([CycleNotifier requestForArgs:(@{@"id": @"x", @"at": @(500000), @"title": @"T", @"body": @"B", @"route": @"r"}) now:now error:&error]);
    XCTAssertTrue([error.localizedDescription containsString:@"not in the future"], @"%@", error);
    XCTAssertNil([CycleNotifier requestForArgs:(@{@"id": @"x", @"at": @(2000000), @"title": @"T", @"body": @"B"}) now:now error:&error]);
    XCTAssertTrue([error.localizedDescription containsString:@"'route'"], @"%@", error);
    XCTAssertNil([CycleNotifier requestForArgs:(@{@"id": @"x", @"at": @"soon", @"title": @"T", @"body": @"B", @"route": @"r"}) now:now error:&error]);
    XCTAssertTrue([error.localizedDescription containsString:@"'at'"], @"%@", error);
}

- (void)testReschedulingAnIdReplacesTheEarlierRequest {
    XCTAssertEqualObjects([self run:@"notify.schedule" args:[self scheduleArgsWithID:@"checkin" title:@"first" inSeconds:60]][@"error"], NSNull.null);
    XCTAssertEqualObjects([self run:@"notify.schedule" args:[self scheduleArgsWithID:@"checkin" title:@"second" inSeconds:120]][@"error"], NSNull.null);
    XCTAssertEqual(self.center.pending.count, 1u, @"same id must leave exactly one pending request");
    XCTAssertEqualObjects(self.center.pending[@"checkin"].content.title, @"second");
    XCTAssertEqualWithAccuracy(((UNTimeIntervalNotificationTrigger *)self.center.pending[@"checkin"].trigger).timeInterval, 120, 2);
    [self run:@"notify.schedule" args:[self scheduleArgsWithID:@"hold" title:@"h" inSeconds:60]];
    XCTAssertEqual(self.center.pending.count, 2u, @"a different id is a separate request");
}

- (void)testScheduleInThePastReturnsErrorAndSchedulesNothing {
    NSDictionary *out = [self run:@"notify.schedule" args:[self scheduleArgsWithID:@"checkin" title:@"t" inSeconds:-5]];
    XCTAssertTrue([out[@"error"] containsString:@"not in the future"], @"%@", out);
    XCTAssertEqual(self.center.pending.count, 0u);
}

- (void)testCancelRemovesPendingAndDelivered {
    [self run:@"notify.schedule" args:[self scheduleArgsWithID:@"checkin" title:@"t" inSeconds:60]];
    XCTAssertEqualObjects([self run:@"notify.cancel" args:(@{@"id": @"checkin"})][@"error"], NSNull.null);
    XCTAssertEqual(self.center.pending.count, 0u);
    XCTAssertEqualObjects(self.center.removedDelivered, (@[@"checkin"]));
}

// ---- native -> JS ----

- (void)testRoutesAreQueuedUntilReadyThenDeliveredInOrder {
    [self.bridge deliverRoute:@"checkin"];
    [self.bridge deliverRoute:@"follow-up"];
    XCTAssertEqual(self.js.count, 0u, @"nothing may reach the page before it sends ready");
    [self run:@"ready" args:@{}];
    XCTAssertEqual(self.js.count, 2u);
    XCTAssertEqualObjects([self argsOfJS:self.js[0] prefix:@"window.cycleNative.route.apply(window.cycleNative, "], (@[@"checkin"]));
    XCTAssertEqualObjects([self argsOfJS:self.js[1] prefix:@"window.cycleNative.route.apply(window.cycleNative, "], (@[@"follow-up"]));
    [self.bridge deliverRoute:@"home"];
    XCTAssertEqual(self.js.count, 3u, @"once ready a route goes straight through");
    [self run:@"ready" args:@{}];
    XCTAssertEqual(self.js.count, 3u, @"a second ready must not redeliver");
}

- (void)testForegroundOnlyOnceReadyAndReloadResetsReady {
    [self.bridge foreground];
    XCTAssertEqual(self.js.count, 0u);
    [self run:@"ready" args:@{}];
    [self.bridge foreground];
    XCTAssertEqual(self.js.count, 1u);
    XCTAssertEqualObjects(self.js[0], @"window.cycleNative.foreground.apply(window.cycleNative, [])");
    [self.bridge pageWillReload];
    [self.bridge foreground];
    [self.bridge deliverRoute:@"checkin"];
    XCTAssertEqual(self.js.count, 1u, @"a reloading page is not ready");
    [self run:@"ready" args:@{}];
    XCTAssertEqual(self.js.count, 2u, @"the queued route goes out on the new page's ready");
}

// A notification tap opens the app, the route reaches the page, then a fresh web copy reloads it: the new page must
// still get the route, or the tap ends on Home (Oliver's "Log fight" tap, 2026-11-05). An old route is not replayed.
- (void)testRouteDeliveredJustBeforeReloadIsRedeliveredToTheNewPage {
    NSString *prefix = @"window.cycleNative.route.apply(window.cycleNative, ";
    [self run:@"ready" args:@{}];
    [self.bridge deliverRoute:@"fight/f1"];
    XCTAssertEqual(self.js.count, 1u);
    [self.bridge pageWillReload];
    [self.bridge pageWillReload]; // provisional navigation can start twice; still one redelivery
    [self run:@"ready" args:@{}];
    XCTAssertEqual(self.js.count, 2u, @"%@", self.js);
    XCTAssertEqualObjects([self argsOfJS:self.js[1] prefix:prefix], (@[@"fight/f1"]));
    // A newer tap queued during the reload wins over the replay.
    [self.bridge pageWillReload];
    [self.bridge deliverRoute:@"todo/t1"];
    [self run:@"ready" args:@{}];
    NSMutableArray *routes = [NSMutableArray array];
    for (NSString *js in self.js) if ([js hasPrefix:prefix]) [routes addObject:[self argsOfJS:js prefix:prefix][0]];
    XCTAssertEqualObjects(routes, (@[@"fight/f1", @"fight/f1", @"todo/t1"]), @"%@", self.js);
    // Past the window the tap is old news: a later reload boots wherever the page boots.
    [self.bridge setValue:[NSDate dateWithTimeIntervalSinceNow:-120] forKey:@"lastRouteAt"];
    NSUInteger before = self.js.count;
    [self.bridge pageWillReload];
    [self run:@"ready" args:@{}];
    XCTAssertEqual(self.js.count, before, @"%@", self.js);
}

// The APNs token is held until the page is ready, goes straight through after, and is resent on every new page's ready.
- (void)testPushTokenWaitsForReadyAndIsResentAfterReload {
    [self.bridge deliverPushToken:@"abcd"];
    XCTAssertEqual(self.js.count, 0u);
    [self run:@"ready" args:@{}];
    XCTAssertEqual(self.js.count, 1u);
    XCTAssertEqualObjects([self argsOfJS:self.js[0] prefix:@"window.cycleNative.pushToken.apply(window.cycleNative, "], (@[@"abcd"]));
    [self.bridge deliverPushToken:@"ef01"];
    XCTAssertEqual(self.js.count, 2u);
    [self.bridge pageWillReload];
    [self run:@"ready" args:@{}];
    XCTAssertEqual(self.js.count, 3u);
    XCTAssertEqualObjects([self argsOfJS:self.js[2] prefix:@"window.cycleNative.pushToken.apply(window.cycleNative, "], (@[@"ef01"]));
}

// Face ID is asked once per install: a success sticks across launches, and toggling the lock asks again.
- (void)testLockNeedsAuthOnlyUntilFirstUnlock {
    NSUserDefaults *d = NSUserDefaults.standardUserDefaults;
    [d removeObjectForKey:@"cycle.lockEnabled"];
    [d removeObjectForKey:@"cycle.lockPassed"];
    XCTAssertTrue([CycleBridge lockNeedsAuth]);
    [CycleBridge markLockPassed];
    XCTAssertFalse([CycleBridge lockNeedsAuth]);
    XCTAssertEqualObjects([self run:@"lock.set" args:@{@"on": @NO}][@"error"], NSNull.null);
    XCTAssertFalse([CycleBridge lockNeedsAuth]);
    [self run:@"lock.set" args:@{@"on": @YES}];
    XCTAssertTrue([CycleBridge lockNeedsAuth]);
    [d removeObjectForKey:@"cycle.lockEnabled"];
    [d removeObjectForKey:@"cycle.lockPassed"];
}

// ---- speech.start / speech.stop / speech.cancel and the silence callback (the recorder itself needs a mic and a signed host app) ----

- (void)testSpeechStartRunsTheHandlerAndRepliesNullWhenRecording {
    __block int starts = 0;
    self.bridge.speechStart = ^(void (^done)(NSString *)) { starts++; done(nil); };
    NSDictionary *out = [self run:@"speech.start" args:@{}];
    XCTAssertEqual(starts, 1);
    XCTAssertEqualObjects(out[@"error"], NSNull.null);
}

- (void)testSpeechStartDeniedSurfacesTheReasonAsTheError {
    self.bridge.speechStart = ^(void (^done)(NSString *)) { done(@"Mic off"); };
    NSDictionary *out = [self run:@"speech.start" args:@{}];
    XCTAssertEqualObjects(out[@"error"], @"Mic off");
    XCTAssertEqualObjects(out[@"result"], NSNull.null);
}

- (void)testSpeechStopRepliesTheClipAsBase64WithItsMime {
    __block int stops = 0;
    NSData *clip = [@"m4a-bytes" dataUsingEncoding:NSUTF8StringEncoding];
    self.bridge.speechStop = ^NSData *{ stops++; return clip; };
    NSDictionary *out = [self run:@"speech.stop" args:@{}];
    XCTAssertEqual(stops, 1);
    XCTAssertEqualObjects(out[@"error"], NSNull.null);
    XCTAssertEqualObjects(out[@"result"], (@{ @"audio": [clip base64EncodedStringWithOptions:0], @"mime": @"audio/mp4" }));
}

- (void)testSpeechStopWithNothingRecordedRepliesNull {
    self.bridge.speechStop = ^NSData *{ return nil; };
    NSDictionary *out = [self run:@"speech.stop" args:@{}];
    XCTAssertEqualObjects(out[@"error"], NSNull.null);
    XCTAssertEqualObjects(out[@"result"], NSNull.null);
}

- (void)testSpeechCancelRunsTheHandler {
    __block int cancels = 0;
    self.bridge.speechCancel = ^{ cancels++; };
    XCTAssertEqualObjects([self run:@"speech.cancel" args:@{}][@"error"], NSNull.null);
    XCTAssertEqual(cancels, 1);
}

- (void)testSpeechCommandsWithoutAHandlerAreLoudErrors {
    XCTAssertTrue([[self run:@"speech.start" args:@{}][@"error"] containsString:@"no speech handler"]);
    XCTAssertTrue([[self run:@"speech.stop" args:@{}][@"error"] containsString:@"no speech handler"]);
    XCTAssertTrue([[self run:@"speech.cancel" args:@{}][@"error"] containsString:@"no speech handler"]);
}

- (void)testSilenceAndErrorReachThePageOnlyOnceItIsReady {
    [self.bridge deliverSpeechSilence];
    [self.bridge deliverSpeechError:@"Mic busy"];
    XCTAssertEqual(self.js.count, 0u, @"nothing may reach the page before it sends ready");
    [self run:@"ready" args:@{}];
    [self.bridge deliverSpeechSilence];
    [self.bridge deliverSpeechError:@"Mic busy"];
    XCTAssertEqual(self.js.count, 2u);
    XCTAssertEqualObjects([self argsOfJS:self.js[0] prefix:@"window.cycleNative.speechSilence.apply(window.cycleNative, "], (@[]));
    XCTAssertEqualObjects([self argsOfJS:self.js[1] prefix:@"window.cycleNative.speechError.apply(window.cycleNative, "], (@[@"Mic busy"]));
}

- (void)testBackgroundingInterruptsTheRecordingWithoutStoppingIt {
    __block int interrupts = 0, stops = 0, cancels = 0;
    self.bridge.speechInterrupt = ^{ interrupts++; };
    self.bridge.speechStop = ^NSData *{ stops++; return nil; };
    self.bridge.speechCancel = ^{ cancels++; };
    [self.bridge speechInterrupted];
    XCTAssertEqual(interrupts, 1);
    XCTAssertEqual(stops + cancels, 0, @"the clip is kept for the page's pending speech.stop");
}

@end
