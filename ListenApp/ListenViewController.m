#import "ListenViewController.h"

#import <AVFoundation/AVFoundation.h>
#import <CoreLocation/CoreLocation.h>
#import <WebKit/WebKit.h>

#import "ListenBakedConfig.h"
#import "ListenDownloads.h"
#import "ListenLinks.h"
#import "GLLog.h"
#import "GLOfflineShell.h"
#import "ListenPlayer.h"
#import "ListenPocketView.h"
#import "ListenProbe.h"
#import "ListenRewind.h"
#import "ListenSpeakTurn.h"
#import "ListenVoiceListener.h"

// The host is the one build-time secret (GL_BAKED_HOST, from
// ListenApp/ListenBakedConfig.h); this app only owns its own port. 9315 is the
// tailnet-only `tailscale serve` HTTPS front for the server on 8315: the Voice
// tab needs getUserMedia, which WKWebView only exposes to secure contexts.
static NSInteger const kListenPort = 9315;

// The page's base URL, trailing slash included; the guest build bakes its own.
static NSURL *ListenBaseURL(void) {
    NSString *baked = GL_BAKED_BASE_URL;
    if (baked.length) return [NSURL URLWithString:baked];
    return [NSURL URLWithString:[NSString stringWithFormat:@"https://%@:%ld/", GL_BAKED_HOST, (long)kListenPort]];
}

// WKUserContentController retains its handlers strongly; the view controller
// owns the web view, so hand the controller a weak forwarder instead of self.
@interface ListenScriptHandler : NSObject <WKScriptMessageHandler>
@property (nonatomic, weak) id<WKScriptMessageHandler> target;
@end

@implementation ListenScriptHandler
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    [self.target userContentController:controller didReceiveScriptMessage:message];
}
@end

@interface ListenViewController () <WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, GLOfflineShellLoaderDelegate, CLLocationManagerDelegate>
@end

@implementation ListenViewController {
    WKWebView *_webView;
    UILabel *_errorLabel;
    UIButton *_retryButton;
    // Falls back to the saved shell.html when a cold launch cannot reach the server.
    GLOfflineShellLoader *_shellLoader;
    ListenPlayer *_player;
    ListenPocketView *_pocket;
    ListenVoiceListener *_voice;
    // Native hands-free Listen & speak turn, for stops the page cannot show (screen locked / pocket view up).
    ListenSpeakTurn *_speak;
    // Ride map: runs only between the page's locationStart and locationStop (when-in-use, no background updates).
    CLLocationManager *_location;
    // The stop chime (public/speak-chime.mp3), fetched once and kept; the player must outlive -chime or it stops at once.
    NSData *_chimeData;
    AVAudioPlayer *_chimePlayer;
}

- (WKWebView *)listenWebView { return _webView; }

#pragma mark - Lifecycle

- (void)viewDidLoad {
    [super viewDidLoad];
    // The page's own background (the pinned "zine" theme), so launch shows no flash before the web view paints.
    self.view.backgroundColor = [UIColor colorWithDynamicProvider:^UIColor *(UITraitCollection *t) {
        return t.userInterfaceStyle == UIUserInterfaceStyleDark
            ? [UIColor colorWithRed:0x1B / 255.0 green:0x19 / 255.0 blue:0x14 / 255.0 alpha:1]
            : [UIColor colorWithRed:0xF3 / 255.0 green:0xEC / 255.0 blue:0xDD / 255.0 alpha:1];
    }];

    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
    config.allowsInlineMediaPlayback = YES;
    _webView = [[WKWebView alloc] initWithFrame:CGRectZero configuration:config];
    _webView.navigationDelegate = self;
    _webView.UIDelegate = self;
    // Left-edge swipe pops the page's one sentinel history entry, which runs the visible Back button (app.js).
    _webView.allowsBackForwardNavigationGestures = YES;
    _webView.translatesAutoresizingMaskIntoConstraints = NO;
    _webView.opaque = NO;
    _webView.backgroundColor = [UIColor clearColor];
    _webView.scrollView.backgroundColor = [UIColor clearColor];
    // Edge to edge: the page paints under the status bar and home indicator and pads itself with
    // env(safe-area-inset-*) (viewport-fit=cover), so no native background shows in those strips.
    _webView.scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;
    [self.view addSubview:_webView];
    UILayoutGuide *safe = self.view.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
        [_webView.topAnchor constraintEqualToAnchor:self.view.topAnchor],
        [_webView.bottomAnchor constraintEqualToAnchor:self.view.bottomAnchor],
        [_webView.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
        [_webView.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
    ]];

    _errorLabel = [[UILabel alloc] init];
    _errorLabel.numberOfLines = 0;
    _errorLabel.textAlignment = NSTextAlignmentCenter;
    _errorLabel.textColor = [UIColor secondaryLabelColor];
    _errorLabel.hidden = YES;
    _errorLabel.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:_errorLabel];
    _retryButton = [UIButton buttonWithType:UIButtonTypeSystem];
    [_retryButton setTitle:@"Retry" forState:UIControlStateNormal];
    [_retryButton addTarget:self action:@selector(loadPage) forControlEvents:UIControlEventTouchUpInside];
    _retryButton.hidden = YES;
    _retryButton.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:_retryButton];
    [NSLayoutConstraint activateConstraints:@[
        [_errorLabel.centerYAnchor constraintEqualToAnchor:self.view.centerYAnchor constant:-20],
        [_errorLabel.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:24],
        [_errorLabel.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-24],
        [_retryButton.topAnchor constraintEqualToAnchor:_errorLabel.bottomAnchor constant:12],
        [_retryButton.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
    ]];

    _shellLoader = [[GLOfflineShellLoader alloc] initWithWebView:_webView
                                                        hostView:self.view
                                                           cache:[GLOfflineShellCache sharedCache]
                                                         session:[NSURLSession sharedSession]];
    _shellLoader.delegate = self;
    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(appWillEnterForeground)
                                                 name:UIApplicationWillEnterForegroundNotification
                                               object:nil];

    _player = [[ListenPlayer alloc] init];
    _voice = [[ListenVoiceListener alloc] initWithPlayer:_player];
    __weak typeof(self) weakSelf = self;
    _player.stateChanged = ^{ [weakSelf emitState]; };
    _player.errorReported = ^(NSString *message) { [weakSelf emitEvent:@"error" payload:@{@"message": message}]; };
    _player.nextTrackOverride = ^BOOL{
        ListenViewController *strongSelf = weakSelf;
        // Double-press while the speak feedback plays = answer again. Checked before the pocket / voice rules because it
        // must work on a plain locked screen too (AirPods double-press arrives as nextTrack either way).
        if (strongSelf && [strongSelf->_speak retryFromFeedback]) return YES;
        if (!strongSelf || !strongSelf->_pocket) return NO;
        if (![strongSelf->_player.settings[@"pocketDoublePress"] isEqual:@"voice"]) return NO;
        [strongSelf->_voice startWindow];
        return YES;
    };
    _voice.onListeningChanged = ^{ [weakSelf emitState]; };
    _voice.onHeard = ^(NSString *transcript, NSString *matched) {
        [weakSelf emitEvent:@"heard" payload:@{@"transcript": transcript, @"matched": matched ?: [NSNull null]}];
    };
    _voice.onCommand = ^(NSString *name, NSInteger idx) { [weakSelf emitCommand:name idx:idx]; };
    _voice.onError = ^(NSString *message) { [weakSelf emitEvent:@"error" payload:@{@"message": message}]; };

    _speak = [[ListenSpeakTurn alloc] initWithBaseURL:ListenBaseURL()];
    _speak.onPhaseChanged = ^{ [weakSelf emitState]; };
    _speak.onResult = ^(NSDictionary *result) { [weakSelf emitEvent:@"speakResult" payload:result]; };
    _speak.onError = ^(NSString *message) { [weakSelf emitEvent:@"error" payload:@{@"message": message}]; };
    // Turn over (done, failed or given up): the player parks paused at the next section; the listener presses play.
    _speak.onFinished = ^(NSInteger afterIdx) {
        ListenViewController *strongSelf = weakSelf;
        [strongSelf->_player parkAfterSpeakTurnFromIdx:afterIdx];
    };
    // The listener said "continue" at the stop: skip it and carry on playing, hands-free.
    _speak.onSkipped = ^(NSInteger afterIdx) {
        ListenViewController *strongSelf = weakSelf;
        [strongSelf->_player resumeAfterSpeakTurnFromIdx:afterIdx];
    };
    _player.speakTurnActive = ^BOOL{
        ListenViewController *strongSelf = weakSelf;
        return strongSelf && strongSelf->_speak.phase != nil;
    };
    // The player reached a Listen & speak stop. The page runs it when it is live; when it is not (app not active, i.e.
    // screen locked, or the pocket view covers the page) the page's sheet cannot be seen or even run, so do it natively.
    _player.speakStopHandler = ^BOOL(NSDictionary *stop) {
        ListenViewController *strongSelf = weakSelf;
        if (!strongSelf) return NO;
        BOOL pageIsLive = [UIApplication sharedApplication].applicationState == UIApplicationStateActive && !strongSelf->_pocket;
        if (pageIsLive) return NO;
        NSString *itemId = strongSelf->_player.itemId;
        if (!itemId) return NO;
        return [strongSelf->_speak startWithItemId:itemId stop:stop];
    };

    ListenScriptHandler *handler = [[ListenScriptHandler alloc] init];
    handler.target = self;
    WKWebView *webView = _webView;
    [webView.configuration.userContentController addScriptMessageHandler:handler name:@"listen"];
    GLLog(@"listen handler registered (webView=%@, controller=%@)", NSStringFromClass([webView class]),
          NSStringFromClass([webView.configuration.userContentController class]));

    [self injectGuestCookieThen:^{ [self loadPage]; }];
    [ListenProbe runIfRequestedWithWebView:webView];
}

#pragma mark - Page loading

// The guest server gates every page and API call on its passcode cookie. Set it in both cookie stores: the web view's,
// and the shared one that NSURLSession (shell refresh, speak turns, downloads) and AVPlayer read.
- (void)injectGuestCookieThen:(void (^)(void))then {
    NSString *value = GL_BAKED_GUEST_COOKIE;
    if (!value.length) { then(); return; }
    NSHTTPCookie *cookie = [NSHTTPCookie cookieWithProperties:@{
        NSHTTPCookieName: @"listen_guest", NSHTTPCookieValue: value, NSHTTPCookieDomain: ListenBaseURL().host,
        NSHTTPCookiePath: @"/", NSHTTPCookieSecure: @"TRUE",
        NSHTTPCookieExpires: [NSDate dateWithTimeIntervalSinceNow:10 * 365 * 24 * 3600],
    }];
    [[NSHTTPCookieStorage sharedHTTPCookieStorage] setCookie:cookie];
    [_webView.configuration.websiteDataStore.httpCookieStore setCookie:cookie completionHandler:then];
}

- (void)loadPage {
    _errorLabel.hidden = YES;
    _retryButton.hidden = YES;
    // Cache-first: paint the saved page at once (it renders from its own local caches) and refresh the saved copy in
    // the background, so a launch never waits on the network. A deploy shows on the next launch or foreground.
    _shellLoader.prefersSavedShell = YES;
    [_shellLoader loadPreferringSavedShell:[NSURLRequest requestWithURL:ListenBaseURL()]];
}

- (void)appWillEnterForeground {
    [_shellLoader swapToLiveIfReachable];
}

- (void)dealloc {
    [[NSNotificationCenter defaultCenter] removeObserver:self];
}

- (void)offlineShellLoaderDidShowShell:(GLOfflineShellLoader *)loader {
    _errorLabel.hidden = YES;
    _retryButton.hidden = YES;
}

- (void)offlineShellLoader:(GLOfflineShellLoader *)loader didFailLiveLoad:(NSError *)error {
    [self showLoadError:error];
}

- (void)webView:(WKWebView *)webView didCommitNavigation:(WKNavigation *)navigation {
    [_shellLoader webView:webView didCommitNavigation:navigation];
    _errorLabel.hidden = YES; // a page arrived, so an earlier failure no longer describes the screen
    _retryButton.hidden = YES;
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    [_shellLoader webView:webView didFinishNavigation:navigation];
    // The one-shot reload reason (see webViewWebContentProcessDidTerminate:) has been read by the page's head script.
    [webView.configuration.userContentController removeAllUserScripts];
}

// iOS kills the web content process of an app left in the background; the view then stays blank (or WebKit reloads the
// live URL on its own, slowly). Reload the saved shell ourselves, cache-first, and tell the page why: a document-start
// user script sets window.__listenReloadReason, which the page's boot trace records.
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
    GLLog(@"listen: web content process terminated, reloading the saved shell");
    WKUserScript *reason = [[WKUserScript alloc] initWithSource:@"window.__listenReloadReason='webcontent-terminated';"
                                                  injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                               forMainFrameOnly:YES];
    [webView.configuration.userContentController removeAllUserScripts];
    [webView.configuration.userContentController addUserScript:reason];
    [self loadPage];
}

// The page's own origin gets the microphone without WebKit's per-launch "allow microphone" sheet; the app-level
// NSMicrophoneUsageDescription prompt still gates it once. Any other origin is refused.
- (void)webView:(WKWebView *)webView requestMediaCapturePermissionForOrigin:(WKSecurityOrigin *)origin
    initiatedByFrame:(WKFrameInfo *)frame type:(WKMediaCaptureType)type
    decisionHandler:(void (^)(WKPermissionDecision))decisionHandler API_AVAILABLE(ios(15.0)) {
    NSURL *base = ListenBaseURL();
    // WKSecurityOrigin reports the scheme's default port as 0.
    NSInteger port = base.port ? base.port.integerValue : 0;
    BOOL ours = [origin.protocol isEqual:@"https"] && [origin.host isEqual:base.host] && origin.port == port
        && type == WKMediaCaptureTypeMicrophone;
    GLLog(@"media capture request %@://%@:%ld type=%ld -> %@", origin.protocol, origin.host, (long)origin.port, (long)type, ours ? @"grant" : @"deny");
    decisionHandler(ours ? WKPermissionDecisionGrant : WKPermissionDecisionDeny);
}

#pragma mark - External links

- (NSURL *)pageURL {
    return ListenBaseURL();
}

- (void)openExternally:(NSURL *)url {
    GLLog(@"link -> Safari: %@", url);
    [UIApplication.sharedApplication openURL:url options:@{} completionHandler:nil];
}

// target="_blank" / window.open: there is no second web view, so hand the URL to Safari instead of dropping it.
- (WKWebView *)webView:(WKWebView *)webView
    createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
               forNavigationAction:(WKNavigationAction *)navigationAction
                    windowFeatures:(WKWindowFeatures *)windowFeatures {
    NSURL *url = navigationAction.request.URL;
    if ([ListenLinks shouldOpenExternally:url pageURL:[self pageURL] isNewWindow:YES isLinkActivation:NO]) {
        [self openExternally:url];
    }
    return nil;
}

// Tapped links to another host (or mailto:/tel:) leave the app; same-host and file:// (the cached shell) stay.
- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction
                    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *url = navigationAction.request.URL;
    BOOL tap = navigationAction.navigationType == WKNavigationTypeLinkActivated;
    if ([ListenLinks shouldOpenExternally:url pageURL:[self pageURL] isNewWindow:NO isLinkActivation:tap]) {
        [self openExternally:url];
        decisionHandler(WKNavigationActionPolicyCancel);
        return;
    }
    decisionHandler(WKNavigationActionPolicyAllow);
}

- (void)showLoadError:(NSError *)error {
    GLLog(@"page load failed: %@", error);
    _errorLabel.text = [NSString stringWithFormat:@"Couldn't reach Listen at %@\n%@",
                        ListenBaseURL().absoluteString, error.localizedDescription];
    _errorLabel.hidden = NO;
    _retryButton.hidden = NO;
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    if ([_shellLoader webView:webView didFailProvisionalNavigation:navigation withError:error]) return;
    [self showLoadError:error];
}

- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    if ([_shellLoader webView:webView didFailNavigation:navigation withError:error]) return;
    [self showLoadError:error];
}

#pragma mark - Page -> native

- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    NSDictionary *body = message.body;
    if (![body isKindOfClass:[NSDictionary class]] || !body[@"id"] || ![body[@"method"] isKindOfClass:[NSString class]]) {
        [self emitEvent:@"error" payload:@{@"message": [NSString stringWithFormat:
            @"listen message must be {id, method, params}, got %@", body]}];
        return;
    }
    id messageId = body[@"id"];
    NSString *method = body[@"method"];
    id rawParams = body[@"params"];
    NSDictionary *params = [rawParams isKindOfClass:[NSDictionary class]] ? rawParams : @{};
    GLLog(@"listen call %@ (id=%@)", method, messageId);

    id result = @{};
    NSString *error = [self perform:method params:params result:&result];
    [self replyTo:messageId result:error ? nil : result error:error];
}

/// Runs one protocol method. Returns an error string or nil; `result` defaults to {}.
- (NSString *)perform:(NSString *)method params:(NSDictionary *)params result:(id *)result {
    if ([method isEqual:@"load"]) {
        NSString *itemId = params[@"itemId"], *title = params[@"title"];
        NSArray *sections = params[@"sections"];
        NSDictionary *settings = params[@"settings"];
        NSNumber *startIdx = params[@"startIdx"];
        id artwork = params[@"artwork"];
        if (![itemId isKindOfClass:[NSString class]]) return @"load: itemId must be a string";
        if (![title isKindOfClass:[NSString class]]) return @"load: title must be a string";
        if (![sections isKindOfClass:[NSArray class]]) return @"load: sections must be an array";
        if (![settings isKindOfClass:[NSDictionary class]]) return @"load: settings must be an object";
        if (![startIdx isKindOfClass:[NSNumber class]]) return @"load: startIdx must be a number";
        if (artwork == [NSNull null]) artwork = nil;
        NSURL *artworkURL = [artwork isKindOfClass:[NSString class]] ? [NSURL URLWithString:artwork] : nil;
        if (artwork && !([artworkURL.scheme isEqual:@"http"] || [artworkURL.scheme isEqual:@"https"])) {
            return @"load: artwork must be an http(s) url or null";
        }
        [_speak cancel]; // a turn for the previous item must not grade or continue into this one
        return [_player loadItemId:itemId title:title artwork:artworkURL sections:sections settings:settings startIdx:startIdx.integerValue];
    }
    if ([method isEqual:@"play"]) return [_player play];
    if ([method isEqual:@"pause"]) return [_player pause];
    if ([method isEqual:@"toggle"]) return [_player toggle];
    if ([method isEqual:@"next"]) return [_player next];
    if ([method isEqual:@"prev"]) return [_player prev];
    if ([method isEqual:@"goto"]) {
        NSNumber *idx = params[@"idx"];
        if (![idx isKindOfClass:[NSNumber class]]) return @"goto: idx must be a number";
        return [_player gotoIdx:idx.integerValue];
    }
    if ([method isEqual:@"replay"]) {
        NSString *kind = params[@"kind"];
        if (![kind isKindOfClass:[NSString class]]) return @"replay: kind must be a string";
        return [_player replay:kind];
    }
    if ([method isEqual:@"rewind"]) {
        NSArray *steps = params[@"steps"];
        NSNumber *slow = params[@"slow"];
        NSString *error = [ListenRewind validateSteps:steps slow:slow];
        if (error) return [@"rewind: " stringByAppendingString:error];
        id after = params[@"after"];
        if (after == nil) after = @"resume";
        if (![after isKindOfClass:[NSString class]]) return [NSString stringWithFormat:@"rewind: unknown rewind after %@", after];
        return [_player rewindSteps:steps slow:slow.integerValue after:after];
    }
    if ([method isEqual:@"loop"]) {
        NSNumber *on = params[@"on"];
        if (![on isKindOfClass:[NSNumber class]]) return @"loop: on must be a bool";
        id start = params[@"start"], end = params[@"end"];
        if ((start == nil) != (end == nil)) return @"loop: start and end must be given together";
        if (start != nil) {
            if (![start isKindOfClass:[NSNumber class]] || ![end isKindOfClass:[NSNumber class]]) return @"loop: start and end must be numbers";
            if (!isfinite([start doubleValue]) || !isfinite([end doubleValue]) || !([start doubleValue] < [end doubleValue])) return @"loop: range needs finite start < end";
        }
        return [_player setLoop:on.boolValue rangeStart:start rangeEnd:end];
    }
    if ([method isEqual:@"setSettings"]) {
        NSDictionary *settings = params[@"settings"];
        if (![settings isKindOfClass:[NSDictionary class]]) return @"setSettings: settings must be an object";
        return [_player setSettings:settings];
    }
    if ([method isEqual:@"getState"]) {
        *result = [self fullState];
        return nil;
    }
    if ([method isEqual:@"pocketMode"]) {
        NSNumber *on = params[@"on"];
        if (![on isKindOfClass:[NSNumber class]]) return @"pocketMode: on must be a bool";
        return [self setPocketMode:on.boolValue];
    }
    if ([method isEqual:@"chime"]) {
        NSString *itemId = params[@"itemId"], *kind = params[@"kind"];
        if (![itemId isKindOfClass:[NSString class]] || ![kind isKindOfClass:[NSString class]]) return @"chime: itemId and kind must be strings";
        [self chimeForItem:itemId kind:kind];
        return nil;
    }
    if ([method isEqual:@"voice"]) {
        NSNumber *on = params[@"on"];
        if (![on isKindOfClass:[NSNumber class]]) return @"voice: on must be a bool";
        if (on.boolValue) [_voice startWindow]; else [_voice cancel];
        return nil;
    }
    if ([method isEqual:@"locationStart"]) {
        if (!_location) {
            _location = [[CLLocationManager alloc] init];
            _location.delegate = self;
            _location.desiredAccuracy = kCLLocationAccuracyBestForNavigation;
            _location.activityType = CLActivityTypeOtherNavigation;
            _location.distanceFilter = kCLDistanceFilterNone;
        }
        if (_location.authorizationStatus == kCLAuthorizationStatusDenied || _location.authorizationStatus == kCLAuthorizationStatusRestricted)
            return @"locationStart: location access is off for Listen (Settings > Privacy > Location Services)";
        [_location requestWhenInUseAuthorization];
        [_location startUpdatingLocation];
        [_location startUpdatingHeading];
        return nil;
    }
    if ([method isEqual:@"locationStop"]) {
        [_location stopUpdatingLocation];
        [_location stopUpdatingHeading];
        return nil;
    }
    if ([method isEqual:@"download"]) {
        id items = params[@"items"];
        NSString *error = [ListenDownloads validateItems:items];
        if (error) return [@"download: " stringByAppendingString:error];
        [[ListenDownloads shared] setItems:items];
        return nil;
    }
    if ([method isEqual:@"getDownloads"]) {
        *result = [[ListenDownloads shared] status];
        return nil;
    }
    return [NSString stringWithFormat:@"unknown listen method %@", method];
}

#pragma mark - Stop chime

// The page's Listen & speak stop chime, played here because a page AudioContext takes the audio session from
// ListenPlayer: AVPlayer reads that as an interruption, pauses, and resumes when it ends, which made the pause
// button un-pause itself. AVAudioPlayer plays inside the app's own Playback session, so nothing is interrupted.
// The bytes come from the same /api/speak/prompt.mp3 the hands-free turn plays (one file for every item and kind,
// which the route still checks), fetched once per launch; a failed fetch or decode reports an error event.
- (void)chimeForItem:(NSString *)itemId kind:(NSString *)kind {
    if (_chimeData) { [self playChimeData:_chimeData]; return; }
    NSURLComponents *c = [NSURLComponents componentsWithURL:[NSURL URLWithString:@"api/speak/prompt.mp3" relativeToURL:ListenBaseURL()]
                                    resolvingAgainstBaseURL:YES];
    c.queryItems = @[[NSURLQueryItem queryItemWithName:@"item" value:itemId], [NSURLQueryItem queryItemWithName:@"kind" value:kind]];
    __weak typeof(self) weakSelf = self;
    [[[NSURLSession sharedSession] dataTaskWithURL:c.URL completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        NSInteger status = [response isKindOfClass:[NSHTTPURLResponse class]] ? ((NSHTTPURLResponse *)response).statusCode : 0;
        dispatch_async(dispatch_get_main_queue(), ^{
            ListenViewController *s = weakSelf;
            if (!s) return;
            if (error || status != 200 || !data.length) {
                [s emitEvent:@"error" payload:@{@"message": [NSString stringWithFormat:@"chime fetch failed: %@ (HTTP %ld)",
                                                              error.localizedDescription ?: @"empty body", (long)status]}];
                return;
            }
            s->_chimeData = data;
            [s playChimeData:data];
        });
    }] resume];
}

- (void)playChimeData:(NSData *)data {
    NSError *error = nil;
    _chimePlayer = [[AVAudioPlayer alloc] initWithData:data fileTypeHint:AVFileTypeMPEGLayer3 error:&error];
    if (!_chimePlayer || ![_chimePlayer play]) {
        [self emitEvent:@"error" payload:@{@"message": [NSString stringWithFormat:@"chime play failed: %@", error.localizedDescription ?: @"play returned NO"]}];
    }
}

#pragma mark - Location (Ride map)

- (void)locationManager:(CLLocationManager *)manager didUpdateLocations:(NSArray<CLLocation *> *)locations {
    CLLocation *l = locations.lastObject;
    if (!l || l.horizontalAccuracy < 0) return;
    // Course is only meaningful while moving; at a standstill (course < 0) fall back to the compass heading.
    double heading = l.course >= 0 ? l.course : (manager.heading.trueHeading >= 0 ? manager.heading.trueHeading : -1);
    [self emitEvent:@"location" payload:@{
        @"lat": @(l.coordinate.latitude), @"lng": @(l.coordinate.longitude), @"accuracy": @(l.horizontalAccuracy),
        @"heading": heading >= 0 ? (id)@(heading) : (id)[NSNull null],
        @"speed": l.speed >= 0 ? (id)@(l.speed) : (id)[NSNull null]}];
}

- (void)locationManager:(CLLocationManager *)manager didFailWithError:(NSError *)error {
    if (error.code == kCLErrorLocationUnknown) return; // transient: the manager keeps trying
    [self emitEvent:@"error" payload:@{@"message": [NSString stringWithFormat:@"location: %@", error.localizedDescription]}];
}

#pragma mark - Pocket mode

- (NSString *)setPocketMode:(BOOL)on {
    if (on == (_pocket != nil)) return nil;
    if (!on) {
        [_pocket dismiss];
        _pocket = nil;
        [self emitState];
        return nil;
    }
    UIWindow *window = self.view.window;
    if (!window) return @"pocketMode: Listen is not on screen";
    ListenPocketView *pocket = [[ListenPocketView alloc] initWithPlayer:_player];
    __weak typeof(self) weakSelf = self;
    pocket.onSave = ^{
        ListenViewController *strongSelf = weakSelf;
        if (strongSelf) [strongSelf emitCommand:@"save" idx:strongSelf->_player.currentIdx];
    };
    pocket.onExitRequested = ^{ [weakSelf setPocketMode:NO]; };
    pocket.onError = ^(NSString *message) { [weakSelf emitEvent:@"error" payload:@{@"message": message}]; };
    NSString *error = [pocket presentInWindow:window];
    if (error) return error;
    _pocket = pocket;
    [self emitState];
    return nil;
}

#pragma mark - Native -> page

- (NSDictionary *)fullState {
    NSMutableDictionary *state = [[_player stateDictionary] mutableCopy];
    state[@"pocket"] = @(_pocket != nil);
    state[@"listening"] = @(_voice.listening);
    state[@"speakTurn"] = _speak.phase ?: [NSNull null];
    return state;
}

- (void)emitState {
    NSDictionary *state = [self fullState];
    if (_pocket) {
        [_pocket refreshRewindLabel];
        NSString *step = [state[@"step"] isKindOfClass:[NSString class]] ? [state[@"step"] capitalizedString] : @"Done";
        [_pocket setStatusText:[NSString stringWithFormat:@"%@ · %ld/%ld", step,
                                (long)_player.currentIdx + 1, (long)_player.sectionCount]];
    }
    [self emitEvent:@"state" payload:state];
}

- (void)emitCommand:(NSString *)name idx:(NSInteger)idx {
    [self emitEvent:@"command" payload:@{@"name": name, @"idx": @(idx)}];
}

- (void)emitEvent:(NSString *)name payload:(NSDictionary *)payload {
    [self callPage:@"__listenEvent" arguments:@[name, payload]];
}

- (void)replyTo:(id)messageId result:(id)result error:(NSString *)error {
    [self callPage:@"__listenReply" arguments:@[messageId, result ?: [NSNull null], error ?: [NSNull null]]];
}

- (void)callPage:(NSString *)function arguments:(NSArray *)arguments {
    if (![NSJSONSerialization isValidJSONObject:arguments]) {
        GLLog(@"cannot serialize %@ arguments: %@", function, arguments);
        return;
    }
    NSError *jsonError = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:arguments options:0 error:&jsonError];
    if (!data) {
        GLLog(@"JSON for %@ failed: %@", function, jsonError);
        return;
    }
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    NSString *script = [NSString stringWithFormat:@"if (typeof window.%@ === 'function') window.%@.apply(null, %@);",
                        function, function, json];
    [[self listenWebView] evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
        if (error) GLLog(@"evaluateJavaScript for %@ failed: %@", function, error);
    }];
}

@end
