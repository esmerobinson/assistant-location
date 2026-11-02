#import "AutoJournalViewController.h"

#import <AVFoundation/AVFoundation.h>
#import <PhotosUI/PhotosUI.h>

#import "BakedConfig.h"
#import "GLEndpoints.h"
#import "GLDropUploader.h"
#import "GLDurableOutboxShared.h"
#import "GLTheme.h"
#import "GLWebModuleViewController.h"
#import "GLModuleRegistry.h"
#import "GLCrashReporter.h"

static NSString *const kJournalStartCaptureNotification = @"GLJournalStartCapture";
static NSString *const kJournalStartTextEntryNotification = @"GLJournalStartTextEntry";
static NSString *const kJournalOpenRecentsNotification = @"GLJournalOpenRecents";
static NSString *const kNoteFieldPlaceholder = @"Type a short entry";

// Option B: the contextual attach row's layout/behavior constants.
static const NSUInteger kMaxAttachedPhotos = 5;
static const CGFloat kAttachRowHeight = 76;
static const CGFloat kAttachThumbnailSize = 60;

typedef NS_ENUM(NSInteger, AutoJournalRecordingState) {
    AutoJournalRecordingStateIdle,
    AutoJournalRecordingStateRecording,
    AutoJournalRecordingStatePaused,
};

@interface AutoJournalViewController () <AVAudioRecorderDelegate, UITextFieldDelegate, UITextViewDelegate,
                                          PHPickerViewControllerDelegate, UIImagePickerControllerDelegate,
                                          UINavigationControllerDelegate>

// In-content header (title + Recents entry point) — see -buildHeaderRow's
// doc comment for why this exists alongside, not instead of, the
// navigationItem set in -viewDidLoad.
@property(nonatomic, assign) NSUInteger handoffRetries;
@property(nonatomic, strong) UILabel *headerTitleLabel;
@property(nonatomic, strong) UIButton *headerRecentsButton;

@property(nonatomic, strong) UISegmentedControl *modeControl;
@property(nonatomic, strong) UITextField *titleField;
@property(nonatomic, strong) UILabel *draftBannerLabel;

// "Save as tweet" row (mockup-recording-option-3.html, approved design).
// Shared between Voice and Text modes -- built in -buildModeToggleAndTitleField,
// not added to voiceModeViews/textModeViews, so it stays visible across the
// mode toggle. See -tweetSwitchChanged: and the Upload section below for the
// one-shot behavior and the record-time-vs-upload-time capture rationale.
@property(nonatomic, strong) UIView *tweetSwitchRow;
@property(nonatomic, strong) UISwitch *tweetSwitch;
// "About Esme" row, directly under the tweet row; same semantics (Voice and
// Text modes, one-shot, captured at save/retry start, persisted in the draft).
@property(nonatomic, strong) UIView *esmeSwitchRow;
@property(nonatomic, strong) UISwitch *esmeSwitch;

@property(nonatomic, strong) UITextView *noteTextView;
@property(nonatomic, strong) UIButton *saveNoteButton;
// Explicit state for whether noteTextView currently holds the placeholder
// copy vs. a real entry -- replaces comparing noteTextView.textColor against
// a sentinel colour, which broke once the colour itself became a themed
// token instead of a fixed system constant.
@property(nonatomic, assign) BOOL noteTextViewShowingPlaceholder;

@property(nonatomic, strong) UIButton *recordButton;
@property(nonatomic, strong) UILabel *elapsedLabel;
@property(nonatomic, strong) UILabel *statusLabel;
@property(nonatomic, strong) UIButton *retryButton;
@property(nonatomic, strong) UIButton *cancelButton;
@property(nonatomic, strong) UIButton *saveButton;

@property(nonatomic, strong) NSArray<UIView *> *voiceModeViews;
@property(nonatomic, strong) NSArray<UIView *> *textModeViews;

@property(nonatomic, strong) AVAudioRecorder *recorder;
@property(nonatomic, strong) NSTimer *elapsedTimer;
@property(nonatomic, assign) NSTimeInterval currentSegmentStartTime;
@property(nonatomic, assign) NSTimeInterval accumulatedElapsed;
@property(nonatomic, strong) NSMutableArray<NSString *> *segmentPaths;
@property(nonatomic, strong) NSDate *draftStartDate;
@property(nonatomic, assign) BOOL restoredFromDraft;
@property(nonatomic, assign) BOOL discardingSegment;
@property(nonatomic, assign) AutoJournalRecordingState recordingState;

@property(nonatomic, copy) NSString *pendingRetryPath;
@property(nonatomic, assign) BOOL pendingRetryIsVoice;
@property(nonatomic, copy) NSString *pendingRetryTitleSlug;
// The failed attempt's timestamp: a retry reuses it so the entry still groups
// with its photos, which were staged in the outbox under it at save time.
@property(nonatomic, copy) NSString *pendingRetryTimestamp;
// Snapshot of tweetSwitch.isOn taken at the moment THIS specific upload
// attempt started (see -uploadFileAtPath:...), not re-read from the switch
// on retry -- the switch may have moved on to arm a DIFFERENT future entry
// by the time a failed upload is retried, and that must not leak backwards
// onto this one.
@property(nonatomic, assign) BOOL pendingRetryIsTweet;
// Same snapshot rule as pendingRetryIsTweet, for the "About Esme" switch.
@property(nonatomic, assign) BOOL pendingRetryIsEsme;
@property(nonatomic, assign) BOOL autoStartOnPermissionGranted;

// Option B — contextual attach row (photos). See -buildAttachRow for the
// layout and -stageAttachedPhotosWithTimestamp:titleSlug:error: for the
// upload contract.
@property(nonatomic, strong) NSMutableArray<UIImage *> *attachedPhotos;
@property(nonatomic, strong) UIView *attachRow;
@property(nonatomic, strong) UIButton *addPhotoButton;
@property(nonatomic, strong) UIScrollView *attachScrollView;
@property(nonatomic, strong) UIStackView *attachStackView;
@property(nonatomic, strong) NSLayoutConstraint *attachRowHeightConstraint;
@property(nonatomic, strong) NSArray<NSLayoutConstraint *> *attachRowVoiceConstraints;
@property(nonatomic, strong) NSArray<NSLayoutConstraint *> *attachRowTextConstraints;

@end

@implementation AutoJournalViewController

- (instancetype)init {
    self = [super init];
    if (self) {
        // Registered here, not in -viewDidLoad: a background tab's view may
        // not have loaded yet when the app cold-launches from the lock-screen
        // Control, but every module's +makeViewController (and therefore this
        // initializer) runs at launch before the intent's notification can
        // fire, whether that's a cold launch or a foreground handoff.
        [[NSNotificationCenter defaultCenter] addObserver:self
                                                  selector:@selector(handleStartCaptureNotification)
                                                      name:kJournalStartCaptureNotification
                                                    object:nil];
        [[NSNotificationCenter defaultCenter] addObserver:self
                                                  selector:@selector(handleStartTextEntryNotification)
                                                      name:kJournalStartTextEntryNotification
                                                    object:nil];
        // Test hook only today (SceneDelegate's UITEST_JOURNAL_RECENTS, see
        // sim-test.yml's "recents" target) -- same registration pattern as
        // the two lock-screen-Control observers above, so a future non-test
        // caller (e.g. a Siri shortcut for "show my recent journal entries")
        // costs nothing extra to add.
        [[NSNotificationCenter defaultCenter] addObserver:self
                                                  selector:@selector(handleOpenRecentsNotification)
                                                      name:kJournalOpenRecentsNotification
                                                    object:nil];
        [[NSNotificationCenter defaultCenter] addObserver:self
                                                  selector:@selector(outboxDidReject:)
                                                      name:GLDurableOutboxDidRejectNotification
                                                    object:nil];
        self.segmentPaths = [NSMutableArray array];
        self.recordingState = AutoJournalRecordingStateIdle;
        self.attachedPhotos = [NSMutableArray array];
    }
    return self;
}

- (void)dealloc {
    [[NSNotificationCenter defaultCenter] removeObserver:self];
}

#pragma mark - Layout

- (void)viewDidLoad {
    [super viewDidLoad];
    [GLTheme applyBackgroundToView:self.view];
    self.title = @"Journal";

    // Costs nothing and is what draws whenever Journal is reached through a
    // navigation controller that DOES show its bar. See -buildHeaderRow for
    // the case (Journal reached as an overflow/"More" tab) where nothing
    // draws this at all.
    self.navigationItem.rightBarButtonItem = [[UIBarButtonItem alloc]
        initWithImage:[UIImage systemImageNamed:@"clock.arrow.circlepath"]
                style:UIBarButtonItemStylePlain
               target:self
               action:@selector(recentTapped)];

    [self buildHeaderRow];
    [self buildModeToggleAndTitleField];
    [self buildRecorderUI];
    [self buildTextEntryUI];
    [self buildAttachRow];

    [self modeChanged:nil];
    [self updateUIForState];
    [self loadDraftIfPresent];

    // A tap anywhere outside the fields puts the keyboard away.
    UITapGestureRecognizer *tap = [[UITapGestureRecognizer alloc] initWithTarget:self.view
                                                                          action:@selector(endEditing:)];
    tap.cancelsTouchesInView = NO;
    [self.view addGestureRecognizer:tap];
}

- (void)viewWillDisappear:(BOOL)animated {
    [super viewWillDisappear:animated];
    // Leaving the tab (swipe back to More, tab switch) with the keyboard up
    // used to strand it there; resign before the transition starts.
    [self.view endEditing:YES];
}

- (void)recentTapped {
    [self.navigationController pushViewController:[self makeRecentsWebViewController] animated:YES];
}

// Managed, not HTTP-loaded, as of the web-page asset-update task: recents.html
// used to live only on location-server (http://GL_BAKED_HOST:8302/recents.html),
// so opening this tab with no network reachable to that host showed nothing
// but GLWebModuleViewController's error view -- the SHELL (header, list
// layout, empty/error states) has no real reason to need a live round trip,
// only the recordings DATA does. It now ships in the bundle (Modules/WebPages/
// recents.html) like More/Settings, loads instantly from
// GLWebPageCache's best local copy, and only its own fetch to
// "<apiBase>/journal/recordings" (see that file's apiBase() helper, fed by
// GLWebModuleViewController's boot injection) still needs location-server
// reachable -- and shows ITS OWN "Couldn't load recordings" error state,
// not this VC's, when it isn't.
- (UIViewController *)makeRecentsWebViewController {
    GLWebModuleViewController *vc =
        [[GLWebModuleViewController alloc] initWithManagedPageNamed:@"recents.html"];
    return vc;
}

// Test hook (SceneDelegate's UITEST_JOURNAL_RECENTS) -- broadcast rather
// than a direct call, same reason as -handleStartCaptureNotification /
// -handleStartTextEntryNotification: SceneDelegate has no reference to this
// particular AutoJournalViewController instance, only to the tab bar.
- (void)handleOpenRecentsNotification {
    if (!self.tabBarController) {
        [self retryLockScreenHandoff:@selector(handleOpenRecentsNotification)];
        return;
    }
    self.handoffRetries = 0;
    [self selectJournalTab];
    [self recentTapped];
}

// Journal is registered past the 4-tab visible limit (Modules/
// GLModuleRegistry.m), so it is opened through the More web page's
// `openModule` bridge call (Modules/WebBridge/GLWebBridge.m ->
// +[GLModuleRegistry openOverflowModuleWithIdentifier:]), which pushes it onto
// the shared More stack. GLMoreStackCoordinator hides that stack's navigation
// bar on every screen in it, deliberately (the user: "there's an extra header
// at the top with a back button. That shouldn't happen."), so the
// `rightBarButtonItem` set in -viewDidLoad has nowhere to draw and the
// Recent-recordings entry point would be unreachable.
//
// Fixed with an in-content header row instead of a navigation bar.
// `self.navigationController` is the More stack itself, which accepts the
// push in -recentTapped. After a back-swipe pops Journal off that stack both
// navigationController and tabBarController are nil until it is pushed again.
- (void)buildHeaderRow {
    self.headerTitleLabel = [[UILabel alloc] init];
    self.headerTitleLabel.text = @"Journal";
    self.headerTitleLabel.font = [GLTheme titleFont];
    self.headerTitleLabel.textColor = [GLTheme textPrimaryColor];
    self.headerTitleLabel.accessibilityIdentifier = @"AutoJournalHeaderTitle";
    self.headerTitleLabel.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:self.headerTitleLabel];

    self.headerRecentsButton = [UIButton buttonWithType:UIButtonTypeSystem];
    [self.headerRecentsButton setImage:[UIImage systemImageNamed:@"clock.arrow.circlepath"]
                               forState:UIControlStateNormal];
    self.headerRecentsButton.tintColor = [GLTheme accentColor];
    [self.headerRecentsButton addTarget:self
                                  action:@selector(recentTapped)
                        forControlEvents:UIControlEventTouchUpInside];
    self.headerRecentsButton.accessibilityIdentifier = @"AutoJournalHeaderRecentsButton";
    self.headerRecentsButton.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:self.headerRecentsButton];

    UILayoutGuide *guide = self.view.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
        [self.headerTitleLabel.topAnchor constraintEqualToAnchor:guide.topAnchor constant:12],
        [self.headerTitleLabel.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor constant:20],

        [self.headerRecentsButton.centerYAnchor constraintEqualToAnchor:self.headerTitleLabel.centerYAnchor],
        [self.headerRecentsButton.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor constant:-20],
        [self.headerRecentsButton.leadingAnchor constraintGreaterThanOrEqualToAnchor:self.headerTitleLabel.trailingAnchor
                                                                             constant:8],
    ]];
}

- (void)buildModeToggleAndTitleField {
    self.modeControl = [[UISegmentedControl alloc] initWithItems:@[@"Voice", @"Text"]];
    self.modeControl.selectedSegmentIndex = 0;
    [self.modeControl addTarget:self
                          action:@selector(modeChanged:)
                forControlEvents:UIControlEventValueChanged];
    self.modeControl.accessibilityIdentifier = @"AutoJournalModeToggle";
    self.modeControl.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:self.modeControl];

    self.titleField = [[UITextField alloc] init];
    self.titleField.borderStyle = UITextBorderStyleRoundedRect;
    self.titleField.returnKeyType = UIReturnKeyDone;
    self.titleField.delegate = self;
    // Themed rather than left stock: an unthemed UITextBorderStyleRoundedRect
    // draws its own opaque near-white background regardless of the app's
    // colour tokens, so it rendered as a stark white box against any themed
    // (peach/purple/whatever) page background. backgroundColor/textColor/
    // font come from the same tokens every other themed control in this
    // file uses; the placeholder needs its OWN attributed colour because
    // UITextField.placeholder (a plain NSString) always draws in the
    // system's own dim grey with no token to override it.
    self.titleField.backgroundColor = [GLTheme surfaceColor];
    self.titleField.textColor = [GLTheme textPrimaryColor];
    self.titleField.font = [GLTheme bodyFont];
    self.titleField.attributedPlaceholder =
        [[NSAttributedString alloc] initWithString:@"Title (optional)"
                                         attributes:@{ NSForegroundColorAttributeName: [GLTheme textSecondaryColor] }];
    self.titleField.accessibilityIdentifier = @"AutoJournalTitleField";
    self.titleField.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:self.titleField];

    self.draftBannerLabel = [[UILabel alloc] init];
    self.draftBannerLabel.font = [GLTheme captionFont];
    // No "warning" token exists in GLTheme (only accent/destructive) --
    // destructiveColor is reserved for the record/cancel affordances below,
    // so accentColor is the closest fit for "this needs your attention".
    self.draftBannerLabel.textColor = [GLTheme accentColor];
    self.draftBannerLabel.textAlignment = NSTextAlignmentCenter;
    self.draftBannerLabel.numberOfLines = 0;
    self.draftBannerLabel.hidden = YES;
    self.draftBannerLabel.accessibilityIdentifier = @"AutoJournalDraftBanner";
    self.draftBannerLabel.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:self.draftBannerLabel];

    // "Save as tweet" settings-style row (mockup-recording-option-3.html,
    // Oliver-approved). A plain UIView rather than GLComponents, since none
    // of that shared kit offers a labeled-switch row -- surfaceColor/
    // cornerRadius/textSecondaryColor below are the same tokens every other
    // themed row in this file already uses (see noteTextView's border above).
    self.tweetSwitchRow = [[UIView alloc] init];
    self.tweetSwitchRow.backgroundColor = [GLTheme surfaceColor];
    self.tweetSwitchRow.layer.cornerRadius = [GLTheme cornerRadius];
    self.tweetSwitchRow.layer.borderWidth = 1;
    self.tweetSwitchRow.layer.borderColor = [GLTheme textSecondaryColor].CGColor;
    self.tweetSwitchRow.accessibilityIdentifier = @"AutoJournalTweetSwitchRow";
    self.tweetSwitchRow.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:self.tweetSwitchRow];

    UILabel *tweetLabel = [[UILabel alloc] init];
    tweetLabel.text = @"Save as tweet";
    tweetLabel.font = [GLTheme bodyFont];
    tweetLabel.textColor = [GLTheme textPrimaryColor];
    tweetLabel.translatesAutoresizingMaskIntoConstraints = NO;
    [self.tweetSwitchRow addSubview:tweetLabel];

    self.tweetSwitch = [[UISwitch alloc] init];
    self.tweetSwitch.onTintColor = [GLTheme accentColor];
    // One-shot per the approved design: this only ARMS the next successful
    // upload (voice or text) -- see -uploadFileAtPath:... for where it's read
    // and switched back off, and -tweetSwitchChanged: for the live recording
    // indicator this drives while armed.
    [self.tweetSwitch addTarget:self
                          action:@selector(tweetSwitchChanged:)
                forControlEvents:UIControlEventValueChanged];
    self.tweetSwitch.accessibilityIdentifier = @"AutoJournalTweetSwitch";
    self.tweetSwitch.translatesAutoresizingMaskIntoConstraints = NO;
    [self.tweetSwitchRow addSubview:self.tweetSwitch];

    // "About Esme" row: same look as the tweet row, one row below it.
    self.esmeSwitchRow = [[UIView alloc] init];
    self.esmeSwitchRow.backgroundColor = [GLTheme surfaceColor];
    self.esmeSwitchRow.layer.cornerRadius = [GLTheme cornerRadius];
    self.esmeSwitchRow.layer.borderWidth = 1;
    self.esmeSwitchRow.layer.borderColor = [GLTheme textSecondaryColor].CGColor;
    self.esmeSwitchRow.accessibilityIdentifier = @"AutoJournalEsmeSwitchRow";
    self.esmeSwitchRow.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:self.esmeSwitchRow];

    UILabel *esmeLabel = [[UILabel alloc] init];
    esmeLabel.text = @"About Esme";
    esmeLabel.font = [GLTheme bodyFont];
    esmeLabel.textColor = [GLTheme textPrimaryColor];
    esmeLabel.translatesAutoresizingMaskIntoConstraints = NO;
    [self.esmeSwitchRow addSubview:esmeLabel];

    self.esmeSwitch = [[UISwitch alloc] init];
    self.esmeSwitch.onTintColor = [GLTheme accentColor];
    self.esmeSwitch.accessibilityIdentifier = @"AutoJournalEsmeSwitch";
    self.esmeSwitch.translatesAutoresizingMaskIntoConstraints = NO;
    [self.esmeSwitchRow addSubview:self.esmeSwitch];

    UILayoutGuide *guide = self.view.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
        [self.modeControl.topAnchor constraintEqualToAnchor:self.headerTitleLabel.bottomAnchor constant:16],
        [self.modeControl.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor constant:20],
        [self.modeControl.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor constant:-20],

        [self.titleField.topAnchor constraintEqualToAnchor:self.modeControl.bottomAnchor constant:16],
        [self.titleField.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor constant:20],
        [self.titleField.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor constant:-20],

        [self.draftBannerLabel.topAnchor constraintEqualToAnchor:self.titleField.bottomAnchor constant:10],
        [self.draftBannerLabel.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor constant:20],
        [self.draftBannerLabel.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor constant:-20],

        [self.tweetSwitchRow.topAnchor constraintEqualToAnchor:self.draftBannerLabel.bottomAnchor constant:12],
        [self.tweetSwitchRow.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor constant:20],
        [self.tweetSwitchRow.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor constant:-20],
        [self.tweetSwitchRow.heightAnchor constraintEqualToConstant:[GLTheme controlHeight]],

        [tweetLabel.leadingAnchor constraintEqualToAnchor:self.tweetSwitchRow.leadingAnchor constant:14],
        [tweetLabel.centerYAnchor constraintEqualToAnchor:self.tweetSwitchRow.centerYAnchor],

        [self.tweetSwitch.trailingAnchor constraintEqualToAnchor:self.tweetSwitchRow.trailingAnchor constant:-14],
        [self.tweetSwitch.centerYAnchor constraintEqualToAnchor:self.tweetSwitchRow.centerYAnchor],
        [self.tweetSwitch.leadingAnchor constraintGreaterThanOrEqualToAnchor:tweetLabel.trailingAnchor constant:8],

        [self.esmeSwitchRow.topAnchor constraintEqualToAnchor:self.tweetSwitchRow.bottomAnchor constant:8],
        [self.esmeSwitchRow.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor constant:20],
        [self.esmeSwitchRow.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor constant:-20],
        [self.esmeSwitchRow.heightAnchor constraintEqualToConstant:[GLTheme controlHeight]],

        [esmeLabel.leadingAnchor constraintEqualToAnchor:self.esmeSwitchRow.leadingAnchor constant:14],
        [esmeLabel.centerYAnchor constraintEqualToAnchor:self.esmeSwitchRow.centerYAnchor],

        [self.esmeSwitch.trailingAnchor constraintEqualToAnchor:self.esmeSwitchRow.trailingAnchor constant:-14],
        [self.esmeSwitch.centerYAnchor constraintEqualToAnchor:self.esmeSwitchRow.centerYAnchor],
        [self.esmeSwitch.leadingAnchor constraintGreaterThanOrEqualToAnchor:esmeLabel.trailingAnchor constant:8],
    ]];
}

- (void)buildRecorderUI {
    self.recordButton = [UIButton buttonWithType:UIButtonTypeSystem];
    [self.recordButton setImage:[UIImage systemImageNamed:@"mic.circle.fill"]
                        forState:UIControlStateNormal];
    self.recordButton.tintColor = [GLTheme destructiveColor]; // recording affordance
    self.recordButton.contentVerticalAlignment = UIControlContentVerticalAlignmentFill;
    self.recordButton.contentHorizontalAlignment = UIControlContentHorizontalAlignmentFill;
    self.recordButton.imageView.contentMode = UIViewContentModeScaleAspectFit;
    [self.recordButton addTarget:self
                           action:@selector(recordButtonTapped)
                 forControlEvents:UIControlEventTouchUpInside];
    self.recordButton.accessibilityIdentifier = @"AutoJournalRecordButton";
    self.recordButton.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:self.recordButton];

    self.elapsedLabel = [[UILabel alloc] init];
    self.elapsedLabel.text = @"00:00";
    self.elapsedLabel.font = [UIFont monospacedDigitSystemFontOfSize:28 weight:UIFontWeightRegular];
    self.elapsedLabel.textAlignment = NSTextAlignmentCenter;
    self.elapsedLabel.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:self.elapsedLabel];

    self.statusLabel = [[UILabel alloc] init];
    self.statusLabel.text = @"Tap to record";
    self.statusLabel.font = [GLTheme captionFont];
    self.statusLabel.textColor = [GLTheme textSecondaryColor];
    self.statusLabel.textAlignment = NSTextAlignmentCenter;
    self.statusLabel.numberOfLines = 0;
    self.statusLabel.translatesAutoresizingMaskIntoConstraints = NO;
    // Lets XCUITest assert on recording state (text goes "Tap to record" ->
    // "Recording…" once startRecording actually runs) without fragile
    // text-matching on the accessibility tree.
    self.statusLabel.accessibilityIdentifier = @"AutoJournalStatusLabel";
    [self.view addSubview:self.statusLabel];

    self.retryButton = [UIButton buttonWithType:UIButtonTypeSystem];
    [self.retryButton setTitle:@"Retry upload" forState:UIControlStateNormal];
    self.retryButton.titleLabel.font = [UIFont boldSystemFontOfSize:17];
    self.retryButton.tintColor = [GLTheme accentColor]; // was stock system blue
    [self.retryButton addTarget:self
                          action:@selector(retryTapped)
                forControlEvents:UIControlEventTouchUpInside];
    self.retryButton.hidden = YES;
    self.retryButton.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:self.retryButton];

    self.cancelButton = [UIButton buttonWithType:UIButtonTypeSystem];
    [self.cancelButton setTitle:@"Cancel" forState:UIControlStateNormal];
    self.cancelButton.titleLabel.font = [GLTheme bodyFont];
    self.cancelButton.tintColor = [GLTheme destructiveColor]; // discards the recording
    [self.cancelButton addTarget:self
                           action:@selector(cancelButtonTapped)
                 forControlEvents:UIControlEventTouchUpInside];
    self.cancelButton.hidden = YES;
    self.cancelButton.accessibilityIdentifier = @"AutoJournalCancelButton";
    self.cancelButton.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:self.cancelButton];

    self.saveButton = [UIButton buttonWithType:UIButtonTypeSystem];
    [self.saveButton setTitle:@"Save" forState:UIControlStateNormal];
    self.saveButton.titleLabel.font = [UIFont boldSystemFontOfSize:17];
    [self.saveButton addTarget:self
                         action:@selector(saveButtonTapped)
               forControlEvents:UIControlEventTouchUpInside];
    self.saveButton.hidden = YES;
    self.saveButton.accessibilityIdentifier = @"AutoJournalSaveButton";
    self.saveButton.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:self.saveButton];

    UILayoutGuide *guide = self.view.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
        [self.recordButton.centerXAnchor constraintEqualToAnchor:guide.centerXAnchor],
        [self.recordButton.centerYAnchor constraintEqualToAnchor:guide.centerYAnchor],
        [self.recordButton.widthAnchor constraintEqualToConstant:120],
        [self.recordButton.heightAnchor constraintEqualToConstant:120],

        [self.elapsedLabel.topAnchor constraintEqualToAnchor:self.recordButton.bottomAnchor
                                                      constant:20],
        [self.elapsedLabel.centerXAnchor constraintEqualToAnchor:guide.centerXAnchor],

        [self.statusLabel.topAnchor constraintEqualToAnchor:self.elapsedLabel.bottomAnchor
                                                     constant:12],
        [self.statusLabel.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor constant:32],
        [self.statusLabel.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor constant:-32],

        [self.retryButton.topAnchor constraintEqualToAnchor:self.statusLabel.bottomAnchor
                                                     constant:16],
        [self.retryButton.centerXAnchor constraintEqualToAnchor:guide.centerXAnchor],

        // cancelButton/saveButton's top anchors are set in -buildAttachRow
        // (attachRowVoiceConstraints), which slots the attach row between
        // retryButton and this row.
        [self.cancelButton.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor constant:40],
        [self.cancelButton.widthAnchor constraintEqualToConstant:100],

        [self.saveButton.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor constant:-40],
        [self.saveButton.widthAnchor constraintEqualToConstant:100],
    ]];

    self.voiceModeViews = @[
        self.recordButton, self.elapsedLabel, self.statusLabel,
        self.retryButton, self.cancelButton, self.saveButton
    ];
}

- (void)buildTextEntryUI {
    self.noteTextView = [[UITextView alloc] init];
    self.noteTextView.font = [GLTheme bodyFont];
    // UITextView draws no background of its own -- without this it showed
    // the page's own (themed) background straight through, with only the
    // 1pt border below to mark its edges, which read as unthemed/undressed
    // next to the titleField right above it once THAT got a surface fill.
    self.noteTextView.backgroundColor = [GLTheme surfaceColor];
    self.noteTextView.layer.borderColor = [GLTheme textSecondaryColor].CGColor;
    self.noteTextView.layer.borderWidth = 1;
    self.noteTextView.layer.cornerRadius = [GLTheme cornerRadius];
    self.noteTextView.text = kNoteFieldPlaceholder;
    self.noteTextView.textColor = [GLTheme textSecondaryColor];
    self.noteTextViewShowingPlaceholder = YES;
    self.noteTextView.delegate = self;
    // Return inserts a newline, so any drag on the field is the way out.
    self.noteTextView.alwaysBounceVertical = YES;
    self.noteTextView.keyboardDismissMode = UIScrollViewKeyboardDismissModeOnDrag;
    self.noteTextView.accessibilityIdentifier = @"AutoJournalNoteTextView";
    self.noteTextView.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:self.noteTextView];

    self.saveNoteButton = [UIButton buttonWithType:UIButtonTypeSystem];
    [self.saveNoteButton setTitle:@"Save" forState:UIControlStateNormal];
    self.saveNoteButton.titleLabel.font = [UIFont boldSystemFontOfSize:17];
    [self.saveNoteButton addTarget:self
                             action:@selector(saveNoteTapped)
                   forControlEvents:UIControlEventTouchUpInside];
    self.saveNoteButton.accessibilityIdentifier = @"AutoJournalTextSaveButton";
    self.saveNoteButton.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:self.saveNoteButton];

    UILayoutGuide *guide = self.view.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
        // Anchored off esmeSwitchRow, not draftBannerLabel directly -- the
        // switch rows (shared between Voice/Text, see
        // -buildModeToggleAndTitleField) always sit between them now.
        [self.noteTextView.topAnchor constraintEqualToAnchor:self.esmeSwitchRow.bottomAnchor
                                                      constant:16],
        [self.noteTextView.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor constant:20],
        [self.noteTextView.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor constant:-20],
        // noteTextView's bottom anchor is set in -buildAttachRow
        // (attachRowTextConstraints), which slots the attach row between
        // the note field and this button.

        // Rides above the keyboard (the guide sits on the safe-area bottom
        // when it is hidden); pinned to the safe area, the keyboard covered
        // Save and a long paste left no way to save or dismiss.
        [self.saveNoteButton.bottomAnchor constraintEqualToAnchor:self.view.keyboardLayoutGuide.topAnchor constant:-24],
        [self.saveNoteButton.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor constant:-20],
    ]];

    self.textModeViews = @[self.noteTextView, self.saveNoteButton];
}

#pragma mark - Mode toggle

- (void)modeChanged:(UISegmentedControl *)sender {
    BOOL isVoice = self.modeControl.selectedSegmentIndex == 0;
    for (UIView *view in self.voiceModeViews) view.hidden = !isVoice;
    for (UIView *view in self.textModeViews) view.hidden = isVoice;
    self.draftBannerLabel.hidden = !(isVoice && self.restoredFromDraft);

    // The attach row (Option B) is one shared view pinned in a different
    // slot per mode -- swap which constraint set is live rather than
    // fighting both at once. See -buildAttachRow.
    if (isVoice) {
        [NSLayoutConstraint deactivateConstraints:self.attachRowTextConstraints];
        [NSLayoutConstraint activateConstraints:self.attachRowVoiceConstraints];
    } else {
        [NSLayoutConstraint deactivateConstraints:self.attachRowVoiceConstraints];
        [NSLayoutConstraint activateConstraints:self.attachRowTextConstraints];
    }

    if (isVoice) {
        // Re-derives cancel/save visibility and the record button's icon
        // from the current recording state, which modeChanged doesn't know
        // about on its own.
        [self updateUIForState];
    }
    [self updateAttachRowVisibility];
}

#pragma mark - Lock-screen Control handoff

// On a cold launch (app was terminated, tapping the lock-screen Control
// launches it), openAppWhenRun's perform() can post this notification
// before SceneDelegate has finished installing the tab bar
// (installIntoTabBarController runs in scene:willConnectToSession:, but
// nothing guarantees AppIntents waits for that specific step before
// calling perform() — only that the app is "active"). Retrying instead of
// silently no-op'ing when self.tabBarController is still nil covers that
// race; a plain UI test can't reproduce it because it can only simulate
// the notification with a fixed delay long after the scene is fully
// active, not at the actual moment a real cold launch would post it.
// TEMPORARY diagnostic — remove once the cold-launch tab-switch bug is
// confirmed fixed or its real cause is found. Two rounds of manual device
// testing (a plain reinstall, then a reinstall with the tabBarController-nil
// retry fix below) both still failed with no visible signal about WHERE in
// the chain it's breaking, and AWS Device Farm's resign step is broken for
// an unrelated, unresolved reason (see memory: overland-devicefarm-
// resigning-fix.md) so there's no automated way to get a trace either. This
// alert proves, in one manual test, whether the notification handler is
// even being called and what state it sees when it is.
// Fire-and-forget GET to location-server's /debug-log (see server.mjs) so
// the sequence of what actually happened is visible live via
// `journalctl --user -u assistant-location -f`, without needing the phone's
// screen at all. Errors are deliberately swallowed — a debug call can never
// be allowed to affect the real flow it's instrumenting.
- (void)journalDebugLog:(NSString *)message {
    // GLEndpointURL raises when GL_BAKED_HOST is unbaked (always true for
    // sim-test's CI build), which contradicts this method's own contract
    // above ("errors are deliberately swallowed") — an uncaught raise here
    // crashes the app it's meant to only be observing. Guard on the actual
    // precondition explicitly and return, same as SceneDelegate's
    // GLSceneDebugLog — no @try/@catch, so a real bug in this path still
    // surfaces instead of vanishing into a generic swallow.
    if (GL_BAKED_HOST.length == 0 || [GL_BAKED_HOST isEqualToString:@"NO_HOST_BAKED_IN"]) {
        NSLog(@"journalDebugLog: inert, GL_BAKED_HOST is unbaked");
        return;
    }
    NSString *encoded = [message stringByAddingPercentEncodingWithAllowedCharacters:
                          [NSCharacterSet URLQueryAllowedCharacterSet]];
    NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"?msg=%@", encoded]
                         relativeToURL:GLEndpointURL(@"/debug-log")];
    NSURLSessionDataTask *task = [[NSURLSession sharedSession] dataTaskWithURL:url];
    [task resume];
}

- (void)handleStartCaptureNotification {
    [self journalDebugLog:[NSString stringWithFormat:@"handleStartCaptureNotification fired. tabBarController=%@ navController=%@ recordingState=%ld",
                            self.tabBarController ? @"present" : @"NIL",
                            self.navigationController ? @"present" : @"NIL",
                            (long)self.recordingState]];
    if (!self.tabBarController) {
        [self journalDebugLog:@"tabBarController nil -> retrying in 0.2s"];
        [self retryLockScreenHandoff:@selector(handleStartCaptureNotification)];
        return;
    }
    self.handoffRetries = 0;
    [self selectJournalTab];
    self.modeControl.selectedSegmentIndex = 0;
    [self modeChanged:nil];

    if (self.recordingState != AutoJournalRecordingStateIdle) {
        [self journalDebugLog:[NSString stringWithFormat:@"recordingState=%ld, not idle -> skipping beginRecordingFlow", (long)self.recordingState]];
        return;
    }
    [self journalDebugLog:@"calling beginRecordingFlow"];
    [self beginRecordingFlow];
}

- (void)handleStartTextEntryNotification {
    if (!self.tabBarController) {
        [self retryLockScreenHandoff:@selector(handleStartTextEntryNotification)];
        return;
    }
    self.handoffRetries = 0;
    [self selectJournalTab];
    self.modeControl.selectedSegmentIndex = 1;
    [self modeChanged:nil];
    [self.noteTextView becomeFirstResponder];
    // sim-test's Journal deep-link case asserts this reads segment 1.
    NSLog(@"Journal: text entry requested, mode segment %ld", (long)self.modeControl.selectedSegmentIndex);
}

- (void)retryLockScreenHandoff:(SEL)selector {
    // No tab bar controller also means "swiped back off the More stack", where
    // nothing else ever puts this instance back. Ask the registry to show
    // Journal again (a no-op before the tab bar is installed); once it is back
    // on the stack the retry goes through. Bounded: a handoff that still has no
    // tab bar after ~10s is a bug, not something to wait on forever.
    static const NSUInteger kMaxHandoffRetries = 50;
    if (++self.handoffRetries > kMaxHandoffRetries) {
        NSString *msg = [NSString stringWithFormat:@"Journal handoff %@ gave up: no tab bar controller after %lu retries",
                         NSStringFromSelector(selector), (unsigned long)kMaxHandoffRetries];
        NSLog(@"%@", msg);
        [GLCrashReporter addBreadcrumb:msg];
        self.handoffRetries = 0;
        return;
    }
    [self selectJournalTab];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.2 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        // -performSelector: rather than a direct call, since ARC can't
        // verify the return type of a selector picked at compile time.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
        [self performSelector:selector];
#pragma clang diagnostic pop
    });
}

// Through the registry, not self.navigationController: once Journal is
// shown from More, UIKit re-parents it under the More stack and its own
// navigation controller is no longer what tabs.viewControllers holds, which
// is how the lock-screen voice Control started recording on the wrong tab.
//
// Then loads the view: on the first open of the session Journal's view is
// still unloaded (UIKit loads it at the next layout pass), so every caller's
// follow-up -- setting modeControl, focusing the text view, starting a
// recording -- would message nil and the Text Control opened on Voice.
- (void)selectJournalTab {
    BOOL shown = [GLModuleRegistry showModuleWithIdentifier:@"GLModule.AutoJournalModule"];
    [self loadViewIfNeeded];
    [self journalDebugLog:[NSString stringWithFormat:@"selectJournalTab: %@", shown ? @"shown" : @"NOT FOUND"]];
}

#pragma mark - Recording state / UI

- (void)updateUIForState {
    self.saveButton.enabled = YES;
    switch (self.recordingState) {
        case AutoJournalRecordingStateIdle:
            [self.recordButton setImage:[UIImage systemImageNamed:@"mic.circle.fill"]
                                forState:UIControlStateNormal];
            self.cancelButton.hidden = YES;
            self.saveButton.hidden = YES;
            break;
        case AutoJournalRecordingStateRecording:
            [self.recordButton setImage:[UIImage systemImageNamed:@"pause.circle.fill"]
                                forState:UIControlStateNormal];
            self.cancelButton.hidden = NO;
            self.saveButton.hidden = NO;
            break;
        case AutoJournalRecordingStatePaused:
            [self.recordButton setImage:[UIImage systemImageNamed:@"mic.circle.fill"]
                                forState:UIControlStateNormal];
            self.cancelButton.hidden = NO;
            self.saveButton.hidden = NO;
            break;
    }
    if (self.modeControl.selectedSegmentIndex == 0) {
        self.draftBannerLabel.hidden = !self.restoredFromDraft;
    }
    [self updateAttachRowVisibility];
    [self updateTweetRecordingIndicator];
}

// Live "armed" indicator while a tweet-flagged entry is recording (mockup-
// recording-option-3.html's blue mic-ring outline + "Recording tweet…"
// status). A blue BORDER on recordButton itself, not a separate ring view
// like the mockup draws -- same visible affordance with one fewer view.
// Called from every place recordingState or tweetSwitch.isOn can change, so
// it can never go stale (same pattern as -updateAttachRowVisibility above).
- (void)updateTweetRecordingIndicator {
    BOOL armed = self.recordingState == AutoJournalRecordingStateRecording && self.tweetSwitch.isOn;
    self.recordButton.layer.borderWidth = armed ? 3 : 0;
    self.recordButton.layer.borderColor = [GLTheme accentColor].CGColor;
    // recordButton is a fixed 120x120 circle (see buildRecorderUI) -- setting
    // this unconditionally is harmless when borderWidth is 0 (no visible
    // effect) and means the border is always circular the instant it appears.
    self.recordButton.layer.cornerRadius = 60;
    if (self.recordingState == AutoJournalRecordingStateRecording) {
        self.statusLabel.text = self.tweetSwitch.isOn ? @"Recording tweet…" : @"Recording…";
    }
}

// UIControlEventValueChanged on tweetSwitch. Only touches the LIVE recording
// indicator -- the switch's value itself is read directly (not cached here)
// at the moment an upload actually starts, see -uploadFileAtPath:... below.
- (void)tweetSwitchChanged:(UISwitch *)sender {
    [self updateTweetRecordingIndicator];
}

#pragma mark - Recording

- (void)recordButtonTapped {
    switch (self.recordingState) {
        case AutoJournalRecordingStateIdle:
        case AutoJournalRecordingStatePaused:
            // Paused -> Idle-permission-path starts a brand new segment,
            // which is exactly "resume".
            [self beginRecordingFlow];
            break;
        case AutoJournalRecordingStateRecording:
            [self pauseRecording];
            break;
    }
}

- (void)beginRecordingFlow {
    AVAudioSession *session = [AVAudioSession sharedInstance];
    [self journalDebugLog:[NSString stringWithFormat:@"beginRecordingFlow: recordPermission=%ld", (long)session.recordPermission]];
    if (session.recordPermission == AVAudioSessionRecordPermissionGranted) {
        [self startRecording];
        return;
    }
    self.autoStartOnPermissionGranted = YES;
    [session requestRecordPermission:^(BOOL granted) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self journalDebugLog:[NSString stringWithFormat:@"requestRecordPermission completion: granted=%d", granted]];
            if (!granted) {
                self.statusLabel.text = @"Microphone access denied. Enable it in Settings to record.";
                self.autoStartOnPermissionGranted = NO;
                return;
            }
            if (self.autoStartOnPermissionGranted) {
                self.autoStartOnPermissionGranted = NO;
                [self startRecording];
            }
        });
    }];
}

- (void)startRecording {
    [self journalDebugLog:@"startRecording entered"];
    NSError *error = nil;
    AVAudioSession *session = [AVAudioSession sharedInstance];
    [session setCategory:AVAudioSessionCategoryPlayAndRecord error:&error];
    if (!error) [session setActive:YES error:&error];
    if (error) {
        [self journalDebugLog:[NSString stringWithFormat:@"startRecording: audio session error: %@", error.localizedDescription]];
        self.statusLabel.text = [NSString stringWithFormat:@"Couldn't start the audio session: %@",
                                                             error.localizedDescription];
        return;
    }

    // Segments live in Application Support, not NSTemporaryDirectory(): the
    // OS can purge the temp dir at any time (more aggressively after a
    // kill), which would silently lose a recording requirement #5 needs to
    // survive a relaunch.
    NSString *path = [[self draftsDirectoryURL] URLByAppendingPathComponent:
        [NSString stringWithFormat:@"segment-%@.m4a", [[NSUUID UUID] UUIDString]]].path;
    NSDictionary *settings = @{
        AVFormatIDKey : @(kAudioFormatMPEG4AAC),
        AVSampleRateKey : @(44100),
        AVNumberOfChannelsKey : @(1),
        AVEncoderAudioQualityKey : @(AVAudioQualityHigh),
    };
    self.recorder = [[AVAudioRecorder alloc] initWithURL:[NSURL fileURLWithPath:path]
                                                  settings:settings
                                                     error:&error];
    if (!self.recorder || error) {
        self.statusLabel.text = [NSString stringWithFormat:@"Couldn't create the recorder: %@",
                                                             error.localizedDescription];
        return;
    }
    self.recorder.delegate = self;
    [self.recorder record];

    self.retryButton.hidden = YES;
    self.pendingRetryPath = nil;
    if (self.segmentPaths.count == 0) {
        self.draftStartDate = [NSDate date];
    }
    [self.segmentPaths addObject:path];
    self.currentSegmentStartTime = [NSDate timeIntervalSinceReferenceDate];
    self.recordingState = AutoJournalRecordingStateRecording;
    [self persistDraftMetadata];
    // -updateUIForState -> -updateTweetRecordingIndicator sets statusLabel to
    // "Recording…" or "Recording tweet…" depending on tweetSwitch.isOn --
    // no need to set it here too.
    [self updateUIForState];

    [self.elapsedTimer invalidate];
    self.elapsedTimer = [NSTimer scheduledTimerWithTimeInterval:0.5
                                                          target:self
                                                        selector:@selector(tickElapsed)
                                                        userInfo:nil
                                                         repeats:YES];
}

- (void)tickElapsed {
    NSTimeInterval elapsed = self.accumulatedElapsed +
        ([NSDate timeIntervalSinceReferenceDate] - self.currentSegmentStartTime);
    self.elapsedLabel.text = [self formattedElapsed:elapsed];
}

- (void)pauseRecording {
    // PITFALL: this deliberately calls -stop, not AVAudioRecorder's real
    // -pause. -pause/-record (resume) keeps writing into the SAME file, but
    // only within this process's lifetime -- if the app is killed while
    // paused (not stopped), the m4a container's moov atom is very likely
    // never written, leaving an invalid/unplayable file on relaunch.
    // Calling -stop here finalizes a real, valid, durable file for this
    // segment immediately; -resume (recordButtonTapped, Paused case) starts
    // a fresh AVAudioRecorder on a new file rather than reopening this one.
    // Do not "simplify" this back to -pause/-record.
    [self.recorder stop];
    self.accumulatedElapsed += [NSDate timeIntervalSinceReferenceDate] - self.currentSegmentStartTime;
    [self.elapsedTimer invalidate];
    self.elapsedTimer = nil;
    self.recordingState = AutoJournalRecordingStatePaused;
    self.statusLabel.text = @"Paused";
    [self persistDraftMetadata];
    [self updateUIForState];
}

- (void)cancelButtonTapped {
    if (self.recordingState == AutoJournalRecordingStateRecording) {
        self.discardingSegment = YES;
        [self.recorder stop];
        self.discardingSegment = NO;
    }
    [self deleteAllSegmentsAndDraftMetadata];
    self.segmentPaths = [NSMutableArray array];
    self.accumulatedElapsed = 0;
    self.draftStartDate = nil;
    self.pendingRetryPath = nil;
    self.retryButton.hidden = YES;
    [self.elapsedTimer invalidate];
    self.elapsedTimer = nil;
    self.recordingState = AutoJournalRecordingStateIdle;
    self.elapsedLabel.text = @"00:00";
    self.statusLabel.text = @"Tap to record";
    [self clearAttachedPhotos]; // spec: Cancel clears attachments along with everything else
    [self updateUIForState];
}

#pragma mark - AVAudioRecorderDelegate

- (void)audioRecorderDidFinishRecording:(AVAudioRecorder *)recorder successfully:(BOOL)flag {
    if (self.discardingSegment) return; // Cancel already handles cleanup.
    if (flag) return; // Segment finalized fine; pause/save flow tracks it -- no auto-upload here anymore.
    NSString *failedPath = recorder.url.path;
    [self.segmentPaths removeObject:failedPath];
    [[NSFileManager defaultManager] removeItemAtPath:failedPath error:nil];
    [self persistDraftMetadata];
    self.statusLabel.text = @"Recording failed before it could be saved.";
}

#pragma mark - Save (voice)

- (void)saveButtonTapped {
    if (self.recordingState == AutoJournalRecordingStateRecording) {
        [self pauseRecording];
    }
    if (self.segmentPaths.count == 0) return;

    NSString *titleSlug = [self slugifiedTitle];
    self.titleField.text = @""; // matches the note field's existing clear-on-save behavior
    // Captured ONCE here and used for the voice upload AND every staged
    // photo -- the backend groups a photo with its entry by matching this
    // exact value, so calling -filenameTimestamp again per-file would break
    // the grouping.
    NSString *timestamp = [self filenameTimestamp];
    self.statusLabel.text = @"Preparing…";
    self.saveButton.enabled = NO;

    if (self.segmentPaths.count == 1) {
        [self uploadVoiceFileAtPath:self.segmentPaths.firstObject titleSlug:titleSlug timestamp:timestamp];
        return;
    }

    __weak typeof(self) weakSelf = self;
    [self concatenateSegmentsWithCompletion:^(NSString *mergedPath, NSError *error) {
        typeof(self) strongSelf = weakSelf;
        if (!strongSelf) return;
        if (!mergedPath) {
            strongSelf.statusLabel.text = [NSString stringWithFormat:@"Couldn't combine the recording: %@",
                                                                       error.localizedDescription];
            strongSelf.saveButton.enabled = YES;
            return;
        }
        // The segments are merged into mergedPath now, so the raw pieces can
        // go; keeping only the merged file means a killed-mid-retry app
        // still has exactly one durable file to resume from.
        for (NSString *segPath in strongSelf.segmentPaths) {
            [[NSFileManager defaultManager] removeItemAtPath:segPath error:nil];
        }
        strongSelf.segmentPaths = [NSMutableArray arrayWithObject:mergedPath];
        [strongSelf persistDraftMetadata];
        [strongSelf uploadVoiceFileAtPath:mergedPath titleSlug:titleSlug timestamp:timestamp];
    }];
}

- (void)uploadVoiceFileAtPath:(NSString *)path
                     titleSlug:(NSString *)titleSlug
                     timestamp:(NSString *)timestamp {
    // Photos go to the durable outbox now that the voice file is final (merged
    // or single), under this entry's timestamp; they upload on their own.
    NSError *stageError = nil;
    if (![self stageAttachedPhotosWithTimestamp:timestamp titleSlug:titleSlug error:&stageError]) {
        self.statusLabel.text = [NSString stringWithFormat:@"Couldn't save the photos: %@", stageError.localizedDescription];
        self.saveButton.enabled = YES;
        return;
    }
    self.statusLabel.text = @"Uploading…";
    // Read here, at the moment this specific upload actually starts, not
    // inside -uploadFileAtPath:... itself -- that method is also called from
    // -retryTapped, where the switch may already have moved on to arm a
    // different, later entry (see pendingRetryIsTweet's doc comment).
    BOOL isTweet = self.tweetSwitch.isOn;
    BOOL isEsme = self.esmeSwitch.isOn;
    __weak typeof(self) weakSelf = self;
    [self uploadFileAtPath:path
                    isVoice:YES
                    isTweet:isTweet
                     isEsme:isEsme
                  titleSlug:titleSlug
                  timestamp:timestamp
                  onSuccess:^{
        [weakSelf finishSaveWithTimestamp:timestamp titleSlug:titleSlug isVoice:YES];
    }];
}

// Shared tail of every successful voice upload (a first try or a retry). The
// photos were staged in the outbox at save time and upload on their own.
- (void)finishSaveWithTimestamp:(NSString *)timestamp
                        titleSlug:(nullable NSString *)titleSlug
                          isVoice:(BOOL)isVoice {
    if (isVoice) [self finishVoiceSaveCleanup];
    self.statusLabel.text = [self savedStatus];
}

- (void)finishVoiceSaveCleanup {
    // Idle owns no timer: whoever leaves the recording states stops the clock.
    // Without this the elapsed label keeps counting up behind "Saved."
    [self.elapsedTimer invalidate];
    self.elapsedTimer = nil;

    [[NSFileManager defaultManager] removeItemAtURL:[self draftMetadataURL] error:nil];
    self.segmentPaths = [NSMutableArray array];
    self.accumulatedElapsed = 0;
    self.draftStartDate = nil;
    self.restoredFromDraft = NO;
    self.recordingState = AutoJournalRecordingStateIdle;
    self.elapsedLabel.text = @"00:00";
    [self updateUIForState];
}

#pragma mark - Concatenation

- (void)concatenateSegmentsWithCompletion:(void (^)(NSString *_Nullable mergedPath,
                                                      NSError *_Nullable error))completion {
    AVMutableComposition *composition = [AVMutableComposition composition];
    AVMutableCompositionTrack *track =
        [composition addMutableTrackWithMediaType:AVMediaTypeAudio
                                  preferredTrackID:kCMPersistentTrackID_Invalid];

    CMTime cursor = kCMTimeZero;
    for (NSString *path in self.segmentPaths) {
        AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:path] options:nil];
        AVAssetTrack *assetTrack = [[asset tracksWithMediaType:AVMediaTypeAudio] firstObject];
        if (!assetTrack) continue;
        NSError *insertError = nil;
        [track insertTimeRange:CMTimeRangeMake(kCMTimeZero, asset.duration)
                        ofTrack:assetTrack
                         atTime:cursor
                          error:&insertError];
        if (insertError) {
            completion(nil, insertError);
            return;
        }
        cursor = CMTimeAdd(cursor, asset.duration);
    }

    NSString *mergedPath = [[self draftsDirectoryURL] URLByAppendingPathComponent:
        [NSString stringWithFormat:@"merged-%@.m4a", [[NSUUID UUID] UUIDString]]].path;
    [[NSFileManager defaultManager] removeItemAtPath:mergedPath error:nil];

    AVAssetExportSession *export = [[AVAssetExportSession alloc] initWithAsset:composition
                                                                     presetName:AVAssetExportPresetAppleM4A];
    export.outputURL = [NSURL fileURLWithPath:mergedPath];
    export.outputFileType = AVFileTypeAppleM4A;
    [export exportAsynchronouslyWithCompletionHandler:^{
        dispatch_async(dispatch_get_main_queue(), ^{
            if (export.status == AVAssetExportSessionStatusCompleted) {
                completion(mergedPath, nil);
            } else {
                completion(nil, export.error ?: [NSError errorWithDomain:@"AutoJournal" code:-1 userInfo:nil]);
            }
        });
    }];
}

#pragma mark - Text note

- (void)textViewDidBeginEditing:(UITextView *)textView {
    if (textView == self.noteTextView && self.noteTextViewShowingPlaceholder) {
        textView.text = @"";
        textView.textColor = [GLTheme textPrimaryColor];
        self.noteTextViewShowingPlaceholder = NO;
    }
}

- (void)textViewDidEndEditing:(UITextView *)textView {
    if (textView == self.noteTextView && textView.text.length == 0) {
        textView.text = kNoteFieldPlaceholder;
        textView.textColor = [GLTheme textSecondaryColor];
        self.noteTextViewShowingPlaceholder = YES;
    }
}

- (void)textViewDidChange:(UITextView *)textView {
    // Recomputes the attach row's visibility on every keystroke (spec item 1:
    // it must never go stale) -- typing the first character reveals it,
    // deleting back to empty hides it again.
    if (textView == self.noteTextView) {
        [self updateAttachRowVisibility];
    }
}

- (BOOL)textFieldShouldReturn:(UITextField *)textField {
    [textField resignFirstResponder];
    return YES;
}

- (void)saveNoteTapped {
    NSString *raw = self.noteTextViewShowingPlaceholder ? @"" : self.noteTextView.text;
    NSString *text = [raw stringByTrimmingCharactersInSet:
        [NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (text.length == 0) return;
    [self.noteTextView resignFirstResponder];

    NSString *titleSlug = [self slugifiedTitle];
    // Captured ONCE here and used for the note AND every staged photo -- the
    // backend groups a photo with its entry by matching this exact value, so
    // calling -filenameTimestamp again per-file would break the grouping.
    NSString *timestamp = [self filenameTimestamp];
    BOOL isTweet = self.tweetSwitch.isOn;
    BOOL isEsme = self.esmeSwitch.isOn;

    // Durable FIRST: the note goes to the on-disk outbox before any field is
    // cleared, so nothing the user typed exists only in memory. If the disk
    // write fails the fields stay exactly as they were.
    NSError *error = nil;
    NSString *filename = [self journalFilenameIsVoice:NO isTweet:isTweet isEsme:isEsme timestamp:timestamp titleSlug:titleSlug];
    NSString *noteID = [[GLDurableOutbox shared] enqueueKind:@"journal-note"
                                                         path:@"/drop"
                                                      headers:@{@"X-Filename": filename,
                                                                @"Content-Type": @"application/octet-stream"}
                                                         body:[text dataUsingEncoding:NSUTF8StringEncoding]
                                                         meta:nil
                                                   keepResult:NO
                                             acceptedStatuses:nil
                                                        error:&error];
    if (!noteID) {
        self.statusLabel.text = [NSString stringWithFormat:@"Couldn't save the note: %@", error.localizedDescription];
        return;
    }
    if (![self stageAttachedPhotosWithTimestamp:timestamp titleSlug:titleSlug error:&error]) {
        [[GLDurableOutbox shared] removeItemID:noteID];
        self.statusLabel.text = [NSString stringWithFormat:@"Couldn't save the photos: %@", error.localizedDescription];
        return;
    }

    self.titleField.text = @"";
    self.noteTextView.text = kNoteFieldPlaceholder;
    self.noteTextView.textColor = [GLTheme textSecondaryColor];
    self.noteTextViewShowingPlaceholder = YES;
    [self updateAttachRowVisibility]; // note is empty again -- hide immediately, don't wait on the upload
    if (isTweet) {
        // One-shot per mockup-recording-option-3: flips back off once THIS
        // entry is saved (it is durably queued now).
        [self.tweetSwitch setOn:NO animated:YES];
    }
    if (isEsme) {
        [self.esmeSwitch setOn:NO animated:YES]; // one-shot, same as tweet
    }
    self.statusLabel.text = @"Uploading note…";
    __weak typeof(self) weakSelf = self;
    [[GLDurableOutbox shared] flushWithCompletion:^{
        weakSelf.statusLabel.text = [weakSelf savedStatus];
    }];
}

/// "Saved." once the outbox holds no journal items; otherwise says what is
/// still waiting for the box, or that the box refused something.
- (NSString *)savedStatus {
    NSUInteger waiting = 0;
    NSString *rejection = nil;
    for (NSDictionary *item in [GLDurableOutbox shared].items) {
        if (![item[@"kind"] hasPrefix:@"journal-"]) continue;
        if ([item[@"state"] isEqualToString:GLDurableOutboxStatePending]) waiting++;
        else if ([item[@"state"] isEqualToString:GLDurableOutboxStateRejected]) rejection = item[@"lastError"];
    }
    if (rejection) return [NSString stringWithFormat:@"Upload rejected by the box: %@", rejection];
    if (waiting > 0) return @"Saved on this device. It uploads automatically when the box is reachable.";
    return @"Saved.";
}

- (void)outboxDidReject:(NSNotification *)note {
    NSDictionary *item = note.userInfo[@"item"];
    if (![item[@"kind"] hasPrefix:@"journal-"]) return;
    self.statusLabel.text = [NSString stringWithFormat:@"Upload rejected by the box: %@", item[@"lastError"]];
}

#pragma mark - Title slug

- (NSString *)slugifiedTitle {
    NSString *trimmed = [self.titleField.text stringByTrimmingCharactersInSet:
        [NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (trimmed.length == 0) return nil;

    NSString *lower = trimmed.lowercaseString;
    NSMutableString *slug = [NSMutableString string];
    BOOL lastWasHyphen = NO;
    for (NSUInteger i = 0; i < lower.length; i++) {
        unichar c = [lower characterAtIndex:i];
        BOOL isAlnum = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
        if (isAlnum) {
            [slug appendFormat:@"%C", c];
            lastWasHyphen = NO;
        } else if (!lastWasHyphen && slug.length > 0) {
            [slug appendString:@"-"];
            lastWasHyphen = YES;
        }
    }
    while (slug.length > 0 && [slug hasSuffix:@"-"]) {
        [slug deleteCharactersInRange:NSMakeRange(slug.length - 1, 1)];
    }

    static const NSUInteger kMaxSlugLength = 40;
    if (slug.length > kMaxSlugLength) {
        [slug deleteCharactersInRange:NSMakeRange(kMaxSlugLength, slug.length - kMaxSlugLength)];
        while (slug.length > 0 && [slug hasSuffix:@"-"]) {
            [slug deleteCharactersInRange:NSMakeRange(slug.length - 1, 1)];
        }
    }
    return slug.length > 0 ? slug : nil;
}

#pragma mark - Draft persistence

- (NSURL *)draftsDirectoryURL {
    NSArray<NSURL *> *urls = [[NSFileManager defaultManager]
        URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask];
    NSURL *base = urls.firstObject;
    NSURL *dir = [base URLByAppendingPathComponent:@"JournalDrafts" isDirectory:YES];
    [[NSFileManager defaultManager] createDirectoryAtURL:dir
                              withIntermediateDirectories:YES
                                               attributes:nil
                                                    error:nil];
    return dir;
}

- (NSURL *)draftMetadataURL {
    return [[self draftsDirectoryURL] URLByAppendingPathComponent:@"draft.json"];
}

- (void)persistDraftMetadata {
    if (self.segmentPaths.count == 0) {
        [[NSFileManager defaultManager] removeItemAtURL:[self draftMetadataURL] error:nil];
        return;
    }
    NSDictionary *json = @{
        @"segments" : self.segmentPaths,
        @"title" : self.titleField.text ?: @"",
        @"startedAt" : @(self.draftStartDate.timeIntervalSince1970),
        // Persisted so a relaunch (draft restored in -loadDraftIfPresent
        // below) doesn't lose the user's intent to the switch's own default
        // (off) -- without this, killing the app mid-recording with the
        // switch armed would silently drop back to a normal, non-tweet
        // upload on the next Save. See -uploadFileAtPath:... for the other
        // half of "captured at record time, not read at upload time".
        @"isTweet" : @(self.tweetSwitch.isOn),
        @"isEsme" : @(self.esmeSwitch.isOn),
    };
    NSData *data = [NSJSONSerialization dataWithJSONObject:json options:0 error:nil];
    [data writeToURL:[self draftMetadataURL] atomically:YES];
}

- (void)loadDraftIfPresent {
    // A live recording outranks any saved draft. This runs from -viewDidLoad,
    // and on a lock-screen launch the view can load EITHER side of
    // -startRecording: the deep link selects this tab (loading the view) while
    // the mic-permission callback that actually starts recording lands a beat
    // later. Losing that race used to restore the draft on top of an active
    // recording — the UI said "Paused" while the recorder ran, and the elapsed
    // timer (which nothing here invalidates) kept ticking straight through the
    // save, so the counter climbed after "Saved."
    if (self.recordingState != AutoJournalRecordingStateIdle) return;

    NSData *data = [NSData dataWithContentsOfURL:[self draftMetadataURL]];
    if (!data) return;
    NSDictionary *json = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![json isKindOfClass:[NSDictionary class]]) return;

    NSArray *segments = json[@"segments"];
    if (![segments isKindOfClass:[NSArray class]]) return;

    NSMutableArray<NSString *> *validSegments = [NSMutableArray array];
    for (id path in segments) {
        if ([path isKindOfClass:[NSString class]] &&
            [[NSFileManager defaultManager] fileExistsAtPath:path]) {
            [validSegments addObject:path];
        }
    }
    if (validSegments.count == 0) {
        [[NSFileManager defaultManager] removeItemAtURL:[self draftMetadataURL] error:nil];
        return;
    }

    self.segmentPaths = validSegments;
    id title = json[@"title"];
    self.titleField.text = [title isKindOfClass:[NSString class]] ? title : @"";

    NSNumber *startedAt = json[@"startedAt"];
    self.draftStartDate = [startedAt isKindOfClass:[NSNumber class]]
        ? [NSDate dateWithTimeIntervalSince1970:startedAt.doubleValue]
        : [NSDate date];

    // Restore the switch's UI state to whatever it was armed to when the
    // draft was last persisted -- a fresh -init would otherwise always start
    // it off, silently un-arming a tweet-flagged draft across a relaunch.
    NSNumber *isTweet = json[@"isTweet"];
    self.tweetSwitch.on = [isTweet isKindOfClass:[NSNumber class]] && isTweet.boolValue;
    NSNumber *isEsme = json[@"isEsme"];
    self.esmeSwitch.on = [isEsme isKindOfClass:[NSNumber class]] && isEsme.boolValue;

    self.accumulatedElapsed = [self totalDurationOfSegments:validSegments];
    self.recordingState = AutoJournalRecordingStatePaused;
    self.restoredFromDraft = YES;

    self.modeControl.selectedSegmentIndex = 0; // the paused voice UI is where the draft lives
    [self modeChanged:nil];

    self.elapsedLabel.text = [self formattedElapsed:self.accumulatedElapsed];
    self.statusLabel.text = @"Paused";

    static NSDateFormatter *timeFormatter;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        timeFormatter = [[NSDateFormatter alloc] init];
        timeFormatter.dateFormat = @"HH:mm";
    });
    self.draftBannerLabel.text = [NSString stringWithFormat:
        @"Unsaved recording from %@ — Resume, Save, or Cancel below.",
        [timeFormatter stringFromDate:self.draftStartDate]];
    self.draftBannerLabel.hidden = NO;

    [self updateUIForState];
}

- (void)deleteAllSegmentsAndDraftMetadata {
    for (NSString *path in self.segmentPaths) {
        [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
    }
    [[NSFileManager defaultManager] removeItemAtURL:[self draftMetadataURL] error:nil];
    self.restoredFromDraft = NO;
}

- (NSTimeInterval)totalDurationOfSegments:(NSArray<NSString *> *)paths {
    NSTimeInterval total = 0;
    for (NSString *path in paths) {
        AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:path] options:nil];
        total += CMTimeGetSeconds(asset.duration);
    }
    return total;
}

- (NSString *)formattedElapsed:(NSTimeInterval)elapsed {
    NSInteger minutes = (NSInteger)elapsed / 60;
    NSInteger seconds = (NSInteger)elapsed % 60;
    return [NSString stringWithFormat:@"%02ld:%02ld", (long)minutes, (long)seconds];
}

#pragma mark - Upload

- (NSString *)filenameTimestamp {
    NSDateFormatter *formatter = [[NSDateFormatter alloc] init];
    formatter.dateFormat = @"yyyy-MM-dd-HHmmss";
    formatter.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
    return [formatter stringFromDate:[NSDate date]];
}

- (NSString *)journalFilenameIsVoice:(BOOL)isVoice
                              isTweet:(BOOL)isTweet
                               isEsme:(BOOL)isEsme
                            timestamp:(NSString *)timestamp
                            titleSlug:(nullable NSString *)titleSlug {
    NSString *suffix = titleSlug.length > 0 ? [NSString stringWithFormat:@"-%@", titleSlug] : @"";
    // The backend's /drop routing only pattern-matches the journal-voice-/
    // journal-note- prefix via regex, so appending the slug after the
    // timestamp and before the extension is safe with no backend change.
    // The "-tweet-" marker (server-side commit 7e313f7, lib/journal-vault.mjs
    // isTweetFilename) sits directly between the kind and the timestamp, NOT
    // anchored to the string start -- the server prefixes on-disk names with
    // its own upload timestamp, so anchoring here would miss the real files.
    // Photo attachments ("journal-photo-...") stay non-taggable.
    // "-esme-" (lib/journal-vault.mjs isEsmeFilename) goes after "-tweet-"
    // and before the timestamp: journal-<kind>-[tweet-][esme-]<timestamp>.
    NSString *markers = [NSString stringWithFormat:@"%@%@", isTweet ? @"tweet-" : @"", isEsme ? @"esme-" : @""];
    return isVoice
        ? [NSString stringWithFormat:@"journal-voice-%@%@%@.m4a", markers, timestamp, suffix]
        : [NSString stringWithFormat:@"journal-note-%@%@%@.txt", markers, timestamp, suffix];
}

- (void)uploadFileAtPath:(NSString *)path
                  isVoice:(BOOL)isVoice
                  isTweet:(BOOL)isTweet
                   isEsme:(BOOL)isEsme
                titleSlug:(nullable NSString *)titleSlug
                timestamp:(NSString *)timestamp
                onSuccess:(void (^_Nullable)(void))onSuccess {
    NSData *data = [NSData dataWithContentsOfFile:path];
    if (!data) {
        [NSException raise:NSInternalInconsistencyException
                    format:@"no data at %@ to upload", path];
    }

    NSString *filename = [self journalFilenameIsVoice:isVoice isTweet:isTweet isEsme:isEsme timestamp:timestamp titleSlug:titleSlug];

    self.pendingRetryPath = nil;
    __weak typeof(self) weakSelf = self;
    [GLDropUploader uploadData:data
                       filename:filename
                    contentType:@"application/octet-stream"
                     toEndpoint:GLEndpointURL(@"/drop").absoluteString
                          token:GL_BAKED_TOKEN
                     completion:^(NSString *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            typeof(self) strongSelf = weakSelf;
            if (!strongSelf) return;
            if (error) {
                strongSelf.statusLabel.text = [NSString stringWithFormat:
                    @"Upload failed: %@. The recording is kept on-device.", error];
                strongSelf.pendingRetryPath = path;
                strongSelf.pendingRetryIsVoice = isVoice;
                strongSelf.pendingRetryTitleSlug = titleSlug;
                strongSelf.pendingRetryTimestamp = timestamp;
                // Snapshot, not a live re-read of tweetSwitch: this failed
                // entry keeps whatever tweet-ness it was recorded with, even
                // if the switch has since been toggled for a DIFFERENT,
                // not-yet-saved entry -- see the switch's one-shot behavior
                // below and pendingRetryIsTweet's declaration comment.
                strongSelf.pendingRetryIsTweet = isTweet;
                strongSelf.pendingRetryIsEsme = isEsme;
                strongSelf.retryButton.hidden = NO;
                strongSelf.saveButton.enabled = YES;
            } else {
                strongSelf.statusLabel.text = @"Saved.";
                strongSelf.retryButton.hidden = YES;
                strongSelf.pendingRetryPath = nil;
                [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
                if (isTweet) {
                    // One-shot per mockup-recording-option-3: flips back off
                    // on its own right after THIS entry finishes uploading.
                    // Doesn't distinguish "this entry's own flag" from "the
                    // switch's current display" -- an edge case where the
                    // user re-arms the switch for a brand-new entry while an
                    // older tweet retry is still in flight would see that
                    // fresh arm clobbered. Not handled: out of scope, no
                    // spec coverage, and the switch is right there to flip
                    // back on if that happens.
                    [strongSelf.tweetSwitch setOn:NO animated:YES];
                }
                if (isEsme) {
                    [strongSelf.esmeSwitch setOn:NO animated:YES]; // one-shot, same as tweet
                }
                if (onSuccess) onSuccess();
            }
        });
    }];
}

- (void)retryTapped {
    if (!self.pendingRetryPath) return;
    NSString *path = self.pendingRetryPath;
    BOOL isVoice = self.pendingRetryIsVoice;
    BOOL isTweet = self.pendingRetryIsTweet;
    BOOL isEsme = self.pendingRetryIsEsme;
    NSString *titleSlug = self.pendingRetryTitleSlug;
    // Reuses the failed attempt's timestamp (its filename never reached the
    // server) so the entry still matches the photos staged under it.
    NSString *timestamp = self.pendingRetryTimestamp;
    self.statusLabel.text = @"Retrying upload…";
    __weak typeof(self) weakSelf = self;
    [self uploadFileAtPath:path
                    isVoice:isVoice
                    isTweet:isTweet
                     isEsme:isEsme
                  titleSlug:titleSlug
                  timestamp:timestamp
                  onSuccess:^{
        [weakSelf finishSaveWithTimestamp:timestamp titleSlug:titleSlug isVoice:isVoice];
    }];
}

#pragma mark - Attach row (Option B)

- (void)buildAttachRow {
    self.attachRow = [[UIView alloc] init];
    self.attachRow.accessibilityIdentifier = @"AutoJournalAttachRow";
    self.attachRow.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:self.attachRow];

    self.addPhotoButton = [UIButton buttonWithType:UIButtonTypeSystem];
    [self.addPhotoButton setTitle:@"+ Add Photo" forState:UIControlStateNormal];
    self.addPhotoButton.titleLabel.font = [GLTheme captionFont];
    self.addPhotoButton.contentHorizontalAlignment = UIControlContentHorizontalAlignmentLeft;
    [self.addPhotoButton addTarget:self
                             action:@selector(addPhotoButtonTapped)
                   forControlEvents:UIControlEventTouchUpInside];
    self.addPhotoButton.accessibilityIdentifier = @"AutoJournalAddPhotoButton";
    self.addPhotoButton.translatesAutoresizingMaskIntoConstraints = NO;
    [self.attachRow addSubview:self.addPhotoButton];

    self.attachStackView = [[UIStackView alloc] init];
    self.attachStackView.axis = UILayoutConstraintAxisHorizontal;
    self.attachStackView.spacing = 8;
    self.attachStackView.alignment = UIStackViewAlignmentCenter;
    self.attachStackView.translatesAutoresizingMaskIntoConstraints = NO;

    self.attachScrollView = [[UIScrollView alloc] init];
    self.attachScrollView.showsHorizontalScrollIndicator = NO;
    self.attachScrollView.accessibilityIdentifier = @"AutoJournalAttachScrollView";
    self.attachScrollView.translatesAutoresizingMaskIntoConstraints = NO;
    [self.attachScrollView addSubview:self.attachStackView];
    [self.attachRow addSubview:self.attachScrollView];

    // Starts at 0 and is flipped to kAttachRowHeight only when
    // -updateAttachRowVisibility decides the row should show -- this is what
    // actually reclaims the note text view's space when the row is hidden,
    // since `.hidden` alone does not collapse a view's Auto Layout footprint.
    self.attachRowHeightConstraint = [self.attachRow.heightAnchor constraintEqualToConstant:0];

    UILayoutGuide *guide = self.view.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
        [self.attachRow.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor constant:20],
        [self.attachRow.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor constant:-20],
        self.attachRowHeightConstraint,

        [self.addPhotoButton.topAnchor constraintEqualToAnchor:self.attachRow.topAnchor],
        [self.addPhotoButton.bottomAnchor constraintEqualToAnchor:self.attachRow.bottomAnchor],
        [self.addPhotoButton.leadingAnchor constraintEqualToAnchor:self.attachRow.leadingAnchor],
        [self.addPhotoButton.trailingAnchor constraintEqualToAnchor:self.attachRow.trailingAnchor],

        [self.attachScrollView.topAnchor constraintEqualToAnchor:self.attachRow.topAnchor],
        [self.attachScrollView.bottomAnchor constraintEqualToAnchor:self.attachRow.bottomAnchor],
        [self.attachScrollView.leadingAnchor constraintEqualToAnchor:self.attachRow.leadingAnchor],
        [self.attachScrollView.trailingAnchor constraintEqualToAnchor:self.attachRow.trailingAnchor],

        [self.attachStackView.topAnchor constraintEqualToAnchor:self.attachScrollView.topAnchor],
        [self.attachStackView.bottomAnchor constraintEqualToAnchor:self.attachScrollView.bottomAnchor],
        [self.attachStackView.leadingAnchor constraintEqualToAnchor:self.attachScrollView.leadingAnchor],
        [self.attachStackView.trailingAnchor constraintEqualToAnchor:self.attachScrollView.trailingAnchor],
        [self.attachStackView.heightAnchor constraintEqualToAnchor:self.attachScrollView.heightAnchor],
    ]];

    // Two mode-specific placements for the SAME view, only one live at a
    // time (-modeChanged: swaps them):
    //  - voice: between retryButton and the cancel/save row (the slot the
    //    task names -- retryButton itself stays where it was, so the two can
    //    both be visible at once, e.g. a photo attached to a failed upload).
    //  - text: between the note field and its Save button.
    // Each set anchors the row from ONE fixed neighbor (retryButton.bottom
    // for voice, saveNoteButton.top for text) and lets attachRowHeightConstraint
    // determine the other edge, so toggling the height never fights these.
    self.attachRowVoiceConstraints = @[
        [self.attachRow.topAnchor constraintEqualToAnchor:self.retryButton.bottomAnchor constant:16],
        [self.cancelButton.topAnchor constraintEqualToAnchor:self.attachRow.bottomAnchor constant:16],
        [self.saveButton.topAnchor constraintEqualToAnchor:self.attachRow.bottomAnchor constant:16],
    ];
    self.attachRowTextConstraints = @[
        [self.attachRow.bottomAnchor constraintEqualToAnchor:self.saveNoteButton.topAnchor constant:-16],
        [self.noteTextView.bottomAnchor constraintEqualToAnchor:self.attachRow.topAnchor constant:-16],
    ];

    // self.attachedPhotos is set up in -init. It is held in memory only,
    // deliberately NOT part of on-disk draft persistence (Option-B scope) --
    // a killed app loses attached photos but keeps the audio draft, same as
    // it always has.
    [self rebuildAttachStrip];
}

// Recomputes whether the attach row should be visible right now, per spec:
// voice mode while Recording/Paused, or text mode with a non-placeholder,
// non-empty note. Called from every place that can change either input --
// -updateUIForState (recording state), -modeChanged: (mode), and
// -textViewDidChange: (note text) -- so it can never go stale.
- (void)updateAttachRowVisibility {
    BOOL isVoice = self.modeControl.selectedSegmentIndex == 0;
    BOOL visible;
    if (isVoice) {
        visible = self.recordingState == AutoJournalRecordingStateRecording ||
                  self.recordingState == AutoJournalRecordingStatePaused;
    } else {
        visible = self.noteTextView.text.length > 0 && !self.noteTextViewShowingPlaceholder;
    }
    self.attachRow.hidden = !visible;
    self.attachRowHeightConstraint.constant = visible ? kAttachRowHeight : 0;
}

- (void)addPhotoButtonTapped {
    UIAlertController *sheet = [UIAlertController alertControllerWithTitle:nil
                                                                     message:nil
                                                              preferredStyle:UIAlertControllerStyleActionSheet];
    if ([UIImagePickerController isSourceTypeAvailable:UIImagePickerControllerSourceTypeCamera]) {
        [sheet addAction:[UIAlertAction actionWithTitle:@"Take Photo"
                                                   style:UIAlertActionStyleDefault
                                                 handler:^(UIAlertAction *action) {
            [self presentCameraPicker];
        }]];
    } // else: simulator / no camera hardware -- omit rather than offer a dead option.
    [sheet addAction:[UIAlertAction actionWithTitle:@"Choose from Library"
                                               style:UIAlertActionStyleDefault
                                             handler:^(UIAlertAction *action) {
        [self presentLibraryPicker];
    }]];
    [sheet addAction:[UIAlertAction actionWithTitle:@"Cancel" style:UIAlertActionStyleCancel handler:nil]];
    // This app is iPhone-only (no iPad size class), so the popover branch
    // never actually renders, but leaving sourceView/sourceRect nil is a
    // guaranteed crash on iPad -- set them defensively at no real cost.
    sheet.popoverPresentationController.sourceView = self.attachRow;
    sheet.popoverPresentationController.sourceRect = self.attachRow.bounds;
    [self presentViewController:sheet animated:YES completion:nil];
}

- (void)presentCameraPicker {
    UIImagePickerController *picker = [[UIImagePickerController alloc] init];
    picker.sourceType = UIImagePickerControllerSourceTypeCamera;
    picker.delegate = self;
    [self presentViewController:picker animated:YES completion:nil];
}

- (void)presentLibraryPicker {
    PHPickerConfiguration *config = [[PHPickerConfiguration alloc] init];
    config.selectionLimit = kMaxAttachedPhotos - self.attachedPhotos.count;
    config.filter = [PHPickerFilter imagesFilter];
    PHPickerViewController *picker = [[PHPickerViewController alloc] initWithConfiguration:config];
    picker.delegate = self;
    [self presentViewController:picker animated:YES completion:nil];
}

#pragma mark UIImagePickerControllerDelegate

- (void)imagePickerController:(UIImagePickerController *)picker
    didFinishPickingMediaWithInfo:(NSDictionary<UIImagePickerControllerInfoKey, id> *)info {
    UIImage *image = info[UIImagePickerControllerOriginalImage];
    [picker dismissViewControllerAnimated:YES completion:nil];
    if (image) [self appendAttachedPhoto:image];
}

- (void)imagePickerControllerDidCancel:(UIImagePickerController *)picker {
    [picker dismissViewControllerAnimated:YES completion:nil];
}

#pragma mark PHPickerViewControllerDelegate

- (void)picker:(PHPickerViewController *)picker didFinishPicking:(NSArray<PHPickerResult *> *)results {
    [picker dismissViewControllerAnimated:YES completion:nil];
    __weak typeof(self) weakSelf = self;
    for (PHPickerResult *result in results) {
        if (![result.itemProvider canLoadObjectOfClass:[UIImage class]]) continue;
        [result.itemProvider loadObjectOfClass:[UIImage class]
                              completionHandler:^(id<NSItemProviderReading> object, NSError *error) {
            if (![object isKindOfClass:[UIImage class]]) return;
            UIImage *image = (UIImage *)object;
            dispatch_async(dispatch_get_main_queue(), ^{
                [weakSelf appendAttachedPhoto:image];
            });
        }];
    }
}

- (void)appendAttachedPhoto:(UIImage *)image {
    if (self.attachedPhotos.count >= kMaxAttachedPhotos) return; // cap already enforced by the picker configs; belt-and-suspenders for the camera path
    [self.attachedPhotos addObject:image];
    [self rebuildAttachStrip];
}

- (void)clearAttachedPhotos {
    [self.attachedPhotos removeAllObjects];
    [self rebuildAttachStrip];
}

// Rebuilds the strip from scratch on every mutation (add/delete) rather than
// diffing -- the list is capped at 5, so this is cheap, and it keeps each
// delete button's `tag` (its index) trivially correct with no bookkeeping.
- (void)rebuildAttachStrip {
    for (UIView *view in self.attachStackView.arrangedSubviews) {
        [self.attachStackView removeArrangedSubview:view];
        [view removeFromSuperview];
    }
    [self.attachedPhotos enumerateObjectsUsingBlock:^(UIImage *image, NSUInteger idx, BOOL *stop) {
        [self.attachStackView addArrangedSubview:[self thumbnailViewForImage:image atIndex:idx]];
    }];
    if (self.attachedPhotos.count < kMaxAttachedPhotos) {
        [self.attachStackView addArrangedSubview:[self addTileView]];
    }
    BOOL hasPhotos = self.attachedPhotos.count > 0;
    self.addPhotoButton.hidden = hasPhotos;
    self.attachScrollView.hidden = !hasPhotos;
}

- (UIView *)thumbnailViewForImage:(UIImage *)image atIndex:(NSUInteger)index {
    UIView *container = [[UIView alloc] init];
    container.translatesAutoresizingMaskIntoConstraints = NO;
    [container.widthAnchor constraintEqualToConstant:kAttachThumbnailSize].active = YES;
    [container.heightAnchor constraintEqualToConstant:kAttachThumbnailSize].active = YES;

    UIImageView *imageView = [[UIImageView alloc] init];
    imageView.image = image;
    imageView.contentMode = UIViewContentModeScaleAspectFill;
    imageView.clipsToBounds = YES;
    imageView.layer.cornerRadius = 8;
    imageView.translatesAutoresizingMaskIntoConstraints = NO;
    [container addSubview:imageView];

    UIButton *deleteButton = [UIButton buttonWithType:UIButtonTypeSystem];
    [deleteButton setTitle:@"×" forState:UIControlStateNormal];
    deleteButton.titleLabel.font = [UIFont boldSystemFontOfSize:14];
    // Deliberately NOT themed: this scrim sits on top of an arbitrary user
    // photo, not app chrome, so it needs fixed white-on-black contrast in
    // both Light and Dark mode rather than a token that would invert it.
    deleteButton.tintColor = UIColor.whiteColor;
    deleteButton.backgroundColor = [UIColor.blackColor colorWithAlphaComponent:0.6];
    deleteButton.layer.cornerRadius = 9;
    deleteButton.clipsToBounds = YES;
    deleteButton.tag = index; // consumed by -deletePhotoTapped: -- valid until the next -rebuildAttachStrip
    [deleteButton addTarget:self
                      action:@selector(deletePhotoTapped:)
            forControlEvents:UIControlEventTouchUpInside];
    deleteButton.translatesAutoresizingMaskIntoConstraints = NO;
    [container addSubview:deleteButton];

    [NSLayoutConstraint activateConstraints:@[
        [imageView.topAnchor constraintEqualToAnchor:container.topAnchor],
        [imageView.leadingAnchor constraintEqualToAnchor:container.leadingAnchor],
        [imageView.trailingAnchor constraintEqualToAnchor:container.trailingAnchor],
        [imageView.bottomAnchor constraintEqualToAnchor:container.bottomAnchor],

        [deleteButton.topAnchor constraintEqualToAnchor:container.topAnchor constant:-6],
        [deleteButton.trailingAnchor constraintEqualToAnchor:container.trailingAnchor constant:6],
        [deleteButton.widthAnchor constraintEqualToConstant:18],
        [deleteButton.heightAnchor constraintEqualToConstant:18],
    ]];
    return container;
}

- (UIView *)addTileView {
    UIButton *tile = [UIButton buttonWithType:UIButtonTypeSystem];
    [tile setImage:[UIImage systemImageNamed:@"plus"] forState:UIControlStateNormal];
    tile.backgroundColor = [GLTheme surfaceColor];
    tile.layer.cornerRadius = 8;
    tile.translatesAutoresizingMaskIntoConstraints = NO;
    [tile.widthAnchor constraintEqualToConstant:kAttachThumbnailSize].active = YES;
    [tile.heightAnchor constraintEqualToConstant:kAttachThumbnailSize].active = YES;
    [tile addTarget:self
             action:@selector(addPhotoButtonTapped)
   forControlEvents:UIControlEventTouchUpInside];
    return tile;
}

- (void)deletePhotoTapped:(UIButton *)sender {
    NSUInteger index = sender.tag;
    if (index >= self.attachedPhotos.count) return;
    [self.attachedPhotos removeObjectAtIndex:index];
    [self rebuildAttachStrip];
}

#pragma mark - Photo upload

// Writes each attached photo to the durable outbox as its own drop under the
// SAME timestamp/titleSlug as the entry, so the server can group them:
// journal-photo-<timestamp><-slug>-<1-based index>.jpg. Only once every photo
// is on disk is the in-memory strip cleared; on a write failure the photos
// already staged are removed again and the strip is left untouched.
- (BOOL)stageAttachedPhotosWithTimestamp:(NSString *)timestamp
                               titleSlug:(nullable NSString *)titleSlug
                                   error:(NSError **)error {
    NSArray<UIImage *> *photos = [self.attachedPhotos copy];
    if (photos.count == 0) return YES;
    NSString *suffix = titleSlug.length > 0 ? [NSString stringWithFormat:@"-%@", titleSlug] : @"";
    NSMutableArray<NSString *> *stagedIDs = [NSMutableArray array];
    for (NSUInteger idx = 0; idx < photos.count; idx++) {
        NSData *data = UIImageJPEGRepresentation(photos[idx], 0.85);
        // 1-based index in the filename, per the upload contract.
        NSString *filename = [NSString stringWithFormat:@"journal-photo-%@%@-%lu.jpg",
                                                          timestamp, suffix, (unsigned long)(idx + 1)];
        NSString *itemID = [[GLDurableOutbox shared] enqueueKind:@"journal-photo"
                                                             path:@"/drop"
                                                          headers:@{@"X-Filename": filename,
                                                                    @"Content-Type": @"image/jpeg"}
                                                             body:data
                                                             meta:nil
                                                       keepResult:NO
                                                 acceptedStatuses:nil
                                                            error:error];
        if (!itemID) {
            for (NSString *staged in stagedIDs) [[GLDurableOutbox shared] removeItemID:staged];
            return NO;
        }
        [stagedIDs addObject:itemID];
    }
    [self clearAttachedPhotos];
    return YES;
}

@end
