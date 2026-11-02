#import "GLOfflineShell.h"

#import <CommonCrypto/CommonDigest.h>

#import "GLLog.h"

#pragma mark - GLOfflineShellCache

@implementation GLOfflineShellCache {
    NSURL *_directory;
}

+ (instancetype)sharedCache {
    static GLOfflineShellCache *shared;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSError *error = nil;
        NSURL *support = [[NSFileManager defaultManager] URLForDirectory:NSApplicationSupportDirectory
                                                                inDomain:NSUserDomainMask
                                                       appropriateForURL:nil
                                                                  create:YES
                                                                   error:&error];
        if (!support) [NSException raise:NSInternalInconsistencyException
                                  format:@"no Application Support directory: %@", error];
        shared = [[self alloc] initWithDirectory:[support URLByAppendingPathComponent:@"ShellCache" isDirectory:YES]];
    });
    return shared;
}

- (instancetype)initWithDirectory:(NSURL *)directory {
    self = [super init];
    if (self) {
        _directory = directory;
        NSError *error = nil;
        if (![[NSFileManager defaultManager] createDirectoryAtURL:directory
                                      withIntermediateDirectories:YES
                                                       attributes:nil
                                                            error:&error]) {
            [NSException raise:NSInternalInconsistencyException
                        format:@"cannot create shell cache directory %@: %@", directory, error];
        }
    }
    return self;
}

+ (NSURL *)shellURLForPageURL:(NSURL *)pageURL {
    return [NSURL URLWithString:@"shell.html" relativeToURL:pageURL].absoluteURL;
}

+ (NSString *)cacheKeyForPageURL:(NSURL *)pageURL {
    NSURLComponents *c = [NSURLComponents componentsWithURL:pageURL resolvingAgainstBaseURL:NO];
    NSString *scheme = c.scheme.lowercaseString;
    NSInteger port = c.port ? c.port.integerValue : ([scheme isEqualToString:@"https"] ? 443 : 80);
    NSString *identity = [NSString stringWithFormat:@"%@://%@:%ld%@", scheme, c.host.lowercaseString,
                                                    (long)port, c.path.length ? c.path : @"/"];
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    NSData *bytes = [identity dataUsingEncoding:NSUTF8StringEncoding];
    CC_SHA256(bytes.bytes, (CC_LONG)bytes.length, digest);
    NSMutableString *hex = [NSMutableString string];
    for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) [hex appendFormat:@"%02x", digest[i]];
    return hex;
}

- (NSURL *)htmlFileForPageURL:(NSURL *)pageURL {
    return [_directory URLByAppendingPathComponent:[[GLOfflineShellCache cacheKeyForPageURL:pageURL]
                                                       stringByAppendingString:@".html"]];
}

- (NSURL *)sidecarFileForPageURL:(NSURL *)pageURL {
    return [_directory URLByAppendingPathComponent:[[GLOfflineShellCache cacheKeyForPageURL:pageURL]
                                                       stringByAppendingString:@".json"]];
}

- (NSString *)cachedHTMLForPageURL:(NSURL *)pageURL {
    @synchronized(self) {
        NSData *data = [NSData dataWithContentsOfURL:[self htmlFileForPageURL:pageURL]];
        if (!data) return nil;
        NSString *html = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
        if (!html) GLLog(@"saved shell for %@ is not valid UTF-8, ignoring it", pageURL);
        return html;
    }
}

- (NSDate *)fetchedAtForPageURL:(NSURL *)pageURL {
    @synchronized(self) {
        NSData *data = [NSData dataWithContentsOfURL:[self sidecarFileForPageURL:pageURL]];
        if (!data) return nil;
        NSDictionary *sidecar = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        NSString *stamp = [sidecar isKindOfClass:[NSDictionary class]] ? sidecar[@"fetchedAt"] : nil;
        if (![stamp isKindOfClass:[NSString class]]) return nil;
        return [[[NSISO8601DateFormatter alloc] init] dateFromString:stamp];
    }
}

- (BOOL)storeShellData:(NSData *)data forPageURL:(NSURL *)pageURL error:(NSError **)error {
    if (![[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]) {
        if (error) *error = [NSError errorWithDomain:@"GLOfflineShell" code:1
                                            userInfo:@{NSLocalizedDescriptionKey: @"shell is not valid UTF-8"}];
        return NO;
    }
    NSDictionary *sidecar = @{
        @"fetchedAt": [[[NSISO8601DateFormatter alloc] init] stringFromDate:[NSDate date]],
        @"url": [GLOfflineShellCache shellURLForPageURL:pageURL].absoluteString,
    };
    NSData *sidecarData = [NSJSONSerialization dataWithJSONObject:sidecar options:0 error:error];
    if (!sidecarData) return NO;
    @synchronized(self) {
        return [data writeToURL:[self htmlFileForPageURL:pageURL] options:NSDataWritingAtomic error:error]
            && [sidecarData writeToURL:[self sidecarFileForPageURL:pageURL] options:NSDataWritingAtomic error:error];
    }
}

- (void)refreshShellForPageURL:(NSURL *)pageURL
                       session:(NSURLSession *)session
                    completion:(void (^)(GLOfflineShellRefreshResult))completion {
    NSURL *shellURL = [GLOfflineShellCache shellURLForPageURL:pageURL];
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:shellURL
                                                           cachePolicy:NSURLRequestReloadIgnoringLocalCacheData
                                                       timeoutInterval:10];
    NSURLSessionDataTask *task = [session dataTaskWithRequest:request
                                            completionHandler:^(NSData *_Nullable data, NSURLResponse *_Nullable response, NSError *_Nullable error) {
        GLOfflineShellRefreshResult result;
        if (error) {
            GLLog(@"shell fetch %@ failed: %@", shellURL, error);
            result = GLOfflineShellRefreshUnreachable;
        } else {
            NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
            NSString *type = [http.MIMEType lowercaseString];
            if (http.statusCode == 200 && [type isEqualToString:@"text/html"] && data.length > 0) {
                NSError *storeError = nil;
                if ([self storeShellData:data forPageURL:pageURL error:&storeError]) {
                    result = GLOfflineShellRefreshUpdated;
                } else {
                    GLLog(@"shell from %@ not saved: %@", shellURL, storeError);
                    result = GLOfflineShellRefreshUnavailable;
                }
            } else {
                // 404 means that app has no shell yet: keep whatever copy we have.
                GLLog(@"shell %@ unusable (status %ld, type %@), keeping any old copy",
                      shellURL, (long)http.statusCode, http.MIMEType);
                result = GLOfflineShellRefreshUnavailable;
            }
        }
        dispatch_async(dispatch_get_main_queue(), ^{ completion(result); });
    }];
    [task resume];
}

@end

#pragma mark - GLOfflineShellLoader

@implementation GLOfflineShellLoader {
    WKWebView *_webView;
    GLOfflineShellCache *_cache;
    NSURLSession *_session;
    NSURLRequest *_request;
    // The navigation started by the latest -loadLiveRequest:, nil once it has
    // finished or failed.
    WKNavigation *_liveNavigation;
    WKNavigation *_shellNavigation;
    // Navigations we cancelled or replaced ourselves; their failure callbacks
    // belong to us, not to the host's error view.
    NSHashTable<WKNavigation *> *_superseded;
    NSUInteger _attempt;
    BOOL _liveCommitted;     // the current attempt got a response
    BOOL _hasCommittedLive;  // any live page has ever been shown by this loader
    NSDate *_shellShownAt;
    BOOL _probing;
    BOOL _cacheFirstShell;     // the shell on screen was chosen up front, not as an offline fallback
    NSString *_shownShellHTML; // what the shell on screen was loaded from
    BOOL _recheckPending;      // a -showPillAndScheduleRecheck timer is armed
}

- (instancetype)initWithWebView:(WKWebView *)webView
                       hostView:(UIView *)hostView
                          cache:(GLOfflineShellCache *)cache
                        session:(NSURLSession *)session {
    self = [super init];
    if (self) {
        _webView = webView;
        _cache = cache;
        _session = session;
        _deadline = 4;
        _minShellSecondsBeforeAutoSwap = 60;
        _offlineRecheckSeconds = 15;
        _superseded = [NSHashTable weakObjectsHashTable];
        [self buildIndicatorInHostView:hostView];
    }
    return self;
}

- (void)buildIndicatorInHostView:(UIView *)hostView {
    UIView *pill = [[UIView alloc] init];
    pill.userInteractionEnabled = NO;  // never steals a tap from the page
    pill.hidden = YES;
    pill.backgroundColor = [[UIColor secondarySystemBackgroundColor] colorWithAlphaComponent:0.92];
    pill.layer.cornerRadius = 9;
    pill.translatesAutoresizingMaskIntoConstraints = NO;
    UILabel *label = [[UILabel alloc] init];
    label.text = @"Offline copy";
    label.font = [UIFont systemFontOfSize:11 weight:UIFontWeightMedium];
    label.textColor = [UIColor secondaryLabelColor];
    label.translatesAutoresizingMaskIntoConstraints = NO;
    [pill addSubview:label];
    [hostView addSubview:pill];
    UILayoutGuide *safe = hostView.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
        [label.topAnchor constraintEqualToAnchor:pill.topAnchor constant:3],
        [label.bottomAnchor constraintEqualToAnchor:pill.bottomAnchor constant:-3],
        [label.leadingAnchor constraintEqualToAnchor:pill.leadingAnchor constant:8],
        [label.trailingAnchor constraintEqualToAnchor:pill.trailingAnchor constant:-8],
        [pill.topAnchor constraintEqualToAnchor:safe.topAnchor constant:4],
        [pill.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-8],
    ]];
    _indicatorView = pill;
}

- (BOOL)showingShell {
    return _shellShownAt != nil;
}

+ (BOOL)isNetworkClassError:(NSError *)error {
    if (![error.domain isEqualToString:NSURLErrorDomain]) return NO;
    switch (error.code) {
        case NSURLErrorNotConnectedToInternet:
        case NSURLErrorTimedOut:
        case NSURLErrorCannotConnectToHost:
        case NSURLErrorCannotFindHost:
        case NSURLErrorNetworkConnectionLost:
        case NSURLErrorDNSLookupFailed:
        case NSURLErrorDataNotAllowed:
        case NSURLErrorInternationalRoamingOff:
        case NSURLErrorCallIsActive:
            return YES;
        default:
            return NO;
    }
}

+ (BOOL)isCancellation:(NSError *)error {
    return [error.domain isEqualToString:NSURLErrorDomain] && error.code == NSURLErrorCancelled;
}

#pragma mark Loading

- (void)loadLiveRequest:(NSURLRequest *)request {
    _request = [request copy];
    _attempt++;
    NSUInteger attempt = _attempt;
    if (_liveNavigation) [_superseded addObject:_liveNavigation];
    _liveCommitted = NO;
    _liveNavigation = [_webView loadRequest:_request];
    __weak typeof(self) weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(self.deadline * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
        [weakSelf deadlineElapsedForAttempt:attempt];
    });
}

- (void)loadPreferringSavedShell:(NSURLRequest *)request {
    NSString *html = self.prefersSavedShell && !_hasCommittedLive ? [_cache cachedHTMLForPageURL:request.URL] : nil;
    if (!html) {
        [self loadLiveRequest:request];
        return;
    }
    _request = [request copy];
    _attempt++;  // invalidates any pending deadline from an earlier live load
    if (_liveNavigation) [_superseded addObject:_liveNavigation];
    _liveNavigation = nil;
    _cacheFirstShell = YES;
    _shownShellHTML = html;
    _shellNavigation = [_webView loadSimulatedRequest:_request responseHTMLString:html];
    _shellShownAt = [NSDate date];
    [self.delegate offlineShellLoaderDidShowShell:self];
    NSURL *pageURL = _request.URL;
    __weak typeof(self) weakSelf = self;
    [_cache refreshShellForPageURL:pageURL session:_session completion:^(GLOfflineShellRefreshResult result) {
        GLOfflineShellLoader *strongSelf = weakSelf;
        GLLog(@"background shell refresh for %@ finished: %ld", pageURL, (long)result);
        // Really offline: say so, and keep checking. Other results leave the page as it is.
        if (strongSelf && strongSelf->_cacheFirstShell && strongSelf.showingShell &&
            result == GLOfflineShellRefreshUnreachable) {
            [strongSelf showPillAndScheduleRecheck];
        }
    }];
}

// A cache-first shell's pill would otherwise stay up until the next foreground, though the page's own requests reach
// the server again seconds later (a cold launch often beats the tailnet VPN). One pending recheck at a time; a new
// load or a live commit makes it a no-op.
- (void)showPillAndScheduleRecheck {
    _indicatorView.hidden = NO;
    if (_recheckPending) return;
    _recheckPending = YES;
    __weak typeof(self) weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(self.offlineRecheckSeconds * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
        GLOfflineShellLoader *strongSelf = weakSelf;
        if (!strongSelf) return;
        strongSelf->_recheckPending = NO;
        if (strongSelf->_cacheFirstShell && strongSelf.showingShell) [strongSelf probeCacheFirstShell];
    });
}

// Refreshes the saved copy: unreachable keeps the pill (and the rechecks); any answer hides it and shows the new copy
// if it changed. Never a live load.
- (void)probeCacheFirstShell {
    if (_probing) return;
    _probing = YES;
    __weak typeof(self) weakSelf = self;
    [_cache refreshShellForPageURL:_request.URL session:_session completion:^(GLOfflineShellRefreshResult result) {
        GLOfflineShellLoader *strongSelf = weakSelf;
        if (!strongSelf) return;
        strongSelf->_probing = NO;
        if (!strongSelf->_cacheFirstShell || !strongSelf.showingShell) return;
        if (result == GLOfflineShellRefreshUnreachable) {
            [strongSelf showPillAndScheduleRecheck];
            return;
        }
        strongSelf->_indicatorView.hidden = YES;
        NSString *html = [strongSelf->_cache cachedHTMLForPageURL:strongSelf->_request.URL];
        if (html && ![html isEqualToString:strongSelf->_shownShellHTML]) {
            strongSelf->_shownShellHTML = html;
            strongSelf->_shellNavigation = [strongSelf->_webView loadSimulatedRequest:strongSelf->_request
                                                                   responseHTMLString:html];
            strongSelf->_shellShownAt = [NSDate date];
        }
    }];
}

- (void)deadlineElapsedForAttempt:(NSUInteger)attempt {
    if (attempt != _attempt || !_liveNavigation || _liveCommitted) return;
    // A live page is already on screen and this is only a refresh: let the
    // load run, its own failure will surface as before.
    if (_hasCommittedLive && !self.showingShell) return;
    if ([self showCachedShell]) GLLog(@"no response from %@ within %.1fs, showing saved shell", _request.URL, self.deadline);
}

/// Cancels the live load and puts the saved shell on screen, at the live
/// request's own URL (that is what keeps the origin, and so localStorage).
/// NO when there is no saved copy: nothing is touched then.
- (BOOL)showCachedShell {
    NSString *html = [_cache cachedHTMLForPageURL:_request.URL];
    if (!html) return NO;
    WKNavigation *live = _liveNavigation;
    _liveNavigation = nil;
    if (live) {
        [_superseded addObject:live];
        [_webView stopLoading];
    }
    if (!self.showingShell) {
        _cacheFirstShell = NO;
        _shellNavigation = [_webView loadSimulatedRequest:_request responseHTMLString:html];
        _shellShownAt = [NSDate date];
    }
    // A live attempt just failed or timed out: the pill is warranted even over a cache-first shell.
    _indicatorView.hidden = NO;
    [self.delegate offlineShellLoaderDidShowShell:self];
    return YES;
}

- (void)swapToLiveIfReachable {
    if (!self.showingShell || _probing) return;
    // Cache-first: no live load, so nothing to protect with the minimum time.
    if (_cacheFirstShell) {
        [self probeCacheFirstShell];
        return;
    }
    if ([[NSDate date] timeIntervalSinceDate:_shellShownAt] < self.minShellSecondsBeforeAutoSwap) return;
    _probing = YES;
    __weak typeof(self) weakSelf = self;
    [_cache refreshShellForPageURL:_request.URL session:_session completion:^(GLOfflineShellRefreshResult result) {
        GLOfflineShellLoader *strongSelf = weakSelf;
        if (!strongSelf) return;
        strongSelf->_probing = NO;
        // Any HTTP answer means the server is reachable; only a transport error does not.
        if (result == GLOfflineShellRefreshUnreachable || !strongSelf.showingShell) return;
        [strongSelf loadLiveRequest:strongSelf->_request];
    }];
}

#pragma mark Navigation callbacks

- (void)webView:(WKWebView *)webView didCommitNavigation:(WKNavigation *)navigation {
    if (!navigation || navigation != _liveNavigation) return;
    _liveCommitted = YES;
    _hasCommittedLive = YES;
    _cacheFirstShell = NO;
    _shellShownAt = nil;
    _indicatorView.hidden = YES;
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    if (!navigation) return;
    if (navigation == _shellNavigation) {
        _shellNavigation = nil;
        return;
    }
    if (navigation != _liveNavigation) return;
    _liveNavigation = nil;
    NSURL *pageURL = _request.URL;
    [_cache refreshShellForPageURL:pageURL session:_session completion:^(GLOfflineShellRefreshResult result) {
        GLLog(@"shell refresh for %@ finished: %ld", pageURL, (long)result);
    }];
}

- (BOOL)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    if (navigation && navigation == _liveNavigation) _liveNavigation = nil;
    return [GLOfflineShellLoader isCancellation:error];
}

- (BOOL)webView:(WKWebView *)webView
    didFailProvisionalNavigation:(WKNavigation *)navigation
                       withError:(NSError *)error {
    if ([GLOfflineShellLoader isCancellation:error]) {
        if (navigation == _liveNavigation) _liveNavigation = nil;
        return YES;
    }
    if (!navigation) return NO;
    if ([_superseded containsObject:navigation]) {
        [_superseded removeObject:navigation];
        return YES;
    }
    if (navigation != _liveNavigation) return NO;
    _liveNavigation = nil;
    BOOL networkClass = [GLOfflineShellLoader isNetworkClassError:error];
    // A live page already on screen (and not our own shell) keeps today's
    // behaviour on a failed refresh: the error view.
    BOOL coldOrShell = !_hasCommittedLive || self.showingShell;
    if (networkClass && coldOrShell && [self showCachedShell]) {
        GLLog(@"live load of %@ failed (%@), showing saved shell", _request.URL, error);
        return YES;
    }
    [self.delegate offlineShellLoader:self didFailLiveLoad:error];
    return YES;
}

@end
