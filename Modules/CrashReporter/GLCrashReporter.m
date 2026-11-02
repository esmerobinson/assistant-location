#import "GLCrashReporter.h"

#import "BakedConfig.h"
#import "GLAppStateReporter.h"
#import "GLCrashDiagnosticMapping.h"

#import <MetricKit/MetricKit.h>

// Same host as everything else in the app (GLAppStateReporter.m, GLTheme.m,
// GLWebBridge.m) -- piggybacks on the existing theme/events server rather
// than standing up a separate one. Duplicated as a static constant rather
// than shared via a header, matching the existing convention every one of
// those files already follows for the same reason (see GLWebBridge.m's own
// comment on this).
static NSInteger const kGLCrashReporterServerPort = 8304;

// Ring-buffer size. 20 is enough to show the last handful of bridge
// dispatches/module opens leading up to a crash without the persisted
// report growing unbounded -- there is no unbounded-growth risk here (a
// fixed-size NSMutableArray, trimmed on every append), so this is just
// "enough breadcrumbs to reconstruct the last few user actions", not a
// measured/tuned value.
static NSUInteger const kGLCrashReporterMaxBreadcrumbs = 20;

// Application Support, not Documents: this file is app-internal diagnostic
// state, never something the user should see in the Files app (Documents is
// user-visible when a target has file-sharing enabled; this app doesn't, but
// Application Support is the correct place regardless).
static NSString *_Nullable GLCrashReportFilePath(void) {
    NSArray<NSString *> *paths = NSSearchPathForDirectoriesInDomains(
        NSApplicationSupportDirectory, NSUserDomainMask, YES);
    NSString *dir = paths.firstObject;
    if (dir.length == 0) return nil;
    // NSApplicationSupportDirectory is NOT guaranteed to exist yet -- unlike
    // Documents/Library, iOS does not pre-create it for a fresh install.
    NSFileManager *fm = [NSFileManager defaultManager];
    if (![fm fileExistsAtPath:dir]) {
        NSError *error = nil;
        if (![fm createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:&error]) {
            return nil;
        }
    }
    return [dir stringByAppendingPathComponent:@"pending-crash-report.json"];
}

static NSString *_Nullable GLCrashSupportFile(NSString *name) {
    NSString *exceptionReport = GLCrashReportFilePath();
    return exceptionReport ? [[exceptionReport stringByDeletingLastPathComponent] stringByAppendingPathComponent:name] : nil;
}

// Breadcrumbs survive the process in two files so a crash that is NOT an
// uncaught exception (signal, watchdog, memory kill: nothing runs at death)
// still has its trail. "current" is rewritten on every addBreadcrumb; at
// launch it is rotated to "previous", which is what MetricKit reports use.
static NSString *_Nullable GLBreadcrumbsCurrentPath(void) { return GLCrashSupportFile(@"breadcrumbs-current.json"); }
static NSString *_Nullable GLBreadcrumbsPreviousPath(void) { return GLCrashSupportFile(@"breadcrumbs-previous.json"); }
static NSString *const kGLMetricKitPendingPrefix = @"pending-metrickit-";

@interface GLCrashReporter ()
+ (NSArray<NSString *> *)gl_previousSessionBreadcrumbs;
+ (void)gl_rotateBreadcrumbFiles;
+ (void)gl_persistMetricKitReport:(NSDictionary *)report;
@end

// MetricKit delivers diagnostics of PAST runs (usually at the next launch).
// Each one is mapped by GLCrashDiagnosticMapping to the same report shape the
// exception path writes, persisted to its own file, and sent by
// +reportPendingCrashIfAny with the same delete-on-2xx rule.
@interface GLMetricKitSubscriber : NSObject <MXMetricManagerSubscriber>
+ (instancetype)shared;
@end

@implementation GLMetricKitSubscriber
+ (instancetype)shared {
    static GLMetricKitSubscriber *s;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ s = [GLMetricKitSubscriber new]; });
    return s;
}

- (void)didReceiveDiagnosticPayloads:(NSArray<MXDiagnosticPayload *> *)payloads {
    NSDictionary *identifying = [GLAppStateReporter currentIdentifyingFields];
    NSArray<NSString *> *crumbs = [GLCrashReporter gl_previousSessionBreadcrumbs];
    for (MXDiagnosticPayload *payload in payloads) {
        for (MXCrashDiagnostic *d in payload.crashDiagnostics) {
            [GLCrashReporter gl_persistMetricKitReport:
                [GLCrashDiagnosticMapping reportForKind:GLCrashDiagnosticKindCrash
                                           exceptionType:d.exceptionType
                                           exceptionCode:d.exceptionCode
                                                  signal:d.signal
                                       terminationReason:d.terminationReason
                                     hangDurationSeconds:nil
                                       callStackTreeJSON:[d.callStackTree JSONRepresentation]
                                             identifying:identifying
                                             breadcrumbs:crumbs]];
        }
        for (MXHangDiagnostic *d in payload.hangDiagnostics) {
            [GLCrashReporter gl_persistMetricKitReport:
                [GLCrashDiagnosticMapping reportForKind:GLCrashDiagnosticKindHang
                                           exceptionType:nil
                                           exceptionCode:nil
                                                  signal:nil
                                       terminationReason:nil
                                     hangDurationSeconds:@([d.hangDuration doubleValue])
                                       callStackTreeJSON:[d.callStackTree JSONRepresentation]
                                             identifying:identifying
                                             breadcrumbs:crumbs]];
        }
    }
    [GLCrashReporter reportPendingCrashIfAny];
}
@end

@implementation GLCrashReporter

#pragma mark - Breadcrumbs

// Function-local static, same pattern (and same reasoning) as
// GLModuleRegistry.m's GLRegisteredModules(): created lazily on first call
// regardless of whether +load or an explicit call reaches this class first,
// so there is no load-order dependency on anything else having initialized.
static NSMutableArray<NSString *> *GLCrashReporterBreadcrumbs(void) {
    static NSMutableArray<NSString *> *breadcrumbs;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        breadcrumbs = [NSMutableArray array];
    });
    return breadcrumbs;
}

+ (void)addBreadcrumb:(NSString *)breadcrumb {
    if (breadcrumb.length == 0) return;
    // @synchronized rather than a serial dispatch queue: call sites are
    // GLWebBridge's main-thread message handler and GLModuleRegistry's
    // (also main-thread, but not guaranteed to stay that way) module-open
    // path -- cheap mutual exclusion on a class object is enough here and
    // avoids introducing a queue just to protect a 20-element array.
    @synchronized(self) {
        NSMutableArray<NSString *> *breadcrumbs = GLCrashReporterBreadcrumbs();
        [breadcrumbs addObject:breadcrumb];
        while (breadcrumbs.count > kGLCrashReporterMaxBreadcrumbs) {
            [breadcrumbs removeObjectAtIndex:0];
        }
        // Small (<= 20 short strings); written under the lock so the file is
        // always a consistent snapshot of the buffer.
        NSString *path = GLBreadcrumbsCurrentPath();
        if (path) {
            NSData *json = [NSJSONSerialization dataWithJSONObject:breadcrumbs options:0 error:nil];
            [json writeToFile:path atomically:YES];
        }
    }
}

+ (NSArray<NSString *> *)gl_previousSessionBreadcrumbs {
    NSString *path = GLBreadcrumbsPreviousPath();
    NSData *data = path ? [NSData dataWithContentsOfFile:path] : nil;
    if (data.length == 0) return @[];
    id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    return [parsed isKindOfClass:[NSArray class]] ? parsed : @[];
}

// Launch step: last session's trail becomes "previous", current starts empty.
+ (void)gl_rotateBreadcrumbFiles {
    NSString *current = GLBreadcrumbsCurrentPath();
    NSString *previous = GLBreadcrumbsPreviousPath();
    if (!current || !previous) return;
    NSFileManager *fm = [NSFileManager defaultManager];
    [fm removeItemAtPath:previous error:nil];
    if ([fm fileExistsAtPath:current]) {
        NSError *error = nil;
        if (![fm moveItemAtPath:current toPath:previous error:&error]) {
            NSLog(@"GLCrashReporter: breadcrumb rotation failed: %@", error);
        }
    }
}

+ (NSArray<NSString *> *)gl_currentBreadcrumbs {
    @synchronized(self) {
        return [GLCrashReporterBreadcrumbs() copy];
    }
}

#pragma mark - Install / handle

// Forward declaration: +installHandler below takes this function's address
// before its definition (further down, so its doc comment can sit directly
// above the code it documents) -- without this prototype, clang errors on
// the reference as an undeclared identifier, since C requires a function be
// declared (not merely defined later in the same file) before its address
// is taken.
static void GLCrashReporterHandleException(NSException *exception);

+ (void)installHandler {
    [self gl_rotateBreadcrumbFiles];
    NSSetUncaughtExceptionHandler(&GLCrashReporterHandleException);
    [[MXMetricManager sharedManager] addSubscriber:[GLMetricKitSubscriber shared]];
}

// Runs while the process is already unwinding to a crash -- NSSetUncaught
// ExceptionHandler's contract is that the process terminates immediately
// after every registered handler returns. That rules out a network call
// here (unreliable mid-crash: no guarantee the run loop, sockets, or even
// enough time remain) and rules out @try/@catch around this body (which
// would hide a real bug in the one piece of code whose entire job is to
// observe a real bug -- same reasoning SceneDelegate.m's GLSceneDebugLog
// gives for not swallowing exceptions in its own guard). All that's left,
// and all that's needed: build a plain dictionary from data already in
// memory (the exception itself, GLAppStateReporter's identifying fields,
// the breadcrumb ring buffer) and write it synchronously to disk before the
// process is gone. +reportPendingCrashIfAny reads it back on the next
// launch.
static void GLCrashReporterHandleException(NSException *exception) {
    NSMutableDictionary *report = [[GLAppStateReporter currentIdentifyingFields] mutableCopy]
        ?: [NSMutableDictionary dictionary];
    report[@"name"] = exception.name ?: @"unknown";
    report[@"reason"] = exception.reason ?: @"";
    report[@"callStackSymbols"] = exception.callStackSymbols ?: @[];

    // NSNumber (from callStackReturnAddresses, an array of boxed pointers)
    // serializes through NSJSONSerialization as a JSON number, which loses
    // precision above 2^53 for a plain 64-bit address on some
    // encoders/decoders -- stringifying every address up front avoids that
    // silently truncating a return address on the far side.
    NSMutableArray<NSString *> *addresses = [NSMutableArray array];
    for (NSNumber *address in exception.callStackReturnAddresses) {
        [addresses addObject:[address stringValue]];
    }
    report[@"callStackReturnAddresses"] = addresses;
    report[@"breadcrumbs"] = [GLCrashReporter gl_currentBreadcrumbs];

    NSError *jsonError = nil;
    NSData *payload = [NSJSONSerialization dataWithJSONObject:report options:0 error:&jsonError];
    if (jsonError || payload == nil) return;

    NSString *path = GLCrashReportFilePath();
    if (path == nil) return;
    [payload writeToFile:path atomically:YES];
}

#pragma mark - Report on next launch

+ (void)gl_persistMetricKitReport:(NSDictionary *)report {
    NSString *path = GLCrashSupportFile([NSString stringWithFormat:@"%@%@.json",
                                         kGLMetricKitPendingPrefix, [NSUUID UUID].UUIDString]);
    NSData *json = [NSJSONSerialization dataWithJSONObject:report options:0 error:nil];
    NSAssert(path && json, @"could not serialize or place a MetricKit crash report");
    [json writeToFile:path atomically:YES];
}

+ (void)reportPendingCrashIfAny {
    NSString *exceptionPath = GLCrashReportFilePath();
    if (exceptionPath == nil) return;
    NSMutableArray<NSString *> *paths = [NSMutableArray arrayWithObject:exceptionPath];
    NSString *dir = [exceptionPath stringByDeletingLastPathComponent];
    for (NSString *name in [[NSFileManager defaultManager] contentsOfDirectoryAtPath:dir error:nil]) {
        if ([name hasPrefix:kGLMetricKitPendingPrefix]) [paths addObject:[dir stringByAppendingPathComponent:name]];
    }
    for (NSString *path in paths) [self gl_sendReportFileAtPath:path];
}

+ (void)gl_sendReportFileAtPath:(NSString *)path {
    NSData *data = [NSData dataWithContentsOfFile:path];
    if (data.length == 0) return;
    // Same unbaked-host guard as GLAppStateReporter.m's +report: a
    // simulator/CI build has no server to send to. Returning here (rather
    // than deleting the file) means a build that DOES have a real host
    // baked in still gets a chance to send this report on some later
    // launch, instead of the report being silently dropped by whichever
    // build happened to run first.
    if (GL_BAKED_HOST.length == 0 || [GL_BAKED_HOST isEqualToString:@"NO_HOST_BAKED_IN"]) {
        return;
    }

    NSString *urlString = [NSString stringWithFormat:@"http://%@:%ld/api/crash-report",
                           GL_BAKED_HOST, (long)kGLCrashReporterServerPort];
    NSURL *url = [NSURL URLWithString:urlString];
    if (url == nil) return;

    // One POST per file at a time: the launch call and the MetricKit
    // callback can overlap.
    static NSMutableSet<NSString *> *inFlight;
    @synchronized(self) {
        if (inFlight == nil) inFlight = [NSMutableSet set];
        if ([inFlight containsObject:path]) return;
        [inFlight addObject:path];
    }
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    request.HTTPMethod = @"POST";
    request.HTTPBody = data;
    [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];

    [[[NSURLSession sharedSession]
        dataTaskWithRequest:request
          completionHandler:^(NSData *_Nullable respData, NSURLResponse *_Nullable response, NSError *_Nullable error) {
        @synchronized(self) { [inFlight removeObject:path]; }
        NSInteger status = [response isKindOfClass:[NSHTTPURLResponse class]]
            ? ((NSHTTPURLResponse *)response).statusCode : 0;
        if (error == nil && status >= 200 && status <= 299) {
            // Only delete on confirmed receipt -- a dropped connection or a
            // 5xx leaves the file in place so the NEXT launch retries it
            // instead of the report being lost for good.
            [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
        }
    }] resume];
}

@end
