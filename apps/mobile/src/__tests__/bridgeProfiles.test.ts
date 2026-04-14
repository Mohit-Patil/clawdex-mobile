import type * as BridgeProfilesModule from '../bridgeProfiles';
import {
  createEmptyBridgeProfileStore,
  deriveBridgeProfileName,
  parseBridgeProfileStore,
  removeBridgeProfile,
  renameBridgeProfile,
  setActiveBridgeProfile,
  upsertBridgeProfile,
} from '../bridgeProfiles';

describe('bridgeProfiles', () => {
  it('derives a profile name from the bridge hostname when omitted', () => {
    expect(deriveBridgeProfileName(null, 'http://192.168.1.39:8787')).toBe('192.168.1.39');
  });

  it('upserts and activates profiles', () => {
    const empty = createEmptyBridgeProfileStore();
    const created = upsertBridgeProfile(empty, {
      name: 'Office Mac',
      bridgeUrl: 'http://192.168.1.39:8787',
      bridgeToken: 'secret-one',
      activate: true,
    }).store;

    expect(created.profiles).toHaveLength(1);
    expect(created.activeProfileId).toBe(created.profiles[0]?.id);

    const updated = upsertBridgeProfile(created, {
      id: created.profiles[0]?.id,
      name: 'Office Mac Mini',
      bridgeUrl: 'http://192.168.1.39:8787',
      bridgeToken: 'secret-two',
      activate: true,
    }).store;

    expect(updated.profiles).toHaveLength(1);
    expect(updated.profiles[0]?.name).toBe('Office Mac Mini');
    expect(updated.profiles[0]?.bridgeToken).toBe('secret-two');
    expect(updated.profiles[0]?.authMode).toBe('bridgeToken');
  });

  it('stores GitHub auth metadata for Codespaces profiles', () => {
    const created = upsertBridgeProfile(createEmptyBridgeProfileStore(), {
      name: 'clawdex-codespace · octocat-codespace',
      bridgeUrl: 'https://octocat-codespace-8787.app.github.dev',
      bridgeToken: 'gho_token',
      authMode: 'githubOAuth',
      githubUserLogin: 'octocat',
      githubCodespaceName: 'octocat-codespace',
      githubRepositoryFullName: 'octocat/clawdex-codespace',
      activate: true,
    }).store;

    expect(created.profiles[0]?.authMode).toBe('githubOAuth');
    expect(created.profiles[0]?.githubUserLogin).toBe('octocat');
    expect(created.profiles[0]?.githubCodespaceName).toBe('octocat-codespace');
    expect(created.profiles[0]?.githubRepositoryFullName).toBe('octocat/clawdex-codespace');
  });

  it('parses stores and drops invalid active ids', () => {
    const parsed = parseBridgeProfileStore(
      JSON.stringify({
        activeProfileId: 'missing',
        profiles: [
          {
            id: 'profile-1',
            name: 'Server A',
            bridgeUrl: 'http://10.0.0.1:8787',
            bridgeToken: 'token-a',
          },
        ],
      })
    );

    expect(parsed.activeProfileId).toBeNull();
    expect(parsed.profiles).toHaveLength(1);
  });

  it('changes the active profile without altering saved entries', () => {
    const base = parseBridgeProfileStore(
      JSON.stringify({
        activeProfileId: 'profile-1',
        profiles: [
          {
            id: 'profile-1',
            name: 'Server A',
            bridgeUrl: 'http://10.0.0.1:8787',
            bridgeToken: 'token-a',
          },
          {
            id: 'profile-2',
            name: 'Server B',
            bridgeUrl: 'http://10.0.0.2:8787',
            bridgeToken: 'token-b',
          },
        ],
      })
    );

    const switched = setActiveBridgeProfile(base, 'profile-2');

    expect(switched.activeProfileId).toBe('profile-2');
    expect(switched.profiles).toHaveLength(2);
  });

  it('renames a saved profile without touching its bridge config', () => {
    const base = parseBridgeProfileStore(
      JSON.stringify({
        activeProfileId: 'profile-1',
        profiles: [
          {
            id: 'profile-1',
            name: 'Server A',
            bridgeUrl: 'http://10.0.0.1:8787',
            bridgeToken: 'token-a',
          },
        ],
      })
    );

    const renamed = renameBridgeProfile(base, 'profile-1', 'Office Bridge');

    expect(renamed.profiles[0]?.name).toBe('Office Bridge');
    expect(renamed.profiles[0]?.bridgeUrl).toBe('http://10.0.0.1:8787');
    expect(renamed.profiles[0]?.bridgeToken).toBe('token-a');
  });

  it('removes the active profile and promotes another saved profile', () => {
    const base = parseBridgeProfileStore(
      JSON.stringify({
        activeProfileId: 'profile-1',
        profiles: [
          {
            id: 'profile-1',
            name: 'Server A',
            bridgeUrl: 'http://10.0.0.1:8787',
            bridgeToken: 'token-a',
          },
          {
            id: 'profile-2',
            name: 'Server B',
            bridgeUrl: 'http://10.0.0.2:8787',
            bridgeToken: 'token-b',
          },
        ],
      })
    );

    const next = removeBridgeProfile(base, 'profile-1');

    expect(next.activeProfileId).toBe('profile-2');
    expect(next.profiles).toHaveLength(1);
    expect(next.profiles[0]?.id).toBe('profile-2');
  });
});

describe('bridgeProfiles storage', () => {
  const bridgeProfileStoreKey = 'clawdex.bridge-profiles.v1';
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    if (originalLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
    } else {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  it('uses browser storage on web instead of expo-secure-store', async () => {
    const getItem = jest.fn().mockReturnValue(
      JSON.stringify({
        activeProfileId: 'profile-1',
        profiles: [
          {
            id: 'profile-1',
            name: 'Web Bridge',
            bridgeUrl: 'http://127.0.0.1:8787',
            bridgeToken: 'token-web',
          },
        ],
      })
    );
    const setItem = jest.fn();
    const removeItem = jest.fn();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem, setItem, removeItem },
    });

    const secureStoreMock = {
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'after-first-unlock',
      getItemAsync: jest.fn(),
      setItemAsync: jest.fn(),
      deleteItemAsync: jest.fn(),
    };

    jest.doMock('react-native', () => ({
      Platform: { OS: 'web' },
    }));
    jest.doMock('expo-secure-store', () => secureStoreMock);

    let bridgeProfiles!: typeof BridgeProfilesModule;
    jest.isolateModules(() => {
      bridgeProfiles = jest.requireActual('../bridgeProfiles') as typeof BridgeProfilesModule;
    });
    const loaded = await bridgeProfiles.loadBridgeProfileStore();
    await bridgeProfiles.saveBridgeProfileStore(loaded);
    await bridgeProfiles.clearBridgeProfileStore();

    expect(getItem).toHaveBeenCalledWith(bridgeProfileStoreKey);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(removeItem).toHaveBeenCalledWith(bridgeProfileStoreKey);
    expect(secureStoreMock.getItemAsync).not.toHaveBeenCalled();
    expect(secureStoreMock.setItemAsync).not.toHaveBeenCalled();
    expect(secureStoreMock.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('uses expo-secure-store on native platforms', async () => {
    const secureStoreMock = {
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'after-first-unlock',
      getItemAsync: jest.fn().mockResolvedValue(
        JSON.stringify({
          activeProfileId: null,
          profiles: [],
        })
      ),
      setItemAsync: jest.fn().mockResolvedValue(undefined),
      deleteItemAsync: jest.fn().mockResolvedValue(undefined),
    };

    jest.doMock('react-native', () => ({
      Platform: { OS: 'ios' },
    }));
    jest.doMock('expo-secure-store', () => secureStoreMock);

    let bridgeProfiles!: typeof BridgeProfilesModule;
    jest.isolateModules(() => {
      bridgeProfiles = jest.requireActual('../bridgeProfiles') as typeof BridgeProfilesModule;
    });
    const loaded = await bridgeProfiles.loadBridgeProfileStore();
    await bridgeProfiles.saveBridgeProfileStore(loaded);
    await bridgeProfiles.clearBridgeProfileStore();

    expect(secureStoreMock.getItemAsync).toHaveBeenCalledWith(bridgeProfileStoreKey);
    expect(secureStoreMock.setItemAsync).toHaveBeenCalledWith(
      bridgeProfileStoreKey,
      JSON.stringify({
        activeProfileId: null,
        profiles: [],
      }),
      {
        keychainAccessible: 'after-first-unlock',
      }
    );
    expect(secureStoreMock.deleteItemAsync).toHaveBeenCalledWith(bridgeProfileStoreKey);
  });

  it('falls back to in-memory web storage when localStorage reads return null', async () => {
    const getItem = jest.fn().mockReturnValue(null);
    const setItem = jest.fn().mockImplementation(() => {
      throw new Error('storage write blocked');
    });
    const removeItem = jest.fn();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem, setItem, removeItem },
    });

    jest.doMock('react-native', () => ({
      Platform: { OS: 'web' },
    }));
    jest.doMock('expo-secure-store', () => ({
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'after-first-unlock',
      getItemAsync: jest.fn(),
      setItemAsync: jest.fn(),
      deleteItemAsync: jest.fn(),
    }));

    let bridgeProfiles!: typeof BridgeProfilesModule;
    jest.isolateModules(() => {
      bridgeProfiles = jest.requireActual('../bridgeProfiles') as typeof BridgeProfilesModule;
    });

    const store = {
      activeProfileId: 'profile-1',
      profiles: [
        {
          id: 'profile-1',
          name: 'Blocked Web Bridge',
          bridgeUrl: 'http://127.0.0.1:8787',
          bridgeToken: 'token-web',
          authMode: 'bridgeToken' as const,
          githubUserLogin: null,
          githubCodespaceName: null,
          githubRepositoryFullName: null,
          createdAt: '2026-04-07T00:00:00.000Z',
          updatedAt: '2026-04-07T00:00:00.000Z',
        },
      ],
    };

    await bridgeProfiles.saveBridgeProfileStore(store);
    const loaded = await bridgeProfiles.loadBridgeProfileStore();

    expect(setItem).toHaveBeenCalledTimes(1);
    expect(getItem).toHaveBeenCalledWith(bridgeProfileStoreKey);
    expect(loaded).toEqual(store);
  });
});
