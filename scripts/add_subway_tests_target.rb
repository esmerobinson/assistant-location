#!/usr/bin/env ruby
# Adds "SubwayTests": a host-less Swift XCTest bundle that compiles JournalControl/SubwayShared.swift and
# SubwayWidget.swift directly (like SharedTests reuses production .m files) and checks them against the real server
# fixtures in SubwayTests/fixtures. Run at CI time, never committed as a project diff. Idempotent.
require "xcodeproj"

proj = Xcodeproj::Project.open("Overland.xcodeproj")
exit 0 if proj.targets.any? { |t| t.name == "SubwayTests" }

test = proj.new_target(:unit_test_bundle, "SubwayTests", :ios, "17.0")
group = proj.main_group.find_subpath("SubwayTests", true)
group.set_source_tree("SOURCE_ROOT")
test.add_file_references(Dir["SubwayTests/*.swift"].sort.map { |p| group.new_reference(p) })
test.add_file_references(%w[SubwayShared SubwayWidget].map { |n| group.new_reference("JournalControl/#{n}.swift") })

test.build_configurations.each do |c|
  s = c.build_settings
  s["PRODUCT_NAME"] = "SubwayTests"
  s["PRODUCT_BUNDLE_IDENTIFIER"] = "com.oliverullman.assistantlocation.subwaytests"
  s["GENERATE_INFOPLIST_FILE"] = "YES"
  s["CODE_SIGN_STYLE"] = "Automatic"
  s["SWIFT_VERSION"] = "5.0"
  s["TARGETED_DEVICE_FAMILY"] = "1,2"
  s["IPHONEOS_DEPLOYMENT_TARGET"] = "17.0"
  s["LD_RUNPATH_SEARCH_PATHS"] = "$(inherited) @executable_path/Frameworks @loader_path/Frameworks"
end

scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(test)
scheme.add_test_target(test)
scheme.save_as(proj.path, "SubwayTests", true)
proj.save
puts "Added SubwayTests target + SubwayTests scheme"
