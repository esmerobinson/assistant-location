// The Listen screen: a WKWebView pointing at the Listen web app on the desktop
// box, port 9315 (HTTPS front for the 8315 server), plus the `listen` script message handler and the native
// audio objects that handler drives. Protocol: PROTOCOL.md in this directory.

#import <UIKit/UIKit.h>

@interface ListenViewController : UIViewController
/// The lock-screen Practice Control was pressed (PracticeIntent.swift): open the page on Practice. Safe to call more
/// than once per press and at any point of launch; see the implementation.
- (void)openPracticeFromShortcut;
@end
