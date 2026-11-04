// CycleWebUpdater against real temp directories and an NSURLProtocol stub standing in for the box.
#import <XCTest/XCTest.h>
#import <CommonCrypto/CommonDigest.h>
#import "CycleWebUpdater.h"

// path (after the box prefix) -> NSData body | NSNumber status | NSError; requests are logged in order.
@interface CycleBoxStub : NSURLProtocol
@end

static NSMutableDictionary *routes_; static NSMutableArray *requests_; static NSMutableArray *queries_;

@implementation CycleBoxStub
+ (BOOL)canInitWithRequest:(NSURLRequest *)request { return YES; }
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }
- (void)startLoading {
    NSString *path = self.request.URL.path;
    @synchronized (CycleBoxStub.class) { [requests_ addObject:path]; [queries_ addObject:self.request.URL.query ?: @""]; }
    id route = routes_[path];
    if ([route isKindOfClass:NSNull.class]) return; // hangs: only the session's timeout ends it
    if ([route isKindOfClass:NSError.class]) { [self.client URLProtocol:self didFailWithError:route]; return; }
    NSInteger status = route ? 200 : 404;
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL statusCode:status HTTPVersion:@"HTTP/1.1" headerFields:nil];
    [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    if (route) [self.client URLProtocol:self didLoadData:route];
    [self.client URLProtocolDidFinishLoading:self];
}
- (void)stopLoading {}
@end

@interface CycleWebUpdaterTests : XCTestCase
@property (nonatomic, strong) NSURL *tmp, *root, *bundle;
@property (nonatomic, strong) NSURLSession *session;
@end

@implementation CycleWebUpdaterTests

static NSString *SHA(NSData *d) {
    unsigned char h[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(d.bytes, (CC_LONG)d.length, h);
    NSMutableString *hex = [NSMutableString string];
    for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) [hex appendFormat:@"%02x", h[i]];
    return hex;
}

static NSData *Bytes(NSString *s) { return [s dataUsingEncoding:NSUTF8StringEncoding]; }

- (void)write:(NSDictionary<NSString *, NSString *> *)files into:(NSURL *)dir {
    for (NSString *rel in files) {
        NSURL *url = [dir URLByAppendingPathComponent:rel];
        NSError *error = nil;
        XCTAssertTrue([NSFileManager.defaultManager createDirectoryAtURL:url.URLByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:&error], @"%@", error);
        XCTAssertTrue([Bytes(files[rel]) writeToURL:url options:0 error:&error], @"%@", error);
    }
}

- (void)setUp {
    self.tmp = [NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:[NSUUID UUID].UUIDString] isDirectory:YES];
    self.root = [self.tmp URLByAppendingPathComponent:@"root" isDirectory:YES];
    self.bundle = [self.tmp URLByAppendingPathComponent:@"bundle" isDirectory:YES];
    NSError *error = nil;
    XCTAssertTrue([NSFileManager.defaultManager createDirectoryAtURL:self.root withIntermediateDirectories:YES attributes:nil error:&error], @"%@", error);
    [self write:@{ @"index.html": @"old index", @"css/a.css": @"body{}", @"config.js": @"window.CYCLE_CONFIG = {\"boxUrl\":\"http://box.test/cycle\"};",
                   @"version.json": @"{\"version\":100}", @"shell.json": @"{\"minShell\":1}" } into:self.bundle];
    routes_ = [NSMutableDictionary dictionary];
    requests_ = [NSMutableArray array];
    queries_ = [NSMutableArray array];
    NSURLSessionConfiguration *config = NSURLSessionConfiguration.ephemeralSessionConfiguration;
    config.protocolClasses = @[CycleBoxStub.class];
    self.session = [NSURLSession sessionWithConfiguration:config];
}

- (void)tearDown {
    [NSFileManager.defaultManager removeItemAtURL:self.tmp error:NULL];
}

/// Publishes a manifest on the stub box; `files` are served and listed with their real hashes, and
/// `tamper` names files whose served bytes differ from the listed hash.
- (void)publishVersion:(NSInteger)version minShell:(NSInteger)minShell files:(NSDictionary<NSString *, NSString *> *)files tamper:(NSArray *)tamper {
    NSMutableDictionary *hashes = [NSMutableDictionary dictionary];
    NSMutableDictionary *all = [files mutableCopy];
    all[@"version.json"] = [NSString stringWithFormat:@"{\"version\":%ld}", (long)version];
    all[@"shell.json"] = [NSString stringWithFormat:@"{\"minShell\":%ld}", (long)minShell];
    for (NSString *rel in all) {
        hashes[rel] = SHA(Bytes(all[rel]));
        routes_[[@"/cycle/app/" stringByAppendingString:rel]] = [tamper containsObject:rel] ? Bytes(@"tampered") : Bytes(all[rel]);
    }
    NSDictionary *manifest = @{ @"version": @(version), @"minShell": @(minShell), @"files": hashes };
    routes_[@"/cycle/app/manifest.json"] = [NSJSONSerialization dataWithJSONObject:manifest options:0 error:NULL];
}

- (CycleWebUpdater *)updaterWithShell:(NSInteger)shell {
    return [[CycleWebUpdater alloc] initWithRoot:self.root bundleDirectory:self.bundle boxURL:[NSURL URLWithString:@"http://box.test/cycle"] shellVersion:shell session:self.session];
}

- (BOOL)runCheck:(CycleWebUpdater *)updater {
    XCTestExpectation *done = [self expectationWithDescription:@"check"];
    __block BOOL activated = NO;
    [updater checkWithCompletion:^(BOOL a) { activated = a; [done fulfill]; }];
    [self waitForExpectationsWithTimeout:10 handler:nil];
    return activated;
}

- (NSURL *)pageDir:(NSInteger)shell {
    return [CycleWebUpdater pageDirectoryWithRoot:self.root bundleDirectory:self.bundle shellVersion:shell];
}

- (NSString *)text:(NSURL *)dir file:(NSString *)rel {
    return [NSString stringWithContentsOfURL:[dir URLByAppendingPathComponent:rel] encoding:NSUTF8StringEncoding error:NULL];
}

- (NSDictionary *)threeFiles { return @{ @"index.html": @"new index", @"css/a.css": @"body{}", @"js/new.js": @"1" }; }

- (void)testNewerManifestDownloadsChangedFilesAndSwaps {
    XCTAssertEqualObjects([self pageDir:1].path, self.bundle.path, @"no download yet: the bundle loads");
    [self publishVersion:200 minShell:1 files:[self threeFiles] tamper:@[]];
    XCTAssertTrue([self runCheck:[self updaterWithShell:1]], @"requests: %@", requests_);
    NSURL *page = [self pageDir:1];
    XCTAssertEqualObjects(page.lastPathComponent, @"v200");
    XCTAssertEqualObjects([self text:page file:@"index.html"], @"new index");
    XCTAssertEqualObjects([self text:page file:@"js/new.js"], @"1");
    XCTAssertEqualObjects([self text:page file:@"css/a.css"], @"body{}");
    XCTAssertEqualObjects([self text:page file:@"config.js"], [self text:self.bundle file:@"config.js"], @"the bundled config.js carries over");
    XCTAssertEqualObjects([self text:self.root file:@"active.txt"], @"v200");
    XCTAssertFalse([requests_ containsObject:@"/cycle/app/css/a.css"], @"an unchanged file is reused, not downloaded: %@", requests_);
    XCTAssertFalse([NSFileManager.defaultManager fileExistsAtPath:[self.root URLByAppendingPathComponent:@"staging"].path], @"staging is gone after the swap");
}

- (void)testHashMismatchLeavesActiveCopyUntouched {
    [self publishVersion:200 minShell:1 files:[self threeFiles] tamper:@[]];
    XCTAssertTrue([self runCheck:[self updaterWithShell:1]]);
    NSMutableDictionary *next = [[self threeFiles] mutableCopy];
    next[@"index.html"] = @"v300 index"; next[@"js/new.js"] = @"2";
    [self publishVersion:300 minShell:1 files:next tamper:@[@"js/new.js"]];
    XCTAssertFalse([self runCheck:[self updaterWithShell:1]], @"a tampered file aborts the update");
    NSURL *page = [self pageDir:1];
    XCTAssertEqualObjects(page.lastPathComponent, @"v200");
    XCTAssertEqualObjects([self text:page file:@"index.html"], @"new index");
    XCTAssertEqualObjects([self text:self.root file:@"active.txt"], @"v200");
}

- (void)testHashMismatchWithNothingActiveKeepsTheBundle {
    [self publishVersion:200 minShell:1 files:[self threeFiles] tamper:@[@"index.html"]];
    XCTAssertFalse([self runCheck:[self updaterWithShell:1]]);
    XCTAssertEqualObjects([self pageDir:1].path, self.bundle.path);
    XCTAssertFalse([NSFileManager.defaultManager fileExistsAtPath:[self.root URLByAppendingPathComponent:@"active.txt"].path]);
}

- (void)testMinShellTooHighIsSkippedWithoutDownloading {
    [self publishVersion:200 minShell:2 files:[self threeFiles] tamper:@[]];
    XCTAssertFalse([self runCheck:[self updaterWithShell:1]]);
    XCTAssertEqualObjects(requests_, (@[@"/cycle/app/manifest.json"]), @"only the manifest was fetched");
    XCTAssertEqualObjects([self pageDir:1].path, self.bundle.path);
}

- (void)testDownloadedCopyNeedingNewerShellIsIgnoredAtLoad {
    [self write:@{ @"index.html": @"future", @"version.json": @"{\"version\":500}", @"shell.json": @"{\"minShell\":7}", @"active.txt": @"v500" } into:self.root];
    [self write:@{ @"index.html": @"future", @"version.json": @"{\"version\":500}", @"shell.json": @"{\"minShell\":7}" } into:[self.root URLByAppendingPathComponent:@"v500"]];
    XCTAssertEqualObjects([self pageDir:1].path, self.bundle.path);
    XCTAssertEqualObjects([self pageDir:7].lastPathComponent, @"v500", @"control: the same copy loads once the shell is new enough");
}

- (void)testNewerBundleBeatsOlderDownload {
    [self write:@{ @"active.txt": @"v150" } into:self.root];
    [self write:@{ @"index.html": @"downloaded", @"version.json": @"{\"version\":150}", @"shell.json": @"{\"minShell\":1}" } into:[self.root URLByAppendingPathComponent:@"v150"]];
    XCTAssertEqualObjects([self pageDir:1].lastPathComponent, @"v150", @"control: bundle 100 is older than download 150");
    [self write:@{ @"version.json": @"{\"version\":200}" } into:self.bundle];
    XCTAssertEqualObjects([self pageDir:1].path, self.bundle.path, @"bundle 200 beats download 150");
}

- (void)testPointerToFolderWithoutIndexFallsBackToTheBundle {
    [self write:@{ @"active.txt": @"v900" } into:self.root];
    [NSFileManager.defaultManager createDirectoryAtURL:[self.root URLByAppendingPathComponent:@"v900"] withIntermediateDirectories:YES attributes:nil error:NULL];
    XCTAssertEqualObjects([self pageDir:1].path, self.bundle.path);
}

- (void)testOfflineIsASilentNoOp {
    routes_[@"/cycle/app/manifest.json"] = [NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorNotConnectedToInternet userInfo:nil];
    XCTAssertFalse([self runCheck:[self updaterWithShell:1]]);
    XCTAssertEqualObjects([self pageDir:1].path, self.bundle.path);
    XCTAssertEqualObjects(requests_, (@[@"/cycle/app/manifest.json"]));
}

- (void)testManifestNotNewerDownloadsNothing {
    [self publishVersion:100 minShell:1 files:[self threeFiles] tamper:@[]];
    XCTAssertFalse([self runCheck:[self updaterWithShell:1]]);
    XCTAssertEqualObjects(requests_, (@[@"/cycle/app/manifest.json"]));
}

- (void)testManifestPathEscapingTheFolderIsRejected {
    NSMutableDictionary *files = [[self threeFiles] mutableCopy];
    files[@"../evil.js"] = @"x";
    [self publishVersion:200 minShell:1 files:files tamper:@[]];
    XCTAssertFalse([self runCheck:[self updaterWithShell:1]]);
    XCTAssertEqualObjects([self pageDir:1].path, self.bundle.path);
    XCTAssertFalse([NSFileManager.defaultManager fileExistsAtPath:[self.root URLByAppendingPathComponent:@"evil.js"].path]);
}

- (void)testPruneKeepsOnlyTheLoadedAndPointedFolders {
    for (NSString *v in @[@"v1", @"v2", @"v3"]) [NSFileManager.defaultManager createDirectoryAtURL:[self.root URLByAppendingPathComponent:v] withIntermediateDirectories:YES attributes:nil error:NULL];
    [self write:@{ @"active.txt": @"v3" } into:self.root];
    [CycleWebUpdater pruneRoot:self.root keepingDirectory:[self.root URLByAppendingPathComponent:@"v2"]];
    NSArray *left = [[NSFileManager.defaultManager contentsOfDirectoryAtPath:self.root.path error:NULL] sortedArrayUsingSelector:@selector(compare:)];
    XCTAssertEqualObjects(left, (@[@"active.txt", @"v2", @"v3"]));
}

- (void)testBoxURLParsedFromConfigJs {
    XCTAssertEqualObjects([CycleWebUpdater boxURLFromConfigAtURL:[self.bundle URLByAppendingPathComponent:@"config.js"]].absoluteString, @"http://box.test/cycle");
    XCTAssertNil([CycleWebUpdater boxURLFromConfigAtURL:[self.bundle URLByAppendingPathComponent:@"missing.js"]]);
}

- (void)testHungFetchTimesOutAndDoesNotBlockTheNextCheck {
    NSURLSessionConfiguration *config = NSURLSessionConfiguration.ephemeralSessionConfiguration;
    config.protocolClasses = @[CycleBoxStub.class];
    config.timeoutIntervalForRequest = 1;
    self.session = [NSURLSession sessionWithConfiguration:config];
    routes_[@"/cycle/app/manifest.json"] = NSNull.null;
    CycleWebUpdater *updater = [self updaterWithShell:1];
    XCTAssertFalse([self runCheck:updater], @"the hung request must complete, not activate");
    [self publishVersion:200 minShell:1 files:[self threeFiles] tamper:@[]];
    XCTAssertTrue([self runCheck:updater], @"a later check must issue a new request; requests: %@", requests_);
    XCTAssertEqualObjects([self pageDir:1].lastPathComponent, @"v200");
}

- (void)testManifestRequestCarriesLoadedVersionAndShell {
    [self publishVersion:200 minShell:1 files:[self threeFiles] tamper:@[]];
    [self runCheck:[self updaterWithShell:1]];
    XCTAssertEqualObjects(queries_.firstObject, @"have=100&shell=1");
    XCTAssertEqualObjects(requests_.firstObject, @"/cycle/app/manifest.json");
}

- (void)testReloadAfterActivationOnlyRightAfterAnOpenWhileActive {
    NSDate *now = [NSDate date];
    XCTAssertTrue([CycleWebUpdater shouldReloadAfterActivationWithFreshOpenAt:[now dateByAddingTimeInterval:-3] now:now active:YES]);
    XCTAssertFalse([CycleWebUpdater shouldReloadAfterActivationWithFreshOpenAt:[now dateByAddingTimeInterval:-30] now:now active:YES], @"mid-session");
    XCTAssertFalse([CycleWebUpdater shouldReloadAfterActivationWithFreshOpenAt:[now dateByAddingTimeInterval:-3] now:now active:NO], @"backgrounded");
    XCTAssertFalse([CycleWebUpdater shouldReloadAfterActivationWithFreshOpenAt:nil now:now active:YES]);
}

@end
