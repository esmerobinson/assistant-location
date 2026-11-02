#import "CycleViewController.h"

#import <LocalAuthentication/LocalAuthentication.h>
#import <WebKit/WebKit.h>

#import "CycleBridge.h"
#import "CycleSpeech.h"
#import "CycleWebUpdater.h"

@interface CycleViewController () <WKNavigationDelegate, WKScriptMessageHandler>
@property (nonatomic, strong) CycleBridge *bridge;
@property (nonatomic, strong) CycleSpeech *speech;
@property (nonatomic, strong) WKWebView *webView;
@property (nonatomic, strong) CycleWebUpdater *updater; // fetches newer web files for the next cold load
@property (nonatomic, strong) NSURL *webRoot, *bundleWeb, *loadedWeb; // downloaded copies, bundle floor, folder on screen
@property (nonatomic, assign) NSInteger shellVersion;
@property (nonatomic, strong) NSDate *backgroundedAt;
// Face ID lock. The cover hides the page (and the app-switcher snapshot) until auth succeeds.
@property (nonatomic, strong) UIView *cover;
@property (nonatomic, assign) BOOL needsAuth;          // YES until the first successful evaluation on this install
@property (nonatomic, assign) BOOL evaluating;         // the system sheet is up; its resign/become-active must not re-trigger anything
@property (nonatomic, assign) BOOL suppressAutoPrompt; // a prompt just failed/cancelled: wait for the Unlock tap or the next backgrounding
@end

@implementation CycleViewController

- (instancetype)initWithBridge:(CycleBridge *)bridge {
    if ((self = [super init])) _bridge = bridge;
    return self;
}

- (UIStatusBarStyle)preferredStatusBarStyle {
    return UIStatusBarStyleLightContent;
}

- (void)viewDidLoad {
    [super viewDidLoad];
    self.view.backgroundColor = UIColor.blackColor;

    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
    WKUserContentController *ucc = [[WKUserContentController alloc] init];
    [ucc addScriptMessageHandler:self name:@"cycle"];
    config.userContentController = ucc;

    self.webView = [[WKWebView alloc] initWithFrame:self.view.bounds configuration:config];
    self.webView.navigationDelegate = self;
    self.webView.opaque = NO;
    self.webView.backgroundColor = UIColor.blackColor;
    self.webView.allowsLinkPreview = NO;
    UIScrollView *scroll = self.webView.scrollView;
    scroll.backgroundColor = UIColor.blackColor;
    // The page handles safe areas itself (viewport-fit=cover, env(safe-area-inset-*)).
    scroll.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;
    scroll.bounces = NO;
    scroll.alwaysBounceVertical = NO;
    scroll.alwaysBounceHorizontal = NO;
    scroll.minimumZoomScale = 1;
    scroll.maximumZoomScale = 1;
    scroll.pinchGestureRecognizer.enabled = NO;
    self.webView.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:self.webView];
    [NSLayoutConstraint activateConstraints:@[
        [self.webView.topAnchor constraintEqualToAnchor:self.view.topAnchor],
        [self.webView.bottomAnchor constraintEqualToAnchor:self.view.bottomAnchor],
        [self.webView.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
        [self.webView.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
    ]];

    __weak typeof(self) weakSelf = self;
    self.bridge.openSettings = ^{ [UIApplication.sharedApplication openURL:[NSURL URLWithString:UIApplicationOpenSettingsURLString] options:@{} completionHandler:nil]; };
    self.bridge.setClipboard = ^(NSString *text) { UIPasteboard.generalPasteboard.string = text; };
    self.bridge.presentItems = ^(NSArray *items) {
        UIActivityViewController *sheet = [[UIActivityViewController alloc] initWithActivityItems:items applicationActivities:nil];
        // iPad needs an anchor; harmless on iPhone.
        sheet.popoverPresentationController.sourceView = weakSelf.view;
        sheet.popoverPresentationController.sourceRect = CGRectMake(CGRectGetMidX(weakSelf.view.bounds), CGRectGetMaxY(weakSelf.view.bounds), 0, 0);
        [weakSelf presentViewController:sheet animated:YES completion:nil];
    };
    self.bridge.evaluateJS = ^(NSString *js) {
        [weakSelf.webView evaluateJavaScript:js completionHandler:^(id r, NSError *e) {
            if (e) NSLog(@"[Cycle] script failed: %@\n%@", e, js);
        }];
    };

    self.speech = [[CycleSpeech alloc] init];
    CycleBridge *bridge = self.bridge;
    self.speech.onText = ^(NSString *text, BOOL final) { [bridge deliverSpeech:text final:final]; };
    self.speech.onError = ^(NSString *message) { [bridge deliverSpeechError:message]; };
    CycleSpeech *speech = self.speech;
    self.bridge.speechStart = ^(void (^done)(NSString *)) { [speech startWithCompletion:done]; };
    self.bridge.speechStop = ^{ [speech stop]; };
    self.bridge.lockChanged = ^{ [weakSelf lockSettingChanged]; };
    [self installCover];
    self.needsAuth = [CycleBridge lockNeedsAuth];
    if (self.needsAuth) self.cover.hidden = NO;
    NSNotificationCenter *nc = NSNotificationCenter.defaultCenter;
    [nc addObserver:self selector:@selector(appWillResignActive) name:UIApplicationWillResignActiveNotification object:nil];
    [nc addObserver:self selector:@selector(appDidEnterBackground) name:UIApplicationDidEnterBackgroundNotification object:nil];
    [nc addObserver:self selector:@selector(appDidBecomeActive) name:UIApplicationDidBecomeActiveNotification object:nil];

    // `web` is a folder reference, so it keeps its directory in the bundle. A downloaded copy (see
    // CycleWebUpdater) replaces it when newer; a fetched copy is shown from the next launch, or on
    // returning after a while away (appDidBecomeActive).
    NSURL *bundleWeb = [NSBundle.mainBundle.resourceURL URLByAppendingPathComponent:@"web" isDirectory:YES];
    NSURL *root = [[NSFileManager.defaultManager URLForDirectory:NSApplicationSupportDirectory inDomain:NSUserDomainMask appropriateForURL:nil create:YES error:NULL] URLByAppendingPathComponent:@"web-ota" isDirectory:YES];
    NSError *error = nil;
    BOOL made = [NSFileManager.defaultManager createDirectoryAtURL:root withIntermediateDirectories:YES attributes:nil error:&error];
    NSAssert(made, @"web-ota: %@", error);
    (void)made;
    NSInteger shell = [[NSBundle.mainBundle objectForInfoDictionaryKey:@"CycleShellVersion"] integerValue];
    NSURL *pageDir = [CycleWebUpdater pageDirectoryWithRoot:root bundleDirectory:bundleWeb shellVersion:shell];
    [CycleWebUpdater pruneRoot:root keepingDirectory:pageDir];
    NSURL *boxURL = [CycleWebUpdater boxURLFromConfigAtURL:[bundleWeb URLByAppendingPathComponent:@"config.js"]];
    if (boxURL) {
        self.updater = [[CycleWebUpdater alloc] initWithRoot:root bundleDirectory:bundleWeb boxURL:boxURL shellVersion:shell session:NSURLSession.sharedSession];
        [self.updater checkIfDue];
    }
    self.webRoot = root; self.bundleWeb = bundleWeb; self.shellVersion = shell;
    [self loadWebFrom:pageDir];
}

- (void)loadWebFrom:(NSURL *)pageDir {
    NSURL *page = [pageDir URLByAppendingPathComponent:@"index.html"];
    NSAssert([NSFileManager.defaultManager fileExistsAtPath:page.path], @"web/index.html missing from %@", pageDir.path);
    self.loadedWeb = pageDir;
    [self.webView loadFileURL:page allowingReadAccessToURL:pageDir];
}

// After 15+ minutes in the background nothing is mid-edit, so a newer downloaded copy is swapped in.
- (void)reloadIfNewerWebAfterLongAbsence {
    NSDate *away = self.backgroundedAt;
    self.backgroundedAt = nil;
    if (!away || -[away timeIntervalSinceNow] < 15 * 60) return;
    NSURL *pageDir = [CycleWebUpdater pageDirectoryWithRoot:self.webRoot bundleDirectory:self.bundleWeb shellVersion:self.shellVersion];
    if ([pageDir isEqual:self.loadedWeb]) return;
    NSLog(@"[Cycle] newer web copy after %.0f min away; reloading from %@", -[away timeIntervalSinceNow] / 60, pageDir.lastPathComponent);
    [self loadWebFrom:pageDir];
}

// ---- Face ID lock ---------------------------------------------------------------------------

- (void)installCover {
    UIView *cover = [[UIView alloc] initWithFrame:self.view.bounds];
    cover.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    cover.backgroundColor = UIColor.blackColor;
    cover.hidden = YES;
    UIButton *unlock = [UIButton buttonWithType:UIButtonTypeSystem];
    [unlock setTitle:@"Unlock" forState:UIControlStateNormal];
    [unlock setTitleColor:[UIColor colorWithRed:1 green:0.18 blue:0.533 alpha:1] forState:UIControlStateNormal];
    unlock.titleLabel.font = [UIFont systemFontOfSize:22 weight:UIFontWeightBold];
    unlock.frame = CGRectMake(0, 0, 200, 56);
    unlock.center = CGPointMake(CGRectGetMidX(cover.bounds), CGRectGetMidY(cover.bounds));
    unlock.autoresizingMask = UIViewAutoresizingFlexibleLeftMargin | UIViewAutoresizingFlexibleRightMargin | UIViewAutoresizingFlexibleTopMargin | UIViewAutoresizingFlexibleBottomMargin;
    [unlock addTarget:self action:@selector(unlockTapped) forControlEvents:UIControlEventTouchUpInside];
    [cover addSubview:unlock];
    [self.view addSubview:cover];
    self.cover = cover;
}

- (void)lockSettingChanged {
    if ([CycleBridge lockEnabled]) return; // takes effect at the next launch
    self.needsAuth = NO;
    self.cover.hidden = YES;
}

- (void)appWillResignActive {
    if (self.needsAuth) self.cover.hidden = NO;
}

- (void)appDidEnterBackground {
    [self.bridge speechInterrupted]; // not on resign-active: the permission prompts resign too and must not cancel the start
    self.suppressAutoPrompt = NO;
    self.backgroundedAt = [NSDate date];
}

- (void)appDidBecomeActive {
    [self reloadIfNewerWebAfterLongAbsence];
    [self.updater checkIfDue];
    if (self.evaluating) return;
    if (!self.needsAuth) { self.cover.hidden = YES; return; }
    self.cover.hidden = NO;
    if (!self.suppressAutoPrompt) [self evaluateLock];
}

- (void)unlockTapped {
    [self evaluateLock];
}

- (void)evaluateLock {
    if (self.evaluating) return;
    LAContext *ctx = [[LAContext alloc] init];
    NSError *err = nil;
    if (![ctx canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&err]) {
        NSLog(@"[Cycle] app lock disabled for this launch, device cannot authenticate: %@", err);
        self.needsAuth = NO;
        self.cover.hidden = YES;
        return;
    }
    self.evaluating = YES;
    [ctx evaluatePolicy:LAPolicyDeviceOwnerAuthentication localizedReason:@"Unlock Cycle" reply:^(BOOL ok, NSError *e) {
        dispatch_async(dispatch_get_main_queue(), ^{
            self.evaluating = NO;
            if (ok) { [CycleBridge markLockPassed]; self.needsAuth = NO; self.cover.hidden = YES; return; }
            NSLog(@"[Cycle] unlock failed: %@", e);
            self.suppressAutoPrompt = YES;
        });
    }];
}

- (void)userContentController:(WKUserContentController *)ucc didReceiveScriptMessage:(WKScriptMessage *)message {
    [self.bridge handleMessage:message.body];
}

- (void)webView:(WKWebView *)webView didStartProvisionalNavigation:(WKNavigation *)navigation {
    [self.bridge pageWillReload];
}

// iOS kills the web content process under memory pressure; the view then stays blank and dead. Reload the same page:
// everything the person typed was persisted through the native store (the page flushes on pagehide/visibility hidden).
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
    NSLog(@"[Cycle] web content process terminated; reloading");
    if (self.loadedWeb) [self loadWebFrom:self.loadedWeb];
    else [webView reload];
}

- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    NSLog(@"[Cycle] page navigation failed: %@", error);
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    NSLog(@"[Cycle] page load failed: %@", error);
}

@end
