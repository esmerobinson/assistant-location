#import "CookingViewController.h"

#import "BakedConfig.h"

// The host is the one build-time secret (GL_BAKED_HOST, from
// App/BakedConfig.h); this tab only owns its own port.
//
// HTTPS on 9342, not HTTP on 8342, for the same reason as the Todos tab
// (see Modules/Todos/TodosViewController.m): the cooking app's offline shell
// cache is a ServiceWorker plus Cache Storage, and both are hard-gated by the
// browser to SECURE CONTEXTS. Over http://<raw tailnet IP>:8342
// `navigator.serviceWorker` is undefined, so the cache silently never
// registers. 9342 is `tailscale serve --https=9342` proxying to 8342 --
// tailnet-only, deliberately NOT the funnelled :443. See
// ~/.claude/rules/ports.md.
static NSInteger const kCookingPort = 9342;

@implementation CookingViewController

- (instancetype)init {
    NSString *urlString = [NSString stringWithFormat:@"https://%@:%ld/", GL_BAKED_HOST, (long)kCookingPort];
    return [self initWithURL:[NSURL URLWithString:urlString]
                 displayName:@"cooking"];
}

@end
