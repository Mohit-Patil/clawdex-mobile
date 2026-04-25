Pod::Spec.new do |s|
  s.name           = 'ClawdexTerminal'
  s.version        = '1.0.0'
  s.summary        = 'Native terminal renderer scaffold for Clawdex Mobile'
  s.description    = 'Expo module scaffolding for a libghostty-vt-backed in-app terminal.'
  s.author         = ''
  s.homepage       = 'https://github.com/ghostty-org/ghostty'
  s.platforms      = {
    :ios => '15.1',
    :tvos => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "*.{h,m,mm,swift,hpp,cpp}"

  vendored_framework = File.join(__dir__, 'vendor', 'ghostty-vt.xcframework')
  if File.directory?(vendored_framework)
    s.vendored_frameworks = 'vendor/ghostty-vt.xcframework'
  end
end
