import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { HostBridgeApiClient } from '../api/client';
import { HostBridgeWsClient } from '../api/ws';
import { toBridgeHealthUrl } from '../bridgeUrl';
import type { BridgeProfile, BridgeProfileDraft } from '../bridgeProfiles';
import {
  getFreshChatGptAuthTokens,
  isNativeChatGptLoginAvailable,
} from '../chatGptAuth';
import { env } from '../config';
import {
  loadStoredGitHubAppAuthTokens,
  loginWithGitHubApp,
  refreshGitHubAppAuthTokens,
  refreshStoredGitHubAppAuthTokens,
} from '../githubAppAuth';
import {
  buildGitHubCodespacesBridgeUrl,
  createGitHubCodespaceForAuthenticatedUser,
  deleteGitHubCodespace,
  fetchGitHubAppAccessSnapshot,
  fetchGitHubCodespaceDefaults,
  fetchGitHubCodespaces,
  fetchGitHubRepository,
  requestGitHubInstallationAccessToken,
  fetchGitHubUser,
  getReusableGitHubBridgeProfile,
  sortGitHubCodespaces,
  startGitHubCodespace,
  stopGitHubCodespace,
  shouldRefreshGitHubUserAccessToken,
  type GitHubAppAccessSnapshot,
  type GitHubCodespace,
  type GitHubUserAccessToken,
  type GitHubUser,
} from '../githubCodespaces';
import { useAppTheme, type AppTheme } from '../theme';

interface GitHubCodespacesScreenProps {
  bridgeProfiles: BridgeProfile[];
  activeBridgeProfileId?: string | null;
  initialSession?: {
    token: GitHubUserAccessToken;
    user: GitHubUser;
  } | null;
  onBack: () => void;
  onConnect: (draft: BridgeProfileDraft) => void | Promise<void>;
  onSyncGitHubAuthToken?: (
    userLogin: string | null | undefined,
    token: GitHubUserAccessToken
  ) => void | Promise<void>;
}

interface GitHubSession extends GitHubUserAccessToken {
  user: GitHubUser;
}

type ConnectionPhase =
  | 'checkingExisting'
  | 'creatingCodespace'
  | 'startingCodespace'
  | 'codespaceReady'
  | 'waitingForBridge'
  | 'codexLoginRequired';

type ConnectionStepState = 'pending' | 'active' | 'done';
type OnboardingStage = 'github' | 'codespace' | 'connect';

interface PendingCodexLogin {
  runId: number;
  bridgeUrl: string;
  accessToken: string;
  codespaceWebUrl: string | null;
  profileDraft: BridgeProfileDraft;
}

const BRIDGE_READY_POLL_MS = 3000;
const BRIDGE_READY_TIMEOUT_MS = 6 * 60 * 1000;

function buildConnectionStepStates(phase: ConnectionPhase | null): {
  github: ConnectionStepState;
  codespace: ConnectionStepState;
  bridge: ConnectionStepState;
} {
  if (!phase) {
    return {
      github: 'done',
      codespace: 'pending',
      bridge: 'pending',
    };
  }

  if (phase === 'waitingForBridge') {
    return {
      github: 'done',
      codespace: 'done',
      bridge: 'active',
    };
  }

  if (phase === 'codespaceReady' || phase === 'codexLoginRequired') {
    return {
      github: 'done',
      codespace: 'done',
      bridge: phase === 'codexLoginRequired' ? 'done' : 'pending',
    };
  }

  return {
    github: 'done',
    codespace: 'active',
    bridge: 'pending',
  };
}

function formatConnectionPhaseTitle(
  phase: ConnectionPhase | null,
  activeCodespaceLabel: string | null
): string {
  const targetLabel = activeCodespaceLabel ? ` ${activeCodespaceLabel}` : '';
  switch (phase) {
    case 'checkingExisting':
      return `Checking existing Codespaces${targetLabel}`;
    case 'creatingCodespace':
      return `Creating Codespace${targetLabel}`;
    case 'startingCodespace':
      return activeCodespaceLabel
        ? `Codespace ${activeCodespaceLabel} found, starting it`
        : 'Starting Codespace';
    case 'codespaceReady':
      return activeCodespaceLabel
        ? `Codespace ${activeCodespaceLabel} is connected`
        : 'Codespace connected';
    case 'waitingForBridge':
      return activeCodespaceLabel
        ? `Codespace ${activeCodespaceLabel} is ready, starting Codex`
        : 'Codespace ready, starting Codex';
    case 'codexLoginRequired':
      return 'Codex is ready, finish login';
    default:
      return 'GitHub is connected';
  }
}

function ConnectionStep({
  label,
  state,
  styles,
  theme,
}: {
  label: string;
  state: ConnectionStepState;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}) {
  const iconName =
    state === 'done'
      ? 'checkmark-circle-outline'
      : state === 'active'
        ? 'radio-button-on-outline'
        : 'ellipse-outline';
  const iconColor =
    state === 'done'
      ? theme.colors.statusComplete
      : state === 'active'
        ? theme.colors.warning
        : theme.colors.textMuted;
  const labelColor =
    state === 'pending' ? theme.colors.textMuted : theme.colors.textPrimary;

  return (
    <View
      style={[
        styles.connectionStep,
        state === 'done'
          ? styles.connectionStepDone
          : state === 'active'
            ? styles.connectionStepActive
            : styles.connectionStepPending,
      ]}
    >
      <Ionicons name={iconName} size={14} color={iconColor} />
      <Text style={[styles.connectionStepLabel, { color: labelColor }]}>{label}</Text>
    </View>
  );
}

export function GitHubCodespacesScreen({
  bridgeProfiles,
  activeBridgeProfileId = null,
  initialSession = null,
  onBack,
  onConnect,
  onSyncGitHubAuthToken,
}: GitHubCodespacesScreenProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [session, setSession] = useState<GitHubSession | null>(null);
  const [restoringSession, setRestoringSession] = useState(true);
  const [authorizing, setAuthorizing] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [appAccess, setAppAccess] = useState<GitHubAppAccessSnapshot | null>(null);
  const [, setAppAccessLoading] = useState(false);
  const [appAccessError, setAppAccessError] = useState<string | null>(null);
  const [codespaces, setCodespaces] = useState<GitHubCodespace[]>([]);
  const [codespacesLoading, setCodespacesLoading] = useState(false);
  const [codespacesError, setCodespacesError] = useState<string | null>(null);
  const [connectingCodespaceName, setConnectingCodespaceName] = useState<string | null>(null);
  const [pendingStopCodespaceName, setPendingStopCodespaceName] = useState<string | null>(null);
  const [stoppingCodespaceName, setStoppingCodespaceName] = useState<string | null>(null);
  const [pendingDeleteCodespaceName, setPendingDeleteCodespaceName] = useState<string | null>(null);
  const [deletingCodespaceName, setDeletingCodespaceName] = useState<string | null>(null);
  const [restartingBridgeCodespaceName, setRestartingBridgeCodespaceName] = useState<string | null>(null);
  const [creatingCodespace, setCreatingCodespace] = useState(false);
  const [showAllCodespaces, setShowAllCodespaces] = useState(false);
  const [expandedCodespaceName, setExpandedCodespaceName] = useState<string | null>(null);
  const [creationTargetLabel, setCreationTargetLabel] = useState<string | null>(null);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionPhase, setConnectionPhase] = useState<ConnectionPhase | null>(null);
  const [pendingCodexLogin, setPendingCodexLogin] = useState<PendingCodexLogin | null>(null);
  const [codexLoginChecking, setCodexLoginChecking] = useState(false);
  const [codexLoginSubmitting, setCodexLoginSubmitting] = useState(false);
  const authFlowRef = useRef(0);
  const connectFlowRef = useRef(0);
  const githubConfigured = Boolean(env.githubClientId);
  const preferredRepositoryName = env.githubCodespacesPreferredRepositoryName;
  const configuredSourceOwner = env.githubCodespacesSourceRepositoryOwner;
  const configuredRepositoryRef = env.githubCodespacesRepositoryRef;
  const nativeChatGptLoginAvailable = isNativeChatGptLoginAvailable();

  const loadCodespaces = useCallback(
    async (accessToken: string) => {
      setCodespacesLoading(true);
      setCodespacesError(null);
      try {
        const nextCodespaces = await fetchGitHubCodespaces(accessToken);
        setCodespaces(sortGitHubCodespaces(nextCodespaces, preferredRepositoryName));
      } catch (error) {
        setCodespacesError((error as Error).message);
      } finally {
        setCodespacesLoading(false);
      }
    },
    [preferredRepositoryName]
  );

  const loadGitHubAppAccess = useCallback(async (accessToken: string) => {
    setAppAccessLoading(true);
    setAppAccessError(null);
    try {
      setAppAccess(await fetchGitHubAppAccessSnapshot(accessToken));
    } catch (error) {
      setAppAccessError((error as Error).message);
    } finally {
      setAppAccessLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const reusableProfile = getReusableGitHubBridgeProfile(bridgeProfiles, activeBridgeProfileId);

    if (!githubConfigured) {
      setRestoringSession(false);
      return () => {
        cancelled = true;
      };
    }

    const restoreSession = async () => {
      try {
        let nextSession: GitHubSession | null = null;
        if (initialSession) {
          nextSession = {
            ...initialSession.token,
            user: initialSession.user,
          };
        } else {
          let restoredToken =
            reusableProfile
              ? bridgeProfileToGitHubToken(reusableProfile)
              : await loadStoredGitHubAppAuthTokens();
          if (!restoredToken) {
            return;
          }
          if (
            env.githubAppAuthBaseUrl &&
            shouldRefreshGitHubUserAccessToken(restoredToken) &&
            restoredToken.refreshToken
          ) {
            restoredToken = await refreshGitHubAppAuthTokens(
              env.githubAppAuthBaseUrl,
              restoredToken.refreshToken
            );
            await onSyncGitHubAuthToken?.(reusableProfile?.githubUserLogin, restoredToken);
          }

          const user = await fetchGitHubUser(restoredToken.accessToken);
          if (cancelled) {
            return;
          }

          nextSession = {
            ...restoredToken,
            user,
          };
        }
        if (!nextSession || cancelled) {
          return;
        }
        setSession(nextSession);
        await Promise.all([
          loadCodespaces(nextSession.accessToken),
          loadGitHubAppAccess(nextSession.accessToken),
        ]);
      } catch (error) {
        if (!cancelled) {
          setAuthError(
            `Saved GitHub session expired or no longer works: ${(error as Error).message}`
          );
        }
      } finally {
        if (!cancelled) {
          setRestoringSession(false);
        }
      }
    };

    void restoreSession();
    return () => {
      cancelled = true;
      authFlowRef.current += 1;
      connectFlowRef.current += 1;
    };
  }, [
    activeBridgeProfileId,
    bridgeProfiles,
    githubConfigured,
    initialSession,
    loadCodespaces,
    loadGitHubAppAccess,
    onSyncGitHubAuthToken,
  ]);

  const approvedRepositories = useMemo(
    () =>
      [...(appAccess?.repositories ?? [])].sort((left, right) =>
        left.fullName.localeCompare(right.fullName)
      ),
    [appAccess]
  );
  const templateRepository = useMemo(() => {
    const owner = configuredSourceOwner?.trim();
    const repo = preferredRepositoryName?.trim();
    if (!owner || !repo) {
      return null;
    }

    return {
      owner,
      repo,
      fullName: `${owner}/${repo}`,
      source: 'fallback' as const,
    };
  }, [configuredSourceOwner, preferredRepositoryName]);
  const createEnabled = Boolean(templateRepository);

  const beginGitHubSignIn = useCallback(async () => {
    if (!env.githubClientId) {
      setAuthError('GitHub login is not configured in this build.');
      return;
    }
    if (!env.githubAppSlug) {
      setAuthError('GitHub App slug is not configured in this build.');
      return;
    }
    if (!env.githubAppAuthBaseUrl) {
      setAuthError('GitHub auth backend URL is not configured in this build.');
      return;
    }

    const runId = authFlowRef.current + 1;
    authFlowRef.current = runId;
    setAuthorizing(true);
    setAuthError(null);
    setConnectionError(null);
    setSession(null);

    try {
      const token = await loginWithGitHubApp({
        clientId: env.githubClientId,
        authBaseUrl: env.githubAppAuthBaseUrl,
      });
      if (authFlowRef.current !== runId) {
        return;
      }

      const nextSession = await finalizeGitHubSession(token);
      if (authFlowRef.current !== runId) {
        return;
      }

      await onSyncGitHubAuthToken?.(nextSession.user.login, token);
      setSession(nextSession);
      await Promise.all([
        loadCodespaces(nextSession.accessToken),
        loadGitHubAppAccess(nextSession.accessToken),
      ]);
    } catch (error) {
      if (authFlowRef.current === runId) {
        setAuthError((error as Error).message);
      }
    } finally {
      if (authFlowRef.current === runId) {
        setAuthorizing(false);
      }
    }
  }, [
    loadCodespaces,
    loadGitHubAppAccess,
    onSyncGitHubAuthToken,
  ]);

  const refreshGitHubState = useCallback(async () => {
    if (!session) {
      return;
    }

    await Promise.all([
      loadCodespaces(session.accessToken),
      loadGitHubAppAccess(session.accessToken),
    ]);
  }, [loadCodespaces, loadGitHubAppAccess, session]);

  const refreshGitHubSessionForBridgeInstall = useCallback(
    async (activeSession: GitHubSession): Promise<GitHubSession> => {
      if (!env.githubAppAuthBaseUrl || !activeSession.refreshToken) {
        return activeSession;
      }

      const refreshedToken = await refreshStoredGitHubAppAuthTokens(
        env.githubAppAuthBaseUrl,
        activeSession.refreshToken
      );
      const nextSession: GitHubSession = {
        ...refreshedToken,
        user: activeSession.user,
      };

      setSession(nextSession);
      await onSyncGitHubAuthToken?.(activeSession.user.login, refreshedToken);
      return nextSession;
    },
    [onSyncGitHubAuthToken]
  );

  const buildGitHubInstallationAuthGrants = useCallback(
    async (activeSession: GitHubSession) => {
      if (!env.githubAppAuthBaseUrl) {
        throw new Error('GitHub auth backend URL is not configured.');
      }

      const repositoriesByInstallation = new Map<number, string[]>();
      approvedRepositories.forEach((repository) => {
        const current = repositoriesByInstallation.get(repository.installationId) ?? [];
        current.push(repository.fullName);
        repositoriesByInstallation.set(repository.installationId, current);
      });

      if (repositoriesByInstallation.size === 0) {
        return [];
      }

      const grants = await Promise.all(
        [...repositoriesByInstallation.entries()].map(async ([installationId, repositories]) => {
          const token = await requestGitHubInstallationAccessToken({
            authBaseUrl: env.githubAppAuthBaseUrl!,
            userAccessToken: activeSession.accessToken,
            installationId,
            repositories,
          });
          return {
            accessToken: token.accessToken,
            repositories: token.repositoryNames,
          };
        })
      );

      return grants.filter((grant) => grant.repositories.length > 0 && grant.accessToken.trim());
    },
    [approvedRepositories]
  );

  const cancelCodespaceConnection = useCallback(() => {
    connectFlowRef.current += 1;
    setCreatingCodespace(false);
    setConnectingCodespaceName(null);
    setPendingStopCodespaceName(null);
    setStoppingCodespaceName(null);
    setCreationTargetLabel(null);
    setConnectionMessage(null);
    setConnectionError(null);
    setConnectionPhase(null);
    setPendingCodexLogin(null);
    setCodexLoginChecking(false);
    setCodexLoginSubmitting(false);
  }, []);

  const finalizeConnectedBridgeProfile = useCallback(
    async (draft: BridgeProfileDraft) => {
      await onConnect(draft);
    },
    [onConnect]
  );

  const completeCodexLoginIfReady = useCallback(
    async (pending: PendingCodexLogin) => {
      if (connectFlowRef.current !== pending.runId) {
        return;
      }

      setCodexLoginChecking(true);
      setConnectionError(null);
      setConnectionMessage('Checking Codex account status…');

      try {
        const account = await withBridgeApiClient(pending.bridgeUrl, pending.accessToken, (api) =>
          api.readAccount()
        );
        if (connectFlowRef.current !== pending.runId) {
          return;
        }

        if (account.type || !account.requiresOpenaiAuth) {
          setConnectionMessage('Codex login verified. Finishing setup…');
          setPendingCodexLogin(null);
          await finalizeConnectedBridgeProfile(pending.profileDraft);
          return;
        }

        setConnectionPhase('codexLoginRequired');
        setConnectionMessage(
          nativeChatGptLoginAvailable
            ? 'Codex is ready, but ChatGPT login is still needed. Tap Login with ChatGPT to finish setup from this phone, or open the Codespace as a fallback.'
            : Platform.OS === 'ios' || Platform.OS === 'android'
              ? 'Codex is ready, but ChatGPT login is still needed. Use the installed native app build to finish that login from this phone, or open the Codespace as a fallback.'
            : 'Codex is ready, but ChatGPT login is still needed. Finish it from the Codespace on another machine, then return here and tap Check again.'
        );
      } catch (error) {
        if (connectFlowRef.current === pending.runId) {
          setConnectionError((error as Error).message);
        }
      } finally {
        if (connectFlowRef.current === pending.runId) {
          setCodexLoginChecking(false);
        }
      }
    },
    [finalizeConnectedBridgeProfile]
  );

  const loginToCodexWithChatGpt = useCallback(async () => {
    if (!pendingCodexLogin) {
      return;
    }

    setCodexLoginSubmitting(true);
    setConnectionError(null);

    try {
      setConnectionMessage('Opening ChatGPT login…');
      const tokens = await getFreshChatGptAuthTokens();
      setConnectionMessage('ChatGPT login complete. Sending tokens to Codex…');
      await withBridgeApiClient(pendingCodexLogin.bridgeUrl, pendingCodexLogin.accessToken, (api) =>
        api.loginWithChatGptAuthTokens({
          accessToken: tokens.accessToken,
          chatgptAccountId: tokens.accountId,
          chatgptPlanType: tokens.planType,
        })
      );
      setConnectionMessage(
        'ChatGPT login complete. Verifying Codex account…'
      );
      await completeCodexLoginIfReady(pendingCodexLogin);
    } catch (error) {
      setConnectionError((error as Error).message);
    } finally {
      setCodexLoginSubmitting(false);
    }
  }, [completeCodexLoginIfReady, pendingCodexLogin]);

  const openCodespaceForCodexLogin = useCallback(async () => {
    if (!pendingCodexLogin) {
      return;
    }

    setCodexLoginSubmitting(true);
    setConnectionError(null);

    try {
      if (!pendingCodexLogin.codespaceWebUrl) {
        throw new Error('This Codespace does not expose a web URL to open.');
      }
      await Linking.openURL(pendingCodexLogin.codespaceWebUrl);
      setConnectionMessage(
        'Open the Codespace on another machine, finish Codex login there if needed, then return here and tap Check again.'
      );
    } catch (error) {
      setConnectionError((error as Error).message);
    } finally {
      setCodexLoginSubmitting(false);
    }
  }, [pendingCodexLogin]);

  const finalizeCodespaceConnection = useCallback(
    async (
      runId: number,
      codespace: GitHubCodespace,
      activeSession: GitHubSession
    ): Promise<'connected' | 'codexLogin'> => {
      const bridgeSession = await refreshGitHubSessionForBridgeInstall(activeSession);
      if (connectFlowRef.current !== runId) {
        return 'connected';
      }

      const bridgeUrl = buildGitHubCodespacesBridgeUrl(
        codespace.name,
        env.githubCodespacesPortForwardingDomain
      );
      if (!bridgeUrl) {
        throw new Error('Unable to derive the forwarded Codespaces bridge URL.');
      }

      setConnectionPhase('waitingForBridge');
      setConnectionMessage(
        `Codespace ${codespace.name} is up. Starting Codex... First boot can take a few minutes.`
      );
      await waitForBridgeReady(bridgeUrl, bridgeSession.accessToken);
      if (connectFlowRef.current !== runId) {
        return 'connected';
      }

      const gitAuthGrants = await buildGitHubInstallationAuthGrants(bridgeSession);
      if (connectFlowRef.current !== runId) {
        return 'connected';
      }

      if (gitAuthGrants.length > 0) {
        setConnectionMessage('Codex is up. Enabling GitHub clone and push access...');
        await withBridgeApiClient(bridgeUrl, bridgeSession.accessToken, (api) =>
          api.installGitHubAuth({
            grants: gitAuthGrants,
          })
        );
      }
      if (connectFlowRef.current !== runId) {
        return 'connected';
      }

      const profileDraft: BridgeProfileDraft = {
        name: buildCodespaceProfileName(codespace),
        bridgeUrl,
        bridgeToken: bridgeSession.accessToken,
        authMode: 'githubApp',
        githubUserLogin: bridgeSession.user.login,
        githubCodespaceName: codespace.name,
        githubRepositoryFullName: codespace.repositoryFullName,
        githubRefreshToken: bridgeSession.refreshToken,
        githubAccessTokenExpiresAt: timestampMsToIsoString(bridgeSession.accessTokenExpiresAtMs),
        githubRefreshTokenExpiresAt: timestampMsToIsoString(
          bridgeSession.refreshTokenExpiresAtMs
        ),
        activate: true,
      };

      setConnectionMessage('Codex is up. Checking whether login is still required...');
      const account = await withBridgeApiClient(bridgeUrl, bridgeSession.accessToken, (api) =>
        api.readAccount()
      );
      if (connectFlowRef.current !== runId) {
        return 'connected';
      }

      if (account.type || !account.requiresOpenaiAuth) {
        await finalizeConnectedBridgeProfile(profileDraft);
        return 'connected';
      }

      setConnectionPhase('codexLoginRequired');
      setPendingCodexLogin({
        runId,
        bridgeUrl,
        accessToken: bridgeSession.accessToken,
        codespaceWebUrl: codespace.webUrl ?? null,
        profileDraft,
      });
      setConnectionMessage(
        nativeChatGptLoginAvailable
          ? 'Codex is ready, but ChatGPT login is still needed. Tap Login with ChatGPT to finish setup from this phone.'
          : Platform.OS === 'ios' || Platform.OS === 'android'
            ? 'Codex is ready, but ChatGPT login is still needed. Use the installed native app build to finish that login from this phone.'
          : 'Codex is ready, but ChatGPT login is still needed. Finish it from the Codespace on another machine, then return here and tap Check again.'
      );
      return 'codexLogin';
    },
    [
      buildGitHubInstallationAuthGrants,
      finalizeConnectedBridgeProfile,
      nativeChatGptLoginAvailable,
      refreshGitHubSessionForBridgeInstall,
    ]
  );

  const handleConnectCodespace = useCallback(
    async (codespace: GitHubCodespace) => {
      if (!session) {
        setConnectionError('Sign in with GitHub first.');
        return;
      }

      let keepConnectionStatus = false;
      const runId = connectFlowRef.current + 1;
      connectFlowRef.current = runId;
      setConnectingCodespaceName(codespace.name);
      setPendingStopCodespaceName(null);
      setCreatingCodespace(false);
      setCreationTargetLabel(null);
      setConnectionError(null);
      setPendingCodexLogin(null);
      setCodexLoginChecking(false);
      setCodexLoginSubmitting(false);
      setConnectionPhase(
        codespace.state.trim().toLowerCase() === 'available' ? 'codespaceReady' : 'startingCodespace'
      );

      try {
        const currentCodespace = codespace;
        if (currentCodespace.state.trim().toLowerCase() !== 'available') {
          setConnectionMessage(`Starting ${codespace.name}…`);
          await startGitHubCodespace(session.accessToken, codespace.name);
        }

        if (connectFlowRef.current !== runId) {
          return;
        }

        keepConnectionStatus =
          (await finalizeCodespaceConnection(runId, currentCodespace, session)) === 'codexLogin';
      } catch (error) {
        if (connectFlowRef.current === runId) {
          setConnectionError((error as Error).message);
        }
      } finally {
        if (connectFlowRef.current === runId) {
          setConnectingCodespaceName(null);
          if (!keepConnectionStatus) {
            setConnectionMessage(null);
            setConnectionPhase(null);
          }
        }
      }
    },
    [finalizeCodespaceConnection, session]
  );

  const handleCreateCodespace = useCallback(async () => {
    if (!session) {
      setConnectionError('Sign in with GitHub first.');
      return;
    }
    if (!templateRepository) {
      setConnectionError('The Claudex template repository is not configured in this build.');
      return;
    }

    let keepConnectionStatus = false;
    const runId = connectFlowRef.current + 1;
    connectFlowRef.current = runId;
    setCreatingCodespace(true);
    setPendingStopCodespaceName(null);
    setConnectingCodespaceName(null);
    setCreationTargetLabel(templateRepository.fullName);
    setConnectionError(null);
    setPendingCodexLogin(null);
    setCodexLoginChecking(false);
    setCodexLoginSubmitting(false);
    setConnectionPhase('creatingCodespace');

    try {
      setConnectionMessage('Preparing the Claudex template…');
      const defaults = await fetchGitHubCodespaceDefaults(
        session.accessToken,
        templateRepository,
        configuredRepositoryRef
      );
      if (connectFlowRef.current !== runId) {
        return;
      }

      const repository = await fetchGitHubRepository(session.accessToken, templateRepository);
      if (connectFlowRef.current !== runId) {
        return;
      }

      setConnectionMessage('Creating your new Codespace…');
      const codespace = await createGitHubCodespaceForAuthenticatedUser(
        session.accessToken,
        repository.id,
        {
          ref: configuredRepositoryRef,
          devcontainerPath: defaults.devcontainerPath,
          location: defaults.location,
        }
      );
      if (connectFlowRef.current !== runId) {
        return;
      }

      setCreatingCodespace(false);
      setConnectingCodespaceName(codespace.name);
      setConnectionPhase('codespaceReady');
      keepConnectionStatus =
        (await finalizeCodespaceConnection(runId, codespace, session)) === 'codexLogin';
      void loadCodespaces(session.accessToken);
    } catch (error) {
      if (connectFlowRef.current === runId) {
        const message = (error as Error).message;
        setConnectionError(
          message.toLowerCase().includes('resource not accessible by integration')
            ? 'This GitHub App still cannot create Codespaces from the Claudex template. Install the app on the template owner once, then try again.'
            : message
        );
      }
    } finally {
      if (connectFlowRef.current === runId) {
        setCreatingCodespace(false);
        setConnectingCodespaceName(null);
        setCreationTargetLabel(null);
        if (!keepConnectionStatus) {
          setConnectionMessage(null);
          setConnectionPhase(null);
        }
      }
    }
  }, [
    configuredRepositoryRef,
    finalizeCodespaceConnection,
    loadCodespaces,
    session,
    templateRepository,
  ]);

  const handleOpenCodespace = useCallback((codespace: GitHubCodespace) => {
    if (!codespace.webUrl) {
      return;
    }
    void Linking.openURL(codespace.webUrl).catch(() => {
      setConnectionError('Unable to open the Codespace URL on this device.');
    });
  }, []);

  const handleRestartCodespaceBridge = useCallback(
    async (codespace: GitHubCodespace) => {
      if (!session) {
        setConnectionError('Sign in with GitHub first.');
        return;
      }

      const bridgeSession = await refreshGitHubSessionForBridgeInstall(session);
      const bridgeUrl = buildGitHubCodespacesBridgeUrl(
        codespace.name,
        env.githubCodespacesPortForwardingDomain
      );
      if (!bridgeUrl) {
        setConnectionError('Unable to derive the forwarded Codespaces bridge URL.');
        return;
      }

      setRestartingBridgeCodespaceName(codespace.name);
      setPendingStopCodespaceName(null);
      setPendingDeleteCodespaceName(null);
      setConnectionError(null);
      setConnectionPhase('waitingForBridge');
      setConnectionMessage(`Restarting connection in ${codespace.name}...`);

      try {
        await withBridgeApiClient(bridgeUrl, bridgeSession.accessToken, (api) =>
          api.startBridgeRestart()
        );
        await sleep(4_000);
        await waitForBridgeReady(bridgeUrl, bridgeSession.accessToken);
        setConnectionMessage('Connection restarted.');
      } catch (error) {
        setConnectionError(
          `Connection restart could not be scheduled: ${(error as Error).message}`
        );
      } finally {
        setRestartingBridgeCodespaceName(null);
        setConnectionPhase(null);
      }
    },
    [refreshGitHubSessionForBridgeInstall, session]
  );

  const handleStopCodespace = useCallback(
    async (codespace: GitHubCodespace) => {
      if (!session) {
        setConnectionError('Sign in with GitHub first.');
        return;
      }

      setStoppingCodespaceName(codespace.name);
      setPendingStopCodespaceName(null);
      setPendingDeleteCodespaceName(null);
      setConnectionError(null);

      try {
        await stopGitHubCodespace(session.accessToken, codespace.name);
        const nextCodespaces = sortGitHubCodespaces(
          await fetchGitHubCodespaces(session.accessToken),
          preferredRepositoryName
        );
        setCodespaces(nextCodespaces);
        setConnectionMessage(null);
        setConnectionPhase(null);
        setPendingCodexLogin(null);
      } catch (error) {
        setConnectionError((error as Error).message);
      } finally {
        setStoppingCodespaceName(null);
      }
    },
    [preferredRepositoryName, session]
  );

  const handleDeleteCodespace = useCallback(
    async (codespace: GitHubCodespace) => {
      if (!session) {
        setConnectionError('Sign in with GitHub first.');
        return;
      }

      setDeletingCodespaceName(codespace.name);
      setPendingDeleteCodespaceName(codespace.name);
      setPendingStopCodespaceName(null);
      setExpandedCodespaceName(codespace.name);
      setConnectionError(null);

      const startedAt = Date.now();
      try {
        await deleteGitHubCodespace(session.accessToken, codespace.name);
        setCodespaces((current) =>
          current.filter((candidate) => candidate.name !== codespace.name)
        );
        const nextCodespaces = sortGitHubCodespaces(
          await fetchGitHubCodespaces(session.accessToken),
          preferredRepositoryName
        ).filter((candidate) => candidate.name !== codespace.name);
        setCodespaces(nextCodespaces);
        setExpandedCodespaceName((current) => (current === codespace.name ? null : current));
        setPendingDeleteCodespaceName((current) => (current === codespace.name ? null : current));
        setConnectionMessage(null);
        setConnectionPhase(null);
        setPendingCodexLogin((current) =>
          current?.profileDraft.githubCodespaceName === codespace.name ? null : current
        );
      } catch (error) {
        setConnectionError((error as Error).message);
      } finally {
        const remainingVisibleMs = 1_500 - (Date.now() - startedAt);
        if (remainingVisibleMs > 0) {
          await sleep(remainingVisibleMs);
        }
        setDeletingCodespaceName(null);
      }
    },
    [preferredRepositoryName, session]
  );

  const busy =
    Boolean(connectingCodespaceName) ||
    Boolean(stoppingCodespaceName) ||
    Boolean(deletingCodespaceName) ||
    Boolean(restartingBridgeCodespaceName) ||
    codexLoginChecking ||
    codexLoginSubmitting;
  const statusCardVisible =
    Boolean(connectionPhase) || busy || Boolean(connectionMessage) || Boolean(pendingCodexLogin);
  const connectionStepStates = buildConnectionStepStates(connectionPhase);
  const activeCodespaceLabel =
    connectingCodespaceName ??
    pendingCodexLogin?.profileDraft.githubCodespaceName ??
    creationTargetLabel ??
    null;
  const suggestedCodespace = codespaces[0] ?? null;
  const availableCodespaceCount = codespaces.filter((codespace) =>
    isCodespaceAvailable(codespace)
  ).length;
  const visibleCodespaces = showAllCodespaces ? codespaces : codespaces.slice(0, 4);
  const hiddenCodespaceCount = Math.max(codespaces.length - visibleCodespaces.length, 0);
  const codespacesSummary = codespacesLoading
    ? 'Loading Codespaces…'
    : codespaces.length === 0
      ? createEnabled
        ? 'Create a new Codespace to continue.'
        : 'Codespace creation is not configured in this build.'
      : availableCodespaceCount > 0
        ? `${availableCodespaceCount} ready now • ${codespaces.length} total`
        : `${codespaces.length} saved • none running`;
  const onboardingStage: OnboardingStage = session
    ? statusCardVisible
      ? 'connect'
      : 'codespace'
    : 'github';

  return (
    <View style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safeArea}>
        <View style={styles.header}>
          <Pressable onPress={onBack} hitSlop={8} style={styles.headerButton}>
            <Ionicons name="chevron-back" size={20} color={theme.colors.textPrimary} />
          </Pressable>
          <View style={styles.headerCopy}>
            <Text style={styles.headerTitle}>GitHub Codespaces</Text>
          </View>
        </View>

        <ScrollView
          style={styles.scroll}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {!githubConfigured ? (
            <BlurView intensity={55} tint={theme.blurTint} style={styles.card}>
              <Text style={styles.cardTitle}>GitHub login not configured</Text>
              <Text style={styles.cardBody}>
                Set `EXPO_PUBLIC_GITHUB_APP_CLIENT_ID`, `EXPO_PUBLIC_GITHUB_APP_SLUG`, and
                `EXPO_PUBLIC_GITHUB_APP_AUTH_BASE_URL` in the mobile app build environment, then
                rebuild the app to enable direct Codespaces sign-in.
              </Text>
            </BlurView>
          ) : null}

          {githubConfigured ? (
            <BlurView intensity={55} tint={theme.blurTint} style={styles.card}>
              {onboardingStage === 'github' ? (
                <View style={styles.simpleHeaderBlock}>
                  <Text style={styles.cardHeadline}>Sign in with GitHub</Text>
                  <Text style={styles.cardBody}>See your Codespaces and connect one to Clawdex.</Text>
                </View>
              ) : null}

              {onboardingStage === 'connect' ? (
                <View style={styles.simpleHeaderBlock}>
                  <View style={styles.loadingRow}>
                    <Ionicons
                      name="git-network-outline"
                      size={18}
                      color={theme.colors.textSecondary}
                    />
                    <Text style={styles.cardHeadline}>Connecting workspace</Text>
                  </View>
                </View>
              ) : null}

              {onboardingStage === 'codespace' && session ? (
                <View style={styles.accountStrip}>
                  <View style={styles.accountStripCopy}>
                    <Text style={styles.accountStripLabel}>GitHub</Text>
                    <Text style={styles.accountStripTitle}>@{session.user.login}</Text>
                    <Text style={styles.accountStripMeta}>{codespacesSummary}</Text>
                  </View>
                  {createEnabled && codespaces.length > 0 ? (
                    <View style={styles.accountStripActions}>
                      <Pressable
                        onPress={() => {
                          void handleCreateCodespace();
                        }}
                        disabled={busy}
                        style={({ pressed }) => [
                          styles.secondaryButton,
                          pressed && !busy && styles.secondaryButtonPressed,
                        ]}
                      >
                        {creatingCodespace ? (
                          <ActivityIndicator size="small" color={theme.colors.textPrimary} />
                        ) : (
                          <Ionicons
                            name="add-circle-outline"
                            size={15}
                            color={theme.colors.textPrimary}
                          />
                        )}
                        <Text style={styles.secondaryButtonText}>Create Codespace</Text>
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              ) : null}

              {restoringSession && onboardingStage !== 'github' ? (
                <View style={styles.loadingRow}>
                  <ActivityIndicator color={theme.colors.textPrimary} />
                  <Text style={styles.cardBody}>Checking saved GitHub access…</Text>
                </View>
              ) : null}

              {authError ? (
                <View style={styles.errorBanner}>
                  <Ionicons name="alert-circle-outline" size={16} color={theme.colors.error} />
                  <Text selectable style={styles.errorBannerText}>
                    {authError}
                  </Text>
                </View>
              ) : null}
              {connectionError ? (
                <View style={styles.errorBanner}>
                  <Ionicons name="alert-circle-outline" size={16} color={theme.colors.error} />
                  <Text selectable style={styles.errorBannerText}>
                    {connectionError}
                  </Text>
                </View>
              ) : null}
              {onboardingStage === 'codespace' && appAccessError ? (
                <View style={styles.errorBanner}>
                  <Ionicons name="alert-circle-outline" size={16} color={theme.colors.error} />
                  <Text selectable style={styles.errorBannerText}>
                    {appAccessError}
                  </Text>
                </View>
              ) : null}
              {onboardingStage === 'codespace' && codespacesError ? (
                <View style={styles.errorBanner}>
                  <Ionicons name="alert-circle-outline" size={16} color={theme.colors.error} />
                  <Text selectable style={styles.errorBannerText}>
                    {codespacesError}
                  </Text>
                </View>
              ) : null}
              {onboardingStage === 'codespace' && deletingCodespaceName ? (
                <View style={styles.progressBanner}>
                  <ActivityIndicator size="small" color={theme.colors.textPrimary} />
                  <View style={styles.progressBannerCopy}>
                    <Text style={styles.progressBannerTitle}>Deleting Codespace</Text>
                    <Text style={styles.progressBannerText} numberOfLines={2}>
                      {deletingCodespaceName}
                    </Text>
                  </View>
                </View>
              ) : null}

              {onboardingStage === 'github' ? (
                <>
                  <View style={styles.recommendedActionCard}>
                    <Text style={styles.recommendedActionEyebrow}>Connecting GitHub</Text>
                    <Text style={styles.recommendedActionTitle}>Sign in with GitHub</Text>
                    <Text style={styles.recommendedActionMeta}>
                      GitHub opens once, then returns here automatically.
                    </Text>
                  </View>
                  {restoringSession ? (
                    <View style={styles.loadingRow}>
                      <ActivityIndicator color={theme.colors.textPrimary} />
                      <Text style={styles.cardBody}>Checking saved GitHub access…</Text>
                    </View>
                  ) : (
                    <Pressable
                      onPress={() => {
                        void beginGitHubSignIn();
                      }}
                      disabled={authorizing}
                      style={({ pressed }) => [
                        styles.primaryButton,
                        pressed && !authorizing && styles.primaryButtonPressed,
                      ]}
                    >
                      {authorizing ? (
                        <ActivityIndicator size="small" color={theme.colors.black} />
                      ) : (
                        <Ionicons name="logo-github" size={16} color={theme.colors.black} />
                      )}
                      <Text style={styles.primaryButtonText}>
                        {authorizing
                          ? 'Opening GitHub…'
                          : authError
                            ? 'Try GitHub again'
                            : 'Sign in with GitHub'}
                      </Text>
                    </Pressable>
                  )}
                </>
              ) : null}

              {onboardingStage === 'codespace' && session ? (
                <>
                  {codespacesLoading ? (
                    <View style={styles.loadingRow}>
                      <ActivityIndicator color={theme.colors.textPrimary} />
                      <Text style={styles.cardBody}>Loading Codespaces…</Text>
                    </View>
                  ) : codespaces.length > 0 ? (
                    <>
                      <View style={styles.cardHeadlineBlock}>
                        <Text style={styles.cardHeadline}>Your Codespaces</Text>
                      </View>
                      <View style={styles.codespaceList}>
                        {visibleCodespaces.map((codespace) => {
                          const codespaceBusy = connectingCodespaceName === codespace.name;
                          const codespaceStopping = stoppingCodespaceName === codespace.name;
                          const codespaceDeleting = deletingCodespaceName === codespace.name;
                          const bridgeRestarting = restartingBridgeCodespaceName === codespace.name;
                          const stopConfirmationVisible =
                            pendingStopCodespaceName === codespace.name;
                          const deleteConfirmationVisible =
                            pendingDeleteCodespaceName === codespace.name;
                          const isSuggested = suggestedCodespace?.name === codespace.name;
                          const canStopCodespace = isCodespaceAvailable(codespace);
                          const secondaryActionsVisible =
                            expandedCodespaceName === codespace.name ||
                            stopConfirmationVisible ||
                            deleteConfirmationVisible;
                          const actionLabel = codespaceDeleting
                            ? 'Deleting...'
                            : canStopCodespace
                              ? 'Connect'
                              : 'Start';
                          const actionIcon = canStopCodespace ? 'flash-outline' : 'play-outline';

                          return (
                            <View
                              key={codespace.name}
                              style={[
                                styles.codespaceCard,
                                isSuggested && styles.codespaceCardRecommended,
                                codespaceDeleting && styles.codespaceCardDeleting,
                              ]}
                            >
                              <View style={styles.codespaceCardTop}>
                                <View style={styles.codespacesCardHeader}>
                                  <View style={styles.codespacesCardCopy}>
                                    <Text style={styles.codespaceCardTitle}>{codespace.name}</Text>
                                    <Text style={styles.codespaceRepository}>
                                      {codespace.repositoryFullName ?? 'Unknown repository'}
                                    </Text>
                                  </View>
                                  <View style={styles.codespaceStatePill}>
                                    <Text style={styles.codespaceStateText}>
                                      {codespaceDeleting ? 'Deleting' : formatCodespaceStatus(codespace)}
                                    </Text>
                                  </View>
                                </View>
                              </View>

                              <View style={styles.codespaceCardFooter}>
                                <Pressable
                                  onPress={() => {
                                    void handleConnectCodespace(codespace);
                                  }}
                                  disabled={busy}
                                  style={({ pressed }) => [
                                    styles.codespacePrimaryAction,
                                    (codespaceBusy ||
                                      codespaceStopping ||
                                      codespaceDeleting ||
                                      bridgeRestarting) &&
                                      styles.codespaceButtonBusy,
                                    pressed && !busy && styles.codespaceButtonPressed,
                                  ]}
                                >
                                  {codespaceBusy || codespaceStopping || codespaceDeleting || bridgeRestarting ? (
                                    <ActivityIndicator size="small" color={theme.colors.black} />
                                  ) : (
                                    <Ionicons
                                      name={actionIcon}
                                      size={15}
                                      color={theme.colors.black}
                                    />
                                  )}
                                  <Text style={styles.codespacePrimaryActionText}>
                                    {actionLabel}
                                  </Text>
                                </Pressable>
                                <Pressable
                                  onPress={() => {
                                    setExpandedCodespaceName((current) =>
                                      current === codespace.name ? null : codespace.name
                                    );
                                  }}
                                  disabled={busy}
                                  style={({ pressed }) => [
                                    styles.codespaceMoreAction,
                                    pressed && !busy && styles.secondaryButtonPressed,
                                  ]}
                                >
                                  <Text style={styles.codespaceSecondaryActionText}>More</Text>
                                  <Ionicons
                                    name={secondaryActionsVisible ? 'chevron-up' : 'chevron-down'}
                                    size={14}
                                    color={theme.colors.textPrimary}
                                  />
                                </Pressable>
                                {secondaryActionsVisible ? (
                                  <View style={styles.codespaceActionRow}>
                                    {codespace.webUrl ? (
                                      <Pressable
                                        onPress={() => handleOpenCodespace(codespace)}
                                        disabled={busy}
                                        style={({ pressed }) => [
                                          styles.codespaceSecondaryAction,
                                          pressed && styles.secondaryButtonPressed,
                                        ]}
                                      >
                                        <Ionicons
                                          name="open-outline"
                                          size={14}
                                          color={theme.colors.textPrimary}
                                        />
                                        <Text style={styles.codespaceSecondaryActionText}>
                                          Open
                                        </Text>
                                      </Pressable>
                                    ) : null}
                                    {canStopCodespace ? (
                                      <Pressable
                                        onPress={() => {
                                          void handleRestartCodespaceBridge(codespace);
                                        }}
                                        disabled={busy}
                                        style={({ pressed }) => [
                                          styles.codespaceSecondaryAction,
                                          pressed && !busy && styles.secondaryButtonPressed,
                                        ]}
                                      >
                                        {bridgeRestarting ? (
                                          <ActivityIndicator
                                            size="small"
                                            color={theme.colors.textPrimary}
                                          />
                                        ) : (
                                          <Ionicons
                                            name="refresh-outline"
                                            size={14}
                                            color={theme.colors.textPrimary}
                                          />
                                        )}
                                        <Text style={styles.codespaceSecondaryActionText}>
                                          Restart connection
                                        </Text>
                                      </Pressable>
                                    ) : null}
                                    {canStopCodespace ? (
                                      <Pressable
                                        onPress={() => {
                                          setPendingDeleteCodespaceName(null);
                                          setPendingStopCodespaceName((current) =>
                                            current === codespace.name ? null : codespace.name
                                          );
                                        }}
                                        disabled={busy}
                                        style={({ pressed }) => [
                                          styles.codespaceStopAction,
                                          pressed && !busy && styles.codespaceStopActionPressed,
                                        ]}
                                      >
                                        <Ionicons
                                          name="stop-circle-outline"
                                          size={14}
                                          color={theme.colors.error}
                                        />
                                        <Text style={styles.codespaceStopActionText}>Stop</Text>
                                      </Pressable>
                                    ) : null}
                                    <Pressable
                                      onPress={() => {
                                        setPendingStopCodespaceName(null);
                                        setPendingDeleteCodespaceName((current) =>
                                          current === codespace.name ? null : codespace.name
                                        );
                                      }}
                                      disabled={busy}
                                      style={({ pressed }) => [
                                        styles.codespaceStopAction,
                                        pressed && !busy && styles.codespaceStopActionPressed,
                                      ]}
                                    >
                                      <Ionicons
                                        name="trash-outline"
                                        size={14}
                                        color={theme.colors.error}
                                      />
                                      <Text style={styles.codespaceStopActionText}>Delete</Text>
                                    </Pressable>
                                  </View>
                                ) : null}

                                {stopConfirmationVisible ? (
                                  <View style={styles.codespaceStopConfirm}>
                                    <Text style={styles.codespaceStopConfirmTitle}>
                                      Stop this Codespace?
                                    </Text>
                                    <View style={styles.codespaceStopConfirmActions}>
                                      <Pressable
                                        onPress={() => setPendingStopCodespaceName(null)}
                                        style={({ pressed }) => [
                                          styles.codespaceStopCancel,
                                          pressed && styles.secondaryButtonPressed,
                                        ]}
                                      >
                                        <Text style={styles.codespaceStopCancelText}>
                                          Keep running
                                        </Text>
                                      </Pressable>
                                      <Pressable
                                        onPress={() => {
                                          void handleStopCodespace(codespace);
                                        }}
                                        disabled={busy}
                                        style={({ pressed }) => [
                                          styles.codespaceStopConfirmButton,
                                          pressed &&
                                            !busy &&
                                            styles.codespaceStopConfirmButtonPressed,
                                          busy && styles.codespaceButtonBusy,
                                        ]}
                                      >
                                        {codespaceStopping ? (
                                          <ActivityIndicator
                                            size="small"
                                            color={theme.colors.white}
                                          />
                                        ) : (
                                          <Ionicons
                                            name="stop-circle-outline"
                                            size={14}
                                            color={theme.colors.white}
                                          />
                                        )}
                                        <Text style={styles.codespaceStopConfirmButtonText}>
                                          Stop Codespace
                                        </Text>
                                      </Pressable>
                                    </View>
                                  </View>
                                ) : null}

                                {deleteConfirmationVisible ? (
                                  <View style={styles.codespaceStopConfirm}>
                                    <Text style={styles.codespaceStopConfirmTitle}>
                                      Delete this Codespace?
                                    </Text>
                                    <Text style={styles.codespaceStopConfirmText}>
                                      This permanently removes the Codespace from GitHub. Your
                                      repository stays intact.
                                    </Text>
                                    <View style={styles.codespaceStopConfirmActions}>
                                      <Pressable
                                        onPress={() => setPendingDeleteCodespaceName(null)}
                                        disabled={codespaceDeleting}
                                        style={({ pressed }) => [
                                          styles.codespaceStopCancel,
                                          codespaceDeleting && styles.codespaceActionDisabled,
                                          pressed && !codespaceDeleting && styles.secondaryButtonPressed,
                                        ]}
                                      >
                                        <Text style={styles.codespaceStopCancelText}>Cancel</Text>
                                      </Pressable>
                                      <Pressable
                                        onPress={() => {
                                          void handleDeleteCodespace(codespace);
                                        }}
                                        disabled={busy}
                                        style={({ pressed }) => [
                                          styles.codespaceStopConfirmButton,
                                          pressed &&
                                            !busy &&
                                            styles.codespaceStopConfirmButtonPressed,
                                          busy && styles.codespaceButtonBusy,
                                        ]}
                                      >
                                        {codespaceDeleting ? (
                                          <ActivityIndicator
                                            size="small"
                                            color={theme.colors.white}
                                          />
                                        ) : (
                                          <Ionicons
                                            name="trash-outline"
                                            size={14}
                                            color={theme.colors.white}
                                          />
                                        )}
                                        <Text style={styles.codespaceStopConfirmButtonText}>
                                          {codespaceDeleting ? 'Deleting...' : 'Delete Codespace'}
                                        </Text>
                                      </Pressable>
                                    </View>
                                  </View>
                                ) : null}
                              </View>
                            </View>
                          );
                        })}
                      </View>

                      {hiddenCodespaceCount > 0 ? (
                        <Pressable
                          onPress={() => setShowAllCodespaces((current) => !current)}
                          style={({ pressed }) => [
                            styles.linkButton,
                            pressed && styles.linkButtonPressed,
                          ]}
                        >
                          <Text style={styles.linkButtonText}>
                            {showAllCodespaces
                              ? 'Show less'
                              : `See ${hiddenCodespaceCount} more`}
                          </Text>
                          <Ionicons
                            name={showAllCodespaces ? 'chevron-up' : 'chevron-down'}
                            size={15}
                            color={theme.colors.textPrimary}
                          />
                        </Pressable>
                      ) : null}
                    </>
                  ) : (
                    <View style={styles.emptyState}>
                      <Text style={styles.emptyStateTitle}>No Codespaces yet</Text>
                      <Text style={styles.cardBody}>
                        {createEnabled
                          ? 'Create one and it will show up here.'
                          : 'Configure the Claudex template repository in this build to continue.'}
                      </Text>
                      {createEnabled ? (
                        <Pressable
                          onPress={() => {
                            void handleCreateCodespace();
                          }}
                          disabled={busy}
                          style={({ pressed }) => [
                            styles.primaryButton,
                            pressed && !busy && styles.primaryButtonPressed,
                          ]}
                        >
                          {creatingCodespace ? (
                            <ActivityIndicator size="small" color={theme.colors.black} />
                          ) : (
                            <Ionicons name="rocket-outline" size={16} color={theme.colors.black} />
                          )}
                          <Text style={styles.primaryButtonText}>Create Codespace</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  )}

                  <View style={styles.actionRow}>
                    <Pressable
                      onPress={() => {
                        void refreshGitHubState();
                      }}
                      disabled={codespacesLoading}
                      style={({ pressed }) => [
                        styles.secondaryButton,
                        pressed && !codespacesLoading && styles.secondaryButtonPressed,
                      ]}
                    >
                      <Ionicons name="refresh-outline" size={15} color={theme.colors.textPrimary} />
                      <Text style={styles.secondaryButtonText}>Refresh list</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        void beginGitHubSignIn();
                      }}
                      disabled={authorizing}
                      style={({ pressed }) => [
                        styles.secondaryButton,
                        pressed && !authorizing && styles.secondaryButtonPressed,
                      ]}
                    >
                      <Ionicons name="logo-github" size={15} color={theme.colors.textPrimary} />
                      <Text style={styles.secondaryButtonText}>Use another account</Text>
                    </Pressable>
                  </View>

                </>
              ) : null}

              {onboardingStage === 'connect' ? (
                <>
                  <View style={styles.stagePanel}>
                    <Text style={styles.stagePanelEyebrow}>Connection progress</Text>
                    <View style={styles.connectionStatusHeader}>
                      <View style={styles.loadingRow}>
                        {busy ? (
                          <ActivityIndicator color={theme.colors.textPrimary} />
                        ) : (
                          <Ionicons
                            name="checkmark-circle-outline"
                            size={16}
                            color={theme.colors.statusComplete}
                          />
                        )}
                        <View style={styles.connectionStatusCopy}>
                          <Text style={styles.stagePanelTitle}>
                            {formatConnectionPhaseTitle(connectionPhase, activeCodespaceLabel)}
                          </Text>
                        </View>
                      </View>
                    </View>
                    {connectionMessage ? (
                      <View style={styles.connectionConsole}>
                        <Text selectable style={styles.connectionConsoleText}>
                          {connectionMessage}
                        </Text>
                      </View>
                    ) : (
                      <Text style={styles.cardBody}>
                        GitHub is connected. Clawdex is finishing setup.
                      </Text>
                    )}
                  </View>

                  <View style={styles.connectionStepRow}>
                    <ConnectionStep
                      theme={theme}
                      styles={styles}
                      label="GitHub"
                      state={connectionStepStates.github}
                    />
                    <ConnectionStep
                      theme={theme}
                      styles={styles}
                      label="Codespace"
                      state={connectionStepStates.codespace}
                    />
                    <ConnectionStep
                      theme={theme}
                      styles={styles}
                      label="Codex"
                      state={connectionStepStates.bridge}
                    />
                  </View>

                  <View style={styles.actionRow}>
                    {pendingCodexLogin ? (
                      <>
                        <Pressable
                          onPress={() => {
                            void loginToCodexWithChatGpt();
                          }}
                          disabled={codexLoginSubmitting}
                          style={({ pressed }) => [
                            styles.primaryButton,
                            pressed && !codexLoginSubmitting && styles.primaryButtonPressed,
                          ]}
                        >
                          {codexLoginSubmitting ? (
                            <ActivityIndicator size="small" color={theme.colors.black} />
                          ) : (
                            <Ionicons name="log-in-outline" size={15} color={theme.colors.black} />
                          )}
                          <Text style={styles.primaryButtonText}>Login with ChatGPT</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => {
                            void openCodespaceForCodexLogin();
                          }}
                          disabled={codexLoginSubmitting}
                          style={({ pressed }) => [
                            styles.secondaryButton,
                            pressed && !codexLoginSubmitting && styles.secondaryButtonPressed,
                          ]}
                        >
                          {codexLoginSubmitting ? (
                            <ActivityIndicator size="small" color={theme.colors.textPrimary} />
                          ) : (
                            <Ionicons
                              name="open-outline"
                              size={15}
                              color={theme.colors.textPrimary}
                            />
                          )}
                          <Text style={styles.secondaryButtonText}>Open Codespace</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => {
                            void completeCodexLoginIfReady(pendingCodexLogin);
                          }}
                          disabled={codexLoginChecking}
                          style={({ pressed }) => [
                            styles.secondaryButton,
                            pressed && !codexLoginChecking && styles.secondaryButtonPressed,
                          ]}
                        >
                          {codexLoginChecking ? (
                            <ActivityIndicator size="small" color={theme.colors.textPrimary} />
                          ) : (
                            <Ionicons
                              name="checkmark-done-outline"
                              size={15}
                              color={theme.colors.textPrimary}
                            />
                          )}
                          <Text style={styles.secondaryButtonText}>Check again</Text>
                        </Pressable>
                      </>
                    ) : null}
                    <Pressable
                      onPress={() => {
                        void refreshGitHubState();
                      }}
                      disabled={codespacesLoading}
                      style={({ pressed }) => [
                        styles.secondaryButton,
                        pressed && !codespacesLoading && styles.secondaryButtonPressed,
                      ]}
                    >
                      <Ionicons name="refresh-outline" size={15} color={theme.colors.textPrimary} />
                      <Text style={styles.secondaryButtonText}>Refresh status</Text>
                    </Pressable>
                    {busy || pendingCodexLogin ? (
                      <Pressable
                        onPress={cancelCodespaceConnection}
                        style={({ pressed }) => [
                          styles.secondaryButton,
                          pressed && styles.secondaryButtonPressed,
                        ]}
                      >
                        <Ionicons name="close-outline" size={15} color={theme.colors.textPrimary} />
                        <Text style={styles.secondaryButtonText}>Cancel wait</Text>
                      </Pressable>
                    ) : null}
                  </View>
                </>
              ) : null}
            </BlurView>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

async function finalizeGitHubSession(token: GitHubUserAccessToken): Promise<GitHubSession> {
  const user = await fetchGitHubUser(token.accessToken);
  return {
    ...token,
    user,
  };
}

function bridgeProfileToGitHubToken(profile: BridgeProfile): GitHubUserAccessToken {
  return {
    accessToken: profile.bridgeToken,
    scope: [],
    tokenType: 'bearer',
    refreshToken: profile.githubRefreshToken,
    expiresInSec: null,
    accessTokenExpiresAtMs: isoStringToTimestampMs(profile.githubAccessTokenExpiresAt),
    refreshTokenExpiresInSec: null,
    refreshTokenExpiresAtMs: isoStringToTimestampMs(profile.githubRefreshTokenExpiresAt),
  };
}

function timestampMsToIsoString(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return new Date(value).toISOString();
}

function isoStringToTimestampMs(value: string | null | undefined): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

async function withBridgeApiClient<T>(
  bridgeUrl: string,
  accessToken: string,
  task: (api: HostBridgeApiClient) => Promise<T>
): Promise<T> {
  const ws = new HostBridgeWsClient(bridgeUrl, {
    authToken: accessToken,
    allowQueryTokenAuth: env.allowWsQueryTokenAuth,
    requestTimeoutMs: 15_000,
  });
  const api = new HostBridgeApiClient({ ws });

  try {
    return await task(api);
  } finally {
    ws.disconnect();
  }
}

async function waitForBridgeReady(bridgeUrl: string, accessToken: string): Promise<void> {
  const startedAt = Date.now();
  let lastErrorMessage = 'bridge did not respond';
  while (Date.now() - startedAt <= BRIDGE_READY_TIMEOUT_MS) {
    try {
      const healthResponse = await fetch(toBridgeHealthUrl(bridgeUrl), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
      if (healthResponse.ok) {
        const health = await readBridgeHealthPayload(healthResponse);
        if (health?.status === 'ok') {
          await verifyBridgeRpcReady(bridgeUrl, accessToken);
          return;
        }
        lastErrorMessage = 'health endpoint responded before the bridge runtime was ready';
      } else {
        lastErrorMessage = `health check returned ${String(healthResponse.status)}`;
      }
    } catch (error) {
      lastErrorMessage =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : 'network request failed';
    }

    await sleep(BRIDGE_READY_POLL_MS);
  }

  throw new Error(
    `Codespace bridge did not become ready in time (${lastErrorMessage}). Open the Codespace in GitHub once and confirm bootstrap finished and ports 8787/8788 are public.`
  );
}

async function readBridgeHealthPayload(
  response: Response
): Promise<{ status?: unknown } | null> {
  try {
    const payload = (await response.json()) as { status?: unknown };
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

async function verifyBridgeRpcReady(bridgeUrl: string, accessToken: string): Promise<void> {
  await withBridgeApiClient(bridgeUrl, accessToken, async (api) => {
    const health = await api.health();
    if (health.status !== 'ok') {
      throw new Error('bridge RPC health check did not return ok');
    }
  });
}

function buildCodespaceProfileName(codespace: GitHubCodespace): string {
  if (codespace.repositoryName) {
    return `${codespace.repositoryName} · ${codespace.name}`;
  }

  return codespace.name;
}

function isCodespaceAvailable(codespace: Pick<GitHubCodespace, 'state'>): boolean {
  return codespace.state.trim().toLowerCase() === 'available';
}

function formatCodespaceStatus(codespace: Pick<GitHubCodespace, 'state'>): string {
  return isCodespaceAvailable(codespace) ? 'Ready' : formatCodespaceState(codespace.state);
}

function formatCodespaceState(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return 'Unknown';
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

const createStyles = (theme: AppTheme) => {
  const cardBackground = theme.isDark ? theme.colors.bgCanvasAccent : '#F3F7FB';
  const cardBorder = theme.isDark ? theme.colors.borderHighlight : 'rgba(71, 85, 105, 0.20)';
  const secondaryBackground = theme.isDark ? theme.colors.bgMain : '#D9E2EB';
  const secondaryPressed = theme.isDark ? theme.colors.bgItem : '#CCD6E0';

  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.bgMain,
    },
    safeArea: {
      flex: 1,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.md,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.borderHighlight,
    },
    headerButton: {
      padding: theme.spacing.xs,
    },
    headerCopy: {
      flex: 1,
    },
    headerEyebrow: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
    },
    headerTitle: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
    },
    scroll: {
      flex: 1,
    },
    content: {
      padding: theme.spacing.lg,
      paddingBottom: theme.spacing.xl * 1.5,
      gap: theme.spacing.md,
    },
    hero: {
      borderRadius: theme.radius.lg,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.xl,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: cardBorder,
      gap: theme.spacing.sm,
      boxShadow: theme.isDark
        ? '0px 24px 60px rgba(0, 0, 0, 0.32)'
        : '0px 18px 42px rgba(15, 31, 54, 0.14)',
    },
    heroEyebrow: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
    },
    heroTitle: {
      ...theme.typography.largeTitle,
      color: theme.colors.textPrimary,
    },
    heroDescription: {
      ...theme.typography.body,
      color: theme.colors.textSecondary,
      lineHeight: 21,
    },
    heroMonitor: {
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(56, 79, 106, 0.16)',
      backgroundColor: theme.isDark ? 'rgba(5, 7, 10, 0.62)' : 'rgba(255, 255, 255, 0.62)',
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      gap: theme.spacing.sm,
    },
    heroMonitorRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    heroMonitorDot: {
      width: 8,
      height: 8,
      borderRadius: 999,
      backgroundColor: theme.colors.textMuted,
      opacity: 0.42,
    },
    heroMonitorDotActive: {
      backgroundColor: theme.colors.statusComplete,
      opacity: 1,
    },
    heroMonitorLabel: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      fontWeight: '600',
    },
    heroStepRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.sm,
      marginTop: theme.spacing.xs,
    },
    heroStep: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      borderRadius: 999,
      borderWidth: 1,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
    },
    heroStepPending: {
      borderColor: cardBorder,
      backgroundColor: theme.isDark ? 'rgba(198, 205, 217, 0.08)' : 'rgba(255, 255, 255, 0.7)',
    },
    heroStepActive: {
      borderColor: theme.colors.textPrimary,
      backgroundColor: theme.isDark ? 'rgba(198, 205, 217, 0.14)' : 'rgba(255, 255, 255, 0.92)',
    },
    heroStepDone: {
      borderColor: theme.isDark ? 'rgba(198, 205, 217, 0.28)' : 'rgba(14, 159, 110, 0.28)',
      backgroundColor: theme.isDark ? 'rgba(198, 205, 217, 0.12)' : 'rgba(14, 159, 110, 0.10)',
    },
    heroStepNumber: {
      ...theme.typography.caption,
      fontWeight: '700',
    },
    heroStepLabel: {
      ...theme.typography.caption,
      fontWeight: '600',
    },
    card: {
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: cardBorder,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.lg,
      backgroundColor: cardBackground,
      overflow: 'hidden',
      gap: theme.spacing.md,
      boxShadow: theme.isDark
        ? '0px 18px 48px rgba(0, 0, 0, 0.24)'
        : '0px 14px 32px rgba(15, 31, 54, 0.12)',
    },
    cardTitle: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
    },
    cardBody: {
      ...theme.typography.body,
      color: theme.colors.textSecondary,
      lineHeight: 21,
    },
    stageHeader: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.spacing.md,
    },
    stageBadge: {
      width: 52,
      minHeight: 72,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: theme.isDark ? 'rgba(198, 205, 217, 0.08)' : 'rgba(255, 255, 255, 0.72)',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.xs,
    },
    stageBadgeValue: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '700',
      fontVariant: ['tabular-nums'],
    },
    stageHeaderCopy: {
      flex: 1,
      gap: 4,
    },
    stageEyebrow: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
    },
    stageTitle: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
    },
    stageDescription: {
      ...theme.typography.body,
      color: theme.colors.textSecondary,
      lineHeight: 21,
    },
    errorBanner: {
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.isDark ? 'rgba(239, 68, 68, 0.28)' : 'rgba(217, 45, 32, 0.24)',
      backgroundColor: theme.colors.errorBg,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.spacing.sm,
    },
    errorBannerText: {
      ...theme.typography.caption,
      color: theme.colors.error,
      flex: 1,
      lineHeight: 18,
    },
    progressBanner: {
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.isDark ? 'rgba(198, 205, 217, 0.22)' : 'rgba(67, 96, 126, 0.20)',
      backgroundColor: theme.isDark ? 'rgba(198, 205, 217, 0.08)' : 'rgba(255, 255, 255, 0.78)',
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    progressBannerCopy: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    progressBannerTitle: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
    progressBannerText: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      lineHeight: 18,
    },
    repoSummaryRow: {
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: theme.isDark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.72)',
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      gap: 4,
    },
    repoSummaryLabel: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    },
    repoSummaryValue: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      lineHeight: 18,
    },
    simpleHeaderBlock: {
      gap: theme.spacing.xs,
    },
    cardHeadlineBlock: {
      gap: theme.spacing.xs,
    },
    cardHeadline: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
    },
    loadingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    sessionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing.md,
    },
    sessionCopy: {
      flex: 1,
      gap: 2,
    },
    accountStrip: {
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: theme.isDark ? 'rgba(198, 205, 217, 0.08)' : 'rgba(255, 255, 255, 0.72)',
      padding: theme.spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing.md,
    },
    accountStripCopy: {
      flex: 1,
      gap: 2,
    },
    accountStripActions: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: theme.spacing.xs,
      flexWrap: 'wrap',
    },
    accountStripLabel: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
    },
    accountStripTitle: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
    accountStripMeta: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
    },
    sessionTitle: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: '600',
    },
    sessionSubtitle: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      marginTop: 2,
    },
    recommendedActionCard: {
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: theme.isDark ? 'rgba(198, 205, 217, 0.08)' : 'rgba(255, 255, 255, 0.72)',
      padding: theme.spacing.md,
      gap: theme.spacing.sm,
    },
    recommendedActionEyebrow: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
    },
    recommendedActionTitle: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
    recommendedActionMeta: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
    },
    stagePanel: {
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: theme.isDark ? 'rgba(198, 205, 217, 0.08)' : 'rgba(255, 255, 255, 0.72)',
      padding: theme.spacing.md,
      gap: theme.spacing.sm,
      boxShadow: theme.isDark
        ? '0px 8px 20px rgba(0, 0, 0, 0.14)'
        : '0px 6px 14px rgba(15, 31, 54, 0.06)',
    },
    stagePanelEyebrow: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
    },
    stagePanelTitle: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
    stagePanelMeta: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
    },
    connectionStatusHeader: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: theme.spacing.md,
    },
    connectionStatusCopy: {
      flex: 1,
      gap: 4,
    },
    connectionStatusTitle: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: '600',
    },
    actionRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.sm,
    },
    primaryButton: {
      minHeight: 44,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.textPrimary,
      paddingHorizontal: theme.spacing.lg,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.xs,
    },
    primaryButtonPressed: {
      opacity: 0.9,
    },
    primaryButtonText: {
      ...theme.typography.caption,
      color: theme.colors.black,
      fontWeight: '700',
    },
    secondaryButton: {
      minHeight: 40,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: secondaryBackground,
      paddingHorizontal: theme.spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.xs,
    },
    secondaryButtonPressed: {
      backgroundColor: secondaryPressed,
    },
    secondaryButtonText: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '600',
    },
    ghostButton: {
      minHeight: 34,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: secondaryBackground,
      paddingHorizontal: theme.spacing.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    ghostButtonDanger: {
      borderColor: theme.isDark ? 'rgba(248, 113, 113, 0.28)' : 'rgba(220, 38, 38, 0.18)',
      backgroundColor: theme.isDark ? 'rgba(127, 29, 29, 0.18)' : 'rgba(254, 242, 242, 0.92)',
    },
    ghostButtonDangerPressed: {
      backgroundColor: theme.isDark ? 'rgba(127, 29, 29, 0.24)' : 'rgba(254, 226, 226, 0.96)',
    },
    ghostButtonText: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '600',
    },
    ghostButtonTextDanger: {
      color: theme.colors.error,
    },
    deviceCodeWrap: {
      alignSelf: 'stretch',
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: theme.colors.bgMain,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      alignItems: 'center',
    },
    deviceCodeValue: {
      ...theme.typography.mono,
      color: theme.colors.textPrimary,
      fontSize: 18,
      letterSpacing: 1.1,
      textAlign: 'center',
      includeFontPadding: false,
    },
    authorizeInstructionList: {
      gap: theme.spacing.sm,
    },
    authorizeInstructionRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.spacing.sm,
    },
    authorizeInstructionNumber: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '700',
      width: 16,
    },
    authorizeInstructionText: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      flex: 1,
      lineHeight: 18,
    },
    deviceCodeStatusRow: {
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: theme.isDark ? 'rgba(198, 205, 217, 0.06)' : 'rgba(255, 255, 255, 0.78)',
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    deviceCodeStatusRowActive: {
      borderColor: theme.isDark ? 'rgba(198, 205, 217, 0.28)' : 'rgba(14, 159, 110, 0.24)',
      backgroundColor: theme.isDark ? 'rgba(198, 205, 217, 0.10)' : 'rgba(14, 159, 110, 0.08)',
    },
    deviceCodeStatusText: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      fontWeight: '600',
    },
    deviceCodeStatusTextActive: {
      color: theme.colors.statusComplete,
    },
    miniStepList: {
      gap: theme.spacing.sm,
    },
    signalList: {
      gap: theme.spacing.md,
    },
    signalRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.spacing.md,
    },
    signalIconWrap: {
      width: 34,
      height: 34,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: theme.isDark ? 'rgba(198, 205, 217, 0.08)' : 'rgba(255, 255, 255, 0.7)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    signalCopy: {
      flex: 1,
      gap: 2,
    },
    signalTitle: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: '600',
    },
    signalMeta: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      lineHeight: 18,
    },
    miniStepRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    miniStepNumber: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '700',
      width: 16,
    },
    miniStepText: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      flex: 1,
    },
    sectionLabel: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
    },
    codespacesHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing.md,
    },
    codespacesCardHeader: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: theme.spacing.md,
    },
    codespacesCardCopy: {
      flex: 1,
      gap: theme.spacing.xs,
    },
    codespaceList: {
      gap: theme.spacing.md,
    },
    codespaceCard: {
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: theme.isDark ? 'rgba(198, 205, 217, 0.06)' : 'rgba(255, 255, 255, 0.72)',
      padding: theme.spacing.md,
      gap: theme.spacing.md,
    },
    codespaceCardRecommended: {
      borderColor: theme.isDark ? 'rgba(198, 205, 217, 0.26)' : 'rgba(14, 159, 110, 0.20)',
      backgroundColor: theme.isDark ? 'rgba(198, 205, 217, 0.10)' : 'rgba(14, 159, 110, 0.08)',
      boxShadow: theme.isDark
        ? '0px 10px 24px rgba(0, 0, 0, 0.16)'
        : '0px 8px 20px rgba(15, 31, 54, 0.08)',
    },
    codespaceCardDeleting: {
      borderColor: theme.isDark ? 'rgba(239, 68, 68, 0.30)' : 'rgba(217, 45, 32, 0.30)',
      backgroundColor: theme.colors.errorBg,
    },
    codespaceCardTop: {
      gap: theme.spacing.sm,
    },
    codespaceBadgeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing.sm,
      flexWrap: 'wrap',
    },
    codespaceTag: {
      borderRadius: 999,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 4,
    },
    codespaceTagRecommended: {
      backgroundColor: theme.isDark ? 'rgba(198, 205, 217, 0.16)' : 'rgba(14, 159, 110, 0.16)',
    },
    codespaceTagDefault: {
      backgroundColor: theme.isDark ? theme.colors.bgMain : '#E6EEF6',
    },
    codespaceTagText: {
      ...theme.typography.caption,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 0.7,
    },
    codespaceTagTextRecommended: {
      color: theme.colors.statusComplete,
    },
    codespaceTagTextDefault: {
      color: theme.colors.textSecondary,
    },
    codespaceCardTitle: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
    codespaceRepository: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      fontWeight: '600',
    },
    codespaceHint: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      lineHeight: 18,
    },
    codespaceStatePill: {
      borderRadius: 999,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 4,
      backgroundColor: theme.isDark ? theme.colors.bgMain : '#E6EEF6',
    },
    codespaceStateText: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      fontWeight: '600',
    },
    codespaceMeta: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
    },
    codespaceFacts: {
      gap: theme.spacing.sm,
    },
    codespaceFactRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
    },
    codespaceFactText: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      flex: 1,
    },
    codespaceCardFooter: {
      gap: theme.spacing.sm,
    },
    codespaceActionRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.sm,
    },
    codespacePrimaryAction: {
      minHeight: 42,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.textPrimary,
      paddingHorizontal: theme.spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.xs,
    },
    codespaceButtonPressed: {
      opacity: 0.9,
    },
    codespaceButtonBusy: {
      opacity: 0.88,
    },
    codespacePrimaryActionText: {
      ...theme.typography.caption,
      color: theme.colors.black,
      fontWeight: '700',
    },
    codespaceSecondaryAction: {
      minHeight: 38,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: secondaryBackground,
      paddingHorizontal: theme.spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.xs,
    },
    codespaceMoreAction: {
      minHeight: 36,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: secondaryBackground,
      paddingHorizontal: theme.spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.xs,
    },
    codespaceSecondaryActionText: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '600',
    },
    codespaceStopAction: {
      minHeight: 38,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.isDark ? 'rgba(239, 68, 68, 0.24)' : 'rgba(217, 45, 32, 0.22)',
      backgroundColor: theme.colors.errorBg,
      paddingHorizontal: theme.spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.xs,
    },
    codespaceStopActionPressed: {
      opacity: 0.9,
    },
    codespaceActionDisabled: {
      opacity: 0.52,
    },
    codespaceStopActionText: {
      ...theme.typography.caption,
      color: theme.colors.error,
      fontWeight: '700',
    },
    codespaceStopConfirm: {
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.isDark ? 'rgba(239, 68, 68, 0.22)' : 'rgba(217, 45, 32, 0.18)',
      backgroundColor: theme.colors.errorBg,
      padding: theme.spacing.md,
      gap: theme.spacing.sm,
    },
    codespaceStopConfirmTitle: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
    codespaceStopConfirmText: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      lineHeight: 18,
    },
    codespaceStopConfirmActions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.sm,
    },
    codespaceStopCancel: {
      minHeight: 38,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: secondaryBackground,
      paddingHorizontal: theme.spacing.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    codespaceStopCancelText: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '600',
    },
    codespaceStopConfirmButton: {
      minHeight: 38,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.error,
      paddingHorizontal: theme.spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.xs,
    },
    codespaceStopConfirmButtonPressed: {
      opacity: 0.92,
    },
    codespaceStopConfirmButtonText: {
      ...theme.typography.caption,
      color: theme.colors.white,
      fontWeight: '700',
    },
    helperText: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
    },
    deferredActionBlock: {
      gap: theme.spacing.xs,
    },
    linkButton: {
      minHeight: 34,
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      paddingVertical: theme.spacing.xs,
    },
    linkButtonPressed: {
      opacity: 0.72,
    },
    linkButtonText: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '600',
    },
    emptyState: {
      gap: theme.spacing.md,
    },
    emptyStateTitle: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
    connectionStepRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.sm,
    },
    connectionStep: {
      minHeight: 38,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
    },
    connectionStepPending: {
      borderColor: cardBorder,
      backgroundColor: secondaryBackground,
    },
    connectionStepActive: {
      borderColor: theme.colors.warning,
      backgroundColor: theme.colors.warningBg,
    },
    connectionStepDone: {
      borderColor: theme.isDark ? 'rgba(198, 205, 217, 0.28)' : 'rgba(14, 159, 110, 0.28)',
      backgroundColor: theme.isDark ? 'rgba(198, 205, 217, 0.12)' : 'rgba(14, 159, 110, 0.10)',
    },
    connectionStepLabel: {
      ...theme.typography.caption,
      fontWeight: '600',
    },
    connectionConsole: {
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: theme.colors.bgMain,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
    },
    connectionConsoleText: {
      ...theme.typography.mono,
      color: theme.colors.textSecondary,
      lineHeight: 18,
    },
    errorText: {
      ...theme.typography.caption,
      color: theme.colors.error,
    },
  });
};
