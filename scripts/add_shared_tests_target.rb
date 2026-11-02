#!/usr/bin/env ruby
# Adds a standalone (host-less) unit-test bundle target ("SharedTests") to
# Overland.xcodeproj so Shared/ classes with no UIKit/app dependency (right
# now: GLTodoOutbox) can be exercised with plain XCTest, no Overland.app
# launch required. Mirrors scripts/add_uitest_target.rb's approach exactly
# (done in code via the xcodeproj gem, run at CI time, never committed as a
# generated project diff) but for a logic-test bundle instead of a UI-test
# bundle, so it deliberately skips that script's TEST_TARGET_NAME/
# add_dependency wiring -- a host-less bundle has no host target to depend
# on or launch. Idempotent: skips if the target already exists.
require "xcodeproj"

TEAM = "J66WVM2DTX"
proj = Xcodeproj::Project.open("Overland.xcodeproj")

if proj.targets.any? { |t| t.name == "SharedTests" }
  puts "SharedTests target already present"
  exit 0
end

test = proj.new_target(:unit_test_bundle, "SharedTests", :ios, "15.0")

group = proj.main_group.find_subpath("SharedTests", true)
group.set_source_tree("SOURCE_ROOT")
test_refs = Dir["SharedTests/*.m"].sort.map { |path| group.new_file(path) }
test.add_file_references(test_refs)

# GLTodoOutbox.m already has a PBXFileReference in the Shared group (it's
# compiled into the real Overland app target too -- see project.pbxproj).
# Reusing that SAME reference here means this test bundle compiles the
# actual production file, not a second copy of it. Matched on `name`, not
# `path` -- the Shared group itself carries no `path` (it's a virtual
# grouping folder), so each file's own `path` is project-relative
# ("Shared/GLTodoOutbox.m"), not bare -- `name` is the one attribute set to
# the plain filename.
shared_group = proj.main_group.find_subpath("Shared", false) or abort "no Shared group found"
outbox_ref = shared_group.files.find { |f| f.name == "GLTodoOutbox.m" || f.path == "Shared/GLTodoOutbox.m" } or abort "GLTodoOutbox.m file reference not found in Shared group -- was it added to the project?"
test.add_file_references([outbox_ref])

# GLTabBarButtonLocator.m lives in Modules/Todos/, a
# PBXFileSystemSynchronizedRootGroup (see project.pbxproj's "Begin
# PBXFileSystemSynchronizedRootGroup section") -- unlike Shared/, that kind
# of group has NO PBXFileReference for any of its files (the synced-group
# mechanism resolves them at build time instead), so there is nothing to
# reuse here the way outbox_ref is reused above. A fresh file reference,
# added straight into the SharedTests group, is the only way to compile this
# production file into the test bundle too.
locator_ref = group.new_reference("Modules/Todos/GLTabBarButtonLocator.m")
test.add_file_references([locator_ref])

# GLWebKeyboardFocus.m lives in Shared/, so its PBXFileReference is reused the
# same way GLTodoOutbox.m's is above rather than created fresh. It is compiled
# in so GLWebKeyboardFocusTests can install the real swizzles and assert
# against a real WKWebView -- the accessory-bar suppression is only meaningful
# as "does an actual WKContentView return nil", which needs the production
# file, not a reimplementation of it.
focus_ref = shared_group.files.find { |f| f.name == "GLWebKeyboardFocus.m" || f.path == "Shared/GLWebKeyboardFocus.m" } or abort "GLWebKeyboardFocus.m file reference not found in Shared group -- run scripts/add_shared_keyboard_focus.rb first"
test.add_file_references([focus_ref])

# GLKeyboardWebInset.m, same reuse-the-existing-reference reasoning. It depends
# on nothing but UIKit by design -- that is why the web view's bottom-edge
# behaviour was split out of GLWebModuleViewController, which drags in the
# bridge, the theme and BakedConfig and could not be compiled in here cheaply.
inset_ref = shared_group.files.find { |f| f.name == "GLKeyboardWebInset.m" || f.path == "Shared/GLKeyboardWebInset.m" } or abort "GLKeyboardWebInset.m file reference not found in Shared group -- run scripts/add_shared_keyboard_inset.rb first"
test.add_file_references([inset_ref])

# GLEsmeReminderScheduling.m lives in Modules/Esme/, also a
# PBXFileSystemSynchronizedRootGroup -- same reasoning as
# GLTabBarButtonLocator.m above, a fresh file reference straight into the
# SharedTests group, not a reused one, since synced groups have no
# PBXFileReference of their own to reuse.
esme_scheduling_ref = group.new_reference("Modules/Esme/GLEsmeReminderScheduling.m")
test.add_file_references([esme_scheduling_ref])

# QuotesModels.m/QuotesRuleEngine.m/QuotesImportParser.m live in
# QuotesApp/Sources/, also a PBXFileSystemSynchronizedRootGroup -- same
# reasoning as GLTabBarButtonLocator.m/GLEsmeReminderScheduling.m above,
# fresh file references straight into the SharedTests group. All three are
# deliberately plain Foundation (no UIKit, no GLTheme, no keychain) so they
# compile into this host-less bundle with nothing else pulled in.
quotes_models_ref = group.new_reference("QuotesApp/Sources/QuotesModels.m")
quotes_rule_engine_ref = group.new_reference("QuotesApp/Sources/QuotesRuleEngine.m")
quotes_import_parser_ref = group.new_reference("QuotesApp/Sources/QuotesImportParser.m")
test.add_file_references([quotes_models_ref, quotes_rule_engine_ref, quotes_import_parser_ref])

# QuotesStore.m, also QuotesApp/Sources/ -- unlike the three above it DOES pull
# in Security.framework (SecItem*) and GLLog.h (Shared/, header-only, no .m
# needed). QuotesStoreTests.m exercises it directly against the real
# Security framework (see that file's own comment for why an unsigned test
# bundle makes the errSecMissingEntitlement path deterministically
# reachable), so both the source and the framework link are required here.
quotes_store_ref = group.new_reference("QuotesApp/Sources/QuotesStore.m")
test.add_file_references([quotes_store_ref])

# QuotesDailyNotifier.m: the pure -entriesFromDate:... scheduling logic is
# tested here; the class also touches UserNotifications (module-autolinked).
test.add_file_references([group.new_reference("QuotesApp/Sources/QuotesDailyNotifier.m")])

# QuotesTheme.m: the date->grid-cell circle path (QuotesCirclePathTests) is a pure
# function living beside the UIKit theme helpers; UIKit is linked in the test bundle.
test.add_file_references([group.new_reference("QuotesApp/Sources/QuotesTheme.m")])

# ListenRewind.m (ListenApp/, owned by the Listen target) is plain Foundation: rewind preset
# validation/naming, kept apart from ListenPlayer (AVFoundation) so it compiles here.
test.add_file_references([group.new_reference("ListenApp/ListenRewind.m")])
# ListenSpeakPhrases.m: plain Foundation matching of the spoken "I'm done" / "continue" control words of a native
# speak turn, kept apart from ListenSpeakTurn (AVFoundation, Speech) so it compiles here.
test.add_file_references([group.new_reference("ListenApp/ListenSpeakPhrases.m")])
# ListenDownloads.m: plain Foundation offline-audio cache; the URL->path mapping and reject rules are tested.
test.add_file_references([group.new_reference("ListenApp/ListenDownloads.m")])
# ListenLinks.m: pure link-routing decision (external vs in-app) for the Listen web view.
test.add_file_references([group.new_reference("ListenApp/ListenLinks.m")])
# MarketplaceOutbox.m (MarketplaceApp/): plain Foundation reply queue of the Marketplace app.
test.add_file_references([group.new_reference("MarketplaceApp/MarketplaceOutbox.m")])
# GLLegacyQuotesPurge.m (Modules/, synced group): purge of pre-split Quotes notifications.
test.add_file_references([group.new_reference("Modules/GLLegacyQuotesPurge.m")])
test.add_system_framework("Security")

# QuotesStore's designated initializer eagerly loads stock-quotes.json from
# NSBundle mainBundle (-loadStockQuotesFromBundle raises if it's missing --
# see QuotesStore.m), so even a test that never touches -allQuotes still
# needs it in THIS bundle the moment it constructs a QuotesStore. Resource,
# not source: add_file_references would put it on the Compile Sources phase,
# so add it to Resources directly instead.
stock_quotes_ref = group.new_reference("QuotesApp/Sources/stock-quotes.json")
test.resources_build_phase.add_file_reference(stock_quotes_ref)

# GLDropUploader.m lives in Shared/ with its own PBXFileReference (it is
# compiled into both the app and the share extension), so it is reused the
# same way GLTodoOutbox.m's is. Foundation + UIKit only, no BakedConfig.
uploader_ref = shared_group.files.find { |f| f.name == "GLDropUploader.m" || f.path == "Shared/GLDropUploader.m" } or abort "GLDropUploader.m file reference not found in Shared group"
test.add_file_references([uploader_ref])

# GLDropBackground.m (Shared/, same reuse): the background-session half of the
# /drop upload; its session configuration, staging, failure mapping and
# notification path are what the tests below pin. Foundation + UserNotifications.
drop_bg_ref = shared_group.files.find { |f| f.name == "GLDropBackground.m" || f.path == "Shared/GLDropBackground.m" } or abort "GLDropBackground.m file reference not found in Shared group"
test.add_file_references([drop_bg_ref])

# GLDefaultTabArbiter.m sits at the top of Modules/ (synced group, same
# fresh-reference reasoning as above). Pure Foundation by design: the
# resume-vs-deep-link ordering it decides can only be tested by driving
# every callback order directly, which a simulator run can't do reliably.
arbiter_ref = group.new_reference("Modules/GLDefaultTabArbiter.m")
test.add_file_references([arbiter_ref])

# GLWebBackSwipe.m lives in Modules/WebBridge/ (synced group, same
# fresh-reference reasoning as above). Plain UIKit, no WebKit, so the
# back-swipe ownership rule is testable here without a running web view.
back_swipe_ref = group.new_reference("Modules/WebBridge/GLWebBackSwipe.m")
test.add_file_references([back_swipe_ref])

# ClipsTakesStore.m (Modules/Clips/, synced group): take-to-song map math.
test.add_file_references([group.new_reference("Modules/Clips/ClipsTakesStore.m")])
# GLDurableOutbox.m (Modules/, synced group, fresh reference). Foundation-only
# by design so the persist/retry/reject rules run against NSURLProtocol stubs.
outbox_durable_ref = group.new_reference("Modules/GLDurableOutbox.m")
test.add_file_references([outbox_durable_ref])

# GLMoreStackRepair.m (Modules/, synced group, fresh reference). Pure
# Foundation: the More-stack root repair behind the Journal-open crash.
test.add_file_references([group.new_reference("Modules/GLMoreStackRepair.m")])
# GLCrashDiagnosticMapping.m (Modules/CrashReporter, synced group, fresh reference). Pure: plain values in, dictionary out.
test.add_file_references([group.new_reference("Modules/CrashReporter/GLCrashDiagnosticMapping.m")])

# GLTabDoubleTap.m (Modules/, synced group, fresh reference). Pure
# Foundation: which tab bar tap sequences count as a double-tap-to-home.
test.add_file_references([group.new_reference("Modules/GLTabDoubleTap.m")])

# GLGrowthQuietWindow.m (Modules/Growth/, synced group, fresh reference). Pure
# Foundation: the Growth quiet-window max/never-shortens bookkeeping.
test.add_file_references([group.new_reference("Modules/Growth/GLGrowthQuietWindow.m")])
# Clips voice parser and manifest parser, pure Foundation.
test.add_file_references([group.new_reference("Modules/Clips/ClipsVoiceCommand.m")])
test.add_file_references([group.new_reference("Modules/Clips/ClipsCatalog.m")])

# Cycle shell (CycleApp/): the store, notifier and bridge are Foundation/UserNotifications (bridge
# also uses UIKit haptics, linked here); the view controller and app delegate are not compiled in.
%w[CycleStore CycleNotifier CycleBridge CycleWebUpdater].each do |n|
  test.add_file_references([group.new_reference("CycleApp/#{n}.m")])
end

# CycleNSE/CycleReceipt.m: the Notification Service Extension's receipt parsing and exactly-once
# gate. Foundation only, split out of the extension so it can be tested here.
test.add_file_references([group.new_reference("CycleNSE/CycleReceipt.m")])

test.build_configurations.each do |c|
  c.build_settings["PRODUCT_NAME"] = "SharedTests"
  c.build_settings["PRODUCT_BUNDLE_IDENTIFIER"] = "com.oliverullman.assistantlocation.sharedtests"
  c.build_settings["GENERATE_INFOPLIST_FILE"] = "YES"
  c.build_settings["CODE_SIGN_STYLE"] = "Automatic"
  c.build_settings["DEVELOPMENT_TEAM"] = TEAM
  c.build_settings["SWIFT_VERSION"] = "5.0"
  # GLWebKeyboardFocusTests #imports <WebKit/WebKit.h>; module autolinking
  # is what pulls WebKit.framework in without an explicit link phase entry.
  # Set explicitly rather than relying on the template default, since this
  # target is generated from scratch by this script on every CI run.
  c.build_settings["CLANG_ENABLE_MODULES"] = "YES"
  c.build_settings["ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES"] = "NO"
  c.build_settings["TARGETED_DEVICE_FAMILY"] = "1,2"
  c.build_settings["IPHONEOS_DEPLOYMENT_TARGET"] = "15.0"
  c.build_settings["LD_RUNPATH_SEARCH_PATHS"] = "$(inherited) @executable_path/Frameworks @loader_path/Frameworks"
  # Same "App" + "Shared" entries as the Overland target's own
  # HEADER_SEARCH_PATHS -- GLTodoOutbox.m #imports "BakedConfig.h" (App/)
  # and "GLLog.h" (Shared/) with flat, no-path #imports, same as every
  # other Shared/*.m file, so this target needs the identical search paths
  # to resolve them. "Modules/Todos" is added for the same reason:
  # GLTabBarButtonLocatorTests.m #imports "GLTabBarButtonLocator.h" flat,
  # and that header lives in Modules/Todos/, not one of the two paths above.
  # "Modules/Esme" is added the same way for
  # GLEsmeReminderSchedulingTests.m's flat #import "GLEsmeReminderScheduling.h".
  # "QuotesApp/Sources" added for the same reason as Todos/Esme above:
  # QuotesRuleEngineTests.m/QuotesImportParserTests.m #import
  # "QuotesModels.h"/"QuotesRuleEngine.h"/"QuotesImportParser.h" flat.
  # "Modules" itself for GLDefaultTabArbiterTests.m's "GLDefaultTabArbiter.h".
  # "Modules/WebBridge" for GLWebBackSwipeTests.m's "GLWebBackSwipe.h".
  c.build_settings["HEADER_SEARCH_PATHS"] = ["$(inherited)", "$(SRCROOT)/App", "$(SRCROOT)/Shared", "$(SRCROOT)/Modules/Todos", "$(SRCROOT)/Modules/Esme", "$(SRCROOT)/QuotesApp/Sources", "$(SRCROOT)/ListenApp","$(SRCROOT)/Modules", "$(SRCROOT)/Modules/WebBridge", "$(SRCROOT)/Modules/CrashReporter", "$(SRCROOT)/Modules/Growth", "$(SRCROOT)/Modules/Clips", "$(SRCROOT)/CycleApp", "$(SRCROOT)/CycleNSE"]
  # Deliberately no TEST_HOST / BUNDLE_LOADER: a standalone "logic test"
  # bundle needs no host app to launch, and no dependency edge onto
  # Overland -- which matters because a dependency edge would make the
  # Overland target's own archive/beta/adhoc builds try to build (and
  # code-sign) this bundle too, and it has no matching provisioning profile.
end

scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(test)
scheme.add_test_target(test)
scheme.save_as(proj.path, "SharedTests", true)

proj.save
puts "Added SharedTests target + SharedTests scheme"
