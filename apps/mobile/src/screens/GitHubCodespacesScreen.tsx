import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
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
import { getFreshChatGptAuthTokens, isNativeChatGptLoginAvailable } from '../chatGptAuth';
import { env } from '../config';
import {
  buildGitHubCodespacesBridgeUrl,
  buildGitHubCodespacesRepositoryCandidates,
  createGitHubCodespaceInRepository,
  fetchGitHubCodespaces,
  fetchGitHubUser,
  getReusableGitHubBridgeProfile,
  isRetryableGitHubDeviceFlowError,
  pollGitHubDeviceAccessToken,
  requestGitHubDeviceCode,
  resolveGitHubCodespaceCreationContext,
  sortGitHubCodespaces,
  startGitHubCodespace,
  stopGitHubCodespace,
  type GitHubCodespace,
  type GitHubDeviceCodeGrant,
  type GitHubOAuthAccessToken,
  type GitHubUser,
} from '../githubCodespaces';
import { useAppTheme, type AppTheme } from '../theme';

interface GitHubCodespacesScreenProps {
  bridgeProfiles: BridgeProfile[];
  activeBridgeProfileId?: string | null;
  onBack: () => void;
  onConnect: (draft: BridgeProfileDraft) => void | Promise<void>;
}

interface GitHubSession {
  accessToken: string;
  scope: string[];
  user: GitHubUser;
}

type ConnectionPhase =
  | 'checkingExisting'
  | 'resolvingRepo'
  | 'creatingCodespace'
  | 'startingCodespace'
  | 'codespaceReady'
  | 'waitingForBridge'
  | 'codexLoginRequired';

type ConnectionStepState = 'pending' | 'active' | 'done';
type OnboardingStage = 'github' | 'authorize' | 'codespace' | 'connect';

interface PendingCodexLogin {
  runId: number;
  bridgeUrl: string;
  accessToken: string;
  codespaceWebUrl: string | null;
  profileDraft: BridgeProfileDraft;
}

const GITHUB_DEVICE_FLOW_SCOPES = ['codespace', 'read:user'];
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
    case 'resolvingRepo':
      return `Preparing repository${targetLabel}`;
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
        ? `Codespace ${activeCodespaceLabel} is ready, starting bridge`
        : 'Codespace ready, starting bridge';
    case 'codexLoginRequired':
      return 'Bridge is ready, finish Codex login';
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

function HeroStepPill({
  number,
  label,
  state,
  styles,
  theme,
}: {
  number: number;
  label: string;
  state: ConnectionStepState;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}) {
  const numberColor =
    state === 'done'
      ? theme.colors.statusComplete
      : state === 'active'
        ? theme.colors.textPrimary
        : theme.colors.textMuted;
  const labelColor =
    state === 'pending' ? theme.colors.textMuted : theme.colors.textSecondary;

  return (
    <View
      style={[
        styles.heroStep,
        state === 'done'
          ? styles.heroStepDone
          : state === 'active'
            ? styles.heroStepActive
            : styles.heroStepPending,
      ]}
    >
      <Text style={[styles.heroStepNumber, { color: numberColor }]}>{number}</Text>
      <Text style={[styles.heroStepLabel, { color: labelColor }]}>{label}</Text>
    </View>
  );
}

export function GitHubCodespacesScreen({
  bridgeProfiles,
  activeBridgeProfileId = null,
  onBack,
  onConnect,
}: GitHubCodespacesScreenProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [session, setSession] = useState<GitHubSession | null>(null);
  const [deviceGrant, setDeviceGrant] = useState<GitHubDeviceCodeGrant | null>(null);
  const [restoringSession, setRestoringSession] = useState(true);
  const [authorizing, setAuthorizing] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [codespaces, setCodespaces] = useState<GitHubCodespace[]>([]);
  const [codespacesLoading, setCodespacesLoading] = useState(false);
  const [codespacesError, setCodespacesError] = useState<string | null>(null);
  const [connectingCodespaceName, setConnectingCodespaceName] = useState<string | null>(null);
  const [pendingStopCodespaceName, setPendingStopCodespaceName] = useState<string | null>(null);
  const [stoppingCodespaceName, setStoppingCodespaceName] = useState<string | null>(null);
  const [creatingCodespace, setCreatingCodespace] = useState(false);
  const [creationTargetLabel, setCreationTargetLabel] = useState<string | null>(null);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionPhase, setConnectionPhase] = useState<ConnectionPhase | null>(null);
  const [pendingCodexLogin, setPendingCodexLogin] = useState<PendingCodexLogin | null>(null);
  const [codexLoginChecking, setCodexLoginChecking] = useState(false);
  const [codexLoginSubmitting, setCodexLoginSubmitting] = useState(false);
  const [deviceCodeCopied, setDeviceCodeCopied] = useState(false);
  const authFlowRef = useRef(0);
  const connectFlowRef = useRef(0);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const deviceCodeCopyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const githubConfigured = Boolean(env.githubClientId);
  const preferredRepositoryName = env.githubCodespacesPreferredRepositoryName;
  const configuredSourceOwner = env.githubCodespacesSourceRepositoryOwner;
  const configuredRepositoryRef = env.githubCodespacesRepositoryRef;
  const createEnabled = Boolean(preferredRepositoryName);
  const nativeChatGptLoginAvailable = isNativeChatGptLoginAvailable();

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      appStateRef.current = nextState;
    });

    return () => {
      subscription.remove();
      if (deviceCodeCopyResetTimeoutRef.current) {
        clearTimeout(deviceCodeCopyResetTimeoutRef.current);
      }
    };
  }, []);

  const flashDeviceCodeCopied = useCallback(() => {
    if (deviceCodeCopyResetTimeoutRef.current) {
      clearTimeout(deviceCodeCopyResetTimeoutRef.current);
    }
    setDeviceCodeCopied(true);
    deviceCodeCopyResetTimeoutRef.current = setTimeout(() => {
      setDeviceCodeCopied(false);
      deviceCodeCopyResetTimeoutRef.current = null;
    }, 1400);
  }, []);

  const copyGitHubDeviceCode = useCallback(
    async (userCode: string) => {
      try {
        await Clipboard.setStringAsync(userCode);
        flashDeviceCodeCopied();
      } catch {
        setAuthError('Unable to copy the GitHub device code automatically.');
      }
    },
    [flashDeviceCodeCopied]
  );

  const openGitHubDeviceVerification = useCallback(async (verificationUri: string) => {
    try {
      await WebBrowser.openBrowserAsync(verificationUri);
    } catch {
      setAuthError('Unable to open GitHub device verification automatically.');
    }
  }, []);

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

  useEffect(() => {
    let cancelled = false;
    const reusableProfile = getReusableGitHubBridgeProfile(bridgeProfiles, activeBridgeProfileId);

    if (!githubConfigured || !reusableProfile) {
      setRestoringSession(false);
      return () => {
        cancelled = true;
      };
    }

    const restoreSession = async () => {
      try {
        const user = await fetchGitHubUser(reusableProfile.bridgeToken);
        if (cancelled) {
          return;
        }

        const nextSession: GitHubSession = {
          accessToken: reusableProfile.bridgeToken,
          scope: [],
          user,
        };
        setSession(nextSession);
        await loadCodespaces(nextSession.accessToken);
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
  }, [activeBridgeProfileId, bridgeProfiles, githubConfigured, loadCodespaces]);

  const beginGitHubSignIn = useCallback(async () => {
    if (!env.githubClientId) {
      setAuthError('GitHub login is not configured in this build.');
      return;
    }

    const runId = authFlowRef.current + 1;
    authFlowRef.current = runId;
    setAuthorizing(true);
    setAuthError(null);
    setConnectionError(null);
    setSession(null);
    setDeviceGrant(null);
    setDeviceCodeCopied(false);

    try {
      const grant = await requestGitHubDeviceCode(env.githubClientId, GITHUB_DEVICE_FLOW_SCOPES);
      if (authFlowRef.current !== runId) {
        return;
      }

      setDeviceGrant(grant);
      void copyGitHubDeviceCode(grant.userCode);

      let nextIntervalSec = grant.intervalSec;
      while (Date.now() < grant.expiresAtMs && authFlowRef.current === runId) {
        if (appStateRef.current !== 'active') {
          await sleep(500);
          continue;
        }

        await sleep(nextIntervalSec * 1000);
        if (authFlowRef.current !== runId) {
          return;
        }
        if (appStateRef.current !== 'active') {
          continue;
        }

        let result;
        try {
          result = await pollGitHubDeviceAccessToken(env.githubClientId, grant.deviceCode);
        } catch (error) {
          if (isRetryableGitHubDeviceFlowError(error)) {
            continue;
          }
          throw error;
        }
        if (authFlowRef.current !== runId) {
          return;
        }

        if (result.kind === 'pending') {
          nextIntervalSec = result.intervalSec;
          continue;
        }

        if (result.kind === 'denied' || result.kind === 'expired') {
          setAuthError(result.message);
          setDeviceGrant(null);
          return;
        }

        const nextSession = await finalizeGitHubSession(result.token);
        if (authFlowRef.current !== runId) {
          return;
        }

        setSession(nextSession);
        setDeviceGrant(null);
        await loadCodespaces(nextSession.accessToken);
        return;
      }

      if (authFlowRef.current === runId) {
        setAuthError('GitHub device verification timed out. Start sign-in again.');
        setDeviceGrant(null);
      }
    } catch (error) {
      if (authFlowRef.current === runId) {
        setAuthError((error as Error).message);
      }
    } finally {
      if (authFlowRef.current === runId) {
        setAuthorizing(false);
      }
    }
  }, [copyGitHubDeviceCode, loadCodespaces, openGitHubDeviceVerification]);

  const cancelGitHubSignIn = useCallback(() => {
    authFlowRef.current += 1;
    setAuthorizing(false);
    setDeviceGrant(null);
    setDeviceCodeCopied(false);
  }, []);

  const refreshCodespaces = useCallback(async () => {
    if (!session) {
      return;
    }

    await loadCodespaces(session.accessToken);
  }, [loadCodespaces, session]);

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
            ? 'Bridge is ready, but Codex still needs ChatGPT login. Tap Login with ChatGPT to finish setup from this phone, or open the Codespace as a fallback.'
            : Platform.OS === 'ios' || Platform.OS === 'android'
              ? 'Bridge is ready, but Codex still needs ChatGPT login. Use the installed native app build to finish that login from this phone, or open the Codespace as a fallback.'
            : 'Bridge is ready, but Codex still needs ChatGPT login. Finish that login from the Codespace on another machine, then return here and tap Check again.'
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
      const bridgeUrl = buildGitHubCodespacesBridgeUrl(
        codespace.name,
        env.githubCodespacesPortForwardingDomain
      );
      if (!bridgeUrl) {
        throw new Error('Unable to derive the forwarded Codespaces bridge URL.');
      }

      setConnectionPhase('waitingForBridge');
      setConnectionMessage(
        `Codespace ${codespace.name} is up. Starting bridge bootstrap… First boot can take a few minutes while the Codespace installs Codex and builds the bridge.`
      );
      await waitForBridgeReady(bridgeUrl, activeSession.accessToken);
      if (connectFlowRef.current !== runId) {
        return 'connected';
      }

      const profileDraft: BridgeProfileDraft = {
        name: buildCodespaceProfileName(codespace),
        bridgeUrl,
        bridgeToken: activeSession.accessToken,
        authMode: 'githubOAuth',
        githubUserLogin: activeSession.user.login,
        githubCodespaceName: codespace.name,
        githubRepositoryFullName: codespace.repositoryFullName,
        activate: true,
      };

      setConnectionMessage('Bridge is up. Checking whether Codex login is still required…');
      const account = await withBridgeApiClient(bridgeUrl, activeSession.accessToken, (api) =>
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
        accessToken: activeSession.accessToken,
        codespaceWebUrl: codespace.webUrl ?? null,
        profileDraft,
      });
      setConnectionMessage(
        nativeChatGptLoginAvailable
          ? 'Bridge is ready, but Codex still needs ChatGPT login. Tap Login with ChatGPT to finish setup from this phone.'
          : Platform.OS === 'ios' || Platform.OS === 'android'
            ? 'Bridge is ready, but Codex still needs ChatGPT login. Use the installed native app build to finish that login from this phone.'
          : 'Bridge is ready, but Codex still needs ChatGPT login. Finish it from the Codespace on another machine, then return here and tap Check again.'
      );
      return 'codexLogin';
    },
    [finalizeConnectedBridgeProfile, nativeChatGptLoginAvailable]
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
    if (!preferredRepositoryName) {
      setConnectionError('No repository is configured for Codespace creation.');
      return;
    }

    let keepConnectionStatus = false;
    const runId = connectFlowRef.current + 1;
    connectFlowRef.current = runId;
    setCreatingCodespace(true);
    setPendingStopCodespaceName(null);
    setConnectingCodespaceName(null);
    setCreationTargetLabel(null);
    setConnectionError(null);
    setPendingCodexLogin(null);
    setCodexLoginChecking(false);
    setCodexLoginSubmitting(false);
    setConnectionPhase('resolvingRepo');

    try {
      setConnectionMessage('Preparing a fresh Codespace from your repository…');
      const creationContext = await resolveGitHubCodespaceCreationContext(session.accessToken, {
        userLogin: session.user.login,
        repoName: preferredRepositoryName,
        sourceOwner: configuredSourceOwner,
        ref: configuredRepositoryRef,
      });
      if (connectFlowRef.current !== runId) {
        return;
      }

      setCreationTargetLabel(creationContext.repository.fullName);
      setConnectionPhase('creatingCodespace');
      setConnectionMessage(
        creationContext.createdFork
          ? `Fork ready. Creating a new Codespace in ${creationContext.repository.fullName}…`
          : `Creating a new Codespace in ${creationContext.repository.fullName}…`
      );
      const codespace = await createGitHubCodespaceInRepository(
        session.accessToken,
        creationContext.repository,
        {
          ref: configuredRepositoryRef,
          devcontainerPath: creationContext.defaults.devcontainerPath,
          location: creationContext.defaults.location,
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
        setConnectionError((error as Error).message);
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
    configuredSourceOwner,
    finalizeCodespaceConnection,
    loadCodespaces,
    preferredRepositoryName,
    session,
  ]);

  const handleOpenCodespace = useCallback((codespace: GitHubCodespace) => {
    if (!codespace.webUrl) {
      return;
    }
    void Linking.openURL(codespace.webUrl).catch(() => {
      setConnectionError('Unable to open the Codespace URL on this device.');
    });
  }, []);

  const handleStopCodespace = useCallback(
    async (codespace: GitHubCodespace) => {
      if (!session) {
        setConnectionError('Sign in with GitHub first.');
        return;
      }

      setStoppingCodespaceName(codespace.name);
      setPendingStopCodespaceName(null);
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

  const githubAccountLabel = session?.user.name?.trim() || session?.user.login || 'GitHub account';
  const repositoryCandidates = useMemo(
    () =>
      session
        ? buildGitHubCodespacesRepositoryCandidates(
            session.user.login,
            preferredRepositoryName,
            configuredSourceOwner
          )
        : [],
    [configuredSourceOwner, preferredRepositoryName, session]
  );
  const busy =
    Boolean(connectingCodespaceName) ||
    Boolean(stoppingCodespaceName) ||
    creatingCodespace ||
    codexLoginChecking ||
    codexLoginSubmitting;
  const statusCardVisible =
    Boolean(connectionPhase) || busy || Boolean(connectionMessage) || Boolean(pendingCodexLogin);
  const creationHint =
    repositoryCandidates.length > 1
      ? `Clawdex will try ${repositoryCandidates[0]?.fullName} first. If it does not exist yet, it will fork from ${repositoryCandidates[1]?.fullName} and create the Codespace there.`
      : repositoryCandidates.length === 1
        ? `Clawdex will create the Codespace in ${repositoryCandidates[0]?.fullName}.`
        : 'Configure a repository name to enable in-app Codespace creation.';
  const connectionStepStates = buildConnectionStepStates(connectionPhase);
  const activeCodespaceLabel =
    connectingCodespaceName ??
    pendingCodexLogin?.profileDraft.githubCodespaceName ??
    creationTargetLabel;
  const suggestedCodespace = codespaces[0] ?? null;
  const suggestedCodespaceActionLabel = suggestedCodespace
    ? suggestedCodespace.state.trim().toLowerCase() === 'available'
      ? 'Connect latest Codespace'
      : 'Start latest Codespace'
    : null;
  const sessionPrimaryActionLabel = suggestedCodespaceActionLabel ?? 'Create your first Codespace';
  const sessionPrimaryActionDescription = suggestedCodespace
    ? `${suggestedCodespace.name} • ${
        suggestedCodespace.repositoryFullName ?? 'Unknown repository'
      }`
    : createEnabled
      ? creationHint
      : 'Configure a repository name in the app build to enable one-tap Codespace creation.';
  const onboardingStage: OnboardingStage = deviceGrant
    ? 'authorize'
    : session
      ? statusCardVisible
        ? 'connect'
        : 'codespace'
      : 'github';
  const onboardingStepStates: {
    github: ConnectionStepState;
    codespace: ConnectionStepState;
    connect: ConnectionStepState;
  } =
    onboardingStage === 'github' || onboardingStage === 'authorize'
      ? {
          github: 'active',
          codespace: 'pending',
          connect: 'pending',
        }
      : onboardingStage === 'codespace'
        ? {
            github: 'done',
            codespace: 'active',
            connect: 'pending',
          }
        : {
            github: 'done',
            codespace: 'done',
            connect: 'active',
          };
  const onboardingStepNumber =
    onboardingStage === 'codespace' ? 2 : onboardingStage === 'connect' ? 3 : 1;
  const onboardingStageTitle =
    onboardingStage === 'authorize'
      ? 'Approve GitHub access'
      : onboardingStage === 'codespace'
        ? 'Choose your Codespace'
        : onboardingStage === 'connect'
          ? 'Finish connection'
          : 'Sign in with GitHub';
  const onboardingStageDescription =
    onboardingStage === 'authorize'
      ? 'Copy the device code, open GitHub when you are ready, then approve the sign-in there. Clawdex keeps waiting here for completion.'
      : onboardingStage === 'codespace'
        ? 'Use your GitHub account to reopen a recent Codespace or create a fresh one from the Clawdex template.'
        : onboardingStage === 'connect'
          ? 'Keep this screen open while Clawdex waits for the Codespace bridge and finishes Codex login.'
          : 'Use the GitHub account that owns your Codespaces. Clawdex uses that session to create, start, and reconnect without any relay.';
  const onboardingStageIcon =
    onboardingStage === 'authorize'
      ? 'keypad-outline'
      : onboardingStage === 'codespace'
        ? 'cube-outline'
        : onboardingStage === 'connect'
          ? 'git-network-outline'
          : 'logo-github';

  return (
    <View style={styles.container}>
      <LinearGradient
        colors={[theme.colors.bgMain, theme.colors.bgCanvasAccent, theme.colors.bgMain]}
        style={StyleSheet.absoluteFill}
      />
      <SafeAreaView edges={['top']} style={styles.safeArea}>
        <View style={styles.header}>
          <Pressable onPress={onBack} hitSlop={8} style={styles.headerButton}>
            <Ionicons name="chevron-back" size={20} color={theme.colors.textPrimary} />
          </Pressable>
          <View style={styles.headerCopy}>
            <Text style={styles.headerEyebrow}>GitHub Codespaces</Text>
            <Text style={styles.headerTitle}>Direct connect</Text>
          </View>
        </View>

        <ScrollView
          style={styles.scroll}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <LinearGradient
            colors={
              theme.isDark
                ? ['rgba(181, 189, 204, 0.18)', 'rgba(17, 21, 28, 0.92)', 'rgba(7, 9, 12, 0.98)']
                : ['rgba(56, 79, 106, 0.16)', 'rgba(245, 248, 251, 0.98)', 'rgba(225, 234, 242, 0.98)']
            }
            style={styles.hero}
          >
            <Text style={styles.heroEyebrow}>No relay needed</Text>
            <Text style={styles.heroTitle}>Sign in once. Clawdex handles the rest.</Text>
            <Text style={styles.heroDescription}>
              Use GitHub to create or resume your own Codespace, let the bootstrap bring the bridge
              up, then reconnect straight from the app.
            </Text>
            <View style={styles.heroMonitor}>
              <View style={styles.heroMonitorRow}>
                <View
                  style={[
                    styles.heroMonitorDot,
                    onboardingStepStates.github !== 'pending' && styles.heroMonitorDotActive,
                  ]}
                />
                <Text style={styles.heroMonitorLabel}>GitHub session on this device</Text>
              </View>
              <View style={styles.heroMonitorRow}>
                <View
                  style={[
                    styles.heroMonitorDot,
                    onboardingStepStates.codespace !== 'pending' && styles.heroMonitorDotActive,
                  ]}
                />
                <Text style={styles.heroMonitorLabel}>Codespace owned by the user account</Text>
              </View>
              <View style={styles.heroMonitorRow}>
                <View
                  style={[
                    styles.heroMonitorDot,
                    onboardingStepStates.connect !== 'pending' && styles.heroMonitorDotActive,
                  ]}
                />
                <Text style={styles.heroMonitorLabel}>Direct bridge connection back to Clawdex</Text>
              </View>
            </View>
            <View style={styles.heroStepRow}>
              <HeroStepPill
                number={1}
                label="GitHub"
                state={onboardingStepStates.github}
                styles={styles}
                theme={theme}
              />
              <HeroStepPill
                number={2}
                label="Codespace"
                state={onboardingStepStates.codespace}
                styles={styles}
                theme={theme}
              />
              <HeroStepPill
                number={3}
                label="Connect"
                state={onboardingStepStates.connect}
                styles={styles}
                theme={theme}
              />
            </View>
          </LinearGradient>

          {!githubConfigured ? (
            <BlurView intensity={55} tint={theme.blurTint} style={styles.card}>
              <Text style={styles.cardTitle}>GitHub login not configured</Text>
              <Text style={styles.cardBody}>
                Set `EXPO_PUBLIC_GITHUB_CLIENT_ID` in the mobile app build environment, then rebuild
                the app to enable direct Codespaces sign-in.
              </Text>
            </BlurView>
          ) : null}

          {githubConfigured ? (
            <BlurView intensity={55} tint={theme.blurTint} style={styles.card}>
              <View style={styles.stageHeader}>
                <View style={styles.stageBadge}>
                  <Ionicons
                    name={onboardingStageIcon}
                    size={18}
                    color={theme.colors.textPrimary}
                  />
                  <Text style={styles.stageBadgeValue}>{String(onboardingStepNumber).padStart(2, '0')}</Text>
                </View>
                <View style={styles.stageHeaderCopy}>
                  <Text style={styles.stageEyebrow}>Step {onboardingStepNumber} of 3</Text>
                  <Text style={styles.stageTitle}>{onboardingStageTitle}</Text>
                </View>
                {session ? (
                  <View style={styles.statusPill}>
                    <Ionicons
                      name="checkmark-circle-outline"
                      size={14}
                      color={theme.colors.statusComplete}
                    />
                    <Text style={styles.statusPillText}>GitHub ready</Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.stageDescription}>{onboardingStageDescription}</Text>

              {restoringSession ? (
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
              {onboardingStage === 'codespace' && codespacesError ? (
                <View style={styles.errorBanner}>
                  <Ionicons name="alert-circle-outline" size={16} color={theme.colors.error} />
                  <Text selectable style={styles.errorBannerText}>
                    {codespacesError}
                  </Text>
                </View>
              ) : null}

              {session && onboardingStage !== 'github' && onboardingStage !== 'authorize' ? (
                <View style={styles.accountStrip}>
                  <View style={styles.accountStripCopy}>
                    <Text style={styles.accountStripLabel}>GitHub session</Text>
                    <Text style={styles.accountStripTitle}>{githubAccountLabel}</Text>
                    <Text style={styles.accountStripMeta}>@{session.user.login}</Text>
                  </View>
                  <Pressable
                    onPress={() => {
                      void beginGitHubSignIn();
                    }}
                    disabled={authorizing}
                    style={({ pressed }) => [
                      styles.ghostButton,
                      pressed && !authorizing && styles.secondaryButtonPressed,
                    ]}
                  >
                    <Text style={styles.ghostButtonText}>Switch</Text>
                  </Pressable>
                </View>
              ) : null}

              {onboardingStage === 'github' ? (
                <>
                  <View style={styles.signalList}>
                    <View style={styles.signalRow}>
                      <View style={styles.signalIconWrap}>
                        <Ionicons name="phone-portrait-outline" size={16} color={theme.colors.textPrimary} />
                      </View>
                      <View style={styles.signalCopy}>
                        <Text style={styles.signalTitle}>Stay on this phone</Text>
                        <Text style={styles.signalMeta}>
                          GitHub opens in the native browser sheet and returns here automatically.
                        </Text>
                      </View>
                    </View>
                    <View style={styles.signalRow}>
                      <View style={styles.signalIconWrap}>
                        <Ionicons name="cloud-outline" size={16} color={theme.colors.textPrimary} />
                      </View>
                      <View style={styles.signalCopy}>
                        <Text style={styles.signalTitle}>Use your own compute</Text>
                        <Text style={styles.signalMeta}>
                          Clawdex finds or creates a Codespace under the signed-in GitHub account.
                        </Text>
                      </View>
                    </View>
                    <View style={styles.signalRow}>
                      <View style={styles.signalIconWrap}>
                        <Ionicons name="git-network-outline" size={16} color={theme.colors.textPrimary} />
                      </View>
                      <View style={styles.signalCopy}>
                        <Text style={styles.signalTitle}>Reconnect directly</Text>
                        <Text style={styles.signalMeta}>
                          Once the bridge is up, the app talks straight to that Codespace.
                        </Text>
                      </View>
                    </View>
                  </View>
                  <Pressable
                    onPress={() => {
                      void beginGitHubSignIn();
                    }}
                    disabled={authorizing || restoringSession}
                    style={({ pressed }) => [
                      styles.primaryButton,
                      pressed &&
                        !authorizing &&
                        !restoringSession &&
                        styles.primaryButtonPressed,
                    ]}
                  >
                    {authorizing ? (
                      <ActivityIndicator size="small" color={theme.colors.black} />
                    ) : (
                      <Ionicons name="logo-github" size={16} color={theme.colors.black} />
                    )}
                    <Text style={styles.primaryButtonText}>Sign in with GitHub</Text>
                  </Pressable>
                  <Text style={styles.helperText}>
                    No relay. No extra Clawdex account. Your GitHub session stays on this device.
                  </Text>
                </>
              ) : null}

              {onboardingStage === 'authorize' && deviceGrant ? (
                <>
                  <View style={styles.stagePanel}>
                    <Text style={styles.stagePanelEyebrow}>Device verification</Text>
                    <Text style={styles.stagePanelTitle}>Enter this code in GitHub</Text>
                    <View style={styles.deviceCodeWrap}>
                      <Text selectable style={styles.deviceCodeValue}>
                        {deviceGrant.userCode}
                      </Text>
                    </View>
                    <View style={styles.authorizeInstructionList}>
                      <View style={styles.authorizeInstructionRow}>
                        <Text style={styles.authorizeInstructionNumber}>1</Text>
                        <Text style={styles.authorizeInstructionText}>
                          {deviceCodeCopied
                            ? 'The code has been copied to your clipboard.'
                            : 'Copy the code so you can paste it into GitHub.'}
                        </Text>
                      </View>
                      <View style={styles.authorizeInstructionRow}>
                        <Text style={styles.authorizeInstructionNumber}>2</Text>
                        <Text style={styles.authorizeInstructionText}>
                          Tap `Open GitHub`, paste the code, and approve the device.
                        </Text>
                      </View>
                      <View style={styles.authorizeInstructionRow}>
                        <Text style={styles.authorizeInstructionNumber}>3</Text>
                        <Text style={styles.authorizeInstructionText}>
                          Return here. Clawdex will continue automatically once GitHub finishes.
                        </Text>
                      </View>
                    </View>
                    <View
                      style={[
                        styles.deviceCodeStatusRow,
                        deviceCodeCopied && styles.deviceCodeStatusRowActive,
                      ]}
                    >
                      <Ionicons
                        name={deviceCodeCopied ? 'checkmark-circle-outline' : 'copy-outline'}
                        size={16}
                        color={
                          deviceCodeCopied ? theme.colors.statusComplete : theme.colors.textMuted
                        }
                      />
                      <Text
                        style={[
                          styles.deviceCodeStatusText,
                          deviceCodeCopied && styles.deviceCodeStatusTextActive,
                        ]}
                      >
                        {deviceCodeCopied
                          ? 'Code copied to clipboard'
                          : 'Copy the code before opening GitHub'}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.actionRow}>
                    <Pressable
                      onPress={() => {
                        void copyGitHubDeviceCode(deviceGrant.userCode);
                      }}
                      style={({ pressed }) => [
                        styles.primaryButton,
                        pressed && styles.primaryButtonPressed,
                      ]}
                    >
                      <Ionicons
                        name={deviceCodeCopied ? 'checkmark-outline' : 'copy-outline'}
                        size={15}
                        color={theme.colors.black}
                      />
                      <Text style={styles.primaryButtonText}>
                        {deviceCodeCopied ? 'Copy again' : 'Copy code'}
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        void openGitHubDeviceVerification(deviceGrant.verificationUri);
                      }}
                      style={({ pressed }) => [
                        styles.secondaryButton,
                        pressed && styles.secondaryButtonPressed,
                      ]}
                    >
                      <Ionicons name="open-outline" size={16} color={theme.colors.textPrimary} />
                      <Text style={styles.secondaryButtonText}>Open GitHub</Text>
                    </Pressable>
                    <Pressable
                      onPress={cancelGitHubSignIn}
                      style={({ pressed }) => [
                        styles.secondaryButton,
                        pressed && styles.secondaryButtonPressed,
                      ]}
                    >
                      <Ionicons name="close-outline" size={15} color={theme.colors.textPrimary} />
                      <Text style={styles.secondaryButtonText}>Cancel</Text>
                    </Pressable>
                  </View>
                </>
              ) : null}

              {onboardingStage === 'codespace' && session ? (
                <>
                  <View style={styles.stagePanel}>
                    <Text style={styles.stagePanelEyebrow}>Recommended next step</Text>
                    <Text style={styles.stagePanelTitle}>{sessionPrimaryActionLabel}</Text>
                    <Text style={styles.stagePanelMeta}>{sessionPrimaryActionDescription}</Text>
                    <Pressable
                      onPress={() => {
                        if (suggestedCodespace) {
                          void handleConnectCodespace(suggestedCodespace);
                          return;
                        }
                        if (createEnabled) {
                          void handleCreateCodespace();
                        }
                      }}
                      disabled={busy || (!suggestedCodespace && !createEnabled)}
                      style={({ pressed }) => [
                        styles.primaryButton,
                        pressed &&
                          !busy &&
                          (suggestedCodespace || createEnabled) &&
                          styles.primaryButtonPressed,
                      ]}
                    >
                      {busy ? (
                        <ActivityIndicator size="small" color={theme.colors.black} />
                      ) : (
                        <Ionicons
                          name={suggestedCodespace ? 'flash-outline' : 'rocket-outline'}
                          size={16}
                          color={theme.colors.black}
                        />
                      )}
                      <Text style={styles.primaryButtonText}>{sessionPrimaryActionLabel}</Text>
                    </Pressable>
                  </View>

                  <View style={styles.codespacesHeaderRow}>
                    <Text style={styles.sectionLabel}>Your Codespaces</Text>
                    {createEnabled ? (
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
                        <Text style={styles.secondaryButtonText}>Create new</Text>
                      </Pressable>
                    ) : null}
                  </View>

                  {codespacesLoading ? (
                    <View style={styles.loadingRow}>
                      <ActivityIndicator color={theme.colors.textPrimary} />
                      <Text style={styles.cardBody}>Loading Codespaces…</Text>
                    </View>
                  ) : codespaces.length > 0 ? (
                    <View style={styles.codespaceList}>
                      {codespaces.map((codespace, index) => {
                        const codespaceBusy = connectingCodespaceName === codespace.name;
                        const codespaceStopping = stoppingCodespaceName === codespace.name;
                        const stopConfirmationVisible =
                          pendingStopCodespaceName === codespace.name;
                        const isSuggested = index === 0;
                        const normalizedState = codespace.state.trim().toLowerCase();
                        const canStopCodespace = normalizedState === 'available';
                        const actionLabel =
                          normalizedState === 'available' ? 'Connect now' : 'Start Codespace';
                        const actionIcon =
                          normalizedState === 'available' ? 'flash-outline' : 'play-outline';
                        const actionHint =
                          normalizedState === 'available'
                            ? 'Ready for direct reconnect from this phone.'
                            : 'Clawdex will start it first, then wait for the bridge.';

                        return (
                          <View
                            key={codespace.name}
                            style={[
                              styles.codespaceCard,
                              isSuggested && styles.codespaceCardRecommended,
                            ]}
                          >
                            <View style={styles.codespaceCardTop}>
                              <View style={styles.codespaceBadgeRow}>
                                <View
                                  style={[
                                    styles.codespaceTag,
                                    isSuggested
                                      ? styles.codespaceTagRecommended
                                      : styles.codespaceTagDefault,
                                  ]}
                                >
                                  <Text
                                    style={[
                                      styles.codespaceTagText,
                                      isSuggested
                                        ? styles.codespaceTagTextRecommended
                                        : styles.codespaceTagTextDefault,
                                    ]}
                                  >
                                    {isSuggested ? 'Recommended' : 'Saved'}
                                  </Text>
                                </View>
                                <View style={styles.codespaceStatePill}>
                                  <Text style={styles.codespaceStateText}>
                                    {formatCodespaceState(codespace.state)}
                                  </Text>
                                </View>
                              </View>

                              <Text style={styles.codespaceCardTitle}>{codespace.name}</Text>
                              <Text style={styles.codespaceRepository}>
                                {codespace.repositoryFullName ?? 'Unknown repository'}
                              </Text>
                              <Text style={styles.codespaceHint}>{actionHint}</Text>

                              <View style={styles.codespaceFacts}>
                                <View style={styles.codespaceFactRow}>
                                  <Ionicons
                                    name="time-outline"
                                    size={13}
                                    color={theme.colors.textMuted}
                                  />
                                  <Text style={styles.codespaceFactText}>
                                    Last used {formatTimestamp(codespace.lastUsedAt ?? codespace.updatedAt)}
                                  </Text>
                                </View>
                                {codespace.webUrl ? (
                                  <View style={styles.codespaceFactRow}>
                                    <Ionicons
                                      name="globe-outline"
                                      size={13}
                                      color={theme.colors.textMuted}
                                    />
                                    <Text style={styles.codespaceFactText}>
                                      GitHub web access available
                                    </Text>
                                  </View>
                                ) : null}
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
                                  (codespaceBusy || codespaceStopping) && styles.codespaceButtonBusy,
                                  pressed && !busy && styles.codespaceButtonPressed,
                                ]}
                              >
                                {codespaceBusy || codespaceStopping ? (
                                  <ActivityIndicator size="small" color={theme.colors.black} />
                                ) : (
                                  <Ionicons
                                    name={actionIcon}
                                    size={15}
                                    color={theme.colors.black}
                                  />
                                )}
                                <Text style={styles.codespacePrimaryActionText}>{actionLabel}</Text>
                              </Pressable>
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
                                      Open in GitHub
                                    </Text>
                                  </Pressable>
                                ) : null}
                                {canStopCodespace ? (
                                  <Pressable
                                    onPress={() => {
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
                              </View>

                              {stopConfirmationVisible ? (
                                <View style={styles.codespaceStopConfirm}>
                                  <Text style={styles.codespaceStopConfirmTitle}>
                                    Stop this Codespace?
                                  </Text>
                                  <Text style={styles.codespaceStopConfirmText}>
                                    Your files stay there, but running processes stop and the app
                                    disconnects until you start it again.
                                  </Text>
                                  <View style={styles.codespaceStopConfirmActions}>
                                    <Pressable
                                      onPress={() => setPendingStopCodespaceName(null)}
                                      style={({ pressed }) => [
                                        styles.codespaceStopCancel,
                                        pressed && styles.secondaryButtonPressed,
                                      ]}
                                    >
                                      <Text style={styles.codespaceStopCancelText}>Keep running</Text>
                                    </Pressable>
                                    <Pressable
                                      onPress={() => {
                                        void handleStopCodespace(codespace);
                                      }}
                                      disabled={busy}
                                      style={({ pressed }) => [
                                        styles.codespaceStopConfirmButton,
                                        pressed && !busy && styles.codespaceStopConfirmButtonPressed,
                                        busy && styles.codespaceButtonBusy,
                                      ]}
                                    >
                                      {codespaceStopping ? (
                                        <ActivityIndicator size="small" color={theme.colors.white} />
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
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  ) : (
                    <View style={styles.emptyState}>
                      <Text style={styles.emptyStateTitle}>No Codespaces yet</Text>
                      <Text style={styles.cardBody}>
                        Create one here and Clawdex will bootstrap it for direct connection.
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
                          <Text style={styles.primaryButtonText}>Create and connect</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  )}

                  <View style={styles.actionRow}>
                    <Pressable
                      onPress={() => {
                        void refreshCodespaces();
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

                  <Text style={styles.helperText}>{creationHint}</Text>
                  {configuredSourceOwner &&
                  configuredSourceOwner.toLowerCase() !== session.user.login.toLowerCase() ? (
                    <Text style={styles.helperText}>
                      Clawdex prefers `{session.user.login}/{preferredRepositoryName}` and only
                      forks from `{configuredSourceOwner}/{preferredRepositoryName}` when needed, so
                      Codespaces usage stays with the user account.
                    </Text>
                  ) : null}
                </>
              ) : null}

              {onboardingStage === 'connect' ? (
                <>
                  <View style={styles.stagePanel}>
                    <Text style={styles.stagePanelEyebrow}>Live connection</Text>
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
                      <View style={styles.statusPill}>
                        <Text style={styles.statusPillText}>{busy ? 'Working' : 'Ready'}</Text>
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
                        GitHub is connected. Clawdex is finishing the direct bridge setup.
                      </Text>
                    )}
                    {creationTargetLabel ? (
                      <Text style={styles.helperText}>Creation target: {creationTargetLabel}</Text>
                    ) : null}
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
                      label="Bridge"
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
                        void refreshCodespaces();
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

async function finalizeGitHubSession(token: GitHubOAuthAccessToken): Promise<GitHubSession> {
  const user = await fetchGitHubUser(token.accessToken);
  return {
    accessToken: token.accessToken,
    scope: token.scope,
    user,
  };
}

async function withBridgeApiClient<T>(
  bridgeUrl: string,
  accessToken: string,
  task: (api: HostBridgeApiClient) => Promise<T>
): Promise<T> {
  const ws = new HostBridgeWsClient(bridgeUrl, {
    authToken: accessToken,
    allowQueryTokenAuth: false,
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

function formatCodespaceState(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return 'Unknown';
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return 'recently';
  }

  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
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
    statusPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      borderRadius: 999,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 6,
      backgroundColor: theme.isDark ? 'rgba(198, 205, 217, 0.14)' : 'rgba(14, 159, 110, 0.12)',
    },
    statusPillText: {
      ...theme.typography.caption,
      color: theme.colors.statusComplete,
      fontWeight: '600',
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
    ghostButtonText: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '600',
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
