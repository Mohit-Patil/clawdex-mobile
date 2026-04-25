const globalScope = globalThis;

function defineMissingStringProperty(target, key, value) {
  if (target && typeof target[key] === 'string' && target[key].length > 0) {
    return;
  }

  try {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  } catch {
    try {
      target[key] = value;
    } catch {
      // Best effort: React Native globals can be partially read-only.
    }
  }
}

function defineGlobalProperty(key, value) {
  if (typeof globalScope[key] !== 'undefined') {
    return;
  }

  try {
    Object.defineProperty(globalScope, key, {
      configurable: true,
      enumerable: false,
      value,
      writable: true,
    });
  } catch {
    globalScope[key] = value;
  }
}

defineGlobalProperty('navigator', {});
defineGlobalProperty('window', globalScope);

defineMissingStringProperty(globalScope.navigator, 'userAgent', 'ReactNative');
defineMissingStringProperty(globalScope.navigator, 'platform', 'ReactNative');

if (globalScope.window && !globalScope.window.navigator) {
  globalScope.window.navigator = globalScope.navigator;
}
