#import <Foundation/Foundation.h>

/// Over-the-air updates for the bundled web folder. The bundle is the offline floor; a newer verified
/// copy fetched from the box (`<boxUrl>/app/manifest.json` + `/app/<file>`) lives in `root` and is
/// used from the next cold page load. Both carry `version.json` ({"version": N}, commit time of the
/// build) and the downloaded copy also `shell.json` ({"minShell": N}, the oldest native shell that can
/// run it). `root` holds `v<version>/` folders plus `active.txt`, the pointer naming the live one.
@interface CycleWebUpdater : NSObject

/// The folder to load: the downloaded copy when its version beats the bundle's and its minShell fits
/// `shellVersion`, otherwise the bundle. The bundle must have a version.json.
+ (NSURL *)pageDirectoryWithRoot:(NSURL *)root bundleDirectory:(NSURL *)bundle shellVersion:(NSInteger)shellVersion;

/// Deletes superseded `v*` folders. Launch-time only: a running page may still be reading from one.
+ (void)pruneRoot:(NSURL *)root keepingDirectory:(NSURL *)page;

/// `boxUrl` from a config.js of the form `window.CYCLE_CONFIG = {...};` (nil + NSLog when absent).
+ (NSURL *)boxURLFromConfigAtURL:(NSURL *)config;

- (instancetype)initWithRoot:(NSURL *)root bundleDirectory:(NSURL *)bundle boxURL:(NSURL *)boxURL
                shellVersion:(NSInteger)shellVersion session:(NSURLSession *)session;

/// Runs `check` unless one ran in the last 10 minutes or is in flight. Main thread.
- (void)checkIfDue;

/// Like `checkIfDue`, with `completion` (main queue, only when a check actually ran) reporting whether a new copy was activated.
- (void)checkIfDueWithCompletion:(void (^)(BOOL activated))completion;

/// Whether a just-activated copy should replace the page on screen: only while the app is active and
/// within a few seconds of a launch or long-absence return (`freshOpenAt`), never mid-session.
+ (BOOL)shouldReloadAfterActivationWithFreshOpenAt:(NSDate *)freshOpenAt now:(NSDate *)now active:(BOOL)active;

/// Fetches the manifest and, when it is newer and compatible, downloads, verifies and swaps in the new
/// copy. Network and verification failures are logged and leave the active copy untouched. Runs on a
/// background queue; `completion` (optional, main queue) reports whether a new copy was activated.
- (void)checkWithCompletion:(void (^)(BOOL activated))completion;

@end
