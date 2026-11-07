#import "ShareViewController.h"
#import "ShareConfig.h"
#import "../Shared/GLDropUploader.h"
#import "../Shared/GLDropBackground.h"

#import <ImageIO/ImageIO.h>
#import <Security/Security.h>
#import <mach/mach.h>

// Share-sheet extension with independent actions on the same shared items:
//
// 1. The original /drop auto-upload: starts the moment the sheet appears,
//    POSTs the raw bytes of every image/video to the Linux box's location
//    server. No compose field, nothing to configure.
// 2. "Start conversation": downsamples just the IMAGE items to JPEG, stashes
//    each in the shared keychain (no network, so it works offline), then opens
//    the containing app straight into a new session
//    (overland://session/text?handoff=<uuid>,<uuid>). The app reads the photos
//    out of the keychain and the session page uploads them, or queues the
//    Start until it is online. The "Voice chat" action runs the same flow with
//    session/voice?... to start recording with the photos attached.
//
// Both share the same NSItemProvider list; (2) is a strict subset (images
// only, capped lower).
//
// -completeRequestReturningItems: is called from exactly two places: after
// ALL /drop items are handed to the background session (via the "Done"
// button, which no longer waits for the transfers: they are run by
// nsurlsessiond and survive this extension) or after the containing app
// has actually been asked to open (in the -openContainingAppURL:completion:
// completion handler) -- never eagerly, and never on a fixed timer.

static NSString *const kImageType = @"public.image";
static const NSUInteger kMaxItems = 10;
static const NSUInteger kMaxConversationItems = 5;

// Downsample target for "Start conversation" photos -- see
// -downsampledJPEGDataAtURL: below. A share extension gets a far smaller
// memory allowance than a normal app (measured ~120MB before jetsam); a
// modern phone camera photo decodes to ~190MB as a full-res UIImage before
// it's even re-encoded, so decoding full-res and THEN downsizing is already
// too late. This also keeps every later upload well under the server's 15MB cap.
static const CGFloat kAttachmentMaxPixelSize = 2048;
static const CGFloat kAttachmentJPEGQuality = 0.85;

// Keychain handoff to the containing app. (The extension now has an App Group
// too, but only for the /drop background session; this handoff is unchanged.)
// The photos go in its own application-identifier keychain group (always
// writable by it); Overland.entitlements lists the same group so the app can
// read and delete. Must match SessionsViewController.m.
static NSString *const kHandoffKeychainService = @"com.oliverullman.assistantlocation.share-handoff";
static NSString *const kHandoffKeychainAccessGroup = @"J66WVM2DTX.com.oliverullman.assistantlocation.share";

// Fire-and-forget line into the box's location-server log (GET /debug-log,
// printed as "[JOURNAL DEBUG] ..."). The app-opening step can't be exercised
// in CI, so this is the only record of what it did on a real phone.
static void GLShareDebugLog(NSString *msg) {
  NSString *encoded = [msg stringByAddingPercentEncodingWithAllowedCharacters:
                               NSCharacterSet.alphanumericCharacterSet];
  NSURL *url = [NSURL URLWithString:
      [NSString stringWithFormat:@"http://%@:8302/debug-log?msg=%@", GLDropHost, encoded]];
  if (!url) return;
  [[[NSURLSession sharedSession] dataTaskWithURL:url] resume];
}

// Resident footprint in MB (phys_footprint, the number jetsam judges an
// extension by), for the launch-stage "share-ext:" lines.
static long GLShareFootprintMB(void) {
  task_vm_info_data_t info;
  mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
  if (task_info(mach_task_self(), TASK_VM_INFO, (task_info_t)&info, &count) != KERN_SUCCESS) return -1;
  return (long)(info.phys_footprint / (1024 * 1024));
}

@interface ShareViewController ()
@property(nonatomic, strong) NSArray<NSItemProvider *> *providers;
@property(nonatomic, strong) NSArray<NSItemProvider *> *imageProviders;
@property(nonatomic, strong) NSMutableArray<UILabel *> *rowLabels;
@property(nonatomic, strong) UILabel *statusLabel;
@property(nonatomic, strong) UIButton *retryButton;
@property(nonatomic, strong) UIButton *doneButton;
@property(nonatomic, strong) UIActivityIndicatorView *spinner;
@property(nonatomic, assign) BOOL started;
@property(nonatomic, strong) GLDropBackground *dropSession;
// Set once every /drop item has been handed to the background session (or
// failed to load) -- "enqueued", not "uploaded". Distinct from dropUploadsDone
// below (all uploads succeeded while still alive) so a concurrent "Start
// conversation" completion knows whether it's safe to end the extension: the
// transfers themselves survive, but items not yet staged into the group
// container would be lost.
@property(nonatomic, assign) BOOL dropUploadAttemptFinished;
@property(nonatomic, assign) BOOL dropUploadsDone;
// Set when "Start conversation" finished (opened the app) before /drop's
// attempt had settled -- tells the /drop completion to finish the
// extension request once IT settles, instead of just showing Done/Retry.
@property(nonatomic, assign) BOOL completePendingDropFinish;

@property(nonatomic, strong) UIButton *startConversationButton;
// "text" or "voice": the mode of the conversation in flight / last tried
// (what Retry repeats).
@property(nonatomic, copy) NSString *conversationMode;
@property(nonatomic, strong) UILabel *conversationStatusLabel;
@property(nonatomic, strong) UIButton *conversationRetryButton;
@property(nonatomic, assign) BOOL conversationInFlight;
// The app can only be asked to open once this view is in a window (the
// responder chain has to reach UIApplication). Photo prep runs before that,
// so its handoff IDs wait in pendingOpenIDs until -viewIsAppearing: fires.
@property(nonatomic, assign) BOOL viewInWindow;
@property(nonatomic, copy) NSArray<NSString *> *pendingOpenIDs;
@end

@implementation ShareViewController

#pragma mark - Lifecycle

// Launch-stage trace for "tapped Share to desktop, panel never appeared":
// whichever init the host takes logs first, before any other work.
- (instancetype)initWithNibName:(NSString *)nibName bundle:(NSBundle *)bundle {
  GLShareDebugLog([NSString stringWithFormat:@"share-ext: init pid=%d mem=%ldMB",
                   getpid(), GLShareFootprintMB()]);
  return [super initWithNibName:nibName bundle:bundle];
}

- (instancetype)initWithCoder:(NSCoder *)coder {
  GLShareDebugLog([NSString stringWithFormat:@"share-ext: init pid=%d mem=%ldMB",
                   getpid(), GLShareFootprintMB()]);
  return [super initWithCoder:coder];
}

- (void)didReceiveMemoryWarning {
  GLShareDebugLog([NSString stringWithFormat:@"share-ext: memory-warning mem=%ldMB",
                   GLShareFootprintMB()]);
  [super didReceiveMemoryWarning];
}

- (void)viewDidLoad {
  [super viewDidLoad];
  GLShareDebugLog([NSString stringWithFormat:@"share-ext: viewDidLoad items=%lu mem=%ldMB",
                   (unsigned long)self.extensionContext.inputItems.count, GLShareFootprintMB()]);
  for (NSExtensionItem *item in self.extensionContext.inputItems) {
    for (NSItemProvider *p in item.attachments) {
      GLShareDebugLog([NSString stringWithFormat:@"share-ext: provider types=%@ name=%@",
                       [p.registeredTypeIdentifiers componentsJoinedByString:@","],
                       p.suggestedName ?: @"-"]);
    }
  }
  self.view.backgroundColor = UIColor.systemBackgroundColor;
  self.providers = [self collectProviders];
  self.imageProviders = [self collectImageProviders];
#ifdef GL_VOICE_ACTION
  [self buildVoiceUI];
  // "Voice chat" action extension (VoiceToDesktop target, same source file):
  // no /drop upload and no buttons -- hand the photos to the app and open the
  // voice session immediately. Photo prep starts here so it overlaps the
  // sheet's presentation; the open itself waits for -viewIsAppearing:.
  self.started = YES;
  self.dropUploadAttemptFinished = YES;
  if (self.imageProviders.count == 0) {
    [self showConversationFailure:@"No photo was shared."];
    return;
  }
  [self startConversationWithMode:@"voice"];
#else
  [self buildUI];
#endif
}

// Called once the view is in the window but before the presentation
// animation runs -- the earliest point the responder chain reaches
// UIApplication, ~0.2-0.5s before -viewDidAppear:.
- (void)viewIsAppearing:(BOOL)animated {
  [super viewIsAppearing:animated];
  GLShareDebugLog(@"share-ext: viewIsAppearing");
  self.viewInWindow = YES;
  if (self.pendingOpenIDs) [self openSessionWithHandoffIDs:self.pendingOpenIDs];
}

- (void)viewDidAppear:(BOOL)animated {
  [super viewDidAppear:animated];
  GLShareDebugLog([NSString stringWithFormat:@"share-ext: viewDidAppear mem=%ldMB",
                   GLShareFootprintMB()]);
  if (self.started) return;
  self.started = YES;
  [self startUploads];
}

/// The share sheet can hand over several extension items, each with several
/// attachments; flatten them and keep everything GLDropUploader can stage
/// (images, videos, audio recordings, plain files), capped at kMaxItems.
- (NSArray<NSItemProvider *> *)collectProviders {
  NSMutableArray<NSItemProvider *> *out = [NSMutableArray array];
  for (NSExtensionItem *item in self.extensionContext.inputItems) {
    for (NSItemProvider *provider in item.attachments) {
      if ([GLDropUploader providerIsSupported:provider] && out.count < kMaxItems) {
        [out addObject:provider];
      }
    }
  }
  return out;
}

/// Subset of -collectProviders: images only (no video — session.html's
/// attachment strip is images-only), capped lower than the /drop list since
/// these get embedded inline in the chat rather than just dropped to disk.
- (NSArray<NSItemProvider *> *)collectImageProviders {
  NSMutableArray<NSItemProvider *> *out = [NSMutableArray array];
  for (NSItemProvider *provider in self.providers) {
    if ([provider hasItemConformingToTypeIdentifier:kImageType] &&
        out.count < kMaxConversationItems) {
      [out addObject:provider];
    }
  }
  return out;
}

#pragma mark - UI

- (void)buildUI {
  UILabel *title = [[UILabel alloc] init];
  title.text = @"Share to desktop";
  title.font = [UIFont boldSystemFontOfSize:18];
  title.textAlignment = NSTextAlignmentCenter;

  self.spinner = [[UIActivityIndicatorView alloc]
      initWithActivityIndicatorStyle:UIActivityIndicatorViewStyleMedium];
  [self.spinner startAnimating];

  self.statusLabel = [[UILabel alloc] init];
  self.statusLabel.font = [UIFont systemFontOfSize:13];
  self.statusLabel.textColor = UIColor.secondaryLabelColor;
  self.statusLabel.textAlignment = NSTextAlignmentCenter;
  self.statusLabel.numberOfLines = 0;
  self.statusLabel.text = [NSString stringWithFormat:@"%lu item%@",
                                                     (unsigned long)self.providers.count,
                                                     self.providers.count == 1 ? @"" : @"s"];

  UIStackView *rows = [[UIStackView alloc] init];
  rows.axis = UILayoutConstraintAxisVertical;
  rows.spacing = 4;
  self.rowLabels = [NSMutableArray array];
  for (NSUInteger i = 0; i < self.providers.count; i++) {
    UILabel *row = [[UILabel alloc] init];
    row.font = [UIFont monospacedDigitSystemFontOfSize:13 weight:UIFontWeightRegular];
    row.lineBreakMode = NSLineBreakByTruncatingMiddle;
    row.text = [NSString stringWithFormat:@"%lu. waiting…", (unsigned long)(i + 1)];
    [self.rowLabels addObject:row];
    [rows addArrangedSubview:row];
  }

  self.retryButton = [UIButton buttonWithType:UIButtonTypeSystem];
  [self.retryButton setTitle:@"Retry" forState:UIControlStateNormal];
  [self.retryButton addTarget:self
                       action:@selector(retryTapped)
             forControlEvents:UIControlEventTouchUpInside];
  self.retryButton.hidden = YES;

  self.doneButton = [UIButton buttonWithType:UIButtonTypeSystem];
  [self.doneButton setTitle:@"Done" forState:UIControlStateNormal];
  self.doneButton.titleLabel.font = [UIFont boldSystemFontOfSize:15];
  [self.doneButton addTarget:self
                       action:@selector(doneTapped)
             forControlEvents:UIControlEventTouchUpInside];
  self.doneButton.hidden = YES;

  UIButton *cancel = [UIButton buttonWithType:UIButtonTypeSystem];
  [cancel setTitle:@"Cancel" forState:UIControlStateNormal];
  [cancel addTarget:self
                action:@selector(cancelTapped)
      forControlEvents:UIControlEventTouchUpInside];

  UIStackView *buttons = [[UIStackView alloc]
      initWithArrangedSubviews:@[ cancel, self.retryButton, self.doneButton ]];
  buttons.axis = UILayoutConstraintAxisHorizontal;
  buttons.spacing = 24;
  buttons.distribution = UIStackViewDistributionFillEqually;

  // "Start conversation" section -- independent of the /drop upload above,
  // visible (though maybe disabled) from first paint.
  self.startConversationButton = [UIButton buttonWithType:UIButtonTypeSystem];
  [self.startConversationButton setTitle:@"Start conversation" forState:UIControlStateNormal];
  self.startConversationButton.titleLabel.font = [UIFont boldSystemFontOfSize:16];
  [self.startConversationButton addTarget:self
                                    action:@selector(startConversationTapped)
                          forControlEvents:UIControlEventTouchUpInside];

  [self setConversationButtonsEnabled:self.imageProviders.count > 0];

  self.conversationStatusLabel = [[UILabel alloc] init];
  self.conversationStatusLabel.font = [UIFont systemFontOfSize:13];
  self.conversationStatusLabel.textColor = UIColor.secondaryLabelColor;
  self.conversationStatusLabel.textAlignment = NSTextAlignmentCenter;
  self.conversationStatusLabel.numberOfLines = 0;
  self.conversationStatusLabel.hidden = YES;

  self.conversationRetryButton = [UIButton buttonWithType:UIButtonTypeSystem];
  [self.conversationRetryButton setTitle:@"Retry" forState:UIControlStateNormal];
  [self.conversationRetryButton addTarget:self
                                    action:@selector(retryConversationTapped)
                          forControlEvents:UIControlEventTouchUpInside];
  self.conversationRetryButton.hidden = YES;

  UIStackView *conversationStack = [[UIStackView alloc] initWithArrangedSubviews:@[
    self.startConversationButton, self.conversationStatusLabel, self.conversationRetryButton
  ]];
  conversationStack.axis = UILayoutConstraintAxisVertical;
  conversationStack.spacing = 6;

  UIStackView *stack = [[UIStackView alloc] initWithArrangedSubviews:@[
    title, self.spinner, self.statusLabel, rows, buttons, conversationStack
  ]];
  stack.axis = UILayoutConstraintAxisVertical;
  stack.spacing = 12;
  stack.translatesAutoresizingMaskIntoConstraints = NO;
  [self.view addSubview:stack];

  UILayoutGuide *guide = self.view.layoutMarginsGuide;
  [NSLayoutConstraint activateConstraints:@[
    [stack.centerYAnchor constraintEqualToAnchor:self.view.centerYAnchor],
    [stack.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor constant:16],
    [stack.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor constant:-16],
  ]];
}

#ifdef GL_VOICE_ACTION
/// Minimal UI for the "Voice chat" action: a status label and Cancel.
- (void)buildVoiceUI {
  self.conversationStatusLabel = [[UILabel alloc] init];
  self.conversationStatusLabel.font = [UIFont systemFontOfSize:15];
  self.conversationStatusLabel.textColor = UIColor.secondaryLabelColor;
  self.conversationStatusLabel.textAlignment = NSTextAlignmentCenter;
  self.conversationStatusLabel.numberOfLines = 0;
  self.conversationStatusLabel.text = @"Opening…";

  UIButton *cancel = [UIButton buttonWithType:UIButtonTypeSystem];
  [cancel setTitle:@"Cancel" forState:UIControlStateNormal];
  [cancel addTarget:self
                action:@selector(cancelTapped)
      forControlEvents:UIControlEventTouchUpInside];

  UIStackView *stack = [[UIStackView alloc] initWithArrangedSubviews:@[ self.conversationStatusLabel, cancel ]];
  stack.axis = UILayoutConstraintAxisVertical;
  stack.spacing = 16;
  stack.translatesAutoresizingMaskIntoConstraints = NO;
  [self.view addSubview:stack];
  [NSLayoutConstraint activateConstraints:@[
    [stack.centerYAnchor constraintEqualToAnchor:self.view.centerYAnchor],
    [stack.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor constant:24],
    [stack.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor constant:-24],
  ]];
}
#endif

- (void)setRow:(NSUInteger)index text:(NSString *)text {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (index < self.rowLabels.count) {
      self.rowLabels[index].text = [NSString stringWithFormat:@"%lu. %@", (unsigned long)(index + 1), text];
    }
  });
}

- (void)showFailure:(NSString *)message {
  dispatch_async(dispatch_get_main_queue(), ^{
    [self.spinner stopAnimating];
    self.spinner.hidden = YES;
    self.statusLabel.textColor = UIColor.systemRedColor;
    self.statusLabel.text = message;
    self.retryButton.hidden = NO;
  });
}

- (void)retryTapped {
  self.retryButton.hidden = YES;
  self.spinner.hidden = NO;
  [self.spinner startAnimating];
  self.statusLabel.textColor = UIColor.secondaryLabelColor;
  self.statusLabel.text = @"Retrying…";
  self.dropUploadAttemptFinished = NO;
  [self startUploads];
}

// Marks the /drop attempt settled (success or failure) and, if a
// Start-conversation completion is waiting on it, finishes the extension
// request now -- see completePendingDropFinish's doc comment.
- (void)markDropAttemptFinished {
  self.dropUploadAttemptFinished = YES;
  if (self.completePendingDropFinish) {
    self.completePendingDropFinish = NO;
    [self.extensionContext completeRequestReturningItems:@[] completionHandler:nil];
  }
}

- (void)doneTapped {
  [self.extensionContext completeRequestReturningItems:@[] completionHandler:nil];
}

- (void)cancelTapped {
  [self.extensionContext cancelRequestWithError:[NSError errorWithDomain:@"ShareToDesktop"
                                                                    code:1
                                                                userInfo:nil]];
}

#pragma mark - Upload (/drop, auto-started)

- (void)startUploads {
  if (self.providers.count == 0) {
    [self showFailure:@"Nothing to upload — nothing shareable as a file was shared."];
    [self markDropAttemptFinished];
    return;
  }
  if ([GLDropToken isEqualToString:@"NO_TOKEN_BAKED_IN"]) {
    [self showFailure:@"No token baked in — this build cannot upload."];
    [self markDropAttemptFinished];
    return;
  }
  if ([GLDropHost isEqualToString:@"NO_HOST_BAKED_IN"]) {
    [self showFailure:@"No host baked in — this build cannot upload."];
    [self markDropAttemptFinished];
    return;
  }

  // One background session per attempt (own identifier, see GLDropBackground).
  // The transfers are run by nsurlsessiond, so they survive this extension
  // being dismissed or killed; a failure is reported by a local notification
  // from whichever process hears about it (GLDropBackground).
  GLDropBackground.logHandler = ^(NSString *line) { GLShareDebugLog([@"share-ext: " stringByAppendingString:line]); };
  self.dropSession = [GLDropBackground newUploadSession];
  GLShareDebugLog([NSString stringWithFormat:@"share-ext: bg-session created id=%@",
                   self.dropSession.identifier]);
  NSURL *stagingRoot = self.dropSession.stagingRoot;
  if (!stagingRoot) {
    [self showFailure:@"App Group container unavailable — this build cannot upload."];
    [self markDropAttemptFinished];
    return;
  }

  self.statusLabel.text = @"Uploading — you can close this";
  __block NSString *firstError = nil;
  __block NSUInteger queued = 0;
  // `startedGroup` settles once every item is either handed to the background
  // session or has failed to load; `group` settles once every upload has
  // finished while this extension is still alive.
  dispatch_group_t startedGroup = dispatch_group_create();
  dispatch_group_t group = dispatch_group_create();

  [self.providers enumerateObjectsUsingBlock:^(NSItemProvider *provider, NSUInteger idx, BOOL *stop) {
    dispatch_group_enter(group);
    dispatch_group_enter(startedGroup);
    // Photos may export or pull a video down from iCloud before it vends the
    // file, which for a long clip takes a while with nothing else to show.
    BOOL isMovie = [GLDropUploader kindOfProvider:provider] == GLDropKindMovie;
    [self setRow:idx text:isMovie ? @"preparing video…" : @"loading…"];
    GLShareDebugLog([NSString stringWithFormat:@"share-ext: load start idx=%lu kind=%@ mem=%ldMB",
                     (unsigned long)idx, isMovie ? @"movie" : @"other", GLShareFootprintMB()]);
    NSDate *loadStart = [NSDate date];
    [GLDropUploader loadItemFromProvider:provider
                  index:idx
             completion:^(NSURL *fileURL, NSString *filename, NSString *contentType, NSString *error) {
               NSNumber *stagedBytes = fileURL
                   ? [[NSFileManager.defaultManager attributesOfItemAtPath:fileURL.path error:nil] objectForKey:NSFileSize]
                   : nil;
               GLShareDebugLog([NSString stringWithFormat:@"share-ext: load done idx=%lu %@ elapsed=%.1fs mem=%ldMB",
                                (unsigned long)idx,
                                fileURL ? [NSString stringWithFormat:@"bytes=%@", stagedBytes] : [NSString stringWithFormat:@"error=%@", error],
                                -[loadStart timeIntervalSinceNow], GLShareFootprintMB()]);
               NSString *loadError = error;
               NSURL *groupFile = nil;
               NSString *taskDescription = nil;
               if (fileURL) {
                 // Background upload tasks must be fromFile:, and the file has
                 // to be somewhere nsurlsessiond (and the app) can read after
                 // this process is gone: the group container, not our tmp.
                 groupFile = [GLDropBackground moveFileAtURL:fileURL
                                                    filename:filename
                                                      toRoot:stagingRoot
                                             taskDescription:&taskDescription
                                                       error:&loadError];
               }
               if (!groupFile) {
                 NSString *name = provider.suggestedName ?: [NSString stringWithFormat:@"Item %lu", (unsigned long)(idx + 1)];
                 [self setRow:idx text:[NSString stringWithFormat:@"failed — %@", loadError]];
                 if (!firstError) firstError = loadError;
                 [self.dropSession postFailureNotificationWithIdentifier:[NSString stringWithFormat:@"drop-failed-load-%@-%lu", self.dropSession.identifier, (unsigned long)idx]
                                                                filename:name
                                                                  reason:loadError];
                 dispatch_group_leave(startedGroup);
                 dispatch_group_leave(group);
                 return;
               }
               [self setRow:idx text:[NSString stringWithFormat:@"%@ — uploading…", filename]];
               __block int64_t lastPercent = -1;
               GLShareDebugLog([NSString stringWithFormat:@"share-ext: upload start idx=%lu mem=%ldMB",
                                (unsigned long)idx, GLShareFootprintMB()]);
               NSDate *uploadStart = [NSDate date];
               [self.dropSession
                   uploadStagedFileAtURL:groupFile
                         taskDescription:taskDescription
                             contentType:contentType
                              toEndpoint:[NSString stringWithFormat:@"http://%@:8302/drop", GLDropHost]
                                   token:GLDropToken
                                progress:^(int64_t sent, int64_t total) {
                                  if (total <= 0) return;
                                  int64_t percent = sent * 100 / total;
                                  if (percent == lastPercent) return;
                                  lastPercent = percent;
                                  [self setRow:idx text:[NSString stringWithFormat:@"%@ — uploading %lld%% (%lld / %lld MB)",
                                                         filename, percent, sent / 1000000, total / 1000000]];
                                }
                              completion:^(NSString *doneName, NSString *uploadError) {
                                GLShareDebugLog([NSString stringWithFormat:@"share-ext: upload done idx=%lu %@ elapsed=%.1fs",
                                                 (unsigned long)idx, uploadError ? [NSString stringWithFormat:@"error=%@", uploadError] : @"ok",
                                                 -[uploadStart timeIntervalSinceNow]]);
                                if (uploadError) {
                                  [self setRow:idx text:[NSString stringWithFormat:@"%@ — failed", filename]];
                                  if (!firstError) firstError = uploadError;
                                } else {
                                  [self setRow:idx text:[NSString stringWithFormat:@"%@ — Uploaded ✓", filename]];
                                }
                                dispatch_group_leave(group);
                              }];
               queued++;
               dispatch_group_leave(startedGroup);
             }];
  }];

  dispatch_group_notify(startedGroup, dispatch_get_main_queue(), ^{
    // Every upload is now owned by the background session, so ending the
    // extension no longer kills anything: unblock the "Start conversation"
    // completion and offer Done while the transfers are still running.
    [self markDropAttemptFinished];
    if (queued > 0) self.doneButton.hidden = NO;
  });

  dispatch_group_notify(group, dispatch_get_main_queue(), ^{
    if (firstError) {
      [self showFailure:firstError];
      return;
    }
    [self.spinner stopAnimating];
    self.spinner.hidden = YES;
    self.statusLabel.text = @"Uploaded ✓";
    self.dropUploadsDone = YES;
    self.doneButton.hidden = NO;
  });
}

#pragma mark - "Start conversation"

- (void)setConversationButtonsEnabled:(BOOL)enabled {
  self.startConversationButton.enabled = enabled;
}

- (void)startConversationTapped {
  [self startConversationWithMode:@"text"];
}

- (void)retryConversationTapped {
  [self startConversationWithMode:self.conversationMode ?: @"text"];
}

- (void)startConversationWithMode:(NSString *)mode {
  if (self.conversationInFlight) return;
  if (self.imageProviders.count == 0) return;
  self.conversationInFlight = YES;
  self.conversationMode = mode;
  [self setConversationButtonsEnabled:NO];
  self.conversationRetryButton.hidden = YES;
  self.conversationStatusLabel.hidden = NO;
  self.conversationStatusLabel.textColor = UIColor.secondaryLabelColor;

  // Serial, one image at a time -- NOT enumerateObjectsUsingBlock: kicking
  // off all 5 loads/uploads concurrently. Each load decodes a full image
  // (see -downsampledJPEGDataAtURL:) and, alongside the concurrent /drop
  // uploads already running, five decodes in flight at once is what was
  // blowing the extension's jetsam limit.
  [self uploadConversationImageAtIndex:0
                                  total:self.imageProviders.count
                            uploadedIDs:[NSMutableArray arrayWithCapacity:self.imageProviders.count]];
}

- (void)uploadConversationImageAtIndex:(NSUInteger)index
                                  total:(NSUInteger)total
                            uploadedIDs:(NSMutableArray<NSString *> *)handoffIDs {
  if (index == total) {
    self.conversationStatusLabel.textColor = UIColor.secondaryLabelColor;
    self.conversationStatusLabel.text = @"Opening…";
    GLShareDebugLog(@"share-ext: photos prepared");
    if (!self.viewInWindow) {
      self.pendingOpenIDs = handoffIDs;
      return;
    }
    [self openSessionWithHandoffIDs:handoffIDs];
    return;
  }

  self.conversationStatusLabel.text =
      [NSString stringWithFormat:@"Preparing %lu/%lu…", (unsigned long)(index + 1), (unsigned long)total];

  NSItemProvider *provider = self.imageProviders[index];
  __weak __typeof(self) weakSelf = self;
  [self loadSessionImageDataFromProvider:provider
                               completion:^(NSData *data, NSString *contentType, NSString *loadError) {
    __typeof(self) strongSelf = weakSelf;
    if (!strongSelf) return;
    if (!data) {
      strongSelf.conversationInFlight = NO;
      [strongSelf showConversationFailure:loadError ?: @"could not read image"];
      return;
    }
    NSString *handoffID = NSUUID.UUID.UUIDString;
    NSDictionary *item = @{
      (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
      (__bridge id)kSecAttrAccessGroup: kHandoffKeychainAccessGroup,
      (__bridge id)kSecAttrService: kHandoffKeychainService,
      (__bridge id)kSecAttrAccount: handoffID,
      (__bridge id)kSecValueData: data,
      (__bridge id)kSecAttrAccessible: (__bridge id)kSecAttrAccessibleAfterFirstUnlock,
    };
    OSStatus status = SecItemAdd((__bridge CFDictionaryRef)item, NULL);
    if (status != errSecSuccess) {
      strongSelf.conversationInFlight = NO;
      [strongSelf showConversationFailure:
          [NSString stringWithFormat:@"could not stash photo (keychain OSStatus %d)", (int)status]];
      return;
    }
    [handoffIDs addObject:handoffID];
    [strongSelf uploadConversationImageAtIndex:index + 1 total:total uploadedIDs:handoffIDs];
  }];
}

- (void)showConversationFailure:(NSString *)message {
  [self setConversationButtonsEnabled:YES];
  self.conversationStatusLabel.textColor = UIColor.systemRedColor;
  self.conversationStatusLabel.text = message;
  self.conversationRetryButton.hidden = NO;
}

/// Loads the provider's ORIGINAL file (not a re-encoded in-memory object --
/// see -downsampledJPEGDataAtURL: for why) and downsamples+re-encodes it to
/// JPEG regardless of source format, PNG included: a 48MP PNG decoded at
/// full resolution is exactly as fatal to the extension's memory limit as a
/// 48MP HEIC. The public.image type identifier here (not a PNG/JPEG-
/// specific one) accepts whatever the provider's native format is.
- (void)loadSessionImageDataFromProvider:(NSItemProvider *)provider
                               completion:(void (^)(NSData *_Nullable data,
                                                     NSString *_Nullable contentType,
                                                     NSString *_Nullable error))completion {
  [provider loadFileRepresentationForTypeIdentifier:kImageType
                                   completionHandler:^(NSURL *url, NSError *error) {
    // url is only valid for the duration of this handler, so the decode +
    // downsample + re-encode has to happen synchronously right here rather
    // than staging the URL away for later -- this handler already runs off
    // the main thread, so doing the work inline doesn't block the UI.
    NSData *jpeg = url ? [self downsampledJPEGDataAtURL:url] : nil;
    dispatch_async(dispatch_get_main_queue(), ^{
      if (!jpeg) {
        completion(nil, nil, error.localizedDescription ?: @"could not read/decode image");
        return;
      }
      completion(jpeg, @"image/jpeg", nil);
    });
  }];
}

/// ImageIO thumbnail path: CGImageSourceCreateThumbnailAtIndex decodes
/// directly to the target pixel size without ever materializing the
/// original full-resolution bitmap, unlike +[UIImage imageWithContentsOfURL:]
/// (or -loadObjectOfClass:[UIImage class]) followed by a resize, which
/// decodes full-res first and only THEN throws most of it away -- a 48MP
/// photo is ~190MB as a decoded RGBA bitmap, comfortably past a share
/// extension's ~120MB jetsam ceiling, before a single byte of downsizing
/// has happened. kCGImageSourceThumbnailMaxPixelSize is a cap, not a
/// target, so a smaller source is unaffected; kCGImageSourceCreateThumbnailWithTransform
/// applies the image's EXIF orientation so a downsized photo isn't rotated.
- (nullable NSData *)downsampledJPEGDataAtURL:(NSURL *)url {
  NSDictionary *sourceOptions = @{(id)kCGImageSourceShouldCache : @NO};
  CGImageSourceRef source =
      CGImageSourceCreateWithURL((__bridge CFURLRef)url, (__bridge CFDictionaryRef)sourceOptions);
  if (!source) return nil;

  NSDictionary *thumbnailOptions = @{
    (id)kCGImageSourceCreateThumbnailFromImageAlways : @YES,
    (id)kCGImageSourceThumbnailMaxPixelSize : @(kAttachmentMaxPixelSize),
    (id)kCGImageSourceCreateThumbnailWithTransform : @YES,
  };
  CGImageRef thumbnail =
      CGImageSourceCreateThumbnailAtIndex(source, 0, (__bridge CFDictionaryRef)thumbnailOptions);
  CFRelease(source);
  if (!thumbnail) return nil;

  UIImage *image = [UIImage imageWithCGImage:thumbnail];
  CGImageRelease(thumbnail);
  return UIImageJPEGRepresentation(image, kAttachmentJPEGQuality);
}

#pragma mark - Opening the containing app

- (void)openSessionWithHandoffIDs:(NSArray<NSString *> *)ids {
  self.pendingOpenIDs = nil;
  NSURL *url = [GLDropUploader sessionURLForMode:self.conversationMode handoffIDs:ids];

  __weak __typeof(self) weakSelf = self;
  [self openContainingAppURL:url
                   completion:^(BOOL success) {
    __typeof(self) strongSelf = weakSelf;
    if (!strongSelf) return;
    if (!success) {
      strongSelf.conversationInFlight = NO;
      [strongSelf showConversationFailure:@"Couldn't open the app — tap Retry."];
      return;
    }
    if (!strongSelf.dropUploadAttemptFinished) {
      // Some /drop items are still being loaded and staged into the group
      // container; ending the extension now would lose them. Wait for
      // -markDropAttemptFinished (every item handed to the background
      // session) to actually end the extension.
      strongSelf.conversationStatusLabel.text = @"Finishing desktop upload…";
      strongSelf.completePendingDropFinish = YES;
      return;
    }
    [strongSelf.extensionContext completeRequestReturningItems:@[] completionHandler:nil];
  }];
}

/// Share extensions run in their own process with no `UIApplication` of
/// their own (`+[UIApplication sharedApplication]` is NS_EXTENSION_UNAVAILABLE
/// and returns nil even if called), so there is no public, compile-time-legal
/// way to ask the containing app to open a URL from here. The long-standing
/// workaround (used by Action/Share extensions for years, predating
/// `NSExtensionContext -openURL:completionHandler:`'s more restricted
/// chooser-style behavior for custom schemes) is to walk the responder chain
/// to the live `UIApplication` instance and call
/// `-openURL:options:completionHandler:` on it. `-openURL:options:completionHandler:`
/// takes three arguments (url, options dict, completion block), which is
/// beyond what `-performSelector:withObject:withObject:` can pass (it caps
/// at two), so this goes through `NSInvocation` instead; the single-argument
/// `-openURL:` some older references use is also known to return NO on
/// iOS 18+ for this cross-process case.
///
/// The completion handler passed down to the responder chain is a private
/// framework contract, not a documented guarantee -- some iOS versions/host
/// contexts are known to just never call it. Without a fallback, a user
/// hitting that case sees "Opening…" forever with no way out except
/// force-quitting the share sheet. `completion` is guarded so ONLY the
/// first of {the real callback, the ~4s timeout} actually fires.
- (void)openContainingAppURL:(NSURL *)url completion:(void (^)(BOOL success))completion {
  __block BOOL didComplete = NO;
  void (^completeOnce)(BOOL) = ^(BOOL success) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (didComplete) return;
      didComplete = YES;
      completion(success);
    });
  };

  // Only UIApplication will do. UIWindowScene sits earlier in the chain and
  // ALSO responds to openURL:options:completionHandler: (with a
  // UISceneOpenExternalURLOptions, not a dictionary), but the extension's
  // hosted scene can't open another app -- stopping at the first responder
  // that matches the selector hit the scene and the app never opened.
  // UIApplication's class is usable from an extension; only
  // +sharedApplication is extension-unavailable.
  Class applicationClass = NSClassFromString(@"UIApplication");
  SEL openSelector = NSSelectorFromString(@"openURL:options:completionHandler:");
  NSMutableArray<NSString *> *chain = [NSMutableArray array];
  UIResponder *responder = self;
  while ((responder = responder.nextResponder) != nil) {
    [chain addObject:NSStringFromClass([responder class])];
    if (![responder isKindOfClass:applicationClass] ||
        ![responder respondsToSelector:openSelector]) {
      continue;
    }
    GLShareDebugLog([NSString stringWithFormat:@"share-open invoking on %@ chain=%@",
                     NSStringFromClass([responder class]),
                     [chain componentsJoinedByString:@">"]]);

    NSMethodSignature *signature = [responder methodSignatureForSelector:openSelector];
    NSInvocation *invocation = [NSInvocation invocationWithMethodSignature:signature];
    invocation.selector = openSelector;
    invocation.target = responder;
    // The invocation object itself goes out of scope the instant -invoke
    // returns, well before openURL:options:completionHandler:'s async work
    // (and its retained completion block) actually runs -- without this,
    // ARC has no reason to keep url/options/completionBlock alive that long.
    [invocation retainArguments];

    NSDictionary *options = @{};
    void (^completionBlock)(BOOL) = ^(BOOL success) {
      GLShareDebugLog([NSString stringWithFormat:@"share-open completion success=%d", success]);
      completeOnce(success);
    };
    [invocation setArgument:&url atIndex:2];
    [invocation setArgument:&options atIndex:3];
    [invocation setArgument:&completionBlock atIndex:4];
    [invocation invoke];

    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(4.0 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
      if (!didComplete) GLShareDebugLog(@"share-open timed out after 4s");
      completeOnce(NO);
    });
    return;
  }
  GLShareDebugLog([NSString stringWithFormat:@"share-open no UIApplication in chain=%@",
                   [chain componentsJoinedByString:@">"]]);
  completeOnce(NO);
}

@end
