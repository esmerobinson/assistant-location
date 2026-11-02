#!/usr/bin/env ruby
# Adds the Notification Service Extension "CycleNSE" (com.oliverullman.cycle.nse) to the existing
# Cycle app target and embeds it, modeled on add_duespike_app.rb. The extension POSTs a push's
# delivery receipt back to the box (see CycleNSE/CycleNotificationService.m). Objective-C, like the
# rest of CycleApp. Run via the gen-project workflow, commit the regenerated project.pbxproj.
# Idempotent: exits early when the target is already there.
require "xcodeproj"

TEAM = "J66WVM2DTX"
APP_ID = "com.oliverullman.cycle"
NSE_ID = "#{APP_ID}.nse"
NSE_PROFILE = "Cycle NSE AdHoc"

proj = Xcodeproj::Project.open("Overland.xcodeproj")
if proj.targets.any? { |t| t.name == "CycleNSE" }
  puts "CycleNSE target already present"
  exit 0
end
app = proj.targets.find { |t| t.name == "Cycle" } or abort "Cycle target not found; run add_cycle_app.rb first"

nse = proj.new_target(:app_extension, "CycleNSE", :ios, "15.0")
# Drop the SDK-versioned framework path the gem adds; module auto-linking links UserNotifications.
nse.frameworks_build_phase.files.to_a.each(&:remove_from_project)
group = proj.main_group.find_subpath("CycleNSE", true)
group.set_source_tree("SOURCE_ROOT")
nse.add_file_references(%w[CycleNotificationService.m CycleReceipt.m].map { |f| group.new_file("CycleNSE/#{f}") })
%w[CycleNotificationService.h CycleReceipt.h Info.plist].each { |f| group.new_file("CycleNSE/#{f}") }
nse.build_configurations.each do |c|
  c.build_settings.merge!(
    "PRODUCT_NAME" => "$(TARGET_NAME)",
    "PRODUCT_BUNDLE_IDENTIFIER" => NSE_ID,
    "INFOPLIST_FILE" => "CycleNSE/Info.plist",
    "GENERATE_INFOPLIST_FILE" => "NO",
    "IPHONEOS_DEPLOYMENT_TARGET" => "15.0",
    "TARGETED_DEVICE_FAMILY" => "1",
    "CLANG_ENABLE_MODULES" => "YES",
    "ENABLE_BITCODE" => "NO",
    "SKIP_INSTALL" => "YES",
    "CODE_SIGN_STYLE" => "Manual",
    "DEVELOPMENT_TEAM" => TEAM,
    "PROVISIONING_PROFILE_SPECIFIER" => NSE_PROFILE,
    "CODE_SIGN_IDENTITY" => "Apple Distribution",
    "LD_RUNPATH_SEARCH_PATHS" => ["$(inherited)", "@executable_path/Frameworks", "@executable_path/../../Frameworks"],
  )
end

app.add_dependency(nse)
embed = app.new_copy_files_build_phase("Embed App Extensions")
embed.symbol_dst_subfolder_spec = :plug_ins
embed.dst_path = ""
embed.add_file_reference(nse.product_reference).settings = { "ATTRIBUTES" => ["RemoveHeadersOnCopy"] }

proj.save
puts "Added CycleNSE (#{NSE_ID}) and embedded it in Cycle"
