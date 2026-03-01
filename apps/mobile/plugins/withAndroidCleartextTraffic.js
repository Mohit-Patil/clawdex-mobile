const { AndroidConfig, withAndroidManifest } = require('@expo/config-plugins');

function withAndroidCleartextTraffic(config) {
  return withAndroidManifest(config, (modConfig) => {
    const mainApplication = AndroidConfig.Manifest.getMainApplicationOrThrow(
      modConfig.modResults
    );

    mainApplication.$['android:usesCleartextTraffic'] = 'true';
    return modConfig;
  });
}

module.exports = withAndroidCleartextTraffic;
