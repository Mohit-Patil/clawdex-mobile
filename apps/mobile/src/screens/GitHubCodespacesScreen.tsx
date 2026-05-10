import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { HostBridgeApiClient } from '../api/client';
import type { AccountLoginStartResponse, AccountSnapshot } from '../api/types';
import { HostBridgeWsClient } from '../api/ws';
import { toBridgeHealthUrl } from '../bridgeUrl';
import type { BridgeProfile, BridgeProfileDraft } from '../bridgeProfiles';
import { ChoiceAction } from '../components/ChoiceAction';
import { openChatGptLoopbackAuthSession } from '../chatGptAuth';
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
  fetchGitHubUser,
  getReusableGitHubBridgeProfile,
  requestGitHubInstallationAccessToken,
  sortGitHubCodespaces,
  startGitHubCodespace,
  stopGitHubCodespace,
  shouldRefreshGitHubUserAccessToken,
  type GitHubAppInstallationRepository,
  type GitHubCodespace,
  type GitHubUserAccessToken,
  type GitHubUser,
} from '../githubCodespaces';
import { useAppTheme, type AppTheme } from '../theme';

interface GitHubCodespacesScreenProps {
  bridgeProfiles: BridgeProfile[];
  activeBridgeProfileId?: string | null;
  mode?: GitHubCodespacesScreenMode;
  initialSession?: {
    token: GitHubUserAccessToken;
    user: GitHubUser;
  } | null;
  onBack: () => void;
  onConnect: (draft: BridgeProfileDraft) => void | Promise<void>;
  onOpenPrivateConnection?: () => void;
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
type OnboardingStage = 'github' | 'codespace' | 'success';
type GitHubCodespacesScreenMode = 'setup' | 'manage';
type CodespaceSelectionMode = 'recommended' | 'list';
type GitHubSetupStep =
  | 'chooseConnection'
  | 'githubLogin'
  | 'createCodespace'
  | 'repositoryChoice'
  | 'projectSetup'
  | 'codexLogin';
type RepositoryChoice = 'clone' | 'fresh';
type RecoveryKind =
  | 'githubToken'
  | 'repoAccess'
  | 'privatePorts'
  | 'bridgeStart'
  | 'codexLogin'
  | 'generic';

interface PendingCodexLogin {
  runId: number;
  bridgeUrl: string;
  accessToken: string;
  codespaceWebUrl: string | null;
  codexLoginId: string | null;
  codexLoginUrl: string | null;
  codexLoginKind: ManagedCodexLoginKind | null;
  codexUserCode: string | null;
  profileDraft: BridgeProfileDraft;
}

type ManagedCodexLoginKind = 'web' | 'device';

const BRIDGE_READY_POLL_MS = 3000;
const BRIDGE_READY_TIMEOUT_MS = 6 * 60 * 1000;
const CODESPACES_PRIVATE_PORT_ERROR =
  'Clawdex cannot reach the Codespace bridge because GitHub kept port 8787 private. Open the Codespace Ports panel and make ports 8787 and 8788 public, then try again.';
const CODEX_ACCOUNT_READY_POLL_MS = 1_250;
const CODEX_ACCOUNT_READY_TIMEOUT_MS = 12_000;
const CODEX_LOGIN_COMPLETION_TIMEOUT_MS = 90_000;
const CODEX_LOGIN_COMPLETION_GRACE_MS = 2_000;
const CODEX_LOGIN_BROWSER_LAUNCH_GRACE_MS = 2_500;

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

function classifyRecovery(error: string | null | undefined): RecoveryKind | null {
  const normalized = error?.trim().toLowerCase() ?? '';
  if (!normalized) {
    return null;
  }
  if (
    normalized.includes('session expired') ||
    normalized.includes('bad credentials') ||
    normalized.includes('token') ||
    normalized.includes('401')
  ) {
    return 'githubToken';
  }
  if (
    normalized.includes('repository access') ||
    normalized.includes('not expose') ||
    normalized.includes('resource not accessible') ||
    normalized.includes('installation')
  ) {
    return 'repoAccess';
  }
  if (normalized.includes('ports') || normalized.includes('public')) {
    return 'privatePorts';
  }
  if (
    normalized.includes('bridge did not become ready') ||
    normalized.includes('health check') ||
    normalized.includes('network request failed')
  ) {
    return 'bridgeStart';
  }
  if (normalized.includes('codex') || normalized.includes('chatgpt')) {
    return 'codexLogin';
  }
  return 'generic';
}

function formatRecovery(kind: RecoveryKind): { title: string; body: string } {
  switch (kind) {
    case 'githubToken':
      return {
        title: 'GitHub session expired',
        body: 'Sign in again so Clawdex can refresh Codespaces access.',
      };
    case 'repoAccess':
      return {
        title: 'Repository unavailable',
        body: 'Use a Codespace repository this GitHub account can access, then try again.',
      };
    case 'privatePorts':
      return {
        title: 'Ports may be private',
        body: 'Open the Codespace and make ports 8787 and 8788 public, then check again.',
      };
    case 'bridgeStart':
      return {
        title: 'Bridge is still starting',
        body: 'Codespaces can take a few minutes after resume. Open GitHub if it keeps waiting.',
      };
    case 'codexLogin':
      return {
        title: 'ChatGPT login required',
        body: 'Log in once to finish setup.',
      };
    case 'generic':
      return {
        title: 'Could not finish setup',
        body: 'Check the current step, then try again.',
      };
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

function SetupMotionScene({
  icon,
  busy,
  styles,
  theme,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  busy: boolean;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}) {
  const pulse = useRef(new Animated.Value(0)).current;
  const float = useRef(new Animated.Value(0)).current;
  const scan = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const pulseLoop = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: busy ? 1050 : 1900,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      })
    );
    const floatLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(float, {
          toValue: 1,
          duration: 1500,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(float, {
          toValue: 0,
          duration: 1500,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );
    const scanLoop = Animated.loop(
      Animated.timing(scan, {
        toValue: 1,
        duration: busy ? 950 : 1800,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      })
    );

    pulseLoop.start();
    floatLoop.start();
    scanLoop.start();
    return () => {
      pulseLoop.stop();
      floatLoop.stop();
      scanLoop.stop();
    };
  }, [busy, float, pulse, scan]);

  const pulseStyle = {
    opacity: pulse.interpolate({
      inputRange: [0, 1],
      outputRange: [0.28, 0.05],
    }),
    transform: [
      {
        scale: pulse.interpolate({
          inputRange: [0, 1],
          outputRange: [0.92, 1.18],
        }),
      },
    ],
  };
  const floatStyle = {
    transform: [
      {
        translateY: float.interpolate({
          inputRange: [0, 1],
          outputRange: [0, -7],
        }),
      },
    ],
  };
  const scanStyle = {
    opacity: scan.interpolate({
      inputRange: [0, 0.18, 0.82, 1],
      outputRange: [0, 0.95, 0.95, 0],
    }),
    transform: [
      {
        translateY: scan.interpolate({
          inputRange: [0, 1],
          outputRange: [-22, 38],
        }),
      },
    ],
  };

  return (
    <View style={styles.setupMotionScene}>
      <Animated.View style={[styles.setupMotionPulseFrame, pulseStyle]} />
      <View style={styles.setupMotionBackplate} />
      <View style={styles.setupMotionBridgeLine}>
        <Animated.View style={[styles.setupMotionBridgeSignal, scanStyle]} />
      </View>
      <Animated.View style={[styles.setupMotionIconWrap, floatStyle]}>
        <Ionicons name={icon} size={30} color={theme.colors.textPrimary} />
      </Animated.View>
      <View style={styles.setupMotionCard}>
        <View style={styles.setupMotionCardHeader} />
        <View style={styles.setupMotionCardLineWide} />
        <View style={styles.setupMotionCardLineShort} />
      </View>
    </View>
  );
}

export function GitHubCodespacesScreen({
  bridgeProfiles,
  activeBridgeProfileId = null,
  mode = 'setup',
  initialSession = null,
  onBack,
  onConnect,
  onOpenPrivateConnection,
  onSyncGitHubAuthToken,
}: GitHubCodespacesScreenProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [setupStep, setSetupStep] = useState<GitHubSetupStep>(
    initialSession ? 'createCodespace' : 'chooseConnection'
  );
  const [createdCodespace, setCreatedCodespace] = useState<GitHubCodespace | null>(null);
  const [repositoryChoice, setRepositoryChoice] = useState<RepositoryChoice | null>(null);
  const [availableCloneRepositories, setAvailableCloneRepositories] = useState<
    GitHubAppInstallationRepository[]
  >([]);
  const [cloneRepositoriesLoading, setCloneRepositoriesLoading] = useState(false);
  const [cloneRepositoriesError, setCloneRepositoriesError] = useState<string | null>(null);
  const [selectedCloneRepository, setSelectedCloneRepository] =
    useState<GitHubAppInstallationRepository | null>(null);
  const [cloningRepositoryFullName, setCloningRepositoryFullName] = useState<string | null>(null);
  const [session, setSession] = useState<GitHubSession | null>(null);
  const [restoringSession, setRestoringSession] = useState(true);
  const [authorizing, setAuthorizing] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
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
  const [codespaceSelectionMode, setCodespaceSelectionMode] =
    useState<CodespaceSelectionMode>('recommended');
  const [expandedCodespaceName, setExpandedCodespaceName] = useState<string | null>(null);
  const [creationTargetLabel, setCreationTargetLabel] = useState<string | null>(null);
  const [creationMessage, setCreationMessage] = useState<string | null>(null);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionPhase, setConnectionPhase] = useState<ConnectionPhase | null>(null);
  const [pendingCodexLogin, setPendingCodexLogin] = useState<PendingCodexLogin | null>(null);
  const [connectedProfileDraft, setConnectedProfileDraft] = useState<BridgeProfileDraft | null>(null);
  const [codexLoginChecking, setCodexLoginChecking] = useState(false);
  const [codexLoginSubmitting, setCodexLoginSubmitting] = useState(false);
  const [codexLoginBrowserOpen, setCodexLoginBrowserOpen] = useState(false);
  const authFlowRef = useRef(0);
  const connectFlowRef = useRef(0);
  const autoCodexLoginRunRef = useRef<number | null>(null);
  const githubConfigured = Boolean(env.githubClientId && env.githubAppAuthBaseUrl);
  const preferredRepositoryName = env.githubCodespacesPreferredRepositoryName;
  const configuredSourceOwner = env.githubCodespacesSourceRepositoryOwner;
  const configuredRepositoryRef = env.githubCodespacesRepositoryRef;
  const reusableBridgeProfile = useMemo(
    () => getReusableGitHubBridgeProfile(bridgeProfiles, activeBridgeProfileId),
    [activeBridgeProfileId, bridgeProfiles]
  );
  const savedCodespaceName = reusableBridgeProfile?.githubCodespaceName ?? null;

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
            reusableBridgeProfile
              ? bridgeProfileToGitHubToken(reusableBridgeProfile)
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
            await onSyncGitHubAuthToken?.(reusableBridgeProfile?.githubUserLogin, restoredToken);
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
  }, [
    githubConfigured,
    initialSession,
    loadCodespaces,
    onSyncGitHubAuthToken,
    reusableBridgeProfile,
  ]);
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

  useEffect(() => {
    if (!session) {
      return;
    }
    if (setupStep === 'githubLogin') {
      setSetupStep('createCodespace');
    }
  }, [session, setupStep]);

  useEffect(() => {
    if (pendingCodexLogin || connectedProfileDraft) {
      setSetupStep('codexLogin');
    }
  }, [connectedProfileDraft, pendingCodexLogin]);

  const beginGitHubSignIn = useCallback(async () => {
    if (!env.githubClientId) {
      setAuthError('GitHub login is not configured in this build.');
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
    setConnectedProfileDraft(null);

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
      setCodespaceSelectionMode('recommended');
      setSession(nextSession);
      await loadCodespaces(nextSession.accessToken);
    } catch (error) {
      if (authFlowRef.current === runId) {
        setAuthError((error as Error).message);
      }
    } finally {
      if (authFlowRef.current === runId) {
        setAuthorizing(false);
      }
    }
  }, [loadCodespaces, onSyncGitHubAuthToken]);

  const refreshGitHubState = useCallback(async () => {
    if (!session) {
      return;
    }

    await loadCodespaces(session.accessToken);
  }, [loadCodespaces, session]);

  const refreshGitHubSessionForBridge = useCallback(
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

  const cancelCodespaceConnection = useCallback(() => {
    connectFlowRef.current += 1;
    autoCodexLoginRunRef.current = null;
    setCreatingCodespace(false);
    setConnectingCodespaceName(null);
    setPendingStopCodespaceName(null);
    setStoppingCodespaceName(null);
    setCreationTargetLabel(null);
    setCreationMessage(null);
    setConnectionMessage(null);
    setConnectionError(null);
    setConnectionPhase(null);
    setPendingCodexLogin(null);
    setConnectedProfileDraft(null);
    setCodexLoginChecking(false);
    setCodexLoginSubmitting(false);
    setCodexLoginBrowserOpen(false);
    setCloningRepositoryFullName(null);
  }, []);

  const finalizeConnectedBridgeProfile = useCallback(
    async (draft: BridgeProfileDraft) => {
      setPendingCodexLogin(null);
      setConnectionMessage(null);
      setConnectionError(null);
      setConnectionPhase(null);
      setConnectedProfileDraft(draft);
    },
    []
  );

  const completeConnectedFlow = useCallback(async () => {
    if (!connectedProfileDraft) {
      return;
    }
    await onConnect(connectedProfileDraft);
  }, [connectedProfileDraft, onConnect]);

  const reloadCodexAccountAfterRuntimeRestart = useCallback(
    async (pending: PendingCodexLogin): Promise<AccountSnapshot | null> => {
      if (connectFlowRef.current !== pending.runId) {
        return null;
      }

      setConnectionMessage('Finishing setup...');
      let codexRestarted = false;
      await withBridgeApiClient(pending.bridgeUrl, pending.accessToken, async (api) => {
        try {
          await api.restartCodexAppServer();
          codexRestarted = true;
        } catch (error) {
          const message = (error as Error).message.trim();
          setConnectionMessage(
            'Update this Codespace to finish setup automatically.'
          );
          if (message.length > 0) {
            console.warn(`Codex app-server restart unavailable: ${message}`);
          }
        }
      });
      if (!codexRestarted) {
        return null;
      }

      setConnectionMessage('Finishing setup...');
      return withTimeout(
        withBridgeApiClient(pending.bridgeUrl, pending.accessToken, (api) =>
          waitForCodexAccountReady(api, CODEX_ACCOUNT_READY_TIMEOUT_MS)
        ),
        CODEX_ACCOUNT_READY_TIMEOUT_MS + 5_000,
        'Log in with ChatGPT to continue.'
      );
    },
    []
  );

  const completeCodexLoginIfReady = useCallback(
    async (
      pending: PendingCodexLogin,
      options: { restartIfNeeded?: boolean } = {}
    ): Promise<boolean> => {
      if (connectFlowRef.current !== pending.runId) {
        return false;
      }

      setCodexLoginChecking(true);
      setConnectionError(null);
      setConnectionMessage('Checking login...');

      try {
        const account = await withTimeout(
          withBridgeApiClient(pending.bridgeUrl, pending.accessToken, (api) =>
            waitForCodexAccountReady(api, CODEX_ACCOUNT_READY_TIMEOUT_MS)
          ),
          CODEX_ACCOUNT_READY_TIMEOUT_MS + 5_000,
          'Log in with ChatGPT to continue.'
        );
        if (connectFlowRef.current !== pending.runId) {
          return false;
        }

        if (isCodexAccountReady(account)) {
          setConnectionMessage('Finishing setup...');
          setPendingCodexLogin(null);
          await finalizeConnectedBridgeProfile(pending.profileDraft);
          return true;
        }

        if (options.restartIfNeeded !== false) {
          const restartedAccount = await reloadCodexAccountAfterRuntimeRestart(pending);
          if (connectFlowRef.current !== pending.runId || !restartedAccount) {
            return false;
          }

          if (isCodexAccountReady(restartedAccount)) {
            setConnectionMessage('Finishing setup...');
            setPendingCodexLogin(null);
            await finalizeConnectedBridgeProfile(pending.profileDraft);
            return true;
          }
        }

        setConnectionPhase('codexLoginRequired');
        setConnectionMessage(formatCodexManagedLoginInstruction(pending.codexUserCode));
        return false;
      } catch (error) {
        if (connectFlowRef.current === pending.runId) {
          setConnectionError((error as Error).message);
        }
        return false;
      } finally {
        if (connectFlowRef.current === pending.runId) {
          setCodexLoginChecking(false);
        }
      }
    },
    [finalizeConnectedBridgeProfile, reloadCodexAccountAfterRuntimeRestart]
  );

  const openCodexManagedLogin = useCallback(async (targetPending?: PendingCodexLogin) => {
    const pending = targetPending ?? pendingCodexLogin;
    if (!pending) {
      return false;
    }

    setCodexLoginSubmitting(true);
    setConnectionError(null);

    try {
      let shouldReloadAfterLogin = false;
      await withBridgeApiClient(
        pending.bridgeUrl,
        pending.accessToken,
        async (api) => {
          let loginUrl = pending.codexLoginUrl;
          let userCode = pending.codexUserCode;
          let loginId = pending.codexLoginId;
          let loginKind = pending.codexLoginKind;

          if (!loginUrl) {
            setConnectionMessage('Log in with ChatGPT to continue.');
            const response = await startManagedCodexLogin(api);
            const loginDetails = readManagedCodexLoginDetails(response);
            loginUrl = loginDetails.url;
            userCode = loginDetails.userCode;
            loginId = loginDetails.loginId;
            loginKind = loginDetails.kind;

            setPendingCodexLogin((current) =>
              current && current.runId === pending.runId
                ? {
                    ...current,
                    codexLoginId: loginId,
                    codexLoginUrl: loginUrl,
                    codexLoginKind: loginKind,
                    codexUserCode: userCode,
                  }
                : current
            );
          }

          if (connectFlowRef.current !== pending.runId) {
            return;
          }

          const loginCompletion = loginId
            ? api.waitForAccountLoginCompleted(loginId, CODEX_LOGIN_COMPLETION_TIMEOUT_MS)
            : Promise.resolve();
          void loginCompletion.catch(() => undefined);
          const waitForLoginCompletionGrace = async () => {
            if (!loginId) {
              return false;
            }
            try {
              return await Promise.race([
                loginCompletion.then(() => true),
                sleep(CODEX_LOGIN_COMPLETION_GRACE_MS).then(() => false),
              ]);
            } catch {
              return false;
            }
          };

          if (loginKind === 'device') {
            await Linking.openURL(loginUrl);
            setConnectionMessage(formatCodexManagedLoginInstruction(userCode));
            shouldReloadAfterLogin = await waitForLoginCompletionGrace();
            return;
          }

          setConnectionMessage('Log in with ChatGPT to continue.');
          setCodexLoginBrowserOpen(true);
          const sessionPromise = openChatGptLoopbackAuthSession(loginUrl, {
            onCallback: async (callbackUrl) => {
              await withBridgeApiClient(pending.bridgeUrl, pending.accessToken, (callbackApi) =>
                callbackApi.forwardCodexAuthCallback(callbackUrl.toString())
              );
            },
          });

          void sessionPromise
            .then((session) => {
              if (connectFlowRef.current !== pending.runId) {
                return;
              }
              if (session.kind === 'error') {
                setConnectionError(session.message);
                return;
              }
              if (session.kind === 'callback') {
                setConnectionMessage('Checking login...');
                void completeCodexLoginIfReady(pending, { restartIfNeeded: true });
              }
            })
            .catch((error) => {
              if (connectFlowRef.current === pending.runId) {
                setConnectionError((error as Error).message);
              }
            })
            .finally(() => {
              if (connectFlowRef.current === pending.runId) {
                setCodexLoginBrowserOpen(false);
              }
            });

          const session = await Promise.race([
            sessionPromise,
            sleep(CODEX_LOGIN_BROWSER_LAUNCH_GRACE_MS).then(() => ({ kind: 'pending' as const })),
          ]);

          if (session.kind === 'pending') {
            setConnectionMessage(formatCodexManagedLoginInstruction(userCode));
            return;
          }
          if (session.kind === 'cancelled') {
            setConnectionMessage('Log in with ChatGPT to continue.');
            return;
          }
          if (session.kind === 'dismissed') {
            setConnectionMessage('Log in with ChatGPT to continue.');
            return;
          }
          if (session.kind === 'error') {
            throw new Error(session.message);
          }

          setConnectionMessage('Finishing setup...');
          await waitForLoginCompletionGrace();
          shouldReloadAfterLogin = true;
        },
        { requestTimeoutMs: 60_000 }
      );

      if (!shouldReloadAfterLogin || connectFlowRef.current !== pending.runId) {
        return false;
      }

      const restartedAccount = await reloadCodexAccountAfterRuntimeRestart(pending);
      if (!restartedAccount || connectFlowRef.current !== pending.runId) {
        return false;
      }

      if (isCodexAccountReady(restartedAccount)) {
        setConnectionMessage('Finishing setup...');
        setPendingCodexLogin(null);
        await finalizeConnectedBridgeProfile(pending.profileDraft);
        return true;
      }

      setConnectionPhase('codexLoginRequired');
      setConnectionMessage(formatCodexManagedLoginInstruction(pending.codexUserCode));
      return false;
    } catch (error) {
      setConnectionError((error as Error).message);
      return false;
    } finally {
      setCodexLoginSubmitting(false);
    }
  }, [
    completeCodexLoginIfReady,
    finalizeConnectedBridgeProfile,
    pendingCodexLogin,
    reloadCodexAccountAfterRuntimeRestart,
  ]);

  useEffect(() => {
    if (!pendingCodexLogin || connectedProfileDraft) {
      return;
    }
    if (codexLoginChecking || codexLoginSubmitting) {
      return;
    }
    if (autoCodexLoginRunRef.current === pendingCodexLogin.runId) {
      return;
    }

    autoCodexLoginRunRef.current = pendingCodexLogin.runId;
    let cancelled = false;

    const runCodexLogin = async () => {
      const ready = await completeCodexLoginIfReady(pendingCodexLogin, {
        restartIfNeeded: Boolean(
          pendingCodexLogin.codexLoginId || pendingCodexLogin.codexLoginUrl
        ),
      });
      if (cancelled || ready || connectFlowRef.current !== pendingCodexLogin.runId) {
        return;
      }

      await openCodexManagedLogin(pendingCodexLogin);
    };

    void runCodexLogin();

    return () => {
      cancelled = true;
    };
  }, [
    codexLoginChecking,
    codexLoginSubmitting,
    completeCodexLoginIfReady,
    connectedProfileDraft,
    openCodexManagedLogin,
    pendingCodexLogin,
  ]);

  const finalizeCodespaceConnection = useCallback(
    async (
      runId: number,
      codespace: GitHubCodespace,
      activeSession: GitHubSession,
      cloneRepository: GitHubAppInstallationRepository | null = null
    ): Promise<'connected' | 'codexLogin'> => {
      const bridgeSession = await refreshGitHubSessionForBridge(activeSession);
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
        `Codespace ${codespace.name} is ready. Starting workspace services...`
      );
      await waitForBridgeReady(bridgeUrl, bridgeSession.accessToken);
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

      if (cloneRepository) {
        if (!env.githubAppAuthBaseUrl) {
          throw new Error('GitHub auth backend URL is not configured in this build.');
        }

        setConnectionMessage(`Preparing GitHub access for ${cloneRepository.fullName}...`);
        const installationToken = await requestGitHubInstallationAccessToken({
          authBaseUrl: env.githubAppAuthBaseUrl,
          userAccessToken: bridgeSession.accessToken,
          installationId: cloneRepository.installationId,
          repositories: [cloneRepository.fullName],
        });
        if (connectFlowRef.current !== runId) {
          return 'connected';
        }

        const authorizedRepositories =
          installationToken.repositoryNames.length > 0
            ? installationToken.repositoryNames
            : [cloneRepository.fullName];
        setConnectionMessage(`Cloning ${cloneRepository.fullName}...`);
        setCloningRepositoryFullName(cloneRepository.fullName);
        await withBridgeApiClient(
          bridgeUrl,
          bridgeSession.accessToken,
          async (api) => {
            await api.installGitHubAuth({
              grants: [
                {
                  accessToken: installationToken.accessToken,
                  repositories: authorizedRepositories,
                },
              ],
            });
            const cloneResult = await api.gitClone({
              url: `https://github.com/${cloneRepository.fullName}.git`,
              parentPath: null,
              directoryName: cloneRepository.name,
            });
            if (!cloneResult.cloned || (cloneResult.code !== null && cloneResult.code !== 0)) {
              const detail = (cloneResult.stderr || cloneResult.stdout).trim();
              throw new Error(
                detail.length > 0
                  ? detail
                  : `Git clone failed for ${cloneRepository.fullName}.`
              );
            }
          },
          { requestTimeoutMs: 5 * 60 * 1000 }
        );
        if (connectFlowRef.current !== runId) {
          return 'connected';
        }
        setCloningRepositoryFullName(null);
        setConnectionMessage('Checking login...');
      }

      setConnectionMessage('Checking login...');
      const account = await withBridgeApiClient(bridgeUrl, bridgeSession.accessToken, (api) =>
        api.readAccount({ refreshToken: true })
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
        codexLoginId: null,
        codexLoginUrl: null,
        codexLoginKind: null,
        codexUserCode: null,
        profileDraft,
      });
      setConnectionMessage(
        'Log in with ChatGPT to continue.'
      );
      return 'codexLogin';
    },
    [finalizeConnectedBridgeProfile, refreshGitHubSessionForBridge]
  );

  const handleConnectCodespace = useCallback(
    async (
      codespace: GitHubCodespace,
      options: { cloneRepository?: GitHubAppInstallationRepository | null } = {}
    ) => {
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
      setCloningRepositoryFullName(null);
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
          (await finalizeCodespaceConnection(
            runId,
            currentCodespace,
            session,
            options.cloneRepository ?? null
          )) === 'codexLogin';
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
          setCloningRepositoryFullName(null);
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
      setConnectionError('The Clawdex template repository is not configured in this build.');
      return;
    }

    let keepConnectionStatus = false;
    const runId = connectFlowRef.current + 1;
    connectFlowRef.current = runId;
    setCreatingCodespace(true);
    setPendingStopCodespaceName(null);
    setPendingDeleteCodespaceName(null);
    setConnectingCodespaceName(null);
    setCreationTargetLabel(templateRepository.fullName);
    setConnectionError(null);
    setConnectionMessage(null);
    setConnectionPhase(null);
    setCreationMessage('Preparing the Clawdex template…');
    setPendingCodexLogin(null);
    setCodexLoginChecking(false);
    setCodexLoginSubmitting(false);

    try {
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

      setCreationMessage('Creating your new Codespace…');
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
      setCreationMessage(null);
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
            ? 'GitHub cannot create a Codespace from the configured Clawdex template. Make sure the template repository is public or accessible to this account, then try again.'
            : message
        );
      }
    } finally {
      if (connectFlowRef.current === runId) {
        setCreatingCodespace(false);
        setCreationMessage(null);
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

  const handleCreateCodespaceForSetup = useCallback(async () => {
    if (!session) {
      setConnectionError('Sign in with GitHub first.');
      setSetupStep('githubLogin');
      return;
    }
    if (!templateRepository) {
      setConnectionError('The Clawdex template repository is not configured in this build.');
      return;
    }

    const runId = connectFlowRef.current + 1;
    connectFlowRef.current = runId;
    setCreatingCodespace(true);
    setPendingStopCodespaceName(null);
    setPendingDeleteCodespaceName(null);
    setConnectingCodespaceName(null);
    setCreatedCodespace(null);
    setRepositoryChoice(null);
    setAvailableCloneRepositories([]);
    setCloneRepositoriesError(null);
    setSelectedCloneRepository(null);
    setCloningRepositoryFullName(null);
    setCreationTargetLabel(templateRepository.fullName);
    setConnectionError(null);
    setConnectionMessage(null);
    setConnectionPhase('creatingCodespace');
    setCreationMessage('Preparing Codespace...');
    setPendingCodexLogin(null);
    setCodexLoginChecking(false);
    setCodexLoginSubmitting(false);

    try {
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

      setCreationMessage('Creating Codespace...');
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

      setCreatedCodespace(codespace);
      setCodespaces((current) => sortGitHubCodespaces([codespace, ...current], preferredRepositoryName));
      setSetupStep('repositoryChoice');
      void loadCodespaces(session.accessToken);
    } catch (error) {
      if (connectFlowRef.current === runId) {
        const message = (error as Error).message;
        setConnectionError(
          message.toLowerCase().includes('resource not accessible by integration')
            ? 'GitHub cannot create a Codespace from the configured Clawdex template. Make sure the template repository is public or accessible to this account, then try again.'
            : message
        );
      }
    } finally {
      if (connectFlowRef.current === runId) {
        setCreatingCodespace(false);
        setCreationMessage(null);
        setCreationTargetLabel(null);
        setConnectionPhase(null);
      }
    }
  }, [
    configuredRepositoryRef,
    loadCodespaces,
    preferredRepositoryName,
    session,
    templateRepository,
  ]);

  const loadCloneRepositoriesForSetup = useCallback(async (options: { force?: boolean } = {}) => {
    if (!session) {
      setConnectionError('Sign in with GitHub first.');
      setSetupStep('githubLogin');
      return;
    }

    setRepositoryChoice('clone');
    setSelectedCloneRepository(null);
    setCloneRepositoriesError(null);

    if (!options.force && availableCloneRepositories.length > 0) {
      return;
    }

    setCloneRepositoriesLoading(true);
    try {
      const snapshot = await fetchGitHubAppAccessSnapshot(session.accessToken);
      const repositories = [...snapshot.repositories].sort((a, b) =>
        a.fullName.localeCompare(b.fullName)
      );
      setAvailableCloneRepositories(repositories);
      if (repositories.length === 0) {
        setCloneRepositoriesError(
          'No repositories with read and write access are available. Check the GitHub App installation access, then try again.'
        );
      }
    } catch (error) {
      setCloneRepositoriesError((error as Error).message);
    } finally {
      setCloneRepositoriesLoading(false);
    }
  }, [availableCloneRepositories.length, session]);

  const handleStartFreshForSetup = useCallback(async () => {
    const targetCodespace = createdCodespace;
    if (!targetCodespace) {
      setConnectionError('Create a Codespace first.');
      setSetupStep('createCodespace');
      return;
    }

    setRepositoryChoice('fresh');
    setSelectedCloneRepository(null);
    setSetupStep('projectSetup');
    await handleConnectCodespace(targetCodespace);
  }, [createdCodespace, handleConnectCodespace]);

  const handleCloneRepositoryForSetup = useCallback(
    async (repository: GitHubAppInstallationRepository) => {
      const targetCodespace = createdCodespace;
      if (!targetCodespace) {
        setConnectionError('Create a Codespace first.');
        setSetupStep('createCodespace');
        return;
      }

      setRepositoryChoice('clone');
      setSelectedCloneRepository(repository);
      setSetupStep('projectSetup');
      await handleConnectCodespace(targetCodespace, { cloneRepository: repository });
    },
    [createdCodespace, handleConnectCodespace]
  );

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

      const bridgeSession = await refreshGitHubSessionForBridge(session);
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
    [refreshGitHubSessionForBridge, session]
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
        const remainingVisibleMs = 1_500 - (Date.now() - startedAt);
        if (remainingVisibleMs > 0) {
          await sleep(remainingVisibleMs);
        }
        setCodespaces((current) =>
          current.filter((candidate) => candidate.name !== codespace.name)
        );
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
        setDeletingCodespaceName(null);
      }
    },
    [session]
  );

  const connectionBusy =
    Boolean(connectingCodespaceName) ||
    Boolean(restartingBridgeCodespaceName) ||
    codexLoginChecking ||
    codexLoginSubmitting;
  const busy =
    connectionBusy ||
    creatingCodespace ||
    Boolean(stoppingCodespaceName) ||
    Boolean(deletingCodespaceName);
  const connectionStatusVisible =
    Boolean(connectionPhase) ||
    connectionBusy ||
    Boolean(connectionMessage) ||
    Boolean(pendingCodexLogin);
  const codespaceActionsLocked = busy || connectionStatusVisible;
  const activeCodespaceLabel =
    connectingCodespaceName ??
    pendingCodexLogin?.profileDraft.githubCodespaceName ??
    creationTargetLabel ??
    null;
  const suggestedCodespace = codespaces[0] ?? null;
  const activeConnectingCodespace =
    connectingCodespaceName
      ? codespaces.find((codespace) => codespace.name === connectingCodespaceName) ?? null
      : null;
  const savedCodespace =
    savedCodespaceName
      ? codespaces.find((codespace) => codespace.name === savedCodespaceName) ?? null
      : null;
  const guidedCodespace = savedCodespace ?? suggestedCodespace;
  const onboardingStage: OnboardingStage = connectedProfileDraft
    ? 'success'
    : !session
      ? 'github'
      : 'codespace';
  const showGuidedCodespaceChoice =
    mode === 'setup' &&
    onboardingStage === 'codespace' &&
    codespaceSelectionMode === 'recommended' &&
    guidedCodespace !== null &&
    !codespacesLoading;
  const connectionStepStates = buildConnectionStepStates(connectionPhase);
  const availableCodespaceCount = codespaces.filter((codespace) =>
    isCodespaceAvailable(codespace)
  ).length;
  const showFullCodespaceList = mode === 'manage' || showAllCodespaces;
  const visibleCodespaces = showFullCodespaceList ? codespaces : codespaces.slice(0, 4);
  const hiddenCodespaceCount = Math.max(codespaces.length - visibleCodespaces.length, 0);
  const recoveryKind = classifyRecovery(connectionError ?? authError ?? codespacesError);
  const recovery = recoveryKind ? formatRecovery(recoveryKind) : null;
  const codespacesSummary = codespacesLoading
    ? 'Loading Codespaces…'
    : codespaces.length === 0
      ? mode === 'manage'
        ? 'No Codespaces found.'
        : createEnabled
          ? 'Create a new Codespace to continue.'
          : 'Codespace creation is not configured in this build.'
      : availableCodespaceCount > 0
        ? `${availableCodespaceCount} ready now • ${codespaces.length} total`
        : `${codespaces.length} saved • none running`;
  const stageIntro =
    mode === 'manage'
      ? {
          icon: 'logo-github' as const,
          title: 'Manage Codespaces',
          body: session
            ? 'View running workspaces, pause unused ones, or delete stale Codespaces.'
            : 'Sign in to view and manage your Codespaces.',
        }
      : onboardingStage === 'github'
      ? {
          icon: 'logo-github' as const,
          title: 'Connect GitHub',
          body: 'Sign in to see your Codespaces, then choose the workspace Clawdex should use.',
        }
      : onboardingStage === 'success' && connectedProfileDraft
        ? {
            icon: 'checkmark-circle-outline' as const,
            title: 'Codespace connected',
            body: `${
              connectedProfileDraft.githubCodespaceName ?? connectedProfileDraft.name
            } is ready for Clawdex.`,
          }
        : {
            icon: 'cloud-outline' as const,
            title: showGuidedCodespaceChoice ? 'Connect your Codespace' : 'Choose a Codespace',
            body: showGuidedCodespaceChoice
              ? 'Use the suggested workspace, choose another, or create a fresh one.'
              : 'Pick the workspace Clawdex should use. Paused Codespaces can take a few minutes to start.',
          };
  const manageCodexLoginActionBusy =
    codexLoginSubmitting || codexLoginChecking || codexLoginBrowserOpen;
  const connectionProgressPanel = connectionStatusVisible ? (
    <View style={styles.stagePanel}>
      <Text style={styles.stagePanelEyebrow}>
        {connectionPhase === 'startingCodespace' ? 'Starting Codespace' : 'Connection progress'}
      </Text>
      <View style={styles.connectionStatusHeader}>
        <View style={styles.loadingRow}>
          {connectionBusy ? (
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
          {connectionPhase === 'startingCodespace'
            ? 'GitHub paused this workspace. Starting it can take a few minutes.'
            : 'GitHub is connected. Clawdex is finishing setup.'}
        </Text>
      )}

      {pendingCodexLogin ? (
        <Pressable
          onPress={() => {
            void openCodexManagedLogin(pendingCodexLogin);
          }}
          disabled={manageCodexLoginActionBusy}
          style={({ pressed }) => [
            styles.primaryButton,
            manageCodexLoginActionBusy && styles.codespaceButtonBusy,
            pressed && !manageCodexLoginActionBusy && styles.primaryButtonPressed,
          ]}
        >
          {manageCodexLoginActionBusy ? (
            <ActivityIndicator size="small" color={theme.colors.accentText} />
          ) : (
            <Ionicons name="log-in-outline" size={16} color={theme.colors.accentText} />
          )}
          <Text style={styles.primaryButtonText}>
            {codexLoginChecking
              ? 'Checking login...'
              : codexLoginBrowserOpen
                ? 'Waiting for login...'
                : 'Log in with ChatGPT'}
          </Text>
        </Pressable>
      ) : null}

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
        {connectionPhase === 'startingCodespace' && activeConnectingCodespace?.webUrl ? (
          <Pressable
            onPress={() => handleOpenCodespace(activeConnectingCodespace)}
            style={({ pressed }) => [
              styles.secondaryButton,
              pressed && styles.secondaryButtonPressed,
            ]}
          >
            <Ionicons name="open-outline" size={15} color={theme.colors.textPrimary} />
            <Text style={styles.secondaryButtonText}>Open in GitHub</Text>
          </Pressable>
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
        {connectionBusy || pendingCodexLogin ? (
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
    </View>
  ) : null;
  const setupActionLocked =
    authorizing ||
    creatingCodespace ||
    cloneRepositoriesLoading ||
    Boolean(connectingCodespaceName) ||
    Boolean(cloningRepositoryFullName) ||
    codexLoginChecking ||
    codexLoginSubmitting;
  const codexLoginActionBusy =
    codexLoginChecking || codexLoginSubmitting || codexLoginBrowserOpen;
  const setupScreen =
    setupStep === 'chooseConnection'
      ? {
          icon: 'git-branch-outline' as const,
          title: 'Choose connection',
          body: 'Use a hosted GitHub workspace, or connect to your own machine.',
        }
      : setupStep === 'githubLogin'
        ? {
            icon: 'logo-github' as const,
            title: 'Connect GitHub',
            body: 'Sign in once so Clawdex can create and manage your Codespace.',
          }
        : setupStep === 'createCodespace'
          ? {
              icon: 'cloud-outline' as const,
              title: 'Create Codespace',
              body: session
                ? `Signed in as @${session.user.login}. Create the hosted workspace next.`
                : 'Sign in with GitHub first, then create the hosted workspace.',
            }
          : setupStep === 'repositoryChoice'
            ? {
                icon:
                  repositoryChoice === 'clone'
                    ? 'git-branch-outline' as const
                    : 'folder-open-outline' as const,
                title: repositoryChoice === 'clone' ? 'Choose repository' : 'Project setup',
                body:
                  repositoryChoice === 'clone'
                    ? 'Select a repository this GitHub account can clone into the Codespace.'
                    : createdCodespace
                      ? `${createdCodespace.name} is ready. Choose how this workspace should start.`
                      : 'Choose whether to clone a repository or start fresh.',
              }
            : setupStep === 'projectSetup'
              ? {
                  icon: selectedCloneRepository
                    ? 'git-branch-outline' as const
                    : 'folder-open-outline' as const,
                  title: cloningRepositoryFullName
                    ? 'Cloning repository'
                    : selectedCloneRepository
                      ? 'Preparing Codespace'
                      : 'Setting up project',
                  body: selectedCloneRepository
                    ? cloningRepositoryFullName
                      ? `${selectedCloneRepository.fullName} is being prepared inside the Codespace.`
                      : `${selectedCloneRepository.fullName} will be cloned after workspace services start.`
                    : createdCodespace
                      ? `${createdCodespace.name} is being prepared for Clawdex.`
                      : 'Preparing the workspace before sign-in.',
                }
            : {
                icon: connectedProfileDraft
                  ? 'checkmark-circle-outline' as const
                  : 'terminal-outline' as const,
                title: connectedProfileDraft ? 'Ready to use' : 'ChatGPT login',
                body: connectedProfileDraft
                  ? 'Your Codespace is connected to Clawdex.'
                  : pendingCodexLogin?.codexUserCode
                    ? `Enter ${pendingCodexLogin.codexUserCode} in ChatGPT. Clawdex will continue automatically.`
                    : 'Log in once to finish setup.',
              };
  const setupStatusMessage =
    pendingCodexLogin &&
    connectionMessage === 'Log in with ChatGPT to continue.' &&
    !codexLoginChecking
      ? null
      : connectionMessage ??
        creationMessage ??
        (cloneRepositoriesLoading ? 'Loading repositories...' : null) ??
        (authorizing
          ? 'Opening GitHub...'
          : restoringSession
            ? 'Checking saved GitHub session...'
            : null);
  const setupActions =
    setupStep === 'chooseConnection' ? (
      <>
        <ChoiceAction
          variant="primary"
          logo="github"
          title="GitHub Codespaces"
          meta="Hosted workspace"
          disabled={setupActionLocked}
          onPress={() => {
            setSetupStep('githubLogin');
            void beginGitHubSignIn();
          }}
        />
        <ChoiceAction
          variant="secondary"
          logo="clawdex"
          title="Private bridge"
          meta="Your machine"
          disabled={setupActionLocked}
          onPress={onOpenPrivateConnection ?? onBack}
        />
      </>
    ) : setupStep === 'githubLogin' ? (
      <ChoiceAction
        variant="primary"
        logo="github"
        title={authorizing ? 'Opening GitHub...' : authError ? 'Try GitHub again' : 'Sign in with GitHub'}
        meta="Return here automatically"
        loading={authorizing}
        disabled={setupActionLocked}
        onPress={() => {
          void beginGitHubSignIn();
        }}
      />
    ) : setupStep === 'createCodespace' ? (
      <ChoiceAction
        variant="primary"
        iconName="add-circle-outline"
        title={creatingCodespace ? 'Creating Codespace...' : 'Create Codespace'}
        meta={templateRepository?.fullName ?? 'Clawdex workspace'}
        loading={creatingCodespace}
        disabled={setupActionLocked || !createEnabled}
        onPress={() => {
          void handleCreateCodespaceForSetup();
        }}
      />
    ) : setupStep === 'repositoryChoice' && repositoryChoice === 'clone' ? (
      <>
        <ChoiceAction
          variant="primary"
          iconName="refresh-outline"
          title={cloneRepositoriesLoading ? 'Loading repositories...' : 'Refresh repositories'}
          meta="GitHub App access"
          loading={cloneRepositoriesLoading}
          disabled={setupActionLocked}
          onPress={() => {
            void loadCloneRepositoriesForSetup({ force: true });
          }}
        />
        <ChoiceAction
          variant="secondary"
          iconName="document-outline"
          title="Start fresh"
          meta="Empty workspace"
          disabled={setupActionLocked}
          onPress={() => {
            void handleStartFreshForSetup();
          }}
        />
      </>
    ) : setupStep === 'repositoryChoice' ? (
      <>
        <ChoiceAction
          variant="primary"
          iconName="git-branch-outline"
          title="Clone repository"
          meta="Bring an existing project"
          disabled={setupActionLocked}
          onPress={() => {
            void loadCloneRepositoriesForSetup();
          }}
        />
        <ChoiceAction
          variant="secondary"
          iconName="document-outline"
          title="Start fresh"
          meta="Empty workspace"
          disabled={setupActionLocked}
          onPress={() => {
            void handleStartFreshForSetup();
          }}
        />
      </>
    ) : setupStep === 'projectSetup' ? (
      <ChoiceAction
        variant="primary"
        iconName={selectedCloneRepository ? 'git-branch-outline' : 'folder-open-outline'}
        title={
          cloningRepositoryFullName
            ? 'Cloning repository...'
            : connectingCodespaceName
              ? 'Preparing workspace...'
              : 'Setting up project...'
        }
        meta={
          selectedCloneRepository?.fullName ??
          createdCodespace?.name ??
          activeCodespaceLabel ??
          'Codespace setup'
        }
        loading
        disabled
        onPress={() => {}}
      />
    ) : connectedProfileDraft ? (
      <ChoiceAction
        variant="primary"
        logo="clawdex"
        title="Start using Clawdex"
        meta={connectedProfileDraft.githubCodespaceName ?? connectedProfileDraft.name ?? undefined}
        disabled={setupActionLocked}
        onPress={() => {
          void completeConnectedFlow();
        }}
      />
    ) : pendingCodexLogin ? (
      <ChoiceAction
        variant="primary"
        iconName="log-in-outline"
        title={
          codexLoginSubmitting
            ? 'Log in with ChatGPT'
            : codexLoginChecking
              ? 'Checking login...'
              : codexLoginBrowserOpen
                ? 'Waiting for login...'
                : pendingCodexLogin.codexLoginUrl
                  ? 'Log in with ChatGPT'
                  : 'Log in with ChatGPT'
        }
        meta={pendingCodexLogin.profileDraft.githubCodespaceName ?? 'Codespace setup'}
        loading={codexLoginActionBusy}
        disabled={codexLoginActionBusy}
        onPress={() => {
          void openCodexManagedLogin(pendingCodexLogin);
        }}
      />
    ) : (
      <ChoiceAction
        variant="primary"
        iconName="time-outline"
        title="Waiting for Codex"
        meta={activeCodespaceLabel ?? 'Codespace setup'}
        disabled
        loading
        onPress={() => {}}
      />
    );
  const githubSetupScreen = (
    <View style={styles.githubOnboardingRoot}>
      <ScrollView
        style={styles.githubOnboardingScroll}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.githubOnboardingContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.githubHero}>
          <SetupMotionScene
            icon={setupScreen.icon}
            busy={setupActionLocked}
            styles={styles}
            theme={theme}
          />
          <Text style={styles.githubHeroTitle}>{setupScreen.title}</Text>
          <Text style={styles.githubHeroText}>{setupScreen.body}</Text>
        </View>

        {createdCodespace ? (
          <View style={styles.accountStrip}>
            <View style={styles.accountStripCopy}>
              <Text style={styles.accountStripLabel}>Codespace</Text>
              <Text style={styles.accountStripTitle}>{createdCodespace.name}</Text>
              <Text style={styles.accountStripMeta}>
                {createdCodespace.repositoryFullName ?? templateRepository?.fullName ?? 'Workspace'}
              </Text>
            </View>
          </View>
        ) : null}

        {setupStep === 'repositoryChoice' && repositoryChoice === 'clone' ? (
          <View style={styles.repositoryPickerPanel}>
            <View style={styles.repositoryPickerHeader}>
              <Text style={styles.repositoryPickerTitle}>Repositories</Text>
              <Text style={styles.repositoryPickerMeta}>
                {availableCloneRepositories.length > 0
                  ? `${availableCloneRepositories.length} available`
                  : 'Read/write access'}
              </Text>
            </View>
            {cloneRepositoriesLoading ? (
              <View style={styles.repositoryLoadingRow}>
                <ActivityIndicator size="small" color={theme.colors.textPrimary} />
                <Text style={styles.repositoryLoadingText}>Loading repositories...</Text>
              </View>
            ) : cloneRepositoriesError ? (
              <View style={styles.repositoryEmptyState}>
                <Ionicons name="alert-circle-outline" size={18} color={theme.colors.error} />
                <Text selectable style={styles.repositoryEmptyText}>
                  {cloneRepositoriesError}
                </Text>
              </View>
            ) : availableCloneRepositories.length === 0 ? (
              <View style={styles.repositoryEmptyState}>
                <Ionicons name="git-branch-outline" size={18} color={theme.colors.textMuted} />
                <Text style={styles.repositoryEmptyText}>
                  Tap refresh to load repositories this GitHub App can read and write.
                </Text>
              </View>
            ) : (
              <View style={styles.repositoryList}>
                {availableCloneRepositories.map((repository) => {
                  const cloningThisRepository =
                    cloningRepositoryFullName === repository.fullName;
                  return (
                    <Pressable
                      key={`${String(repository.installationId)}:${repository.fullName}`}
                      style={({ pressed }) => [
                        styles.repositoryRow,
                        pressed && !setupActionLocked ? styles.repositoryRowPressed : null,
                        selectedCloneRepository?.fullName === repository.fullName
                          ? styles.repositoryRowSelected
                          : null,
                      ]}
                      disabled={setupActionLocked}
                      onPress={() => {
                        void handleCloneRepositoryForSetup(repository);
                      }}
                    >
                      <View style={styles.repositoryIconWrap}>
                        {cloningThisRepository ? (
                          <ActivityIndicator size="small" color={theme.colors.textPrimary} />
                        ) : (
                          <Ionicons
                            name={repository.private ? 'lock-closed-outline' : 'git-branch-outline'}
                            size={20}
                            color={theme.colors.textPrimary}
                          />
                        )}
                      </View>
                      <View style={styles.repositoryRowCopy}>
                        <Text style={styles.repositoryRowTitle} numberOfLines={1}>
                          {repository.fullName}
                        </Text>
                        <Text style={styles.repositoryRowMeta}>
                          {repository.private ? 'Private repository' : 'Public repository'}
                        </Text>
                      </View>
                      <Ionicons name="arrow-forward" size={20} color={theme.colors.textPrimary} />
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>
        ) : null}

        {setupStatusMessage ? (
          <View style={styles.progressBanner}>
            {setupActionLocked ? (
              <ActivityIndicator size="small" color={theme.colors.textPrimary} />
            ) : (
              <Ionicons name="information-circle-outline" size={16} color={theme.colors.textPrimary} />
            )}
            <View style={styles.progressBannerCopy}>
              <Text style={styles.progressBannerTitle}>Status</Text>
              <Text style={styles.progressBannerText} numberOfLines={3}>
                {setupStatusMessage}
              </Text>
            </View>
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
      </ScrollView>

      <SafeAreaView edges={['bottom']} style={styles.githubDockSafe}>
        <BlurView intensity={70} tint={theme.blurTint} style={styles.githubBottomDock}>
          <View style={styles.githubChoiceFooter}>{setupActions}</View>
        </BlurView>
      </SafeAreaView>
    </View>
  );
  const shouldShowSetupFlow = githubConfigured && mode === 'setup';
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

        {shouldShowSetupFlow ? (
          githubSetupScreen
        ) : (
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
                Set `EXPO_PUBLIC_GITHUB_APP_CLIENT_ID` and
                `EXPO_PUBLIC_GITHUB_APP_AUTH_BASE_URL` in the mobile app build environment, then
                rebuild the app to enable direct Codespaces sign-in.
              </Text>
            </BlurView>
          ) : null}

          {githubConfigured ? (
            <BlurView
              intensity={55}
              tint={theme.blurTint}
              style={styles.card}
            >
              <View style={styles.stageIntro}>
                <View style={styles.stageIntroIcon}>
                  <Ionicons
                    name={stageIntro.icon}
                    size={22}
                    color={theme.colors.textPrimary}
                  />
                </View>
                <View style={styles.stageIntroCopy}>
                  <Text style={styles.stageIntroTitle}>{stageIntro.title}</Text>
                  <Text style={styles.stageIntroBody}>{stageIntro.body}</Text>
                </View>
              </View>

              {mode === 'manage' && onboardingStage === 'github' ? (
                <View style={styles.actionRow}>
                  <Pressable
                    onPress={() => {
                      void beginGitHubSignIn();
                    }}
                    disabled={authorizing || restoringSession}
                    style={({ pressed }) => [
                      styles.primaryButton,
                      (authorizing || restoringSession) && styles.codespaceButtonBusy,
                      pressed && !authorizing && !restoringSession && styles.primaryButtonPressed,
                    ]}
                  >
                    {authorizing || restoringSession ? (
                      <ActivityIndicator size="small" color={theme.colors.accentText} />
                    ) : (
                      <Ionicons name="logo-github" size={16} color={theme.colors.accentText} />
                    )}
                    <Text style={styles.primaryButtonText}>
                      {restoringSession
                        ? 'Checking GitHub...'
                        : authorizing
                          ? 'Opening GitHub...'
                          : 'Sign in with GitHub'}
                    </Text>
                  </Pressable>
                </View>
              ) : null}

              {onboardingStage === 'codespace' && session && !showGuidedCodespaceChoice ? (
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
                        disabled={codespaceActionsLocked}
                        style={({ pressed }) => [
                          styles.secondaryButton,
                          codespaceActionsLocked && styles.codespaceActionDisabled,
                          pressed && !codespaceActionsLocked && styles.secondaryButtonPressed,
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
              {onboardingStage === 'codespace' && codespacesError ? (
                <View style={styles.errorBanner}>
                  <Ionicons name="alert-circle-outline" size={16} color={theme.colors.error} />
                  <Text selectable style={styles.errorBannerText}>
                    {codespacesError}
                  </Text>
                </View>
              ) : null}
              {onboardingStage === 'codespace' && creatingCodespace ? (
                <View style={styles.progressBanner}>
                  <ActivityIndicator size="small" color={theme.colors.textPrimary} />
                  <View style={styles.progressBannerCopy}>
                    <Text style={styles.progressBannerTitle}>Creating Codespace</Text>
                    <Text style={styles.progressBannerText} numberOfLines={2}>
                      {creationMessage ?? creationTargetLabel ?? 'Preparing workspace'}
                    </Text>
                  </View>
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
              {recovery ? (
                <View style={styles.recoveryPanel}>
                  <View style={styles.recoveryIconWrap}>
                    <Ionicons name="construct-outline" size={16} color={theme.colors.textPrimary} />
                  </View>
                  <View style={styles.recoveryCopy}>
                    <Text style={styles.recoveryTitle}>{recovery.title}</Text>
                    <Text style={styles.recoveryText}>{recovery.body}</Text>
                  </View>
                </View>
              ) : null}

              {onboardingStage === 'codespace' && session ? (
                <>
                  {connectionProgressPanel}

                  {codespacesLoading ? (
                    <View style={styles.loadingRow}>
                      <ActivityIndicator color={theme.colors.textPrimary} />
                      <Text style={styles.cardBody}>Loading Codespaces…</Text>
                    </View>
                  ) : showGuidedCodespaceChoice && guidedCodespace ? (
                    <>
                      <View style={styles.reconnectPanel}>
                        <View style={styles.reconnectPanelCopy}>
                          <Text style={styles.reconnectPanelLabel}>
                            {savedCodespace ? 'Last connection' : 'Recommended'}
                          </Text>
                          <Text style={styles.reconnectPanelTitle}>{guidedCodespace.name}</Text>
                          <Text style={styles.reconnectPanelMeta}>
                            {formatCodespaceStatusHint(guidedCodespace)}
                          </Text>
                        </View>
                        <Pressable
                          onPress={() => {
                            void handleConnectCodespace(guidedCodespace);
                          }}
                          disabled={codespaceActionsLocked}
                          style={({ pressed }) => [
                            styles.reconnectButton,
                            pressed && !codespaceActionsLocked && styles.codespaceButtonPressed,
                            codespaceActionsLocked && styles.codespaceButtonBusy,
                          ]}
                        >
                          {connectingCodespaceName === guidedCodespace.name ? (
                            <ActivityIndicator size="small" color={theme.colors.accentText} />
                          ) : (
                            <Ionicons
                              name={
                                isCodespaceAvailable(guidedCodespace)
                                  ? 'flash-outline'
                                  : 'play-outline'
                              }
                              size={15}
                              color={theme.colors.accentText}
                            />
                          )}
                          <Text style={styles.codespacePrimaryActionText}>
                            {formatCodespacePrimaryActionLabel(guidedCodespace, {
                              bridgeRestarting:
                                restartingBridgeCodespaceName === guidedCodespace.name,
                              codespaceBusy: connectingCodespaceName === guidedCodespace.name,
                              codespaceDeleting: deletingCodespaceName === guidedCodespace.name,
                            })}
                          </Text>
                        </Pressable>
                      </View>
                      <View style={styles.actionRow}>
                        <Pressable
                          onPress={() => setCodespaceSelectionMode('list')}
                          disabled={codespaceActionsLocked}
                          style={({ pressed }) => [
                            styles.secondaryButton,
                            codespaceActionsLocked && styles.codespaceActionDisabled,
                            pressed && !codespaceActionsLocked && styles.secondaryButtonPressed,
                          ]}
                        >
                          <Ionicons
                            name="list-outline"
                            size={15}
                            color={theme.colors.textPrimary}
                          />
                          <Text style={styles.secondaryButtonText}>Choose another</Text>
                        </Pressable>
                        {createEnabled ? (
                          <Pressable
                            onPress={() => {
                              void handleCreateCodespace();
                            }}
                            disabled={codespaceActionsLocked}
                            style={({ pressed }) => [
                              styles.secondaryButton,
                              codespaceActionsLocked && styles.codespaceActionDisabled,
                              pressed && !codespaceActionsLocked && styles.secondaryButtonPressed,
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
                    </>
                  ) : codespaces.length > 0 ? (
                    <>
                      <View style={styles.cardHeadlineBlock}>
                        <Text style={styles.cardHeadline}>
                          {mode === 'manage' ? 'All Codespaces' : 'Your Codespaces'}
                        </Text>
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
                          const isSavedCodespace = savedCodespaceName === codespace.name;
                          const isCurrentCodespace = mode === 'manage' && isSavedCodespace;
                          const isSuggested =
                            isCurrentCodespace ||
                            (mode === 'setup' && isSavedCodespace) ||
                            (mode === 'setup' && suggestedCodespace?.name === codespace.name);
                          const canStopCodespace = isCodespaceAvailable(codespace);
                          const secondaryActionsVisible =
                            expandedCodespaceName === codespace.name ||
                            stopConfirmationVisible ||
                            deleteConfirmationVisible;
                          const actionLabel = isCurrentCodespace
                            ? 'Current'
                            : codespaceStopping
                              ? 'Pausing...'
                              : formatCodespacePrimaryActionLabel(codespace, {
                                  bridgeRestarting,
                                  codespaceBusy,
                                  codespaceDeleting,
                                });
                          const actionIcon = isCurrentCodespace
                            ? 'checkmark-circle-outline'
                            : canStopCodespace
                              ? 'flash-outline'
                              : 'play-outline';
                          const statusHint = formatCodespaceStatusHint(codespace);
                          const primaryActionDisabled =
                            codespaceActionsLocked || isCurrentCodespace;

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
                                {isCurrentCodespace ? (
                                  <View style={styles.codespaceBadgeRow}>
                                    <View
                                      style={[
                                        styles.codespaceTag,
                                        styles.codespaceTagRecommended,
                                      ]}
                                    >
                                      <Text
                                        style={[
                                          styles.codespaceTagText,
                                          styles.codespaceTagTextRecommended,
                                        ]}
                                      >
                                        Current
                                      </Text>
                                    </View>
                                  </View>
                                ) : null}
                                <View style={styles.codespacesCardHeader}>
                                  <View style={styles.codespacesCardCopy}>
                                    <Text style={styles.codespaceCardTitle}>{codespace.name}</Text>
                                    <Text style={styles.codespaceRepository}>
                                      {codespace.repositoryFullName ?? 'Unknown repository'}
                                    </Text>
                                    <Text style={styles.codespaceHint}>
                                      {isCurrentCodespace
                                        ? 'Currently used by Clawdex. '
                                        : isSavedCodespace
                                          ? 'Last connected. '
                                          : ''}
                                      {statusHint}
                                    </Text>
                                  </View>
                                  <View style={styles.codespaceStatePill}>
                                    <Text style={styles.codespaceStateText}>
                                      {codespaceStopping
                                        ? 'Pausing'
                                        : codespaceDeleting
                                          ? 'Deleting'
                                          : formatCodespaceStatus(codespace)}
                                    </Text>
                                  </View>
                                </View>
                              </View>

                              <View style={styles.codespaceCardFooter}>
                                <Pressable
                                  onPress={() => {
                                    if (!isCurrentCodespace) {
                                      void handleConnectCodespace(codespace);
                                    }
                                  }}
                                  disabled={primaryActionDisabled}
                                  style={({ pressed }) => [
                                    styles.codespacePrimaryAction,
                                    (codespaceBusy ||
                                      codespaceStopping ||
                                      codespaceDeleting ||
                                      bridgeRestarting ||
                                      primaryActionDisabled) &&
                                      styles.codespaceButtonBusy,
                                    isCurrentCodespace && styles.codespaceCurrentAction,
                                    pressed &&
                                      !primaryActionDisabled &&
                                      styles.codespaceButtonPressed,
                                  ]}
                                >
                                  {codespaceBusy || codespaceStopping || codespaceDeleting || bridgeRestarting ? (
                                    <ActivityIndicator size="small" color={theme.colors.accentText} />
                                  ) : (
                                    <Ionicons
                                      name={actionIcon}
                                      size={15}
                                      color={
                                        isCurrentCodespace
                                          ? theme.colors.statusComplete
                                          : theme.colors.accentText
                                      }
                                    />
                                  )}
                                  <Text
                                    style={[
                                      styles.codespacePrimaryActionText,
                                      isCurrentCodespace &&
                                        styles.codespaceCurrentActionText,
                                    ]}
                                  >
                                    {actionLabel}
                                  </Text>
                                </Pressable>
                                <Pressable
                                  onPress={() => {
                                    setExpandedCodespaceName((current) =>
                                      current === codespace.name ? null : codespace.name
                                    );
                                  }}
                                  disabled={codespaceActionsLocked}
                                  style={({ pressed }) => [
                                    styles.codespaceMoreAction,
                                    codespaceActionsLocked && styles.codespaceActionDisabled,
                                    pressed && !codespaceActionsLocked && styles.secondaryButtonPressed,
                                  ]}
                                >
                                  <Text style={styles.codespaceSecondaryActionText}>Options</Text>
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
                                        disabled={codespaceActionsLocked}
                                        style={({ pressed }) => [
                                          styles.codespaceSecondaryAction,
                                          codespaceActionsLocked && styles.codespaceActionDisabled,
                                          pressed &&
                                            !codespaceActionsLocked &&
                                            styles.secondaryButtonPressed,
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
                                          void handleRestartCodespaceBridge(codespace);
                                        }}
                                        disabled={codespaceActionsLocked}
                                        style={({ pressed }) => [
                                          styles.codespaceSecondaryAction,
                                          codespaceActionsLocked && styles.codespaceActionDisabled,
                                          pressed &&
                                            !codespaceActionsLocked &&
                                            styles.secondaryButtonPressed,
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
                                          Restart Clawdex
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
                                        disabled={codespaceActionsLocked}
                                        style={({ pressed }) => [
                                          styles.codespaceStopAction,
                                          codespaceActionsLocked && styles.codespaceActionDisabled,
                                          pressed &&
                                            !codespaceActionsLocked &&
                                            styles.codespaceStopActionPressed,
                                        ]}
                                      >
                                        <Ionicons
                                          name="stop-circle-outline"
                                          size={14}
                                          color={theme.colors.error}
                                        />
                                        <Text style={styles.codespaceStopActionText}>Pause</Text>
                                      </Pressable>
                                    ) : null}
                                    <Pressable
                                      onPress={() => {
                                        setPendingStopCodespaceName(null);
                                        setPendingDeleteCodespaceName((current) =>
                                          current === codespace.name ? null : codespace.name
                                        );
                                      }}
                                      disabled={codespaceActionsLocked}
                                      style={({ pressed }) => [
                                        styles.codespaceStopAction,
                                        codespaceActionsLocked && styles.codespaceActionDisabled,
                                        pressed &&
                                          !codespaceActionsLocked &&
                                          styles.codespaceStopActionPressed,
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
                                      Pause this Codespace?
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
                                        disabled={codespaceActionsLocked}
                                        style={({ pressed }) => [
                                          styles.codespaceStopConfirmButton,
                                          pressed &&
                                            !codespaceActionsLocked &&
                                            styles.codespaceStopConfirmButtonPressed,
                                          codespaceActionsLocked && styles.codespaceButtonBusy,
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
                                          Pause Codespace
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
                                        disabled={codespaceActionsLocked}
                                        style={({ pressed }) => [
                                          styles.codespaceStopConfirmButton,
                                          pressed &&
                                            !codespaceActionsLocked &&
                                            styles.codespaceStopConfirmButtonPressed,
                                          codespaceActionsLocked && styles.codespaceButtonBusy,
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
                          : 'Configure the Clawdex template repository in this build to continue.'}
                      </Text>
                      {createEnabled ? (
                        <Pressable
                          onPress={() => {
                            void handleCreateCodespace();
                          }}
                          disabled={codespaceActionsLocked}
                          style={({ pressed }) => [
                            styles.primaryButton,
                            codespaceActionsLocked && styles.codespaceButtonBusy,
                            pressed && !codespaceActionsLocked && styles.primaryButtonPressed,
                          ]}
                        >
                          {creatingCodespace ? (
                            <ActivityIndicator size="small" color={theme.colors.accentText} />
                          ) : (
                            <Ionicons name="rocket-outline" size={16} color={theme.colors.accentText} />
                          )}
                          <Text style={styles.primaryButtonText}>Create Codespace</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  )}

                  {!connectionStatusVisible ? (
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
                        <Ionicons
                          name="refresh-outline"
                          size={15}
                          color={theme.colors.textPrimary}
                        />
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
                  ) : null}

                </>
              ) : null}

              {onboardingStage === 'success' && connectedProfileDraft ? (
                <View style={styles.actionRow}>
                  <Pressable
                    onPress={() => {
                      void completeConnectedFlow();
                    }}
                    style={({ pressed }) => [
                      styles.primaryButton,
                      pressed && styles.primaryButtonPressed,
                    ]}
                  >
                    <Ionicons name="arrow-forward-outline" size={16} color={theme.colors.accentText} />
                    <Text style={styles.primaryButtonText}>Start using Clawdex</Text>
                  </Pressable>
                </View>
              ) : null}

            </BlurView>
          ) : null}
        </ScrollView>
        )}
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
  task: (api: HostBridgeApiClient) => Promise<T>,
  options: { requestTimeoutMs?: number } = {}
): Promise<T> {
  const ws = new HostBridgeWsClient(bridgeUrl, {
    authToken: accessToken,
    allowQueryTokenAuth: env.allowWsQueryTokenAuth,
    requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
  });
  const api = new HostBridgeApiClient({ ws });

  try {
    return await task(api);
  } finally {
    ws.disconnect();
  }
}

function isCodexAccountReady(account: AccountSnapshot): boolean {
  return account.type !== null || !account.requiresOpenaiAuth;
}

async function waitForCodexAccountReady(
  api: HostBridgeApiClient,
  timeoutMs: number
): Promise<AccountSnapshot> {
  const startedAt = Date.now();
  let latestAccount: AccountSnapshot | null = null;
  let lastError: Error | null = null;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const account = await api.readAccount({ refreshToken: true });
      latestAccount = account;
      lastError = null;
      if (isCodexAccountReady(account)) {
        return account;
      }
    } catch (error) {
      lastError = error as Error;
    }

    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(CODEX_ACCOUNT_READY_POLL_MS, remainingMs));
  }

  if (latestAccount) {
    return latestAccount;
  }

  throw lastError ?? new Error('Login status could not be checked.');
}

async function startManagedCodexLogin(
  api: HostBridgeApiClient
): Promise<AccountLoginStartResponse> {
  try {
    return await api.startChatGptAccountLogin();
  } catch (error) {
    const message = String((error as Error)?.message ?? error).toLowerCase();
    if (
      !message.includes('unsupported') &&
      !message.includes('unknown') &&
      !message.includes('invalid')
    ) {
      throw error;
    }
  }

  return api.startChatGptDeviceCodeAccountLogin();
}

function readManagedCodexLoginDetails(response: AccountLoginStartResponse): {
  kind: ManagedCodexLoginKind;
  loginId: string;
  url: string;
  userCode: string | null;
} {
  if (response.type === 'chatgptDeviceCode') {
    return {
      kind: 'device',
      loginId: response.loginId,
      url: response.verificationUrl,
      userCode: response.userCode,
    };
  }

  if (response.type === 'chatgpt') {
    return {
      kind: 'web',
      loginId: response.loginId,
      url: response.authUrl,
      userCode: response.userCode ?? null,
    };
  }

  throw new Error('Codex did not return a ChatGPT login URL.');
}

function formatCodexManagedLoginInstruction(userCode: string | null): string {
  if (userCode) {
    return `Enter ${userCode} in ChatGPT to continue.`;
  }

  return 'Log in with ChatGPT to continue.';
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
      if (isCodespacesTunnelAuthResponse(healthResponse, bridgeUrl)) {
        throw new Error(CODESPACES_PRIVATE_PORT_ERROR);
      }
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

function isCodespacesTunnelAuthResponse(response: Response, bridgeUrl: string): boolean {
  const responseUrl = typeof response.url === 'string' ? response.url : '';
  const location = response.headers.get('location') ?? '';
  if (responseUrl.includes('/pf-signin') || location.includes('/pf-signin')) {
    return true;
  }

  if (!responseUrl) {
    return false;
  }

  try {
    const expectedHost = new URL(bridgeUrl).host;
    const actualHost = new URL(responseUrl).host;
    return (
      expectedHost.endsWith('.app.github.dev') &&
      actualHost.length > 0 &&
      actualHost !== expectedHost &&
      actualHost.endsWith('github.dev')
    );
  } catch {
    return false;
  }
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

function isCodespacePaused(codespace: Pick<GitHubCodespace, 'state'>): boolean {
  const normalized = codespace.state.trim().toLowerCase();
  return normalized === 'shutdown' || normalized === 'stopped';
}

function formatCodespacePrimaryActionLabel(
  codespace: Pick<GitHubCodespace, 'state'>,
  options: {
    bridgeRestarting: boolean;
    codespaceBusy: boolean;
    codespaceDeleting: boolean;
  }
): string {
  if (options.codespaceDeleting) {
    return 'Deleting...';
  }
  if (options.bridgeRestarting) {
    return 'Restarting...';
  }
  if (options.codespaceBusy && isCodespacePaused(codespace)) {
    return 'Starting...';
  }
  if (options.codespaceBusy) {
    return 'Connecting...';
  }
  if (isCodespaceAvailable(codespace)) {
    return 'Use this';
  }
  if (isCodespacePaused(codespace)) {
    return 'Start and use';
  }
  return 'Use when ready';
}

function formatCodespaceStatus(codespace: Pick<GitHubCodespace, 'state'>): string {
  return isCodespaceAvailable(codespace) ? 'Ready' : formatCodespaceState(codespace.state);
}

function formatCodespaceStatusHint(codespace: Pick<GitHubCodespace, 'state'>): string {
  if (isCodespaceAvailable(codespace)) {
    return 'Ready to connect.';
  }
  if (isCodespacePaused(codespace)) {
    return 'Paused by GitHub. Starting it can take a few minutes.';
  }

  const state = formatCodespaceState(codespace.state);
  return `${state}. Clawdex will wait until GitHub finishes.`;
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

function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutTask = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  return Promise.race([task, timeoutTask]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

const createStyles = (theme: AppTheme) => {
  const cardBackground = theme.colors.bgCanvasAccent;
  const cardBorder = theme.colors.borderHighlight;
  const secondaryBackground = theme.colors.bgInput;
  const secondaryPressed = theme.colors.bgItem;

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
      letterSpacing: 0,
    },
    headerTitle: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
    },
    scroll: {
      flex: 1,
    },
    content: {
      flexGrow: 1,
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
      letterSpacing: 0,
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
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgElevated,
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
      backgroundColor: theme.colors.bgInput,
    },
    heroStepActive: {
      borderColor: theme.colors.textPrimary,
      backgroundColor: theme.colors.bgItem,
    },
    heroStepDone: {
      borderColor: theme.colors.successBorder,
      backgroundColor: theme.colors.successBg,
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
    githubOnboardingRoot: {
      flex: 1,
    },
    githubOnboardingScroll: {
      flex: 1,
    },
    githubOnboardingContent: {
      flexGrow: 1,
      justifyContent: 'center',
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.lg,
      paddingBottom: theme.spacing.lg,
      gap: theme.spacing.lg,
    },
    githubHero: {
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    githubHeroIconWrap: {
      width: 44,
      height: 44,
      borderRadius: 15,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: secondaryBackground,
      alignItems: 'center',
      justifyContent: 'center',
    },
    githubHeroTitle: {
      ...theme.typography.largeTitle,
      color: theme.colors.textPrimary,
      fontSize: 22,
      lineHeight: 28,
      textAlign: 'center',
    },
    githubHeroText: {
      ...theme.typography.body,
      color: theme.colors.textSecondary,
      fontSize: 13,
      lineHeight: 19,
      textAlign: 'center',
    },
    setupMotionScene: {
      width: 176,
      height: 132,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: theme.spacing.xs,
    },
    setupMotionPulseFrame: {
      position: 'absolute',
      top: 14,
      width: 92,
      height: 92,
      borderRadius: 28,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgInput,
    },
    setupMotionBackplate: {
      position: 'absolute',
      top: 25,
      width: 72,
      height: 72,
      borderRadius: 24,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: theme.colors.bgItem,
      opacity: 0.72,
      transform: [{ rotate: '45deg' }],
    },
    setupMotionBridgeLine: {
      position: 'absolute',
      top: 74,
      width: 2,
      height: 54,
      borderRadius: 999,
      backgroundColor: theme.colors.borderLight,
      overflow: 'hidden',
    },
    setupMotionBridgeSignal: {
      width: 2,
      height: 18,
      borderRadius: 999,
      backgroundColor: theme.colors.textPrimary,
    },
    setupMotionIconWrap: {
      position: 'absolute',
      top: 20,
      width: 64,
      height: 64,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: secondaryBackground,
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: theme.isDark
        ? '0px 14px 32px rgba(0, 0, 0, 0.28)'
        : '0px 12px 26px rgba(15, 31, 54, 0.12)',
    },
    setupMotionCard: {
      position: 'absolute',
      bottom: 0,
      width: 128,
      height: 40,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: theme.colors.bgElevated,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      gap: 5,
    },
    setupMotionCardHeader: {
      width: 28,
      height: 4,
      borderRadius: 999,
      backgroundColor: theme.colors.textPrimary,
      opacity: 0.58,
    },
    setupMotionCardLineWide: {
      width: 78,
      height: 3,
      borderRadius: 999,
      backgroundColor: theme.colors.textMuted,
      opacity: 0.4,
    },
    setupMotionCardLineShort: {
      width: 48,
      height: 3,
      borderRadius: 999,
      backgroundColor: theme.colors.textMuted,
      opacity: 0.28,
    },
    githubStepsSection: {
      gap: theme.spacing.md,
    },
    githubStepsHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing.md,
    },
    githubStepsEyebrow: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0,
      fontWeight: '700',
    },
    githubStepDots: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
    },
    githubStepDot: {
      width: 6,
      height: 6,
      borderRadius: 999,
      backgroundColor: theme.colors.textMuted,
      opacity: 0.34,
    },
    githubStepDotActive: {
      width: 18,
      opacity: 0.9,
      backgroundColor: theme.colors.textPrimary,
    },
    githubStepPanel: {
      minHeight: 210,
      borderRadius: 24,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: cardBackground,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.xl,
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.md,
      boxShadow: theme.isDark
        ? '0px 12px 26px rgba(0, 0, 0, 0.18)'
        : '0px 10px 24px rgba(15, 31, 54, 0.08)',
    },
    githubStepIconLarge: {
      width: 58,
      height: 58,
      borderRadius: 19,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: secondaryBackground,
      alignItems: 'center',
      justifyContent: 'center',
    },
    githubStepTitleLarge: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
      fontWeight: '700',
      fontSize: 20,
      textAlign: 'center',
    },
    githubStepBodyLarge: {
      ...theme.typography.body,
      color: theme.colors.textSecondary,
      fontSize: 15,
      lineHeight: 21,
      textAlign: 'center',
    },
    githubDockSafe: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: cardBorder,
      backgroundColor: theme.colors.bgMain,
    },
    githubBottomDock: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.sm,
      paddingBottom: theme.spacing.sm,
      overflow: 'hidden',
    },
    githubChoiceFooter: {
      gap: theme.spacing.sm,
    },
    cardTitle: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      textTransform: 'uppercase',
      letterSpacing: 0,
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
      backgroundColor: theme.colors.bgInput,
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
      letterSpacing: 0,
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
      borderColor: theme.colors.errorBorder,
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
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgInput,
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
    repositoryPickerPanel: {
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: theme.colors.bgItem,
      padding: theme.spacing.sm,
      gap: theme.spacing.sm,
    },
    repositoryPickerHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: theme.spacing.xs,
      gap: theme.spacing.md,
    },
    repositoryPickerTitle: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 0,
    },
    repositoryPickerMeta: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
    },
    repositoryList: {
      gap: theme.spacing.xs,
    },
    repositoryRow: {
      minHeight: 64,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgInput,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    repositoryRowPressed: {
      opacity: 0.72,
    },
    repositoryRowSelected: {
      borderColor: theme.colors.textPrimary,
    },
    repositoryIconWrap: {
      width: 40,
      height: 40,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: secondaryBackground,
      alignItems: 'center',
      justifyContent: 'center',
    },
    repositoryRowCopy: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    repositoryRowTitle: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
    repositoryRowMeta: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
    },
    repositoryLoadingRow: {
      minHeight: 72,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgInput,
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
      gap: theme.spacing.sm,
    },
    repositoryLoadingText: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
    },
    repositoryEmptyState: {
      minHeight: 78,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgInput,
      padding: theme.spacing.md,
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
      gap: theme.spacing.sm,
    },
    repositoryEmptyText: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      flex: 1,
      lineHeight: 18,
    },
    recoveryPanel: {
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.warningBorder,
      backgroundColor: theme.colors.warningBg,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.spacing.sm,
    },
    recoveryIconWrap: {
      width: 28,
      height: 28,
      borderRadius: 999,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.bgInput,
    },
    recoveryCopy: {
      flex: 1,
      gap: 2,
    },
    recoveryTitle: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
    recoveryText: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      lineHeight: 18,
    },
    repoSummaryRow: {
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: theme.colors.bgItem,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      gap: 4,
    },
    repoSummaryLabel: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0,
    },
    repoSummaryValue: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      lineHeight: 18,
    },
    stageIntro: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.spacing.md,
    },
    stageIntroIcon: {
      width: 44,
      height: 44,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: theme.colors.bgInput,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stageIntroCopy: {
      flex: 1,
      minWidth: 0,
      gap: 4,
    },
    stageIntroTitle: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
    },
    stageIntroBody: {
      ...theme.typography.body,
      color: theme.colors.textSecondary,
      lineHeight: 21,
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
      backgroundColor: theme.colors.bgItem,
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
      letterSpacing: 0,
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
    reconnectPanel: {
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.successBorder,
      backgroundColor: theme.colors.successBg,
      padding: theme.spacing.md,
      gap: theme.spacing.md,
    },
    reconnectPanelCopy: {
      gap: 3,
    },
    reconnectPanelLabel: {
      ...theme.typography.caption,
      color: theme.colors.statusComplete,
      textTransform: 'uppercase',
      letterSpacing: 0,
      fontWeight: '700',
    },
    reconnectPanelTitle: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
    reconnectPanelMeta: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      lineHeight: 18,
    },
    reconnectButton: {
      minHeight: 42,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.accent,
      paddingHorizontal: theme.spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.xs,
    },
    stagePanel: {
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: theme.colors.bgItem,
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
      letterSpacing: 0,
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
    actionRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.sm,
    },
    primaryButton: {
      minHeight: 44,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.accent,
      paddingHorizontal: theme.spacing.lg,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.xs,
    },
    primaryButtonPressed: {
      backgroundColor: theme.colors.accentPressed,
    },
    primaryButtonText: {
      ...theme.typography.caption,
      color: theme.colors.accentText,
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
      borderColor: theme.colors.errorBorder,
      backgroundColor: theme.colors.errorBg,
    },
    ghostButtonDangerPressed: {
      backgroundColor: theme.colors.errorBg,
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
      letterSpacing: 0,
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
      backgroundColor: theme.colors.bgItem,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    deviceCodeStatusRowActive: {
      borderColor: theme.colors.successBorder,
      backgroundColor: theme.colors.successBg,
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
      backgroundColor: theme.colors.bgInput,
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
      letterSpacing: 0,
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
      backgroundColor: theme.colors.bgItem,
      padding: theme.spacing.md,
      gap: theme.spacing.md,
    },
    codespaceCardRecommended: {
      borderColor: theme.colors.successBorder,
      backgroundColor: theme.colors.successBg,
      boxShadow: theme.isDark
        ? '0px 10px 24px rgba(0, 0, 0, 0.16)'
        : '0px 8px 20px rgba(15, 31, 54, 0.08)',
    },
    codespaceCardDeleting: {
      borderColor: theme.colors.errorBorder,
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
      backgroundColor: theme.colors.successBg,
    },
    codespaceTagDefault: {
      backgroundColor: theme.colors.bgInput,
    },
    codespaceTagText: {
      ...theme.typography.caption,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 0,
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
      backgroundColor: theme.colors.bgInput,
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
      backgroundColor: theme.colors.accent,
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
    codespaceCurrentAction: {
      backgroundColor: theme.colors.successBg,
      borderWidth: 1,
      borderColor: theme.colors.successBorder,
    },
    codespacePrimaryActionText: {
      ...theme.typography.caption,
      color: theme.colors.accentText,
      fontWeight: '700',
    },
    codespaceCurrentActionText: {
      color: theme.colors.statusComplete,
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
      borderColor: theme.colors.errorBorder,
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
      borderColor: theme.colors.errorBorder,
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
      borderColor: theme.colors.successBorder,
      backgroundColor: theme.colors.successBg,
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
