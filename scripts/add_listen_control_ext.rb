#!/usr/bin/env ruby
# Adds the "ListenControl" widget extension (the lock-screen "Practice" Control)
# and embeds it in the standalone Listen app. PracticeIntent.swift is compiled
# into both the extension and the Listen app (see that file for why). Run via
# the gen-project workflow and commit the regenerated project.pbxproj.
#
# Idempotent: the target is created once; settings and file membership are
# re-applied on every run. The bundle id below is the personal app's; the
# Listen fastlane lanes override it per target for the guest copy.
require "xcodeproj"

TEAM = "J66WVM2DTX"
EXT_NAME = "ListenControl"
EXT_ID = "com.oliverullman.listen.practice"
EXT_PROFILE = "Listen Practice AdHoc"

proj = Xcodeproj::Project.open("Overland.xcodeproj")
app = proj.targets.find { |t| t.name == "Listen" } or abort "no Listen target"

def find_or_add_file_ref(proj, group, path)
  proj.files.find { |f| f.path == path } || group.new_file(path)
end

group = proj.main_group.find_subpath(EXT_NAME, true)
group.set_source_tree("SOURCE_ROOT")

ext = proj.targets.find { |t| t.name == EXT_NAME }
if ext
  puts "#{EXT_NAME} target already present; re-applying settings"
else
  ext = proj.new_target(:app_extension, EXT_NAME, :ios, "18.0")
  # The gem's default Foundation reference is pinned to one SDK; drop it.
  ext.frameworks_build_phase.files.to_a.each(&:remove_from_project)
  %w[Info.plist ListenControl.entitlements].each { |f| find_or_add_file_ref(proj, group, "#{EXT_NAME}/#{f}") }
end

bundle_ref = find_or_add_file_ref(proj, group, "#{EXT_NAME}/ListenControlBundle.swift")
intent_ref = find_or_add_file_ref(proj, group, "#{EXT_NAME}/PracticeIntent.swift")
ext.add_file_references([bundle_ref]) unless ext.source_build_phase.files_references.include?(bundle_ref)
[ext, app].each do |t|
  t.add_file_references([intent_ref]) unless t.source_build_phase.files_references.include?(intent_ref)
end

ext.build_configurations.each do |c|
  c.build_settings.merge!(
    "PRODUCT_NAME" => "$(TARGET_NAME)",
    "PRODUCT_BUNDLE_IDENTIFIER" => EXT_ID,
    "INFOPLIST_FILE" => "#{EXT_NAME}/Info.plist",
    "GENERATE_INFOPLIST_FILE" => "NO",
    "CODE_SIGN_ENTITLEMENTS" => "#{EXT_NAME}/#{EXT_NAME}.entitlements",
    "IPHONEOS_DEPLOYMENT_TARGET" => "18.0",
    "TARGETED_DEVICE_FAMILY" => "1",
    "SWIFT_VERSION" => "5.0",
    "SKIP_INSTALL" => "YES",
    "ENABLE_BITCODE" => "NO",
    "CODE_SIGN_STYLE" => "Manual",
    "DEVELOPMENT_TEAM" => TEAM,
    "PROVISIONING_PROFILE_SPECIFIER" => EXT_PROFILE,
    "CODE_SIGN_IDENTITY" => "Apple Distribution",
    "LD_RUNPATH_SEARCH_PATHS" => ["$(inherited)", "@executable_path/Frameworks", "@executable_path/../../Frameworks"],
  )
end

# PracticeIntent.swift makes the ObjC Listen target mixed-language.
app.build_configurations.each { |c| c.build_settings["SWIFT_VERSION"] = "5.0" }

app.add_dependency(ext) unless app.dependencies.any? { |d| d.target == ext }
embed = app.copy_files_build_phases.find { |p| p.symbol_dst_subfolder_spec == :plug_ins }
embed ||= app.new_copy_files_build_phase("Embed App Extensions")
embed.symbol_dst_subfolder_spec = :plug_ins
embed.dst_path = ""
unless embed.files_references.include?(ext.product_reference)
  embed.add_file_reference(ext.product_reference).settings = { "ATTRIBUTES" => ["RemoveHeadersOnCopy"] }
end

proj.save
puts "Added/updated #{EXT_NAME} (#{EXT_ID}), embedded in Listen"
