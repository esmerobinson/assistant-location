#import "GLWebModuleViewController.h"

#import <WebKit/WebKit.h>

#import "BakedConfig.h"
#import "GLDefaultsKeys.h"
#import "GLTheme.h"
#import "GLWebBridge.h"
#import "GLWebBackSwipe.h"
#import "GLKeyboardWebInset.h"
#import "GLOfflineShell.h"
#import "GLWebKeyboardFocus.h"
#import "GLWebPageCache.h"

// Port for the same location-server GLEndpoints.h's kGLBakedHostPort names —
// duplicated as its own constant rather than importing that header, same
// call GLTheme.m/GLAppStateReporter.m already made about their own copies of
// a port number: this is the one value a MANAGED page's boot injection
// needs (see -bootScriptSource's "apiBase" key) so a page like recents.html,
// now loadable from a file:// bundle/cache copy, can still reach its OWN
// data server with an absolute URL instead of a bare "/journal/..." that
// would resolve against the file:// origin and fail.
static NSInteger const kGLWebPageAPIBasePort = 8302;

@interface GLWebModuleViewController () <WKNavigationDelegate, WKUIDelegate, GLOfflineShellLoaderDelegate>
@property(nonatomic, strong, nullable) NSURL *backingURL;
@property(nonatomic, copy, nullable) NSString *backingDisplayName;
// Set only by -initWithManagedPageNamed: — see that initializer and -webURL,
// which re-resolves this against GLWebPageCacheActiveDirectory()'s current best copy on
// EVERY call rather than caching a single NSURL at init time, so a
// pull-to-refresh (or any other -loadPage call) after a background update
// lands picks up the new files without needing the tab to be torn down and
// recreated.
@property(nonatomic, copy, nullable) NSString *managedPageName;

@property(nonatomic, strong) WKWebView *webView;
// Fills the safe-area gap ABOVE the web view only -- see -updateTopInsetColor.
@property(nonatomic, strong) UIView *topInsetView;
@property(nonatomic, strong) UIRefreshControl *refreshControl;
@property(nonatomic, strong) UIActivityIndicatorView *loadingIndicator;
@property(nonatomic, strong) UIView *errorView;
@property(nonatomic, strong) UILabel *errorLabel;
@property(nonatomic, strong) GLWebBridge *bridge;
// Owns the web view's bottom edge, moving it over the tab bar's strip while the
// keyboard is up. See GLKeyboardWebInset.h for why that band existed.
@property(nonatomic, strong) GLKeyboardWebInset *keyboardInset;
// Shows the saved shell.html when a remote tab cannot be reached on a cold launch.
// Only used for http(s) pages; bundled/managed file:// pages never touch it.
@property(nonatomic, strong) GLOfflineShellLoader *shellLoader;
// Between -viewWillAppear: and -viewWillDisappear:. Gates canGoBack changes from
// touching a navigation controller this screen is not currently showing in.
@property(nonatomic) BOOL onScreen;
@end

@implementation GLWebModuleViewController

- (instancetype)initWithURL:(NSURL *)url displayName:(NSString *)displayName {
    self = [super initWithNibName:nil bundle:nil];
    if (self) {
        _backingURL = url;
        _backingDisplayName = [displayName copy];
    }
    return self;
}

- (instancetype)initWithBundledPageNamed:(NSString *)pageName {
    NSString *resourceName = [pageName stringByDeletingPathExtension];
    NSString *extension = [pageName pathExtension];
    NSBundle *bundle = [NSBundle mainBundle];
    // Modules/ is a PBXFileSystemSynchronizedRootGroup (see MODULES.md); the
    // pages under Modules/WebPages/ may land flat in the bundle root or
    // nested under a "WebPages" subdirectory depending on how Xcode's
    // synchronized-group resource copying resolves that folder -- there is
    // no compiler on the box that wrote this to settle it, so both are
    // tried before raising.
    NSURL *fileURL = [bundle URLForResource:resourceName withExtension:extension subdirectory:@"WebPages"];
    if (!fileURL) {
        fileURL = [bundle URLForResource:resourceName withExtension:extension];
    }
    if (!fileURL) {
        [NSException raise:NSInternalInconsistencyException
                    format:@"Bundled web page \"%@\" not found in the app bundle (checked "
                            "WebPages/ and the bundle root) -- check that Modules/'s "
                            "file-system-synchronized group is copying .html resources "
                            "into the build product", pageName];
    }
    return [self initWithURL:fileURL displayName:pageName];
}

// Chains through -initWithURL:displayName: (the designated initializer),
// same convention -initWithBundledPageNamed: above follows, rather than
// calling super directly -- keeps this a well-formed convenience
// initializer under NS_DESIGNATED_INITIALIZER's rules. The NSURL passed
// through here is only ever used as -webURL's INITIAL value; once
// managedPageName is set, -webURL below re-resolves
// GLWebPageCacheActiveDirectory() fresh on EVERY call instead of
// trusting backingURL -- a managed page's active copy CAN change while this
// VC is alive (a background GLWebPageCacheCheckForUpdates()
// can promote a new cache directory between one -loadPage call and the
// next), unlike a bundled page's fixed, one-time location.
- (instancetype)initWithManagedPageNamed:(NSString *)pageName {
    NSURL *initialURL = [GLWebPageCacheActiveDirectory() URLByAppendingPathComponent:pageName];
    self = [self initWithURL:initialURL displayName:pageName];
    if (self) {
        _managedPageName = [pageName copy];
    }
    return self;
}

- (NSURL *)webURL {
    if (self.managedPageName) {
        return [GLWebPageCacheActiveDirectory() URLByAppendingPathComponent:self.managedPageName];
    }
    if (!self.backingURL) {
        [NSException raise:NSInternalInconsistencyException
                    format:@"%@ has no URL — either use -initWithURL:displayName: or override -webURL",
                           NSStringFromClass(self.class)];
    }
    return self.backingURL;
}

- (NSString *)displayName {
    if (!self.backingDisplayName) {
        [NSException raise:NSInternalInconsistencyException
                    format:@"%@ has no display name — either use -initWithURL:displayName: or override -displayName",
                           NSStringFromClass(self.class)];
    }
    return self.backingDisplayName;
}

// KVO context pointer -- its ADDRESS is the identity, so the value is
// irrelevant. Using a context rather than matching the key path alone stops
// this from swallowing a themeColor observation registered by a superclass.
static void *GLWebThemeColorContext = &GLWebThemeColorContext;
static void *GLWebCanGoBackContext = &GLWebCanGoBackContext;

#pragma mark - Lifecycle

- (void)viewDidLoad {
    [super viewDidLoad];

    // Every GLWebModuleViewController hosts a WKWebView that native code can
    // push a focus into via -callWebFunctionIfDefined: (e.g. TodosModule's
    // double-tap "Add Todo") -- see GLWebKeyboardFocus.h for why that needs
    // a private-API swizzle to raise the keyboard. +install is idempotent
    // (dispatch_once internally), so calling it from every instance here is
    // safe; it only has to actually run once, before the first WKWebView
    // below is created.
    [GLWebKeyboardFocus install];

    UIColor *background = [GLTheme backgroundColor];
    self.view.backgroundColor = background;

    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
    config.userContentController = [self makeUserContentController];
    // Default is NO, which silently drops window.open()/target="_blank" even
    // from inside a real pointerup/click handler -- WKWebView's own gesture
    // heuristics don't reliably recognize a custom-drag app's synthetic
    // pointer sequence as "user interaction" the way a plain tap does.
    // Without this, todo-sorter's swipe-to-open-email card (and any other
    // module's window.open) is a silent no-op on device. Confirmed missing
    // and reported broken on 2026-09-06.
    config.preferences.javaScriptCanOpenWindowsAutomatically = YES;

    self.webView = [[WKWebView alloc] initWithFrame:CGRectZero configuration:config];
    self.webView.navigationDelegate = self;
    self.webView.UIDelegate = self;
    self.webView.opaque = NO;
    self.webView.backgroundColor = background;
    self.webView.scrollView.backgroundColor = background;
    // A swipeable card deck fights vertical rubber-banding, so only allow
    // horizontal bounce (harmless, and iOS ties the two together loosely).
    self.webView.scrollView.bounces = NO;
    // The edge swipe steps back through the page's own history (a hash route
    // like Outfits' piece view -> list) before it leaves the module. See
    // GLWebBackSwipe.h for how this shares the swipe with the More stack's pop.
    self.webView.allowsBackForwardNavigationGestures = YES;
    self.webView.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:self.webView];

    UILayoutGuide *guide = self.view.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
        [self.webView.topAnchor constraintEqualToAnchor:guide.topAnchor],
        [self.webView.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor],
        [self.webView.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor],
    ]];
    // The bottom edge is not pinned here: GLKeyboardWebInset owns it, because
    // it moves between the safe area and the view's true bottom as the keyboard
    // comes and goes. See that header for the band this closes.
    self.keyboardInset = [GLKeyboardWebInset attachTo:self.webView inContainer:self.view];

    // A dedicated view for the strip behind the status bar, rather than just
    // colouring self.view. That distinction is the whole point of this second
    // attempt: self.view sits behind the TAB BAR too, and on iOS 26 the bar
    // draws a system material whose light/dark choice follows the content
    // behind it. Painting self.view with the page's white flipped that
    // material to dark (#252525) with black labels on it -- measured on
    // device, and the reason the first version was reverted. Confining the
    // page's colour to this view leaves every pixel behind the tab bar exactly
    // as it was, so the bar's material cannot be affected by it at all.
    self.topInsetView = [[UIView alloc] init];
    self.topInsetView.translatesAutoresizingMaskIntoConstraints = NO;
    // Below the web view in z-order: they never overlap (this one ends where
    // the web view begins), so this only matters if a future layout change
    // makes them intersect, where the CONTENT should win, not the filler.
    [self.view insertSubview:self.topInsetView belowSubview:self.webView];
    [NSLayoutConstraint activateConstraints:@[
        [self.topInsetView.topAnchor constraintEqualToAnchor:self.view.topAnchor],
        [self.topInsetView.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
        [self.topInsetView.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
        [self.topInsetView.bottomAnchor constraintEqualToAnchor:guide.topAnchor],
    ]];
    [self updateTopInsetColor];

    // The page is a long-lived SPA (background searches, swipe state) — give
    // it an explicit reload affordance rather than relying on re-navigation.
    self.refreshControl = [[UIRefreshControl alloc] init];
    // Sits over the adaptive GLTheme.backgroundColor, not a fixed dark
    // surface — white was invisible in light mode. textSecondaryColor
    // reads as a muted spinner in both themes.
    self.refreshControl.tintColor = [GLTheme textSecondaryColor];
    [self.refreshControl addTarget:self
                             action:@selector(reloadTapped)
                   forControlEvents:UIControlEventValueChanged];
    [self.webView.scrollView addSubview:self.refreshControl];

    self.loadingIndicator = [[UIActivityIndicatorView alloc]
        initWithActivityIndicatorStyle:UIActivityIndicatorViewStyleMedium];
    self.loadingIndicator.hidesWhenStopped = YES;
    self.loadingIndicator.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:self.loadingIndicator];
    [NSLayoutConstraint activateConstraints:@[
        [self.loadingIndicator.centerXAnchor constraintEqualToAnchor:guide.centerXAnchor],
        [self.loadingIndicator.centerYAnchor constraintEqualToAnchor:guide.centerYAnchor],
    ]];

    [self buildErrorView:background];

    self.shellLoader = [[GLOfflineShellLoader alloc] initWithWebView:self.webView
                                                            hostView:self.view
                                                               cache:[GLOfflineShellCache sharedCache]
                                                             session:[NSURLSession sharedSession]];
    self.shellLoader.delegate = self;
    // A saved shell never swaps itself for the live page mid-session; coming
    // back to the foreground (after it has been up a while, server reachable) is
    // one of the three moments it does.
    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(appWillEnterForeground)
                                                 name:UIApplicationWillEnterForegroundNotification
                                               object:nil];

    [[NSNotificationCenter defaultCenter] addObserver:self
                                              selector:@selector(themeDidChange)
                                                  name:GLThemeDidChangeNotification
                                                object:nil];
    // Distinct trigger from the mode flip above -- see GLTheme.h's doc
    // comment on GLPaletteDidChangeNotification for why a palette change
    // (new theme id, or the same id resolving differently) needs its own
    // notification rather than piggybacking on GLThemeDidChangeNotification.
    [[NSNotificationCenter defaultCenter] addObserver:self
                                              selector:@selector(paletteDidChange)
                                                  name:GLPaletteDidChangeNotification
                                                object:nil];

    // themeColor lands asynchronously, after the page's meta is parsed and
    // generally later than -didFinishNavigation:, so reading it once on
    // navigation finish leaves a stale strip on a slow page.
    [self.webView addObserver:self
                   forKeyPath:NSStringFromSelector(@selector(themeColor))
                      options:NSKeyValueObservingOptionNew
                      context:GLWebThemeColorContext];
    [self.webView addObserver:self
                   forKeyPath:NSStringFromSelector(@selector(canGoBack))
                      options:NSKeyValueObservingOptionNew
                      context:GLWebCanGoBackContext];

    if (self.prefersSavedShell) {
        [self loadPageUsingSavedShell:YES];
    } else {
        [self loadPage];  // subclasses may override it
    }
}

// Only while on screen: the navigation controller is shared with the More page
// and every other module pushed onto it, so this controller may only claim its
// gestures while it is the one showing.
- (void)viewWillAppear:(BOOL)animated {
    [super viewWillAppear:animated];
    self.onScreen = YES;
    [GLWebBackSwipe applyPageCanGoBack:self.webView.canGoBack toNavigationController:self.navigationController];
}

- (void)viewWillDisappear:(BOOL)animated {
    [super viewWillDisappear:animated];
    self.onScreen = NO;
    [GLWebBackSwipe applyPageCanGoBack:NO toNavigationController:self.navigationController];
}

- (void)dealloc {
    [[NSNotificationCenter defaultCenter] removeObserver:self];
    // Paired with the addObserver: above. Guarded on the _webView ivar (not
    // the property -- a property access on a partially torn-down object is its
    // own hazard) because -viewDidLoad may never have run, and removing an
    // observer that was never added throws.
    if (_webView) {
        [_webView removeObserver:self
                      forKeyPath:NSStringFromSelector(@selector(themeColor))
                         context:GLWebThemeColorContext];
        [_webView removeObserver:self
                      forKeyPath:NSStringFromSelector(@selector(canGoBack))
                         context:GLWebCanGoBackContext];
    }
}

- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary *)change
                       context:(void *)context {
    if (context == GLWebCanGoBackContext) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (!self.onScreen) return;
            [GLWebBackSwipe applyPageCanGoBack:self.webView.canGoBack
                        toNavigationController:self.navigationController];
        });
        return;
    }
    if (context != GLWebThemeColorContext) {
        [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
        return;
    }
    // KVO can fire off the main thread; -updateTopInsetColor touches UIKit.
    dispatch_async(dispatch_get_main_queue(), ^{ [self updateTopInsetColor]; });
}

// The strip behind the status bar is the one part of this screen a hosted page
// cannot draw into (the web view starts at the safe-area top), so it follows
// the page's own <meta name="theme-color"> and falls back to the palette when
// a page publishes nothing -- a module that hasn't opted in is unaffected.
- (void)updateTopInsetColor {
    self.topInsetView.backgroundColor = self.webView.themeColor ?: [GLTheme backgroundColor];
}

#pragma mark - Theme propagation

// Built once at -viewDidLoad: only the "gl" bridge handler, which must be
// added exactly once per WKUserContentController (a second
// addScriptMessageHandler:name: for the same name throws). The boot script
// itself is NOT added here -- see -installBootUserScript, called from
// -loadPage on every load, which is what actually carries the current
// palette/mode/themeId (this used to be built once here and go stale the
// moment either changed after the first load).
- (WKUserContentController *)makeUserContentController {
    WKUserContentController *controller = [[WKUserContentController alloc] init];
    self.bridge = [[GLWebBridge alloc] initWithHostViewController:self];
    [controller addScriptMessageHandler:self.bridge name:@"gl"];
    return controller;
}

- (NSString *)javaScriptStringLiteralForModeName:(NSString *)modeName {
    return [NSString stringWithFormat:@"\"%@\"", modeName];
}

// Rebuilt on EVERY -loadPage (removeAllUserScripts + re-add), not just once
// at -viewDidLoad: a WKUserScript is immutable once created, so a stale one
// left in place across a mode/palette change would keep injecting the OLD
// GL_BOOT into every subsequent navigation (including the retry reload
// -loadPage itself triggers).
- (void)installBootUserScript {
    WKUserContentController *controller = self.webView.configuration.userContentController;
    [controller removeAllUserScripts];
    WKUserScript *script =
        [[WKUserScript alloc] initWithSource:[self bootScriptSource]
                                injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                             forMainFrameOnly:YES];
    [controller addUserScript:script];
}

// `window.GL_BOOT = {palette, mode, themeId, platform}` + the legacy
// `document.documentElement.dataset.theme` assignment -- the frozen
// native<->web bridge protocol's boot injection (Modules/WebBridge/
// GLWebBridge.h). NSJSONSerialization builds the object literal so nothing
// here ever string-formats palette/theme-id content directly into the
// script.
- (NSString *)bootScriptSource {
    NSString *mode = [GLTheme effectiveModeName];
    NSDictionary *palette = [GLTheme currentPaletteColors];
    NSString *themeId = [GLTheme selectedThemeId];

    // "apiBase" — the location-server origin, added for MANAGED pages that
    // fetch their own data over HTTP after loading their shell from a
    // file:// bundle/cache copy (today: recents.html's
    // "/journal/recordings" fetch — see that file's apiBase() helper).
    // Present on every page's boot, not just managed ones: harmless for
    // more.html/settings.html (they never read it, everything they do goes
    // through GLBridge.call), and keeping it unconditional means a future
    // page never needs a per-page branch here to get it. Not routed through
    // GLEndpoints.h's GLEndpointURL() because that helper *raises* on an
    // unbaked host (every simulator/CI build) — this is boot-script
    // content, not a network call, so it must never throw building it; an
    // unbaked/placeholder value here just means a managed page's own fetch
    // fails into ITS OWN error state exactly like an unreachable real host
    // would, which is the correct degrade.
    // Test hook, same pattern as TrackerAppLifecycle.m's UITEST_ENDPOINT and
    // GLTheme.m's UITEST_NATIVE_PALETTE: sim-test.yml never bakes
    // GL_BAKED_HOST (see this method's own doc above), so a managed page's
    // /sessions/* fetch had no way to reach a real server in CI before this
    // -- every such request just failed into the page's own error state,
    // which proved the ERROR path but never that the app actually sends the
    // right request (method, path, Bearer token) when a server IS
    // reachable.
    //
    // Persisted to NSUserDefaults (GLUITestWebPageAPIBaseDefaultsName), not
    // read from the environment alone: `xcrun simctl openurl` (used to
    // exercise Sessions' overland://session/... deep links) launches the
    // app WITHOUT the `SIMCTL_CHILD_` prefix `simctl launch` supports, so a
    // cold launch triggered by openurl carries no environment override at
    // all. Writing the env value into the default HERE, every time it's
    // present, means one earlier `simctl launch` with the env var set is
    // enough to make every later launch in the same test run (env-carrying
    // or not) see it — same trick TrackerAppLifecycle.m's UITEST_ENDPOINT
    // uses for GLAPIEndpointDefaultsName.
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    NSString *envApiBase = [[NSProcessInfo processInfo] environment][@"UITEST_WEBPAGE_API_BASE"];
    if (envApiBase.length > 0) {
        [defaults setObject:envApiBase forKey:GLUITestWebPageAPIBaseDefaultsName];
    }
    NSString *apiBase = envApiBase
        ?: [defaults stringForKey:GLUITestWebPageAPIBaseDefaultsName]
        ?: [NSString stringWithFormat:@"http://%@:%ld", GL_BAKED_HOST, (long)kGLWebPageAPIBasePort];

    NSDictionary *boot = @{
        @"palette": palette ?: [NSNull null],
        @"mode": mode,
        @"themeId": themeId ?: [NSNull null],
        @"platform": @"ios",
        @"apiBase": apiBase,
    };
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:boot options:0 error:&error];
    NSString *bootJSON = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]
                              : @"{\"palette\":null,\"mode\":\"light\",\"themeId\":null,\"platform\":\"ios\",\"apiBase\":\"\"}";
    return [NSString stringWithFormat:@"window.GL_BOOT = %@;\ndocument.documentElement.dataset.theme = %@;",
                                       bootJSON, [self javaScriptStringLiteralForModeName:mode]];
}

- (NSURL *)themedWebURL {
    NSURL *url = [self webURL];
    // Bundled pages carry their theme entirely through GL_BOOT (see
    // -bootScriptSource) -- mutating a file:// URL's query string buys
    // nothing (there's no server on the other end to read it) and risks
    // NSURLComponents mangling a file URL some iOS versions round-trip
    // imperfectly.
    if (url.isFileURL) return url;
    NSURLComponents *components = [NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:NO];
    NSMutableArray<NSURLQueryItem *> *items = [components.queryItems mutableCopy] ?: [NSMutableArray array];
    [items addObject:[NSURLQueryItem queryItemWithName:@"theme" value:[GLTheme effectiveModeName]]];
    components.queryItems = items;
    return components.URL;
}

// Updates the wrapper's OWN chrome (the parts UIKit draws, not the page) --
// called from both -themeDidChange and -paletteDidChange, since either can
// change these independent of the other.
- (void)updateChromeForTheme {
    UIColor *background = [GLTheme backgroundColor];
    self.view.backgroundColor = background;
    self.webView.backgroundColor = background;
    self.webView.scrollView.backgroundColor = background;
    self.refreshControl.tintColor = [GLTheme textSecondaryColor];
    // Deliberately NOT folded into the assignments above: those stay on the
    // palette (they back the tab bar's material, see -viewDidLoad), while the
    // strip re-resolves against the page and only falls back to the palette.
    [self updateTopInsetColor];
}

- (void)themeDidChange {
    [self updateChromeForTheme];
    [self pushThemeToPageOrReload];
}

- (void)paletteDidChange {
    [self updateChromeForTheme];
    [self pushThemeToPageOrReload];
}

// Live-pushes the new palette/mode/themeId into the already-loaded page via
// `window.__glThemeChanged`, guarded so a page that never defines it (or
// hasn't finished loading gl-bridge.js yet) is simply a no-op rather than a
// thrown exception. A full -loadPage reload happens ONLY when the page never
// successfully loaded in the first place (the error view is showing): there
// is nothing live to push a theme into, and a reload is also the one way to
// retry the load itself.
- (void)pushThemeToPageOrReload {
    if (!self.errorView.hidden) {
        [self loadPage];
        return;
    }

    NSDictionary *payload = @{
        @"palette": [GLTheme currentPaletteColors] ?: [NSNull null],
        @"mode": [GLTheme effectiveModeName],
        @"themeId": [GLTheme selectedThemeId] ?: [NSNull null],
    };
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:&error];
    if (!data) return;
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    NSString *script = [NSString stringWithFormat:
        @"typeof window.__glThemeChanged === 'function' && window.__glThemeChanged(%@);", json];
    [self.webView evaluateJavaScript:script completionHandler:nil];
}

#pragma mark - Error view

- (void)buildErrorView:(UIColor *)background {
    self.errorView = [[UIView alloc] init];
    self.errorView.backgroundColor = background;
    self.errorView.hidden = YES;
    self.errorView.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:self.errorView];

    self.errorLabel = [[UILabel alloc] init];
    self.errorLabel.textColor = [GLTheme textPrimaryColor];
    self.errorLabel.font = [GLTheme bodyFont];
    self.errorLabel.textAlignment = NSTextAlignmentCenter;
    self.errorLabel.numberOfLines = 0;
    self.errorLabel.translatesAutoresizingMaskIntoConstraints = NO;

    UIButton *retryButton = [UIButton buttonWithType:UIButtonTypeSystem];
    [retryButton setTitle:@"Retry" forState:UIControlStateNormal];
    retryButton.titleLabel.font = [GLTheme buttonFont];
    [retryButton setTitleColor:UIColor.whiteColor forState:UIControlStateNormal];
    retryButton.backgroundColor = [GLTheme accentColor];
    retryButton.layer.cornerRadius = [GLTheme cornerRadius];
    [retryButton.heightAnchor constraintEqualToConstant:[GLTheme controlHeight]].active = YES;
    [retryButton addTarget:self
                     action:@selector(reloadTapped)
           forControlEvents:UIControlEventTouchUpInside];

    UIStackView *stack = [[UIStackView alloc] initWithArrangedSubviews:@[
        self.errorLabel, retryButton
    ]];
    stack.axis = UILayoutConstraintAxisVertical;
    stack.spacing = [GLTheme spacingL];
    stack.alignment = UIStackViewAlignmentCenter;
    stack.translatesAutoresizingMaskIntoConstraints = NO;
    [self.errorView addSubview:stack];

    UILayoutGuide *guide = self.errorView.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
        [self.errorView.topAnchor constraintEqualToAnchor:self.view.safeAreaLayoutGuide.topAnchor],
        [self.errorView.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
        [self.errorView.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
        [self.errorView.bottomAnchor constraintEqualToAnchor:self.view.bottomAnchor],

        [stack.centerXAnchor constraintEqualToAnchor:guide.centerXAnchor],
        [stack.centerYAnchor constraintEqualToAnchor:guide.centerYAnchor],
        [stack.leadingAnchor constraintGreaterThanOrEqualToAnchor:guide.leadingAnchor
                                                          constant:[GLTheme spacingL]],
        [stack.trailingAnchor constraintLessThanOrEqualToAnchor:guide.trailingAnchor
                                                         constant:-[GLTheme spacingL]],
    ]];
}

- (void)showErrorWithMessage:(NSString *)message {
    self.errorLabel.text = message;
    self.errorView.hidden = NO;
    [self.webView setHidden:YES];
}

- (void)hideError {
    self.errorView.hidden = YES;
    self.webView.hidden = NO;
}

#pragma mark - Loading

- (void)loadPage {
    [self loadPageUsingSavedShell:NO];
}

- (void)loadPageUsingSavedShell:(BOOL)savedShell {
    [self hideError];
    [self.loadingIndicator startAnimating];
    [self installBootUserScript];
    NSURL *url = [self themedWebURL];
    if (url.isFileURL) {
        [self.webView loadFileURL:url allowingReadAccessToURL:url.URLByDeletingLastPathComponent];
    } else {
        NSURLRequest *request = [NSURLRequest requestWithURL:url];
        if (savedShell) {
            self.shellLoader.prefersSavedShell = YES;
            [self.shellLoader loadPreferringSavedShell:request];
        } else {
            [self.shellLoader loadLiveRequest:request];
        }
    }

    // Fired AFTER the load above is already underway, using whatever
    // GLWebPageCacheActiveDirectory() returned synchronously a
    // few lines up — this call never blocks or delays first paint. When it
    // finds+verifies a newer set, the page reloads onto it straight away.
    // It used to wait for "the next -loadPage", but the More tab loads
    // exactly once per process and has no pull-to-refresh, so a fixed
    // more.html (the 2026-09-28 scroll + Growth-demo fix) never reached the
    // screen while iOS kept the app suspended rather than killed. No reload
    // loop: the reload's own check finds the version already current and
    // completes with NO. Gated on managedPageName so a future page type
    // doesn't start firing redundant checks just by existing.
    if (self.managedPageName) {
        __weak typeof(self) weakSelf = self;
        GLWebPageCacheCheckForUpdates(^(BOOL updated) {
            if (updated) [weakSelf loadPage];
        });
    }
}

- (void)goHome {
    [self loadPageUsingSavedShell:self.prefersSavedShell];
}

- (void)appWillEnterForeground {
    [self.shellLoader swapToLiveIfReachable];
}

- (void)reloadTapped {
    [self loadPage];
}

#pragma mark - Test hook

- (void)evaluateTestJavaScript:(NSString *)script
              completionHandler:(void (^)(id _Nullable, NSError *_Nullable))completionHandler {
    [self.webView evaluateJavaScript:script completionHandler:completionHandler];
}

#pragma mark - Native entry points into page-defined actions

// Same guard shape as -pushThemeToPageOrReload's `__glThemeChanged` push
// above, for a no-argument function instead of one taking a JSON payload --
// kept as a separate method rather than folded into that one so a native
// caller with no theme state to send doesn't have to fake an empty argument
// list.
- (void)callWebFunctionIfDefined:(NSString *)functionName {
    [self callWebFunctionIfDefined:functionName completion:nil];
}

- (void)callWebFunctionIfDefined:(NSString *)functionName withJSONArgument:(id)jsonArgument {
    [self callWebFunctionIfDefined:functionName withJSONArgument:jsonArgument completion:nil];
}

- (void)callWebFunctionIfDefined:(NSString *)functionName
                       completion:(void (^_Nullable)(BOOL ran))completion {
    // IIFE returning an explicit boolean -- the bare
    // `typeof window.X === 'function' && window.X()` guard evaluates to
    // whatever X() itself returns (often undefined), which a caller can't
    // reliably tell apart from "X didn't exist". A completion-reporting
    // caller needs to know specifically whether the call RAN.
    NSString *script = [NSString stringWithFormat:
        @"(function(){if(typeof window.%@==='function'){window.%@();return true;}return false;})();",
        functionName, functionName];
    [self evaluateGuardedScript:script completion:completion];
}

- (void)callWebFunctionIfDefined:(NSString *)functionName
                 withJSONArgument:(id)jsonArgument
                       completion:(void (^_Nullable)(BOOL ran))completion {
    NSError *error = nil;
    // FragmentsAllowed: the header promises this works for a bare
    // string/number argument too, not just an array/dictionary -- without
    // this option, -dataWithJSONObject: rejects anything whose top-level
    // object isn't an array or dictionary and silently returns nil, which
    // made this method a silent no-op for a fragment argument.
    NSData *data = [NSJSONSerialization dataWithJSONObject:jsonArgument
                                                     options:NSJSONWritingFragmentsAllowed
                                                       error:&error];
    if (!data) {
        if (completion) completion(NO);
        return;
    }
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    NSString *script = [NSString stringWithFormat:
        @"(function(){if(typeof window.%@==='function'){window.%@(%@);return true;}return false;})();",
        functionName, functionName, json];
    [self evaluateGuardedScript:script completion:completion];
}

// Shared by both completion-reporting overloads above. `result` comes back
// as an NSNumber wrapping the IIFE's JS boolean when evaluation succeeds; a
// thrown JS error, a torn-down page, or WKWebView simply not being ready all
// look the same from here: no completion, i.e. `ran == NO`.
- (void)evaluateGuardedScript:(NSString *)script completion:(void (^_Nullable)(BOOL ran))completion {
    if (!completion) {
        [self.webView evaluateJavaScript:script completionHandler:nil];
        return;
    }
    [self.webView evaluateJavaScript:script completionHandler:^(id result, NSError *error) {
        BOOL ran = !error && [result isKindOfClass:[NSNumber class]] && [(NSNumber *)result boolValue];
        completion(ran);
    }];
}

#pragma mark - WKUIDelegate

// target="_blank" (and window.open) ask for a new WKWebView; we don't host a
// second web view, so hand the URL to Safari instead of silently dropping it.
- (WKWebView *)webView:(WKWebView *)webView
    createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
               forNavigationAction:(WKNavigationAction *)navigationAction
                    windowFeatures:(WKWindowFeatures *)windowFeatures {
    if (!navigationAction.targetFrame || !navigationAction.targetFrame.isMainFrame) {
        NSURL *url = navigationAction.request.URL;
        if (url) {
            [UIApplication.sharedApplication openURL:url options:@{} completionHandler:nil];
        }
    }
    return nil;
}

#pragma mark - WKNavigationDelegate

// Keep plain link taps inside the SPA (so it doesn't get navigated away from
// under itself), but send anything pointing off-host — or a non-http(s)
// scheme like mailto:/tel: — out to Safari/the system instead.
//
// file:// is exempt from all of this: it is inherently local (there is no
// "off-host" for a bundled page) and routing it to
// UIApplication.openURL:options:completionHandler: would just fail silently
// (Safari can't open an app-bundle file URL), cancelling a same-page
// in-content link a bundled page might use. The initial loadFileURL:
// navigation that opens the page in the first place is WKNavigationTypeOther,
// not LinkActivated, so it never even reaches this branch.
- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction
                    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    if (navigationAction.navigationType == WKNavigationTypeLinkActivated) {
        NSURL *url = navigationAction.request.URL;
        NSString *scheme = url.scheme.lowercaseString;
        if ([scheme isEqualToString:@"file"]) {
            decisionHandler(WKNavigationActionPolicyAllow);
            return;
        }
        BOOL isHTTPFamily = [scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"];
        BOOL sameHost = isHTTPFamily && [url.host isEqualToString:[self webURL].host];
        if (!sameHost) {
            if (url) {
                [UIApplication.sharedApplication openURL:url options:@{} completionHandler:nil];
            }
            decisionHandler(WKNavigationActionPolicyCancel);
            return;
        }
    }
    decisionHandler(WKNavigationActionPolicyAllow);
}

- (void)webView:(WKWebView *)webView didCommitNavigation:(WKNavigation *)navigation {
    [self.shellLoader webView:webView didCommitNavigation:navigation];
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    [self.shellLoader webView:webView didFinishNavigation:navigation];
    [self hideError];
    [self.loadingIndicator stopAnimating];
    [self.refreshControl endRefreshing];
}

- (void)webView:(WKWebView *)webView
    didFailProvisionalNavigation:(WKNavigation *)navigation
                       withError:(NSError *)error {
    if ([self.shellLoader webView:webView didFailProvisionalNavigation:navigation withError:error]) return;
    [self.loadingIndicator stopAnimating];
    [self.refreshControl endRefreshing];
    [self showErrorWithMessage:[self unreachableMessageForError:error initialLoad:YES]];
}

- (void)webView:(WKWebView *)webView
    didFailNavigation:(WKNavigation *)navigation
             withError:(NSError *)error {
    BOOL consumed = [self.shellLoader webView:webView didFailNavigation:navigation withError:error];
    [self.loadingIndicator stopAnimating];
    [self.refreshControl endRefreshing];
    if (consumed) return;
    [self showErrorWithMessage:[self unreachableMessageForError:error initialLoad:NO]];
}

#pragma mark - GLOfflineShellLoaderDelegate

- (void)offlineShellLoaderDidShowShell:(GLOfflineShellLoader *)loader {
    [self hideError];
    [self.loadingIndicator stopAnimating];
    [self.refreshControl endRefreshing];
}

- (void)offlineShellLoader:(GLOfflineShellLoader *)loader didFailLiveLoad:(NSError *)error {
    [self.loadingIndicator stopAnimating];
    [self.refreshControl endRefreshing];
    [self showErrorWithMessage:[self unreachableMessageForError:error initialLoad:YES]];
}

// A bundled (file://) page's load can't fail because "you're not on the
// tailnet" -- that copy is specific to the HTTP(S) pages this class also
// wraps (Events, Todos, Journal's Recent-recordings page), and would be
// actively misleading for a page that never touched the network at all.
- (NSString *)unreachableMessageForError:(NSError *)error initialLoad:(BOOL)initialLoad {
    if ([self webURL].isFileURL) {
        return [NSString stringWithFormat:@"Couldn't load %@.\n\n%@",
                                           [self displayName], error.localizedDescription];
    }
    NSString *verb = initialLoad ? @"Couldn't reach" : @"Lost connection to";
    return [NSString stringWithFormat:@"%@ %@ at %@.\n\n"
                                        "Check that you're on the tailnet and the "
                                        "server is running.\n\n%@",
                                       verb, [self displayName], [self webURL], error.localizedDescription];
}

@end
