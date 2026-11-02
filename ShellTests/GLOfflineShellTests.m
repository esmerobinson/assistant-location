// Tests for GLOfflineShell: the saved-shell cache and the live-load -> saved
// shell fallback, run against a REAL WKWebView (this bundle has a host app,
// see Host/main.m) and a real HTTP server on 127.0.0.1 (GLTestHTTPServer).
//
// The whole design rests on one premise, proven first by
// testPremise_...: a page shown with -loadSimulatedRequest:responseHTMLString: at
// the live page's own URL has the live page's web origin, so its localStorage
// (the app's offline queue + read cache) is the same storage. Everything else
// here assumes it.
//
// Not covered, because a unit-test process cannot do it: an actual process
// kill + relaunch with the radio off. Both loads here share one process, so
// localStorage is read back from the same WebKit storage manager, not from a
// cold disk read; a device check is still needed for that.
#import <XCTest/XCTest.h>
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>

#import "GLOfflineShell.h"
#import "GLTestHTTPServer.h"

#pragma mark - helpers

/// Spins the main run loop until `condition` holds or `timeout` passes.
static BOOL GLWaitFor(NSTimeInterval timeout, BOOL (^condition)(void)) {
    NSDate *end = [NSDate dateWithTimeIntervalSinceNow:timeout];
    while (!condition()) {
        if ([end timeIntervalSinceNow] <= 0) return NO;
        [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    return YES;
}

static void GLSpin(NSTimeInterval seconds) {
    GLWaitFor(seconds, ^BOOL { return NO; });
}

/// Evaluates `js` and returns its value (NSNull for null/undefined), or a
/// descriptive string when evaluation errored or never completed.
static id GLEvalJS(WKWebView *webView, NSString *js) {
    __block id value = nil;
    __block BOOL done = NO;
    [webView evaluateJavaScript:js completionHandler:^(id result, NSError *error) {
        value = error ? [NSString stringWithFormat:@"<JS error: %@>", error] : (result ?: [NSNull null]);
        done = YES;
    }];
    if (!GLWaitFor(10, ^BOOL { return done; })) return @"<evaluateJavaScript never completed>";
    return value;
}

/// Polls `js` until it equals `expected`; returns the last value seen.
static id GLPollJS(WKWebView *webView, NSString *js, id expected, NSTimeInterval timeout) {
    __block id last = nil;
    GLWaitFor(timeout, ^BOOL {
        last = GLEvalJS(webView, js);
        return [last isEqual:expected];
    });
    return last;
}

static NSString *GLLivePage(NSString *token) {
    return [NSString stringWithFormat:
        @"<!doctype html><html><head><meta charset=utf-8><title>live</title></head><body>live page"
         "<script>localStorage.setItem('probe-key','%@');</script></body></html>", token];
}

/// What the saved shell does on load: read the live page's localStorage key,
/// run an inline module script, and try a fetch to the server. Each result is
/// parked on window for the test to read back.
static NSString *GLShellPage(NSString *version) {
    return [NSString stringWithFormat:
        @"<!doctype html><html><head><meta charset=utf-8><title>shell</title></head><body>shell %@"
         "<script>window.__origin=location.origin;window.__stored=localStorage.getItem('probe-key');"
         "window.__fetchState='pending';"
         "fetch('/ping').then(function(){window.__fetchState='resolved';},"
         "function(e){window.__fetchState='rejected';});</script>"
         "<script type=\"module\">window.__moduleRan=true;</script></body></html>", version];
}

static NSURL *GLTempDir(void) {
    NSURL *url = [NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:
                                                                   [NSUUID UUID].UUIDString]];
    return url;
}

#pragma mark - harness (stands in for GLWebModuleViewController / ListenViewController)

@interface GLShellHarness : NSObject <WKNavigationDelegate, GLOfflineShellLoaderDelegate>
@property(nonatomic, strong) UIWindow *window;
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic, strong) GLOfflineShellLoader *loader;
@property(nonatomic) NSInteger committed;
@property(nonatomic) NSInteger finished;
@property(nonatomic) NSInteger shellShown;
@property(nonatomic, strong) NSError *liveFailure;
/// Failures the loader did NOT consume: the host would have put
/// its error view up for each of these.
@property(nonatomic) NSInteger hostErrorViews;
/// Every -999 WebKit reported, consumed or not: proves a test really cancelled a navigation.
@property(nonatomic) NSInteger cancellations;
@end

@implementation GLShellHarness
- (instancetype)initWithCache:(GLOfflineShellCache *)cache {
    self = [super init];
    if (self) {
        UIViewController *vc = [[UIViewController alloc] init];
        self.window = [[UIWindow alloc] initWithFrame:CGRectMake(0, 0, 375, 667)];
        self.window.rootViewController = vc;
        self.window.hidden = NO;
        self.webView = [[WKWebView alloc] initWithFrame:vc.view.bounds configuration:[[WKWebViewConfiguration alloc] init]];
        self.webView.navigationDelegate = self;
        [vc.view addSubview:self.webView];
        self.loader = [[GLOfflineShellLoader alloc] initWithWebView:self.webView
                                                           hostView:vc.view
                                                              cache:cache
                                                            session:[NSURLSession sharedSession]];
        self.loader.delegate = self;
    }
    return self;
}
- (void)webView:(WKWebView *)webView didCommitNavigation:(WKNavigation *)navigation {
    self.committed++;
    [self.loader webView:webView didCommitNavigation:navigation];
}
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    self.finished++;
    [self.loader webView:webView didFinishNavigation:navigation];
}
- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    NSLog(@"[harness] provisional failure: %@", error);
    if (error.code == NSURLErrorCancelled) self.cancellations++;
    if (![self.loader webView:webView didFailProvisionalNavigation:navigation withError:error]) self.hostErrorViews++;
}
- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    NSLog(@"[harness] failure: %@", error);
    if (error.code == NSURLErrorCancelled) self.cancellations++;
    if (![self.loader webView:webView didFailNavigation:navigation withError:error]) self.hostErrorViews++;
}
- (void)offlineShellLoaderDidShowShell:(GLOfflineShellLoader *)loader { self.shellShown++; }
- (void)offlineShellLoader:(GLOfflineShellLoader *)loader didFailLiveLoad:(NSError *)error { self.liveFailure = error; }
@end

#pragma mark - tests

@interface GLOfflineShellTests : XCTestCase
@end

@implementation GLOfflineShellTests {
    GLTestHTTPServer *_server;
    NSString *_token;
    NSString *_shellVersion;
    GLOfflineShellCache *_cache;
    NSURL *_cacheDir;
    NSMutableArray *_keepAlive;
}

- (void)setUp {
    _token = [NSUUID UUID].UUIDString;
    _shellVersion = @"v1";
    _keepAlive = [NSMutableArray array];
    _cacheDir = GLTempDir();
    _cache = [[GLOfflineShellCache alloc] initWithDirectory:_cacheDir];
    _server = [[GLTestHTTPServer alloc] init];
    __weak typeof(self) weakSelf = self;
    _server.handler = ^GLTestHTTPResponse *(NSString *method, NSString *path) {
        GLOfflineShellTests *s = weakSelf;
        if ([path hasPrefix:@"/shell.html"]) return [GLTestHTTPResponse html:GLShellPage(s->_shellVersion)];
        if ([path hasPrefix:@"/ping"]) return [GLTestHTTPResponse status:200 contentType:@"text/plain" body:@"pong"];
        if ([path isEqualToString:@"/"] || [path hasPrefix:@"/?"]) return [GLTestHTTPResponse html:GLLivePage(s->_token)];
        return [GLTestHTTPResponse status:404 contentType:@"text/plain" body:@"nope"];
    };
    NSError *error = nil;
    XCTAssertTrue([_server startOnPort:0 error:&error], @"test server failed to start: %@", error);
}

- (void)tearDown {
    [_server stop];
    [[NSFileManager defaultManager] removeItemAtURL:_cacheDir error:nil];
}

- (NSURL *)liveURL { return [_server URLForPath:@"/?theme=light"]; }

- (GLShellHarness *)newHarness {
    GLShellHarness *h = [[GLShellHarness alloc] initWithCache:_cache];
    [_keepAlive addObject:h];
    return h;
}

/// A live load through the loader, until the page finished and its shell is saved.
- (void)liveLoadAndSaveShell {
    GLShellHarness *h = [self newHarness];
    [h.loader loadLiveRequest:[NSURLRequest requestWithURL:[self liveURL]]];
    XCTAssertTrue(GLWaitFor(15, ^BOOL { return h.finished == 1; }), @"live page never finished loading");
    XCTAssertEqualObjects(GLEvalJS(h.webView, @"localStorage.getItem('probe-key')"), _token,
                          @"the live page did not write its localStorage key");
    XCTAssertTrue(GLWaitFor(15, ^BOOL { return [self->_cache cachedHTMLForPageURL:[self liveURL]] != nil; }),
                  @"no shell saved after a successful live load");
}

#pragma mark premise

// THE PREMISE. Live page writes localStorage; the server is then stopped; the
// saved shell is shown with -loadSimulatedRequest:responseHTMLString: at the SAME
// URL in a different web view. It must see that localStorage, run an inline
// <script type=module>, and a fetch to the dead server must reject promptly.
- (void)testPremise_simulatedRequestAtSameURLSharesLocalStorageWithLivePage {
    // Live load, in its own web view.
    GLShellHarness *live = [self newHarness];
    [live.webView loadRequest:[NSURLRequest requestWithURL:[self liveURL]]];
    XCTAssertTrue(GLWaitFor(15, ^BOOL { return live.finished == 1; }), @"live page never finished loading");
    XCTAssertEqualObjects(GLEvalJS(live.webView, @"localStorage.getItem('probe-key')"), _token,
                          @"the live page did not write its localStorage key");

    // Fetch the shell the way the app does, then kill the server.
    __block NSNumber *refreshResult = nil;
    [_cache refreshShellForPageURL:[self liveURL] session:[NSURLSession sharedSession]
                        completion:^(GLOfflineShellRefreshResult r) { refreshResult = @(r); }];
    XCTAssertTrue(GLWaitFor(15, ^BOOL { return refreshResult != nil; }), @"shell fetch never completed");
    XCTAssertEqual(refreshResult.integerValue, GLOfflineShellRefreshUpdated);
    NSString *html = [_cache cachedHTMLForPageURL:[self liveURL]];
    XCTAssertNotNil(html, @"shell not saved");
    uint16_t port = _server.port;
    [_server stop];

    // Cold-launch stand-in: a brand-new web view, same URL, simulated response.
    GLShellHarness *shell = [self newHarness];
    NSDate *start = [NSDate date];
    [shell.webView loadSimulatedRequest:[NSURLRequest requestWithURL:[self liveURL]] responseHTMLString:html];
    XCTAssertTrue(GLWaitFor(15, ^BOOL { return shell.finished == 1; }), @"simulated page never finished loading");

    NSString *origin = [NSString stringWithFormat:@"http://127.0.0.1:%u", port];
    XCTAssertEqualObjects(GLPollJS(shell.webView, @"window.__origin", origin, 5), origin,
                          @"simulated page did not get the live page's origin");
    XCTAssertEqualObjects(GLEvalJS(shell.webView, @"window.__stored"), _token,
                          @"simulated page at the same URL did NOT see the live page's localStorage: premise is false");
    XCTAssertEqualObjects(GLPollJS(shell.webView, @"window.__moduleRan === true", @YES, 5), @YES,
                          @"inline <script type=module> did not run in the simulated page");
    id fetchState = GLPollJS(shell.webView, @"window.__fetchState", @"rejected", 8);
    NSTimeInterval took = -[start timeIntervalSinceNow];
    XCTAssertEqualObjects(fetchState, @"rejected",
                          @"fetch to the dead server did not reject (state: %@) -- it hangs", fetchState);
    XCTAssertLessThan(took, 10, @"fetch to the dead server took %.1fs to reject", took);

    // Control: the same HTML at a DIFFERENT origin must NOT see the key, else
    // the assertion above would be passing for a reason other than the origin.
    GLShellHarness *other = [self newHarness];
    NSURL *otherURL = [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%u/?theme=light", port + 1]];
    [other.webView loadSimulatedRequest:[NSURLRequest requestWithURL:otherURL] responseHTMLString:html];
    XCTAssertTrue(GLWaitFor(15, ^BOOL { return other.finished == 1; }), @"control page never finished loading");
    NSString *otherOrigin = [NSString stringWithFormat:@"http://127.0.0.1:%u", port + 1];
    XCTAssertEqualObjects(GLPollJS(other.webView, @"window.__origin", otherOrigin, 5), otherOrigin);
    XCTAssertEqualObjects(GLEvalJS(other.webView, @"window.__stored"), [NSNull null],
                          @"a different origin saw the key: localStorage is not origin-scoped, the test proves nothing");
}

#pragma mark fallback

- (void)testProvisionalFailureShowsCachedShellWithLiveLocalStorage {
    [self liveLoadAndSaveShell];
    [_server stop];

    GLShellHarness *cold = [self newHarness];
    [cold.loader loadLiveRequest:[NSURLRequest requestWithURL:[self liveURL]]];
    XCTAssertTrue(GLWaitFor(15, ^BOOL { return cold.shellShown >= 1; }),
                  @"live load failed but the saved shell was never shown (liveFailure: %@, hostErrorViews: %ld)",
                  cold.liveFailure, (long)cold.hostErrorViews);
    XCTAssertNil(cold.liveFailure, @"delegate was told the live load failed despite a saved shell");
    XCTAssertTrue(cold.loader.showingShell);
    XCTAssertFalse(cold.loader.indicatorView.hidden, @"the Offline copy indicator is not showing");
    XCTAssertEqualObjects(GLPollJS(cold.webView, @"window.__stored", _token, 8), _token,
                          @"saved shell did not see the live page's localStorage");
    XCTAssertEqualObjects(GLEvalJS(cold.webView, @"location.href"), [self liveURL].absoluteString,
                          @"saved shell is not at the live page's URL");
    XCTAssertEqualObjects(GLEvalJS(cold.webView, @"window.__moduleRan === true"), @YES);
    XCTAssertEqual(cold.hostErrorViews, 0, @"the host would have shown its error view");
}

- (void)testNoResponseWithinDeadlineShowsCachedShell {
    [self liveLoadAndSaveShell];
    __weak typeof(self) weakSelf = self;
    // Server is up but never answers the page itself.
    _server.handler = ^GLTestHTTPResponse *(NSString *method, NSString *path) {
        GLOfflineShellTests *s = weakSelf;
        if ([path hasPrefix:@"/shell.html"]) return [GLTestHTTPResponse html:GLShellPage(s->_shellVersion)];
        return nil;
    };
    GLShellHarness *cold = [self newHarness];
    cold.loader.deadline = 1;
    NSDate *start = [NSDate date];
    [cold.loader loadLiveRequest:[NSURLRequest requestWithURL:[self liveURL]]];
    XCTAssertTrue(GLWaitFor(10, ^BOOL { return cold.shellShown >= 1; }),
                  @"server never answered and the saved shell was not shown after the deadline");
    NSTimeInterval took = -[start timeIntervalSinceNow];
    XCTAssertGreaterThanOrEqual(took, 0.9, @"the shell appeared after %.2fs, before the deadline", took);
    XCTAssertLessThan(took, 6, @"the shell took %.1fs, the deadline did not fire", took);
    XCTAssertTrue([_server.requestedPaths containsObject:@"/?theme=light"], @"the live load never started: %@", _server.requestedPaths);
    XCTAssertEqualObjects(GLPollJS(cold.webView, @"window.__stored", _token, 8), _token);
    GLSpin(1.5);  // the cancelled live load's failure must not reach the host's error view
    XCTAssertEqual(cold.hostErrorViews, 0, @"cancelling the live load surfaced an error view");
    XCTAssertEqual(cold.shellShown, 1);
    XCTAssertTrue(cold.loader.showingShell);
}

- (void)testSlowButAnsweringServerKeepsLivePage {
    [self liveLoadAndSaveShell];
    GLShellHarness *cold = [self newHarness];
    cold.loader.deadline = 30;
    [cold.loader loadLiveRequest:[NSURLRequest requestWithURL:[self liveURL]]];
    XCTAssertTrue(GLWaitFor(15, ^BOOL { return cold.finished == 1; }));
    XCTAssertEqual(cold.shellShown, 0);
    XCTAssertFalse(cold.loader.showingShell);
    XCTAssertTrue(cold.loader.indicatorView.hidden);
    XCTAssertEqualObjects(GLEvalJS(cold.webView, @"document.body.innerText.indexOf('live page') >= 0"), @YES);
}

- (void)testNoCachedShellKeepsTheErrorView {
    [_server stop];
    GLShellHarness *cold = [self newHarness];
    [cold.loader loadLiveRequest:[NSURLRequest requestWithURL:[self liveURL]]];
    XCTAssertTrue(GLWaitFor(15, ^BOOL { return cold.liveFailure != nil; }),
                  @"no cached shell and the live load failed, but the delegate was never told");
    NSLog(@"[test] live failure with no cache: %@", cold.liveFailure);
    XCTAssertEqual(cold.shellShown, 0);
    XCTAssertFalse(cold.loader.showingShell);
    XCTAssertTrue(cold.loader.indicatorView.hidden);
    XCTAssertEqual(cold.hostErrorViews, 0, @"the loader must own the failure and report it via the delegate");
}

- (void)testNoCachedShellAndNoResponseKeepsWaitingForLive {
    // Hanging server, nothing saved: the deadline must not do anything.
    _server.handler = ^GLTestHTTPResponse *(NSString *method, NSString *path) { return nil; };
    GLShellHarness *cold = [self newHarness];
    cold.loader.deadline = 0.5;
    [cold.loader loadLiveRequest:[NSURLRequest requestWithURL:[self liveURL]]];
    GLSpin(2);
    XCTAssertEqual(cold.shellShown, 0);
    XCTAssertNil(cold.liveFailure);
    XCTAssertEqual(cold.hostErrorViews, 0);
}

#pragma mark shell cache

- (void)testShellIsRefreshedAfterEveryLiveLoad {
    [self liveLoadAndSaveShell];
    NSURL *url = [self liveURL];
    XCTAssertEqualObjects([_cache cachedHTMLForPageURL:url], GLShellPage(@"v1"));
    NSDate *fetchedAt = [_cache fetchedAtForPageURL:url];
    XCTAssertNotNil(fetchedAt, @"no sidecar fetchedAt");
    XCTAssertLessThan(-[fetchedAt timeIntervalSinceNow], 60);
    NSData *sidecar = [NSData dataWithContentsOfURL:[_cacheDir URLByAppendingPathComponent:
        [[GLOfflineShellCache cacheKeyForPageURL:url] stringByAppendingString:@".json"]]];
    NSDictionary *json = [NSJSONSerialization JSONObjectWithData:sidecar options:0 error:nil];
    XCTAssertEqualObjects(json[@"url"], [_server URLForPath:@"/shell.html"].absoluteString);

    _shellVersion = @"v2";
    GLShellHarness *second = [self newHarness];
    [second.loader loadLiveRequest:[NSURLRequest requestWithURL:url]];
    XCTAssertTrue(GLWaitFor(15, ^BOOL { return [[self->_cache cachedHTMLForPageURL:url] isEqual:GLShellPage(@"v2")]; }),
                  @"a second live load did not refresh the saved shell (still: %@)", [_cache cachedHTMLForPageURL:url]);
}

- (void)testShell404KeepsOldCopyAndDoesNotCrash {
    NSURL *url = [self liveURL];
    // No copy yet and the app has no shell: nothing saved, no crash.
    __block NSNumber *result = nil;
    _server.handler = ^GLTestHTTPResponse *(NSString *m, NSString *p) { return [GLTestHTTPResponse status:404 contentType:@"text/html" body:@"<h1>404</h1>"]; };
    [_cache refreshShellForPageURL:url session:[NSURLSession sharedSession] completion:^(GLOfflineShellRefreshResult r) { result = @(r); }];
    XCTAssertTrue(GLWaitFor(15, ^BOOL { return result != nil; }));
    XCTAssertEqual(result.integerValue, GLOfflineShellRefreshUnavailable);
    XCTAssertNil([_cache cachedHTMLForPageURL:url], @"a 404 page was saved as the shell");

    // With an old copy: kept, through a 404, a wrong content type and a dead server.
    NSError *error = nil;
    XCTAssertTrue([_cache storeShellData:[GLShellPage(@"old") dataUsingEncoding:NSUTF8StringEncoding] forPageURL:url error:&error], @"%@", error);
    NSDate *savedAt = [_cache fetchedAtForPageURL:url];
    NSArray<GLTestHTTPResponse *> *bad = @[
        [GLTestHTTPResponse status:404 contentType:@"text/html" body:@"<h1>404</h1>"],
        [GLTestHTTPResponse status:200 contentType:@"text/plain" body:@"not html"],
        [GLTestHTTPResponse status:500 contentType:@"text/html" body:@"<h1>boom</h1>"],
    ];
    for (GLTestHTTPResponse *response in bad) {
        result = nil;
        _server.handler = ^GLTestHTTPResponse *(NSString *m, NSString *p) { return response; };
        [_cache refreshShellForPageURL:url session:[NSURLSession sharedSession] completion:^(GLOfflineShellRefreshResult r) { result = @(r); }];
        XCTAssertTrue(GLWaitFor(15, ^BOOL { return result != nil; }));
        XCTAssertEqual(result.integerValue, GLOfflineShellRefreshUnavailable, @"status %ld type %@", (long)response.status, response.contentType);
        XCTAssertEqualObjects([_cache cachedHTMLForPageURL:url], GLShellPage(@"old"), @"old copy was overwritten by status %ld", (long)response.status);
        XCTAssertEqualObjects([_cache fetchedAtForPageURL:url], savedAt);
    }
    result = nil;
    [_server stop];
    [_cache refreshShellForPageURL:url session:[NSURLSession sharedSession] completion:^(GLOfflineShellRefreshResult r) { result = @(r); }];
    XCTAssertTrue(GLWaitFor(15, ^BOOL { return result != nil; }));
    XCTAssertEqual(result.integerValue, GLOfflineShellRefreshUnreachable);
    XCTAssertEqualObjects([_cache cachedHTMLForPageURL:url], GLShellPage(@"old"));
}

- (void)testCacheKeyIgnoresQueryAndSeparatesApps {
    NSURL *light = [NSURL URLWithString:@"http://100.1.2.3:8312/?theme=light"];
    NSURL *dark = [NSURL URLWithString:@"http://100.1.2.3:8312/?theme=dark&demo=1"];
    XCTAssertEqualObjects([GLOfflineShellCache cacheKeyForPageURL:light], [GLOfflineShellCache cacheKeyForPageURL:dark]);
    XCTAssertNotEqualObjects([GLOfflineShellCache cacheKeyForPageURL:light],
                             [GLOfflineShellCache cacheKeyForPageURL:[NSURL URLWithString:@"http://100.1.2.3:8313/"]]);
    XCTAssertNotEqualObjects([GLOfflineShellCache cacheKeyForPageURL:light],
                             [GLOfflineShellCache cacheKeyForPageURL:[NSURL URLWithString:@"https://100.1.2.3:8312/"]]);
    XCTAssertEqualObjects([GLOfflineShellCache shellURLForPageURL:dark].absoluteString, @"http://100.1.2.3:8312/shell.html");
}

#pragma mark leaving the shell

- (void)testRefreshWhileStillOfflineKeepsTheShellPageAndItsState {
    [self liveLoadAndSaveShell];
    [_server stop];
    GLShellHarness *cold = [self newHarness];
    [cold.loader loadLiveRequest:[NSURLRequest requestWithURL:[self liveURL]]];
    XCTAssertTrue(GLWaitFor(15, ^BOOL { return cold.shellShown == 1; }));
    XCTAssertEqualObjects(GLPollJS(cold.webView, @"window.__moduleRan === true", @YES, 8), @YES);
    GLEvalJS(cold.webView, @"window.__typed = 'half-written todo'; true");

    [cold.loader loadLiveRequest:[NSURLRequest requestWithURL:[self liveURL]]];  // the Refresh control
    XCTAssertTrue(GLWaitFor(15, ^BOOL { return cold.shellShown == 2; }),
                  @"a refresh that failed while on the shell did not report back to the host");
    GLSpin(1);
    XCTAssertEqualObjects(GLEvalJS(cold.webView, @"window.__typed"), @"half-written todo",
                          @"a failed refresh reloaded the shell and lost the page's state");
    XCTAssertNil(cold.liveFailure);
    XCTAssertEqual(cold.hostErrorViews, 0);
    XCTAssertTrue(cold.loader.showingShell);
}

- (void)testForegroundSwapsToLiveOnlyAfterTheMinimumTimeAndWhenReachable {
    [self liveLoadAndSaveShell];
    uint16_t port = _server.port;
    [_server stop];
    GLShellHarness *cold = [self newHarness];
    [cold.loader loadLiveRequest:[NSURLRequest requestWithURL:[self liveURL]]];
    XCTAssertTrue(GLWaitFor(15, ^BOOL { return cold.shellShown == 1; }));

    // Shell up less than the minimum: nothing happens.
    cold.loader.minShellSecondsBeforeAutoSwap = 3600;
    [cold.loader swapToLiveIfReachable];
    GLSpin(1);
    XCTAssertTrue(cold.loader.showingShell);

    // Long enough but the server is still down: stays on the shell.
    cold.loader.minShellSecondsBeforeAutoSwap = 0;
    [cold.loader swapToLiveIfReachable];
    GLSpin(1.5);
    XCTAssertTrue(cold.loader.showingShell, @"swapped to live with the server unreachable");
    XCTAssertEqual(cold.hostErrorViews, 0);

    // Server back, but still inside the minimum: no request reaches it.
    NSError *error = nil;
    XCTAssertTrue([_server startOnPort:port error:&error], @"could not bring the server back: %@", error);
    NSUInteger before = _server.requestedPaths.count;
    cold.loader.minShellSecondsBeforeAutoSwap = 3600;
    [cold.loader swapToLiveIfReachable];
    GLSpin(1);
    XCTAssertEqual(_server.requestedPaths.count, before, @"a swap was attempted before the minimum time: %@", _server.requestedPaths);
    XCTAssertTrue(cold.loader.showingShell);

    // Long enough and reachable: goes live, indicator gone.
    cold.loader.minShellSecondsBeforeAutoSwap = 0;
    [cold.loader swapToLiveIfReachable];
    XCTAssertTrue(GLWaitFor(15, ^BOOL { return !cold.loader.showingShell; }), @"never swapped to the live page");
    XCTAssertTrue(cold.loader.indicatorView.hidden);
    XCTAssertEqualObjects(GLPollJS(cold.webView, @"document.body.innerText.indexOf('live page') >= 0", @YES, 15), @YES,
                          @"after the swap the web view is not showing the live page");
}

#pragma mark cache-first (prefersSavedShell)

- (void)saveShellVersion:(NSString *)version {
    NSError *error = nil;
    XCTAssertTrue([_cache storeShellData:[GLShellPage(version) dataUsingEncoding:NSUTF8StringEncoding]
                              forPageURL:[self liveURL] error:&error], @"%@", error);
}

- (BOOL)isLiveRequestPath:(NSString *)path {
    return [path isEqualToString:@"/"] || [path hasPrefix:@"/?"];
}

// (a) The saved shell is on screen well before a slow server answers, with no
// pill and no live navigation; the background refresh then updates the cache.
- (void)testCacheFirstShowsSavedShellImmediatelyWhileServerIsSlow {
    [self saveShellVersion:@"v1"];
    _shellVersion = @"v2";
    __weak typeof(self) weakSelf = self;
    _server.handler = ^GLTestHTTPResponse *(NSString *method, NSString *path) {
        GLOfflineShellTests *s = weakSelf;
        [NSThread sleepForTimeInterval:3];
        if ([path hasPrefix:@"/shell.html"]) return [GLTestHTTPResponse html:GLShellPage(s->_shellVersion)];
        return [GLTestHTTPResponse html:GLLivePage(s->_token)];
    };
    GLShellHarness *cold = [self newHarness];
    cold.loader.prefersSavedShell = YES;
    NSDate *start = [NSDate date];
    [cold.loader loadPreferringSavedShell:[NSURLRequest requestWithURL:[self liveURL]]];
    XCTAssertEqualObjects(GLPollJS(cold.webView, @"document.body.innerText.indexOf('shell v1') >= 0", @YES, 1.5), @YES,
                          @"the saved shell was not on screen within 1.5s");
    XCTAssertLessThan(-[start timeIntervalSinceNow], 1.5);
    XCTAssertTrue(cold.loader.showingShell);
    XCTAssertTrue(cold.loader.indicatorView.hidden, @"cache-first shell must not show the Offline copy pill");
    XCTAssertEqual(cold.shellShown, 1);
    XCTAssertFalse([_server.requestedPaths containsObject:@"/?theme=light"], @"a live navigation was started: %@", _server.requestedPaths);
    XCTAssertTrue(GLWaitFor(15, ^BOOL { return [[self->_cache cachedHTMLForPageURL:[self liveURL]] isEqual:GLShellPage(@"v2")]; }),
                  @"background refresh did not update the saved shell");
    XCTAssertTrue(cold.loader.indicatorView.hidden);
    XCTAssertEqual(cold.hostErrorViews, 0);
}

// (b) Server unreachable: shell shown at once, pill appears once the background refresh fails.
- (void)testCacheFirstWithUnreachableServerShowsShellAndPill {
    [self saveShellVersion:@"v1"];
    [_server stop];
    GLShellHarness *cold = [self newHarness];
    cold.loader.prefersSavedShell = YES;
    [cold.loader loadPreferringSavedShell:[NSURLRequest requestWithURL:[self liveURL]]];
    XCTAssertEqual(cold.shellShown, 1, @"shell not reported synchronously");
    XCTAssertTrue(cold.loader.showingShell);
    XCTAssertEqualObjects(GLPollJS(cold.webView, @"document.body.innerText.indexOf('shell v1') >= 0", @YES, 5), @YES);
    XCTAssertTrue(GLWaitFor(15, ^BOOL { return !cold.loader.indicatorView.hidden; }),
                  @"unreachable background refresh did not show the Offline copy pill");
    XCTAssertEqual(cold.hostErrorViews, 0);
    XCTAssertNil(cold.liveFailure);
}

// (b2) Launched while unreachable, then the server comes back with the app still in front: the pill clears on its own
// recheck, with no foreground, and the page is never live-loaded.
- (void)testCacheFirstPillClearsWhenServerReturnsWithoutForeground {
    [self saveShellVersion:@"v1"];
    uint16_t port = _server.port;
    [_server stop];
    GLShellHarness *cold = [self newHarness];
    cold.loader.prefersSavedShell = YES;
    cold.loader.offlineRecheckSeconds = 1;
    [cold.loader loadPreferringSavedShell:[NSURLRequest requestWithURL:[self liveURL]]];
    XCTAssertTrue(GLWaitFor(15, ^BOOL { return !cold.loader.indicatorView.hidden; }), @"pill never appeared");
    GLSpin(2.5);  // at least one recheck against the still-stopped server
    XCTAssertFalse(cold.loader.indicatorView.hidden, @"pill cleared while the server was still down");

    NSError *error = nil;
    XCTAssertTrue([_server startOnPort:port error:&error], @"could not bring the server back: %@", error);
    XCTAssertTrue(GLWaitFor(15, ^BOOL { return cold.loader.indicatorView.hidden; }),
                  @"Offline copy pill stayed up after the server came back");
    XCTAssertTrue(cold.loader.showingShell);
    for (NSString *path in _server.requestedPaths) {
        XCTAssertFalse([self isLiveRequestPath:path], @"recheck did a live load: %@", _server.requestedPaths);
    }
}

// (b3) A foreground soon after launch (inside the 60 s minimum, which only guards live reloads) still clears the pill.
- (void)testCacheFirstForegroundClearsPillInsideMinimumTime {
    [self saveShellVersion:@"v1"];
    uint16_t port = _server.port;
    [_server stop];
    GLShellHarness *cold = [self newHarness];
    cold.loader.prefersSavedShell = YES;
    cold.loader.offlineRecheckSeconds = 3600;
    [cold.loader loadPreferringSavedShell:[NSURLRequest requestWithURL:[self liveURL]]];
    XCTAssertTrue(GLWaitFor(15, ^BOOL { return !cold.loader.indicatorView.hidden; }), @"pill never appeared");

    NSError *error = nil;
    XCTAssertTrue([_server startOnPort:port error:&error], @"could not bring the server back: %@", error);
    cold.loader.minShellSecondsBeforeAutoSwap = 3600;
    [cold.loader swapToLiveIfReachable];
    XCTAssertTrue(GLWaitFor(15, ^BOOL { return cold.loader.indicatorView.hidden; }),
                  @"foreground inside the minimum time left the pill up");
}

// (c) Nothing saved: today's live path.
- (void)testCacheFirstWithoutSavedShellLoadsLivePage {
    GLShellHarness *cold = [self newHarness];
    cold.loader.prefersSavedShell = YES;
    [cold.loader loadPreferringSavedShell:[NSURLRequest requestWithURL:[self liveURL]]];
    XCTAssertTrue(GLWaitFor(15, ^BOOL { return cold.finished == 1; }));
    XCTAssertFalse(cold.loader.showingShell);
    XCTAssertEqual(cold.shellShown, 0);
    XCTAssertEqualObjects(GLEvalJS(cold.webView, @"document.body.innerText.indexOf('live page') >= 0"), @YES);
    XCTAssertTrue(GLWaitFor(15, ^BOOL { return [self->_cache cachedHTMLForPageURL:[self liveURL]] != nil; }),
                  @"live load did not save a shell");
}

// (d) Not opted in: a saved shell is ignored and the live page loads, as before.
- (void)testDefaultLoaderIgnoresSavedShellOnFirstLoad {
    [self saveShellVersion:@"v1"];
    GLShellHarness *cold = [self newHarness];
    XCTAssertFalse(cold.loader.prefersSavedShell);
    [cold.loader loadPreferringSavedShell:[NSURLRequest requestWithURL:[self liveURL]]];
    XCTAssertTrue(GLWaitFor(15, ^BOOL { return cold.finished == 1; }));
    XCTAssertFalse(cold.loader.showingShell);
    XCTAssertEqual(cold.shellShown, 0);
    XCTAssertEqualObjects(GLEvalJS(cold.webView, @"document.body.innerText.indexOf('live page') >= 0"), @YES);
}

// (e) Foreground on a cache-first shell: refresh in the background and reload
// the new saved copy; never a live load of the page.
- (void)testCacheFirstForegroundReloadsChangedShellWithoutLiveLoad {
    [self saveShellVersion:@"v1"];
    GLShellHarness *cold = [self newHarness];
    cold.loader.prefersSavedShell = YES;
    [cold.loader loadPreferringSavedShell:[NSURLRequest requestWithURL:[self liveURL]]];
    XCTAssertEqualObjects(GLPollJS(cold.webView, @"document.body.innerText.indexOf('shell v1') >= 0", @YES, 15), @YES);
    XCTAssertTrue(GLWaitFor(15, ^BOOL { return self->_server.requestedPaths.count >= 1; }));
    GLSpin(1);  // let the launch-time background refresh finish

    // Unchanged server shell: nothing reloads.
    cold.loader.minShellSecondsBeforeAutoSwap = 0;
    NSInteger finishedBefore = cold.finished;
    [cold.loader swapToLiveIfReachable];
    GLSpin(1.5);
    XCTAssertEqual(cold.finished, finishedBefore, @"an unchanged shell was reloaded");

    _shellVersion = @"v2";
    [cold.loader swapToLiveIfReachable];
    XCTAssertEqualObjects(GLPollJS(cold.webView, @"document.body.innerText.indexOf('shell v2') >= 0", @YES, 15), @YES,
                          @"the changed shell was not shown after foreground");
    XCTAssertTrue(cold.loader.showingShell);
    for (NSString *path in _server.requestedPaths) {
        XCTAssertFalse([self isLiveRequestPath:path], @"foreground did a live load: %@", _server.requestedPaths);
    }
}

// A navigation the loader did not start is still waiting on the server when a changed shell replaces it. It must report
// -999, and that must stay away from the host's error view.
- (void)testReplacedInFlightNavigationShowsNoError {
    [self saveShellVersion:@"v1"];
    __weak typeof(self) weakSelf = self;
    _server.handler = ^GLTestHTTPResponse *(NSString *method, NSString *path) {
        GLOfflineShellTests *s = weakSelf;
        if ([path hasPrefix:@"/slow"]) [NSThread sleepForTimeInterval:8];
        if ([path hasPrefix:@"/shell.html"]) return [GLTestHTTPResponse html:GLShellPage(s->_shellVersion)];
        return [GLTestHTTPResponse status:200 contentType:@"text/plain" body:@"ok"];
    };
    GLShellHarness *cold = [self newHarness];
    cold.loader.prefersSavedShell = YES;
    [cold.loader loadPreferringSavedShell:[NSURLRequest requestWithURL:[self liveURL]]];
    XCTAssertEqualObjects(GLPollJS(cold.webView, @"document.body.innerText.indexOf('shell v1') >= 0", @YES, 15), @YES);
    GLSpin(1);  // let the launch-time background refresh finish

    _shellVersion = @"v2";
    GLEvalJS(cold.webView, @"location.href = '/slow'; 1");
    XCTAssertTrue(GLWaitFor(5, ^BOOL { return [self->_server.requestedPaths containsObject:@"/slow"]; }),
                  @"the page's navigation never reached the server: %@", _server.requestedPaths);
    [cold.loader swapToLiveIfReachable];
    XCTAssertEqualObjects(GLPollJS(cold.webView, @"document.body.innerText.indexOf('shell v2') >= 0", @YES, 15), @YES);
    GLSpin(1);
    XCTAssertGreaterThanOrEqual(cold.cancellations, 1, @"nothing was cancelled, so this test proved nothing");
    XCTAssertEqual(cold.hostErrorViews, 0, @"a replaced navigation reached the host's error view");
    XCTAssertNil(cold.liveFailure);
}

// The contract both hosts rely on, for navigations the loader did not start too (a nil navigation, a history move);
// a real failure still reaches the host.
- (void)testCancellationIsConsumedAndARealFailureIsNot {
    GLShellHarness *h = [self newHarness];
    NSError *cancelled = [NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorCancelled userInfo:nil];
    NSError *lost = [NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorNetworkConnectionLost userInfo:nil];
    XCTAssertTrue([h.loader webView:h.webView didFailNavigation:nil withError:cancelled]);
    XCTAssertTrue([h.loader webView:h.webView didFailProvisionalNavigation:nil withError:cancelled]);
    XCTAssertFalse([h.loader webView:h.webView didFailNavigation:nil withError:lost]);
    XCTAssertFalse([h.loader webView:h.webView didFailProvisionalNavigation:nil withError:lost]);
    XCTAssertNil(h.liveFailure);
}

#pragma mark probe (asserts nothing; logs real framework behaviour for the next round)

- (void)testProbe_logFrameworkBehaviour {
    NSLog(@"[probe] iOS %@", UIDevice.currentDevice.systemVersion);
    NSURL *url = [self liveURL];
    // 1. error for a refused connection
    uint16_t port = _server.port;
    [_server stop];
    GLShellHarness *refused = [self newHarness];
    [refused.webView loadRequest:[NSURLRequest requestWithURL:url]];
    GLSpin(3);
    // 2. what a cancelled pending load reports, and what a simulated page sees
    NSError *error = nil;
    [_server startOnPort:port error:&error];
    _server.handler = ^GLTestHTTPResponse *(NSString *m, NSString *p) { return nil; };
    GLShellHarness *hang = [self newHarness];
    [hang.webView loadRequest:[NSURLRequest requestWithURL:url]];
    GLSpin(1);
    [hang.webView stopLoading];
    GLSpin(2);
    NSLog(@"[probe] after stopLoading on a hung load: finished=%ld committed=%ld", (long)hang.finished, (long)hang.committed);
    [hang.webView loadSimulatedRequest:[NSURLRequest requestWithURL:url] responseHTMLString:GLShellPage(@"probe")];
    GLSpin(2);
    NSLog(@"[probe] simulated: href=%@ origin=%@ title=%@ fetch=%@ module=%@ finished=%ld",
          GLEvalJS(hang.webView, @"location.href"), GLEvalJS(hang.webView, @"window.__origin"),
          GLEvalJS(hang.webView, @"document.title"), GLEvalJS(hang.webView, @"window.__fetchState"),
          GLEvalJS(hang.webView, @"window.__moduleRan"), (long)hang.finished);
}

@end
