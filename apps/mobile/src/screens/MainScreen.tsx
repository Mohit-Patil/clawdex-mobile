import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type ListRenderItem,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { HostBridgeApiClient } from '../api/client';
import { readAccountRateLimitSnapshot } from '../api/rateLimits';
import type {
  AccountRateLimitSnapshot,
  ApprovalMode,
  ApprovalPolicy,
  ApprovalDecision,
  CollaborationMode,
  PendingApproval,
  PendingUserInputRequest,
  RpcNotification,
  RunEvent,
  Chat,
  ChatSummary,
  ModelOption,
  MentionInput,
  LocalImageInput,
  ReasoningEffort,
  ServiceTier,
  TurnPlanStep,
  ChatMessage as ChatTranscriptMessage,
} from '../api/types';
import type { HostBridgeWsClient } from '../api/ws';
import { ActivityBar, type ActivityTone } from '../components/ActivityBar';
import { ApprovalBanner } from '../components/ApprovalBanner';
import { ChatHeader } from '../components/ChatHeader';
import { ChatInput } from '../components/ChatInput';
import { ChatMessage } from '../components/ChatMessage';
import { ToolBlock } from '../components/ToolBlock';
import { ComposerUsageLimits } from '../components/ComposerUsageLimits';
import { BrandMark } from '../components/BrandMark';
import { SelectionSheet, type SelectionSheetOption } from '../components/SelectionSheet';
import { buildComposerUsageLimitBadges } from '../components/usageLimitBadges';
import { env } from '../config';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder';
import { getVisibleTranscriptMessages } from './transcriptMessages';
import { colors, spacing, typography } from '../theme';

export interface MainScreenHandle {
  openChat: (id: string, optimisticChat?: Chat | null) => void;
  startNewChat: () => void;
}

interface MainScreenProps {
  api: HostBridgeApiClient;
  ws: HostBridgeWsClient;
  bridgeUrl: string;
  bridgeToken?: string | null;
  onOpenDrawer: () => void;
  onOpenGit: (chat: Chat) => void;
  defaultStartCwd?: string | null;
  defaultModelId?: string | null;
  defaultReasoningEffort?: ReasoningEffort | null;
  approvalMode?: ApprovalMode;
  showToolCalls?: boolean;
  onDefaultStartCwdChange?: (cwd: string | null) => void;
  onChatContextChange?: (chat: Chat | null) => void;
  pendingOpenChatId?: string | null;
  pendingOpenChatSnapshot?: Chat | null;
  onPendingOpenChatHandled?: () => void;
}

const SUGGESTIONS = [
  'Explain the current codebase structure',
  'Write tests for the main module',
];

interface ActivityState {
  tone: ActivityTone;
  title: string;
  detail?: string;
}

interface ActivePlanState {
  threadId: string;
  turnId: string;
  explanation: string | null;
  steps: TurnPlanStep[];
  deltaText: string;
  updatedAt: string;
}

interface PendingPlanImplementationPrompt {
  threadId: string;
  turnId: string;
}

interface ThreadContextUsage {
  totalTokens: number | null;
  lastTokens: number | null;
  modelContextWindow: number | null;
  updatedAtMs: number;
}

interface ThreadRuntimeSnapshot {
  activity?: ActivityState;
  activeCommands?: RunEvent[];
  streamingText?: string | null;
  pendingApproval?: PendingApproval | null;
  pendingUserInputRequest?: PendingUserInputRequest | null;
  contextUsage?: ThreadContextUsage | null;
  plan?: ActivePlanState | null;
  activeTurnId?: string | null;
  runWatchdogUntil?: number;
  updatedAtMs: number;
}

interface ComposerAttachmentChip {
  id: string;
  label: string;
}

interface QueuedChatMessage {
  id: string;
  createdAt: string;
  content: string;
  mentions: MentionInput[];
  localImages: LocalImageInput[];
  collaborationMode: CollaborationMode;
}

interface AutoScrollState {
  shouldStickToBottom: boolean;
  isUserInteracting: boolean;
  isMomentumScrolling: boolean;
}

interface SlashCommandDefinition {
  name: string;
  summary: string;
  argsHint?: string;
  mobileSupported: boolean;
  aliases?: string[];
  availabilityNote?: string;
}

const MAX_ACTIVE_COMMANDS = 16;
const MAX_VISIBLE_TOOL_BLOCKS = 6;
const RUN_WATCHDOG_MS = 60_000;
const LARGE_CHAT_MESSAGE_COUNT_THRESHOLD = 120;
const CHAT_INITIAL_VISIBLE_MESSAGE_WINDOW = 80;
const CHAT_MESSAGE_PAGE_SIZE = 80;
const LIKELY_RUNNING_RECENT_UPDATE_MS = 30_000;
const UNANSWERED_USER_RUNNING_TTL_MS = 90_000;
const ACTIVE_CHAT_SYNC_INTERVAL_MS = 2_000;
const IDLE_CHAT_SYNC_INTERVAL_MS = 2_500;
const CONTEXT_WINDOW_BASELINE_TOKENS = 5_000;
const CHAT_MODEL_PREFERENCES_FILE = 'chat-model-preferences.json';
const CHAT_MODEL_PREFERENCES_VERSION = 1;
const CHAT_PLAN_SNAPSHOTS_FILE = 'chat-plan-snapshots.json';
const CHAT_PLAN_SNAPSHOTS_VERSION = 1;
const PLAN_IMPLEMENTATION_TITLE = 'Implement this plan?';
const PLAN_IMPLEMENTATION_YES = 'Yes, implement this plan';
const PLAN_IMPLEMENTATION_NO = 'No, stay in Plan mode';
const PLAN_IMPLEMENTATION_CODING_MESSAGE = 'Implement the plan.';
const INLINE_OPTION_LINE_PATTERN =
  /^(?:[-*+]\s*)?(?:\d{1,2}\s*[.):-]|\(\d{1,2}\)\s*[.):-]?|\[\d{1,2}\]\s*|[A-Ca-c]\s*[.):-]|\([A-Ca-c]\)\s*[.):-]?|option\s+\d{1,2}\s*[.):-]?)\s*(.+)$/i;
const INLINE_CHOICE_CUE_PATTERNS = [
  /\bchoose\b/i,
  /\bselect\b/i,
  /\bpick\b/i,
  /\bwould you like\b/i,
  /\bshould i\b/i,
  /\bprefer\b/i,
  /\bconfirm\b/i,
  /\b(?:reply|respond)\s+with\b/i,
  /\blet me know\b.*\b(which|what|option|one)\b/i,
  /\bwhich\b.*\b(option|one)\b/i,
  /\bwhat\b.*\b(option|one)\b/i,
];
const CODEX_RUN_HEARTBEAT_EVENT_TYPES = new Set([
  'taskstarted',
  'agentreasoningdelta',
  'reasoningcontentdelta',
  'reasoningrawcontentdelta',
  'agentreasoningrawcontentdelta',
  'agentreasoningsectionbreak',
  'agentmessagedelta',
  'agentmessagecontentdelta',
  'execcommandbegin',
  'execcommandend',
  'mcpstartupupdate',
  'mcptoolcallbegin',
  'websearchbegin',
  'backgroundevent',
]);
const CODEX_RUN_COMPLETION_EVENT_TYPES = new Set(['taskcomplete']);
const CODEX_RUN_ABORT_EVENT_TYPES = new Set([
  'turnaborted',
  'taskinterrupted',
]);
const CODEX_RUN_FAILURE_EVENT_TYPES = new Set([
  'taskfailed',
  'turnfailed',
]);
const EXTERNAL_RUNNING_STATUS_HINTS = new Set([
  'running',
  'inprogress',
  'active',
  'queued',
  'pending',
]);
const EXTERNAL_ERROR_STATUS_HINTS = new Set([
  'failed',
  'error',
  'interrupted',
  'aborted',
]);
const EXTERNAL_COMPLETE_STATUS_HINTS = new Set([
  'complete',
  'completed',
  'success',
  'succeeded',
]);

interface ChatModelPreference {
  modelId: string | null;
  effort: ReasoningEffort | null;
  serviceTier: ServiceTier | null;
  updatedAt: string;
}

const SLASH_COMMANDS: SlashCommandDefinition[] = [
  {
    name: 'permissions',
    summary: 'Set approvals and sandbox permissions',
    mobileSupported: false,
    availabilityNote: 'Available in Codex CLI only right now.',
  },
  {
    name: 'sandbox-add-read-dir',
    summary: 'Grant sandbox read access to extra directory',
    argsHint: '<absolute-path>',
    mobileSupported: false,
    availabilityNote: 'Windows Codex CLI only.',
  },
  {
    name: 'agent',
    summary: 'Switch the active sub-agent thread',
    mobileSupported: false,
    availabilityNote: 'Available in Codex CLI only right now.',
  },
  {
    name: 'apps',
    summary: 'Browse and insert apps/connectors',
    mobileSupported: false,
    availabilityNote: 'Available in Codex CLI only right now.',
  },
  {
    name: 'compact',
    summary: 'Compact current thread history',
    mobileSupported: true,
  },
  {
    name: 'diff',
    summary: 'Open Git view for current chat',
    mobileSupported: true,
  },
  {
    name: 'exit',
    summary: 'Exit Codex CLI',
    mobileSupported: false,
    availabilityNote: 'Not applicable on mobile.',
  },
  {
    name: 'experimental',
    summary: 'Toggle experimental features',
    mobileSupported: false,
    availabilityNote: 'Available in Codex CLI only right now.',
  },
  {
    name: 'feedback',
    summary: 'Send feedback diagnostics',
    mobileSupported: false,
    availabilityNote: 'Available in Codex CLI only right now.',
  },
  {
    name: 'init',
    summary: 'Generate AGENTS.md scaffold',
    mobileSupported: false,
    availabilityNote: 'Available in Codex CLI only right now.',
  },
  {
    name: 'logout',
    summary: 'Sign out from Codex',
    mobileSupported: false,
    availabilityNote: 'Available in Codex CLI only right now.',
  },
  {
    name: 'mcp',
    summary: 'List configured MCP tools',
    mobileSupported: false,
    availabilityNote: 'Available in Codex CLI only right now.',
  },
  {
    name: 'mention',
    summary: 'Attach file/folder context to prompt',
    argsHint: '<path>',
    mobileSupported: false,
    availabilityNote: 'Available in Codex CLI only right now.',
  },
  {
    name: 'model',
    summary: 'Open model picker or set model by id',
    argsHint: '<model-id>',
    mobileSupported: true,
  },
  {
    name: 'plan',
    summary: 'Toggle plan mode or run next prompt in plan mode',
    argsHint: '[prompt]',
    mobileSupported: true,
  },
  {
    name: 'personality',
    summary: 'Set response personality',
    argsHint: '<friendly|pragmatic|none>',
    mobileSupported: false,
    availabilityNote: 'Available in Codex CLI only right now.',
  },
  {
    name: 'ps',
    summary: 'Show background terminal jobs',
    mobileSupported: false,
    availabilityNote: 'Available in Codex CLI only right now.',
  },
  {
    name: 'fork',
    summary: 'Fork current conversation into a new chat',
    mobileSupported: true,
  },
  {
    name: 'resume',
    summary: 'Resume a saved conversation',
    mobileSupported: false,
    availabilityNote: 'Use chat list on mobile for now.',
  },
  {
    name: 'new',
    summary: 'Start a new conversation',
    mobileSupported: true,
  },
  {
    name: 'quit',
    summary: 'Exit Codex CLI',
    mobileSupported: false,
    aliases: ['exit'],
    availabilityNote: 'Not applicable on mobile.',
  },
  {
    name: 'review',
    summary: 'Run review on uncommitted changes',
    mobileSupported: true,
  },
  {
    name: 'status',
    summary: 'Show current session status',
    mobileSupported: true,
  },
  {
    name: 'debug-config',
    summary: 'Inspect config layers and diagnostics',
    mobileSupported: false,
    availabilityNote: 'Available in Codex CLI only right now.',
  },
  {
    name: 'statusline',
    summary: 'Configure footer status-line fields',
    mobileSupported: false,
    availabilityNote: 'Available in Codex CLI only right now.',
  },
  {
    name: 'approvals',
    summary: 'Alias for /permissions',
    mobileSupported: false,
    aliases: ['permissions'],
    availabilityNote: 'Alias supported in CLI; use /permissions there.',
  },
  {
    name: 'help',
    summary: 'List slash commands',
    mobileSupported: true,
  },
  {
    name: 'rename',
    summary: 'Rename current chat',
    argsHint: '<new-name>',
    mobileSupported: true,
  },
];

export const MainScreen = forwardRef<MainScreenHandle, MainScreenProps>(
  function MainScreen(
    {
      api,
      ws,
      bridgeUrl,
      bridgeToken = null,
      onOpenDrawer,
      onOpenGit,
      defaultStartCwd,
      defaultModelId,
      defaultReasoningEffort,
      approvalMode,
      showToolCalls = false,
      onDefaultStartCwdChange,
      onChatContextChange,
      pendingOpenChatId,
      pendingOpenChatSnapshot,
      onPendingOpenChatHandled,
    },
    ref
  ) {
    const { height: windowHeight } = useWindowDimensions();
    const initialPendingSnapshot =
      pendingOpenChatId && pendingOpenChatSnapshot?.id === pendingOpenChatId
        ? pendingOpenChatSnapshot
        : null;
    const [selectedChat, setSelectedChat] = useState<Chat | null>(
      initialPendingSnapshot
    );
    const [selectedChatId, setSelectedChatId] = useState<string | null>(
      initialPendingSnapshot?.id ?? pendingOpenChatId ?? null
    );
    const [openingChatId, setOpeningChatId] = useState<string | null>(
      initialPendingSnapshot ? null : pendingOpenChatId ?? null
    );
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [activeCommands, setActiveCommands] = useState<RunEvent[]>([]);
    const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
    const [pendingUserInputRequest, setPendingUserInputRequest] =
      useState<PendingUserInputRequest | null>(null);
    const [userInputDrafts, setUserInputDrafts] = useState<Record<string, string>>({});
    const [userInputError, setUserInputError] = useState<string | null>(null);
    const [resolvingUserInput, setResolvingUserInput] = useState(false);
    const [activePlan, setActivePlan] = useState<ActivePlanState | null>(null);
    const [, setStreamingText] = useState<string | null>(null);
    const [renameModalVisible, setRenameModalVisible] = useState(false);
    const [renameDraft, setRenameDraft] = useState('');
    const [renaming, setRenaming] = useState(false);
    const [attachmentModalVisible, setAttachmentModalVisible] = useState(false);
    const [attachmentMenuVisible, setAttachmentMenuVisible] = useState(false);
    const [attachmentPathDraft, setAttachmentPathDraft] = useState('');
    const [pendingMentionPaths, setPendingMentionPaths] = useState<string[]>([]);
    const [pendingLocalImagePaths, setPendingLocalImagePaths] = useState<string[]>([]);
    const [attachmentFileCandidates, setAttachmentFileCandidates] = useState<string[]>([]);
    const [loadingAttachmentFileCandidates, setLoadingAttachmentFileCandidates] =
      useState(false);
    const [uploadingAttachment, setUploadingAttachment] = useState(false);
    const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
    const [stoppingTurn, setStoppingTurn] = useState(false);
    const [workspaceModalVisible, setWorkspaceModalVisible] = useState(false);
    const [workspaceOptions, setWorkspaceOptions] = useState<string[]>([]);
    const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);
    const [chatTitleMenuVisible, setChatTitleMenuVisible] = useState(false);
    const [modelModalVisible, setModelModalVisible] = useState(false);
    const [modelSettingsMenuVisible, setModelSettingsMenuVisible] = useState(false);
    const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
    const [loadingModels, setLoadingModels] = useState(false);
    const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
    const [selectedEffort, setSelectedEffort] = useState<ReasoningEffort | null>(null);
    const [selectedServiceTier, setSelectedServiceTier] = useState<ServiceTier | null>(
      null
    );
    const [defaultServiceTier, setDefaultServiceTier] = useState<ServiceTier | null>(null);
    const [selectedCollaborationMode, setSelectedCollaborationMode] =
      useState<CollaborationMode>('default');
    const [keyboardVisible, setKeyboardVisible] = useState(false);
    const [queuedMessages, setQueuedMessages] = useState<QueuedChatMessage[]>([]);
    const [queueDispatching, setQueueDispatching] = useState(false);
    const [queuePaused, setQueuePaused] = useState(false);
    const [collaborationModeMenuVisible, setCollaborationModeMenuVisible] = useState(false);
    const [effortModalVisible, setEffortModalVisible] = useState(false);
    const [effortPickerModelId, setEffortPickerModelId] = useState<string | null>(null);
    const [activity, setActivity] = useState<ActivityState>({
      tone: 'idle',
      title: 'Ready',
    });
    const [accountRateLimits, setAccountRateLimits] = useState<AccountRateLimitSnapshot | null>(
      null
    );
    const accountRateLimitsRef = useRef<AccountRateLimitSnapshot | null>(null);
    accountRateLimitsRef.current = accountRateLimits;
    const [threadContextUsage, setThreadContextUsage] = useState<ThreadContextUsage | null>(
      null
    );
    const [planPanelCollapsedByThread, setPlanPanelCollapsedByThread] = useState<
      Record<string, boolean>
    >({});
    const [pendingPlanImplementationPrompts, setPendingPlanImplementationPrompts] =
      useState<Record<string, PendingPlanImplementationPrompt>>({});
    const safeAreaInsets = useSafeAreaInsets();
    const scrollRef = useRef<FlatList<ChatTranscriptMessage>>(null);
    const scrollRetryTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
    const autoScrollStateRef = useRef<AutoScrollState>({
      shouldStickToBottom: true,
      isUserInteracting: false,
      isMomentumScrolling: false,
    });
    const loadChatRequestRef = useRef(0);

    const voiceRecorder = useVoiceRecorder({
      transcribe: (dataBase64, prompt, options) =>
        api.transcribeVoice({ dataBase64, prompt, ...options }),
      composerContext: draft,
      onTranscript: (text) => setDraft((prev) => (prev ? `${prev} ${text}` : text)),
      onError: (msg) => setError(msg),
    });
    const canUseVoiceInput = Platform.OS !== 'web';

    const clearPendingScrollRetries = useCallback(() => {
      for (const timeoutId of scrollRetryTimeoutsRef.current) {
        clearTimeout(timeoutId);
      }
      scrollRetryTimeoutsRef.current = [];
    }, []);

    const scrollToBottomReliable = useCallback(
      (animated = true) => {
        clearPendingScrollRetries();
        const delays = [0, 70, 180, 320];
        scrollRetryTimeoutsRef.current = delays.map((delay, index) =>
          setTimeout(() => {
            requestAnimationFrame(() => {
              scrollRef.current?.scrollToOffset({
                offset: 0,
                animated: index === 0 ? animated : false,
              });
            });
          }, delay)
        );
      },
      [clearPendingScrollRetries]
    );

    const scrollToBottomIfPinned = useCallback(
      (animated = true) => {
        const autoScrollState = autoScrollStateRef.current;
        if (
          autoScrollState.isUserInteracting ||
          autoScrollState.isMomentumScrolling ||
          !autoScrollState.shouldStickToBottom
        ) {
          return;
        }
        scrollToBottomReliable(animated);
      },
      [scrollToBottomReliable]
    );

    useEffect(() => {
      return () => {
        clearPendingScrollRetries();
      };
    }, [clearPendingScrollRetries]);

    useEffect(() => {
      const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
      const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
      const showSub = Keyboard.addListener(showEvent, () => setKeyboardVisible(true));
      const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardVisible(false));
      return () => {
        showSub.remove();
        hideSub.remove();
      };
    }, []);

    // Ref so the WS handler always reads the latest chat ID without
    // needing to re-subscribe on every change.
    const chatIdRef = useRef<string | null>(null);
    chatIdRef.current = selectedChatId;
    const selectedChatRef = useRef<Chat | null>(selectedChat);
    selectedChatRef.current = selectedChat;
    const planPanelLastTurnByThreadRef = useRef<Record<string, string>>({});
    const planItemTurnIdByThreadRef = useRef<Record<string, string>>({});
    const activeTurnIdRef = useRef<string | null>(null);
    activeTurnIdRef.current = activeTurnId;
    const stopRequestedRef = useRef(false);
    const stopSystemMessageLoggedRef = useRef(false);

    // Track whether a command arrived since the last delta — used to
    // know when a new thinking segment starts so we can replace the old one.
    const hadCommandRef = useRef(false);
    const reasoningSummaryRef = useRef<Record<string, string>>({});
    const codexReasoningBufferRef = useRef('');
    const runWatchdogUntilRef = useRef(0);
    const runWatchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [runWatchdogNow, setRunWatchdogNow] = useState(() => Date.now());
    const externalStatusFullSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
      null
    );
    const externalStatusFullSyncInFlightRef = useRef(false);
    const externalStatusFullSyncQueuedThreadRef = useRef<string | null>(null);
    const externalStatusFullSyncNextAllowedAtRef = useRef(0);
    const threadRuntimeSnapshotsRef = useRef<Record<string, ThreadRuntimeSnapshot>>({});
    const threadReasoningBuffersRef = useRef<Record<string, string>>({});
    const chatModelPreferencesRef = useRef<Record<string, ChatModelPreference>>({});
    const [chatModelPreferencesLoaded, setChatModelPreferencesLoaded] = useState(false);
    const chatPlanSnapshotsRef = useRef<Record<string, ActivePlanState>>({});
    const [, setChatPlanSnapshotsLoaded] = useState(false);
    const preferredStartCwd = normalizeWorkspacePath(defaultStartCwd);
    const preferredDefaultModelId = normalizeModelId(defaultModelId);
    const preferredDefaultEffort = normalizeReasoningEffort(defaultReasoningEffort);
    const activeApprovalPolicy = toApprovalPolicyForMode(approvalMode);
    const attachmentWorkspace = selectedChat?.cwd ?? preferredStartCwd ?? null;
    const slashQuery = parseSlashQuery(draft);
    const slashSuggestions =
      slashQuery !== null
        ? filterSlashCommands(slashQuery)
        : [];
    const slashSuggestionsMaxHeight = Math.max(
      148,
      Math.min(300, Math.floor(windowHeight * 0.34))
    );
    const attachmentPathSuggestions = useMemo(
      () =>
        toAttachmentPathSuggestions(
          attachmentFileCandidates,
          attachmentPathDraft,
          pendingMentionPaths
        ),
      [attachmentFileCandidates, attachmentPathDraft, pendingMentionPaths]
    );
    const composerAttachments = useMemo(() => {
      const next: ComposerAttachmentChip[] = [];
      for (const path of pendingMentionPaths) {
        next.push({
          id: `file:${path}`,
          label: path,
        });
      }
      for (const path of pendingLocalImagePaths) {
        next.push({
          id: `image:${path}`,
          label: `image · ${toPathBasename(path)}`,
        });
      }
      return next;
    }, [pendingLocalImagePaths, pendingMentionPaths]);

    const scheduleRunWatchdogExpiry = useCallback((deadlineMs: number) => {
      const existingTimer = runWatchdogTimerRef.current;
      if (existingTimer) {
        clearTimeout(existingTimer);
        runWatchdogTimerRef.current = null;
      }

      const delayMs = deadlineMs - Date.now();
      if (delayMs <= 0) {
        return;
      }

      runWatchdogTimerRef.current = setTimeout(() => {
        runWatchdogTimerRef.current = null;
        setRunWatchdogNow(Date.now());
      }, delayMs + 16);
    }, []);

    const bumpRunWatchdog = useCallback(
      (durationMs = RUN_WATCHDOG_MS) => {
        const deadlineMs = Math.max(runWatchdogUntilRef.current, Date.now() + durationMs);
        runWatchdogUntilRef.current = deadlineMs;
        setRunWatchdogNow(Date.now());
        scheduleRunWatchdogExpiry(deadlineMs);
      },
      [scheduleRunWatchdogExpiry]
    );

    const clearRunWatchdog = useCallback(() => {
      runWatchdogUntilRef.current = 0;
      const existingTimer = runWatchdogTimerRef.current;
      if (existingTimer) {
        clearTimeout(existingTimer);
        runWatchdogTimerRef.current = null;
      }
      setRunWatchdogNow(Date.now());
    }, []);

    useEffect(() => {
      return () => {
        const existingTimer = runWatchdogTimerRef.current;
        if (existingTimer) {
          clearTimeout(existingTimer);
          runWatchdogTimerRef.current = null;
        }
      };
    }, []);

    const readThreadContextUsage = useCallback(
      (value: unknown): ThreadContextUsage | null => {
        const record = toRecord(value);
        if (!record) {
          return null;
        }

        const turnRecord = toRecord(record.turn);
        const tokenUsageRecord =
          toRecord(record.tokenUsage) ??
          toRecord(record.token_usage) ??
          toRecord(toRecord(record.info)?.tokenUsage) ??
          toRecord(toRecord(record.info)?.token_usage);
        const infoRecord = toRecord(record.info);

        const totalRecord =
          toRecord(tokenUsageRecord?.total) ??
          toRecord(infoRecord?.total_token_usage) ??
          toRecord(infoRecord?.totalTokenUsage);
        const lastRecord =
          toRecord(tokenUsageRecord?.last) ??
          toRecord(infoRecord?.last_token_usage) ??
          toRecord(infoRecord?.lastTokenUsage);

        const totalTokens =
          readIntegerLike(totalRecord?.totalTokens) ??
          readIntegerLike(totalRecord?.total_tokens);

        const lastTokens =
          readIntegerLike(lastRecord?.totalTokens) ??
          readIntegerLike(lastRecord?.total_tokens) ??
          (totalTokens !== null ? 0 : null);
        const modelContextWindow =
          readIntegerLike(record.modelContextWindow) ??
          readIntegerLike(record.model_context_window) ??
          readIntegerLike(turnRecord?.modelContextWindow) ??
          readIntegerLike(turnRecord?.model_context_window) ??
          readIntegerLike(tokenUsageRecord?.modelContextWindow) ??
          readIntegerLike(tokenUsageRecord?.model_context_window) ??
          readIntegerLike(infoRecord?.modelContextWindow) ??
          readIntegerLike(infoRecord?.model_context_window);

        if (totalTokens === null && modelContextWindow === null) {
          return null;
        }

        return {
          totalTokens,
          lastTokens,
          modelContextWindow,
          updatedAtMs: Date.now(),
        };
      },
      []
    );

    const saveChatModelPreferences = useCallback(
      async (nextPreferences: Record<string, ChatModelPreference>) => {
        const preferencesPath = getChatModelPreferencesPath();
        if (!preferencesPath) {
          return;
        }

        const payload = JSON.stringify({
          version: CHAT_MODEL_PREFERENCES_VERSION,
          entries: nextPreferences,
        });

        try {
          await FileSystem.writeAsStringAsync(preferencesPath, payload);
        } catch {
          // Best effort persistence only.
        }
      },
      []
    );

    const saveChatPlanSnapshots = useCallback(
      async (nextSnapshots: Record<string, ActivePlanState>) => {
        const snapshotsPath = getChatPlanSnapshotsPath();
        if (!snapshotsPath) {
          return;
        }

        const payload = JSON.stringify({
          version: CHAT_PLAN_SNAPSHOTS_VERSION,
          entries: nextSnapshots,
        });

        try {
          await FileSystem.writeAsStringAsync(snapshotsPath, payload);
        } catch {
          // Best effort persistence only.
        }
      },
      []
    );

    const rememberChatPlanSnapshot = useCallback(
      (chatId: string, plan: ActivePlanState | null) => {
        const normalizedChatId = chatId.trim();
        if (!normalizedChatId) {
          return;
        }

        const previous = chatPlanSnapshotsRef.current[normalizedChatId] ?? null;
        const unchanged =
          previous?.turnId === plan?.turnId &&
          previous?.explanation === plan?.explanation &&
          previous?.deltaText === plan?.deltaText &&
          previous?.updatedAt === plan?.updatedAt &&
          JSON.stringify(previous?.steps ?? []) === JSON.stringify(plan?.steps ?? []);
        if (unchanged) {
          return;
        }

        const nextSnapshots = { ...chatPlanSnapshotsRef.current };
        if (plan) {
          nextSnapshots[normalizedChatId] = plan;
        } else {
          delete nextSnapshots[normalizedChatId];
        }
        chatPlanSnapshotsRef.current = nextSnapshots;
        void saveChatPlanSnapshots(nextSnapshots);
      },
      [saveChatPlanSnapshots]
    );

    const rememberChatModelPreference = useCallback(
      (
        chatId: string | null | undefined,
        modelId: string | null | undefined,
        effort: ReasoningEffort | null | undefined,
        serviceTier: ServiceTier | null | undefined
      ) => {
        const normalizedChatId = typeof chatId === 'string' ? chatId.trim() : '';
        if (!normalizedChatId) {
          return;
        }

        const normalizedModelId = normalizeModelId(modelId);
        const normalizedEffort = normalizeReasoningEffort(effort);
        const normalizedServiceTier = toFastModeServiceTier(
          normalizeServiceTier(serviceTier)
        );
        const previous = chatModelPreferencesRef.current[normalizedChatId];
        if (
          previous &&
          previous.modelId === normalizedModelId &&
          previous.effort === normalizedEffort &&
          previous.serviceTier === normalizedServiceTier
        ) {
          return;
        }

        const nextPreferences: Record<string, ChatModelPreference> = {
          ...chatModelPreferencesRef.current,
          [normalizedChatId]: {
            modelId: normalizedModelId,
            effort: normalizedEffort,
            serviceTier: normalizedServiceTier,
            updatedAt: new Date().toISOString(),
          },
        };
        chatModelPreferencesRef.current = nextPreferences;
        if (chatIdRef.current === normalizedChatId) {
          setSelectedModelId(normalizedModelId);
          setSelectedEffort(normalizedEffort);
          setSelectedServiceTier(normalizedServiceTier);
        }
        void saveChatModelPreferences(nextPreferences);
      },
      [saveChatModelPreferences]
    );

    useEffect(() => {
      let cancelled = false;

      const load = async () => {
        const preferencesPath = getChatModelPreferencesPath();
        if (!preferencesPath) {
          if (!cancelled) {
            setChatModelPreferencesLoaded(true);
          }
          return;
        }

        try {
          const raw = await FileSystem.readAsStringAsync(preferencesPath);
          if (cancelled) {
            return;
          }
          chatModelPreferencesRef.current = parseChatModelPreferences(raw);
        } catch {
          if (!cancelled) {
            chatModelPreferencesRef.current = {};
          }
        } finally {
          if (!cancelled) {
            setChatModelPreferencesLoaded(true);
          }
        }
      };

      void load();
      return () => {
        cancelled = true;
      };
    }, []);

    useEffect(() => {
      let cancelled = false;

      const load = async () => {
        try {
          const serviceTier = await api.readServiceTierPreference();
          if (!cancelled) {
            setDefaultServiceTier(toFastModeServiceTier(serviceTier));
          }
        } catch {
          if (!cancelled) {
            setDefaultServiceTier(null);
          }
        }
      };

      void load();
      return () => {
        cancelled = true;
      };
    }, [api]);

    useEffect(() => {
      let cancelled = false;

      const load = async () => {
        try {
          const snapshot = await api.readAccountRateLimits();
          if (!cancelled) {
            accountRateLimitsRef.current = snapshot;
            setAccountRateLimits(snapshot);
          }
        } catch {
          // Best effort hydration. The footer stays hidden when unavailable.
        }
      };

      void load();
      return () => {
        cancelled = true;
      };
    }, [api]);

    const clearExternalStatusFullSync = useCallback(() => {
      const timer = externalStatusFullSyncTimerRef.current;
      if (!timer) {
        externalStatusFullSyncQueuedThreadRef.current = null;
        return;
      }
      clearTimeout(timer);
      externalStatusFullSyncTimerRef.current = null;
      externalStatusFullSyncQueuedThreadRef.current = null;
    }, []);

    const drainExternalStatusFullSyncQueue = useCallback(() => {
      if (externalStatusFullSyncInFlightRef.current) {
        return;
      }

      const queuedThreadId = externalStatusFullSyncQueuedThreadRef.current;
      if (!queuedThreadId) {
        return;
      }

      if (chatIdRef.current !== queuedThreadId) {
        externalStatusFullSyncQueuedThreadRef.current = null;
        return;
      }

      const waitMs = Math.max(
        0,
        externalStatusFullSyncNextAllowedAtRef.current - Date.now()
      );
      if (waitMs > 0) {
        if (!externalStatusFullSyncTimerRef.current) {
          externalStatusFullSyncTimerRef.current = setTimeout(() => {
            externalStatusFullSyncTimerRef.current = null;
            drainExternalStatusFullSyncQueue();
          }, waitMs);
        }
        return;
      }

      externalStatusFullSyncQueuedThreadRef.current = null;
      externalStatusFullSyncInFlightRef.current = true;
      externalStatusFullSyncNextAllowedAtRef.current =
        Date.now() + env.externalStatusFullSyncDebounceMs;

      api
        .getChat(queuedThreadId)
        .then((latest) => {
          if (chatIdRef.current !== queuedThreadId) {
            return;
          }
          setSelectedChat((prev) => (prev && prev.id === latest.id ? latest : prev));
          if (isChatLikelyRunning(latest)) {
            bumpRunWatchdog();
            setActivity((prev) =>
              prev.tone === 'running' ? prev : { tone: 'running', title: 'Working' }
            );
          }
        })
        .catch(() => {})
        .finally(() => {
          externalStatusFullSyncInFlightRef.current = false;
          drainExternalStatusFullSyncQueue();
        });
    }, [api, bumpRunWatchdog]);

    const scheduleExternalStatusFullSync = useCallback(
      (threadId: string) => {
        if (chatIdRef.current !== threadId) {
          return;
        }
        externalStatusFullSyncQueuedThreadRef.current = threadId;
        drainExternalStatusFullSyncQueue();
      },
      [drainExternalStatusFullSyncQueue]
    );

    useEffect(
      () => () => {
        clearExternalStatusFullSync();
      },
      [clearExternalStatusFullSync]
    );

    const upsertThreadRuntimeSnapshot = useCallback(
      (
        threadId: string,
        updater: (previous: ThreadRuntimeSnapshot) => Partial<ThreadRuntimeSnapshot>
      ) => {
        if (!threadId) {
          return;
        }

        const previous =
          threadRuntimeSnapshotsRef.current[threadId] ??
          ({
            updatedAtMs: Date.now(),
          } as ThreadRuntimeSnapshot);
        const nextPatch = updater(previous);

        threadRuntimeSnapshotsRef.current[threadId] = {
          ...previous,
          ...nextPatch,
          updatedAtMs: Date.now(),
        };
      },
      []
    );

    const cacheThreadActivity = useCallback(
      (threadId: string, nextActivity: ActivityState) => {
        upsertThreadRuntimeSnapshot(threadId, () => ({ activity: nextActivity }));
      },
      [upsertThreadRuntimeSnapshot]
    );

    const cacheThreadStreamingDelta = useCallback(
      (threadId: string, delta: string) => {
        const normalized = delta.trim();
        if (!normalized) {
          return;
        }

        upsertThreadRuntimeSnapshot(threadId, (previous) => {
          const merged = mergeStreamingDelta(previous.streamingText ?? null, delta);
          return { streamingText: merged };
        });
      },
      [upsertThreadRuntimeSnapshot]
    );

    const cacheThreadActiveCommand = useCallback(
      (threadId: string, eventType: string, detail: string) => {
        upsertThreadRuntimeSnapshot(threadId, (previous) => ({
          activeCommands: appendRunEventHistory(
            previous.activeCommands ?? [],
            threadId,
            eventType,
            detail
          ),
        }));
      },
      [upsertThreadRuntimeSnapshot]
    );

    const cacheThreadPendingApproval = useCallback(
      (threadId: string, approval: PendingApproval | null) => {
        upsertThreadRuntimeSnapshot(threadId, () => ({
          pendingApproval: approval,
        }));
      },
      [upsertThreadRuntimeSnapshot]
    );

    const cacheThreadPendingUserInputRequest = useCallback(
      (threadId: string, request: PendingUserInputRequest | null) => {
        upsertThreadRuntimeSnapshot(threadId, () => ({
          pendingUserInputRequest: request,
        }));
      },
      [upsertThreadRuntimeSnapshot]
    );

    const cacheThreadTurnState = useCallback(
      (
        threadId: string,
        options: {
          activeTurnId?: string | null;
          runWatchdogUntil?: number;
        }
      ) => {
        upsertThreadRuntimeSnapshot(threadId, () => options);
      },
      [upsertThreadRuntimeSnapshot]
    );

    const cacheThreadContextUsage = useCallback(
      (threadId: string, contextUsage: ThreadContextUsage | null) => {
        if (!contextUsage) {
          upsertThreadRuntimeSnapshot(threadId, () => ({
            contextUsage: null,
          }));
          return;
        }

        const previousContextUsage =
          threadRuntimeSnapshotsRef.current[threadId]?.contextUsage ?? null;
        const mergedContextUsage = mergeThreadContextUsage(previousContextUsage, contextUsage);

        upsertThreadRuntimeSnapshot(threadId, (previous) => {
          return {
            contextUsage: mergeThreadContextUsage(previous.contextUsage ?? null, mergedContextUsage),
          };
        });
      },
      [upsertThreadRuntimeSnapshot]
    );

    const cacheThreadPlan = useCallback(
      (
        threadId: string,
        nextPlan:
          | ActivePlanState
          | null
          | ((previous: ActivePlanState | null) => ActivePlanState | null)
      ) => {
        upsertThreadRuntimeSnapshot(threadId, (previous) => ({
          plan:
            typeof nextPlan === 'function'
              ? (
                  nextPlan as (previous: ActivePlanState | null) => ActivePlanState | null
                )(previous.plan ?? null)
              : nextPlan,
        }));
        rememberChatPlanSnapshot(
          threadId,
          threadRuntimeSnapshotsRef.current[threadId]?.plan ?? null
        );
      },
      [rememberChatPlanSnapshot, upsertThreadRuntimeSnapshot]
    );

    const clearPendingPlanImplementationPrompt = useCallback((threadId: string) => {
      if (!threadId) {
        return;
      }

      setPendingPlanImplementationPrompts((prev) => {
        if (!(threadId in prev)) {
          return prev;
        }

        const next = { ...prev };
        delete next[threadId];
        return next;
      });
    }, []);

    const clearThreadRuntimeSnapshot = useCallback(
      (threadId: string, preserveApprovals = false) => {
        if (!threadId) {
          return;
        }

        delete threadReasoningBuffersRef.current[threadId];
        upsertThreadRuntimeSnapshot(threadId, (previous) => ({
          activity: {
            tone: 'complete',
            title: 'Turn completed',
          },
          activeCommands: [],
          streamingText: null,
          activeTurnId: null,
          runWatchdogUntil: 0,
          pendingApproval: preserveApprovals ? previous.pendingApproval : null,
          pendingUserInputRequest: preserveApprovals
            ? previous.pendingUserInputRequest
            : null,
        }));
      },
      [upsertThreadRuntimeSnapshot]
    );

    const applyThreadRuntimeSnapshot = useCallback(
      (threadId: string) => {
        if (!threadId) {
          setThreadContextUsage(null);
          setActivePlan(null);
          setSelectedCollaborationMode('default');
          return;
        }

        const snapshot = threadRuntimeSnapshotsRef.current[threadId];
        if (!snapshot) {
          setThreadContextUsage(null);
          setActivePlan(null);
          setSelectedCollaborationMode('default');
          return;
        }

        setSelectedCollaborationMode(resolveSnapshotCollaborationMode(snapshot));
        if (snapshot.activeCommands !== undefined) {
          setActiveCommands(snapshot.activeCommands);
        }
        if (snapshot.streamingText !== undefined) {
          setStreamingText(snapshot.streamingText);
        }
        if (snapshot.pendingApproval !== undefined) {
          setPendingApproval(snapshot.pendingApproval);
        }
        if (snapshot.pendingUserInputRequest !== undefined) {
          setPendingUserInputRequest(snapshot.pendingUserInputRequest);
          setUserInputDrafts(
            snapshot.pendingUserInputRequest
              ? buildUserInputDrafts(snapshot.pendingUserInputRequest)
              : {}
          );
          setUserInputError(null);
          setResolvingUserInput(false);
        }
        setThreadContextUsage(snapshot.contextUsage ?? null);
        setActivePlan(snapshot.plan ?? null);
        if (snapshot.activeTurnId !== undefined) {
          setActiveTurnId(snapshot.activeTurnId);
        }
        if (snapshot.activity) {
          setActivity(snapshot.activity);
        }
        if (
          typeof snapshot.runWatchdogUntil === 'number' &&
          snapshot.runWatchdogUntil > runWatchdogUntilRef.current
        ) {
          runWatchdogUntilRef.current = snapshot.runWatchdogUntil;
          setRunWatchdogNow(Date.now());
          scheduleRunWatchdogExpiry(snapshot.runWatchdogUntil);
        }
      },
      [scheduleRunWatchdogExpiry]
    );

    useEffect(() => {
      let cancelled = false;

      const load = async () => {
        const snapshotsPath = getChatPlanSnapshotsPath();
        if (!snapshotsPath) {
          if (!cancelled) {
            setChatPlanSnapshotsLoaded(true);
          }
          return;
        }

        try {
          const raw = await FileSystem.readAsStringAsync(snapshotsPath);
          if (cancelled) {
            return;
          }

          const parsedSnapshots = parseChatPlanSnapshots(raw);
          chatPlanSnapshotsRef.current = parsedSnapshots;
          for (const [threadId, plan] of Object.entries(parsedSnapshots)) {
            upsertThreadRuntimeSnapshot(threadId, () => ({ plan }));
          }
          if (chatIdRef.current) {
            applyThreadRuntimeSnapshot(chatIdRef.current);
          }
        } catch {
          if (!cancelled) {
            chatPlanSnapshotsRef.current = {};
          }
        } finally {
          if (!cancelled) {
            setChatPlanSnapshotsLoaded(true);
          }
        }
      };

      void load();
      return () => {
        cancelled = true;
      };
    }, [applyThreadRuntimeSnapshot, upsertThreadRuntimeSnapshot]);

    const refreshPendingApprovalsForThread = useCallback(
      async (threadId: string) => {
        try {
          const approvals = await api.listApprovals();
          const match = approvals.find((entry) => entry.threadId === threadId) ?? null;
          cacheThreadPendingApproval(threadId, match);
          if (chatIdRef.current === threadId) {
            setPendingApproval(match);
            if (match) {
              setActivity({
                tone: 'idle',
                title: 'Waiting for approval',
                detail: match.command ?? match.kind,
              });
            }
          }
        } catch {
          // Best effort hydration for externally-started turns.
        }
      },
      [api, cacheThreadPendingApproval]
    );

    const cacheCodexRuntimeForThread = useCallback(
      (
        threadId: string,
        codexEventType: string,
        msg: Record<string, unknown> | null
      ) => {
        if (!threadId) {
          return;
        }

        if (codexEventType === 'tokencount') {
          const contextUsage = readThreadContextUsage(msg);
          if (contextUsage) {
            cacheThreadContextUsage(threadId, contextUsage);
          }
          return;
        }

        if (isCodexRunHeartbeatEvent(codexEventType)) {
          cacheThreadTurnState(threadId, {
            runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
          });
          cacheThreadActivity(threadId, {
            tone: 'running',
            title: 'Working',
          });
        }

        if (codexEventType === 'taskstarted') {
          cacheThreadActivity(threadId, {
            tone: 'running',
            title: 'Working',
          });
          return;
        }

        if (
          codexEventType === 'agentreasoningdelta' ||
          codexEventType === 'reasoningcontentdelta' ||
          codexEventType === 'reasoningrawcontentdelta' ||
          codexEventType === 'agentreasoningrawcontentdelta'
        ) {
          const delta = readString(msg?.delta);
          if (!delta) {
            return;
          }

          const nextBuffer = `${threadReasoningBuffersRef.current[threadId] ?? ''}${delta}`;
          threadReasoningBuffersRef.current[threadId] = nextBuffer;
          const heading =
            extractFirstBoldSnippet(nextBuffer, 56) ??
            extractFirstBoldSnippet(delta, 56);
          const summary = toTickerSnippet(stripMarkdownInline(delta), 64);
          cacheThreadActivity(threadId, {
            tone: 'running',
            title: heading ?? 'Reasoning',
            detail: heading ? undefined : summary ?? undefined,
          });
          return;
        }

        if (codexEventType === 'agentreasoningsectionbreak') {
          delete threadReasoningBuffersRef.current[threadId];
          return;
        }

        if (
          codexEventType === 'agentmessagedelta' ||
          codexEventType === 'agentmessagecontentdelta'
        ) {
          const delta = readString(msg?.delta);
          if (!delta) {
            return;
          }

          cacheThreadStreamingDelta(threadId, delta);
          cacheThreadActivity(threadId, {
            tone: 'running',
            title: 'Thinking',
          });
          return;
        }

        if (codexEventType === 'execcommandbegin') {
          cacheThreadActivity(threadId, {
            tone: 'running',
            title: 'Working',
          });
          return;
        }

        if (codexEventType === 'execcommandend') {
          const status = readString(msg?.status);
          const failed = status === 'failed' || status === 'error';
          cacheThreadActivity(threadId, {
            tone: failed ? 'error' : 'running',
            title: failed ? 'Turn failed' : 'Working',
          });
          return;
        }

        if (codexEventType === 'mcpstartupupdate') {
          cacheThreadActivity(threadId, {
            tone: 'running',
            title: 'Working',
          });
          return;
        }

        if (codexEventType === 'mcptoolcallbegin') {
          cacheThreadActivity(threadId, {
            tone: 'running',
            title: 'Working',
          });
          return;
        }

        if (codexEventType === 'websearchbegin') {
          const searchEvent = describeWebSearchToolEvent(msg);
          if (searchEvent) {
            cacheThreadActiveCommand(threadId, searchEvent.eventType, searchEvent.detail);
          }
          cacheThreadActivity(threadId, {
            tone: 'running',
            title: 'Working',
          });
          return;
        }

        if (codexEventType === 'backgroundevent') {
          const message =
            toTickerSnippet(readString(msg?.message), 72) ??
            toTickerSnippet(readString(msg?.text), 72);
          cacheThreadActivity(threadId, {
            tone: 'running',
            title: message ?? 'Working',
          });
          return;
        }

        if (CODEX_RUN_ABORT_EVENT_TYPES.has(codexEventType)) {
          cacheThreadTurnState(threadId, {
            activeTurnId: null,
            runWatchdogUntil: 0,
          });
          upsertThreadRuntimeSnapshot(threadId, () => ({
            activity: {
              tone: 'error',
              title: 'Turn interrupted',
            },
            activeCommands: [],
            streamingText: null,
          }));
          return;
        }

        if (CODEX_RUN_FAILURE_EVENT_TYPES.has(codexEventType)) {
          cacheThreadTurnState(threadId, {
            activeTurnId: null,
            runWatchdogUntil: 0,
          });
          upsertThreadRuntimeSnapshot(threadId, () => ({
            activity: {
              tone: 'error',
              title: 'Turn failed',
            },
            activeCommands: [],
            streamingText: null,
          }));
          return;
        }

        if (CODEX_RUN_COMPLETION_EVENT_TYPES.has(codexEventType)) {
          clearThreadRuntimeSnapshot(threadId, true);
        }
      },
      [
        cacheThreadActiveCommand,
        cacheThreadActivity,
        cacheThreadContextUsage,
        cacheThreadStreamingDelta,
        cacheThreadTurnState,
        clearThreadRuntimeSnapshot,
        readThreadContextUsage,
        upsertThreadRuntimeSnapshot,
      ]
    );

    const pushActiveCommand = useCallback(
      (threadId: string, eventType: string, detail: string) => {
        setActiveCommands((prev) =>
          appendRunEventHistory(prev, threadId, eventType, detail)
        );
      },
      []
    );

    useEffect(() => {
      onChatContextChange?.(selectedChat);
    }, [onChatContextChange, selectedChat]);

    useEffect(() => {
      if (!chatModelPreferencesLoaded) {
        return;
      }

      const chatId = selectedChatId?.trim();
      if (!chatId) {
        return;
      }

      const preference = chatModelPreferencesRef.current[chatId];
      setSelectedModelId(preference?.modelId ?? null);
      setSelectedEffort(preference?.effort ?? null);
      setSelectedServiceTier(toFastModeServiceTier(preference?.serviceTier ?? null));
    }, [chatModelPreferencesLoaded, selectedChatId]);

    useEffect(() => {
      if (selectedChatId) {
        return;
      }

      setSelectedModelId(preferredDefaultModelId);
      setSelectedEffort(preferredDefaultEffort);
      setSelectedServiceTier(defaultServiceTier);
    }, [
      defaultServiceTier,
      preferredDefaultEffort,
      preferredDefaultModelId,
      selectedChatId,
    ]);

    const serverDefaultModel = modelOptions.find((model) => model.isDefault) ?? null;
    const serverDefaultModelId = serverDefaultModel?.id ?? null;
    const activeModelId =
      selectedModelId ??
      (selectedChatId ? null : preferredDefaultModelId) ??
      serverDefaultModelId;
    const activeModel = activeModelId
      ? modelOptions.find((model) => model.id === activeModelId) ?? null
      : null;
    const effortPickerModel = effortPickerModelId
      ? modelOptions.find((model) => model.id === effortPickerModelId) ?? null
      : activeModel;
    const effortPickerOptions = effortPickerModel?.reasoningEffort ?? [];
    const effortPickerDefault = effortPickerModel?.defaultReasoningEffort ?? null;
    const activeModelEffortOptions = activeModel?.reasoningEffort ?? [];
    const activeModelDefaultEffort = activeModel?.defaultReasoningEffort ?? null;
    const requestedEffort =
      selectedEffort ?? (!selectedChatId ? preferredDefaultEffort : null);
    const appliedServiceTierForSelectedChat = toFastModeServiceTier(
      selectedChatId
        ? normalizeServiceTier(
            chatModelPreferencesRef.current[selectedChatId]?.serviceTier ?? null
          )
        : defaultServiceTier
    );
    const activeServiceTier = toFastModeServiceTier(
      selectedServiceTier ?? (!selectedChatId ? defaultServiceTier : null) ?? null
    );
    const fastModeEnabled = activeServiceTier === 'fast';
    const supportsSelectedEffort =
      requestedEffort &&
      (!activeModel ||
        activeModelEffortOptions.length === 0 ||
        !selectedModelId ||
        activeModelEffortOptions.some((option) => option.effort === requestedEffort));
    const activeEffort = supportsSelectedEffort ? requestedEffort : activeModelDefaultEffort;
    const activeModelLabel =
      selectedModelId && activeModel
        ? activeModel.displayName
        : selectedModelId
          ? selectedModelId
          : activeModel
            ? `Default (${activeModel.displayName})`
            : 'Default model';
    const activeEffortLabel =
      requestedEffort && activeEffort
        ? formatReasoningEffort(activeEffort)
        : activeModelDefaultEffort
          ? `Default (${formatReasoningEffort(activeModelDefaultEffort)})`
          : activeEffort
            ? formatReasoningEffort(activeEffort)
            : 'Model default';
    const modelReasoningLabel = `${activeModelLabel} · ${activeEffortLabel}`;
    const collaborationModeLabel = formatCollaborationModeLabel(selectedCollaborationMode);
    const hasPendingServiceTierChange =
      Boolean(selectedChatId) && appliedServiceTierForSelectedChat !== activeServiceTier;
    const fastModeLabel = hasPendingServiceTierChange
      ? `${fastModeEnabled ? 'Fast mode on' : 'Fast mode off'} · next message`
      : fastModeEnabled
        ? 'Fast mode on'
        : 'Fast mode off';

    // Auto-transition complete/error → idle after 3s so the bar hides.
    useEffect(() => {
      if (activity.tone !== 'complete' && activity.tone !== 'error') {
        return;
      }
      const timer = setTimeout(() => {
        setActivity({ tone: 'idle', title: 'Ready' });
      }, 3000);
      return () => clearTimeout(timer);
    }, [activity.tone]);

    useEffect(() => {
      if (!selectedEffort) {
        return;
      }

      if (!selectedModelId) {
        return;
      }

      if (!activeModel) {
        return;
      }

      const effortOptions = activeModel.reasoningEffort ?? [];
      if (effortOptions.length === 0) {
        return;
      }

      const supportsSelectedEffort =
        effortOptions.some((option) => option.effort === selectedEffort);
      if (!supportsSelectedEffort) {
        setSelectedEffort(null);
      }
    }, [activeModel, selectedEffort, selectedModelId]);

    const resetComposerState = useCallback(() => {
      clearExternalStatusFullSync();
      loadChatRequestRef.current += 1;
      setSelectedChat(null);
      setSelectedChatId(null);
      setSelectedCollaborationMode('default');
      setOpeningChatId(null);
      setDraft('');
      setError(null);
      setSelectedServiceTier(defaultServiceTier);
      setActiveCommands([]);
      setThreadContextUsage(null);
      setPendingApproval(null);
      setPendingUserInputRequest(null);
      setUserInputDrafts({});
      setUserInputError(null);
      setResolvingUserInput(false);
      setActivePlan(null);
      setStreamingText(null);
      setRenameModalVisible(false);
      setRenameDraft('');
      setRenaming(false);
      setAttachmentModalVisible(false);
      setAttachmentMenuVisible(false);
      setAttachmentPathDraft('');
      setPendingMentionPaths([]);
      setPendingLocalImagePaths([]);
      setAttachmentFileCandidates([]);
      setLoadingAttachmentFileCandidates(false);
      setUploadingAttachment(false);
      setActiveTurnId(null);
      setStoppingTurn(false);
      setWorkspaceModalVisible(false);
      setChatTitleMenuVisible(false);
      setModelModalVisible(false);
      setModelSettingsMenuVisible(false);
      setCollaborationModeMenuVisible(false);
      setEffortModalVisible(false);
      setQueuedMessages([]);
      setQueueDispatching(false);
      setQueuePaused(false);
      setActivity({
        tone: 'idle',
        title: 'Ready',
      });
      stopRequestedRef.current = false;
      stopSystemMessageLoggedRef.current = false;
      reasoningSummaryRef.current = {};
      codexReasoningBufferRef.current = '';
      hadCommandRef.current = false;
      clearRunWatchdog();
    }, [clearExternalStatusFullSync, clearRunWatchdog, defaultServiceTier]);

    const startNewChat = useCallback(() => {
      // New chat should land on compose/home so user can pick workspace first.
      resetComposerState();
    }, [resetComposerState]);

    const refreshWorkspaceOptions = useCallback(async () => {
      setLoadingWorkspaces(true);
      try {
        const chats = await api.listChats();
        setWorkspaceOptions(extractWorkspaceOptions(chats));
      } catch {
        // Keep existing options when list refresh fails.
      } finally {
        setLoadingWorkspaces(false);
      }
    }, [api]);

    const openWorkspaceModal = useCallback(() => {
      setWorkspaceModalVisible(true);
      void refreshWorkspaceOptions();
    }, [refreshWorkspaceOptions]);

    const closeWorkspaceModal = useCallback(() => {
      if (loadingWorkspaces) {
        return;
      }
      setWorkspaceModalVisible(false);
    }, [loadingWorkspaces]);

    const selectDefaultWorkspace = useCallback(
      (cwd: string | null) => {
        onDefaultStartCwdChange?.(normalizeWorkspacePath(cwd));
        setWorkspaceModalVisible(false);
      },
      [onDefaultStartCwdChange]
    );

    const refreshModelOptions = useCallback(async () => {
      setLoadingModels(true);
      try {
        const models = await api.listModels(false);
        setModelOptions(models);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoadingModels(false);
      }
    }, [api]);

    const openModelModal = useCallback(() => {
      setModelModalVisible(true);
      void refreshModelOptions();
    }, [refreshModelOptions]);

    const closeModelModal = useCallback(() => {
      if (loadingModels) {
        return;
      }
      setModelModalVisible(false);
    }, [loadingModels]);

    const openEffortModal = useCallback(
      (modelId?: string | null) => {
        const resolvedModelId = normalizeModelId(modelId ?? activeModelId);
        if (!resolvedModelId) {
          setError('Select a model first');
          return;
        }

        setEffortPickerModelId(resolvedModelId);
        setEffortModalVisible(true);
        setError(null);
      },
      [activeModelId]
    );

    const closeEffortModal = useCallback(() => {
      setEffortModalVisible(false);
    }, []);

    const selectEffort = useCallback(
      (effort: ReasoningEffort | null) => {
        setSelectedEffort(effort);
        setEffortModalVisible(false);
        setError(null);
        if (selectedChatId) {
          rememberChatModelPreference(
            selectedChatId,
            activeModelId,
            effort,
            activeServiceTier
          );
        }
      },
      [activeModelId, activeServiceTier, rememberChatModelPreference, selectedChatId]
    );

    const selectModel = useCallback(
      (modelId: string | null) => {
        const normalizedModelId = normalizeModelId(modelId);
        setSelectedModelId(normalizedModelId);
        setSelectedEffort(null);
        setModelModalVisible(false);
        setError(null);
        if (selectedChatId) {
          rememberChatModelPreference(
            selectedChatId,
            normalizedModelId,
            null,
            activeServiceTier
          );
        }

        if (normalizedModelId) {
          const model = modelOptions.find((entry) => entry.id === normalizedModelId) ?? null;
          if ((model?.reasoningEffort?.length ?? 0) > 0) {
            setEffortPickerModelId(normalizedModelId);
            setEffortModalVisible(true);
          }
        }
      },
      [activeServiceTier, modelOptions, rememberChatModelPreference, selectedChatId]
    );

    const loadAttachmentFileCandidates = useCallback(async () => {
      setLoadingAttachmentFileCandidates(true);
      try {
        const response = await api.execTerminal({
          command: 'git ls-files --cached --others --exclude-standard',
          cwd: attachmentWorkspace ?? undefined,
          timeoutMs: 15_000,
        });
        if (response.code !== 0) {
          setAttachmentFileCandidates([]);
          return;
        }

        const lines = response.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .slice(0, 8_000);
        setAttachmentFileCandidates(lines);
      } catch {
        setAttachmentFileCandidates([]);
      } finally {
        setLoadingAttachmentFileCandidates(false);
      }
    }, [api, attachmentWorkspace]);

    const openAttachmentPathModal = useCallback(() => {
      setAttachmentPathDraft('');
      setAttachmentModalVisible(true);
      setError(null);
      if (attachmentFileCandidates.length === 0 && !loadingAttachmentFileCandidates) {
        void loadAttachmentFileCandidates();
      }
    }, [
      attachmentFileCandidates.length,
      loadAttachmentFileCandidates,
      loadingAttachmentFileCandidates,
    ]);

    const closeAttachmentModal = useCallback(() => {
      setAttachmentModalVisible(false);
      setAttachmentPathDraft('');
    }, []);

    const removePendingMentionPath = useCallback((path: string) => {
      setPendingMentionPaths((prev) => prev.filter((entry) => entry !== path));
    }, []);

    const removePendingLocalImagePath = useCallback((path: string) => {
      setPendingLocalImagePaths((prev) => prev.filter((entry) => entry !== path));
    }, []);

    const removeComposerAttachment = useCallback(
      (attachmentId: string) => {
        if (attachmentId.startsWith('file:')) {
          removePendingMentionPath(attachmentId.slice('file:'.length));
          return;
        }
        if (attachmentId.startsWith('image:')) {
          removePendingLocalImagePath(attachmentId.slice('image:'.length));
        }
      },
      [removePendingLocalImagePath, removePendingMentionPath]
    );

    const addPendingMentionPath = useCallback((rawPath: string): boolean => {
      const normalized = normalizeAttachmentPath(rawPath);
      if (!normalized) {
        setError('Enter a file path to attach');
        return false;
      }

      setPendingMentionPaths((prev) => {
        const dedupeKey = normalized.toLowerCase();
        if (prev.some((entry) => entry.toLowerCase() === dedupeKey)) {
          return prev;
        }
        return [...prev, normalized];
      });
      setError(null);
      return true;
    }, []);

    const addPendingLocalImagePath = useCallback((rawPath: string): boolean => {
      const normalized = normalizeAttachmentPath(rawPath);
      if (!normalized) {
        setError('Image path is invalid');
        return false;
      }

      setPendingLocalImagePaths((prev) => {
        const dedupeKey = normalized.toLowerCase();
        if (prev.some((entry) => entry.toLowerCase() === dedupeKey)) {
          return prev;
        }
        return [...prev, normalized];
      });
      setError(null);
      return true;
    }, []);

    const uploadMobileAttachment = useCallback(
      async ({
        uri,
        fileName,
        mimeType,
        kind,
        dataBase64,
      }: {
        uri: string;
        fileName?: string;
        mimeType?: string;
        kind: 'file' | 'image';
        dataBase64?: string;
      }) => {
        const normalizedUri = normalizeAttachmentPath(uri);
        if (!normalizedUri) {
          setError('Unable to read attachment from this device');
          return;
        }

        setUploadingAttachment(true);
        try {
          const base64 =
            dataBase64 ??
            (await FileSystem.readAsStringAsync(normalizedUri, {
              encoding: FileSystem.EncodingType.Base64,
            }));
          if (!base64.trim()) {
            throw new Error('Attachment is empty');
          }

          const uploaded = await api.uploadAttachment({
            dataBase64: base64,
            fileName,
            mimeType,
            threadId: selectedChatId ?? undefined,
            kind,
          });

          if (uploaded.kind === 'image') {
            addPendingLocalImagePath(uploaded.path);
          } else {
            addPendingMentionPath(uploaded.path);
          }
          setError(null);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setUploadingAttachment(false);
        }
      },
      [addPendingLocalImagePath, addPendingMentionPath, api, selectedChatId]
    );

    const pickFileFromDevice = useCallback(async () => {
      try {
        const result = await DocumentPicker.getDocumentAsync({
          type: '*/*',
          copyToCacheDirectory: true,
          multiple: false,
        });
        if (result.canceled || !result.assets[0]) {
          return;
        }

        const file = result.assets[0];
        await uploadMobileAttachment({
          uri: file.uri,
          fileName: file.name,
          mimeType: file.mimeType ?? undefined,
          kind: 'file',
        });
      } catch (err) {
        setError((err as Error).message);
      }
    }, [uploadMobileAttachment]);

    const pickImageFromDevice = useCallback(async () => {
      try {
        if (Platform.OS !== 'ios') {
          const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (!permission.granted) {
            setError('Photo library permission is required to attach images');
            return;
          }
        }

        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          quality: 1,
          base64: true,
          allowsMultipleSelection: false,
        });
        if (result.canceled || !result.assets[0]) {
          return;
        }

        const image = result.assets[0];
        await uploadMobileAttachment({
          uri: image.uri,
          fileName: image.fileName ?? undefined,
          mimeType: image.mimeType ?? undefined,
          kind: 'image',
          dataBase64: image.base64 ?? undefined,
        });
      } catch (err) {
        setError((err as Error).message);
      }
    }, [uploadMobileAttachment]);

    const openAttachmentMenu = useCallback(() => {
      setAttachmentMenuVisible(true);
    }, []);

    const submitAttachmentPath = useCallback(() => {
      if (!addPendingMentionPath(attachmentPathDraft)) {
        return;
      }

      setAttachmentPathDraft('');
      setAttachmentModalVisible(false);
    }, [addPendingMentionPath, attachmentPathDraft]);

    const selectAttachmentSuggestion = useCallback(
      (path: string) => {
        if (!addPendingMentionPath(path)) {
          return;
        }

        setAttachmentPathDraft('');
        setAttachmentModalVisible(false);
      },
      [addPendingMentionPath]
    );

    useEffect(() => {
      void refreshModelOptions();
    }, [refreshModelOptions]);

    useEffect(() => {
      setAttachmentFileCandidates([]);
    }, [attachmentWorkspace]);

    const openRenameModal = useCallback(() => {
      if (!selectedChat) {
        return;
      }

      setRenameDraft(selectedChat.title || '');
      setRenameModalVisible(true);
    }, [selectedChat]);

    const openChatTitleMenu = useCallback(() => {
      if (!selectedChat) {
        return;
      }

      setChatTitleMenuVisible(true);
    }, [selectedChat]);

    const openCollaborationModeMenu = useCallback(() => {
      setCollaborationModeMenuVisible(true);
    }, []);

    const toggleFastMode = useCallback(() => {
      const nextServiceTier: ServiceTier | null =
        activeServiceTier === 'fast' ? null : 'fast';
      const enablingFastMode = nextServiceTier === 'fast';
      const nextTitle = enablingFastMode ? 'Fast mode enabled' : 'Fast mode disabled';
      setSelectedServiceTier(nextServiceTier);
      setError(null);
      setActivity({
        tone: 'complete',
        title: nextTitle,
        detail: selectedChatId ? 'Applies to the next message' : 'Applies to the next new chat',
      });
    }, [activeServiceTier, selectedChatId]);

    const openModelReasoningMenu = useCallback(() => {
      setModelSettingsMenuVisible(true);
    }, []);

    const attachmentMenuOptions = useMemo<SelectionSheetOption[]>(
      () => [
        {
          key: 'workspace-path',
          title: 'Attach from workspace path',
          description: 'Reference a file or folder from the current repo.',
          icon: 'folder-open-outline',
          onPress: () => {
            setAttachmentMenuVisible(false);
            openAttachmentPathModal();
          },
        },
        {
          key: 'phone-file',
          title: 'Pick file from phone',
          description: 'Import a document or asset from local storage.',
          icon: 'document-outline',
          onPress: () => {
            setAttachmentMenuVisible(false);
            void pickFileFromDevice();
          },
        },
        {
          key: 'phone-image',
          title: 'Pick image from phone',
          description: 'Send an image directly from your photo library.',
          icon: 'image-outline',
          onPress: () => {
            setAttachmentMenuVisible(false);
            void pickImageFromDevice();
          },
        },
      ],
      [openAttachmentPathModal, pickFileFromDevice, pickImageFromDevice]
    );

    const chatTitleMenuOptions = useMemo<SelectionSheetOption[]>(
      () => [
        {
          key: 'rename-chat',
          title: 'Rename chat',
          description: 'Update the title shown in the transcript and sidebar.',
          icon: 'pencil-outline',
          onPress: () => {
            setChatTitleMenuVisible(false);
            openRenameModal();
          },
        },
      ],
      [openRenameModal]
    );

    const collaborationModeOptions = useMemo<SelectionSheetOption[]>(
      () => [
        {
          key: 'default',
          title: 'Default mode',
          description: 'Answer directly and keep the turn moving.',
          icon: 'chatbubble-ellipses-outline',
          selected: selectedCollaborationMode === 'default',
          onPress: () => {
            setSelectedCollaborationMode('default');
            setCollaborationModeMenuVisible(false);
            setError(null);
          },
        },
        {
          key: 'plan',
          title: 'Plan mode',
          description: 'Pause to ask structured follow-up questions before execution.',
          icon: 'git-branch-outline',
          selected: selectedCollaborationMode === 'plan',
          onPress: () => {
            setSelectedCollaborationMode('plan');
            setCollaborationModeMenuVisible(false);
            setError(null);
          },
        },
      ],
      [selectedCollaborationMode]
    );

    const modelSettingsMenuOptions = useMemo<SelectionSheetOption[]>(
      () => [
        {
          key: 'model',
          title: 'Change model',
          description: activeModelLabel,
          icon: 'hardware-chip-outline',
          onPress: () => {
            setModelSettingsMenuVisible(false);
            openModelModal();
          },
        },
        {
          key: 'reasoning',
          title: 'Change reasoning level',
          description: activeEffortLabel,
          icon: 'pulse-outline',
          onPress: () => {
            setModelSettingsMenuVisible(false);
            openEffortModal();
          },
        },
        {
          key: 'mode',
          title: 'Change collaboration mode',
          description: collaborationModeLabel,
          icon: 'git-network-outline',
          onPress: () => {
            setModelSettingsMenuVisible(false);
            setCollaborationModeMenuVisible(true);
          },
        },
        {
          key: 'fast-mode',
          title: fastModeEnabled ? 'Disable fast mode' : 'Enable fast mode',
          description:
            selectedChatId !== null
              ? 'Applies to the next message in this chat.'
              : 'Applies to the next new chat.',
          icon: 'flash-outline',
          meta: fastModeEnabled ? 'On' : 'Off',
          onPress: () => {
            setModelSettingsMenuVisible(false);
            void toggleFastMode();
          },
        },
      ],
      [
        activeEffortLabel,
        activeModelLabel,
        collaborationModeLabel,
        fastModeEnabled,
        openEffortModal,
        openModelModal,
        selectedChatId,
        toggleFastMode,
      ]
    );

    const workspacePickerOptions = useMemo<SelectionSheetOption[]>(
      () => [
        {
          key: 'bridge-default',
          title: 'Bridge default workspace',
          description: 'Use the bridge start directory unless you override it here.',
          icon: 'server-outline',
          badge: 'Auto',
          selected: preferredStartCwd === null,
          onPress: () => selectDefaultWorkspace(null),
        },
        ...workspaceOptions.map((cwd) => ({
          key: cwd,
          title: toPathBasename(cwd),
          description: cwd,
          icon: 'folder-outline' as const,
          selected: cwd === preferredStartCwd,
          onPress: () => selectDefaultWorkspace(cwd),
        })),
      ],
      [preferredStartCwd, selectDefaultWorkspace, workspaceOptions]
    );

    const modelPickerOptions = useMemo<SelectionSheetOption[]>(
      () => [
        {
          key: 'server-default',
          title: 'Use server default',
          description: serverDefaultModel
            ? `Currently ${serverDefaultModel.displayName}.`
            : 'Follow the bridge default model.',
          icon: 'sparkles-outline',
          badge: 'Auto',
          selected: selectedModelId === null,
          onPress: () => selectModel(null),
        },
        ...modelOptions.map((model) => ({
          key: model.id,
          title: model.displayName,
          description: model.description?.trim() || model.id,
          icon: 'hardware-chip-outline' as const,
          badge: model.isDefault ? 'Default' : undefined,
          meta: model.defaultReasoningEffort
            ? formatReasoningEffort(model.defaultReasoningEffort)
            : undefined,
          selected: model.id === selectedModelId,
          onPress: () => selectModel(model.id),
        })),
      ],
      [modelOptions, selectModel, selectedModelId, serverDefaultModel]
    );

    const effortPickerSheetOptions = useMemo<SelectionSheetOption[]>(
      () => [
        {
          key: 'model-default',
          title: effortPickerDefault
            ? `Use ${formatReasoningEffort(effortPickerDefault)}`
            : 'Use model default',
          description: effortPickerModel
            ? `Follow ${effortPickerModel.displayName}'s default reasoning.`
            : 'Follow the active model default.',
          icon: 'sparkles-outline',
          badge: 'Auto',
          selected: selectedEffort === null,
          onPress: () => selectEffort(null),
        },
        ...effortPickerOptions.map((option) => ({
          key: option.effort,
          title: formatReasoningEffort(option.effort),
          description:
            option.description?.trim() ||
            'Override the model default for the next response.',
          icon: 'pulse-outline' as const,
          selected: option.effort === selectedEffort,
          onPress: () => selectEffort(option.effort),
        })),
      ],
      [
        effortPickerDefault,
        effortPickerModel,
        effortPickerOptions,
        selectEffort,
        selectedEffort,
      ]
    );

    const closeRenameModal = useCallback(() => {
      if (renaming) {
        return;
      }
      setRenameModalVisible(false);
    }, [renaming]);

    const submitRenameChat = useCallback(async () => {
      const activeChatId = selectedChatId ?? selectedChat?.id ?? null;
      if (!activeChatId || renaming) {
        return;
      }

      const nextName = renameDraft.trim();
      if (!nextName) {
        setRenameModalVisible(false);
        return;
      }

      try {
        setRenaming(true);
        const updated = await api.renameChat(activeChatId, nextName);
        setSelectedChat({
          ...updated,
          title: nextName,
        });
        setError(null);
        setRenameModalVisible(false);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setRenaming(false);
      }
    }, [api, renameDraft, renaming, selectedChat?.id, selectedChatId]);

    const appendLocalAssistantMessage = useCallback(
      (content: string) => {
        const normalized = content.trim();
        if (!normalized) {
          return;
        }

        if (!selectedChatId) {
          setError(normalized);
          return;
        }

        const createdAt = new Date().toISOString();
        setSelectedChat((prev) => {
          if (!prev || prev.id !== selectedChatId) {
            return prev;
          }

          return {
            ...prev,
            updatedAt: createdAt,
            statusUpdatedAt: createdAt,
            lastMessagePreview: normalized.slice(0, 120),
            messages: [
              ...prev.messages,
              {
                id: `local-assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                role: 'assistant',
                content: normalized,
                createdAt,
              },
            ],
          };
        });
        scrollToBottomIfPinned(true);
      },
      [scrollToBottomIfPinned, selectedChatId]
    );

    const appendLocalSystemMessage = useCallback(
      (content: string) => {
        const normalized = content.trim();
        if (!normalized || !selectedChatId) {
          return;
        }

        const createdAt = new Date().toISOString();
        setSelectedChat((prev) => {
          if (!prev || prev.id !== selectedChatId) {
            return prev;
          }

          return {
            ...prev,
            updatedAt: createdAt,
            statusUpdatedAt: createdAt,
            messages: [
              ...prev.messages,
              {
                id: `local-system-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                role: 'system',
                content: normalized,
                createdAt,
              },
            ],
          };
        });
        scrollToBottomIfPinned(true);
      },
      [scrollToBottomIfPinned, selectedChatId]
    );

    const appendStopSystemMessageIfNeeded = useCallback(() => {
      if (stopSystemMessageLoggedRef.current) {
        return;
      }
      stopSystemMessageLoggedRef.current = true;
      appendLocalSystemMessage('Turn stopped by user.');
    }, [appendLocalSystemMessage]);

    const handleTurnFailure = useCallback(
      (error: unknown) => {
        const message = (error as Error).message ?? String(error);
        const normalizedMessage = message.toLowerCase();
        const interruptedByUser =
          stopRequestedRef.current &&
          (normalizedMessage.includes('turn aborted') ||
            normalizedMessage.includes('interrupted'));

        if (interruptedByUser) {
          setError(null);
          appendStopSystemMessageIfNeeded();
          setActivity({
            tone: 'complete',
            title: 'Turn stopped',
          });
        } else {
          setError(message);
          setActivity({
            tone: 'error',
            title: 'Turn failed',
            detail: message,
          });
        }

        setActiveTurnId(null);
        setStoppingTurn(false);
        stopRequestedRef.current = interruptedByUser;
        clearRunWatchdog();
      },
      [appendStopSystemMessageIfNeeded, clearRunWatchdog]
    );

    const interruptActiveTurn = useCallback(
      async (threadId: string, turnId: string) => {
        try {
          await api.interruptTurn(threadId, turnId);
          setError(null);
          setActivity({
            tone: 'running',
            title: 'Stopping turn',
          });
        } catch (error) {
          const message = (error as Error).message ?? String(error);
          setError(message);
          setActivity({
            tone: 'error',
            title: 'Failed to stop turn',
            detail: message,
          });
          setStoppingTurn(false);
          stopRequestedRef.current = false;
        }
      },
      [api]
    );

    const interruptLatestTurn = useCallback(
      async (threadId: string) => {
        try {
          const interruptedTurnId = await api.interruptLatestTurn(threadId);
          if (interruptedTurnId) {
            setActiveTurnId(interruptedTurnId);
            setError(null);
            setActivity({
              tone: 'running',
              title: 'Stopping turn',
            });
            return;
          }

          setStoppingTurn(false);
          stopRequestedRef.current = false;
          setActivity({
            tone: 'idle',
            title: 'No active turn found',
          });
        } catch (error) {
          const message = (error as Error).message ?? String(error);
          setError(message);
          setActivity({
            tone: 'error',
            title: 'Failed to stop turn',
            detail: message,
          });
          setStoppingTurn(false);
          stopRequestedRef.current = false;
        }
      },
      [api]
    );

    const registerTurnStarted = useCallback(
      (threadId: string, turnId: string) => {
        const currentChatId = chatIdRef.current;
        if (!threadId || !turnId || (currentChatId && currentChatId !== threadId)) {
          return;
        }

        setActiveTurnId(turnId);
        if (stopRequestedRef.current) {
          void interruptActiveTurn(threadId, turnId);
        }
      },
      [interruptActiveTurn]
    );

    const handleStopTurn = useCallback(() => {
      if (stoppingTurn) {
        return;
      }

      stopRequestedRef.current = true;
      stopSystemMessageLoggedRef.current = false;
      setStoppingTurn(true);
      setError(null);
      setActivity({
        tone: 'running',
        title: 'Stopping turn',
      });

      const threadId = chatIdRef.current;
      const turnId = activeTurnIdRef.current;
      if (threadId && turnId) {
        void interruptActiveTurn(threadId, turnId);
        return;
      }

      if (threadId) {
        void interruptLatestTurn(threadId);
        return;
      }

      setStoppingTurn(false);
      stopRequestedRef.current = false;
      setActivity({
        tone: 'idle',
        title: 'No active turn found',
      });
    }, [interruptActiveTurn, interruptLatestTurn, stoppingTurn]);

    const handleSlashCommand = useCallback(
      async (input: string): Promise<boolean> => {
        const parsed = parseSlashCommand(input);
        if (!parsed) {
          return false;
        }

        const { name: rawName, args } = parsed;
        const commandDef = findSlashCommandDefinition(rawName);
        const name = commandDef?.name ?? rawName;
        const argText = args.trim();

        if (!commandDef) {
          setError(`Unknown slash command: /${rawName}`);
          return true;
        }

        if (!commandDef.mobileSupported) {
          setError(commandDef.availabilityNote ?? `/${name} is available in Codex CLI only.`);
          return true;
        }

        if (name === 'help') {
          const lines = SLASH_COMMANDS.map((command) => {
            const suffix = command.argsHint ? ` ${command.argsHint}` : '';
            const scope = command.mobileSupported ? 'mobile' : 'CLI only';
            return `/${command.name}${suffix} — ${command.summary} (${scope})`;
          });
          appendLocalAssistantMessage(`Supported slash commands:\n${lines.join('\n')}`);
          return true;
        }

        if (name === 'new') {
          startNewChat();
          return true;
        }

        if (name === 'model') {
          if (!argText) {
            openModelModal();
            return true;
          }

          const models = modelOptions.length > 0 ? modelOptions : await api.listModels(false);
          if (modelOptions.length === 0) {
            setModelOptions(models);
          }
          const lowered = argText.toLowerCase();
          const match = models.find(
            (model) =>
              model.id.toLowerCase() === lowered ||
              model.displayName.toLowerCase() === lowered
          );

          if (!match) {
            setError(`Unknown model: ${argText}`);
            return true;
          }

          setSelectedModelId(match.id);
          setSelectedEffort(null);
          if (selectedChatId) {
            rememberChatModelPreference(
              selectedChatId,
              match.id,
              null,
              activeServiceTier
            );
          }
          if ((match.reasoningEffort?.length ?? 0) > 0) {
            setEffortPickerModelId(match.id);
            setEffortModalVisible(true);
          }
          setActivity({
            tone: 'complete',
            title: 'Model updated',
            detail: match.displayName,
          });
          setError(null);
          return true;
        }

        if (name === 'plan') {
          const lowered = argText.toLowerCase();
          if (!argText || lowered === 'on' || lowered === 'enable' || lowered === 'enabled') {
            setSelectedCollaborationMode('plan');
            setActivity({
              tone: 'complete',
              title: 'Plan mode enabled',
            });
            setError(null);
            return true;
          }

          if (
            lowered === 'off' ||
            lowered === 'disable' ||
            lowered === 'disabled' ||
            lowered === 'default' ||
            lowered === 'chat'
          ) {
            setSelectedCollaborationMode('default');
            setActivity({
              tone: 'complete',
              title: 'Default mode enabled',
            });
            setError(null);
            return true;
          }

          setSelectedCollaborationMode('plan');
          if (!selectedChatId) {
            const optimisticMessage: ChatTranscriptMessage = {
              id: `msg-${Date.now()}`,
              role: 'user',
              content: argText,
              createdAt: new Date().toISOString(),
            };

            setDraft('');
            try {
              setCreating(true);
              setActiveTurnId(null);
              setStoppingTurn(false);
              stopRequestedRef.current = false;
              setActivePlan(null);
              setPendingUserInputRequest(null);
              setUserInputDrafts({});
              setUserInputError(null);
              setResolvingUserInput(false);
              setActivity({
                tone: 'running',
                title: 'Creating chat',
              });
              const created = await api.createChat({
                cwd: preferredStartCwd ?? undefined,
                model: activeModelId ?? undefined,
                effort: activeEffort ?? undefined,
                serviceTier: activeServiceTier ?? undefined,
                approvalPolicy: activeApprovalPolicy,
              });

              setSelectedChatId(created.id);
              setSelectedChat({
                ...created,
                status: 'running',
                updatedAt: new Date().toISOString(),
                statusUpdatedAt: new Date().toISOString(),
                lastMessagePreview: argText.slice(0, 50),
                messages: [...created.messages, optimisticMessage],
              });

              setActivity({
                tone: 'running',
                title: 'Sending plan prompt',
              });
              bumpRunWatchdog();

              const updated = await api.sendChatMessage(created.id, {
                content: argText,
                cwd: created.cwd ?? preferredStartCwd ?? undefined,
                model: activeModelId ?? undefined,
                effort: activeEffort ?? undefined,
                serviceTier: activeServiceTier ?? undefined,
                approvalPolicy: activeApprovalPolicy,
                collaborationMode: 'plan',
              }, {
                onTurnStarted: (turnId) => registerTurnStarted(created.id, turnId),
              });
              const autoEnabledPlan = shouldAutoEnablePlanModeFromChat(updated);
              if (autoEnabledPlan) {
                setSelectedCollaborationMode('plan');
              }
              rememberChatModelPreference(
                created.id,
                activeModelId,
                selectedEffort ?? activeEffort,
                activeServiceTier
              );
              setSelectedChat(updated);
              setError(null);
              setActivity({
                tone: 'complete',
                title: 'Turn completed',
                detail:
                  autoEnabledPlan
                    ? 'Plan mode enabled for the next turn'
                    : undefined,
              });
              clearRunWatchdog();
            } catch (err) {
              handleTurnFailure(err);
            } finally {
              setCreating(false);
            }
            return true;
          }

          const optimisticMessage: ChatTranscriptMessage = {
            id: `msg-${Date.now()}`,
            role: 'user',
            content: argText,
            createdAt: new Date().toISOString(),
          };

            try {
              setSending(true);
              setActiveTurnId(null);
              setStoppingTurn(false);
              stopRequestedRef.current = false;
              setActivePlan(null);
              cacheThreadPlan(selectedChatId, null);
              setPendingUserInputRequest(null);
              setUserInputDrafts({});
              setUserInputError(null);
              setResolvingUserInput(false);
            setActivity({
              tone: 'running',
              title: 'Sending plan prompt',
            });
            bumpRunWatchdog();
            setDraft('');
            setSelectedChat((prev) => {
              const baseChat =
                selectedChat?.id === selectedChatId
                  ? selectedChat
                  : prev?.id === selectedChatId
                    ? prev
                    : prev;
              if (!baseChat) {
                return prev;
              }
              return {
                ...baseChat,
                messages: [...baseChat.messages, optimisticMessage],
              };
            });
            scrollToBottomReliable(true);
            const updated = await api.sendChatMessage(selectedChatId, {
              content: argText,
              cwd: selectedChat?.cwd,
              model: activeModelId ?? undefined,
              effort: activeEffort ?? undefined,
              serviceTier: activeServiceTier ?? undefined,
              approvalPolicy: activeApprovalPolicy,
              collaborationMode: 'plan',
            }, {
              onTurnStarted: (turnId) => registerTurnStarted(selectedChatId, turnId),
            });
            rememberChatModelPreference(
              selectedChatId,
              activeModelId,
              selectedEffort ?? activeEffort,
              activeServiceTier
            );
            setSelectedChat(updated);
            setError(null);
            setActivity({
              tone: 'complete',
              title: 'Turn completed',
            });
            clearRunWatchdog();
          } catch (err) {
            handleTurnFailure(err);
          } finally {
            setSending(false);
          }

          return true;
        }

        if (name === 'status') {
          const lines = [
            `Model: ${activeModelLabel}`,
            `Reasoning: ${activeEffortLabel}`,
            `Fast mode: ${fastModeEnabled ? 'On' : 'Off'}`,
            `Mode: ${formatCollaborationModeLabel(selectedCollaborationMode)}`,
            `Default workspace: ${preferredStartCwd ?? 'Bridge default workspace'}`,
          ];
          if (selectedChat) {
            lines.push(`Chat: ${selectedChat.title || selectedChat.id}`);
            lines.push(`Chat workspace: ${selectedChat.cwd ?? 'Not set'}`);
            lines.push(`Chat status: ${selectedChat.status}`);
          }
          appendLocalAssistantMessage(lines.join('\n'));
          return true;
        }

        if (name === 'rename') {
          const activeChatId = selectedChatId ?? selectedChat?.id ?? null;
          if (!activeChatId) {
            setError('/rename requires an open chat');
            return true;
          }

          if (!argText) {
            openRenameModal();
            return true;
          }

          try {
            setRenaming(true);
            const updated = await api.renameChat(activeChatId, argText);
            setSelectedChat(updated);
            setActivity({
              tone: 'complete',
              title: 'Chat renamed',
              detail: updated.title,
            });
            setError(null);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setRenaming(false);
          }
          return true;
        }

        if (name === 'compact') {
          if (!selectedChatId) {
            setError('/compact requires an open chat');
            return true;
          }

          try {
            setActivity({
              tone: 'running',
              title: 'Compacting thread',
            });
            await api.compactChat(selectedChatId);
            bumpRunWatchdog();
            setError(null);
          } catch (err) {
            setError((err as Error).message);
            setActivity({
              tone: 'error',
              title: 'Compact failed',
              detail: (err as Error).message,
            });
          }
          return true;
        }

        if (name === 'review') {
          if (!selectedChatId) {
            setError('/review requires an open chat');
            return true;
          }

          try {
            setActivity({
              tone: 'running',
              title: 'Starting review',
            });
            await api.reviewChat(selectedChatId);
            bumpRunWatchdog();
            setError(null);
          } catch (err) {
            setError((err as Error).message);
            setActivity({
              tone: 'error',
              title: 'Review failed',
              detail: (err as Error).message,
            });
          }
          return true;
        }

        if (name === 'fork') {
          if (!selectedChatId) {
            setError('/fork requires an open chat');
            return true;
          }

          try {
            setCreating(true);
            setActivity({
              tone: 'running',
              title: 'Forking chat',
            });
            const forked = await api.forkChat(selectedChatId, {
              cwd: selectedChat?.cwd,
              model: activeModelId ?? undefined,
              serviceTier: activeServiceTier ?? undefined,
              approvalPolicy: activeApprovalPolicy,
            });
            setSelectedChatId(forked.id);
            rememberChatModelPreference(
              forked.id,
              activeModelId,
              selectedEffort ?? activeEffort,
              activeServiceTier
            );
            setSelectedChat(forked);
            setError(null);
            setActivity({
              tone: 'complete',
              title: 'Chat forked',
            });
          } catch (err) {
            setError((err as Error).message);
            setActivity({
              tone: 'error',
              title: 'Fork failed',
              detail: (err as Error).message,
            });
          } finally {
            setCreating(false);
          }
          return true;
        }

        if (name === 'diff') {
          if (!selectedChat) {
            setError('/diff requires an open chat');
            return true;
          }

          onOpenGit(selectedChat);
          return true;
        }

        setError(`Unsupported slash command on mobile: /${name}`);
        return true;
      },
      [
        activeEffort,
        activeModelId,
        activeEffortLabel,
        activeModelLabel,
        activeApprovalPolicy,
        activeServiceTier,
        api,
        appendLocalAssistantMessage,
        bumpRunWatchdog,
        clearRunWatchdog,
        fastModeEnabled,
        modelOptions,
        onOpenGit,
        openModelModal,
        openRenameModal,
        preferredStartCwd,
        registerTurnStarted,
        selectedChat,
        selectedChatId,
        selectedCollaborationMode,
        handleTurnFailure,
        rememberChatModelPreference,
        scrollToBottomReliable,
        startNewChat,
      ]
    );

    const loadChat = useCallback(
      async (
        chatId: string,
        options?: { forceScroll?: boolean; preserveRuntimeState?: boolean }
      ) => {
        const requestId = loadChatRequestRef.current + 1;
        loadChatRequestRef.current = requestId;
        let loadedSuccessfully = false;
        try {
          const chat = await api.getChat(chatId);
          if (requestId !== loadChatRequestRef.current) {
            return;
          }
          loadedSuccessfully = true;
          const shouldPreserveRuntimeState = Boolean(
            options?.preserveRuntimeState && chatId === chatIdRef.current
          );
          setSelectedChatId(chatId);
          setSelectedChat(chat);
          setError(null);
          if (!shouldPreserveRuntimeState) {
            setActiveCommands([]);
            setPendingApproval(null);
            setStreamingText(null);
            setActiveTurnId(null);
            setStoppingTurn(false);
            stopSystemMessageLoggedRef.current = false;
            const shouldRun = isChatLikelyRunning(chat);
            if (shouldRun) {
              bumpRunWatchdog();
              setActivity({
                tone: 'running',
                title: 'Working',
              });
            } else {
              clearRunWatchdog();
              setActivity(
                chat.status === 'complete'
                  ? {
                      tone: 'complete',
                      title: 'Turn completed',
                    }
                  : chat.status === 'error'
                    ? {
                        tone: 'error',
                        title: 'Turn failed',
                        detail: chat.lastError ?? undefined,
                      }
                    : {
                        tone: 'idle',
                        title: 'Ready',
                      }
              );
            }
            reasoningSummaryRef.current = {};
            codexReasoningBufferRef.current = '';
            hadCommandRef.current = false;
            applyThreadRuntimeSnapshot(chatId);
          }
          void refreshPendingApprovalsForThread(chatId);
        } catch (err) {
          if (requestId !== loadChatRequestRef.current) {
            return;
          }
          setError((err as Error).message);
          setActivity({
            tone: 'error',
            title: 'Failed to load chat',
            detail: (err as Error).message,
          });
        } finally {
          if (requestId !== loadChatRequestRef.current) {
            return;
          }

          if (loadedSuccessfully) {
            if (options?.forceScroll) {
              scrollToBottomReliable(false);
            } else {
              scrollToBottomIfPinned(false);
            }
            setOpeningChatId((current) => (current === chatId ? null : current));
          } else {
            setOpeningChatId(null);
          }
        }
      },
      [
        api,
        applyThreadRuntimeSnapshot,
        bumpRunWatchdog,
        clearRunWatchdog,
        refreshPendingApprovalsForThread,
        scrollToBottomIfPinned,
        scrollToBottomReliable,
      ]
    );

    const openChatThread = useCallback(
      (id: string, optimisticChat?: Chat | null) => {
        const hasSnapshot = Boolean(
          optimisticChat &&
            optimisticChat.id === id &&
            optimisticChat.messages.length > 0
        );

        setSelectedChatId(id);
        setOpeningChatId(hasSnapshot ? null : id);
        setSending(false);
        setCreating(false);
        setError(null);
        setPendingUserInputRequest(null);
        setUserInputDrafts({});
        setUserInputError(null);
        setResolvingUserInput(false);
        setAttachmentModalVisible(false);
        setAttachmentPathDraft('');
        setPendingMentionPaths([]);
        setPendingLocalImagePaths([]);
        setActivePlan(null);
        setActiveTurnId(null);
        setStoppingTurn(false);
        setQueuedMessages([]);
        setQueueDispatching(false);
        setQueuePaused(false);
        stopRequestedRef.current = false;
        stopSystemMessageLoggedRef.current = false;

        if (hasSnapshot && optimisticChat) {
          setSelectedChat(optimisticChat);
        } else {
          setSelectedChat(null);
        }
        setActivity({
          tone: 'running',
          title: 'Opening chat',
        });

        applyThreadRuntimeSnapshot(id);
        void refreshPendingApprovalsForThread(id);
        loadChat(id, { forceScroll: true }).catch(() => {});
      },
      [
        applyThreadRuntimeSnapshot,
        loadChat,
        refreshPendingApprovalsForThread,
      ]
    );

    useImperativeHandle(ref, () => ({
      openChat: (id: string, optimisticChat?: Chat | null) => {
        openChatThread(id, optimisticChat);
      },
      startNewChat: () => {
        startNewChat();
      },
    }));

    useEffect(() => {
      if (!pendingOpenChatId) {
        return;
      }

      const snapshot =
        pendingOpenChatSnapshot && pendingOpenChatSnapshot.id === pendingOpenChatId
          ? pendingOpenChatSnapshot
          : null;

      openChatThread(pendingOpenChatId, snapshot);
      onPendingOpenChatHandled?.();
    }, [
      onPendingOpenChatHandled,
      openChatThread,
      pendingOpenChatId,
      pendingOpenChatSnapshot,
    ]);

    const createChat = useCallback(async () => {
      const content = draft.trim();
      if (!content) return;

      if (await handleSlashCommand(content)) {
        setDraft('');
        return;
      }

      const turnMentions = pendingMentionPaths.map((path) => toMentionInput(path));
      const turnLocalImages = pendingLocalImagePaths.map((path) => ({ path }));
      const optimisticContent = toOptimisticUserContent(content, turnMentions, turnLocalImages);

      const optimisticMessage: ChatTranscriptMessage = {
        id: `msg-${Date.now()}`,
        role: 'user',
        content: optimisticContent,
        createdAt: new Date().toISOString(),
      };

      setDraft('');

      try {
        setCreating(true);
        setActiveTurnId(null);
        setStoppingTurn(false);
        stopRequestedRef.current = false;
        setActivePlan(null);
        setPendingUserInputRequest(null);
        setUserInputDrafts({});
        setUserInputError(null);
        setResolvingUserInput(false);
        setActivity({
          tone: 'running',
          title: 'Creating chat',
        });
        const created = await api.createChat({
          cwd: preferredStartCwd ?? undefined,
          model: activeModelId ?? undefined,
          effort: activeEffort ?? undefined,
          serviceTier: activeServiceTier ?? undefined,
          approvalPolicy: activeApprovalPolicy,
        });

        setSelectedChatId(created.id);
        setSelectedChat({
          ...created,
          status: 'running',
          updatedAt: new Date().toISOString(),
          statusUpdatedAt: new Date().toISOString(),
          lastMessagePreview: content.slice(0, 50),
          messages: [...created.messages, optimisticMessage],
        });
        scrollToBottomReliable(true);

        setActivity({
          tone: 'running',
          title: 'Working',
        });
        bumpRunWatchdog();

        const updated = await api.sendChatMessage(
          created.id,
          {
            content,
            mentions: turnMentions,
            localImages: turnLocalImages,
            cwd: created.cwd ?? preferredStartCwd ?? undefined,
            model: activeModelId ?? undefined,
            effort: activeEffort ?? undefined,
            serviceTier: activeServiceTier ?? undefined,
            approvalPolicy: activeApprovalPolicy,
            collaborationMode: selectedCollaborationMode,
          },
          {
            onTurnStarted: (turnId) => registerTurnStarted(created.id, turnId),
          }
        );
        const autoEnabledPlan = shouldAutoEnablePlanModeFromChat(updated);
        if (autoEnabledPlan) {
          setSelectedCollaborationMode('plan');
        }
        rememberChatModelPreference(
          created.id,
          activeModelId,
          selectedEffort ?? activeEffort,
          activeServiceTier
        );
        setSelectedChat(updated);
        setPendingMentionPaths([]);
        setPendingLocalImagePaths([]);
        setError(null);
        if (updated.status === 'complete') {
          setActivity({
            tone: 'complete',
            title: 'Turn completed',
            detail:
              autoEnabledPlan && selectedCollaborationMode !== 'plan'
                ? 'Plan mode enabled for the next turn'
                : undefined,
          });
          clearRunWatchdog();
        } else if (updated.status === 'error') {
          setActivity({
            tone: 'error',
            title: 'Turn failed',
            detail: updated.lastError ?? undefined,
          });
          clearRunWatchdog();
        } else {
          // 'running' or 'idle' (server may not have started yet) — keep working
          setActivity({
            tone: 'running',
            title: 'Working',
          });
          bumpRunWatchdog();
        }
      } catch (err) {
        handleTurnFailure(err);
      } finally {
        setCreating(false);
      }
    }, [
      api,
      draft,
      activeEffort,
      activeModelId,
      activeApprovalPolicy,
      activeServiceTier,
      handleSlashCommand,
      pendingMentionPaths,
      pendingLocalImagePaths,
      preferredStartCwd,
      selectedCollaborationMode,
      registerTurnStarted,
      handleTurnFailure,
      bumpRunWatchdog,
      clearRunWatchdog,
      rememberChatModelPreference,
      scrollToBottomReliable,
    ]);

    const sendMessageContent = useCallback(
      async (
        rawContent: string,
        options?: {
          allowSlashCommands?: boolean;
          collaborationMode?: CollaborationMode;
          mentions?: MentionInput[];
          localImages?: LocalImageInput[];
          clearComposer?: boolean;
          preservePlan?: boolean;
        }
      ) => {
        const content = rawContent.trim();
        if (!selectedChatId || !content) {
          return false;
        }

        const shouldClearComposer = options?.clearComposer ?? true;
        const shouldPreservePlan = options?.preservePlan ?? false;
        if (options?.allowSlashCommands && (await handleSlashCommand(content))) {
          if (shouldClearComposer) {
            setDraft('');
          }
          return true;
        }
        const resolvedCollaborationMode =
          options?.collaborationMode ?? selectedCollaborationMode;
        const turnMentions =
          options?.mentions ?? pendingMentionPaths.map((path) => toMentionInput(path));
        const turnLocalImages =
          options?.localImages ?? pendingLocalImagePaths.map((path) => ({ path }));
        const optimisticContent = toOptimisticUserContent(content, turnMentions, turnLocalImages);

        const optimisticMessage: ChatTranscriptMessage = {
          id: `msg-${Date.now()}`,
          role: 'user',
          content: optimisticContent,
          createdAt: new Date().toISOString(),
        };

        try {
          setSending(true);
          setActiveTurnId(null);
          setStoppingTurn(false);
          stopRequestedRef.current = false;
          if (!shouldPreservePlan) {
            setActivePlan(null);
            cacheThreadPlan(selectedChatId, null);
          }
          setPendingUserInputRequest(null);
          setUserInputDrafts({});
          setUserInputError(null);
          setResolvingUserInput(false);
          setActivity({
            tone: 'running',
            title: 'Sending message',
          });
          bumpRunWatchdog();
          if (shouldClearComposer) {
            setDraft('');
          }
          setSelectedChat((prev) => {
            const baseChat =
              selectedChat?.id === selectedChatId
                ? selectedChat
                : prev?.id === selectedChatId
                  ? prev
                  : prev;
            if (!baseChat) {
              return prev;
            }
            return {
              ...baseChat,
              messages: [...baseChat.messages, optimisticMessage],
            };
          });
          scrollToBottomReliable(true);
          const updated = await api.sendChatMessage(
            selectedChatId,
            {
              content,
              mentions: turnMentions,
              localImages: turnLocalImages,
              cwd: selectedChat?.cwd,
              model: activeModelId ?? undefined,
              effort: activeEffort ?? undefined,
              serviceTier: activeServiceTier ?? undefined,
              approvalPolicy: activeApprovalPolicy,
              collaborationMode: resolvedCollaborationMode,
            },
            {
              onTurnStarted: (turnId) => registerTurnStarted(selectedChatId, turnId),
            }
          );
          const autoEnabledPlan = shouldAutoEnablePlanModeFromChat(updated);
          if (autoEnabledPlan) {
            setSelectedCollaborationMode('plan');
          }
          rememberChatModelPreference(
            selectedChatId,
            activeModelId,
            selectedEffort ?? activeEffort,
            activeServiceTier
          );
          setSelectedChat(updated);
          if (shouldClearComposer) {
            setPendingMentionPaths([]);
            setPendingLocalImagePaths([]);
          }
          setError(null);
          if (updated.status === 'complete') {
            setActivity({
              tone: 'complete',
              title: 'Turn completed',
              detail:
                autoEnabledPlan && resolvedCollaborationMode !== 'plan'
                  ? 'Plan mode enabled for the next turn'
                  : undefined,
            });
            clearRunWatchdog();
          } else if (updated.status === 'error') {
            setActivity({
              tone: 'error',
              title: 'Turn failed',
              detail: updated.lastError ?? undefined,
            });
            clearRunWatchdog();
          } else {
            // 'running' or 'idle' (server may not have started yet) — keep working
            setActivity({
              tone: 'running',
              title: 'Working',
            });
            bumpRunWatchdog();
          }
        } catch (err) {
          handleTurnFailure(err);
          return false;
        } finally {
          setSending(false);
        }

        return true;
      },
      [
        activeEffort,
        activeModelId,
        activeApprovalPolicy,
        activeServiceTier,
        api,
        cacheThreadPlan,
        handleSlashCommand,
        pendingMentionPaths,
        pendingLocalImagePaths,
        selectedCollaborationMode,
        selectedChat,
        selectedChatId,
        registerTurnStarted,
        handleTurnFailure,
        bumpRunWatchdog,
        clearRunWatchdog,
        rememberChatModelPreference,
        scrollToBottomReliable,
      ]
    );

    const sendMessage = useCallback(async () => {
      const content = draft.trim();
      if (!content) {
        return;
      }

      setQueuePaused(false);

      if (uploadingAttachment) {
        setError('Please wait for attachments to finish uploading.');
        return;
      }

      if (await handleSlashCommand(content)) {
        setDraft('');
        return;
      }

      const isTurnBlocked =
        sending ||
        creating ||
        stoppingTurn ||
        Boolean(activeTurnIdRef.current) ||
        Boolean(pendingApproval?.id) ||
        Boolean(pendingUserInputRequest?.id) ||
        (selectedChat ? isChatLikelyRunning(selectedChat) : false);

      if (isTurnBlocked) {
        const queuedMentions = pendingMentionPaths.map((path) => toMentionInput(path));
        const queuedLocalImages = pendingLocalImagePaths.map((path) => ({ path }));
        setQueuedMessages((prev) => [
          ...prev,
          {
            id: createQueuedMessageId(),
            createdAt: new Date().toISOString(),
            content,
            mentions: queuedMentions,
            localImages: queuedLocalImages,
            collaborationMode: selectedCollaborationMode,
          },
        ]);
        setDraft('');
        setPendingMentionPaths([]);
        setPendingLocalImagePaths([]);
        setError(null);
        return;
      }

      await sendMessageContent(content, { allowSlashCommands: false });
    }, [
      creating,
      draft,
      handleSlashCommand,
      pendingApproval?.id,
      pendingLocalImagePaths,
      pendingMentionPaths,
      pendingUserInputRequest?.id,
      selectedChat,
      selectedCollaborationMode,
      sendMessageContent,
      sending,
      stoppingTurn,
      setQueuePaused,
      uploadingAttachment,
    ]);

    const stayInPlanMode = useCallback(() => {
      if (!selectedChatId) {
        return;
      }

      setSelectedCollaborationMode('plan');
      clearPendingPlanImplementationPrompt(selectedChatId);
    }, [clearPendingPlanImplementationPrompt, selectedChatId]);

    const implementPlan = useCallback(async () => {
      if (!selectedChatId) {
        return;
      }

      const prompt = pendingPlanImplementationPrompts[selectedChatId];
      if (!prompt) {
        return;
      }

      clearPendingPlanImplementationPrompt(prompt.threadId);
      setSelectedCollaborationMode('default');
      const sent = await sendMessageContent(PLAN_IMPLEMENTATION_CODING_MESSAGE, {
        collaborationMode: 'default',
        clearComposer: false,
        preservePlan: true,
      });
      if (!sent) {
        setPendingPlanImplementationPrompts((prev) => ({
          ...prev,
          [prompt.threadId]: prompt,
        }));
      }
    }, [
      clearPendingPlanImplementationPrompt,
      pendingPlanImplementationPrompts,
      selectedChatId,
      sendMessageContent,
    ]);

    const handleSteerQueuedMessage = useCallback(async () => {
      const threadId = selectedChatId?.trim();
      const expectedTurnId = activeTurnIdRef.current?.trim() ?? '';
      const nextQueuedMessage = queuedMessages[0] ?? null;
      const canSteer =
        Boolean(threadId) &&
        Boolean(expectedTurnId) &&
        Boolean(nextQueuedMessage) &&
        !pendingApproval?.id &&
        !pendingUserInputRequest?.id &&
        Boolean(selectedChat && isChatLikelyRunning(selectedChat));

      if (!threadId || !expectedTurnId || !nextQueuedMessage || !canSteer) {
        return;
      }

      try {
        setError(null);
        await api.steerChatTurn(threadId, expectedTurnId, {
          content: nextQueuedMessage.content,
          mentions: nextQueuedMessage.mentions,
          localImages: nextQueuedMessage.localImages,
        });
        setQueuedMessages((prev) =>
          prev[0]?.id === nextQueuedMessage.id ? prev.slice(1) : prev
        );
      } catch (err) {
        setError((err as Error).message);
      }
    }, [
      api,
      pendingApproval?.id,
      pendingUserInputRequest?.id,
      queuedMessages,
      selectedChat,
      selectedChatId,
    ]);

    useEffect(() => {
      if (!selectedChatId || queuedMessages.length === 0 || queueDispatching || queuePaused) {
        return;
      }

      const isTurnBlocked =
        sending ||
        creating ||
        stoppingTurn ||
        uploadingAttachment ||
        Boolean(activeTurnId) ||
        Boolean(pendingApproval?.id) ||
        Boolean(pendingUserInputRequest?.id) ||
        (selectedChat ? isChatLikelyRunning(selectedChat) : false);
      if (isTurnBlocked) {
        return;
      }

      const nextMessage = queuedMessages[0];
      setQueueDispatching(true);
      void (async () => {
        const sent = await sendMessageContent(nextMessage.content, {
          allowSlashCommands: false,
          collaborationMode: nextMessage.collaborationMode,
          mentions: nextMessage.mentions,
          localImages: nextMessage.localImages,
          clearComposer: false,
        });
        if (sent) {
          setQueuedMessages((prev) => prev.slice(1));
        } else {
          setQueuePaused(true);
        }
        setQueueDispatching(false);
      })();
    }, [
      activeTurnId,
      creating,
      pendingApproval?.id,
      pendingUserInputRequest?.id,
      queueDispatching,
      queuePaused,
      queuedMessages,
      selectedChat,
      selectedChatId,
      sendMessageContent,
      sending,
      stoppingTurn,
      uploadingAttachment,
    ]);

    const handleInlineOptionSelect = useCallback(
      (value: string) => {
        const option = value.trim();
        if (!option) {
          return;
        }

        const cannotAutoSend =
          !selectedChatId ||
          sending ||
          creating ||
          stoppingTurn ||
          Boolean(activeTurnId) ||
          Boolean(pendingApproval?.id) ||
          Boolean(pendingUserInputRequest?.id) ||
          (selectedChat ? isChatLikelyRunning(selectedChat) : false);
        if (cannotAutoSend) {
          setDraft(option);
          return;
        }

        void sendMessageContent(option, { allowSlashCommands: false });
      },
      [
        creating,
        activeTurnId,
        pendingApproval?.id,
        pendingUserInputRequest?.id,
        selectedChat,
        selectedChatId,
        sendMessageContent,
        sending,
        stoppingTurn,
      ]
    );

    useEffect(() => {
      const pendingApprovalId = pendingApproval?.id;
      const pendingUserInputRequestId = pendingUserInputRequest?.id;

      return ws.onEvent((event: RpcNotification) => {
        const currentId = chatIdRef.current;

        if (event.method === 'account/rateLimits/updated') {
          const params = toRecord(event.params);
          const snapshot = readAccountRateLimitSnapshot(
            params?.rateLimits ?? params?.rate_limits ?? event.params
          );
          accountRateLimitsRef.current = snapshot;
          setAccountRateLimits(snapshot);
          return;
        }

        if (event.method === 'thread/name/updated') {
          const params = toRecord(event.params);
          const threadId = extractNotificationThreadId(params);
          if (!threadId || threadId !== currentId) {
            return;
          }

          const threadName =
            readString(params?.threadName) ?? readString(params?.thread_name);
          if (threadName && threadName.trim()) {
            setSelectedChat((prev) =>
              prev
                ? {
                    ...prev,
                    title: threadName,
                  }
                : prev
            );
          } else {
            loadChat(threadId, { preserveRuntimeState: true }).catch(() => {});
          }
          return;
        }

        if (event.method.startsWith('codex/event/')) {
          const params = toRecord(event.params);
          const msg = toRecord(params?.msg);
          const codexEventType = normalizeCodexEventType(
            readString(msg?.type) ?? event.method.replace('codex/event/', '')
          );
          if (!codexEventType) {
            return;
          }
          const threadId = extractNotificationThreadId(params, msg);

          if (codexEventType === 'tokencount') {
            const rateLimitSnapshot = readAccountRateLimitSnapshot(
              msg?.rate_limits ?? msg?.rateLimits
            );
            if (rateLimitSnapshot && !accountRateLimitsRef.current) {
              // Token-count events can lag behind account-level rate-limit reads.
              // Only use them as a bootstrap source when we have no account snapshot yet.
              accountRateLimitsRef.current = rateLimitSnapshot;
              setAccountRateLimits(rateLimitSnapshot);
            }

            const contextUsage = readThreadContextUsage(msg);
            if (threadId && contextUsage) {
              cacheThreadContextUsage(threadId, contextUsage);
              if (threadId === currentId) {
                setThreadContextUsage((previous) =>
                  mergeThreadContextUsage(previous, contextUsage)
                );
              }
            }
            return;
          }

          if (!currentId) {
            if (threadId) {
              cacheCodexRuntimeForThread(threadId, codexEventType, msg);
            }
            return;
          }

          const isMatchingThread = Boolean(threadId) && threadId === currentId;
          const isUnscopedRunEvent =
            !threadId &&
            Boolean(currentId) &&
            (isCodexRunHeartbeatEvent(codexEventType) ||
              CODEX_RUN_COMPLETION_EVENT_TYPES.has(codexEventType) ||
              CODEX_RUN_ABORT_EVENT_TYPES.has(codexEventType) ||
              CODEX_RUN_FAILURE_EVENT_TYPES.has(codexEventType));

          if (!isMatchingThread && !isUnscopedRunEvent) {
            if (threadId) {
              cacheCodexRuntimeForThread(threadId, codexEventType, msg);
            }
            return;
          }

          const activeThreadId = threadId ?? currentId;

          if (isCodexRunHeartbeatEvent(codexEventType)) {
            bumpRunWatchdog();
            scheduleExternalStatusFullSync(activeThreadId);
          }

          if (codexEventType === 'taskstarted') {
            setActivity({
              tone: 'running',
              title: 'Working',
            });
            return;
          }

          if (
            codexEventType === 'agentreasoningdelta' ||
            codexEventType === 'reasoningcontentdelta' ||
            codexEventType === 'reasoningrawcontentdelta' ||
            codexEventType === 'agentreasoningrawcontentdelta'
          ) {
            const delta = readString(msg?.delta);
            if (!delta) {
              return;
            }

            codexReasoningBufferRef.current += delta;
            const heading =
              extractFirstBoldSnippet(codexReasoningBufferRef.current, 56) ??
              extractFirstBoldSnippet(delta, 56);
            const summary = toTickerSnippet(stripMarkdownInline(delta), 64);

            setActivity({
              tone: 'running',
              title: heading ?? 'Reasoning',
              detail: heading ? undefined : summary ?? undefined,
            });

            return;
          }

          if (codexEventType === 'agentreasoningsectionbreak') {
            codexReasoningBufferRef.current = '';
            return;
          }

          if (
            codexEventType === 'agentmessagedelta' ||
            codexEventType === 'agentmessagecontentdelta'
          ) {
            const delta = readString(msg?.delta);
            if (!delta) {
              return;
            }

            if (hadCommandRef.current) {
              setStreamingText(delta);
              hadCommandRef.current = false;
            } else {
              setStreamingText((prev) => mergeStreamingDelta(prev, delta));
            }

            setActivity((prev) =>
              prev.tone === 'running' && prev.title === 'Thinking'
                ? prev
                : {
                    tone: 'running',
                    title: 'Thinking',
                  }
            );
            scrollToBottomIfPinned(true);
            return;
          }

          if (codexEventType === 'execcommandbegin') {
            setActivity({
              tone: 'running',
              title: 'Working',
            });
            return;
          }

          if (codexEventType === 'execcommandend') {
            const status = readString(msg?.status);
            const failed = status === 'failed' || status === 'error';

            setActivity({
              tone: failed ? 'error' : 'running',
              title: failed ? 'Turn failed' : 'Working',
            });
            return;
          }

          if (codexEventType === 'mcpstartupupdate') {
            setActivity({
              tone: 'running',
              title: 'Working',
            });
            return;
          }

          if (codexEventType === 'mcptoolcallbegin') {
            setActivity({
              tone: 'running',
              title: 'Working',
            });
            return;
          }

          if (codexEventType === 'websearchbegin') {
            const searchEvent = describeWebSearchToolEvent(msg);
            if (searchEvent) {
              cacheThreadActiveCommand(
                activeThreadId,
                searchEvent.eventType,
                searchEvent.detail
              );
              pushActiveCommand(activeThreadId, searchEvent.eventType, searchEvent.detail);
            }
            setActivity({
              tone: 'running',
              title: 'Working',
            });
            return;
          }

          if (codexEventType === 'backgroundevent') {
            const message =
              toTickerSnippet(readString(msg?.message), 72) ??
              toTickerSnippet(readString(msg?.text), 72);
            setActivity({
              tone: 'running',
              title: message ?? 'Working',
            });
            return;
          }

          if (CODEX_RUN_ABORT_EVENT_TYPES.has(codexEventType)) {
            const interruptedByUser = stopRequestedRef.current;
            clearRunWatchdog();
            setActiveCommands([]);
            setStreamingText(null);
            setActiveTurnId(null);
            setStoppingTurn(false);
            stopRequestedRef.current = interruptedByUser;
            reasoningSummaryRef.current = {};
            codexReasoningBufferRef.current = '';
            hadCommandRef.current = false;
            if (interruptedByUser) {
              setError(null);
              appendStopSystemMessageIfNeeded();
            }
            setActivity({
              tone: interruptedByUser ? 'complete' : 'error',
              title: interruptedByUser ? 'Turn stopped' : 'Turn interrupted',
            });
            loadChat(activeThreadId).catch(() => {});
            return;
          }

          if (CODEX_RUN_FAILURE_EVENT_TYPES.has(codexEventType)) {
            clearRunWatchdog();
            setActiveCommands([]);
            setStreamingText(null);
            setActiveTurnId(null);
            setStoppingTurn(false);
            stopRequestedRef.current = false;
            reasoningSummaryRef.current = {};
            codexReasoningBufferRef.current = '';
            hadCommandRef.current = false;
            setActivity({
              tone: 'error',
              title: 'Turn failed',
            });
            loadChat(activeThreadId).catch(() => {});
            return;
          }

          if (CODEX_RUN_COMPLETION_EVENT_TYPES.has(codexEventType)) {
            clearRunWatchdog();
            setActiveTurnId(null);
            setStoppingTurn(false);
            stopRequestedRef.current = false;
            setActivity({
              tone: 'complete',
              title: 'Turn completed',
            });
            setStreamingText(null);
            reasoningSummaryRef.current = {};
            codexReasoningBufferRef.current = '';
            hadCommandRef.current = false;
            loadChat(activeThreadId).catch(() => {});
            return;
          }

          if (isCodexRunHeartbeatEvent(codexEventType)) {
            setActivity((prev) =>
              prev.tone === 'running'
                ? prev
                : {
                    tone: 'running',
                    title: 'Working',
                  }
            );
          }
          return;
        }

        // Streaming delta -> transient thinking text
        if (event.method === 'item/agentMessage/delta') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
          const delta = readString(params?.delta);
          if (!threadId || !delta) return;
          if (currentId !== threadId) {
            cacheThreadStreamingDelta(threadId, delta);
            cacheThreadTurnState(threadId, {
              runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
            });
            cacheThreadActivity(threadId, {
              tone: 'running',
              title: 'Thinking',
            });
            return;
          }

          bumpRunWatchdog();
          if (hadCommandRef.current) {
            setStreamingText(delta);
            hadCommandRef.current = false;
          } else {
            setStreamingText((prev) => mergeStreamingDelta(prev, delta));
          }
          setActivity((prev) =>
            prev.tone === 'running' && prev.title === 'Thinking'
              ? prev
              : {
                  tone: 'running',
                  title: 'Thinking',
                }
          );
          scrollToBottomIfPinned(true);
          return;
        }

        if (event.method === 'thread/tokenUsage/updated') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
          const contextUsage = readThreadContextUsage(params);
          if (!threadId || !contextUsage) {
            return;
          }
          cacheThreadContextUsage(threadId, contextUsage);
          if (threadId === currentId) {
            setThreadContextUsage((previous) =>
              mergeThreadContextUsage(previous, contextUsage)
            );
          }
          return;
        }

        if (event.method === 'turn/started') {
          const params = toRecord(event.params);
          const threadId =
            readString(params?.threadId) ??
            readString(params?.thread_id) ??
            readString(toRecord(params?.turn)?.threadId) ??
            readString(toRecord(params?.turn)?.thread_id);
          if (!threadId) {
            return;
          }
          const startedContextUsage = readThreadContextUsage(params);
          const turn = toRecord(params?.turn);
          const startedTurnId =
            readString(params?.turnId) ??
            readString(params?.turn_id) ??
            readString(turn?.id) ??
            readString(turn?.turnId) ??
            null;
          if (threadId !== currentId) {
            if (startedContextUsage) {
              cacheThreadContextUsage(threadId, startedContextUsage);
            }
            upsertThreadRuntimeSnapshot(threadId, () => ({
              activeCommands: [],
              streamingText: null,
            }));
            cacheThreadTurnState(threadId, {
              activeTurnId: startedTurnId,
              runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
            });
            cacheThreadActivity(threadId, {
              tone: 'running',
              title: 'Turn started',
            });
            return;
          }
          if (startedTurnId) {
            registerTurnStarted(threadId, startedTurnId);
          }
          if (startedContextUsage) {
            cacheThreadContextUsage(threadId, startedContextUsage);
            setThreadContextUsage((previous) =>
              mergeThreadContextUsage(previous, startedContextUsage)
            );
          }
          upsertThreadRuntimeSnapshot(threadId, () => ({
            activeCommands: [],
            streamingText: null,
          }));
          setActiveCommands([]);
          setStreamingText(null);
          bumpRunWatchdog();
          setActivity({
            tone: 'running',
            title: 'Turn started',
          });
          return;
        }

        if (event.method === 'item/started') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
          if (!threadId) {
            return;
          }
          const item = toRecord(params?.item);
          const itemType = readString(item?.type);
          const itemTurnId =
            readString(params?.turnId) ?? readString(params?.turn_id) ?? null;
          if (itemType === 'plan' && itemTurnId) {
            planItemTurnIdByThreadRef.current[threadId] = itemTurnId;
          }
          if (threadId !== currentId) {
            cacheThreadTurnState(threadId, {
              runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
            });
            const startedToolEvent = describeStartedToolEvent(item);
            if (startedToolEvent) {
              cacheThreadActiveCommand(
                threadId,
                startedToolEvent.eventType,
                startedToolEvent.detail
              );
            }
            if (itemType === 'commandExecution') {
              cacheThreadActivity(threadId, {
                tone: 'running',
                title: 'Working',
              });
              return;
            }

            if (itemType === 'fileChange') {
              cacheThreadActivity(threadId, {
                tone: 'running',
                title: 'Working',
              });
              return;
            }

            if (itemType === 'mcpToolCall') {
              cacheThreadActivity(threadId, {
                tone: 'running',
                title: 'Working',
              });
              return;
            }

            if (itemType === 'plan') {
              cacheThreadActivity(threadId, {
                tone: 'running',
                title: 'Planning',
              });
              return;
            }

            if (itemType === 'reasoning') {
              cacheThreadActivity(threadId, {
                tone: 'running',
                title: 'Reasoning',
              });
              return;
            }
            return;
          }

          bumpRunWatchdog();
          const startedToolEvent = describeStartedToolEvent(item);
          if (startedToolEvent) {
            cacheThreadActiveCommand(
              threadId,
              startedToolEvent.eventType,
              startedToolEvent.detail
            );
            pushActiveCommand(
              threadId,
              startedToolEvent.eventType,
              startedToolEvent.detail
            );
          }

          if (itemType === 'commandExecution') {
            setActivity({
              tone: 'running',
              title: 'Working',
            });
            return;
          }

          if (itemType === 'fileChange') {
            setActivity({
              tone: 'running',
              title: 'Working',
            });
            return;
          }

          if (itemType === 'mcpToolCall') {
            setActivity({
              tone: 'running',
              title: 'Working',
            });
            return;
          }

          if (itemType === 'plan') {
            setSelectedCollaborationMode('plan');
            setActivity({
              tone: 'running',
              title: 'Planning',
            });
            return;
          }

          if (itemType === 'reasoning') {
            setActivity({
              tone: 'running',
              title: 'Reasoning',
            });
            return;
          }
        }

        if (event.method === 'item/plan/delta') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
          if (!threadId) {
            return;
          }
          const turnId = readString(params?.turnId) ?? 'unknown-turn';
          planItemTurnIdByThreadRef.current[threadId] = turnId;
          if (threadId !== currentId) {
            cacheThreadTurnState(threadId, {
              runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
            });
            cacheThreadActivity(threadId, {
              tone: 'running',
              title: 'Planning',
            });
            const rawDelta = readString(params?.delta) ?? '';
            cacheThreadPlan(threadId, (previous) =>
              buildNextPlanStateFromDelta(previous, threadId, turnId, rawDelta)
            );
            return;
          }

          setSelectedCollaborationMode('plan');
          bumpRunWatchdog();
          const rawDelta = readString(params?.delta) ?? '';
          setActivePlan((prev) =>
            buildNextPlanStateFromDelta(prev, threadId, turnId, rawDelta)
          );
          cacheThreadPlan(threadId, (previous) =>
            buildNextPlanStateFromDelta(previous, threadId, turnId, rawDelta)
          );
          setActivity((prev) =>
            prev.tone === 'running' && prev.title === 'Planning'
              ? prev
              : {
                  tone: 'running',
                  title: 'Planning',
                }
          );
          return;
        }

        if (event.method === 'item/reasoning/summaryPartAdded') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
          if (!threadId) {
            return;
          }
          if (threadId !== currentId) {
            cacheThreadTurnState(threadId, {
              runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
            });
            cacheThreadActivity(threadId, {
              tone: 'running',
              title: 'Reasoning',
            });
            return;
          }

          bumpRunWatchdog();
          const itemId = readString(params?.itemId);
          const summaryIndex = readNumber(params?.summaryIndex);
          const summaryKey =
            itemId && summaryIndex !== null ? `${itemId}:${String(summaryIndex)}` : null;
          if (summaryKey && reasoningSummaryRef.current[summaryKey] === undefined) {
            reasoningSummaryRef.current[summaryKey] = '';
          }

          setActivity((prev) =>
            prev.tone === 'running' && prev.title === 'Reasoning'
              ? prev
              : {
                  tone: 'running',
                  title: 'Reasoning',
                }
          );
          return;
        }

        if (event.method === 'item/reasoning/summaryTextDelta') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
          if (!threadId) {
            return;
          }
          const delta = readString(params?.delta);
          if (threadId !== currentId) {
            if (delta) {
              const buffer = `${threadReasoningBuffersRef.current[threadId] ?? ''}${delta}`;
              threadReasoningBuffersRef.current[threadId] = buffer;
              const heading = extractFirstBoldSnippet(buffer, 56);
              const summary = toTickerSnippet(stripMarkdownInline(buffer), 64);
              cacheThreadTurnState(threadId, {
                runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
              });
              cacheThreadActivity(threadId, {
                tone: 'running',
                title: heading ?? 'Reasoning',
                detail: heading ? undefined : summary ?? undefined,
              });
            }
            return;
          }

          bumpRunWatchdog();
          const itemId = readString(params?.itemId);
          const summaryIndex = readNumber(params?.summaryIndex);
          const summaryKey =
            itemId && summaryIndex !== null ? `${itemId}:${String(summaryIndex)}` : null;

          let summaryText = toTickerSnippet(delta, 64);
          let heading = extractFirstBoldSnippet(delta, 56);
          if (summaryKey) {
            const accumulated = (reasoningSummaryRef.current[summaryKey] ?? '') + (delta ?? '');
            reasoningSummaryRef.current[summaryKey] = accumulated;
            summaryText = toTickerSnippet(stripMarkdownInline(accumulated), 64);
            heading = extractFirstBoldSnippet(accumulated, 56) ?? heading;
          }

          setActivity((prev) => {
            const title = heading ?? 'Reasoning';
            const detail = heading ? undefined : summaryText ?? prev.detail;
            if (
              prev.tone === 'running' &&
              prev.title === title &&
              prev.detail === detail
            ) {
              return prev;
            }
            return {
              tone: 'running',
              title,
              detail,
            };
          });
          return;
        }

        if (event.method === 'item/reasoning/textDelta') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
          if (!threadId) {
            return;
          }
          if (threadId !== currentId) {
            cacheThreadTurnState(threadId, {
              runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
            });
            cacheThreadActivity(threadId, {
              tone: 'running',
              title: 'Reasoning',
            });
            return;
          }

          bumpRunWatchdog();
          setActivity((prev) =>
            prev.tone === 'running' && prev.title === 'Reasoning'
              ? prev
              : {
                  tone: 'running',
                  title: 'Reasoning',
                }
          );
          return;
        }

        if (event.method === 'item/commandExecution/outputDelta') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
          if (!threadId) {
            return;
          }
          if (threadId !== currentId) {
            cacheThreadTurnState(threadId, {
              runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
            });
            cacheThreadActivity(threadId, {
              tone: 'running',
              title: 'Working',
            });
            return;
          }

          bumpRunWatchdog();
          setActivity((prev) =>
            prev.tone === 'running' && prev.title === 'Working'
              ? prev
              : {
                  tone: 'running',
                  title: 'Working',
                }
          );
          return;
        }

        if (event.method === 'item/mcpToolCall/progress') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
          if (!threadId) {
            return;
          }
          if (threadId !== currentId) {
            cacheThreadTurnState(threadId, {
              runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
            });
            cacheThreadActivity(threadId, {
              tone: 'running',
              title: 'Working',
            });
            return;
          }

          bumpRunWatchdog();
          setActivity((prev) =>
            prev.tone === 'running' && prev.title === 'Working'
              ? prev
              : {
                  tone: 'running',
                  title: 'Working',
                }
          );
          return;
        }

        if (event.method === 'item/commandExecution/terminalInteraction') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
          if (!threadId) {
            return;
          }
          if (threadId !== currentId) {
            cacheThreadTurnState(threadId, {
              runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
            });
            cacheThreadActivity(threadId, {
              tone: 'running',
              title: 'Working',
            });
            return;
          }

          bumpRunWatchdog();
          setActivity({
            tone: 'running',
            title: 'Working',
          });
          return;
        }

        if (event.method === 'turn/plan/updated') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(params?.thread_id) ?? currentId;
          if (!threadId) {
            return;
          }
          if (threadId !== currentId) {
            cacheThreadTurnState(threadId, {
              runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
            });
            cacheThreadActivity(threadId, {
              tone: 'running',
              title: 'Planning',
            });
            const planUpdate = toTurnPlanUpdate(params, threadId);
            if (planUpdate) {
              cacheThreadPlan(threadId, (previous) =>
                buildNextPlanStateFromUpdate(previous, planUpdate)
              );
            }
            return;
          }

          setSelectedCollaborationMode('plan');
          bumpRunWatchdog();
          const planUpdate = toTurnPlanUpdate(params, threadId);
          if (planUpdate) {
            setActivePlan((prev) => buildNextPlanStateFromUpdate(prev, planUpdate));
            cacheThreadPlan(threadId, (previous) =>
              buildNextPlanStateFromUpdate(previous, planUpdate)
            );
          }
          setActivity({
            tone: 'running',
            title: 'Planning',
          });
          return;
        }

        if (event.method === 'turn/diff/updated') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
          if (!threadId) {
            return;
          }
          if (threadId !== currentId) {
            cacheThreadTurnState(threadId, {
              runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
            });
            cacheThreadActivity(threadId, {
              tone: 'running',
              title: 'Working',
            });
            return;
          }

          bumpRunWatchdog();
          setActivity({
            tone: 'running',
            title: 'Working',
          });
          return;
        }

        // Command completion blocks
        if (event.method === 'item/completed') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
          if (!threadId) {
            return;
          }

          const item = toRecord(params?.item);
          const itemType = readString(item?.type);
          if (threadId !== currentId) {
            const completedToolEvent = describeCompletedToolEvent(item);
            if (completedToolEvent) {
              cacheThreadActiveCommand(
                threadId,
                completedToolEvent.eventType,
                completedToolEvent.detail
              );
            }
            if (itemType === 'commandExecution') {
              const status = readString(item?.status);
              const failed = status === 'failed' || status === 'error';
              cacheThreadActivity(threadId, {
                tone: failed ? 'error' : 'running',
                title: failed ? 'Turn failed' : 'Working',
              });
            }
            return;
          }

          const completedToolEvent = describeCompletedToolEvent(item);
          if (completedToolEvent) {
            cacheThreadActiveCommand(
              threadId,
              completedToolEvent.eventType,
              completedToolEvent.detail
            );
            pushActiveCommand(
              threadId,
              completedToolEvent.eventType,
              completedToolEvent.detail
            );
          }

          if (itemType === 'commandExecution') {
            const status = readString(item?.status);
            const failed = status === 'failed' || status === 'error';
            hadCommandRef.current = true;
            setActivity({
              tone: failed ? 'error' : 'running',
              title: failed ? 'Turn failed' : 'Working',
            });
          }
          return;
        }

        // Turn completion/failure
        if (event.method === 'turn/completed') {
          const params = toRecord(event.params);
          const turn = toRecord(params?.turn);
          const threadId =
            readString(params?.threadId) ??
            readString(params?.thread_id) ??
            readString(turn?.threadId) ??
            readString(turn?.thread_id);
          if (!threadId) {
            return;
          }
          const status = readString(turn?.status) ?? readString(params?.status);
          const completedTurnId =
            readString(turn?.id) ??
            readString(turn?.turnId) ??
            readString(params?.turnId) ??
            readString(params?.turn_id) ??
            null;
          const planTurnId = planItemTurnIdByThreadRef.current[threadId] ?? null;
          const promptTurnId = completedTurnId ?? planTurnId;
          const shouldPromptPlanImplementation =
            status === 'completed' &&
            Boolean(planTurnId) &&
            (!completedTurnId || completedTurnId === planTurnId);
          delete planItemTurnIdByThreadRef.current[threadId];
          if (currentId !== threadId) {
            delete threadReasoningBuffersRef.current[threadId];
            cacheThreadTurnState(threadId, {
              activeTurnId: null,
              runWatchdogUntil: 0,
            });
            upsertThreadRuntimeSnapshot(threadId, () => ({
              activeCommands: [],
              streamingText: null,
              pendingUserInputRequest: null,
              activity:
                status === 'failed' || status === 'interrupted'
                  ? {
                      tone: 'error',
                      title: 'Turn failed',
                      detail: status ?? undefined,
                    }
                  : {
                      tone: 'complete',
                      title: 'Turn completed',
                    },
            }));
            if (shouldPromptPlanImplementation && promptTurnId) {
              setPendingPlanImplementationPrompts((prev) => ({
                ...prev,
                [threadId]: {
                  threadId,
                  turnId: promptTurnId,
                },
              }));
            } else {
              clearPendingPlanImplementationPrompt(threadId);
            }
            return;
          }

          clearRunWatchdog();

          const interruptedByUser = status === 'interrupted' && stopRequestedRef.current;
          const turnError = toRecord(turn?.error) ?? toRecord(params?.error);
          const turnErrorMessage = readString(turnError?.message);

          setActiveCommands([]);
          setStreamingText(null);
          setPendingUserInputRequest(null);
          setUserInputDrafts({});
          setUserInputError(null);
          setResolvingUserInput(false);
          if (!completedTurnId || completedTurnId === activeTurnIdRef.current) {
            setActiveTurnId(null);
          }
          setStoppingTurn(false);
          stopRequestedRef.current = false;
          hadCommandRef.current = false;
          reasoningSummaryRef.current = {};
          codexReasoningBufferRef.current = '';

          if (status === 'failed' || status === 'interrupted') {
            if (interruptedByUser) {
              setError(null);
              appendStopSystemMessageIfNeeded();
              setActivity({
                tone: 'complete',
                title: 'Turn stopped',
              });
            } else {
              setError(turnErrorMessage ?? `turn ${status ?? 'failed'}`);
              setActivity({
                tone: 'error',
                title: 'Turn failed',
                detail: turnErrorMessage ?? status ?? undefined,
              });
            }
            clearPendingPlanImplementationPrompt(threadId);
          } else {
            setActivity({
              tone: 'complete',
              title: 'Turn completed',
            });
            if (shouldPromptPlanImplementation && promptTurnId) {
              setPendingPlanImplementationPrompts((prev) => ({
                ...prev,
                [threadId]: {
                  threadId,
                  turnId: promptTurnId,
                },
              }));
            } else {
              clearPendingPlanImplementationPrompt(threadId);
            }
          }
          loadChat(threadId).catch(() => {});
          return;
        }

        if (event.method === 'bridge/approval.requested') {
          const parsed = toPendingApproval(event.params);
          if (parsed) {
            cacheThreadPendingApproval(parsed.threadId, parsed);
            cacheThreadActivity(parsed.threadId, {
              tone: 'idle',
              title: 'Waiting for approval',
              detail: parsed.command ?? parsed.kind,
            });

            if (parsed.threadId === currentId) {
              clearRunWatchdog();
              setPendingApproval(parsed);
              setActivity({
                tone: 'idle',
                title: 'Waiting for approval',
                detail: parsed.command ?? parsed.kind,
              });
            }
          }
          return;
        }

        if (event.method === 'bridge/userInput.requested') {
          const parsed = toPendingUserInputRequest(event.params);
          if (parsed) {
            cacheThreadPendingUserInputRequest(parsed.threadId, parsed);
            cacheThreadActivity(parsed.threadId, {
              tone: 'idle',
              title: 'Clarification needed',
              detail: parsed.questions[0]?.header ?? 'Answer required',
            });

            if (parsed.threadId === currentId) {
              setSelectedCollaborationMode('plan');
              clearRunWatchdog();
              setPendingUserInputRequest(parsed);
              setUserInputDrafts(buildUserInputDrafts(parsed));
              setUserInputError(null);
              setResolvingUserInput(false);
              setActivity({
                tone: 'idle',
                title: 'Clarification needed',
                detail: parsed.questions[0]?.header ?? 'Answer required',
              });
            }
          }
          return;
        }

        if (event.method === 'bridge/userInput.resolved') {
          const params = toRecord(event.params);
          const resolvedId = readString(params?.id);
          if (resolvedId) {
            for (const [threadId, snapshot] of Object.entries(
              threadRuntimeSnapshotsRef.current
            )) {
              if (snapshot.pendingUserInputRequest?.id !== resolvedId) {
                continue;
              }
              cacheThreadPendingUserInputRequest(threadId, null);
              cacheThreadActivity(threadId, {
                tone: 'running',
                title: 'Input submitted',
              });
            }
          }
          if (pendingUserInputRequestId && resolvedId === pendingUserInputRequestId) {
            bumpRunWatchdog();
            setPendingUserInputRequest(null);
            setUserInputDrafts({});
            setUserInputError(null);
            setResolvingUserInput(false);
            setActivity({
              tone: 'running',
              title: 'Input submitted',
            });
          }
          return;
        }

        if (event.method === 'bridge/approval.resolved') {
          const params = toRecord(event.params);
          const resolvedId = readString(params?.id);
          if (resolvedId) {
            for (const [threadId, snapshot] of Object.entries(
              threadRuntimeSnapshotsRef.current
            )) {
              if (snapshot.pendingApproval?.id !== resolvedId) {
                continue;
              }
              cacheThreadPendingApproval(threadId, null);
              cacheThreadActivity(threadId, {
                tone: 'running',
                title: 'Approval resolved',
              });
            }
          }
          if (pendingApprovalId && resolvedId === pendingApprovalId) {
            bumpRunWatchdog();
            setPendingApproval(null);
            setActivity({
              tone: 'running',
              title: 'Approval resolved',
            });
          }
          return;
        }

        // Externally-started turns (e.g. from CLI) broadcast this event.
        // Do a lightweight status check — don't call loadChat() which would
        // wipe streaming text, active commands, and the watchdog.
        if (event.method === 'thread/status/changed') {
          const params = toRecord(event.params);
          const threadId = extractNotificationThreadId(params);
          const statusHint = extractExternalStatusHint(params);
          const hasExplicitRunningStatus = Boolean(
            statusHint && EXTERNAL_RUNNING_STATUS_HINTS.has(statusHint)
          );
          const hasExplicitTerminalStatus = Boolean(
            statusHint &&
              (EXTERNAL_ERROR_STATUS_HINTS.has(statusHint) ||
                EXTERNAL_COMPLETE_STATUS_HINTS.has(statusHint))
          );
          if (threadId && threadId === currentId) {
            if (!hasExplicitTerminalStatus) {
              bumpRunWatchdog();
              setActivity((prev) =>
                prev.tone === 'running'
                  ? prev
                  : { tone: 'running', title: 'Working' }
              );
            }

            api
              .getChatSummary(threadId)
              .then((summary) => {
                if (chatIdRef.current !== threadId) {
                  return; // user switched away
                }

                setSelectedChat((prev) => {
                  if (!prev || prev.id !== summary.id) {
                    return prev;
                  }
                  return {
                    ...prev,
                    ...summary,
                    messages: prev.messages,
                  };
                });

                const shouldPreserveRunning =
                  !hasExplicitTerminalStatus &&
                  runWatchdogUntilRef.current > Date.now();
                const shouldShowRunning =
                  hasExplicitRunningStatus ||
                  isChatSummaryLikelyRunning(summary) ||
                  shouldPreserveRunning;

                if (shouldShowRunning) {
                  bumpRunWatchdog();
                  setActivity((prev) =>
                    prev.tone === 'running'
                      ? prev
                      : { tone: 'running', title: 'Working' }
                  );
                } else {
                  clearRunWatchdog();
                  setActiveTurnId(null);
                  setStoppingTurn(false);
                  if (!pendingApprovalId && !pendingUserInputRequestId) {
                    setActiveCommands([]);
                    setStreamingText(null);
                    reasoningSummaryRef.current = {};
                    codexReasoningBufferRef.current = '';
                    hadCommandRef.current = false;
                    setActivity(() => {
                      if (statusHint && EXTERNAL_ERROR_STATUS_HINTS.has(statusHint)) {
                        return {
                          tone: 'error',
                          title: 'Turn failed',
                          detail: summary.lastError ?? undefined,
                        };
                      }

                      if (statusHint && EXTERNAL_COMPLETE_STATUS_HINTS.has(statusHint)) {
                        return {
                          tone: 'complete',
                          title: 'Turn completed',
                        };
                      }

                      return summary.status === 'error'
                        ? {
                            tone: 'error',
                            title: 'Turn failed',
                            detail: summary.lastError ?? undefined,
                          }
                        : summary.status === 'complete'
                          ? {
                              tone: 'complete',
                              title: 'Turn completed',
                            }
                          : {
                              tone: 'idle',
                              title: 'Ready',
                            };
                    });
                  }
                }
              })
              .catch(() => {});

            scheduleExternalStatusFullSync(threadId);
          } else if (threadId) {
            if (!hasExplicitTerminalStatus) {
              cacheThreadTurnState(threadId, {
                runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
              });
              cacheThreadActivity(threadId, {
                tone: 'running',
                title: 'Working',
              });
            }
            void refreshPendingApprovalsForThread(threadId);
          }
          return;
        }

        if (event.method === 'bridge/connection/state') {
          const params = toRecord(event.params);
          const status = readString(params?.status);
          if (status === 'connected' && currentId) {
            setActivity((prev) =>
              prev.tone === 'running'
                ? prev
                : {
                    tone: 'idle',
                    title: 'Connected',
                  }
            );
            clearRunWatchdog();
            loadChat(currentId, { preserveRuntimeState: true }).catch(() => {});
            return;
          }

          if (status === 'disconnected') {
            clearRunWatchdog();
            setActivity({
              tone: 'error',
              title: 'Disconnected',
            });
          }
        }
      });
    }, [
      ws,
      api,
      pendingApproval?.id,
      pendingUserInputRequest?.id,
      loadChat,
      appendStopSystemMessageIfNeeded,
      bumpRunWatchdog,
      cacheCodexRuntimeForThread,
      cacheThreadActiveCommand,
      cacheThreadActivity,
      cacheThreadContextUsage,
      cacheThreadPendingApproval,
      cacheThreadPendingUserInputRequest,
      cacheThreadPlan,
      cacheThreadStreamingDelta,
      cacheThreadTurnState,
      clearPendingPlanImplementationPrompt,
      clearRunWatchdog,
      readThreadContextUsage,
      refreshPendingApprovalsForThread,
      scheduleExternalStatusFullSync,
      registerTurnStarted,
      pushActiveCommand,
      scrollToBottomIfPinned,
      upsertThreadRuntimeSnapshot,
    ]);

    useEffect(() => {
      if (!selectedChatId) {
        return;
      }
      const hasPendingApproval = Boolean(pendingApproval?.id);
      const hasPendingUserInput = Boolean(pendingUserInputRequest?.id);
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const syncChat = async () => {
        if (sending || creating) {
          return;
        }

        try {
          const latest = await api.getChat(selectedChatId);
          setSelectedChat((prev) => {
            if (!prev || prev.id !== latest.id) {
              return latest;
            }

            const isUnchanged =
              prev.updatedAt === latest.updatedAt &&
              prev.messages.length === latest.messages.length;

            return isUnchanged ? prev : latest;
          });

          const currentSelectedChat = selectedChatRef.current;
          const hasTerminalStatus =
            latest.status === 'complete' || latest.status === 'error';
          const hasAssistantProgress =
            !hasTerminalStatus &&
            didAssistantMessageProgress(currentSelectedChat, latest);
          const hasPendingUserMessage =
            !hasTerminalStatus && hasRecentUnansweredUserTurn(latest);
          const shouldRunFromChat =
            isChatLikelyRunning(latest) ||
            hasAssistantProgress ||
            hasPendingUserMessage;
          const shouldRunFromWatchdog =
            !hasTerminalStatus && runWatchdogUntilRef.current > Date.now();
          const shouldShowRunning = shouldRunFromChat || shouldRunFromWatchdog;
          const shouldRefreshWatchdog = shouldRunFromChat;
          const watchdogDurationMs =
            hasAssistantProgress && !isChatLikelyRunning(latest)
              ? Math.floor(RUN_WATCHDOG_MS / 4)
              : RUN_WATCHDOG_MS;

          if (shouldShowRunning && !hasPendingApproval && !hasPendingUserInput) {
            setActivity((prev) => {
              // Only guard against watchdog-only bumps overriding a fresh
              // completion. When the server explicitly reports running, trust it
              // (handles externally-started turns like CLI).
              if (
                !shouldRunFromChat &&
                (prev.tone === 'complete' || prev.tone === 'error')
              ) {
                return prev;
              }
              if (shouldRefreshWatchdog) {
                bumpRunWatchdog(watchdogDurationMs);
              }
              return prev.tone === 'running'
                ? prev
                : { tone: 'running', title: hasAssistantProgress ? 'Thinking' : 'Working' };
            });
          } else if (!hasPendingApproval && !hasPendingUserInput) {
            clearRunWatchdog();
            setActiveCommands([]);
            setStreamingText(null);
            setActiveTurnId(null);
            setStoppingTurn(false);
            reasoningSummaryRef.current = {};
            codexReasoningBufferRef.current = '';
            hadCommandRef.current = false;
            setActivity((prev) => {
              if (latest.status === 'error') {
                return {
                  tone: 'error',
                  title: 'Turn failed',
                  detail: latest.lastError ?? undefined,
                };
              }

              if (latest.status === 'complete') {
                return prev.tone === 'running'
                  ? {
                      tone: 'complete',
                      title: 'Turn completed',
                    }
                  : {
                      tone: 'idle',
                      title: 'Ready',
                    };
              }

              return {
                tone: 'idle',
                title: 'Ready',
              };
            });
          }
        } catch {
          // Polling is best-effort; keep the current view if refresh fails.
        }
      };

      const scheduleNextSync = () => {
        if (stopped) {
          return;
        }
        const shouldPollFast =
          Boolean(activeTurnIdRef.current) || runWatchdogUntilRef.current > Date.now();
        const intervalMs = shouldPollFast
          ? ACTIVE_CHAT_SYNC_INTERVAL_MS
          : IDLE_CHAT_SYNC_INTERVAL_MS;
        timer = setTimeout(() => {
          void syncChat().finally(() => {
            scheduleNextSync();
          });
        }, intervalMs);
      };

      void syncChat();
      scheduleNextSync();

      return () => {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
        }
      };
    }, [
      api,
      selectedChatId,
      sending,
      creating,
      pendingApproval?.id,
      pendingUserInputRequest?.id,
      bumpRunWatchdog,
      clearRunWatchdog,
    ]);

    const handleResolveApproval = useCallback(
      async (id: string, decision: ApprovalDecision) => {
        try {
          await api.resolveApproval(id, decision);
          if (selectedChatId) {
            cacheThreadPendingApproval(selectedChatId, null);
          }
          setPendingApproval(null);
        } catch (err) {
          setError((err as Error).message);
        }
      },
      [api, cacheThreadPendingApproval, selectedChatId]
    );

    const setUserInputDraft = useCallback((questionId: string, value: string) => {
      setUserInputDrafts((prev) => ({
        ...prev,
        [questionId]: value,
      }));
      setUserInputError(null);
    }, []);

    const submitUserInputRequest = useCallback(async () => {
      if (!pendingUserInputRequest || resolvingUserInput) {
        return;
      }

      const answers: Record<string, { answers: string[] }> = {};
      for (const question of pendingUserInputRequest.questions) {
        const raw = (userInputDrafts[question.id] ?? '').trim();
        const normalizedAnswers = normalizeQuestionAnswers(raw);
        if (normalizedAnswers.length === 0) {
          setUserInputError(`Please answer "${question.header}"`);
          return;
        }

        answers[question.id] = { answers: normalizedAnswers };
      }

      setResolvingUserInput(true);
      try {
        await api.resolveUserInput(pendingUserInputRequest.id, { answers });
        cacheThreadPendingUserInputRequest(pendingUserInputRequest.threadId, null);
        setPendingUserInputRequest(null);
        setUserInputDrafts({});
        setUserInputError(null);
        setActivity({
          tone: 'running',
          title: 'Input submitted',
        });
        bumpRunWatchdog();
      } catch (err) {
        setUserInputError((err as Error).message);
      } finally {
        setResolvingUserInput(false);
      }
    }, [
      api,
      bumpRunWatchdog,
      cacheThreadPendingUserInputRequest,
      pendingUserInputRequest,
      resolvingUserInput,
      userInputDrafts,
    ]);

    const handleOpenGit = useCallback(() => {
      if (!selectedChat) {
        return;
      }
      onOpenGit(selectedChat);
    }, [onOpenGit, selectedChat]);

    const handleComposerFocus = useCallback(() => {
      requestAnimationFrame(() => {
        scrollToBottomReliable(true);
      });
    }, [scrollToBottomReliable]);

    const handleSubmit = selectedChat ? sendMessage : createChat;
    const isTurnLoading = sending || creating;
    const isLoading = isTurnLoading || uploadingAttachment;
    const isOpeningChat = Boolean(openingChatId);
    const shouldShowComposer = !isOpeningChat;
    const isTurnLikelyRunning =
      Boolean(activeTurnId) || (selectedChat ? isChatLikelyRunning(selectedChat) : false);
    const hasRunWatchdog = runWatchdogUntilRef.current > runWatchdogNow;

    useEffect(() => {
      if (
        activity.tone !== 'running' ||
        isLoading ||
        isOpeningChat ||
        pendingApproval ||
        pendingUserInputRequest ||
        isTurnLikelyRunning ||
        hasRunWatchdog
      ) {
        return;
      }

      setActivity((prev) => {
        if (prev.tone !== 'running') {
          return prev;
        }

        if (selectedChat?.status === 'error') {
          return {
            tone: 'error',
            title: 'Turn failed',
            detail: selectedChat.lastError ?? undefined,
          };
        }

        if (selectedChat?.status === 'complete') {
          return {
            tone: 'complete',
            title: 'Turn completed',
          };
        }

        return {
          tone: 'idle',
          title: 'Ready',
        };
      });
    }, [
      activity.tone,
      hasRunWatchdog,
      isLoading,
      isOpeningChat,
      isTurnLikelyRunning,
      pendingApproval,
      pendingUserInputRequest,
      selectedChat,
    ]);

    const oldestQueuedMessage = queuedMessages[0] ?? null;
    const remainingQueuedMessagesCount = Math.max(0, queuedMessages.length - 1);
    const visibleActivity = (() => {
      if (isOpeningChat) {
        return {
          tone: 'running',
          title: 'Opening chat',
        } satisfies ActivityState;
      }

      if (pendingApproval) {
        return {
          tone: 'idle',
          title: 'Waiting for approval',
          detail: pendingApproval.command ?? pendingApproval.kind,
        } satisfies ActivityState;
      }

      if (pendingUserInputRequest) {
        return {
          tone: 'idle',
          title: 'Waiting for input',
        } satisfies ActivityState;
      }

      if (!isLoading && !isTurnLikelyRunning && selectedChat?.status === 'error') {
        return {
          tone: 'error',
          title: 'Turn failed',
          detail: selectedChat.lastError ?? activity.detail,
        } satisfies ActivityState;
      }

      if (!isLoading && !isTurnLikelyRunning && selectedChat?.status === 'complete') {
        return {
          tone: 'complete',
          title: 'Turn completed',
        } satisfies ActivityState;
      }

      if (isLoading || isTurnLikelyRunning || activity.tone === 'running') {
        const runningTitle =
          activity.title === 'Thinking' ||
          activity.title === 'Planning' ||
          activity.title === 'Reasoning'
            ? activity.title
            : 'Working';
        return {
          tone: 'running',
          title: runningTitle,
          detail: activity.detail,
        } satisfies ActivityState;
      }

      return activity;
    })();
    const activityDetail = visibleActivity.detail;
    const showActivity =
      isLoading ||
      isOpeningChat ||
      visibleActivity.tone !== 'idle' ||
      Boolean(activityDetail);
    const activeContextWindow = threadContextUsage?.modelContextWindow ?? null;
    const contextUsedTokens = threadContextUsage?.lastTokens ?? null;
    const contextWindowLabel =
      activeContextWindow !== null ? formatTokenCount(activeContextWindow) : null;
    const contextUsedLabel =
      contextUsedTokens !== null ? formatTokenCount(contextUsedTokens) : null;
    const contextRemainingPercent =
      activeContextWindow !== null && contextUsedTokens !== null && activeContextWindow > 0
        ? (() => {
            if (activeContextWindow <= CONTEXT_WINDOW_BASELINE_TOKENS) {
              return 0;
            }

            const effectiveWindow = activeContextWindow - CONTEXT_WINDOW_BASELINE_TOKENS;
            const used = Math.max(0, contextUsedTokens - CONTEXT_WINDOW_BASELINE_TOKENS);
            const remaining = Math.max(0, effectiveWindow - used);
            return Math.max(
              0,
              Math.min(100, Math.round((remaining / effectiveWindow) * 100))
            );
          })()
        : null;
    const composerUsageLimitBadges = buildComposerUsageLimitBadges(accountRateLimits);
    const contextChipLabel =
      contextUsedLabel && contextWindowLabel
        ? `${contextUsedLabel} / ${contextWindowLabel}${
            contextRemainingPercent !== null ? ` · ${String(contextRemainingPercent)}% left` : ''
          }`
        : contextWindowLabel
          ? `${contextWindowLabel} window`
          : 'Context --';
    const contextIndicatorColor =
      contextRemainingPercent === null
        ? contextWindowLabel
          ? colors.borderHighlight
          : colors.textMuted
        : contextRemainingPercent <= 10
          ? colors.error
          : contextRemainingPercent <= 25
            ? colors.accent
            : colors.borderHighlight;
    const headerTitle = isOpeningChat ? 'Opening chat' : selectedChat?.title?.trim() || 'New chat';
    const defaultStartWorkspaceLabel =
      preferredStartCwd ?? 'Bridge default workspace';
    const selectedThreadPlan = selectedChat
      ? activePlan?.threadId === selectedChat.id
        ? activePlan
        : threadRuntimeSnapshotsRef.current[selectedChat.id]?.plan ??
          chatPlanSnapshotsRef.current[selectedChat.id] ??
          null
      : null;
    const selectedPlanImplementationPrompt = selectedChat
      ? pendingPlanImplementationPrompts[selectedChat.id] ?? null
      : null;
    const planPanelCollapsed =
      selectedChat ? (planPanelCollapsedByThread[selectedChat.id] ?? false) : false;
    const fastModeControlDisabled = isOpeningChat;
    const showSlashSuggestions = slashSuggestions.length > 0 && draft.trimStart().startsWith('/');
    const canSteerQueuedMessage =
      Boolean(oldestQueuedMessage) &&
      Boolean(selectedChatId) &&
      Boolean(activeTurnId) &&
      !pendingApproval &&
      !pendingUserInputRequest &&
      Boolean(selectedChat && isChatLikelyRunning(selectedChat));
    const queuedMessageSteerDisabledReason = pendingApproval
      ? 'Waiting for approval before steering.'
      : pendingUserInputRequest
        ? 'Waiting for required input before steering.'
        : null;
    const showQueuedMessageCard =
      Boolean(selectedChat) && !isOpeningChat && Boolean(oldestQueuedMessage);
    const showTopCardsRow = !isOpeningChat && Boolean(selectedThreadPlan);
    const showFloatingActivity =
      showActivity && shouldShowComposer && Boolean(selectedChat) && !isOpeningChat;
    const visibleToolBlocks = activeCommands.slice(-MAX_VISIBLE_TOOL_BLOCKS);
    const toolPanelMaxHeight = Math.min(Math.floor(windowHeight * 0.26), 180);
    const showLiveToolPanel =
      showToolCalls &&
      Boolean(selectedChat) &&
      !isOpeningChat &&
      visibleToolBlocks.length > 0;
    const showPlanImplementationPrompt =
      Boolean(selectedPlanImplementationPrompt) &&
      !isOpeningChat &&
      !sending &&
      !creating &&
      !stoppingTurn &&
      !pendingApproval &&
      !pendingUserInputRequest &&
      !renameModalVisible &&
      !attachmentMenuVisible &&
      !attachmentModalVisible &&
      !chatTitleMenuVisible &&
      !collaborationModeMenuVisible &&
      !modelSettingsMenuVisible &&
      !workspaceModalVisible &&
      !modelModalVisible &&
      !effortModalVisible &&
      queuedMessages.length === 0;
    const chatBottomInset = shouldShowComposer
      ? spacing.lg
      : Math.max(spacing.xxl, safeAreaInsets.bottom + spacing.lg);

    useEffect(() => {
      if (!selectedChat || isOpeningChat || !showActivity) {
        return;
      }
      scrollToBottomIfPinned(false);
    }, [isOpeningChat, scrollToBottomIfPinned, selectedChat, showActivity]);

    useEffect(() => {
      const threadId = selectedChat?.id;
      const turnId = selectedThreadPlan?.turnId;
      if (!threadId || !turnId) {
        return;
      }

      const previousTurnId = planPanelLastTurnByThreadRef.current[threadId];
      if (previousTurnId === turnId) {
        return;
      }

      planPanelLastTurnByThreadRef.current[threadId] = turnId;
      setPlanPanelCollapsedByThread((prev) => {
        if (prev[threadId] === false) {
          return prev;
        }
        return {
          ...prev,
          [threadId]: false,
        };
      });
    }, [selectedChat?.id, selectedThreadPlan?.turnId]);

    const toggleSelectedPlanPanel = useCallback(() => {
      if (!selectedChat?.id || !selectedThreadPlan) {
        return;
      }

      setPlanPanelCollapsedByThread((prev) => ({
        ...prev,
        [selectedChat.id]: !(prev[selectedChat.id] ?? false),
      }));
    }, [selectedChat?.id, selectedThreadPlan]);

    return (
      <View style={styles.container}>
        <ChatHeader
          onOpenDrawer={onOpenDrawer}
          title={headerTitle}
          onOpenTitleMenu={selectedChat ? openChatTitleMenu : undefined}
          rightIconName="git-branch-outline"
          onRightActionPress={selectedChat ? handleOpenGit : undefined}
        />

        {selectedChat && !isOpeningChat ? (
          <View style={styles.sessionMetaRow}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.sessionMetaRowContent}
            >
              <View style={styles.contextChip}>
                <View
                  style={[
                    styles.contextChipIndicator,
                    {
                      backgroundColor: contextIndicatorColor,
                    },
                  ]}
                />
                <Text style={styles.contextChipText} numberOfLines={1}>
                  {contextChipLabel}
                </Text>
              </View>
              <Pressable
                style={({ pressed }) => [
                  styles.modelChip,
                  pressed && styles.modelChipPressed,
                ]}
                onPress={openModelReasoningMenu}
              >
                <Ionicons name="sparkles-outline" size={13} color={colors.textMuted} />
                <Text style={styles.modelChipText} numberOfLines={1}>
                  {modelReasoningLabel}
                </Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.modeChip,
                  pressed && styles.modelChipPressed,
                ]}
                onPress={openCollaborationModeMenu}
              >
                <Ionicons name="map-outline" size={13} color={colors.textMuted} />
                <Text style={styles.modelChipText} numberOfLines={1}>
                  {collaborationModeLabel}
                </Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.fastChip,
                  fastModeEnabled && styles.fastChipEnabled,
                  pressed && styles.modelChipPressed,
                  fastModeControlDisabled && styles.sessionMetaChipDisabled,
                ]}
                onPress={() => {
                  void toggleFastMode();
                }}
                disabled={fastModeControlDisabled}
              >
                <Ionicons
                  name={fastModeEnabled ? 'flash' : 'flash-outline'}
                  size={13}
                  color={fastModeEnabled ? colors.textPrimary : colors.textMuted}
                />
                <Text
                  style={[
                    styles.modelChipText,
                    fastModeEnabled && styles.fastChipTextEnabled,
                  ]}
                  numberOfLines={1}
                >
                  Fast
                </Text>
              </Pressable>
            </ScrollView>
          </View>
        ) : null}

        {showTopCardsRow ? (
          <View style={styles.topCardsRow}>
            {selectedThreadPlan ? (
              <PlanCard
                plan={selectedThreadPlan}
                collapsed={planPanelCollapsed}
                onToggleCollapse={toggleSelectedPlanPanel}
              />
            ) : null}
          </View>
        ) : null}

        <KeyboardAvoidingView
          style={styles.keyboardAvoiding}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          enabled={Platform.OS === 'ios'}
        >
          {selectedChat && !isOpeningChat ? (
            <ChatView
              chat={selectedChat}
              bridgeUrl={bridgeUrl}
              bridgeToken={bridgeToken}
              showToolCalls={showToolCalls}
              scrollRef={scrollRef}
              inlineChoicesEnabled={!pendingUserInputRequest && !pendingApproval && !isLoading}
              onInlineOptionSelect={handleInlineOptionSelect}
              onPinnedAutoScroll={scrollToBottomIfPinned}
              onScrollInteractionStart={clearPendingScrollRetries}
              autoScrollStateRef={autoScrollStateRef}
              bottomInset={chatBottomInset}
            />
          ) : isOpeningChat ? (
            <View style={styles.chatLoadingContainer}>
              <ActivityIndicator size="small" color={colors.textMuted} />
              <Text style={styles.chatLoadingText}>Opening chat...</Text>
            </View>
          ) : (
            <ComposeView
              startWorkspaceLabel={defaultStartWorkspaceLabel}
              modelReasoningLabel={modelReasoningLabel}
              collaborationModeLabel={collaborationModeLabel}
              fastModeEnabled={fastModeEnabled}
              fastModeLabel={fastModeLabel}
              onSuggestion={(s) => setDraft(s)}
              onOpenWorkspacePicker={openWorkspaceModal}
              onOpenModelReasoningPicker={openModelReasoningMenu}
              onOpenCollaborationModePicker={openCollaborationModeMenu}
              onToggleFastMode={() => {
                void toggleFastMode();
              }}
            />
          )}

          {showLiveToolPanel ? (
            <View style={styles.queuedMessageDock}>
              <View style={[styles.livePanelShell, styles.toolPanel, { maxHeight: toolPanelMaxHeight }]}>
                <ScrollView
                  nestedScrollEnabled
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={styles.toolPanelContent}
                >
                  <View style={styles.livePanelContent}>
                    {visibleToolBlocks.map((event) => {
                      const tool = toToolBlockState(event);
                      if (!tool) {
                        return null;
                      }
                      return (
                        <ToolBlock
                          key={event.id}
                          command={tool.command}
                          status={tool.status}
                          icon={tool.icon}
                        />
                      );
                    })}
                  </View>
                </ScrollView>
              </View>
            </View>
          ) : null}

          {showFloatingActivity ? (
            <View pointerEvents="none" style={styles.activityDock}>
              <ActivityBar
                title={visibleActivity.title}
                detail={activityDetail}
                tone={visibleActivity.tone}
              />
            </View>
          ) : null}

          {showQueuedMessageCard && oldestQueuedMessage ? (
            <View style={styles.queuedMessageDock}>
              <QueuedMessageCard
                message={oldestQueuedMessage}
                remainingCount={remainingQueuedMessagesCount}
                steerEnabled={canSteerQueuedMessage}
                steerDisabledReason={queuedMessageSteerDisabledReason}
                onSteer={() => {
                  void handleSteerQueuedMessage();
                }}
              />
            </View>
          ) : null}

          {shouldShowComposer ? (
            <View
              style={[
                styles.composerContainer,
                !keyboardVisible ? styles.composerContainerResting : null,
              ]}
            >
              {error ? <Text style={styles.errorText}>{error}</Text> : null}
              {pendingApproval ? (
                <ApprovalBanner
                  approval={pendingApproval}
                  onResolve={handleResolveApproval}
                />
              ) : null}
              {showSlashSuggestions ? (
                <ScrollView
                  style={[
                    styles.slashSuggestions,
                    { maxHeight: slashSuggestionsMaxHeight },
                  ]}
                  contentContainerStyle={styles.slashSuggestionsContent}
                  keyboardShouldPersistTaps="handled"
                  nestedScrollEnabled
                >
                  {slashSuggestions.map((command, index) => {
                    const suffix = command.argsHint ? ` ${command.argsHint}` : '';
                    return (
                      <Pressable
                        key={`${command.name}-${String(index)}`}
                        onPress={() => setDraft(`/${command.name}${command.argsHint ? ' ' : ''}`)}
                        style={({ pressed }) => [
                          styles.slashSuggestionItem,
                          index === slashSuggestions.length - 1 &&
                            styles.slashSuggestionItemLast,
                          pressed && styles.slashSuggestionItemPressed,
                        ]}
                      >
                        <Text style={styles.slashSuggestionTitle}>{`/${command.name}${suffix}`}</Text>
                        <Text style={styles.slashSuggestionSummary} numberOfLines={1}>
                          {command.mobileSupported
                            ? command.summary
                            : `${command.summary} · CLI only`}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              ) : null}
              <ChatInput
                value={draft}
                onChangeText={setDraft}
                onFocus={handleComposerFocus}
                onSubmit={() => void handleSubmit()}
                onStop={() => handleStopTurn()}
                showStopButton={isTurnLoading || isTurnLikelyRunning || stoppingTurn}
                isStopping={stoppingTurn}
                onAttachPress={openAttachmentMenu}
                attachments={composerAttachments}
                onRemoveAttachment={removeComposerAttachment}
                isLoading={isLoading}
                placeholder={selectedChat ? 'Reply...' : 'Message Codex...'}
                voiceState={canUseVoiceInput ? voiceRecorder.voiceState : 'idle'}
                voiceRecordingDurationMillis={
                  canUseVoiceInput ? voiceRecorder.recordingDurationMillis : 0
                }
                voiceMetering={canUseVoiceInput ? voiceRecorder.recordingMetering : null}
                onVoiceToggle={canUseVoiceInput ? voiceRecorder.toggleRecording : undefined}
                safeAreaBottomInset={safeAreaInsets.bottom}
                keyboardVisible={keyboardVisible}
                footer={
                  composerUsageLimitBadges.length > 0 ? (
                    <ComposerUsageLimits limits={composerUsageLimitBadges} />
                  ) : null
                }
              />
            </View>
          ) : null}
        </KeyboardAvoidingView>

        <SelectionSheet
          visible={attachmentMenuVisible}
          eyebrow="Attachments"
          title="Add context"
          subtitle="Bring in a workspace path, a file, or an image."
          options={attachmentMenuOptions}
          onClose={() => setAttachmentMenuVisible(false)}
        />

        <SelectionSheet
          visible={chatTitleMenuVisible}
          eyebrow="Chat"
          title={selectedChat?.title?.trim() || 'Chat options'}
          subtitle="Quick actions for the current thread."
          options={chatTitleMenuOptions}
          onClose={() => setChatTitleMenuVisible(false)}
        />

        <SelectionSheet
          visible={collaborationModeMenuVisible}
          eyebrow="Mode"
          title="Collaboration mode"
          subtitle="Choose how Codex should steer the next turn."
          options={collaborationModeOptions}
          onClose={() => setCollaborationModeMenuVisible(false)}
        />

        <SelectionSheet
          visible={modelSettingsMenuVisible}
          eyebrow="Model"
          title="Model controls"
          subtitle={modelReasoningLabel}
          options={modelSettingsMenuOptions}
          onClose={() => setModelSettingsMenuVisible(false)}
        />

        <SelectionSheet
          visible={workspaceModalVisible}
          eyebrow="Workspace"
          title="Start directory"
          subtitle="Pick which workspace new chats should open in."
          options={workspacePickerOptions}
          loading={loadingWorkspaces}
          loadingLabel="Refreshing workspaces…"
          onClose={closeWorkspaceModal}
        />

        <SelectionSheet
          visible={modelModalVisible}
          eyebrow="Model"
          title="Select model"
          subtitle="Choose a model for this chat or fall back to the bridge default."
          options={modelPickerOptions}
          loading={loadingModels}
          loadingLabel="Refreshing available models…"
          onClose={closeModelModal}
        />

        <SelectionSheet
          visible={effortModalVisible}
          eyebrow="Reasoning"
          title="Reasoning level"
          subtitle={
            effortPickerModel
              ? `Current model: ${effortPickerModel.displayName}`
              : 'Select how much reasoning depth to use.'
          }
          options={effortPickerSheetOptions}
          onClose={closeEffortModal}
        />

        <Modal
          visible={renameModalVisible}
          transparent
          animationType="fade"
          onRequestClose={closeRenameModal}
        >
          <View style={styles.renameModalBackdrop}>
            <View style={styles.renameModalCard}>
              <Text style={styles.renameModalTitle}>Rename chat</Text>
              <TextInput
                value={renameDraft}
                onChangeText={setRenameDraft}
                keyboardAppearance="dark"
                placeholder="Chat name"
                placeholderTextColor={colors.textMuted}
                style={styles.renameModalInput}
                autoFocus
                editable={!renaming}
                maxLength={120}
              />
              <View style={styles.renameModalActions}>
                <Pressable
                  onPress={closeRenameModal}
                  style={({ pressed }) => [
                    styles.renameModalButton,
                    styles.renameModalButtonSecondary,
                    pressed && styles.renameModalButtonPressed,
                  ]}
                  disabled={renaming}
                >
                  <Text style={styles.renameModalButtonSecondaryText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={() => void submitRenameChat()}
                  style={({ pressed }) => [
                    styles.renameModalButton,
                    styles.renameModalButtonPrimary,
                    pressed && styles.renameModalButtonPrimaryPressed,
                    (renaming || !renameDraft.trim()) && styles.renameModalButtonDisabled,
                  ]}
                  disabled={renaming || !renameDraft.trim()}
                >
                  <Text style={styles.renameModalButtonPrimaryText}>
                    {renaming ? 'Saving...' : 'Save'}
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        <Modal
          visible={attachmentModalVisible}
          transparent
          animationType="fade"
          onRequestClose={closeAttachmentModal}
        >
          <View style={styles.renameModalBackdrop}>
            <View style={styles.renameModalCard}>
              <Text style={styles.renameModalTitle}>Attach file</Text>
              <Text style={styles.attachmentModalHint}>
                Enter a workspace-relative path to include as context.
              </Text>
              <TextInput
                value={attachmentPathDraft}
                onChangeText={setAttachmentPathDraft}
                keyboardAppearance="dark"
                placeholder="apps/mobile/src/screens/MainScreen.tsx"
                placeholderTextColor={colors.textMuted}
                style={styles.renameModalInput}
                autoFocus
                editable={!isLoading}
                autoCapitalize="none"
                autoCorrect={false}
                onSubmitEditing={submitAttachmentPath}
                returnKeyType="done"
              />
              {loadingAttachmentFileCandidates ? (
                <Text style={styles.workspaceModalLoading}>Indexing files…</Text>
              ) : null}
              {attachmentPathSuggestions.length > 0 ? (
                <ScrollView
                  style={styles.attachmentSuggestionsList}
                  contentContainerStyle={styles.attachmentSuggestionsListContent}
                  keyboardShouldPersistTaps="handled"
                  nestedScrollEnabled
                >
                  {attachmentPathSuggestions.map((path, index) => (
                    <Pressable
                      key={`${path}-${String(index)}`}
                      onPress={() => selectAttachmentSuggestion(path)}
                      style={({ pressed }) => [
                        styles.attachmentSuggestionItem,
                        index === attachmentPathSuggestions.length - 1 &&
                          styles.attachmentSuggestionItemLast,
                        pressed && styles.attachmentSuggestionItemPressed,
                      ]}
                    >
                      <Text style={styles.attachmentSuggestionText} numberOfLines={1}>
                        {path}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              ) : attachmentPathDraft.trim() && !loadingAttachmentFileCandidates ? (
                <Text style={styles.workspaceModalLoading}>No matching files found.</Text>
              ) : null}
              {pendingMentionPaths.length > 0 ? (
                <View style={styles.attachmentListColumn}>
                  {pendingMentionPaths.map((path, index) => (
                    <View key={`${path}-${String(index)}`} style={styles.attachmentListRow}>
                      <Text style={styles.attachmentListPath} numberOfLines={1}>
                        {path}
                      </Text>
                      <Pressable
                        onPress={() => removePendingMentionPath(path)}
                        style={({ pressed }) => [
                          styles.attachmentRemoveButton,
                          pressed && styles.attachmentRemoveButtonPressed,
                        ]}
                      >
                        <Ionicons name="close" size={14} color={colors.textMuted} />
                      </Pressable>
                    </View>
                  ))}
                </View>
              ) : null}
              <View style={styles.renameModalActions}>
                <Pressable
                  onPress={closeAttachmentModal}
                  style={({ pressed }) => [
                    styles.renameModalButton,
                    styles.renameModalButtonSecondary,
                    pressed && styles.renameModalButtonPressed,
                  ]}
                  disabled={isLoading}
                >
                  <Text style={styles.renameModalButtonSecondaryText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={submitAttachmentPath}
                  style={({ pressed }) => [
                    styles.renameModalButton,
                    styles.renameModalButtonPrimary,
                    pressed && styles.renameModalButtonPrimaryPressed,
                    (!attachmentPathDraft.trim() || isLoading) &&
                      styles.renameModalButtonDisabled,
                  ]}
                  disabled={!attachmentPathDraft.trim() || isLoading}
                >
                  <Text style={styles.renameModalButtonPrimaryText}>Attach</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        <Modal
          visible={showPlanImplementationPrompt}
          transparent
          animationType="fade"
          onRequestClose={stayInPlanMode}
        >
          <View style={styles.userInputModalBackdrop}>
            <View style={styles.planPromptModalCard}>
              <Text style={styles.userInputModalTitle}>{PLAN_IMPLEMENTATION_TITLE}</Text>
              <View style={styles.planPromptOptionsColumn}>
                <Pressable
                  onPress={() => void implementPlan()}
                  style={({ pressed }) => [
                    styles.planPromptOptionButton,
                    pressed && styles.planPromptOptionButtonPressed,
                  ]}
                >
                  <Text style={styles.planPromptOptionTitle}>{PLAN_IMPLEMENTATION_YES}</Text>
                  <Text style={styles.planPromptOptionDescription}>
                    Switch to Default and start coding.
                  </Text>
                </Pressable>
                <Pressable
                  onPress={stayInPlanMode}
                  style={({ pressed }) => [
                    styles.planPromptOptionButton,
                    pressed && styles.planPromptOptionButtonPressed,
                  ]}
                >
                  <Text style={styles.planPromptOptionTitle}>{PLAN_IMPLEMENTATION_NO}</Text>
                  <Text style={styles.planPromptOptionDescription}>
                    Continue planning with the model.
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        <Modal
          visible={Boolean(pendingUserInputRequest)}
          transparent
          animationType="fade"
          onRequestClose={() => {
            // This prompt requires a reply; keep it visible until submitted.
          }}
        >
          <View style={styles.userInputModalBackdrop}>
            <View style={styles.userInputModalCard}>
              <Text style={styles.userInputModalTitle}>Clarification needed</Text>
              <ScrollView
                style={styles.userInputQuestionsList}
                contentContainerStyle={styles.userInputQuestionsListContent}
                showsVerticalScrollIndicator={false}
              >
                {(pendingUserInputRequest?.questions ?? []).map((question, questionIndex) => {
                  const answer = userInputDrafts[question.id] ?? '';
                  const hasPresetOptions =
                    Array.isArray(question.options) && question.options.length > 0;
                  const needsFreeformInput = !hasPresetOptions || question.isOther;
                  return (
                    <View
                      key={`${question.id}-${String(questionIndex)}`}
                      style={styles.userInputQuestionCard}
                    >
                      <Text style={styles.userInputQuestionHeader}>{question.header}</Text>
                      <Text style={styles.userInputQuestionText}>{question.question}</Text>
                      {hasPresetOptions ? (
                        <View style={styles.userInputOptionsColumn}>
                          {question.options?.map((option, index) => (
                            <Pressable
                              key={`${question.id}-${String(index)}-${option.label}`}
                              style={({ pressed }) => [
                                styles.userInputOptionButton,
                                answer.trim() === option.label.trim() &&
                                  styles.userInputOptionButtonSelected,
                                pressed && styles.userInputOptionButtonPressed,
                              ]}
                              onPress={() => setUserInputDraft(question.id, option.label)}
                            >
                              <View style={styles.userInputOptionHeaderRow}>
                                <Text style={styles.userInputOptionIndex}>
                                  {`${String(index + 1)}.`}
                                </Text>
                                <Text style={styles.userInputOptionLabel}>{option.label}</Text>
                              </View>
                              {option.description.trim() ? (
                                <Text style={styles.userInputOptionDescription}>
                                  {option.description}
                                </Text>
                              ) : null}
                            </Pressable>
                          ))}
                        </View>
                      ) : null}
                      {needsFreeformInput ? (
                        <TextInput
                          value={answer}
                          onChangeText={(value) => setUserInputDraft(question.id, value)}
                          keyboardAppearance="dark"
                          placeholder={
                            question.isOther
                              ? 'Or enter a custom answer…'
                              : 'Type your answer…'
                          }
                          placeholderTextColor={colors.textMuted}
                          secureTextEntry={question.isSecret}
                          editable={!resolvingUserInput}
                          multiline={!question.isSecret}
                          style={[
                            styles.userInputAnswerInput,
                            question.isSecret && styles.userInputAnswerInputSecret,
                          ]}
                        />
                      ) : null}
                    </View>
                  );
                })}
              </ScrollView>
              {userInputError ? (
                <Text style={styles.userInputErrorText}>{userInputError}</Text>
              ) : null}
              <Pressable
                onPress={() => void submitUserInputRequest()}
                style={({ pressed }) => [
                  styles.userInputSubmitButton,
                  pressed && styles.userInputSubmitButtonPressed,
                  resolvingUserInput && styles.userInputSubmitButtonDisabled,
                ]}
                disabled={resolvingUserInput}
              >
                <Text style={styles.userInputSubmitButtonText}>
                  {resolvingUserInput ? 'Submitting…' : 'Submit answers'}
                </Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      </View>
    );
  }
);

// ── Compose View ───────────────────────────────────────────────────

function ComposeView({
  startWorkspaceLabel,
  modelReasoningLabel,
  collaborationModeLabel,
  fastModeEnabled,
  fastModeLabel,
  onSuggestion,
  onOpenWorkspacePicker,
  onOpenModelReasoningPicker,
  onOpenCollaborationModePicker,
  onToggleFastMode,
}: {
  startWorkspaceLabel: string;
  modelReasoningLabel: string;
  collaborationModeLabel: string;
  fastModeEnabled: boolean;
  fastModeLabel: string;
  onSuggestion: (s: string) => void;
  onOpenWorkspacePicker: () => void;
  onOpenModelReasoningPicker: () => void;
  onOpenCollaborationModePicker: () => void;
  onToggleFastMode: () => void;
}) {
  return (
    <ScrollView
      style={styles.composeScroll}
      contentContainerStyle={styles.composeContainer}
      showsVerticalScrollIndicator={false}
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      keyboardShouldPersistTaps="handled"
      onScrollBeginDrag={Keyboard.dismiss}
      alwaysBounceVertical
      overScrollMode="always"
    >
      <View style={styles.composeIcon}>
        <BrandMark size={52} />
      </View>
      <Text style={styles.composeTitle}>Let's build</Text>
      <Text style={styles.composeSubtitle}>clawdex-mobile</Text>
      <Pressable
        style={({ pressed }) => [
          styles.workspaceSelectBtn,
          pressed && styles.workspaceSelectBtnPressed,
        ]}
        onPress={onOpenWorkspacePicker}
      >
        <Ionicons name="folder-open-outline" size={16} color={colors.textMuted} />
        <Text style={styles.workspaceSelectLabel} numberOfLines={1}>
          {startWorkspaceLabel}
        </Text>
        <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
      </Pressable>
      <Pressable
        style={({ pressed }) => [
          styles.workspaceSelectBtn,
          pressed && styles.workspaceSelectBtnPressed,
        ]}
        onPress={onOpenModelReasoningPicker}
      >
        <Ionicons name="sparkles-outline" size={16} color={colors.textMuted} />
        <Text style={styles.workspaceSelectLabel} numberOfLines={1}>
          {modelReasoningLabel}
        </Text>
        <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
      </Pressable>
      <Pressable
        style={({ pressed }) => [
          styles.workspaceSelectBtn,
          pressed && styles.workspaceSelectBtnPressed,
        ]}
        onPress={onOpenCollaborationModePicker}
      >
        <Ionicons name="map-outline" size={16} color={colors.textMuted} />
        <Text style={styles.workspaceSelectLabel} numberOfLines={1}>
          {collaborationModeLabel}
        </Text>
        <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
      </Pressable>
      <Pressable
        style={({ pressed }) => [
          styles.workspaceSelectBtn,
          pressed && styles.workspaceSelectBtnPressed,
        ]}
        onPress={onToggleFastMode}
      >
        <Ionicons name="flash-outline" size={16} color={colors.textMuted} />
        <Text style={styles.workspaceSelectLabel} numberOfLines={1}>
          {fastModeLabel}
        </Text>
        <Ionicons
          name={fastModeEnabled ? 'checkmark-circle' : 'ellipse-outline'}
          size={14}
          color={colors.textMuted}
        />
      </Pressable>
      <View style={styles.suggestions}>
        {SUGGESTIONS.map((s, index) => (
          <Pressable
            key={`${s}-${String(index)}`}
            style={({ pressed }) => [
              styles.suggestionCard,
              pressed && styles.suggestionCardPressed,
            ]}
            onPress={() => onSuggestion(s)}
          >
            <Text style={styles.suggestionText}>{s}</Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

// ── Chat View ──────────────────────────────────────────────────────

function ChatView({
  chat,
  bridgeUrl,
  bridgeToken,
  showToolCalls,
  scrollRef,
  inlineChoicesEnabled,
  onInlineOptionSelect,
  onPinnedAutoScroll,
  onScrollInteractionStart,
  autoScrollStateRef,
  bottomInset,
}: {
  chat: Chat;
  bridgeUrl: string;
  bridgeToken: string | null;
  showToolCalls: boolean;
  scrollRef: React.RefObject<FlatList<ChatTranscriptMessage> | null>;
  inlineChoicesEnabled: boolean;
  onInlineOptionSelect: (value: string) => void;
  onPinnedAutoScroll: (animated?: boolean) => void;
  onScrollInteractionStart: () => void;
  autoScrollStateRef: React.MutableRefObject<AutoScrollState>;
  bottomInset: number;
}) {
  const visibleMessages = useMemo(
    () => getVisibleTranscriptMessages(chat.messages, showToolCalls),
    [chat.messages, showToolCalls]
  );
  const [visibleStartIndex, setVisibleStartIndex] = useState(() =>
    getInitialVisibleMessageStartIndex(visibleMessages.length)
  );
  const paginatedMessages = useMemo(
    () => visibleMessages.slice(visibleStartIndex),
    [visibleMessages, visibleStartIndex]
  );
  const displayMessages = useMemo(
    () => [...paginatedMessages].reverse(),
    [paginatedMessages]
  );
  const olderMessageCount = visibleStartIndex;
  const hasOlderMessages = olderMessageCount > 0;
  const inlineChoiceSet = useMemo(
    () => (inlineChoicesEnabled ? findInlineChoiceSet(paginatedMessages) : null),
    [inlineChoicesEnabled, paginatedMessages]
  );
  useEffect(() => {
    setVisibleStartIndex(getInitialVisibleMessageStartIndex(visibleMessages.length));
  }, [chat.id]);

  useEffect(() => {
    setVisibleStartIndex((current) => {
      const maxStartIndex = Math.max(visibleMessages.length - 1, 0);
      return current > maxStartIndex ? maxStartIndex : current;
    });
  }, [visibleMessages.length]);

  const loadOlderMessages = useCallback(() => {
    setVisibleStartIndex((current) =>
      Math.max(0, current - CHAT_MESSAGE_PAGE_SIZE)
    );
  }, []);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset } = event.nativeEvent;
      const distanceFromBottom = contentOffset.y;
      autoScrollStateRef.current.shouldStickToBottom = distanceFromBottom <= spacing.xl * 2;
    },
    [autoScrollStateRef]
  );

  useEffect(() => {
    autoScrollStateRef.current.shouldStickToBottom = true;
    autoScrollStateRef.current.isUserInteracting = false;
    autoScrollStateRef.current.isMomentumScrolling = false;
  }, [autoScrollStateRef, chat.id]);
  const messageListContentStyle = useMemo(
    () => [styles.messageListContent, { paddingBottom: bottomInset }],
    [bottomInset]
  );
  const isLargeChat = visibleMessages.length >= LARGE_CHAT_MESSAGE_COUNT_THRESHOLD;
  const keyExtractor = useCallback((msg: ChatTranscriptMessage) => msg.id, []);
  const renderMessageItem = useCallback<ListRenderItem<ChatTranscriptMessage>>(
    ({ item: msg }) => {
      const showInlineChoices = inlineChoiceSet?.messageId === msg.id;
      return (
        <View style={styles.chatMessageBlock}>
          <ChatMessage message={msg} bridgeUrl={bridgeUrl} bridgeToken={bridgeToken} />
          {showInlineChoices ? (
            <View style={styles.inlineChoiceOptions}>
              {inlineChoiceSet.options.map((option, index) => (
                <Pressable
                  key={`${msg.id}-${index}-${option.label}`}
                  style={({ pressed }) => [
                    styles.inlineChoiceOptionButton,
                    pressed && styles.inlineChoiceOptionButtonPressed,
                  ]}
                  onPress={() => onInlineOptionSelect(option.label)}
                >
                  <View style={styles.inlineChoiceOptionRow}>
                    <Text style={styles.inlineChoiceOptionIndex}>{`${String(index + 1)}.`}</Text>
                    <Text style={styles.inlineChoiceOptionLabel}>{option.label}</Text>
                  </View>
                  {option.description.trim() ? (
                    <Text style={styles.inlineChoiceOptionDescription}>
                      {option.description}
                    </Text>
                  ) : null}
                </Pressable>
              ))}
              <Text style={styles.inlineChoiceHint}>
                Tap an option to fill the reply box.
              </Text>
            </View>
          ) : null}
        </View>
      );
    },
    [bridgeToken, bridgeUrl, inlineChoiceSet, onInlineOptionSelect]
  );

  const paginationHeader = useMemo(() => {
    if (!hasOlderMessages) {
      return null;
    }

    const olderBatchCount = Math.min(CHAT_MESSAGE_PAGE_SIZE, olderMessageCount);
    return (
      <View style={styles.messagePaginationWrap}>
        <Pressable
          onPress={loadOlderMessages}
          style={({ pressed }) => [
            styles.messagePaginationButton,
            pressed && styles.messagePaginationButtonPressed,
          ]}>
          <Ionicons
            name="chevron-up-circle-outline"
            size={16}
            color={colors.textPrimary}
          />
          <Text style={styles.messagePaginationButtonText}>
            {`Load ${String(olderBatchCount)} earlier message${
              olderBatchCount === 1 ? '' : 's'
            }`}
          </Text>
        </Pressable>
        <Text style={styles.messagePaginationMeta}>
          {`Showing ${String(paginatedMessages.length)} of ${String(visibleMessages.length)} messages`}
        </Text>
      </View>
    );
  }, [
    hasOlderMessages,
    loadOlderMessages,
    olderMessageCount,
    paginatedMessages.length,
    visibleMessages.length,
  ]);

  return (
    <View style={styles.messageListShell}>
      <FlatList
        key={chat.id}
        ref={scrollRef}
        data={displayMessages}
        keyExtractor={keyExtractor}
        renderItem={renderMessageItem}
        ListFooterComponent={paginationHeader}
        style={styles.messageList}
        contentContainerStyle={messageListContentStyle}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        inverted
        showsVerticalScrollIndicator={false}
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        keyboardShouldPersistTaps="handled"
        onScrollBeginDrag={() => {
          onScrollInteractionStart();
          Keyboard.dismiss();
          autoScrollStateRef.current.isUserInteracting = true;
          autoScrollStateRef.current.isMomentumScrolling = false;
          autoScrollStateRef.current.shouldStickToBottom = false;
        }}
        onScrollEndDrag={() => {
          if (!autoScrollStateRef.current.isMomentumScrolling) {
            autoScrollStateRef.current.isUserInteracting = false;
          }
        }}
        onMomentumScrollBegin={() => {
          autoScrollStateRef.current.isMomentumScrolling = true;
        }}
        onMomentumScrollEnd={() => {
          autoScrollStateRef.current.isUserInteracting = false;
          autoScrollStateRef.current.isMomentumScrolling = false;
        }}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        onContentSizeChange={() => {
          onPinnedAutoScroll(false);
        }}
        initialNumToRender={Math.min(displayMessages.length, 16)}
        maxToRenderPerBatch={Math.min(displayMessages.length, 12)}
        updateCellsBatchingPeriod={isLargeChat ? 16 : undefined}
        windowSize={isLargeChat ? 15 : 11}
        removeClippedSubviews={Platform.OS === 'android'}
      />
    </View>
  );
}

function QueuedMessageCard({
  message,
  remainingCount,
  steerEnabled,
  steerDisabledReason,
  onSteer,
}: {
  message: QueuedChatMessage;
  remainingCount: number;
  steerEnabled: boolean;
  steerDisabledReason: string | null;
  onSteer: () => void;
}) {
  return (
    <View style={[styles.planCard, styles.queuedMessageCard]}>
      <View style={styles.queuedMessageHeader}>
        <View style={styles.queuedMessageHeaderText}>
          <Text style={styles.planCardTitle}>Queued message</Text>
          {remainingCount > 0 ? (
            <Text style={styles.queuedMessageSummary}>{`+${String(remainingCount)} more queued`}</Text>
          ) : null}
        </View>
        <Pressable
          onPress={onSteer}
          disabled={!steerEnabled}
          style={({ pressed }) => [
            styles.queuedMessageActionButton,
            !steerEnabled && styles.queuedMessageActionButtonDisabled,
            pressed && steerEnabled && styles.queuedMessageActionButtonPressed,
          ]}
        >
          <Text
            style={[
              styles.queuedMessageActionLabel,
              !steerEnabled && styles.queuedMessageActionLabelDisabled,
            ]}
          >
            Steer
          </Text>
        </Pressable>
      </View>
      <Text numberOfLines={2} style={styles.queuedMessageBody}>
        {message.content}
      </Text>
      {steerDisabledReason ? (
        <Text style={styles.queuedMessageHint}>{steerDisabledReason}</Text>
      ) : null}
    </View>
  );
}

function PlanCard({
  plan,
  collapsed,
  onToggleCollapse,
}: {
  plan: ActivePlanState;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const hasSteps = plan.steps.length > 0;
  const hasStructuredUpdate = hasSteps || Boolean(plan.explanation?.trim());
  const deltaPreview = toTickerSnippet(plan.deltaText, 260);
  if (!hasStructuredUpdate && !deltaPreview) {
    return null;
  }

  const title = hasStructuredUpdate ? 'Updated Plan' : 'Proposed Plan';
  const activeStep =
    plan.steps.find((step) => step.status === 'inProgress') ??
    plan.steps.find((step) => step.status === 'pending') ??
    plan.steps[plan.steps.length - 1] ??
    null;
  const collapsedSummary =
    activeStep?.step ??
    plan.explanation?.trim() ??
    deltaPreview ??
    '(no steps provided)';

  return (
    <View style={[styles.planCard, styles.planOverlayCard]}>
      <Pressable
        style={({ pressed }) => [
          styles.planCardHeader,
          styles.planCardHeaderPressable,
          pressed && styles.modelChipPressed,
        ]}
        onPress={onToggleCollapse}
      >
        <Ionicons name="map-outline" size={14} color={colors.textPrimary} />
        <View style={styles.planCardHeaderText}>
          <Text style={styles.planCardTitle}>{title}</Text>
          {collapsed ? (
            <Text style={styles.planCardSummary} numberOfLines={1}>
              {collapsedSummary}
            </Text>
          ) : null}
        </View>
        <Ionicons
          name={collapsed ? 'chevron-down-outline' : 'chevron-up-outline'}
          size={16}
          color={colors.textMuted}
        />
      </Pressable>

      {collapsed ? null : (
        <>
          {plan.explanation ? (
            <Text style={styles.planExplanationText}>{plan.explanation}</Text>
          ) : null}

          {hasSteps ? (
            <View style={styles.planStepsList}>
              {plan.steps.map((step, index) => (
                <View key={`${plan.turnId}-${index}-${step.step}`} style={styles.planStepRow}>
                  <Text
                    style={[
                      styles.planStepStatus,
                      step.status === 'completed'
                        ? styles.planStepStatusCompleted
                        : step.status === 'inProgress'
                          ? styles.planStepStatusInProgress
                          : styles.planStepStatusPending,
                    ]}
                  >
                    {renderPlanStatusGlyph(step.status)}
                  </Text>
                  <Text
                    style={[
                      styles.planStepText,
                      step.status === 'completed'
                        ? styles.planStepTextCompleted
                        : step.status === 'inProgress'
                          ? styles.planStepTextInProgress
                          : styles.planStepTextPending,
                    ]}
                  >
                    {step.step}
                  </Text>
                </View>
              ))}
            </View>
          ) : hasStructuredUpdate ? (
            <Text style={styles.planDeltaText}>(no steps provided)</Text>
          ) : null}

          {!hasStructuredUpdate && deltaPreview ? (
            <Text style={styles.planDeltaText}>{deltaPreview}</Text>
          ) : null}
        </>
      )}
    </View>
  );
}

// ── Helpers ────────────────────────────────────────────────────────

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const values = value.filter((entry): entry is string => typeof entry === 'string');
  return values.length > 0 ? values : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readIntegerLike(value: unknown): number | null {
  const numberValue = readNumber(value);
  if (numberValue !== null) {
    return Math.max(0, Math.floor(numberValue));
  }

  const stringValue = readString(value)?.trim();
  if (!stringValue) {
    return null;
  }

  const parsed = Number(stringValue);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function mergeThreadContextUsage(
  previous: ThreadContextUsage | null,
  next: ThreadContextUsage | null
): ThreadContextUsage | null {
  if (!next) {
    return previous;
  }

  return {
    totalTokens: next.totalTokens ?? previous?.totalTokens ?? null,
    lastTokens: next.lastTokens ?? previous?.lastTokens ?? null,
    modelContextWindow: next.modelContextWindow ?? previous?.modelContextWindow ?? null,
    updatedAtMs: next.updatedAtMs,
  };
}

function formatTokenCount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions >= 10 ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }

  if (abs >= 1_000) {
    const thousands = value / 1_000;
    return `${thousands >= 10 ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
  }

  return String(Math.round(value));
}

function compactPlanDelta(value: string): string {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .slice(-1200);
}

function buildNextPlanStateFromDelta(
  previous: ActivePlanState | null,
  threadId: string,
  turnId: string,
  rawDelta: string
): ActivePlanState {
  const sameTurn =
    previous && previous.threadId === threadId && previous.turnId === turnId;
  const nextDelta = compactPlanDelta(
    sameTurn ? `${previous.deltaText}\n${rawDelta}` : rawDelta
  );

  return {
    threadId,
    turnId,
    explanation: sameTurn ? previous.explanation : null,
    steps: sameTurn ? previous.steps : [],
    deltaText: nextDelta,
    updatedAt: new Date().toISOString(),
  };
}

function buildNextPlanStateFromUpdate(
  previous: ActivePlanState | null,
  next: {
    threadId: string;
    turnId: string;
    explanation: string | null;
    plan: TurnPlanStep[];
  }
): ActivePlanState {
  const sameTurn =
    previous &&
    previous.threadId === next.threadId &&
    previous.turnId === next.turnId;

  return {
    threadId: next.threadId,
    turnId: next.turnId,
    explanation: next.explanation,
    steps: next.plan,
    deltaText: sameTurn ? previous.deltaText : '',
    updatedAt: new Date().toISOString(),
  };
}

function renderPlanStatusGlyph(status: TurnPlanStep['status']): string {
  if (status === 'completed') {
    return '✔';
  }
  if (status === 'inProgress') {
    return '□';
  }
  return '□';
}

function toTurnPlanUpdate(
  value: unknown,
  fallbackThreadId: string | null = null
): {
  threadId: string;
  turnId: string;
  explanation: string | null;
  plan: TurnPlanStep[];
} | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const threadId = readString(record.threadId) ?? fallbackThreadId;
  const turnId = readString(record.turnId);
  if (!threadId || !turnId) {
    return null;
  }

  const rawPlan = Array.isArray(record.plan) ? record.plan : [];
  const plan: TurnPlanStep[] = rawPlan
    .map((item) => {
      const itemRecord = toRecord(item);
      if (!itemRecord) {
        return null;
      }

      const step = readString(itemRecord.step);
      const status = readString(itemRecord.status);
      if (
        !step ||
        (status !== 'pending' && status !== 'inProgress' && status !== 'completed')
      ) {
        return null;
      }

      return {
        step,
        status,
      } satisfies TurnPlanStep;
    })
    .filter((item): item is TurnPlanStep => item !== null);

  return {
    threadId,
    turnId,
    explanation: readString(record.explanation),
    plan,
  };
}

function toPendingUserInputRequest(value: unknown): PendingUserInputRequest | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const id = readString(record.id);
  const threadId = readString(record.threadId);
  const turnId = readString(record.turnId);
  const itemId = readString(record.itemId);
  const requestedAt = readString(record.requestedAt);
  const rawQuestions = Array.isArray(record.questions) ? record.questions : [];
  if (!id || !threadId || !turnId || !itemId || !requestedAt || rawQuestions.length === 0) {
    return null;
  }

  const questions = rawQuestions
    .map((item) => {
      const itemRecord = toRecord(item);
      if (!itemRecord) {
        return null;
      }

      const questionId = readString(itemRecord.id);
      const header = readString(itemRecord.header);
      const question = readString(itemRecord.question);
      if (!questionId || !header || !question) {
        return null;
      }

      const parsedInlineOptions = parseInlineOptionsFromQuestionText(question);

      const parsedOptions = Array.isArray(itemRecord.options)
        ? itemRecord.options
            .map((option) => {
              const optionRecord = toRecord(option);
              if (!optionRecord) {
                return null;
              }

              const label =
                readString(optionRecord.label) ??
                readString(optionRecord.title) ??
                readString(optionRecord.value) ??
                readString(optionRecord.text);
              const description =
                readString(optionRecord.description) ??
                readString(optionRecord.detail) ??
                '';
              if (!label) {
                return null;
              }
              return {
                label,
                description,
              };
            })
            .filter(
              (option): option is { label: string; description: string } => option !== null
            )
        : null;
      const options =
        parsedOptions && parsedOptions.length > 0
          ? parsedOptions
          : parsedInlineOptions.options;

      return {
        id: questionId,
        header,
        question: parsedInlineOptions.question,
        isOther: readBoolean(itemRecord.isOther) ?? false,
        isSecret: readBoolean(itemRecord.isSecret) ?? false,
        options,
      } satisfies PendingUserInputRequest['questions'][number];
    })
    .filter(
      (question): question is PendingUserInputRequest['questions'][number] =>
        question !== null
    );

  if (questions.length === 0) {
    return null;
  }

  return {
    id,
    threadId,
    turnId,
    itemId,
    requestedAt,
    questions,
  };
}

function buildUserInputDrafts(request: PendingUserInputRequest): Record<string, string> {
  const drafts: Record<string, string> = {};
  for (const question of request.questions) {
    drafts[question.id] = '';
  }
  return drafts;
}

function normalizeQuestionAnswers(value: string): string[] {
  return value
    .split('\n')
    .flatMap((line) => line.split(','))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function findInlineChoiceSet(messages: ChatTranscriptMessage[]): {
  messageId: string;
  options: Array<{ label: string; description: string }>;
} | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') {
      continue;
    }

    if (message.content.length > 1200) {
      continue;
    }

    const parsed = parseInlineOptionsFromQuestionText(message.content);
    if (!parsed.options || parsed.options.length < 2 || parsed.options.length > 5) {
      continue;
    }

    const cueSource = parsed.question.trim();
    const hasCue =
      cueSource.includes('?') ||
      INLINE_CHOICE_CUE_PATTERNS.some((pattern) => pattern.test(cueSource));
    if (!hasCue) {
      continue;
    }

    return {
      messageId: message.id,
      options: parsed.options,
    };
  }

  return null;
}

function stripOptionText(value: string): string {
  return value
    .replace(/^[`*_~]+/g, '')
    .replace(/[`*_~]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitOptionLine(value: string): { label: string; description: string } {
  const normalized = value.replace(/^[-*+\u2022]\s+/, '').trim();
  if (!normalized) {
    return {
      label: '',
      description: '',
    };
  }

  const separators = [' \u2014 ', ' - ', ': '];
  for (const separator of separators) {
    const separatorIndex = normalized.indexOf(separator);
    if (separatorIndex <= 0 || separatorIndex >= normalized.length - separator.length) {
      continue;
    }

    const label = stripOptionText(normalized.slice(0, separatorIndex));
    const description = stripOptionText(
      normalized.slice(separatorIndex + separator.length)
    );
    if (!label) {
      continue;
    }

    return {
      label,
      description,
    };
  }

  return {
    label: stripOptionText(normalized),
    description: '',
  };
}

function isLikelyOptionContinuationLine(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  return (
    /^[-*+\u2022]\s+/.test(trimmed) ||
    /^(impact|trade[- ]?off|reason|because|benefit|cost|why)\b/i.test(trimmed)
  );
}

function parseInlineOptionsFromQuestionText(value: string): {
  question: string;
  options: Array<{ label: string; description: string }> | null;
} {
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return {
      question: value,
      options: null,
    };
  }

  const promptLines: string[] = [];
  const options: Array<{ label: string; description: string }> = [];
  let hasMatchedOptionLine = false;

  for (const line of lines) {
    const optionMatch = line.match(INLINE_OPTION_LINE_PATTERN);
    if (optionMatch) {
      const parsed = splitOptionLine(optionMatch[1] ?? '');
      if (parsed.label) {
        options.push(parsed);
        hasMatchedOptionLine = true;
        continue;
      }
    }

    if (hasMatchedOptionLine && options.length > 0 && isLikelyOptionContinuationLine(line)) {
      const continuation = stripOptionText(line.replace(/^[-*+\u2022]\s+/, ''));
      if (continuation) {
        const lastOption = options[options.length - 1];
        lastOption.description = lastOption.description
          ? `${lastOption.description} ${continuation}`
          : continuation;
      }
      continue;
    }

    promptLines.push(line);
  }

  if (options.length < 2) {
    return {
      question: value,
      options: null,
    };
  }

  const question = promptLines.length > 0 ? promptLines.join('\n') : 'Select one option.';

  return {
    question,
    options,
  };
}

function normalizeWorkspacePath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeAttachmentPath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toMentionInput(path: string): MentionInput {
  const segments = path.split(/[\\/]/).filter(Boolean);
  const name = segments[segments.length - 1] ?? path;
  return {
    path,
    name,
  };
}

function toOptimisticUserContent(
  content: string,
  mentions: MentionInput[],
  localImages: LocalImageInput[]
): string {
  if (mentions.length === 0 && localImages.length === 0) {
    return content;
  }

  const mentionLines = mentions.map((mention) => `[file: ${mention.path}]`);
  const localImageLines = localImages.map((image) => `[local image: ${image.path}]`);
  return [content, ...mentionLines, ...localImageLines].join('\n');
}

function toPathBasename(path: string): string {
  const normalized = path.trim();
  if (!normalized) {
    return 'image';
  }

  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? normalized;
}

function toAttachmentPathSuggestions(
  candidates: string[],
  query: string,
  pendingMentionPaths: string[]
): string[] {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return [];
  }

  const normalizedQuery = query.trim().toLowerCase();
  const selectedSet = new Set(pendingMentionPaths.map((path) => path.trim().toLowerCase()));
  const startsWithMatches: string[] = [];
  const containsMatches: string[] = [];

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }

    const lowered = trimmed.toLowerCase();
    if (selectedSet.has(lowered)) {
      continue;
    }

    if (!normalizedQuery) {
      startsWithMatches.push(trimmed);
      if (startsWithMatches.length >= 8) {
        break;
      }
      continue;
    }

    if (lowered.startsWith(normalizedQuery)) {
      startsWithMatches.push(trimmed);
      continue;
    }

    if (lowered.includes(`/${normalizedQuery}`) || lowered.includes(normalizedQuery)) {
      containsMatches.push(trimmed);
    }
  }

  return [...startsWithMatches, ...containsMatches].slice(0, 8);
}

function extractWorkspaceOptions(chats: ChatSummary[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const chat of chats) {
    const cwd = normalizeWorkspacePath(chat.cwd);
    if (!cwd || seen.has(cwd)) {
      continue;
    }
    seen.add(cwd);
    result.push(cwd);
  }

  return result;
}

function normalizeModelId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeReasoningEffort(
  effort: string | null | undefined
): ReasoningEffort | null {
  if (typeof effort !== 'string') {
    return null;
  }

  const normalized = effort.trim().toLowerCase();
  if (
    normalized === 'none' ||
    normalized === 'minimal' ||
    normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high' ||
    normalized === 'xhigh'
  ) {
    return normalized;
  }

  return null;
}

function normalizeServiceTier(
  serviceTier: string | null | undefined
): ServiceTier | null {
  if (typeof serviceTier !== 'string') {
    return null;
  }

  const normalized = serviceTier.trim().toLowerCase();
  if (normalized === 'flex' || normalized === 'fast') {
    return normalized;
  }

  return null;
}

function toFastModeServiceTier(
  serviceTier: ServiceTier | null | undefined
): ServiceTier | null {
  return serviceTier === 'fast' ? 'fast' : null;
}

function toApprovalPolicyForMode(mode: ApprovalMode | null | undefined): ApprovalPolicy {
  return mode === 'yolo' ? 'never' : 'untrusted';
}

function getChatModelPreferencesPath(): string | null {
  const base = FileSystem.documentDirectory;
  if (typeof base !== 'string' || base.trim().length === 0) {
    return null;
  }

  return `${base}${CHAT_MODEL_PREFERENCES_FILE}`;
}

function getChatPlanSnapshotsPath(): string | null {
  const base = FileSystem.documentDirectory;
  if (typeof base !== 'string' || base.trim().length === 0) {
    return null;
  }

  return `${base}${CHAT_PLAN_SNAPSHOTS_FILE}`;
}

function parseChatModelPreferences(raw: string): Record<string, ChatModelPreference> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    const parsedRecord = toRecord(parsed);
    if (!parsedRecord || parsedRecord.version !== CHAT_MODEL_PREFERENCES_VERSION) {
      return {};
    }

    const entries = toRecord(parsedRecord.entries);
    if (!entries) {
      return {};
    }

    const result: Record<string, ChatModelPreference> = {};
    for (const [chatId, value] of Object.entries(entries)) {
      const entry = toRecord(value);
      if (!entry) {
        continue;
      }

      const normalizedChatId = chatId.trim();
      if (!normalizedChatId) {
        continue;
      }

      result[normalizedChatId] = {
        modelId: normalizeModelId(readString(entry.modelId)),
        effort: normalizeReasoningEffort(readString(entry.effort)),
        serviceTier: toFastModeServiceTier(
          normalizeServiceTier(readString(entry.serviceTier))
        ),
        updatedAt: readString(entry.updatedAt) ?? new Date(0).toISOString(),
      };
    }

    return result;
  } catch {
    return {};
  }
}

function parseChatPlanSnapshots(raw: string): Record<string, ActivePlanState> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    const parsedRecord = toRecord(parsed);
    if (!parsedRecord || parsedRecord.version !== CHAT_PLAN_SNAPSHOTS_VERSION) {
      return {};
    }

    const entries = toRecord(parsedRecord.entries);
    if (!entries) {
      return {};
    }

    const result: Record<string, ActivePlanState> = {};
    for (const [chatId, value] of Object.entries(entries)) {
      const entry = toRecord(value);
      if (!entry) {
        continue;
      }

      const normalizedChatId = chatId.trim();
      const threadId = readString(entry.threadId) ?? normalizedChatId;
      const turnId = readString(entry.turnId);
      if (!normalizedChatId || !threadId || !turnId) {
        continue;
      }

      const rawSteps = Array.isArray(entry.steps) ? entry.steps : [];
      const steps: TurnPlanStep[] = rawSteps
        .map((item) => {
          const itemRecord = toRecord(item);
          if (!itemRecord) {
            return null;
          }

          const step = readString(itemRecord.step);
          const status = readString(itemRecord.status);
          if (
            !step ||
            (status !== 'pending' && status !== 'inProgress' && status !== 'completed')
          ) {
            return null;
          }

          return {
            step,
            status,
          } satisfies TurnPlanStep;
        })
        .filter((item): item is TurnPlanStep => item !== null);

      result[normalizedChatId] = {
        threadId,
        turnId,
        explanation: readString(entry.explanation),
        steps,
        deltaText: readString(entry.deltaText) ?? '',
        updatedAt: readString(entry.updatedAt) ?? new Date(0).toISOString(),
      };
    }

    return result;
  } catch {
    return {};
  }
}

function formatCollaborationModeLabel(mode: CollaborationMode): string {
  return mode === 'plan' ? 'Plan mode' : 'Default mode';
}

function createQueuedMessageId(): string {
  return `queued-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getInitialVisibleMessageStartIndex(totalMessageCount: number): number {
  if (totalMessageCount <= LARGE_CHAT_MESSAGE_COUNT_THRESHOLD) {
    return 0;
  }

  return Math.max(0, totalMessageCount - CHAT_INITIAL_VISIBLE_MESSAGE_WINDOW);
}

function resolveSnapshotCollaborationMode(
  snapshot: ThreadRuntimeSnapshot | null | undefined
): CollaborationMode {
  if (!snapshot) {
    return 'default';
  }

  return snapshot.pendingUserInputRequest ? 'plan' : 'default';
}

function formatReasoningEffort(effort: ReasoningEffort): string {
  if (effort === 'xhigh') {
    return 'X-High';
  }

  if (effort === 'none') {
    return 'None';
  }

  if (effort === 'minimal') {
    return 'Minimal';
  }

  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

function shouldAutoEnablePlanModeFromChat(chat: Chat): boolean {
  const latestAssistantMessage = [...chat.messages]
    .reverse()
    .find((message) => message.role === 'assistant');
  if (!latestAssistantMessage) {
    return false;
  }

  const normalized = latestAssistantMessage.content.toLowerCase();
  return (
    normalized.includes('request_user_input is unavailable in default mode') ||
    (normalized.includes('request_user_input') &&
      normalized.includes('default mode') &&
      normalized.includes('plan mode') &&
      normalized.includes('unavailable'))
  );
}

function parseSlashCommand(input: string): { name: string; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  if (trimmed === '/') {
    return {
      name: 'help',
      args: '',
    };
  }

  const match = trimmed.match(/^\/([a-zA-Z0-9_-]+)\s*(.*)$/);
  if (!match) {
    return null;
  }

  return {
    name: match[1].toLowerCase(),
    args: match[2] ?? '',
  };
}

function parseSlashQuery(input: string): string | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  if (trimmed === '/') {
    return '';
  }

  const afterSlash = trimmed.slice(1);
  const token = afterSlash.split(/\s+/)[0] ?? '';
  return token.toLowerCase();
}

function findSlashCommandDefinition(name: string): SlashCommandDefinition | null {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return (
    SLASH_COMMANDS.find((command) => {
      if (command.name.toLowerCase() === normalized) {
        return true;
      }

      return (
        command.aliases?.some((alias) => alias.toLowerCase() === normalized) ?? false
      );
    }) ?? null
  );
}

function filterSlashCommands(query: string): SlashCommandDefinition[] {
  const normalized = query.trim().toLowerCase();
  const dedupedCommands = dedupeSlashCommandsByName(SLASH_COMMANDS);
  if (!normalized) {
    return dedupedCommands;
  }

  return dedupedCommands.filter((command) => {
    const byName = command.name.toLowerCase().includes(normalized);
    const bySummary = command.summary.toLowerCase().includes(normalized);
    const byAlias =
      command.aliases?.some((alias) => alias.toLowerCase().includes(normalized)) ?? false;
    return byName || bySummary || byAlias;
  });
}

function dedupeSlashCommandsByName(
  commands: SlashCommandDefinition[]
): SlashCommandDefinition[] {
  const seen = new Set<string>();
  const result: SlashCommandDefinition[] = [];

  for (const command of commands) {
    const key = command.name.trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(command);
  }

  return result;
}

function stripMarkdownInline(value: string): string {
  return value
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[_~]/g, '');
}

function toTickerSnippet(
  value: string | null | undefined,
  maxLength = 72
): string | null {
  if (!value) {
    return null;
  }

  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return null;
  }

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  return `${cleaned.slice(0, Math.max(1, maxLength - 1))}…`;
}

function mergeStreamingDelta(previous: string | null, delta: string): string {
  if (!delta) {
    return previous ?? '';
  }

  const prev = previous ?? '';
  if (!prev) {
    return delta;
  }

  if (delta === prev || prev.endsWith(delta)) {
    return prev;
  }

  // Some transports send cumulative snapshots instead of token deltas.
  if (delta.startsWith(prev)) {
    return delta;
  }

  const maxOverlap = Math.min(prev.length, delta.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (prev.endsWith(delta.slice(0, overlap))) {
      return prev + delta.slice(overlap);
    }
  }

  return prev + delta;
}

function describeStartedToolEvent(
  item: Record<string, unknown> | null
): { eventType: string; detail: string } | null {
  const itemType = readString(item?.type);
  if (itemType === 'commandExecution') {
    const command = toTickerSnippet(readString(item?.command), 80) ?? 'Command';
    return {
      eventType: 'command.running',
      detail: buildToolEventDetail(command, 'running'),
    };
  }

  if (itemType === 'fileChange') {
    return {
      eventType: 'file_change.running',
      detail: buildToolEventDetail('Applying file changes', 'running'),
    };
  }

  if (itemType === 'mcpToolCall') {
    const detail = [readString(item?.server), readString(item?.tool)]
      .filter(Boolean)
      .join(' / ') || 'Tool call';
    return {
      eventType: 'tool.running',
      detail: buildToolEventDetail(detail, 'running'),
    };
  }

  return null;
}

function describeCompletedToolEvent(
  item: Record<string, unknown> | null
): { eventType: string; detail: string } | null {
  const itemType = readString(item?.type);
  const rawStatus = readString(item?.status);
  const status: 'complete' | 'error' =
    rawStatus === 'failed' || rawStatus === 'error' ? 'error' : 'complete';

  if (itemType === 'commandExecution') {
    const command = toTickerSnippet(readString(item?.command), 80) ?? 'Command';
    return {
      eventType: 'command.completed',
      detail: buildToolEventDetail(command, status),
    };
  }

  if (itemType === 'fileChange') {
    return {
      eventType: 'file_change.completed',
      detail: buildToolEventDetail('File changes', status),
    };
  }

  if (itemType === 'mcpToolCall') {
    const detail = [readString(item?.server), readString(item?.tool)]
      .filter(Boolean)
      .join(' / ') || 'Tool call';
    return {
      eventType: 'tool.completed',
      detail: buildToolEventDetail(detail, status),
    };
  }

  return null;
}

function describeWebSearchToolEvent(
  msg: Record<string, unknown> | null
): { eventType: string; detail: string } | null {
  const query = toTickerSnippet(readString(msg?.query), 80);
  return {
    eventType: 'web_search.running',
    detail: buildToolEventDetail(query ? `Web search: ${query}` : 'Web search', 'running'),
  };
}

function buildToolEventDetail(
  label: string,
  status: 'running' | 'complete' | 'error'
): string {
  return `${label} | ${status}`;
}

function toToolBlockState(
  event: RunEvent
): {
  command: string;
  status: 'running' | 'complete' | 'error';
  icon: keyof typeof Ionicons.glyphMap;
} | null {
  const rawDetail = event.detail?.trim();
  if (!rawDetail) {
    return null;
  }

  const separatorIndex = rawDetail.lastIndexOf('|');
  const command =
    separatorIndex >= 0 ? rawDetail.slice(0, separatorIndex).trim() : rawDetail;
  const rawStatus =
    separatorIndex >= 0
      ? rawDetail.slice(separatorIndex + 1).trim().toLowerCase()
      : '';

  const status: 'running' | 'complete' | 'error' =
    rawStatus === 'running'
      ? 'running'
      : rawStatus === 'error' || rawStatus === 'failed'
        ? 'error'
        : 'complete';

  const icon: keyof typeof Ionicons.glyphMap = event.eventType.startsWith('web_search')
    ? 'search-outline'
    : event.eventType.startsWith('tool')
      ? 'build-outline'
      : event.eventType.startsWith('file_change')
        ? 'document-outline'
        : 'terminal-outline';

  return {
    command,
    status,
    icon,
  };
}

function appendRunEventHistory(
  previous: RunEvent[],
  threadId: string,
  eventType: string,
  detail: string
): RunEvent[] {
  const last = previous[previous.length - 1];
  if (last && last.eventType === eventType && last.detail === detail) {
    return previous;
  }

  const next: RunEvent = {
    id: `re-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    threadId,
    eventType,
    at: new Date().toISOString(),
    detail,
  };

  return [...previous, next].slice(-MAX_ACTIVE_COMMANDS);
}

function normalizeCodexEventType(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized.length > 0 ? normalized : null;
}

function isCodexRunHeartbeatEvent(codexEventType: string): boolean {
  return CODEX_RUN_HEARTBEAT_EVENT_TYPES.has(codexEventType);
}

function normalizeExternalStatusHint(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized.length > 0 ? normalized : null;
}

function extractNotificationThreadId(
  params: Record<string, unknown> | null,
  msgArg?: Record<string, unknown> | null
): string | null {
  if (!params && !msgArg) {
    return null;
  }

  const msg = msgArg ?? toRecord(params?.msg);
  const threadRecord =
    toRecord(params?.thread) ??
    toRecord(params?.threadState) ??
    toRecord(params?.thread_state) ??
    toRecord(msg?.thread);
  const turnRecord = toRecord(params?.turn) ?? toRecord(msg?.turn);
  const sourceRecord = toRecord(params?.source) ?? toRecord(msg?.source);
  const subagentThreadSpawnRecord = toRecord(
    toRecord(sourceRecord?.subagent)?.thread_spawn
  );

  return (
    readString(msg?.thread_id) ??
    readString(msg?.threadId) ??
    readString(msg?.conversation_id) ??
    readString(msg?.conversationId) ??
    readString(params?.thread_id) ??
    readString(params?.threadId) ??
    readString(params?.conversation_id) ??
    readString(params?.conversationId) ??
    readString(threadRecord?.id) ??
    readString(threadRecord?.thread_id) ??
    readString(threadRecord?.threadId) ??
    readString(threadRecord?.conversation_id) ??
    readString(threadRecord?.conversationId) ??
    readString(turnRecord?.thread_id) ??
    readString(turnRecord?.threadId) ??
    readString(sourceRecord?.thread_id) ??
    readString(sourceRecord?.threadId) ??
    readString(sourceRecord?.conversation_id) ??
    readString(sourceRecord?.conversationId) ??
    readString(sourceRecord?.parent_thread_id) ??
    readString(sourceRecord?.parentThreadId) ??
    readString(subagentThreadSpawnRecord?.parent_thread_id) ??
    null
  );
}

function extractExternalStatusHint(
  params: Record<string, unknown> | null
): string | null {
  if (!params) {
    return null;
  }

  const directCandidates: unknown[] = [
    params.status,
    params.threadStatus,
    params.thread_status,
    params.state,
    params.phase,
  ];
  for (const candidate of directCandidates) {
    const direct = normalizeExternalStatusHint(readString(candidate));
    if (direct) {
      return direct;
    }

    const candidateRecord = toRecord(candidate);
    const typed = normalizeExternalStatusHint(
      readString(candidateRecord?.type) ??
        readString(candidateRecord?.status) ??
        readString(candidateRecord?.state) ??
        readString(candidateRecord?.phase)
    );
    if (typed) {
      return typed;
    }
  }

  const threadRecord =
    toRecord(params.thread) ?? toRecord(params.threadState) ?? toRecord(params.thread_state);
  if (!threadRecord) {
    return null;
  }

  const nestedThreadStatus = normalizeExternalStatusHint(
    readString(threadRecord.status) ??
      readString(toRecord(threadRecord.status)?.type) ??
      readString(threadRecord.state) ??
      readString(threadRecord.phase) ??
      readString(toRecord(threadRecord.lifecycle)?.status)
  );
  return nestedThreadStatus;
}

function isChatSummaryLikelyRunning(chat: ChatSummary): boolean {
  return chat.status === 'running';
}

function isChatLikelyRunning(chat: Chat): boolean {
  if (chat.status === 'running') {
    return true;
  }

  // Trust definitive server statuses — don't second-guess them with heuristics.
  if (chat.status === 'error' || chat.status === 'complete' || chat.status === 'idle') {
    return false;
  }

  const lastMessage = chat.messages[chat.messages.length - 1];
  if (!lastMessage || lastMessage.role !== 'user') {
    return false;
  }

  const updatedAtMs = Date.parse(chat.updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return false;
  }

  return Date.now() - updatedAtMs < LIKELY_RUNNING_RECENT_UPDATE_MS;
}

function hasRecentUnansweredUserTurn(chat: Chat): boolean {
  let lastUserIndex = -1;
  for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
    if (chat.messages[index].role === 'user') {
      lastUserIndex = index;
      break;
    }
  }

  if (lastUserIndex < 0) {
    return false;
  }

  for (let index = lastUserIndex + 1; index < chat.messages.length; index += 1) {
    if (chat.messages[index].role === 'assistant') {
      return false;
    }
  }

  const lastUser = chat.messages[lastUserIndex];
  const userCreatedAtMs = Date.parse(lastUser.createdAt);
  if (!Number.isFinite(userCreatedAtMs)) {
    return false;
  }

  return Date.now() - userCreatedAtMs < UNANSWERED_USER_RUNNING_TTL_MS;
}

function didAssistantMessageProgress(previous: Chat | null, next: Chat): boolean {
  if (!previous || previous.id !== next.id) {
    return false;
  }

  const previousLatestAssistant = latestAssistantMessage(previous.messages);
  const nextLatestAssistant = latestAssistantMessage(next.messages);

  if (!nextLatestAssistant) {
    return false;
  }

  if (!previousLatestAssistant) {
    return nextLatestAssistant.content.trim().length > 0;
  }

  if (nextLatestAssistant.id === previousLatestAssistant.id) {
    return nextLatestAssistant.content.length > previousLatestAssistant.content.length;
  }

  return (
    next.messages.length > previous.messages.length &&
    nextLatestAssistant.content.trim().length > 0
  );
}

function latestAssistantMessage(messages: ChatTranscriptMessage[]): ChatTranscriptMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant') {
      return message;
    }
  }
  return null;
}

function extractFirstBoldSnippet(
  value: string | null | undefined,
  maxLength = 56
): string | null {
  if (!value) {
    return null;
  }

  const match = value.match(/\*\*([^*]+)\*\*/);
  if (!match) {
    return null;
  }

  return toTickerSnippet(match[1], maxLength);
}

function toPendingApproval(value: unknown): PendingApproval | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const id = readString(record.id);
  const kind = readString(record.kind);
  const threadId = readString(record.threadId);
  const turnId = readString(record.turnId);
  const itemId = readString(record.itemId);
  const requestedAt = readString(record.requestedAt);

  if (
    !id ||
    !kind ||
    !threadId ||
    !turnId ||
    !itemId ||
    !requestedAt ||
    (kind !== 'commandExecution' && kind !== 'fileChange')
  ) {
    return null;
  }

  return {
    id,
    kind,
    threadId,
    turnId,
    itemId,
    requestedAt,
    reason: readString(record.reason) ?? undefined,
    command: readString(record.command) ?? undefined,
    cwd: readString(record.cwd) ?? undefined,
    grantRoot: readString(record.grantRoot) ?? undefined,
    proposedExecpolicyAmendment: readStringArray(record.proposedExecpolicyAmendment) ?? undefined,
  };
}

// ── Styles ─────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgMain,
  },

  bodyContainer: {
    flex: 1,
  },
  keyboardAvoiding: {
    flex: 1,
  },
  composerContainer: {
    backgroundColor: colors.bgMain,
  },
  composerContainerResting: {
    marginBottom: 0,
  },
  activityDock: {
    backgroundColor: colors.bgMain,
    paddingTop: spacing.xs,
    paddingBottom: spacing.xs / 2,
    zIndex: 3,
  },
  queuedMessageDock: {
    backgroundColor: colors.bgMain,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs / 2,
    paddingBottom: spacing.xs,
    zIndex: 3,
  },
  sessionMetaRow: {
    backgroundColor: colors.bgMain,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderLight,
    paddingVertical: spacing.sm,
  },
  sessionMetaRowContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  topCardsRow: {
    backgroundColor: colors.bgMain,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
    zIndex: 2,
  },
  contextChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.bgItem,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    flexShrink: 0,
  },
  contextChipIndicator: {
    width: 8,
    height: 8,
    borderRadius: 999,
    flexShrink: 0,
  },
  contextChipText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  modelChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.bgItem,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    flexShrink: 0,
  },
  modeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.bgItem,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    flexShrink: 0,
  },
  fastChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.bgItem,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    flexShrink: 0,
  },
  fastChipEnabled: {
    borderColor: colors.borderHighlight,
    backgroundColor: colors.inlineCodeBg,
  },
  modelChipPressed: {
    opacity: 0.86,
  },
  sessionMetaChipDisabled: {
    opacity: 0.5,
  },
  modelChipText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  fastChipTextEnabled: {
    color: colors.textPrimary,
  },
  planCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    borderRadius: 12,
    backgroundColor: colors.bgItem,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  planOverlayCard: {
    marginBottom: 0,
    shadowColor: '#000',
    shadowOpacity: 0.16,
    shadowRadius: 10,
    shadowOffset: {
      width: 0,
      height: 4,
    },
    elevation: 4,
  },
  queuedMessageCard: {
    marginBottom: 0,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 10,
  },
  queuedMessageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.xs / 2,
  },
  queuedMessageHeaderText: {
    flex: 1,
    gap: 2,
  },
  queuedMessageSummary: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  queuedMessageBody: {
    ...typography.caption,
    color: colors.textPrimary,
    lineHeight: 18,
  },
  queuedMessageHint: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  queuedMessageActionButton: {
    flexShrink: 0,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHighlight,
    backgroundColor: colors.inlineCodeBg,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
  },
  queuedMessageActionButtonDisabled: {
    borderColor: colors.border,
    backgroundColor: colors.bgMain,
  },
  queuedMessageActionButtonPressed: {
    opacity: 0.88,
  },
  queuedMessageActionLabel: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  queuedMessageActionLabelDisabled: {
    color: colors.textMuted,
  },
  planCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  planCardHeaderPressable: {
    marginBottom: 0,
  },
  planCardHeaderText: {
    flex: 1,
    gap: 2,
  },
  planCardTitle: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  planCardSummary: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  planExplanationText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontStyle: 'italic',
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  planStepsList: {
    gap: spacing.xs,
  },
  planStepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  planStepStatus: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: 1,
  },
  planStepStatusCompleted: {
    color: colors.textMuted,
  },
  planStepStatusInProgress: {
    color: colors.accent,
    fontWeight: '700',
  },
  planStepStatusPending: {
    color: colors.textMuted,
  },
  planStepText: {
    ...typography.caption,
    color: colors.textPrimary,
    flex: 1,
  },
  planStepTextCompleted: {
    color: colors.textMuted,
    textDecorationLine: 'line-through',
  },
  planStepTextInProgress: {
    color: colors.textPrimary,
    fontWeight: '700',
  },
  planStepTextPending: {
    color: colors.textPrimary,
  },
  planDeltaText: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  renameModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  workspaceModalLoading: {
    ...typography.caption,
    color: colors.textMuted,
  },
  slashSuggestions: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.xs,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    backgroundColor: colors.bgItem,
    overflow: 'hidden',
  },
  slashSuggestionsContent: {
    paddingVertical: 0,
  },
  slashSuggestionItem: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderLight,
  },
  slashSuggestionItemLast: {
    borderBottomWidth: 0,
  },
  slashSuggestionItemPressed: {
    backgroundColor: colors.bgInput,
  },
  slashSuggestionTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  slashSuggestionSummary: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: 2,
  },
  renameModalCard: {
    backgroundColor: colors.bgItem,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  renameModalTitle: {
    ...typography.headline,
    color: colors.textPrimary,
  },
  attachmentModalHint: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  attachmentSuggestionsList: {
    maxHeight: 170,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    borderRadius: 10,
    backgroundColor: colors.bgMain,
  },
  attachmentSuggestionsListContent: {
    paddingVertical: 0,
  },
  attachmentSuggestionItem: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderLight,
  },
  attachmentSuggestionItemLast: {
    borderBottomWidth: 0,
  },
  attachmentSuggestionItemPressed: {
    backgroundColor: colors.bgInput,
  },
  attachmentSuggestionText: {
    ...typography.caption,
    color: colors.textPrimary,
  },
  renameModalInput: {
    color: colors.textPrimary,
    backgroundColor: colors.bgInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 15,
  },
  attachmentListColumn: {
    gap: spacing.xs,
    maxHeight: 180,
  },
  attachmentListRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    borderRadius: 8,
    backgroundColor: colors.bgMain,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  attachmentListPath: {
    ...typography.caption,
    color: colors.textPrimary,
    flex: 1,
  },
  attachmentRemoveButton: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.bgItem,
  },
  attachmentRemoveButtonPressed: {
    opacity: 0.8,
  },
  renameModalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  renameModalButton: {
    borderRadius: 10,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderWidth: 1,
  },
  renameModalButtonSecondary: {
    borderColor: colors.border,
    backgroundColor: colors.bgMain,
  },
  renameModalButtonSecondaryText: {
    ...typography.body,
    color: colors.textPrimary,
  },
  renameModalButtonPrimary: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  renameModalButtonPrimaryPressed: {
    backgroundColor: colors.accentPressed,
    borderColor: colors.accentPressed,
  },
  renameModalButtonDisabled: {
    opacity: 0.45,
  },
  renameModalButtonPressed: {
    opacity: 0.8,
  },
  renameModalButtonPrimaryText: {
    ...typography.body,
    color: colors.black,
    fontWeight: '600',
  },
  userInputModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  userInputModalCard: {
    backgroundColor: colors.bgItem,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.borderHighlight,
    padding: spacing.lg,
    gap: spacing.md,
    maxHeight: '80%',
  },
  planPromptModalCard: {
    backgroundColor: colors.bgItem,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.borderHighlight,
    padding: spacing.lg,
    gap: spacing.md,
  },
  userInputModalTitle: {
    ...typography.headline,
    color: colors.textPrimary,
  },
  planPromptOptionsColumn: {
    gap: spacing.sm,
  },
  planPromptOptionButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.bgMain,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: spacing.xs,
  },
  planPromptOptionButtonPressed: {
    opacity: 0.88,
  },
  planPromptOptionTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  planPromptOptionDescription: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  userInputQuestionsList: {
    maxHeight: 380,
  },
  userInputQuestionsListContent: {
    gap: spacing.md,
  },
  userInputQuestionCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    borderRadius: 10,
    backgroundColor: colors.bgMain,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  userInputQuestionHeader: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  userInputQuestionText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  userInputOptionsColumn: {
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  userInputOptionButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.bgItem,
    borderRadius: 10,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    gap: 2,
  },
  userInputOptionButtonSelected: {
    borderColor: colors.borderHighlight,
    backgroundColor: colors.bgInput,
  },
  userInputOptionButtonPressed: {
    opacity: 0.85,
  },
  userInputOptionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  userInputOptionIndex: {
    ...typography.caption,
    color: colors.textMuted,
    fontWeight: '700',
    minWidth: 18,
  },
  userInputOptionLabel: {
    ...typography.caption,
    color: colors.textPrimary,
    flex: 1,
    fontWeight: '600',
  },
  userInputOptionDescription: {
    ...typography.caption,
    color: colors.textMuted,
  },
  userInputAnswerInput: {
    color: colors.textPrimary,
    backgroundColor: colors.bgInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    minHeight: 42,
    textAlignVertical: 'top',
  },
  userInputAnswerInputSecret: {
    textAlignVertical: 'center',
  },
  userInputErrorText: {
    ...typography.caption,
    color: colors.error,
  },
  userInputSubmitButton: {
    borderWidth: 1,
    borderColor: colors.borderHighlight,
    backgroundColor: colors.bgInput,
    borderRadius: 10,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  userInputSubmitButtonPressed: {
    opacity: 0.88,
  },
  userInputSubmitButtonDisabled: {
    opacity: 0.45,
  },
  userInputSubmitButtonText: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
  },

  // Compose
  composeScroll: {
    flex: 1,
  },
  composeContainer: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xxl * 2,
  },
  composeIcon: {
    marginBottom: spacing.lg,
  },
  composeTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.xs,
  },
  composeSubtitle: {
    ...typography.body,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
  workspaceSelectBtn: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    backgroundColor: colors.bgItem,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.xl * 2,
  },
  workspaceSelectBtnPressed: {
    opacity: 0.85,
  },
  workspaceSelectLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    flex: 1,
  },
  suggestions: {
    flexDirection: 'row',
    gap: spacing.md,
    width: '100%',
  },
  suggestionCard: {
    flex: 1,
    backgroundColor: colors.bgItem,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing.md,
  },
  suggestionCardPressed: {
    backgroundColor: colors.bgInput,
  },
  suggestionText: {
    ...typography.caption,
    color: colors.textPrimary,
    lineHeight: 18,
  },

  // Chat
  messageListShell: {
    flex: 1,
  },
  messageList: {
    flex: 1,
  },
  messageListContent: {
    flexGrow: 1,
    padding: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.xl,
  },
  chatMessageBlock: {
    gap: spacing.sm,
  },
  messagePaginationWrap: {
    alignItems: 'flex-start',
    gap: spacing.xs,
  },
  messagePaginationButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHighlight,
    backgroundColor: colors.bgItem,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  messagePaginationButtonPressed: {
    backgroundColor: colors.bgInput,
  },
  messagePaginationButtonText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  messagePaginationMeta: {
    ...typography.caption,
    color: colors.textMuted,
    marginLeft: spacing.xs,
  },
  inlineChoiceOptions: {
    marginLeft: spacing.sm,
    gap: spacing.xs,
  },
  inlineChoiceOptionButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.bgItem,
    borderRadius: 10,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    gap: 2,
  },
  inlineChoiceOptionButtonPressed: {
    backgroundColor: colors.bgInput,
    borderColor: colors.borderHighlight,
  },
  inlineChoiceOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  inlineChoiceOptionIndex: {
    ...typography.caption,
    color: colors.textMuted,
    fontWeight: '700',
    minWidth: 18,
  },
  inlineChoiceOptionLabel: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '600',
    flex: 1,
  },
  inlineChoiceOptionDescription: {
    ...typography.caption,
    color: colors.textMuted,
  },
  inlineChoiceHint: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: 2,
    marginLeft: spacing.xs,
  },
  livePanelOverlay: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    zIndex: 2,
  },
  livePanelShell: {
    justifyContent: 'flex-start',
  },
  livePanelContent: {
    gap: spacing.sm,
  },
  toolPanel: {
    borderRadius: 12,
    overflow: 'hidden',
  },
  toolPanelContent: {
    paddingBottom: spacing.sm,
  },
  chatLoadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  chatLoadingText: {
    ...typography.caption,
    color: colors.textMuted,
  },

  // Streaming thinking text
  streamingText: {
    ...typography.body,
    fontStyle: 'italic',
    color: colors.textMuted,
    lineHeight: 20,
  },

  // Error
  errorText: {
    ...typography.caption,
    color: colors.error,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
  },
});
