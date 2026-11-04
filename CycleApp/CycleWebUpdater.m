#import "CycleWebUpdater.h"

#import <CommonCrypto/CommonDigest.h>

static NSString *const CycleActivePointer = @"active.txt";
static const NSTimeInterval CycleWebCheckInterval = 600;
static const NSTimeInterval CycleFreshOpenWindow = 10;

@interface CycleWebUpdater ()
@property (nonatomic, strong) NSURL *root;
@property (nonatomic, strong) NSURL *bundle;
@property (nonatomic, strong) NSURL *boxURL;
@property (nonatomic, assign) NSInteger shellVersion;
@property (nonatomic, strong) NSURLSession *session;
@property (nonatomic, strong) NSDate *lastCheck;
@property (nonatomic, assign) BOOL running;
@end

@implementation CycleWebUpdater

// ---- reading versions -----------------------------------------------------------------------

static NSNumber *CycleJSONNumber(NSURL *dir, NSString *file, NSString *key) {
    NSData *data = [NSData dataWithContentsOfURL:[dir URLByAppendingPathComponent:file]];
    if (!data) return nil;
    id json = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
    id v = [json isKindOfClass:NSDictionary.class] ? json[key] : nil;
    return [v isKindOfClass:NSNumber.class] ? v : nil;
}

/// The live downloaded folder, or nil when none is active. A pointer to a folder without index.html
/// breaks the invariant that a swap is all-or-nothing, so it is logged loudly.
+ (NSURL *)activeDirectoryInRoot:(NSURL *)root {
    NSString *name = [NSString stringWithContentsOfURL:[root URLByAppendingPathComponent:CycleActivePointer] encoding:NSUTF8StringEncoding error:NULL];
    if (!name.length) return nil;
    NSURL *dir = [root URLByAppendingPathComponent:name isDirectory:YES];
    if (![NSFileManager.defaultManager fileExistsAtPath:[dir URLByAppendingPathComponent:@"index.html"].path]) {
        NSLog(@"[Cycle] INVARIANT VIOLATED: active web copy %@ has no index.html; using the bundle", dir.path);
        return nil;
    }
    return dir;
}

+ (NSURL *)pageDirectoryWithRoot:(NSURL *)root bundleDirectory:(NSURL *)bundle shellVersion:(NSInteger)shellVersion {
    NSNumber *bundleVersion = CycleJSONNumber(bundle, @"version.json", @"version");
    NSAssert(bundleVersion, @"web/version.json missing from the app bundle (the CI build writes it)");
    NSURL *active = [self activeDirectoryInRoot:root];
    if (!active) return bundle;
    NSNumber *version = CycleJSONNumber(active, @"version.json", @"version");
    NSNumber *minShell = CycleJSONNumber(active, @"shell.json", @"minShell");
    if (!version || !minShell) {
        NSLog(@"[Cycle] INVARIANT VIOLATED: active web copy %@ lacks version.json/shell.json; using the bundle", active.path);
        return bundle;
    }
    return (version.integerValue > bundleVersion.integerValue && minShell.integerValue <= shellVersion) ? active : bundle;
}

+ (void)pruneRoot:(NSURL *)root keepingDirectory:(NSURL *)page {
    NSString *active = [NSString stringWithContentsOfURL:[root URLByAppendingPathComponent:CycleActivePointer] encoding:NSUTF8StringEncoding error:NULL];
    for (NSURL *dir in [NSFileManager.defaultManager contentsOfDirectoryAtURL:root includingPropertiesForKeys:nil options:0 error:NULL]) {
        NSString *name = dir.lastPathComponent;
        if ([name hasPrefix:@"v"] && ![name isEqualToString:active] && ![name isEqualToString:page.lastPathComponent]) [NSFileManager.defaultManager removeItemAtURL:dir error:NULL];
    }
}

+ (NSURL *)boxURLFromConfigAtURL:(NSURL *)config {
    NSString *js = [NSString stringWithContentsOfURL:config encoding:NSUTF8StringEncoding error:NULL];
    NSRange eq = [js rangeOfString:@"="];
    NSRange end = [js rangeOfString:@";" options:NSBackwardsSearch];
    NSData *json = (eq.location != NSNotFound && end.location != NSNotFound && end.location > eq.location)
        ? [[js substringWithRange:NSMakeRange(NSMaxRange(eq), end.location - NSMaxRange(eq))] dataUsingEncoding:NSUTF8StringEncoding] : nil;
    id cfg = json ? [NSJSONSerialization JSONObjectWithData:json options:0 error:NULL] : nil;
    NSString *box = [cfg isKindOfClass:NSDictionary.class] ? cfg[@"boxUrl"] : nil;
    if (!box.length) { NSLog(@"[Cycle] no boxUrl in %@; web updates disabled", config.path); return nil; }
    return [NSURL URLWithString:box];
}

// ---- checking -------------------------------------------------------------------------------

- (instancetype)initWithRoot:(NSURL *)root bundleDirectory:(NSURL *)bundle boxURL:(NSURL *)boxURL
                shellVersion:(NSInteger)shellVersion session:(NSURLSession *)session {
    if ((self = [super init])) {
        _root = root; _bundle = bundle; _boxURL = boxURL; _shellVersion = shellVersion; _session = session;
    }
    return self;
}

- (void)checkIfDue {
    [self checkIfDueWithCompletion:nil];
}

- (void)checkIfDueWithCompletion:(void (^)(BOOL))completion {
    if (self.running || (self.lastCheck && -[self.lastCheck timeIntervalSinceNow] < CycleWebCheckInterval)) return;
    self.lastCheck = [NSDate date];
    [self checkWithCompletion:completion];
}

+ (BOOL)shouldReloadAfterActivationWithFreshOpenAt:(NSDate *)freshOpenAt now:(NSDate *)now active:(BOOL)active {
    return active && freshOpenAt && [now timeIntervalSinceDate:freshOpenAt] <= CycleFreshOpenWindow;
}

- (void)checkWithCompletion:(void (^)(BOOL))completion {
    self.running = YES;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        NSError *error = nil;
        BOOL activated = [self update:&error];
        if (error) NSLog(@"[Cycle] web update skipped: %@", error.localizedDescription);
        dispatch_async(dispatch_get_main_queue(), ^{
            self.running = NO;
            if (completion) completion(activated);
        });
    });
}

static NSError *CycleUpdateError(NSString *message) {
    return [NSError errorWithDomain:@"CycleWebUpdater" code:1 userInfo:@{ NSLocalizedDescriptionKey: message }];
}

/// Synchronous GET (the caller is already on a background queue).
- (NSData *)fetch:(NSString *)path query:(NSString *)query error:(NSError **)error {
    NSURL *url = [self.boxURL URLByAppendingPathComponent:path];
    if (query) {
        NSURLComponents *parts = [NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:NO];
        parts.query = query;
        url = parts.URL;
    }
    __block NSData *body = nil; __block NSError *err = nil;
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    [[self.session dataTaskWithURL:url completionHandler:^(NSData *data, NSURLResponse *response, NSError *e) {
        NSInteger status = [(NSHTTPURLResponse *)response statusCode];
        if (e) err = e;
        else if (status != 200) err = CycleUpdateError([NSString stringWithFormat:@"GET %@ returned %ld", url, (long)status]);
        else body = data;
        dispatch_semaphore_signal(done);
    }] resume];
    dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
    if (error) *error = err;
    return body;
}

static NSString *CycleSHA256(NSData *data) {
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
    NSMutableString *hex = [NSMutableString string];
    for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) [hex appendFormat:@"%02x", digest[i]];
    return hex;
}

- (BOOL)update:(NSError **)error {
    // The loaded version rides on the manifest GET so phone checks are distinguishable in the box log.
    NSURL *loaded = [CycleWebUpdater pageDirectoryWithRoot:self.root bundleDirectory:self.bundle shellVersion:self.shellVersion];
    NSString *query = [NSString stringWithFormat:@"have=%@&shell=%ld", CycleJSONNumber(loaded, @"version.json", @"version"), (long)self.shellVersion];
    NSData *raw = [self fetch:@"app/manifest.json" query:query error:error];
    if (!raw) return NO;
    NSDictionary *manifest = [NSJSONSerialization JSONObjectWithData:raw options:0 error:NULL];
    NSNumber *version = [manifest isKindOfClass:NSDictionary.class] ? manifest[@"version"] : nil;
    NSNumber *minShell = [manifest isKindOfClass:NSDictionary.class] ? manifest[@"minShell"] : nil;
    NSDictionary<NSString *, NSString *> *files = [manifest isKindOfClass:NSDictionary.class] ? manifest[@"files"] : nil;
    if (![version isKindOfClass:NSNumber.class] || ![minShell isKindOfClass:NSNumber.class] || ![files isKindOfClass:NSDictionary.class]) {
        if (error) *error = CycleUpdateError(@"malformed manifest");
        return NO;
    }

    NSURL *current = [CycleWebUpdater pageDirectoryWithRoot:self.root bundleDirectory:self.bundle shellVersion:self.shellVersion];
    if (version.integerValue <= [CycleJSONNumber(current, @"version.json", @"version") integerValue]) return NO;
    if (minShell.integerValue > self.shellVersion) {
        if (error) *error = CycleUpdateError([NSString stringWithFormat:@"web %@ needs shell %@, this is %ld", version, minShell, (long)self.shellVersion]);
        return NO;
    }

    NSFileManager *fm = NSFileManager.defaultManager;
    NSURL *staging = [self.root URLByAppendingPathComponent:@"staging" isDirectory:YES];
    [fm removeItemAtURL:staging error:NULL];
    if (![fm createDirectoryAtURL:staging withIntermediateDirectories:YES attributes:nil error:error]) return NO;

    NSString *stagingPrefix = [staging.URLByStandardizingPath.path stringByAppendingString:@"/"];
    for (NSString *rel in files) {
        NSURL *dst = [staging URLByAppendingPathComponent:rel];
        // The manifest is remote input: a path that resolves outside staging is rejected outright.
        if (![dst.URLByStandardizingPath.path hasPrefix:stagingPrefix]) {
            if (error) *error = CycleUpdateError([NSString stringWithFormat:@"manifest path escapes the web folder: %@", rel]);
            return NO;
        }
        NSString *want = files[rel];
        NSData *data = nil;
        for (NSURL *dir in @[current, self.bundle]) { // reuse an unchanged file already on the device
            NSData *local = [NSData dataWithContentsOfURL:[dir URLByAppendingPathComponent:rel]];
            if (local && [CycleSHA256(local) isEqualToString:want]) { data = local; break; }
        }
        if (!data) {
            data = [self fetch:[@"app/" stringByAppendingString:rel] query:nil error:error];
            if (!data) return NO;
            if (![CycleSHA256(data) isEqualToString:want]) {
                if (error) *error = CycleUpdateError([NSString stringWithFormat:@"hash mismatch for %@", rel]);
                return NO;
            }
        }
        if (![fm createDirectoryAtURL:dst.URLByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:error]) return NO;
        if (![data writeToURL:dst options:0 error:error]) return NO;
    }
    // config.js is generated per build and is not in the manifest; the bundled one carries over.
    if (![fm copyItemAtURL:[self.bundle URLByAppendingPathComponent:@"config.js"] toURL:[staging URLByAppendingPathComponent:@"config.js"] error:error]) return NO;
    if ([CycleJSONNumber(staging, @"version.json", @"version") integerValue] != version.integerValue) {
        if (error) *error = CycleUpdateError(@"staged version.json does not match the manifest version");
        return NO;
    }

    // Swap: move the finished folder into place, then flip the pointer with one atomic write.
    NSString *name = [NSString stringWithFormat:@"v%@", version];
    NSURL *live = [self.root URLByAppendingPathComponent:name isDirectory:YES];
    [fm removeItemAtURL:live error:NULL];
    if (![fm moveItemAtURL:staging toURL:live error:error]) return NO;
    if (![name writeToURL:[self.root URLByAppendingPathComponent:CycleActivePointer] atomically:YES encoding:NSUTF8StringEncoding error:error]) return NO;
    NSLog(@"[Cycle] web copy %@ activated; used from the next cold load or long-absence return", version);
    return YES;
}

@end
