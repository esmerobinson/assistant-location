// The Cooking tab: a WKWebView pointing at the cooking web app running on the
// desktop box (HTTPS port 9342 -> 8342, see CookingViewController.m).
//
// Thin subclass of GLWebModuleViewController (Shared/) — the base class owns
// the WKWebView setup, pull-to-refresh, error+retry view and theme
// propagation; this file supplies only the URL and display name.

#import "GLWebModuleViewController.h"

@interface CookingViewController : GLWebModuleViewController
@end
