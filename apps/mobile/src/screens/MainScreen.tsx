import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import {
  type ComponentProps,
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AppState,
  ActivityIndicator,
  Dimensions,
  FlatList,
  InteractionManager,
  Keyboard,
  KeyboardAvoidingView,
  type KeyboardEvent,
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
import Markdown from 'react-native-markdown-display';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { HostBridgeApiClient } from '../api/client';
import { readAccountRateLimitSnapshot } from '../api/rateLimits';
import { getChatEngineLabel, resolveChatEngine } from '../chatEngines';
import type {
  AccountRateLimitSnapshot,
  ApprovalMode,
  ApprovalPolicy,
  ApprovalDecision,
  BridgeCapabilities,
  ChatEngine,
  CollaborationMode,
  EngineDefaultSettingsMap,
  PendingApproval,
  PendingUserInputRequest,
  RpcNotification,
  RunEvent,
  Chat,
  ChatStatus,
  ChatSummary,
  ModelOption,
  MentionInput,
  LocalImageInput,
  ReasoningEffort,
  ServiceTier,
  TurnPlanStep,
  ChatMessage as ChatTranscriptMessage,
  FileSystemEntry,
  WorkspaceSummary,
} from '../api/types';
import type { HostBridgeWsClient } from '../api/ws';
import { ActivityBar, type ActivityTone } from '../components/ActivityBar';
import { ApprovalBanner } from '../components/ApprovalBanner';
import { ChatHeader } from '../components/ChatHeader';
import { ChatInput } from '../components/ChatInput';
import { ChatMessage, ToolActivityGroup } from '../components/ChatMessage';
import { ComposerUsageLimits } from '../components/ComposerUsageLimits';
import { BrandMark } from '../components/BrandMark';
import { SelectionSheet, type SelectionSheetOption } from '../components/SelectionSheet';
import { WorkspacePickerModal } from '../components/WorkspacePickerModal';
import { buildComposerUsageLimitBadges } from '../components/usageLimitBadges';
import { env } from '../config';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder';
import {
  formatModelOptionDescription,
  formatModelOptionLabel,
} from '../modelOptions';
import {
  collectLiveAgentPanelThreadIds,
  collectRelatedAgentThreads,
  describeAgentThreadSource,
  findMatchingAgentThread,
} from './agentThreads';
import {
  buildAgentThreadDisplayState,
  type AgentThreadDisplayState,
} from './agentThreadDisplay';
import {
  hasStructuredPlanCardContent,
  resolveWorkflowCardMode,
} from './planCardState';
import { trimInheritedParentMessages } from './subAgentTranscript';
import {
  buildTranscriptDisplayItems,
  getVisibleTranscriptMessages,
  syncVisibleSubAgentStatuses,
  type TranscriptDisplayItem,
} from './transcriptMessages';
import { useAppTheme, type AppTheme } from '../theme';

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
  onOpenLocalPreview?: (targetUrl: string) => void;
  defaultStartCwd?: string | null;
  defaultChatEngine?: ChatEngine | null;
  defaultEngineSettings?: EngineDefaultSettingsMap | null;
  approvalMode?: ApprovalMode;
  showToolCalls?: boolean;
  onDefaultStartCwdChange?: (cwd: string | null) => void;
  onChatContextChange?: (chat: Chat | null) => void;
  onChatOpeningStateChange?: (chatId: string | null) => void;
  pendingOpenChatId?: string | null;
  pendingOpenChatSnapshot?: Chat | null;
  onPendingOpenChatHandled?: () => void;
}

const SUGGESTIONS = [
  'Explain the current codebase structure',
  'Write tests for the main module',
];
const OPEN_CHAT_MIN_LOADING_MS = 250;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PendingPlanImplementationPrompt {
  threadId: string;
  turnId: string;
}

type AttachmentMenuAction =
  | 'workspace-path'
  | 'phone-file'
  | 'phone-image'
  | 'phone-camera'
  | null;

type WorkspacePickerPurpose = 'default-start' | 'git-checkout-destination';

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

interface PendingOptimisticUserMessage {
  message: ChatTranscriptMessage;
  userOrdinal: number;
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
const RUN_WATCHDOG_MS = 60_000;
const LARGE_CHAT_MESSAGE_COUNT_THRESHOLD = 120;
const CHAT_INITIAL_VISIBLE_MESSAGE_WINDOW = 80;
const CHAT_MESSAGE_PAGE_SIZE = 80;
const LIKELY_RUNNING_RECENT_UPDATE_MS = 30_000;
const UNANSWERED_USER_RUNNING_TTL_MS = 90_000;
const ACTIVE_CHAT_SYNC_INTERVAL_MS = 2_000;
const IDLE_CHAT_SYNC_INTERVAL_MS = 2_500;
const AGENT_THREADS_SYNC_INTERVAL_MS = 10_000;
const CONTEXT_WINDOW_BASELINE_TOKENS = 5_000;
const CHAT_DRAFTS_FILE = 'chat-drafts.json';
const CHAT_DRAFTS_VERSION = 1;
const CHAT_MODEL_PREFERENCES_FILE = 'chat-model-preferences.json';
const CHAT_MODEL_PREFERENCES_VERSION = 1;
const CHAT_PLAN_SNAPSHOTS_FILE = 'chat-plan-snapshots.json';
const CHAT_PLAN_SNAPSHOTS_VERSION = 1;
const CHAT_NEW_DRAFT_KEY = '__new_chat__';
const STREAMING_SCROLL_THROTTLE_MS = 48;
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

type SelectedServiceTier = ServiceTier | null | undefined;

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
    argsHint: '[thread]',
    mobileSupported: true,
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
      onOpenLocalPreview: onOpenLocalPreviewHandler,
      defaultStartCwd,
      defaultChatEngine,
      defaultEngineSettings,
      approvalMode,
      showToolCalls = true,
      onDefaultStartCwdChange,
      onChatContextChange,
      onChatOpeningStateChange,
      pendingOpenChatId,
      pendingOpenChatSnapshot,
      onPendingOpenChatHandled,
    },
    ref
  ) {
    const theme = useAppTheme();
    const { height: windowHeight } = useWindowDimensions();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const initialPendingSnapshot =
      pendingOpenChatId && pendingOpenChatSnapshot?.id === pendingOpenChatId
        ? pendingOpenChatSnapshot
        : null;
    const [selectedChat, setSelectedChat] = useState<Chat | null>(
      initialPendingSnapshot
    );
    const [selectedParentChat, setSelectedParentChat] = useState<Chat | null>(null);
    const [selectedChatId, setSelectedChatId] = useState<string | null>(
      initialPendingSnapshot?.id ?? pendingOpenChatId ?? null
    );
    const [openingChatId, setOpeningChatId] = useState<string | null>(
      initialPendingSnapshot ? null : pendingOpenChatId ?? null
    );
    const openingChatStartedAtRef = useRef<number>(
      initialPendingSnapshot || !pendingOpenChatId ? 0 : Date.now()
    );
    const initialDraftScopeKey = getDraftScopeKey(initialPendingSnapshot?.id ?? pendingOpenChatId);
    const [draft, setDraft] = useState('');
    const [draftOwnerKey, setDraftOwnerKey] = useState(initialDraftScopeKey);
    const [chatDraftsLoaded, setChatDraftsLoaded] = useState(false);
    const [sending, setSending] = useState(false);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [, setActiveCommands] = useState<RunEvent[]>([]);
    const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
    const [pendingUserInputRequest, setPendingUserInputRequest] =
      useState<PendingUserInputRequest | null>(null);
    const [userInputDrafts, setUserInputDrafts] = useState<Record<string, string>>({});
    const [userInputError, setUserInputError] = useState<string | null>(null);
    const [resolvingUserInput, setResolvingUserInput] = useState(false);
    const [activePlan, setActivePlan] = useState<ActivePlanState | null>(null);
    const streamingTextRef = useRef<string | null>(null);
    const setStreamingText = useCallback(
      (
        next:
          | string
          | null
          | ((previous: string | null) => string | null)
      ) => {
        streamingTextRef.current =
          typeof next === 'function'
            ? (
                next as (previous: string | null) => string | null
              )(streamingTextRef.current)
            : next;
      },
      []
    );
    const [renameModalVisible, setRenameModalVisible] = useState(false);
    const [renameDraft, setRenameDraft] = useState('');
    const [renaming, setRenaming] = useState(false);
    const [attachmentModalVisible, setAttachmentModalVisible] = useState(false);
    const [attachmentMenuVisible, setAttachmentMenuVisible] = useState(false);
    const [attachmentPathDraft, setAttachmentPathDraft] = useState('');
    const [pendingAttachmentMenuAction, setPendingAttachmentMenuAction] =
      useState<AttachmentMenuAction>(null);
    const [pendingMentionPaths, setPendingMentionPaths] = useState<string[]>([]);
    const [pendingLocalImagePaths, setPendingLocalImagePaths] = useState<string[]>([]);
    const [attachmentFileCandidates, setAttachmentFileCandidates] = useState<string[]>([]);
    const [loadingAttachmentFileCandidates, setLoadingAttachmentFileCandidates] =
      useState(false);
    const [attachmentPickerBusy, setAttachmentPickerBusy] = useState(false);
    const [uploadingAttachment, setUploadingAttachment] = useState(false);
    const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
    const [stoppingTurn, setStoppingTurn] = useState(false);
    const [workspaceModalVisible, setWorkspaceModalVisible] = useState(false);
    const [workspacePickerPurpose, setWorkspacePickerPurpose] =
      useState<WorkspacePickerPurpose>('default-start');
    const [workspaceRoots, setWorkspaceRoots] = useState<WorkspaceSummary[]>([]);
    const [workspaceBridgeRoot, setWorkspaceBridgeRoot] = useState<string | null>(null);
    const [loadingWorkspaceRoots, setLoadingWorkspaceRoots] = useState(false);
    const [workspaceBrowsePath, setWorkspaceBrowsePath] = useState<string | null>(null);
    const [workspaceBrowseParentPath, setWorkspaceBrowseParentPath] = useState<string | null>(
      null
    );
    const [workspaceBrowseEntries, setWorkspaceBrowseEntries] = useState<FileSystemEntry[]>([]);
    const [loadingWorkspaceBrowse, setLoadingWorkspaceBrowse] = useState(false);
    const [workspaceBrowseError, setWorkspaceBrowseError] = useState<string | null>(null);
    const [resumeGitCheckoutAfterWorkspacePicker, setResumeGitCheckoutAfterWorkspacePicker] =
      useState(false);
    const [gitCheckoutModalVisible, setGitCheckoutModalVisible] = useState(false);
    const [gitCheckoutRepoUrl, setGitCheckoutRepoUrl] = useState('');
    const [gitCheckoutParentPath, setGitCheckoutParentPath] = useState<string | null>(null);
    const [gitCheckoutDirectoryName, setGitCheckoutDirectoryName] = useState('');
    const [gitCheckoutDirectoryNameEdited, setGitCheckoutDirectoryNameEdited] =
      useState(false);
    const [gitCheckoutError, setGitCheckoutError] = useState<string | null>(null);
    const [gitCheckoutCloning, setGitCheckoutCloning] = useState(false);
    const [chatTitleMenuVisible, setChatTitleMenuVisible] = useState(false);
    const [agentThreadMenuVisible, setAgentThreadMenuVisible] = useState(false);
    const [modelModalVisible, setModelModalVisible] = useState(false);
    const [modelSettingsMenuVisible, setModelSettingsMenuVisible] = useState(false);
    const [engineModalVisible, setEngineModalVisible] = useState(false);
    const [bridgeCapabilities, setBridgeCapabilities] = useState<BridgeCapabilities | null>(
      null
    );
    const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
    const [loadingModels, setLoadingModels] = useState(false);
    const [pendingChatEngine, setPendingChatEngine] = useState<ChatEngine>(
      () => defaultChatEngine ?? 'codex'
    );
    const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
    const [selectedEffort, setSelectedEffort] = useState<ReasoningEffort | null>(null);
    const [selectedServiceTier, setSelectedServiceTier] = useState<SelectedServiceTier>();
    const [defaultServiceTier, setDefaultServiceTier] = useState<ServiceTier | null>(null);
    const [selectedCollaborationMode, setSelectedCollaborationMode] =
      useState<CollaborationMode>('default');
    const [keyboardVisible, setKeyboardVisible] = useState(false);
    const [androidKeyboardInset, setAndroidKeyboardInset] = useState(0);
    const [composerHeight, setComposerHeight] = useState(0);
    const [queuedMessages, setQueuedMessages] = useState<QueuedChatMessage[]>([]);
    const [queueDispatching, setQueueDispatching] = useState(false);
    const [queuePaused, setQueuePaused] = useState(false);
    const [steeringMessage, setSteeringMessage] = useState<QueuedChatMessage | null>(null);
    const [relatedAgentThreads, setRelatedAgentThreads] = useState<ChatSummary[]>([]);
    const [agentRootThreadId, setAgentRootThreadId] = useState<string | null>(null);
    const [agentPanelCollapsed, setAgentPanelCollapsed] = useState(false);
    const [agentRuntimeRevision, setAgentRuntimeRevision] = useState(0);
    const [loadingAgentThreads, setLoadingAgentThreads] = useState(false);
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
    const attachmentPickerInProgressRef = useRef(false);
    const [threadContextUsage, setThreadContextUsage] = useState<ThreadContextUsage | null>(
      null
    );
    const chatDraftsRef = useRef<Record<string, string>>({});
    const draftPersistenceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [planPanelCollapsedByThread, setPlanPanelCollapsedByThread] = useState<
      Record<string, boolean>
    >({});
    const [pendingPlanImplementationPrompts, setPendingPlanImplementationPrompts] =
      useState<Record<string, PendingPlanImplementationPrompt>>({});
    const safeAreaInsets = useSafeAreaInsets();
    const scrollRef = useRef<FlatList<TranscriptDisplayItem>>(null);
    const scrollRetryTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
    const scheduledPinnedScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastPinnedScrollAtRef = useRef(0);
    const autoScrollStateRef = useRef<AutoScrollState>({
      shouldStickToBottom: true,
      isUserInteracting: false,
      isMomentumScrolling: false,
    });
    const loadChatRequestRef = useRef(0);
    const agentThreadsRequestRef = useRef(0);
    const agentThreadsRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const openAgentThreadSelectorRef = useRef<(query?: string | null) => Promise<boolean>>(
      async () => false
    );
    const bumpAgentRuntimeRevision = useCallback(() => {
      setAgentRuntimeRevision((previous) => previous + 1);
    }, []);

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
      if (scheduledPinnedScrollTimeoutRef.current) {
        clearTimeout(scheduledPinnedScrollTimeoutRef.current);
        scheduledPinnedScrollTimeoutRef.current = null;
      }
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

    const schedulePinnedScrollToBottom = useCallback(
      (animated = true) => {
        const autoScrollState = autoScrollStateRef.current;
        if (
          autoScrollState.isUserInteracting ||
          autoScrollState.isMomentumScrolling ||
          !autoScrollState.shouldStickToBottom
        ) {
          return;
        }

        const now = Date.now();
        const elapsed = now - lastPinnedScrollAtRef.current;
        if (elapsed >= STREAMING_SCROLL_THROTTLE_MS) {
          lastPinnedScrollAtRef.current = now;
          scrollToBottomReliable(animated);
          return;
        }

        if (scheduledPinnedScrollTimeoutRef.current) {
          return;
        }

        scheduledPinnedScrollTimeoutRef.current = setTimeout(() => {
          scheduledPinnedScrollTimeoutRef.current = null;
          lastPinnedScrollAtRef.current = Date.now();
          scrollToBottomReliable(animated);
        }, STREAMING_SCROLL_THROTTLE_MS - elapsed);
      },
      [scrollToBottomReliable]
    );

    useEffect(() => {
      return () => {
        clearPendingScrollRetries();
      };
    }, [clearPendingScrollRetries]);

    useEffect(() => {
      return () => {
        const timerId = agentThreadsRefreshTimerRef.current;
        if (timerId) {
          clearTimeout(timerId);
          agentThreadsRefreshTimerRef.current = null;
        }
      };
    }, []);

    useEffect(() => {
      const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
      const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
      const showSub = Keyboard.addListener(showEvent, (event: KeyboardEvent) => {
        setKeyboardVisible(true);

        if (Platform.OS !== 'android') {
          return;
        }

        const keyboardTop = event.endCoordinates?.screenY;
        const keyboardHeight = event.endCoordinates?.height ?? 0;
        const screenHeight = Dimensions.get('screen').height;
        const overlap =
          typeof keyboardTop === 'number' && Number.isFinite(keyboardTop)
            ? Math.max(0, screenHeight - keyboardTop)
            : Math.max(0, keyboardHeight);
        setAndroidKeyboardInset(overlap);
      });
      const hideSub = Keyboard.addListener(hideEvent, () => {
        setKeyboardVisible(false);
        setAndroidKeyboardInset(0);
      });
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
    const parentChatCacheRef = useRef<Record<string, Chat>>({});
    const agentRootThreadIdRef = useRef<string | null>(agentRootThreadId);
    agentRootThreadIdRef.current = agentRootThreadId;
    const planPanelLastTurnByThreadRef = useRef<Record<string, string>>({});
    const planItemTurnIdByThreadRef = useRef<Record<string, string>>({});
    const autoEnabledPlanTurnIdByThreadRef = useRef<Record<string, string>>({});
    const dismissedPlanImplementationTurnIdByThreadRef = useRef<Record<string, string>>({});
    const activeTurnIdRef = useRef<string | null>(null);
    activeTurnIdRef.current = activeTurnId;
    const stopRequestedRef = useRef(false);
    const stopSystemMessageLoggedRef = useRef(false);
    const appStateRef = useRef(AppState.currentState);

    // Track whether a command arrived since the last delta — used to
    // know when a new thinking segment starts so we can replace the old one.
    const hadCommandRef = useRef(false);
    const reasoningSummaryRef = useRef<Record<string, string>>({});
    const codexReasoningBufferRef = useRef('');
    const liveReasoningBuffersRef = useRef<Record<string, string>>({});
    const liveReasoningMessageIdsRef = useRef<Record<string, string>>({});
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
    const pendingOptimisticUserMessagesRef = useRef<
      Record<string, PendingOptimisticUserMessage[]>
    >({});
    const chatModelPreferencesRef = useRef<Record<string, ChatModelPreference>>({});
    const [chatModelPreferencesLoaded, setChatModelPreferencesLoaded] = useState(false);
    const chatPlanSnapshotsRef = useRef<Record<string, ActivePlanState>>({});
    const [, setChatPlanSnapshotsLoaded] = useState(false);
    const preferredStartCwd = normalizeWorkspacePath(defaultStartCwd);
    const draftScopeKey = getDraftScopeKey(selectedChatId);
    const persistedDefaultChatEngine = resolveChatEngine(defaultChatEngine ?? 'codex');
    const availableNewChatEngines: ChatEngine[] = bridgeCapabilities?.availableEngines?.length
      ? bridgeCapabilities.availableEngines
      : ['codex'];
    const fallbackDefaultChatEngine = availableNewChatEngines.includes(persistedDefaultChatEngine)
      ? persistedDefaultChatEngine
      : availableNewChatEngines[0] ?? 'codex';
    const preferredNewChatEngine = availableNewChatEngines.includes(pendingChatEngine)
      ? pendingChatEngine
      : fallbackDefaultChatEngine;
    const activeChatEngine = selectedChat?.engine
      ? resolveChatEngine(selectedChat.engine)
      : preferredNewChatEngine;
    const activeChatEngineLabel = getChatEngineLabel(activeChatEngine);
    const pendingEngineDefaults = defaultEngineSettings?.[preferredNewChatEngine] ?? null;
    const preferredDefaultModelId = normalizeModelId(pendingEngineDefaults?.modelId);
    const preferredDefaultEffort = normalizeReasoningEffort(pendingEngineDefaults?.effort);
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

    const queueOptimisticUserMessage = useCallback(
      (
        threadId: string,
        message: ChatTranscriptMessage,
        options?: { baseChat?: Chat | null }
      ) => {
        if (!threadId) {
          return;
        }

        const existingPendingMessages =
          pendingOptimisticUserMessagesRef.current[threadId] ?? [];
        const visibleChat =
          selectedChatRef.current?.id === threadId
            ? selectedChatRef.current
            : options?.baseChat ?? null;
        const nextUserOrdinal =
          Math.max(
            countUserMessages(visibleChat?.messages ?? []),
            existingPendingMessages[existingPendingMessages.length - 1]?.userOrdinal ?? 0
          ) + 1;

        pendingOptimisticUserMessagesRef.current[threadId] = [
          ...existingPendingMessages,
          {
            message,
            userOrdinal: nextUserOrdinal,
          },
        ];
      },
      []
    );

    const discardOptimisticUserMessage = useCallback(
      (threadId: string, messageId: string) => {
        if (!threadId || !messageId) {
          return;
        }

        const existingPendingMessages =
          pendingOptimisticUserMessagesRef.current[threadId] ?? [];
        if (existingPendingMessages.length === 0) {
          return;
        }

        const nextPendingMessages = existingPendingMessages.filter(
          (entry) => entry.message.id !== messageId
        );
        if (nextPendingMessages.length > 0) {
          pendingOptimisticUserMessagesRef.current[threadId] = nextPendingMessages;
        } else {
          delete pendingOptimisticUserMessagesRef.current[threadId];
        }
      },
      []
    );

    const mergeChatWithPendingOptimisticMessages = useCallback((chat: Chat): Chat => {
      const pendingMessages = pendingOptimisticUserMessagesRef.current[chat.id] ?? [];
      if (pendingMessages.length === 0) {
        return chat;
      }

      const {
        chat: mergedChat,
        remainingPendingMessages,
      } = reconcileChatWithPendingOptimisticMessages(chat, pendingMessages);

      if (remainingPendingMessages.length > 0) {
        pendingOptimisticUserMessagesRef.current[chat.id] = remainingPendingMessages;
      } else {
        delete pendingOptimisticUserMessagesRef.current[chat.id];
      }

      return mergedChat;
    }, []);

    useEffect(() => {
      if (!selectedChat?.id) {
        return;
      }

      parentChatCacheRef.current[selectedChat.id] = selectedChat;
    }, [selectedChat]);

    useEffect(() => {
      const parentThreadId = selectedChat?.parentThreadId?.trim();
      if (!parentThreadId) {
        setSelectedParentChat(null);
        return;
      }

      const cachedParentChat = parentChatCacheRef.current[parentThreadId];
      if (cachedParentChat) {
        setSelectedParentChat(cachedParentChat);
        return;
      }

      let cancelled = false;

      api
        .getChat(parentThreadId)
        .then((parentChat) => {
          parentChatCacheRef.current[parentThreadId] = parentChat;
          if (!cancelled) {
            setSelectedParentChat(parentChat);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setSelectedParentChat(null);
          }
        });

      return () => {
        cancelled = true;
      };
    }, [api, selectedChat?.id, selectedChat?.parentThreadId]);

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

    const saveChatDrafts = useCallback(async (nextDrafts: Record<string, string>) => {
      const draftsPath = getChatDraftsPath();
      if (!draftsPath) {
        return;
      }

      const payload = JSON.stringify({
        version: CHAT_DRAFTS_VERSION,
        entries: nextDrafts,
      });

      try {
        await FileSystem.writeAsStringAsync(draftsPath, payload);
      } catch {
        // Best effort persistence only.
      }
    }, []);

    const scheduleChatDraftsPersist = useCallback(
      (nextDrafts: Record<string, string>) => {
        const existingTimer = draftPersistenceTimeoutRef.current;
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        draftPersistenceTimeoutRef.current = setTimeout(() => {
          draftPersistenceTimeoutRef.current = null;
          void saveChatDrafts(nextDrafts);
        }, 180);
      },
      [saveChatDrafts]
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

    useEffect(() => {
      let cancelled = false;

      const load = async () => {
        const draftsPath = getChatDraftsPath();
        if (!draftsPath) {
          if (!cancelled) {
            setChatDraftsLoaded(true);
          }
          return;
        }

        try {
          const raw = await FileSystem.readAsStringAsync(draftsPath);
          if (cancelled) {
            return;
          }

          chatDraftsRef.current = parseChatDrafts(raw);
        } catch {
          if (!cancelled) {
            chatDraftsRef.current = {};
          }
        } finally {
          if (!cancelled) {
            setChatDraftsLoaded(true);
          }
        }
      };

      void load();
      return () => {
        cancelled = true;
      };
    }, []);

    useEffect(() => {
      if (!chatDraftsLoaded) {
        return;
      }

      const resolvedOwnerKey = draftOwnerKey === draftScopeKey ? draftOwnerKey : draftScopeKey;
      const nextDraft = chatDraftsRef.current[resolvedOwnerKey] ?? '';
      if (draftOwnerKey !== draftScopeKey) {
        setDraftOwnerKey(draftScopeKey);
      }
      setDraft((previous) => (previous === nextDraft ? previous : nextDraft));
    }, [chatDraftsLoaded, draftOwnerKey, draftScopeKey]);

    useEffect(() => {
      if (!chatDraftsLoaded) {
        return;
      }

      const previousDraft = chatDraftsRef.current[draftOwnerKey] ?? '';
      if (previousDraft === draft) {
        return;
      }

      const nextDrafts = { ...chatDraftsRef.current };
      if (draft.trim().length > 0) {
        nextDrafts[draftOwnerKey] = draft;
      } else {
        delete nextDrafts[draftOwnerKey];
      }
      chatDraftsRef.current = nextDrafts;
      scheduleChatDraftsPersist(nextDrafts);
    }, [chatDraftsLoaded, draft, draftOwnerKey, scheduleChatDraftsPersist]);

    useEffect(() => {
      return () => {
        const existingTimer = draftPersistenceTimeoutRef.current;
        if (existingTimer) {
          clearTimeout(existingTimer);
          draftPersistenceTimeoutRef.current = null;
        }
        void saveChatDrafts(chatDraftsRef.current);
      };
    }, [saveChatDrafts]);

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
          const resolvedLatest = mergeChatWithPendingOptimisticMessages(latest);
          if (chatIdRef.current !== queuedThreadId) {
            return;
          }
          setSelectedChat((prev) =>
            prev && prev.id === resolvedLatest.id ? resolvedLatest : prev
          );
          if (isChatLikelyRunning(resolvedLatest)) {
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
    }, [api, bumpRunWatchdog, mergeChatWithPendingOptimisticMessages]);

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
        bumpAgentRuntimeRevision();
      },
      [bumpAgentRuntimeRevision, upsertThreadRuntimeSnapshot]
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
        bumpAgentRuntimeRevision();
      },
      [bumpAgentRuntimeRevision, upsertThreadRuntimeSnapshot]
    );

    const cacheThreadPendingUserInputRequest = useCallback(
      (threadId: string, request: PendingUserInputRequest | null) => {
        upsertThreadRuntimeSnapshot(threadId, () => ({
          pendingUserInputRequest: request,
        }));
        bumpAgentRuntimeRevision();
      },
      [bumpAgentRuntimeRevision, upsertThreadRuntimeSnapshot]
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
        bumpAgentRuntimeRevision();
      },
      [bumpAgentRuntimeRevision, upsertThreadRuntimeSnapshot]
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
        bumpAgentRuntimeRevision();
      },
      [bumpAgentRuntimeRevision, upsertThreadRuntimeSnapshot]
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
          delete planItemTurnIdByThreadRef.current[threadId];
          clearPendingPlanImplementationPrompt(threadId);
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

        if (codexEventType === 'plandelta') {
          const rawDelta = readString(msg?.delta) ?? '';
          if (!rawDelta) {
            return;
          }

          const turnId = resolveCodexPlanTurnId(
            msg,
            planItemTurnIdByThreadRef.current[threadId] ??
              threadRuntimeSnapshotsRef.current[threadId]?.activeTurnId ??
              null
          );
          planItemTurnIdByThreadRef.current[threadId] = turnId;
          cacheThreadTurnState(threadId, {
            runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
          });
          cacheThreadPlan(threadId, (previous) =>
            buildNextPlanStateFromDelta(previous, threadId, turnId, rawDelta)
          );
          cacheThreadActivity(threadId, {
            tone: 'running',
            title: 'Planning',
          });
          return;
        }

        if (codexEventType === 'planupdate') {
          const turnId = resolveCodexPlanTurnId(
            msg,
            planItemTurnIdByThreadRef.current[threadId] ??
              threadRuntimeSnapshotsRef.current[threadId]?.activeTurnId ??
              null
          );
          const planUpdate = toCodexTurnPlanUpdate(msg, threadId, turnId);
          planItemTurnIdByThreadRef.current[threadId] = turnId;
          if (planUpdate) {
            cacheThreadPlan(threadId, (previous) =>
              buildNextPlanStateFromUpdate(previous, planUpdate)
            );
          }
          cacheThreadActivity(threadId, {
            tone: 'running',
            title: 'Planning',
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
          delete planItemTurnIdByThreadRef.current[threadId];
          clearPendingPlanImplementationPrompt(threadId);
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
          delete planItemTurnIdByThreadRef.current[threadId];
          clearPendingPlanImplementationPrompt(threadId);
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
          const planTurnId = planItemTurnIdByThreadRef.current[threadId] ?? null;
          delete planItemTurnIdByThreadRef.current[threadId];
          if (planTurnId) {
            setPendingPlanImplementationPrompts((prev) => ({
              ...prev,
              [threadId]: {
                threadId,
                turnId: planTurnId,
              },
            }));
          } else {
            clearPendingPlanImplementationPrompt(threadId);
          }
          clearThreadRuntimeSnapshot(threadId, true);
        }
      },
      [
        cacheThreadActiveCommand,
        cacheThreadActivity,
        cacheThreadContextUsage,
        cacheThreadStreamingDelta,
        cacheThreadTurnState,
        clearPendingPlanImplementationPrompt,
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
      onChatOpeningStateChange?.(openingChatId);
    }, [onChatOpeningStateChange, openingChatId]);

    useEffect(() => {
      let cancelled = false;

      const loadBridgeCapabilities = async () => {
        try {
          const capabilities = await api.readBridgeCapabilities();
          if (!cancelled) {
            setBridgeCapabilities(capabilities);
          }
        } catch {
          if (!cancelled) {
            setBridgeCapabilities(null);
          }
        }
      };

      void loadBridgeCapabilities();
      return () => {
        cancelled = true;
      };
    }, [api]);

    useEffect(() => {
      if (selectedChatId) {
        return;
      }

      if (availableNewChatEngines.includes(pendingChatEngine)) {
        return;
      }

      setPendingChatEngine(availableNewChatEngines[0] ?? 'codex');
    }, [availableNewChatEngines, pendingChatEngine, selectedChatId]);

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
      setSelectedServiceTier(undefined);
    }, [
      defaultServiceTier,
      pendingChatEngine,
      preferredDefaultEffort,
      preferredDefaultModelId,
      selectedChatId,
    ]);

    const serverDefaultModel = modelOptions.find((model) => model.isDefault) ?? null;
    const serverDefaultModelId = serverDefaultModel?.id ?? null;
    const selectedModel = selectedModelId
      ? modelOptions.find((model) => model.id === selectedModelId) ?? null
      : null;
    const preferredDefaultModel =
      !selectedChatId && preferredDefaultModelId
        ? modelOptions.find((model) => model.id === preferredDefaultModelId) ?? null
        : null;
    const activeModel =
      selectedModel ?? preferredDefaultModel ?? serverDefaultModel ?? null;
    const activeModelId =
      selectedModel?.id ?? preferredDefaultModel?.id ?? serverDefaultModelId;
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
    const activeServiceTier = resolveSelectedServiceTier(
      selectedServiceTier,
      selectedChatId ? null : defaultServiceTier
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
      selectedModel
        ? formatModelOptionLabel(selectedModel)
        : activeModel
          ? `Default (${formatModelOptionLabel(activeModel)})`
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
      setPendingChatEngine(fallbackDefaultChatEngine);
      setSelectedCollaborationMode('default');
      openingChatStartedAtRef.current = 0;
      setOpeningChatId(null);
      setError(null);
      setSelectedServiceTier(undefined);
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
      setAgentThreadMenuVisible(false);
      setModelModalVisible(false);
      setModelSettingsMenuVisible(false);
      setCollaborationModeMenuVisible(false);
      setEffortModalVisible(false);
      setQueuedMessages([]);
      setQueueDispatching(false);
      setQueuePaused(false);
      setSteeringMessage(null);
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
    }, [
      clearExternalStatusFullSync,
      clearRunWatchdog,
      defaultServiceTier,
      fallbackDefaultChatEngine,
    ]);

    const startNewChat = useCallback(() => {
      // New chat should land on compose/home so user can pick workspace first.
      resetComposerState();
    }, [resetComposerState]);

    const refreshWorkspaceRoots = useCallback(async () => {
      setLoadingWorkspaceRoots(true);
      try {
        const response = await api.listWorkspaceRoots();
        setWorkspaceBridgeRoot(normalizeWorkspacePath(response.bridgeRoot));
        setWorkspaceRoots(response.workspaces);
        setWorkspaceBrowseError(null);
        return response;
      } catch (err) {
        setWorkspaceBrowseError((err as Error).message);
        return null;
      } finally {
        setLoadingWorkspaceRoots(false);
      }
    }, [api]);

    const browseWorkspacePath = useCallback(
      async (path: string | null | undefined) => {
        setLoadingWorkspaceBrowse(true);
        try {
          const response = await api.listFilesystemEntries({
            path: normalizeWorkspacePath(path),
            directoriesOnly: true,
          });
          const normalizedPath = normalizeWorkspacePath(response.path);
          setWorkspaceBridgeRoot(
            normalizeWorkspacePath(response.bridgeRoot) ?? workspaceBridgeRoot
          );
          setWorkspaceBrowsePath(normalizedPath);
          setWorkspaceBrowseParentPath(normalizeWorkspacePath(response.parentPath));
          setWorkspaceBrowseEntries(response.entries);
          setWorkspaceBrowseError(null);
        } catch (err) {
          setWorkspaceBrowseError((err as Error).message);
        } finally {
          setLoadingWorkspaceBrowse(false);
        }
      },
      [api, workspaceBridgeRoot]
    );

    const openWorkspacePicker = useCallback(
      (
        purpose: WorkspacePickerPurpose,
        initialPathOverride?: string | null
      ) => {
        const initialPath =
          normalizeWorkspacePath(initialPathOverride) ??
          preferredStartCwd ??
          workspaceBrowsePath ??
          workspaceBridgeRoot ??
          null;
        setWorkspacePickerPurpose(purpose);
        setWorkspaceModalVisible(true);
        void refreshWorkspaceRoots();
        void browseWorkspacePath(initialPath);
      },
      [
        browseWorkspacePath,
        preferredStartCwd,
        refreshWorkspaceRoots,
        workspaceBridgeRoot,
        workspaceBrowsePath,
      ]
    );

    const openWorkspaceModal = useCallback(() => {
      setResumeGitCheckoutAfterWorkspacePicker(false);
      openWorkspacePicker('default-start');
    }, [openWorkspacePicker]);

    const openGitCheckoutModal = useCallback((initialParentPath?: string | null) => {
      const defaultParentPath =
        normalizeWorkspacePath(initialParentPath) ??
        preferredStartCwd ??
        workspaceBrowsePath ??
        workspaceBridgeRoot ??
        null;
      setGitCheckoutRepoUrl('');
      setGitCheckoutDirectoryName('');
      setGitCheckoutDirectoryNameEdited(false);
      setGitCheckoutParentPath(defaultParentPath);
      setGitCheckoutError(null);
      setGitCheckoutCloning(false);
      setResumeGitCheckoutAfterWorkspacePicker(false);
      setGitCheckoutModalVisible(true);
      void refreshWorkspaceRoots().then((response) => {
        const bridgeRoot = normalizeWorkspacePath(response?.bridgeRoot);
        if (bridgeRoot) {
          setGitCheckoutParentPath((current) => current ?? bridgeRoot);
        }
      });
    }, [
      preferredStartCwd,
      refreshWorkspaceRoots,
      workspaceBridgeRoot,
      workspaceBrowsePath,
    ]);

    const closeGitCheckoutModal = useCallback(() => {
      if (gitCheckoutCloning) {
        return;
      }
      setGitCheckoutModalVisible(false);
      setGitCheckoutError(null);
      setResumeGitCheckoutAfterWorkspacePicker(false);
    }, [gitCheckoutCloning]);

    const openGitCheckoutDestinationPicker = useCallback(() => {
      setResumeGitCheckoutAfterWorkspacePicker(true);
      setGitCheckoutModalVisible(false);
      openWorkspacePicker(
        'git-checkout-destination',
        gitCheckoutParentPath ?? preferredStartCwd ?? workspaceBridgeRoot ?? null
      );
    }, [gitCheckoutParentPath, openWorkspacePicker, preferredStartCwd, workspaceBridgeRoot]);

    const refreshAgentThreads = useCallback(
      async (
        focusChatId?: string | null,
        options?: { showLoading?: boolean }
      ) => {
        const activeChatId = focusChatId ?? chatIdRef.current;
        if (!activeChatId) {
          setRelatedAgentThreads([]);
          setAgentRootThreadId(null);
          return {
            rootThreadId: null,
            threads: [],
          };
        }

        const requestId = agentThreadsRequestRef.current + 1;
        agentThreadsRequestRef.current = requestId;
        if (options?.showLoading) {
          setLoadingAgentThreads(true);
        }

        try {
          const [listedChats, loadedThreadIds] = await Promise.all([
            api.listChats({ includeSubAgents: true }),
            api.listLoadedChatIds().catch(() => []),
          ]);
          const listedChatIds = new Set(listedChats.map((chat) => chat.id));
          const missingLoadedIds = loadedThreadIds.filter((threadId) => !listedChatIds.has(threadId));
          const loadedOnlyChats = await Promise.all(
            missingLoadedIds.map(async (threadId) => {
              try {
                return await api.getChatSummary(threadId);
              } catch {
                return null;
              }
            })
          );
          const chats = [
            ...listedChats,
            ...loadedOnlyChats.filter((chat): chat is ChatSummary => chat !== null),
          ];
          const focusChat =
            chats.find((chat) => chat.id === activeChatId) ??
            (selectedChatRef.current?.id === activeChatId ? selectedChatRef.current : null);
          const related = collectRelatedAgentThreads(chats, focusChat);

          if (agentThreadsRequestRef.current !== requestId) {
            return related;
          }

          setRelatedAgentThreads(related.threads);
          setAgentRootThreadId(related.rootThreadId);
          return related;
        } catch (err) {
          if (agentThreadsRequestRef.current === requestId && options?.showLoading) {
            setError((err as Error).message);
          }
          return {
            rootThreadId: null,
            threads: [],
          };
        } finally {
          if (agentThreadsRequestRef.current === requestId && options?.showLoading) {
            setLoadingAgentThreads(false);
          }
        }
      },
      [api]
    );

    const scheduleAgentThreadsRefresh = useCallback(
      (focusChatId?: string | null) => {
        const activeChatId = focusChatId ?? chatIdRef.current;
        if (!activeChatId) {
          return;
        }

        const existingTimer = agentThreadsRefreshTimerRef.current;
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        agentThreadsRefreshTimerRef.current = setTimeout(() => {
          agentThreadsRefreshTimerRef.current = null;
          void refreshAgentThreads(activeChatId);
        }, 220);
      },
      [refreshAgentThreads]
    );

    const closeWorkspaceModal = useCallback(() => {
      if (loadingWorkspaceBrowse || loadingWorkspaceRoots) {
        return;
      }
      setWorkspaceModalVisible(false);
      if (
        workspacePickerPurpose === 'git-checkout-destination' &&
        resumeGitCheckoutAfterWorkspacePicker
      ) {
        setResumeGitCheckoutAfterWorkspacePicker(false);
        setGitCheckoutModalVisible(true);
      }
    }, [
      loadingWorkspaceBrowse,
      loadingWorkspaceRoots,
      resumeGitCheckoutAfterWorkspacePicker,
      workspacePickerPurpose,
    ]);

    useEffect(() => {
      if (!selectedChatId) {
        setRelatedAgentThreads([]);
        setAgentRootThreadId(null);
        setAgentThreadMenuVisible(false);
        return;
      }

      void refreshAgentThreads(selectedChatId);
    }, [refreshAgentThreads, selectedChatId]);

    useEffect(() => {
      if (!selectedChatId) {
        return;
      }

      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const scheduleNextRefresh = () => {
        if (stopped) {
          return;
        }

        timer = setTimeout(() => {
          const activeChatId = chatIdRef.current;
          if (appStateRef.current === 'active' && activeChatId === selectedChatId) {
            void refreshAgentThreads(activeChatId);
          }
          scheduleNextRefresh();
        }, AGENT_THREADS_SYNC_INTERVAL_MS);
      };

      scheduleNextRefresh();
      return () => {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
        }
      };
    }, [refreshAgentThreads, selectedChatId]);

    useEffect(() => {
      const subscription = AppState.addEventListener('change', (nextAppState) => {
        const previousAppState = appStateRef.current;
        appStateRef.current = nextAppState;

        if (nextAppState !== 'active' || previousAppState === 'active') {
          return;
        }

        const activeChatId = chatIdRef.current;
        if (!activeChatId) {
          return;
        }

        void refreshAgentThreads(activeChatId);
      });

      return () => {
        subscription.remove();
      };
    }, [refreshAgentThreads]);

    const handleWorkspaceSelection = useCallback(
      (cwd: string | null) => {
        const normalizedPath = normalizeWorkspacePath(cwd);
        setWorkspaceBrowseError(null);

        if (workspacePickerPurpose === 'git-checkout-destination') {
          setGitCheckoutParentPath(normalizedPath);
          setResumeGitCheckoutAfterWorkspacePicker(false);
          setWorkspaceModalVisible(false);
          setGitCheckoutModalVisible(true);
          return;
        }

        onDefaultStartCwdChange?.(normalizedPath);
        setWorkspaceModalVisible(false);
      },
      [onDefaultStartCwdChange, workspacePickerPurpose]
    );

    const handleGitCheckoutRepoUrlChange = useCallback(
      (value: string) => {
        setGitCheckoutRepoUrl(value);
        setGitCheckoutError(null);
        if (!gitCheckoutDirectoryNameEdited) {
          setGitCheckoutDirectoryName(deriveCloneDirectoryName(value) ?? '');
        }
      },
      [gitCheckoutDirectoryNameEdited]
    );

    const handleGitCheckoutDirectoryNameChange = useCallback((value: string) => {
      setGitCheckoutDirectoryName(value);
      setGitCheckoutDirectoryNameEdited(value.trim().length > 0);
      setGitCheckoutError(null);
    }, []);

    const submitGitCheckout = useCallback(async () => {
      const url = gitCheckoutRepoUrl.trim();
      const directoryName = normalizeCloneDirectoryName(gitCheckoutDirectoryName);
      if (!url) {
        setGitCheckoutError('Paste an HTTPS or SSH repository URL first.');
        return;
      }
      if (!directoryName) {
        setGitCheckoutError('Choose a valid folder name for the cloned repo.');
        return;
      }

      let parentPath = normalizeWorkspacePath(gitCheckoutParentPath) ?? workspaceBridgeRoot;
      if (!parentPath) {
        const response = await refreshWorkspaceRoots();
        parentPath = normalizeWorkspacePath(response?.bridgeRoot);
      }
      if (!parentPath) {
        setGitCheckoutError('Choose where the repository should be cloned.');
        return;
      }

      try {
        setGitCheckoutCloning(true);
        setGitCheckoutError(null);
        const cloned = await api.gitClone({
          url,
          parentPath,
          directoryName,
        });
        const clonedPath = normalizeWorkspacePath(cloned.cwd) ?? joinWorkspacePath(parentPath, directoryName);
        onDefaultStartCwdChange?.(clonedPath);
        setWorkspaceBrowsePath(clonedPath);
        setWorkspaceBrowseParentPath(parentPath);
        setWorkspaceBrowseError(null);
        setGitCheckoutModalVisible(false);
      } catch (err) {
        setGitCheckoutError((err as Error).message);
      } finally {
        setGitCheckoutCloning(false);
      }
    }, [
      api,
      gitCheckoutDirectoryName,
      gitCheckoutParentPath,
      gitCheckoutRepoUrl,
      onDefaultStartCwdChange,
      refreshWorkspaceRoots,
      workspaceBridgeRoot,
    ]);

    const refreshModelOptions = useCallback(async () => {
      setLoadingModels(true);
      try {
        const models = await api.listModels(false, {
          threadId: selectedChatId,
          engine: activeChatEngine,
        });
        setModelOptions(models);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoadingModels(false);
      }
    }, [activeChatEngine, api, selectedChatId]);

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

    const openEngineModal = useCallback(() => {
      if (selectedChatId) {
        return;
      }
      setEngineModalVisible(true);
      setError(null);
    }, [selectedChatId]);

    const closeEngineModal = useCallback(() => {
      setEngineModalVisible(false);
    }, []);

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

    const selectPendingChatEngine = useCallback((engine: ChatEngine) => {
      if (selectedChatId) {
        return;
      }

      const normalizedEngine = resolveChatEngine(engine);
      setPendingChatEngine(normalizedEngine);
      setSelectedModelId(null);
      setSelectedEffort(null);
      setEngineModalVisible(false);
      setError(null);
    }, [selectedChatId]);

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
      if (attachmentPickerInProgressRef.current) {
        return;
      }
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

    const runAttachmentPicker = useCallback(
      async (picker: () => Promise<void>) => {
        if (attachmentPickerInProgressRef.current) {
          return;
        }

        attachmentPickerInProgressRef.current = true;
        setAttachmentPickerBusy(true);
        try {
          await picker();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          attachmentPickerInProgressRef.current = false;
          setAttachmentPickerBusy(false);
        }
      },
      []
    );

    const pickFileFromDevice = useCallback(async () => {
      await runAttachmentPicker(async () => {
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
      });
    }, [runAttachmentPicker, uploadMobileAttachment]);

    const pickImageFromDevice = useCallback(async () => {
      await runAttachmentPicker(async () => {
        if (Platform.OS !== 'ios') {
          const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (!permission.granted) {
            setError('Photo library permission is required to attach images');
            return;
          }
        }

        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'] as ImagePicker.MediaType[],
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
      });
    }, [runAttachmentPicker, uploadMobileAttachment]);

    const captureImageFromCamera = useCallback(async () => {
      await runAttachmentPicker(async () => {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          setError('Camera permission is required to take a photo');
          return;
        }

        const result = await ImagePicker.launchCameraAsync({
          mediaTypes: ['images'] as ImagePicker.MediaType[],
          quality: 1,
          base64: true,
          allowsEditing: false,
        });
        if (result.canceled || !result.assets[0]) {
          return;
        }

        const image = result.assets[0];
        await uploadMobileAttachment({
          uri: image.uri,
          fileName: image.fileName ?? 'camera-photo.jpg',
          mimeType: image.mimeType ?? 'image/jpeg',
          kind: 'image',
          dataBase64: image.base64 ?? undefined,
        });
      });
    }, [runAttachmentPicker, uploadMobileAttachment]);

    const openAttachmentMenu = useCallback(() => {
      if (attachmentPickerInProgressRef.current || uploadingAttachment) {
        return;
      }
      setAttachmentMenuVisible(true);
    }, [uploadingAttachment]);

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

    useEffect(() => {
      if (attachmentMenuVisible || pendingAttachmentMenuAction === null) {
        return;
      }

      let cancelled = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const interactionHandle = InteractionManager.runAfterInteractions(() => {
        timeoutId = setTimeout(() => {
          if (cancelled) {
            return;
          }
          const action = pendingAttachmentMenuAction;
          setPendingAttachmentMenuAction(null);

          if (action === 'workspace-path') {
            openAttachmentPathModal();
            return;
          }

          if (action === 'phone-file') {
            void pickFileFromDevice();
            return;
          }

          if (action === 'phone-image') {
            void pickImageFromDevice();
            return;
          }

          if (action === 'phone-camera') {
            void captureImageFromCamera();
          }
        }, 180);
      });

      return () => {
        cancelled = true;
        interactionHandle.cancel();
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
      };
    }, [
      attachmentMenuVisible,
      captureImageFromCamera,
      openAttachmentPathModal,
      pendingAttachmentMenuAction,
      pickFileFromDevice,
      pickImageFromDevice,
    ]);

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

    const attachmentControlsDisabled = attachmentPickerBusy || uploadingAttachment;

    const attachmentMenuOptions = useMemo<SelectionSheetOption[]>(
      () => [
        {
          key: 'workspace-path',
          title: 'Attach from workspace path',
          description: 'Reference a file or folder from the current repo.',
          icon: 'folder-open-outline',
          disabled: attachmentControlsDisabled,
          onPress: () => {
            setAttachmentMenuVisible(false);
            setPendingAttachmentMenuAction('workspace-path');
          },
        },
        {
          key: 'phone-file',
          title: 'Pick file from phone',
          description: 'Import a document or asset from local storage.',
          icon: 'document-outline',
          disabled: attachmentControlsDisabled,
          onPress: () => {
            setAttachmentMenuVisible(false);
            setPendingAttachmentMenuAction('phone-file');
          },
        },
        {
          key: 'phone-image',
          title: 'Pick image from phone',
          description: 'Send an image directly from your photo library.',
          icon: 'image-outline',
          disabled: attachmentControlsDisabled,
          onPress: () => {
            setAttachmentMenuVisible(false);
            setPendingAttachmentMenuAction('phone-image');
          },
        },
        {
          key: 'phone-camera',
          title: 'Take photo',
          description: 'Capture a new photo and attach it right away.',
          icon: 'camera-outline',
          disabled: attachmentControlsDisabled,
          onPress: () => {
            setAttachmentMenuVisible(false);
            setPendingAttachmentMenuAction('phone-camera');
          },
        },
      ],
      [
        attachmentControlsDisabled,
        captureImageFromCamera,
        openAttachmentPathModal,
        pickFileFromDevice,
        pickImageFromDevice,
      ]
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
        ...(!selectedChatId && availableNewChatEngines.length > 1
          ? [
              {
                key: 'engine',
                title: 'Change engine',
                description: activeChatEngineLabel,
                icon: 'layers-outline' as const,
                onPress: () => {
                  setModelSettingsMenuVisible(false);
                  openEngineModal();
                },
              },
            ]
          : []),
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
        activeChatEngineLabel,
        availableNewChatEngines.length,
        openEngineModal,
      ]
    );

    const enginePickerOptions = useMemo<SelectionSheetOption[]>(
      () =>
        availableNewChatEngines.map((engine) => ({
          key: engine,
          title: getChatEngineLabel(engine),
          description:
            engine === 'opencode'
              ? 'Use the OpenCode backend and its connected provider models.'
              : 'Use the Codex backend and its model catalog.',
          icon:
            engine === 'opencode'
              ? ('layers-outline' as const)
              : ('sparkles-outline' as const),
          selected: activeChatEngine === engine,
          onPress: () => selectPendingChatEngine(engine),
        })),
      [activeChatEngine, availableNewChatEngines, selectPendingChatEngine]
    );

    const modelPickerOptions = useMemo<SelectionSheetOption[]>(
      () => [
        {
          key: 'server-default',
          title: 'Use server default',
          description: serverDefaultModel
            ? `Currently ${formatModelOptionLabel(serverDefaultModel)}.`
            : 'Follow the bridge default model.',
          icon: 'sparkles-outline',
          badge: 'Auto',
          selected: selectedModelId === null,
          onPress: () => selectModel(null),
        },
        ...modelOptions.map((model) => ({
          key: model.id,
          title: formatModelOptionLabel(model),
          description: formatModelOptionDescription(model),
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
            ? `Follow ${formatModelOptionLabel(effortPickerModel)}'s default reasoning.`
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
        setSelectedChat(
          mergeChatWithPendingOptimisticMessages({
            ...updated,
            title: nextName,
          })
        );
        setError(null);
        setRenameModalVisible(false);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setRenaming(false);
      }
    }, [
      api,
      mergeChatWithPendingOptimisticMessages,
      renameDraft,
      renaming,
      selectedChat?.id,
      selectedChatId,
    ]);

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

    const upsertLiveReasoningMessage = useCallback(
      (threadId: string, delta?: string | null) => {
        if (!threadId || chatIdRef.current !== threadId) {
          return;
        }

        const previousBuffer = liveReasoningBuffersRef.current[threadId] ?? '';
        const nextBuffer =
          typeof delta === 'string' && delta.length > 0
            ? mergeStreamingDelta(previousBuffer, delta)
            : previousBuffer;

        if (nextBuffer) {
          liveReasoningBuffersRef.current[threadId] = nextBuffer;
        }

        const createdAt = new Date().toISOString();
        const messageId =
          liveReasoningMessageIdsRef.current[threadId] ??
          `local-reasoning-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        liveReasoningMessageIdsRef.current[threadId] = messageId;
        const content = formatLiveReasoningMessage(
          liveReasoningBuffersRef.current[threadId] ?? ''
        );

        setSelectedChat((prev) => {
          if (!prev || prev.id !== threadId) {
            return prev;
          }

          let found = false;
          const messages = prev.messages.map((message) => {
            if (message.id !== messageId) {
              return message;
            }

            found = true;
            return {
              ...message,
              role: 'system' as const,
              systemKind: 'reasoning' as const,
              content,
            };
          });

          return {
            ...prev,
            updatedAt: createdAt,
            statusUpdatedAt: createdAt,
            messages: found
              ? messages
              : [
                  ...messages,
                  {
                    id: messageId,
                    role: 'system',
                    systemKind: 'reasoning',
                    content,
                    createdAt,
                  },
                ],
          };
        });

        schedulePinnedScrollToBottom(true);
      },
      [schedulePinnedScrollToBottom]
    );

    const clearLiveReasoningMessage = useCallback((threadId: string | null | undefined) => {
      if (!threadId) {
        return;
      }
      delete liveReasoningBuffersRef.current[threadId];
      delete liveReasoningMessageIdsRef.current[threadId];
    }, []);

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

        const nowIso = new Date().toISOString();
        setSending(false);
        setCreating(false);
        setActiveTurnId(turnId);
        setSelectedChat((prev) => {
          if (!prev || prev.id !== threadId) {
            return prev;
          }

          return {
            ...prev,
            status: 'running',
            updatedAt: nowIso,
            statusUpdatedAt: nowIso,
            lastError: undefined,
          };
        });
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

        if (name === 'agent') {
          await openAgentThreadSelectorRef.current(argText || null);
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

          const models =
            modelOptions.length > 0
              ? modelOptions
              : await api.listModels(false, {
                  threadId: selectedChatId,
                  engine: activeChatEngine,
                });
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
            let createdChatId: string | null = null;
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
              createdChatId = created.id;

              setSelectedChatId(created.id);
              queueOptimisticUserMessage(created.id, optimisticMessage, {
                baseChat: created,
              });
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
              const resolvedUpdated =
                mergeChatWithPendingOptimisticMessages(updated);
              const autoEnabledPlan =
                shouldAutoEnablePlanModeFromChat(resolvedUpdated);
              if (autoEnabledPlan) {
                setSelectedCollaborationMode('plan');
              }
              rememberChatModelPreference(
                created.id,
                activeModelId,
                selectedEffort ?? activeEffort,
                activeServiceTier
              );
              setSelectedChat(resolvedUpdated);
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
              if (createdChatId) {
                discardOptimisticUserMessage(createdChatId, optimisticMessage.id);
              }
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
            queueOptimisticUserMessage(selectedChatId, optimisticMessage);
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
              const nowIso = new Date().toISOString();
              return {
                ...baseChat,
                status: 'running',
                updatedAt: nowIso,
                statusUpdatedAt: nowIso,
                lastError: undefined,
                lastMessagePreview:
                  normalizeChatMessageMatchContent(optimisticMessage.content).slice(0, 120) ||
                  baseChat.lastMessagePreview,
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
            const resolvedUpdated =
              mergeChatWithPendingOptimisticMessages(updated);
            rememberChatModelPreference(
              selectedChatId,
              activeModelId,
              selectedEffort ?? activeEffort,
              activeServiceTier
            );
            setSelectedChat(resolvedUpdated);
            setError(null);
            setActivity({
              tone: 'complete',
              title: 'Turn completed',
            });
            clearRunWatchdog();
          } catch (err) {
            discardOptimisticUserMessage(selectedChatId, optimisticMessage.id);
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
            setSelectedChat(mergeChatWithPendingOptimisticMessages(updated));
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

          if (selectedChat?.engine === 'opencode') {
            const detail = 'Review is not supported for OpenCode chats yet.';
            setError(detail);
            setActivity({
              tone: 'error',
              title: 'Review unavailable',
              detail,
            });
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
            setSelectedChat(mergeChatWithPendingOptimisticMessages(forked));
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
        discardOptimisticUserMessage,
        fastModeEnabled,
        mergeChatWithPendingOptimisticMessages,
        modelOptions,
        onOpenGit,
        openModelModal,
        openRenameModal,
        preferredStartCwd,
        queueOptimisticUserMessage,
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
          const chat = mergeChatWithPendingOptimisticMessages(await api.getChat(chatId));
          if (requestId !== loadChatRequestRef.current) {
            return;
          }
          loadedSuccessfully = true;
          const shouldPreserveRuntimeState = Boolean(
            options?.preserveRuntimeState && chatId === chatIdRef.current
          );
          if (!shouldPreserveRuntimeState) {
            delete autoEnabledPlanTurnIdByThreadRef.current[chatId];
          }
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
              cacheThreadTurnState(chatId, {
                activeTurnId: null,
                runWatchdogUntil: 0,
              });
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
            const startedAt = openingChatStartedAtRef.current;
            if (startedAt > 0) {
              const remainingMs = OPEN_CHAT_MIN_LOADING_MS - (Date.now() - startedAt);
              if (remainingMs > 0) {
                await sleep(remainingMs);
              }
            }
            if (requestId !== loadChatRequestRef.current) {
              return;
            }
            setOpeningChatId((current) => {
              if (current === chatId) {
                openingChatStartedAtRef.current = 0;
                return null;
              }
              return current;
            });
          } else {
            openingChatStartedAtRef.current = 0;
            setOpeningChatId(null);
          }
        }
      },
      [
        api,
        applyThreadRuntimeSnapshot,
        bumpRunWatchdog,
        clearRunWatchdog,
        mergeChatWithPendingOptimisticMessages,
        refreshPendingApprovalsForThread,
        scrollToBottomIfPinned,
        scrollToBottomReliable,
      ]
    );

    const openChatThread = useCallback(
      (id: string, optimisticChat?: Chat | null) => {
        const isSameChat = chatIdRef.current === id;
        const hasSnapshot = Boolean(
          optimisticChat &&
            optimisticChat.id === id &&
            optimisticChat.messages.length > 0
        );

        if (isSameChat) {
          setSelectedChatId(id);
          openingChatStartedAtRef.current = 0;
          setOpeningChatId(null);
          setError(null);
          if (hasSnapshot && optimisticChat) {
            setSelectedChat(mergeChatWithPendingOptimisticMessages(optimisticChat));
          }
          void refreshPendingApprovalsForThread(id);
          loadChat(id, {
            forceScroll: true,
            preserveRuntimeState: true,
          }).catch(() => {});
          return;
        }

        setSelectedChatId(id);
        openingChatStartedAtRef.current = hasSnapshot ? 0 : Date.now();
        setOpeningChatId(hasSnapshot ? null : id);
        setSending(false);
        setCreating(false);
        setError(null);
        setPendingUserInputRequest(null);
        setUserInputDrafts({});
        setUserInputError(null);
        setResolvingUserInput(false);
        setAttachmentModalVisible(false);
        setAgentThreadMenuVisible(false);
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
        delete autoEnabledPlanTurnIdByThreadRef.current[id];

        if (hasSnapshot && optimisticChat) {
          setSelectedChat(mergeChatWithPendingOptimisticMessages(optimisticChat));
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
        mergeChatWithPendingOptimisticMessages,
        refreshPendingApprovalsForThread,
      ]
    );

    const openAgentThreadSelector = useCallback(
      async (query?: string | null): Promise<boolean> => {
        const focusChat = selectedChatRef.current;
        if (!focusChat?.id) {
          setError('Open a chat before switching agent threads.');
          return false;
        }

        const related = await refreshAgentThreads(focusChat.id, { showLoading: true });
        if (related.threads.length <= 1) {
          setAgentThreadMenuVisible(false);
          setError('No spawned agent threads for this chat yet.');
          return true;
        }

        const normalizedQuery = query?.trim() ?? '';
        if (!normalizedQuery) {
          setError(null);
          setAgentThreadMenuVisible(true);
          return true;
        }

        const match = findMatchingAgentThread(related.threads, normalizedQuery);
        if (!match) {
          setError(`No agent thread matched "${normalizedQuery}".`);
          setAgentThreadMenuVisible(true);
          return true;
        }

        setAgentThreadMenuVisible(false);
        openChatThread(
          match.id,
          selectedChatRef.current?.id === match.id ? selectedChatRef.current : null
        );
        return true;
      },
      [openChatThread, refreshAgentThreads]
    );
    openAgentThreadSelectorRef.current = openAgentThreadSelector;

    const agentThreadRows = useMemo(() => {
      let subAgentOrdinal = 0;

      return relatedAgentThreads.map((chat) => {
        const isRootThread = Boolean(agentRootThreadId) && chat.id === agentRootThreadId;
        const ordinal = isRootThread ? null : (subAgentOrdinal += 1);
        const snapshot = threadRuntimeSnapshotsRef.current[chat.id] ?? null;
        const runtime = buildAgentThreadDisplayState(
          chat,
          snapshot,
          runWatchdogNow
        );
        const fallbackDescription =
          chat.agentRole?.trim() ||
          chat.lastMessagePreview.trim() ||
          describeAgentThreadSource(chat, agentRootThreadId);

        return {
          chat,
          isRootThread,
          ordinal,
          title: formatAgentThreadOptionTitle(chat, agentRootThreadId, ordinal),
          description: runtime.detail ?? fallbackDescription,
          runtime,
          selected: chat.id === selectedChatId,
        };
      });
    }, [
      agentRootThreadId,
      agentRuntimeRevision,
      relatedAgentThreads,
      runWatchdogNow,
      selectedChatId,
    ]);

    const liveAgentRows = useMemo(
      () => {
        const visibleIds = new Set(
          collectLiveAgentPanelThreadIds(
            agentThreadRows.map((row) => ({
              id: row.chat.id,
              isRootThread: row.isRootThread,
              isActive: row.runtime.isActive,
            }))
          )
        );
        return agentThreadRows.filter((row) => visibleIds.has(row.chat.id));
      },
      [agentThreadRows]
    );
    const liveRunningAgentCount = useMemo(
      () => agentThreadRows.filter((row) => !row.isRootThread && row.runtime.isActive).length,
      [agentThreadRows]
    );
    const selectorAgentCount = useMemo(
      () => agentThreadRows.filter((row) => !row.isRootThread).length,
      [agentThreadRows]
    );

    const agentThreadMenuOptions = useMemo<SelectionSheetOption[]>(() => {
      return agentThreadRows.map((row) => {
        const { chat, description, isRootThread, runtime } = row;
        return {
          key: chat.id,
          title: row.title,
          description,
          badge: isRootThread
            ? 'Main'
            : chat.subAgentDepth
              ? `D${String(chat.subAgentDepth)}`
              : undefined,
          badgeBackgroundColor: isRootThread ? undefined : runtime.statusSurfaceColor,
          badgeTextColor: isRootThread ? undefined : runtime.accentColor,
          meta: runtime.label,
          metaColor: runtime.statusColor,
          icon: isRootThread ? iconForAgentThread(chat, agentRootThreadId) : runtime.icon,
          iconColor: isRootThread ? undefined : runtime.accentColor,
          titleColor: isRootThread ? undefined : runtime.accentColor,
          selected: row.selected,
          onPress: () => {
            setAgentThreadMenuVisible(false);
            if (chat.id === selectedChatRef.current?.id) {
              return;
            }
            openChatThread(chat.id);
          },
        } satisfies SelectionSheetOption;
      });
    }, [agentRootThreadId, agentThreadRows, openChatThread]);

    useImperativeHandle(ref, () => ({
      openChat: (id: string, optimisticChat?: Chat | null) => {
        openChatThread(id, optimisticChat);
      },
      startNewChat: () => {
        startNewChat();
      },
    }));

    useLayoutEffect(() => {
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

    useEffect(() => {
      return ws.onEvent((event: RpcNotification) => {
        if (
          event.method !== 'thread/started' &&
          event.method !== 'thread/name/updated' &&
          event.method !== 'thread/status/changed' &&
          event.method !== 'turn/completed'
        ) {
          return;
        }

        const currentThreadId = chatIdRef.current;
        const currentRootThreadId = agentRootThreadIdRef.current;
        if (!currentThreadId || !currentRootThreadId) {
          return;
        }

        const params = toRecord(event.params);
        const eventThreadId = extractNotificationThreadId(params);
        const eventParentThreadId = extractNotificationParentThreadId(params);
        if (
          eventThreadId &&
          eventThreadId !== currentThreadId &&
          eventThreadId !== currentRootThreadId &&
          eventParentThreadId !== currentThreadId &&
          eventParentThreadId !== currentRootThreadId
        ) {
          return;
        }

        scheduleAgentThreadsRefresh(currentThreadId);
      });
    }, [scheduleAgentThreadsRefresh, ws]);

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

      let createdChatId: string | null = null;
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
          engine: activeChatEngine,
          cwd: preferredStartCwd ?? undefined,
          model: activeModelId ?? undefined,
          effort: activeEffort ?? undefined,
          serviceTier: activeServiceTier ?? undefined,
          approvalPolicy: activeApprovalPolicy,
        });
        createdChatId = created.id;

        setSelectedChatId(created.id);
        queueOptimisticUserMessage(created.id, optimisticMessage, {
          baseChat: created,
        });
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
        const resolvedUpdated =
          mergeChatWithPendingOptimisticMessages(updated);
        const autoEnabledPlan =
          shouldAutoEnablePlanModeFromChat(resolvedUpdated);
        if (autoEnabledPlan) {
          setSelectedCollaborationMode('plan');
        }
        rememberChatModelPreference(
          created.id,
          activeModelId,
          selectedEffort ?? activeEffort,
          activeServiceTier
        );
        setSelectedChat(resolvedUpdated);
        setPendingMentionPaths([]);
        setPendingLocalImagePaths([]);
        setError(null);
        if (resolvedUpdated.status === 'complete') {
          setActivity({
            tone: 'complete',
            title: 'Turn completed',
            detail:
              autoEnabledPlan && selectedCollaborationMode !== 'plan'
                ? 'Plan mode enabled for the next turn'
                : undefined,
          });
          clearRunWatchdog();
        } else if (resolvedUpdated.status === 'error') {
          setActivity({
            tone: 'error',
            title: 'Turn failed',
            detail: resolvedUpdated.lastError ?? undefined,
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
        if (createdChatId) {
          discardOptimisticUserMessage(createdChatId, optimisticMessage.id);
        }
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
      discardOptimisticUserMessage,
      bumpRunWatchdog,
      clearRunWatchdog,
      mergeChatWithPendingOptimisticMessages,
      queueOptimisticUserMessage,
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
          suppressPlanModeAutoEnable?: boolean;
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
          queueOptimisticUserMessage(selectedChatId, optimisticMessage);
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
            const nowIso = new Date().toISOString();
            return {
              ...baseChat,
              status: 'running',
              updatedAt: nowIso,
              statusUpdatedAt: nowIso,
              lastError: undefined,
              lastMessagePreview:
                normalizeChatMessageMatchContent(optimisticMessage.content).slice(0, 120) ||
                baseChat.lastMessagePreview,
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
          const resolvedUpdated =
            mergeChatWithPendingOptimisticMessages(updated);
          const autoEnabledPlan =
            !options?.suppressPlanModeAutoEnable &&
            shouldAutoEnablePlanModeFromChat(resolvedUpdated);
          if (autoEnabledPlan) {
            setSelectedCollaborationMode('plan');
          }
          rememberChatModelPreference(
            selectedChatId,
            activeModelId,
            selectedEffort ?? activeEffort,
            activeServiceTier
          );
          setSelectedChat(resolvedUpdated);
          if (shouldClearComposer) {
            setPendingMentionPaths([]);
            setPendingLocalImagePaths([]);
          }
          setError(null);
          if (resolvedUpdated.status === 'complete') {
            setActivity({
              tone: 'complete',
              title: 'Turn completed',
              detail:
                autoEnabledPlan && resolvedCollaborationMode !== 'plan'
                  ? 'Plan mode enabled for the next turn'
                  : undefined,
            });
            clearRunWatchdog();
          } else if (resolvedUpdated.status === 'error') {
            setActivity({
              tone: 'error',
              title: 'Turn failed',
              detail: resolvedUpdated.lastError ?? undefined,
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
          discardOptimisticUserMessage(selectedChatId, optimisticMessage.id);
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
        discardOptimisticUserMessage,
        bumpRunWatchdog,
        clearRunWatchdog,
        mergeChatWithPendingOptimisticMessages,
        queueOptimisticUserMessage,
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

    const handleSteerQueuedMessage = useCallback(async () => {
      const threadId = selectedChatId?.trim();
      const snapshotTurnId = threadId
        ? threadRuntimeSnapshotsRef.current[threadId]?.activeTurnId?.trim() ?? ''
        : '';
      const expectedTurnId = activeTurnIdRef.current?.trim() || snapshotTurnId;
      const nextQueuedMessage = queuedMessages[0] ?? null;
      const canSteer =
        Boolean(threadId) &&
        Boolean(expectedTurnId) &&
        Boolean(nextQueuedMessage) &&
        !pendingApproval?.id &&
        !pendingUserInputRequest?.id;

      if (!threadId || !expectedTurnId || !nextQueuedMessage || !canSteer) {
        return;
      }

      try {
        setError(null);
        bumpRunWatchdog();
        setSteeringMessage(nextQueuedMessage);
        await api.steerChatTurn(threadId, expectedTurnId, {
          content: nextQueuedMessage.content,
          mentions: nextQueuedMessage.mentions,
          localImages: nextQueuedMessage.localImages,
        });
        const optimisticContent = toOptimisticUserContent(
          nextQueuedMessage.content,
          nextQueuedMessage.mentions,
          nextQueuedMessage.localImages
        );
        const optimisticMessage: ChatTranscriptMessage = {
          id: `msg-${Date.now()}`,
          role: 'user',
          content: optimisticContent,
          createdAt: new Date().toISOString(),
        };
        queueOptimisticUserMessage(threadId, optimisticMessage);
        setSelectedChat((prev) => {
          if (!prev || prev.id !== threadId) {
            return prev;
          }

          return {
            ...prev,
            lastMessagePreview:
              normalizeChatMessageMatchContent(optimisticMessage.content).slice(0, 120) ||
              prev.lastMessagePreview,
            messages: [...prev.messages, optimisticMessage],
          };
        });
        setQueuedMessages((prev) =>
          prev[0]?.id === nextQueuedMessage.id ? prev.slice(1) : prev
        );
        setSteeringMessage((previous) =>
          previous?.id === nextQueuedMessage.id ? null : previous
        );
        setQueuePaused(false);
        scrollToBottomReliable(true);
        setActivity({
          tone: 'running',
          title: 'Steering turn',
          detail: 'Message sent to the current run',
        });
      } catch (err) {
        setSteeringMessage((previous) =>
          previous?.id === nextQueuedMessage.id ? null : previous
        );
        setError((err as Error).message);
      }
    }, [
      api,
      bumpRunWatchdog,
      pendingApproval?.id,
      pendingUserInputRequest?.id,
      queueOptimisticUserMessage,
      queuedMessages,
      scrollToBottomReliable,
      selectedChatId,
    ]);

    const handleCancelQueuedMessage = useCallback(
      (messageId: string) => {
        const normalizedMessageId = messageId.trim();
        if (!normalizedMessageId || queueDispatching) {
          return;
        }

        setQueuedMessages((prev) =>
          prev.filter((message) => message.id !== normalizedMessageId)
        );
        setQueuePaused(false);
        setError(null);
      },
      [queueDispatching]
    );

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
      const dispatchingThreadId = selectedChatId;
      const dispatchingMessageId = nextMessage.id;
      setQueueDispatching(true);
      void (async () => {
        const sent = await sendMessageContent(nextMessage.content, {
          allowSlashCommands: false,
          collaborationMode: nextMessage.collaborationMode,
          mentions: nextMessage.mentions,
          localImages: nextMessage.localImages,
          clearComposer: false,
        });
        if (chatIdRef.current === dispatchingThreadId) {
          if (sent) {
            setQueuedMessages((prev) =>
              prev[0]?.id === dispatchingMessageId ? prev.slice(1) : prev
            );
          } else {
            setQueuePaused(true);
          }
          setQueueDispatching(false);
        }
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

    useEffect(() => {
      setSteeringMessage(null);
    }, [selectedChat?.id]);

    useEffect(() => {
      if (!steeringMessage) {
        return;
      }

      const shouldKeepSteeringMessage =
        Boolean(activeTurnId) ||
        runWatchdogUntilRef.current > Date.now() ||
        (selectedChat ? isChatLikelyRunning(selectedChat) : false);
      if (shouldKeepSteeringMessage) {
        return;
      }

      setSteeringMessage(null);
    }, [activeTurnId, runWatchdogNow, selectedChat, steeringMessage]);

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
            clearLiveReasoningMessage(activeThreadId);
            delete planItemTurnIdByThreadRef.current[activeThreadId];
            clearPendingPlanImplementationPrompt(activeThreadId);
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
            schedulePinnedScrollToBottom(true);
            return;
          }

          if (codexEventType === 'plandelta') {
            const rawDelta = readString(msg?.delta) ?? '';
            if (!rawDelta) {
              return;
            }

            const turnId = resolveCodexPlanTurnId(
              msg,
              planItemTurnIdByThreadRef.current[activeThreadId] ??
                activeTurnIdRef.current ??
                threadRuntimeSnapshotsRef.current[activeThreadId]?.activeTurnId ??
                null
            );
            planItemTurnIdByThreadRef.current[activeThreadId] = turnId;
            setSelectedCollaborationMode('plan');
            bumpRunWatchdog();
            setActivePlan((prev) =>
              buildNextPlanStateFromDelta(prev, activeThreadId, turnId, rawDelta)
            );
            cacheThreadPlan(activeThreadId, (previous) =>
              buildNextPlanStateFromDelta(previous, activeThreadId, turnId, rawDelta)
            );
            setActivity({
              tone: 'running',
              title: 'Planning',
            });
            return;
          }

          if (codexEventType === 'planupdate') {
            const turnId = resolveCodexPlanTurnId(
              msg,
              planItemTurnIdByThreadRef.current[activeThreadId] ??
                activeTurnIdRef.current ??
                threadRuntimeSnapshotsRef.current[activeThreadId]?.activeTurnId ??
                null
            );
            const planUpdate = toCodexTurnPlanUpdate(msg, activeThreadId, turnId);
            planItemTurnIdByThreadRef.current[activeThreadId] = turnId;
            setSelectedCollaborationMode('plan');
            bumpRunWatchdog();
            if (planUpdate) {
              setActivePlan((prev) => buildNextPlanStateFromUpdate(prev, planUpdate));
              cacheThreadPlan(activeThreadId, (previous) =>
                buildNextPlanStateFromUpdate(previous, planUpdate)
              );
            }
            setActivity({
              tone: 'running',
              title: 'Planning',
            });
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
            delete planItemTurnIdByThreadRef.current[activeThreadId];
            clearPendingPlanImplementationPrompt(activeThreadId);
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
            delete planItemTurnIdByThreadRef.current[activeThreadId];
            clearPendingPlanImplementationPrompt(activeThreadId);
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
            const planTurnId = planItemTurnIdByThreadRef.current[activeThreadId] ?? null;
            delete planItemTurnIdByThreadRef.current[activeThreadId];
            clearRunWatchdog();
            setActiveTurnId(null);
            setStoppingTurn(false);
            stopRequestedRef.current = false;
            if (planTurnId) {
              setPendingPlanImplementationPrompts((prev) => ({
                ...prev,
                [activeThreadId]: {
                  threadId: activeThreadId,
                  turnId: planTurnId,
                },
              }));
            } else {
              clearPendingPlanImplementationPrompt(activeThreadId);
            }
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
          schedulePinnedScrollToBottom(true);
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
          clearLiveReasoningMessage(threadId);
          delete planItemTurnIdByThreadRef.current[threadId];
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
            if (selectedChatRef.current?.engine === 'opencode') {
              upsertLiveReasoningMessage(threadId);
            }
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
          const delta = readString(params?.delta);
          if (delta && selectedChatRef.current?.engine === 'opencode') {
            upsertLiveReasoningMessage(threadId, delta);
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
          clearLiveReasoningMessage(threadId);
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
          const terminalStatus: ChatStatus =
            status === 'failed' || (status === 'interrupted' && !interruptedByUser)
              ? 'error'
              : 'complete';
          const terminalStatusAt = new Date().toISOString();

          setActiveCommands([]);
          setStreamingText(null);
          setPendingUserInputRequest(null);
          setUserInputDrafts({});
          setUserInputError(null);
          setResolvingUserInput(false);
          setSteeringMessage(null);
          if (!completedTurnId || completedTurnId === activeTurnIdRef.current) {
            setActiveTurnId(null);
          }
          setSelectedChat((prev) => {
            if (!prev || prev.id !== threadId) {
              return prev;
            }

            return {
              ...prev,
              status: terminalStatus,
              updatedAt: terminalStatusAt,
              statusUpdatedAt: terminalStatusAt,
              lastError:
                terminalStatus === 'error' ? turnErrorMessage ?? status ?? undefined : undefined,
            };
          });
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
                  cacheThreadTurnState(threadId, {
                    activeTurnId: null,
                    runWatchdogUntil: 0,
                  });
                  setActiveTurnId(null);
                  setStoppingTurn(false);
                  setSteeringMessage(null);
                  if (!pendingApprovalId && !pendingUserInputRequestId) {
                    setActiveCommands([]);
                    setStreamingText(null);
                    reasoningSummaryRef.current = {};
                    codexReasoningBufferRef.current = '';
                    hadCommandRef.current = false;
                    setActivity(() => {
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
      clearLiveReasoningMessage,
      clearRunWatchdog,
      readThreadContextUsage,
      refreshPendingApprovalsForThread,
      scheduleExternalStatusFullSync,
      registerTurnStarted,
      pushActiveCommand,
      scrollToBottomIfPinned,
      upsertLiveReasoningMessage,
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
          const resolvedLatest = mergeChatWithPendingOptimisticMessages(latest);
          setSelectedChat((prev) => {
            if (!prev || prev.id !== resolvedLatest.id) {
              return resolvedLatest;
            }

            const isUnchanged =
              prev.updatedAt === resolvedLatest.updatedAt &&
              prev.messages.length === resolvedLatest.messages.length;

            return isUnchanged ? prev : resolvedLatest;
          });

          const currentSelectedChat = selectedChatRef.current;
          const hasTerminalStatus =
            resolvedLatest.status === 'complete' || resolvedLatest.status === 'error';
          const hasAssistantProgress =
            !hasTerminalStatus &&
            didAssistantMessageProgress(currentSelectedChat, resolvedLatest);
          const hasPendingUserMessage =
            !hasTerminalStatus && hasRecentUnansweredUserTurn(resolvedLatest);
          const shouldRunFromChat =
            isChatLikelyRunning(resolvedLatest) ||
            hasAssistantProgress ||
            hasPendingUserMessage;
          const shouldRunFromWatchdog =
            !hasTerminalStatus && runWatchdogUntilRef.current > Date.now();
          const shouldShowRunning = shouldRunFromChat || shouldRunFromWatchdog;
          const shouldRefreshWatchdog = shouldRunFromChat;
          const watchdogDurationMs =
            hasAssistantProgress && !isChatLikelyRunning(resolvedLatest)
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
              if (resolvedLatest.status === 'complete') {
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
      mergeChatWithPendingOptimisticMessages,
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
    const displayedQueuedMessage = steeringMessage ?? oldestQueuedMessage;
    const remainingQueuedMessagesCount = steeringMessage
      ? queuedMessages.length
      : Math.max(0, queuedMessages.length - 1);
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

      if (activity.tone === 'error' && activity.title === 'Turn failed') {
        return {
          tone: 'idle',
          title: 'Ready',
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
    const composerUsageLimitBadges =
      activeChatEngine === 'codex'
        ? buildComposerUsageLimitBadges(accountRateLimits)
        : [];
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
          ? theme.colors.borderHighlight
          : theme.colors.textMuted
        : contextRemainingPercent <= 10
          ? theme.colors.error
          : contextRemainingPercent <= 25
            ? theme.colors.accent
            : theme.colors.borderHighlight;
    const headerTitle = isOpeningChat ? 'Opening chat' : selectedChat?.title?.trim() || 'New chat';
    const defaultStartWorkspaceLabel =
      preferredStartCwd ?? 'Bridge default workspace';
    const gitCheckoutDestinationLabel =
      gitCheckoutParentPath ?? workspaceBridgeRoot ?? 'Bridge default workspace';
    const gitCheckoutTargetPath =
      gitCheckoutParentPath && normalizeCloneDirectoryName(gitCheckoutDirectoryName)
        ? joinWorkspacePath(
            gitCheckoutParentPath,
            normalizeCloneDirectoryName(gitCheckoutDirectoryName) ?? ''
          )
        : null;
    const spawnedAgentCount = selectorAgentCount;
    const selectedChatIsSubAgent = Boolean(selectedChat?.parentThreadId);
    const showAgentThreadChip =
      !isOpeningChat &&
      Boolean(selectedChat) &&
      (spawnedAgentCount > 0 || selectedChatIsSubAgent);
    const agentThreadChipLabel = selectedChatIsSubAgent
      ? spawnedAgentCount > 1
        ? `Sub-agent · ${String(spawnedAgentCount)} threads`
        : 'Sub-agent'
      : spawnedAgentCount === 1
        ? '1 agent'
        : `${String(spawnedAgentCount)} agents`;
    const showLiveAgentPanel =
      !isOpeningChat && Boolean(selectedChat) && liveAgentRows.length > 0;
    const agentThreadStatusById = useMemo(
      () => new Map(relatedAgentThreads.map((chat) => [chat.id, chat.status] as const)),
      [relatedAgentThreads]
    );
    const selectedThreadRuntimeSnapshot = selectedChat
      ? threadRuntimeSnapshotsRef.current[selectedChat.id] ?? null
      : null;
    const inMemorySelectedThreadPlan = selectedChat
      ? activePlan?.threadId === selectedChat.id
        ? activePlan
        : selectedThreadRuntimeSnapshot?.plan ??
          chatPlanSnapshotsRef.current[selectedChat.id] ??
          null
      : null;
    const persistedSelectedThreadPlan = selectedChat
      ? toPersistedActivePlanState(selectedChat.latestPlan, selectedChat.updatedAt)
      : null;
    const selectedThreadPlan = selectedChat
      ? resolveDisplayedThreadPlan(
          inMemorySelectedThreadPlan,
          persistedSelectedThreadPlan,
          selectedThreadRuntimeSnapshot
        )
      : null;
    const dismissedSelectedPlanTurnId = selectedChat
      ? dismissedPlanImplementationTurnIdByThreadRef.current[selectedChat.id] ?? null
      : null;
    const derivedSelectedPlanImplementationPrompt = selectedChat
      ? resolvePersistedPlanImplementationPrompt(
          selectedChat,
          dismissedSelectedPlanTurnId
        )
      : null;
    const selectedPlanImplementationPrompt = selectedChat
      ? resolveUndismissedPlanImplementationPrompt(
          pendingPlanImplementationPrompts[selectedChat.id] ?? null,
          dismissedSelectedPlanTurnId
        ) ??
        derivedSelectedPlanImplementationPrompt
      : null;
    const showStructuredPlanCard = hasStructuredPlanCardContent(selectedThreadPlan);
    const planPanelCollapsed =
      selectedChat ? (planPanelCollapsedByThread[selectedChat.id] ?? false) : false;
    const fastModeControlDisabled = isOpeningChat;
    const showSlashSuggestions = slashSuggestions.length > 0 && draft.trimStart().startsWith('/');
    const steerTargetTurnId = resolveSteerTargetTurnId(
      activeTurnId,
      selectedThreadRuntimeSnapshot?.activeTurnId
    );
    const canSteerQueuedMessage =
      Boolean(oldestQueuedMessage) &&
      Boolean(selectedChatId) &&
      Boolean(steerTargetTurnId) &&
      !pendingApproval &&
      !pendingUserInputRequest &&
      !steeringMessage;
    const canCancelQueuedMessage =
      Boolean(oldestQueuedMessage) && !queueDispatching && !steeringMessage;
    const queuedMessageSteerDisabledReason = steeringMessage
      ? 'Sending the queued message to the current turn.'
      : pendingApproval
      ? 'Waiting for approval before steering.'
      : pendingUserInputRequest
        ? 'Waiting for required input before steering.'
        : !steerTargetTurnId && oldestQueuedMessage
          ? 'Steer becomes available once the current turn has started.'
        : null;
    const showQueuedMessageDock =
      Boolean(selectedChat) && !isOpeningChat && Boolean(displayedQueuedMessage);
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
    const workflowCardMode = resolveWorkflowCardMode({
      collaborationMode: selectedCollaborationMode,
      hasStructuredPlan: showStructuredPlanCard,
      hasPlanApprovalPrompt: showPlanImplementationPrompt,
    });
    const showTopCardsRow = !isOpeningChat && workflowCardMode !== null;
    const showFloatingActivity =
      showActivity && shouldShowComposer && Boolean(selectedChat) && !isOpeningChat;
    const chatBottomInset = shouldShowComposer
      ? theme.spacing.lg
      : Math.max(theme.spacing.xxl, safeAreaInsets.bottom + theme.spacing.lg);
    const composerSafeAreaBottomInset = safeAreaInsets.bottom;
    const composerOverlayInset =
      Platform.OS === 'android' && keyboardVisible ? androidKeyboardInset : 0;
    const androidComposerReservedInset = shouldShowComposer
      ? Math.max(
          theme.spacing.lg,
          composerHeight +
            composerOverlayInset +
            theme.spacing.sm
        )
      : chatBottomInset;
    const renderComposer = (overlay: boolean) => (
      <View
        onLayout={
          overlay
            ? (event) => {
                const nextHeight = Math.ceil(event.nativeEvent.layout.height);
                setComposerHeight((previous) => (previous === nextHeight ? previous : nextHeight));
              }
            : undefined
        }
        style={[
          styles.composerContainer,
          overlay ? styles.composerContainerOverlay : null,
          overlay ? { bottom: composerOverlayInset } : null,
          !overlay && !keyboardVisible ? styles.composerContainerResting : null,
        ]}
      >
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {pendingApproval ? (
          <ApprovalBanner
            approval={pendingApproval}
            onResolve={handleResolveApproval}
          />
        ) : null}
        {showQueuedMessageDock && displayedQueuedMessage ? (
          <QueuedMessageDock
            queuedMessage={displayedQueuedMessage}
            remainingQueuedMessagesCount={remainingQueuedMessagesCount}
            steerEnabled={canSteerQueuedMessage}
            cancelEnabled={canCancelQueuedMessage}
            steeringActive={Boolean(steeringMessage)}
            steerDisabledReason={queuedMessageSteerDisabledReason}
            onCancelQueuedMessage={(messageId) => {
              handleCancelQueuedMessage(messageId);
            }}
            onSteerQueuedMessage={() => {
              void handleSteerQueuedMessage();
            }}
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
        {overlay && showFloatingActivity ? (
          <View pointerEvents="none" style={styles.activityDock}>
            <ActivityBar
              title={visibleActivity.title}
              detail={activityDetail}
              tone={visibleActivity.tone}
            />
          </View>
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
          attachDisabled={attachmentControlsDisabled}
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
          safeAreaBottomInset={composerSafeAreaBottomInset}
          keyboardVisible={keyboardVisible}
          footer={
            composerUsageLimitBadges.length > 0 ? (
              <ComposerUsageLimits limits={composerUsageLimitBadges} />
            ) : null
          }
        />
      </View>
    );

    useEffect(() => {
      if (!selectedChat || isOpeningChat || !shouldAutoEnablePlanModeFromChat(selectedChat)) {
        return;
      }

      const latestPlanTurnId = selectedChat.latestTurnPlan?.turnId?.trim();
      if (!latestPlanTurnId) {
        return;
      }

      if (
        dismissedPlanImplementationTurnIdByThreadRef.current[selectedChat.id] ===
        latestPlanTurnId
      ) {
        return;
      }

      if (autoEnabledPlanTurnIdByThreadRef.current[selectedChat.id] === latestPlanTurnId) {
        return;
      }

      autoEnabledPlanTurnIdByThreadRef.current[selectedChat.id] = latestPlanTurnId;
      setSelectedCollaborationMode('plan');
    }, [
      isOpeningChat,
      selectedChat?.id,
      selectedChat?.latestTurnPlan?.turnId,
      selectedChat?.latestTurnStatus,
    ]);

    useEffect(() => {
      const threadId = selectedChat?.id;
      if (
        !threadId ||
        isOpeningChat ||
        selectedChat?.latestTurnPlan ||
        selectedCollaborationMode !== 'plan'
      ) {
        return;
      }

      if (!autoEnabledPlanTurnIdByThreadRef.current[threadId]) {
        return;
      }

      setSelectedCollaborationMode('default');
    }, [
      isOpeningChat,
      selectedChat?.id,
      selectedChat?.latestTurnPlan?.turnId,
      selectedCollaborationMode,
    ]);

    useEffect(() => {
      const threadId = selectedChat?.id;
      if (!threadId) {
        return;
      }

      const pendingPrompt = pendingPlanImplementationPrompts[threadId];
      if (!pendingPrompt) {
        return;
      }

      const latestTurnPlanTurnId = selectedChat?.latestTurnPlan?.turnId ?? null;
      if (latestTurnPlanTurnId && latestTurnPlanTurnId === pendingPrompt.turnId) {
        return;
      }

      clearPendingPlanImplementationPrompt(threadId);
    }, [
      clearPendingPlanImplementationPrompt,
      pendingPlanImplementationPrompts,
      selectedChat?.id,
      selectedChat?.latestTurnPlan?.turnId,
    ]);

    const stayInPlanMode = useCallback(() => {
      if (!selectedChatId) {
        return;
      }

      const prompt = selectedPlanImplementationPrompt;
      if (prompt) {
        dismissedPlanImplementationTurnIdByThreadRef.current[prompt.threadId] = prompt.turnId;
      }
      setSelectedCollaborationMode('plan');
      clearPendingPlanImplementationPrompt(selectedChatId);
    }, [
      clearPendingPlanImplementationPrompt,
      selectedChatId,
      selectedPlanImplementationPrompt,
    ]);

    const implementPlan = useCallback(async () => {
      if (!selectedChatId) {
        return;
      }

      const prompt = selectedPlanImplementationPrompt;
      if (!prompt) {
        return;
      }

      clearPendingPlanImplementationPrompt(prompt.threadId);
      setSelectedCollaborationMode('default');
      const sent = await sendMessageContent(PLAN_IMPLEMENTATION_CODING_MESSAGE, {
        collaborationMode: 'default',
        clearComposer: false,
        preservePlan: true,
        suppressPlanModeAutoEnable: true,
      });
      if (sent) {
        dismissedPlanImplementationTurnIdByThreadRef.current[prompt.threadId] = prompt.turnId;
      } else {
        setPendingPlanImplementationPrompts((prev) => ({
          ...prev,
          [prompt.threadId]: prompt,
        }));
      }
    }, [
      clearPendingPlanImplementationPrompt,
      pendingPlanImplementationPrompts,
      selectedChatId,
      selectedPlanImplementationPrompt,
      sendMessageContent,
    ]);

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

    useEffect(() => {
      if (!showLiveAgentPanel) {
        setAgentPanelCollapsed(false);
      }
    }, [showLiveAgentPanel]);

    useEffect(() => {
      setAgentPanelCollapsed(false);
    }, [selectedChat?.id]);

    const toggleSelectedPlanPanel = useCallback(() => {
      if (!selectedChat?.id || workflowCardMode === null) {
        return;
      }

      setPlanPanelCollapsedByThread((prev) => ({
        ...prev,
        [selectedChat.id]: !(prev[selectedChat.id] ?? false),
      }));
    }, [selectedChat?.id, workflowCardMode]);

    return (
      <View style={styles.container}>
        <ChatHeader
          onOpenDrawer={onOpenDrawer}
          title={headerTitle}
          engineLabel={selectedChat ? getChatEngineLabel(selectedChat.engine) : undefined}
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
                <Ionicons name="sparkles-outline" size={13} color={theme.colors.textMuted} />
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
                <Ionicons name="map-outline" size={13} color={theme.colors.textMuted} />
                <Text style={styles.modelChipText} numberOfLines={1}>
                  {collaborationModeLabel}
                </Text>
              </Pressable>
              {showAgentThreadChip ? (
                <Pressable
                  style={({ pressed }) => [
                    styles.modeChip,
                    pressed && styles.modelChipPressed,
                  ]}
                  onPress={() => {
                    void openAgentThreadSelector();
                  }}
                >
                  <Ionicons name="people-outline" size={13} color={theme.colors.textMuted} />
                  <Text style={styles.modelChipText} numberOfLines={1}>
                    {agentThreadChipLabel}
                  </Text>
                </Pressable>
              ) : null}
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
                  color={fastModeEnabled ? theme.colors.textPrimary : theme.colors.textMuted}
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
            {workflowCardMode ? (
              <WorkflowCard
                mode={workflowCardMode}
                plan={selectedThreadPlan}
                collapsed={planPanelCollapsed}
                scrollMaxHeight={Math.max(
                  176,
                  Math.min(
                    Math.floor(windowHeight * (workflowCardMode === 'approval' ? 0.34 : 0.4)),
                    workflowCardMode === 'approval' ? 280 : 360
                  )
                )}
                actionDisabled={sending || creating || stoppingTurn}
                onToggleCollapse={toggleSelectedPlanPanel}
                onImplement={() => void implementPlan()}
                onStayInPlanMode={stayInPlanMode}
              />
            ) : null}
          </View>
        ) : null}

        {showLiveAgentPanel ? (
          <View style={styles.agentPanelWrap}>
            <AgentThreadsPanel
              rows={liveAgentRows}
              runningCount={liveRunningAgentCount}
              collapsed={agentPanelCollapsed}
              onToggleCollapse={() => {
                setAgentPanelCollapsed((previous) => !previous);
              }}
              onSelectThread={(threadId) => {
                if (threadId === selectedChatRef.current?.id) {
                  return;
                }
                openChatThread(threadId);
              }}
            />
          </View>
        ) : null}

        {Platform.OS === 'android' ? (
          <View style={styles.bodyContainer}>
            <KeyboardAvoidingView style={styles.keyboardAvoiding} enabled={false}>
              {selectedChat && !isOpeningChat ? (
                <ChatView
                  chat={selectedChat}
                  parentChat={selectedParentChat}
                  bridgeUrl={bridgeUrl}
                  bridgeToken={bridgeToken}
                  onOpenLocalPreview={onOpenLocalPreviewHandler}
                  showToolCalls={showToolCalls}
                  agentThreadStatusById={agentThreadStatusById}
                  scrollRef={scrollRef}
                  inlineChoicesEnabled={!pendingUserInputRequest && !pendingApproval && !isLoading}
                  onInlineOptionSelect={handleInlineOptionSelect}
                  onPinnedAutoScroll={scrollToBottomIfPinned}
                  onScrollInteractionStart={clearPendingScrollRetries}
                  autoScrollStateRef={autoScrollStateRef}
                  bottomInset={androidComposerReservedInset}
                />
              ) : isOpeningChat ? (
                <View style={styles.chatLoadingContainer}>
                  <ActivityIndicator size="small" color={theme.colors.textMuted} />
                  <Text style={styles.chatLoadingText}>Opening chat...</Text>
                </View>
              ) : (
                <ComposeView
                  startWorkspaceLabel={defaultStartWorkspaceLabel}
                  showEnginePicker={availableNewChatEngines.length > 1}
                  engineLabel={activeChatEngineLabel}
                  modelReasoningLabel={modelReasoningLabel}
                  collaborationModeLabel={collaborationModeLabel}
                  fastModeEnabled={fastModeEnabled}
                  fastModeLabel={fastModeLabel}
                  keyboardVisible={keyboardVisible}
                  bottomInset={androidComposerReservedInset}
                  onSuggestion={(s) => setDraft(s)}
                  onOpenWorkspacePicker={openWorkspaceModal}
                  onOpenEnginePicker={openEngineModal}
                  onOpenModelReasoningPicker={openModelReasoningMenu}
                  onOpenCollaborationModePicker={openCollaborationModeMenu}
                  onToggleFastMode={() => {
                    void toggleFastMode();
                  }}
                />
              )}
            </KeyboardAvoidingView>

            {shouldShowComposer ? renderComposer(true) : null}
          </View>
        ) : (
          <KeyboardAvoidingView
            style={styles.keyboardAvoiding}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            enabled={Platform.OS === 'ios'}
          >
            {selectedChat && !isOpeningChat ? (
              <ChatView
                chat={selectedChat}
                parentChat={selectedParentChat}
                bridgeUrl={bridgeUrl}
                bridgeToken={bridgeToken}
                onOpenLocalPreview={onOpenLocalPreviewHandler}
                showToolCalls={showToolCalls}
                agentThreadStatusById={agentThreadStatusById}
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
                <ActivityIndicator size="small" color={theme.colors.textMuted} />
                <Text style={styles.chatLoadingText}>Opening chat...</Text>
              </View>
            ) : (
              <ComposeView
                startWorkspaceLabel={defaultStartWorkspaceLabel}
                showEnginePicker={availableNewChatEngines.length > 1}
                engineLabel={activeChatEngineLabel}
                modelReasoningLabel={modelReasoningLabel}
                collaborationModeLabel={collaborationModeLabel}
                fastModeEnabled={fastModeEnabled}
                fastModeLabel={fastModeLabel}
                keyboardVisible={false}
                bottomInset={0}
                onSuggestion={(s) => setDraft(s)}
                onOpenWorkspacePicker={openWorkspaceModal}
                onOpenEnginePicker={openEngineModal}
                onOpenModelReasoningPicker={openModelReasoningMenu}
                onOpenCollaborationModePicker={openCollaborationModeMenu}
                onToggleFastMode={() => {
                  void toggleFastMode();
                }}
              />
            )}

            {showFloatingActivity ? (
              <View pointerEvents="none" style={styles.activityDock}>
                <ActivityBar
                  title={visibleActivity.title}
                  detail={activityDetail}
                  tone={visibleActivity.tone}
                />
              </View>
            ) : null}

            {shouldShowComposer ? renderComposer(false) : null}
          </KeyboardAvoidingView>
        )}

        <SelectionSheet
          visible={attachmentMenuVisible}
          eyebrow="Attachments"
          title="Add context"
          subtitle="Bring in a workspace path, a file, a saved image, or a fresh photo."
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
          visible={agentThreadMenuVisible}
          eyebrow="Agents"
          title="Agent threads"
          subtitle="Switch between the main thread and spawned sub-agent threads."
          options={agentThreadMenuOptions}
          loading={loadingAgentThreads}
          loadingLabel="Loading agent threads…"
          emptyLabel="No spawned agent threads for this chat yet."
          onClose={() => setAgentThreadMenuVisible(false)}
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
          presentation="expanded"
          onClose={() => setModelSettingsMenuVisible(false)}
        />

        <SelectionSheet
          visible={engineModalVisible}
          eyebrow="Engine"
          title="Select engine"
          subtitle="Choose which backend new chats should start with."
          options={enginePickerOptions}
          onClose={closeEngineModal}
        />

        <WorkspacePickerModal
          visible={workspaceModalVisible}
          selectedPath={
            workspacePickerPurpose === 'git-checkout-destination'
              ? gitCheckoutParentPath
              : preferredStartCwd
          }
          bridgeRoot={workspaceBridgeRoot}
          recentWorkspaces={workspaceRoots}
          currentPath={workspaceBrowsePath}
          parentPath={workspaceBrowseParentPath}
          entries={workspaceBrowseEntries}
          loadingRecent={loadingWorkspaceRoots}
          loadingEntries={loadingWorkspaceBrowse}
          error={workspaceBrowseError}
          onBrowsePath={(path) => void browseWorkspacePath(path)}
          onSelectPath={handleWorkspaceSelection}
          actionLabel={
            workspacePickerPurpose === 'default-start' ? 'Clone repository here' : null
          }
          actionDescription={
            workspacePickerPurpose === 'default-start'
              ? 'Use the folder you already have selected or open as the destination for a fresh checkout.'
              : null
          }
          onActionPress={
            workspacePickerPurpose === 'default-start'
              ? (path) => {
                  setWorkspaceModalVisible(false);
                  openGitCheckoutModal(path);
                }
              : undefined
          }
          onClose={closeWorkspaceModal}
        />

        <Modal
          visible={gitCheckoutModalVisible}
          transparent
          animationType="fade"
          onRequestClose={closeGitCheckoutModal}
        >
          <View style={styles.renameModalBackdrop}>
            <KeyboardAvoidingView
              style={styles.renameModalKeyboardAvoider}
              behavior={Platform.OS === 'ios' ? 'position' : 'height'}
              keyboardVerticalOffset={
                Platform.OS === 'ios'
                  ? Math.max(theme.spacing.xl * 2, safeAreaInsets.bottom + theme.spacing.md)
                  : 0
              }
            >
              <View style={styles.renameModalKeyboardContent}>
                <View style={styles.renameModalCard}>
                  <Text style={styles.renameModalTitle}>Git checkout</Text>
                  <Text style={styles.gitCheckoutHint}>
                    Paste an SSH or HTTPS repository URL, choose where to clone it, then start
                    the new chat in that workspace.
                  </Text>
                  <TextInput
                    value={gitCheckoutRepoUrl}
                    onChangeText={handleGitCheckoutRepoUrlChange}
                    keyboardAppearance={theme.keyboardAppearance}
                    placeholder="git@github.com:org/repo.git"
                    placeholderTextColor={theme.colors.textMuted}
                    style={styles.renameModalInput}
                    autoFocus
                    editable={!gitCheckoutCloning}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="next"
                  />
                  <Pressable
                    onPress={openGitCheckoutDestinationPicker}
                    style={({ pressed }) => [
                      styles.gitCheckoutPathButton,
                      pressed && styles.gitCheckoutPathButtonPressed,
                    ]}
                    disabled={gitCheckoutCloning}
                  >
                    <Ionicons
                      name="folder-open-outline"
                      size={16}
                      color={theme.colors.textMuted}
                    />
                    <View style={styles.gitCheckoutPathCopy}>
                      <Text style={styles.gitCheckoutPathLabel}>Clone into</Text>
                      <Text style={styles.gitCheckoutPathValue} numberOfLines={1}>
                        {gitCheckoutDestinationLabel}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={14} color={theme.colors.textMuted} />
                  </Pressable>
                  <TextInput
                    value={gitCheckoutDirectoryName}
                    onChangeText={handleGitCheckoutDirectoryNameChange}
                    keyboardAppearance={theme.keyboardAppearance}
                    placeholder="repo-folder"
                    placeholderTextColor={theme.colors.textMuted}
                    style={styles.renameModalInput}
                    editable={!gitCheckoutCloning}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="done"
                    onSubmitEditing={() => void submitGitCheckout()}
                  />
                  {gitCheckoutTargetPath ? (
                    <Text style={styles.gitCheckoutSummary} numberOfLines={2}>
                      {`Will clone into ${gitCheckoutTargetPath}`}
                    </Text>
                  ) : null}
                  {gitCheckoutError ? (
                    <Text style={styles.gitCheckoutErrorText}>{gitCheckoutError}</Text>
                  ) : null}
                  <View style={styles.renameModalActions}>
                    <Pressable
                      onPress={closeGitCheckoutModal}
                      style={({ pressed }) => [
                        styles.renameModalButton,
                        styles.renameModalButtonSecondary,
                        pressed && styles.renameModalButtonPressed,
                      ]}
                      disabled={gitCheckoutCloning}
                    >
                      <Text style={styles.renameModalButtonSecondaryText}>Cancel</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => void submitGitCheckout()}
                      style={({ pressed }) => [
                        styles.renameModalButton,
                        styles.renameModalButtonPrimary,
                        pressed && styles.renameModalButtonPrimaryPressed,
                        (!gitCheckoutRepoUrl.trim() ||
                          !normalizeCloneDirectoryName(gitCheckoutDirectoryName) ||
                          gitCheckoutCloning) &&
                          styles.renameModalButtonDisabled,
                      ]}
                      disabled={
                        !gitCheckoutRepoUrl.trim() ||
                        !normalizeCloneDirectoryName(gitCheckoutDirectoryName) ||
                        gitCheckoutCloning
                      }
                    >
                      <Text style={styles.renameModalButtonPrimaryText}>
                        {gitCheckoutCloning ? 'Cloning...' : 'Clone and use'}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            </KeyboardAvoidingView>
          </View>
        </Modal>

        <SelectionSheet
          visible={modelModalVisible}
          eyebrow="Model"
          title="Select model"
          subtitle={`Choose a ${activeChatEngineLabel} model for this chat or fall back to that engine's default.`}
          options={modelPickerOptions}
          loading={loadingModels}
          loadingLabel="Refreshing available models…"
          presentation="expanded"
          onClose={closeModelModal}
        />

        <SelectionSheet
          visible={effortModalVisible}
          eyebrow="Reasoning"
          title="Reasoning level"
          subtitle={
            effortPickerModel
              ? `Current model: ${formatModelOptionLabel(effortPickerModel)}`
              : 'Select how much reasoning depth to use.'
          }
          options={effortPickerSheetOptions}
          presentation="expanded"
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
                keyboardAppearance={theme.keyboardAppearance}
                placeholder="Chat name"
                placeholderTextColor={theme.colors.textMuted}
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
                keyboardAppearance={theme.keyboardAppearance}
                placeholder="apps/mobile/src/screens/MainScreen.tsx"
                placeholderTextColor={theme.colors.textMuted}
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
                        <Ionicons name="close" size={14} color={theme.colors.textMuted} />
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
                          keyboardAppearance={theme.keyboardAppearance}
                          placeholder={
                            question.isOther
                              ? 'Or enter a custom answer…'
                              : 'Type your answer…'
                          }
                          placeholderTextColor={theme.colors.textMuted}
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
  showEnginePicker,
  engineLabel,
  modelReasoningLabel,
  collaborationModeLabel,
  fastModeEnabled,
  fastModeLabel,
  keyboardVisible,
  bottomInset,
  onSuggestion,
  onOpenWorkspacePicker,
  onOpenEnginePicker,
  onOpenModelReasoningPicker,
  onOpenCollaborationModePicker,
  onToggleFastMode,
}: {
  startWorkspaceLabel: string;
  showEnginePicker: boolean;
  engineLabel: string;
  modelReasoningLabel: string;
  collaborationModeLabel: string;
  fastModeEnabled: boolean;
  fastModeLabel: string;
  keyboardVisible: boolean;
  bottomInset: number;
  onSuggestion: (s: string) => void;
  onOpenWorkspacePicker: () => void;
  onOpenEnginePicker: () => void;
  onOpenModelReasoningPicker: () => void;
  onOpenCollaborationModePicker: () => void;
  onToggleFastMode: () => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const contentContainerStyle =
    Platform.OS === 'android'
      ? [
          styles.composeContainer,
          keyboardVisible ? styles.composeContainerKeyboardOpen : null,
          { paddingBottom: bottomInset },
        ]
      : styles.composeContainer;

  return (
    <ScrollView
      style={styles.composeScroll}
      contentContainerStyle={contentContainerStyle}
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
          styles.workspacePathSelectBtn,
          pressed && styles.workspaceSelectBtnPressed,
        ]}
        onPress={onOpenWorkspacePicker}
      >
        <Ionicons name="folder-open-outline" size={16} color={theme.colors.textMuted} />
        <Text style={[styles.workspaceSelectLabel, styles.workspacePathSelectLabel]}>
          {startWorkspaceLabel}
        </Text>
        <Ionicons name="chevron-forward" size={14} color={theme.colors.textMuted} />
      </Pressable>
      {showEnginePicker ? (
        <Pressable
          style={({ pressed }) => [
            styles.workspaceSelectBtn,
            pressed && styles.workspaceSelectBtnPressed,
          ]}
          onPress={onOpenEnginePicker}
        >
          <Ionicons name="layers-outline" size={16} color={theme.colors.textMuted} />
          <Text style={styles.workspaceSelectLabel} numberOfLines={1}>
            {engineLabel}
          </Text>
          <Ionicons name="chevron-forward" size={14} color={theme.colors.textMuted} />
        </Pressable>
      ) : null}
      <Pressable
        style={({ pressed }) => [
          styles.workspaceSelectBtn,
          pressed && styles.workspaceSelectBtnPressed,
        ]}
        onPress={onOpenModelReasoningPicker}
      >
        <Ionicons name="sparkles-outline" size={16} color={theme.colors.textMuted} />
        <Text style={styles.workspaceSelectLabel} numberOfLines={1}>
          {modelReasoningLabel}
        </Text>
        <Ionicons name="chevron-forward" size={14} color={theme.colors.textMuted} />
      </Pressable>
      <Pressable
        style={({ pressed }) => [
          styles.workspaceSelectBtn,
          pressed && styles.workspaceSelectBtnPressed,
        ]}
        onPress={onOpenCollaborationModePicker}
      >
        <Ionicons name="map-outline" size={16} color={theme.colors.textMuted} />
        <Text style={styles.workspaceSelectLabel} numberOfLines={1}>
          {collaborationModeLabel}
        </Text>
        <Ionicons name="chevron-forward" size={14} color={theme.colors.textMuted} />
      </Pressable>
      <Pressable
        style={({ pressed }) => [
          styles.workspaceSelectBtn,
          pressed && styles.workspaceSelectBtnPressed,
        ]}
        onPress={onToggleFastMode}
      >
        <Ionicons name="flash-outline" size={16} color={theme.colors.textMuted} />
        <Text style={styles.workspaceSelectLabel} numberOfLines={1}>
          {fastModeLabel}
        </Text>
        <Ionicons
          name={fastModeEnabled ? 'checkmark-circle' : 'ellipse-outline'}
          size={14}
          color={theme.colors.textMuted}
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

interface AgentThreadPanelRow {
  chat: ChatSummary;
  title: string;
  description: string;
  runtime: AgentThreadDisplayState;
  selected: boolean;
}

interface ChatViewProps {
  chat: Chat;
  parentChat: Chat | null;
  bridgeUrl: string;
  bridgeToken: string | null;
  onOpenLocalPreview?: (targetUrl: string) => void;
  showToolCalls: boolean;
  agentThreadStatusById: ReadonlyMap<string, Chat['status']>;
  scrollRef: React.RefObject<FlatList<TranscriptDisplayItem> | null>;
  inlineChoicesEnabled: boolean;
  onInlineOptionSelect: (value: string) => void;
  onPinnedAutoScroll: (animated?: boolean) => void;
  onScrollInteractionStart: () => void;
  autoScrollStateRef: React.MutableRefObject<AutoScrollState>;
  bottomInset: number;
}

function AgentThreadsPanel({
  rows,
  runningCount,
  collapsed,
  onToggleCollapse,
  onSelectThread,
}: {
  rows: AgentThreadPanelRow[];
  runningCount: number;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSelectThread: (threadId: string) => void;
}) {
  const theme = useAppTheme();
  const { height: windowHeight } = useWindowDimensions();
  const styles = useMemo(() => createStyles(theme), [theme]);

  if (rows.length === 0) {
    return null;
  }

  return (
    <View style={styles.agentPanelCard}>
      <Pressable
        onPress={onToggleCollapse}
        style={({ pressed }) => [
          styles.agentPanelHeader,
          styles.agentPanelHeaderPressable,
          pressed && styles.agentPanelHeaderPressed,
        ]}
      >
        <View style={styles.agentPanelHeaderCopy}>
          <Text style={styles.agentPanelEyebrow}>Agents</Text>
          <Text style={styles.agentPanelSummary}>
            {runningCount === 1
              ? '1 running now'
              : `${String(runningCount)} running now`}
          </Text>
        </View>
        <Ionicons
          name={collapsed ? 'chevron-down' : 'chevron-up'}
          size={16}
          color={theme.colors.textMuted}
        />
      </Pressable>

      {!collapsed ? (
        <ScrollView
          style={[
            styles.agentPanelScroll,
            { maxHeight: Math.max(180, Math.floor(windowHeight * 0.5)) },
          ]}
          contentContainerStyle={styles.agentPanelList}
          showsVerticalScrollIndicator={false}
          nestedScrollEnabled
        >
          {rows.map((row) => (
            <Pressable
              key={row.chat.id}
              onPress={() => onSelectThread(row.chat.id)}
              style={({ pressed }) => [
                styles.agentPanelRow,
                { borderColor: row.runtime.statusBorderColor },
                row.selected && styles.agentPanelRowSelected,
                pressed && styles.agentPanelRowPressed,
              ]}
            >
              <View
                style={[
                  styles.agentPanelAccent,
                  { backgroundColor: row.runtime.accentColor },
                ]}
              />
              <View style={styles.agentPanelCopy}>
                <View style={styles.agentPanelTitleRow}>
                  <Text
                    style={[
                      styles.agentPanelTitle,
                      { color: row.runtime.accentColor },
                    ]}
                    numberOfLines={1}
                  >
                    {row.title}
                  </Text>
                  {row.selected ? (
                    <Text style={styles.agentPanelSelectedLabel}>Current</Text>
                  ) : null}
                </View>
                <Text style={styles.agentPanelDescription} numberOfLines={1}>
                  {row.description}
                </Text>
              </View>
              <View
                style={[
                  styles.agentPanelStatusBadge,
                  {
                    backgroundColor: row.runtime.statusSurfaceColor,
                    borderColor: row.runtime.statusBorderColor,
                  },
                ]}
              >
                <Ionicons
                  name={row.runtime.icon}
                  size={12}
                  color={row.runtime.statusColor}
                />
                <Text
                  style={[
                    styles.agentPanelStatusText,
                    { color: row.runtime.statusColor },
                  ]}
                  numberOfLines={1}
                >
                  {row.runtime.label}
                </Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

// ── Chat View ──────────────────────────────────────────────────────

const ChatView = memo(function ChatView({
  chat,
  parentChat,
  bridgeUrl,
  bridgeToken,
  onOpenLocalPreview,
  showToolCalls,
  agentThreadStatusById,
  scrollRef,
  inlineChoicesEnabled,
  onInlineOptionSelect,
  onPinnedAutoScroll,
  onScrollInteractionStart,
  autoScrollStateRef,
  bottomInset,
}: ChatViewProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const transcriptView = useMemo(() => {
    const childVisibleMessages = getVisibleTranscriptMessages(
      filterReasoningMessagesForEngine(chat.messages, chat.engine),
      showToolCalls
    );
    if (!chat.parentThreadId || !parentChat) {
      return {
        messages: childVisibleMessages,
        hiddenInheritedMessageCount: 0,
      };
    }

    const parentVisibleMessages = getVisibleTranscriptMessages(
      filterReasoningMessagesForEngine(parentChat.messages, parentChat.engine),
      showToolCalls
    );
    return trimInheritedParentMessages(parentVisibleMessages, childVisibleMessages, chat.id);
  }, [chat.messages, chat.parentThreadId, parentChat, showToolCalls]);
  const visibleMessages = useMemo(
    () => syncVisibleSubAgentStatuses(transcriptView.messages, agentThreadStatusById),
    [agentThreadStatusById, transcriptView.messages]
  );
  const [visibleStartIndex, setVisibleStartIndex] = useState(() =>
    getInitialVisibleMessageStartIndex(visibleMessages.length)
  );
  const paginatedMessages = useMemo(
    () => visibleMessages.slice(visibleStartIndex),
    [visibleMessages, visibleStartIndex]
  );
  const displayItems = useMemo(
    () => buildTranscriptDisplayItems(paginatedMessages),
    [paginatedMessages]
  );
  const displayMessages = useMemo(
    () => [...displayItems].reverse(),
    [displayItems]
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
      autoScrollStateRef.current.shouldStickToBottom = distanceFromBottom <= theme.spacing.xl * 2;
    },
    [autoScrollStateRef, theme.spacing.xl]
  );

  useEffect(() => {
    autoScrollStateRef.current.shouldStickToBottom = true;
    autoScrollStateRef.current.isUserInteracting = false;
    autoScrollStateRef.current.isMomentumScrolling = false;
  }, [autoScrollStateRef, chat.id]);
  const messageListContentStyle = useMemo(
    () =>
      Platform.OS === 'android'
        ? [styles.messageListContent, { paddingTop: bottomInset }]
        : [styles.messageListContent, { paddingBottom: bottomInset }],
    [bottomInset, styles.messageListContent]
  );
  const isLargeChat = displayItems.length >= LARGE_CHAT_MESSAGE_COUNT_THRESHOLD;
  const keyExtractor = useCallback(
    (item: TranscriptDisplayItem) => (item.kind === 'message' ? item.renderKey : item.id),
    []
  );
  const renderMessageItem = useCallback<ListRenderItem<TranscriptDisplayItem>>(
    ({ item }) => {
      if (item.kind === 'toolGroup') {
        return (
          <View style={styles.chatMessageBlock}>
            <ToolActivityGroup messages={item.messages} />
          </View>
        );
      }

      const msg = item.message;
      const showInlineChoices = inlineChoiceSet?.messageId === msg.id;
      return (
        <View style={styles.chatMessageBlock}>
          <ChatMessage
            message={msg}
            bridgeUrl={bridgeUrl}
            bridgeToken={bridgeToken}
            onOpenLocalPreview={onOpenLocalPreview}
          />
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
            color={theme.colors.textPrimary}
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
}, areChatViewPropsEqual);

function areChatViewPropsEqual(previous: ChatViewProps, next: ChatViewProps): boolean {
  return (
    previous.chat === next.chat &&
    previous.parentChat === next.parentChat &&
    previous.bridgeUrl === next.bridgeUrl &&
    previous.bridgeToken === next.bridgeToken &&
    previous.onOpenLocalPreview === next.onOpenLocalPreview &&
    previous.showToolCalls === next.showToolCalls &&
    previous.agentThreadStatusById === next.agentThreadStatusById &&
    previous.scrollRef === next.scrollRef &&
    previous.inlineChoicesEnabled === next.inlineChoicesEnabled &&
    previous.onInlineOptionSelect === next.onInlineOptionSelect &&
    previous.onPinnedAutoScroll === next.onPinnedAutoScroll &&
    previous.onScrollInteractionStart === next.onScrollInteractionStart &&
    previous.autoScrollStateRef === next.autoScrollStateRef &&
    previous.bottomInset === next.bottomInset
  );
}

function WorkflowCard({
  mode,
  plan,
  collapsed,
  scrollMaxHeight,
  actionDisabled,
  onToggleCollapse,
  onImplement,
  onStayInPlanMode,
}: {
  mode: 'plan' | 'approval' | 'execution';
  plan: ActivePlanState | null;
  collapsed: boolean;
  scrollMaxHeight: number;
  actionDisabled: boolean;
  onToggleCollapse: () => void;
  onImplement: () => void;
  onStayInPlanMode: () => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const workflowMarkdownStyles = useMemo(() => createWorkflowMarkdownStyles(theme), [theme]);
  const hasStructuredPlan = hasStructuredPlanCardContent(plan);
  const hasSteps = (plan?.steps.length ?? 0) > 0;
  const totalStepCount = plan?.steps.length ?? 0;
  const completedStepCount =
    plan?.steps.filter((step) => step.status === 'completed').length ?? 0;
  const inProgressStepCount =
    plan?.steps.filter((step) => step.status === 'inProgress').length ?? 0;
  const pendingStepCount =
    plan?.steps.filter((step) => step.status === 'pending').length ?? 0;
  const activeStep =
    plan?.steps.find((step) => step.status === 'inProgress') ??
    plan?.steps.find((step) => step.status === 'pending') ??
    (plan ? plan.steps[plan.steps.length - 1] ?? null : null) ??
    null;
  const collapsedSummaryRaw =
    mode === 'approval'
      ? activeStep?.step ??
        plan?.explanation?.trim() ??
        'Start coding now or keep refining the plan.'
      : mode === 'execution'
        ? activeStep?.step ??
          plan?.explanation?.trim() ??
          '(no execution details yet)'
        : activeStep?.step ?? plan?.explanation?.trim() ?? '(no steps provided)';
  const collapsedSummary = stripMarkdownInline(collapsedSummaryRaw)
    .replace(/\s*#{1,6}\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const isCollapsible = hasStructuredPlan || mode === 'approval';
  const title =
    mode === 'approval'
      ? PLAN_IMPLEMENTATION_TITLE
      : mode === 'execution'
        ? 'Execution'
        : 'Plan';
  const iconName =
    mode === 'approval'
      ? 'rocket-outline'
      : mode === 'execution'
        ? 'construct-outline'
        : 'map-outline';
  const planProgressSummary =
    totalStepCount > 0
      ? [
          `${String(completedStepCount)}/${String(totalStepCount)} done`,
          inProgressStepCount > 0 ? `${String(inProgressStepCount)} active` : null,
          pendingStepCount > 0 ? `${String(pendingStepCount)} pending` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : null;

  if (!hasStructuredPlan && mode !== 'approval') {
    return null;
  }

  const stepListContent = hasSteps ? (
    <View style={styles.planStepsList}>
      {plan?.steps.map((step, index) => (
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
          <View style={styles.planStepMarkdownWrap}>
            <Markdown
              style={workflowMarkdownStyles}
            >
              {step.step}
            </Markdown>
          </View>
        </View>
      ))}
    </View>
  ) : (
    <Text style={styles.planDeltaText}>(no steps provided)</Text>
  );

  const planSections = hasStructuredPlan ? (
    mode === 'execution' ? (
      <>
        <View style={styles.workflowSection}>
          <Text style={styles.workflowSectionEyebrow}>Plan summary</Text>
          {plan?.explanation ? (
            <Markdown style={workflowMarkdownStyles}>{plan.explanation}</Markdown>
          ) : activeStep ? (
            <Markdown style={workflowMarkdownStyles}>{activeStep.step}</Markdown>
          ) : null}
          {planProgressSummary ? (
            <Text style={styles.workflowMetaText}>{planProgressSummary}</Text>
          ) : null}
        </View>
        <View style={styles.workflowSection}>
          <Text style={styles.workflowSectionEyebrow}>Tasks</Text>
          {stepListContent}
        </View>
      </>
    ) : (
      <>
        {plan?.explanation ? (
          <Markdown style={workflowMarkdownStyles}>{plan.explanation}</Markdown>
        ) : null}
        {stepListContent}
      </>
    )
  ) : null;

  const header = isCollapsible ? (
    <Pressable
      style={({ pressed }) => [
        styles.planCardHeader,
        styles.planCardHeaderPressable,
        pressed && styles.modelChipPressed,
      ]}
      onPress={onToggleCollapse}
    >
      <Ionicons name={iconName} size={14} color={theme.colors.textPrimary} />
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
        color={theme.colors.textMuted}
      />
    </Pressable>
  ) : (
    <View style={styles.planCardHeader}>
      <Ionicons name={iconName} size={14} color={theme.colors.textPrimary} />
      <View style={styles.planCardHeaderText}>
        <Text style={styles.planCardTitle}>{title}</Text>
        <Text style={styles.planCardSummary} numberOfLines={2}>
          {collapsedSummary}
        </Text>
      </View>
    </View>
  );

  return (
    <View style={[styles.planCard, styles.planOverlayCard]}>
      {header}

      {collapsed && isCollapsible ? null : (
        <>
          {planSections ? (
            <ScrollView
              nestedScrollEnabled
              bounces={false}
              style={[styles.workflowScrollViewport, { maxHeight: scrollMaxHeight }]}
              contentContainerStyle={styles.workflowScrollContent}
              showsVerticalScrollIndicator
            >
              {planSections}
            </ScrollView>
          ) : null}

          {mode === 'approval' ? (
            <View style={styles.planPromptOptionsColumn}>
              <Pressable
                onPress={onImplement}
                disabled={actionDisabled}
                style={({ pressed }) => [
                  styles.planPromptOptionButton,
                  actionDisabled && styles.planPromptOptionButtonDisabled,
                  pressed && !actionDisabled && styles.planPromptOptionButtonPressed,
                ]}
              >
                <Text
                  style={[
                    styles.planPromptOptionTitle,
                    actionDisabled && styles.planPromptOptionTitleDisabled,
                  ]}
                >
                  {PLAN_IMPLEMENTATION_YES}
                </Text>
                <Text
                  style={[
                    styles.planPromptOptionDescription,
                    actionDisabled && styles.planPromptOptionDescriptionDisabled,
                  ]}
                >
                  Switch to Default mode and start coding.
                </Text>
              </Pressable>
              <Pressable
                onPress={onStayInPlanMode}
                disabled={actionDisabled}
                style={({ pressed }) => [
                  styles.planPromptOptionButton,
                  actionDisabled && styles.planPromptOptionButtonDisabled,
                  pressed && !actionDisabled && styles.planPromptOptionButtonPressed,
                ]}
              >
                <Text
                  style={[
                    styles.planPromptOptionTitle,
                    actionDisabled && styles.planPromptOptionTitleDisabled,
                  ]}
                >
                  {PLAN_IMPLEMENTATION_NO}
                </Text>
                <Text
                  style={[
                    styles.planPromptOptionDescription,
                    actionDisabled && styles.planPromptOptionDescriptionDisabled,
                  ]}
                >
                  Stay in Plan mode and keep refining the approach.
                </Text>
              </Pressable>
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

function QueuedMessageDock({
  queuedMessage,
  remainingQueuedMessagesCount,
  steerEnabled,
  cancelEnabled,
  steeringActive,
  steerDisabledReason,
  onCancelQueuedMessage,
  onSteerQueuedMessage,
}: {
  queuedMessage: QueuedChatMessage;
  remainingQueuedMessagesCount: number;
  steerEnabled: boolean;
  cancelEnabled: boolean;
  steeringActive: boolean;
  steerDisabledReason: string | null;
  onCancelQueuedMessage: (messageId: string) => void;
  onSteerQueuedMessage: () => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <View style={styles.queuedMessageDock}>
      <View style={[styles.planCard, styles.planOverlayCard, styles.queuedMessageCard]}>
        <View style={styles.queuedMessageHeader}>
          <View style={styles.queuedMessageHeaderText}>
            <Text style={styles.planCardTitle}>
              {steeringActive ? 'Steering message' : 'Queued message'}
            </Text>
            {remainingQueuedMessagesCount > 0 ? (
              <Text style={styles.queuedMessageSummary}>
                {`+${String(remainingQueuedMessagesCount)} more queued`}
              </Text>
            ) : null}
          </View>
          <View style={styles.queuedMessageActions}>
            <Pressable
              onPress={() => onCancelQueuedMessage(queuedMessage.id)}
              disabled={!cancelEnabled}
              style={({ pressed }) => [
                styles.queuedMessageActionButton,
                styles.queuedMessageActionButtonDestructive,
                !cancelEnabled && styles.queuedMessageActionButtonDisabled,
                pressed && cancelEnabled && styles.queuedMessageActionButtonPressed,
              ]}
            >
              <Text
                style={[
                  styles.queuedMessageActionLabel,
                  styles.queuedMessageActionLabelDestructive,
                  !cancelEnabled && styles.queuedMessageActionLabelDisabled,
                ]}
              >
                Cancel
              </Text>
            </Pressable>
            <Pressable
              onPress={onSteerQueuedMessage}
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
                {steeringActive ? 'Steering…' : 'Steer'}
              </Text>
            </Pressable>
          </View>
        </View>
        <Text numberOfLines={3} style={styles.queuedMessageBody}>
          {queuedMessage.content}
        </Text>
        {steerDisabledReason ? (
          <Text style={styles.queuedMessageHint}>{steerDisabledReason}</Text>
        ) : null}
      </View>
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

function resolveCodexPlanTurnId(
  value: Record<string, unknown> | null,
  fallbackTurnId: string | null = null
): string {
  return (
    readString(value?.turnId) ??
    readString(value?.turn_id) ??
    fallbackTurnId ??
    'unknown-turn'
  );
}

function toCodexTurnPlanUpdate(
  value: Record<string, unknown> | null,
  threadId: string,
  fallbackTurnId: string | null = null
): {
  threadId: string;
  turnId: string;
  explanation: string | null;
  plan: TurnPlanStep[];
} | null {
  if (!value) {
    return null;
  }

  return toTurnPlanUpdate(
    {
      ...value,
      threadId,
      turnId: resolveCodexPlanTurnId(value, fallbackTurnId),
    },
    threadId
  );
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

function normalizeCloneDirectoryName(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') {
    return null;
  }
  if (/[\\/]/.test(trimmed)) {
    return null;
  }

  return trimmed;
}

function deriveCloneDirectoryName(url: string | null | undefined): string | null {
  if (typeof url !== 'string') {
    return null;
  }

  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return null;
  }

  const lastSlash = trimmed.lastIndexOf('/');
  const lastColon = trimmed.lastIndexOf(':');
  const splitIndex = Math.max(lastSlash, lastColon);
  const candidate = (splitIndex >= 0 ? trimmed.slice(splitIndex + 1) : trimmed).replace(
    /\.git$/i,
    ''
  );

  return normalizeCloneDirectoryName(candidate);
}

function joinWorkspacePath(parentPath: string, child: string): string {
  const separator =
    parentPath.includes('\\') && !parentPath.includes('/') ? '\\' : '/';
  if (parentPath.endsWith('/') || parentPath.endsWith('\\')) {
    return `${parentPath}${child}`;
  }
  return `${parentPath}${separator}${child}`;
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

function countUserMessages(messages: ChatTranscriptMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.role === 'user') {
      count += 1;
    }
  }
  return count;
}

function normalizeChatMessageMatchContent(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

function reconcileChatWithPendingOptimisticMessages(
  chat: Chat,
  pendingMessages: PendingOptimisticUserMessage[]
): {
  chat: Chat;
  remainingPendingMessages: PendingOptimisticUserMessage[];
} {
  if (pendingMessages.length === 0) {
    return {
      chat,
      remainingPendingMessages: [],
    };
  }

  const userMessages = chat.messages.filter((message) => message.role === 'user');
  const remainingPendingMessages = pendingMessages.filter((entry) => {
    const matchedUserMessage = userMessages[entry.userOrdinal - 1];
    if (!matchedUserMessage) {
      return true;
    }

    return (
      normalizeChatMessageMatchContent(matchedUserMessage.content) !==
      normalizeChatMessageMatchContent(entry.message.content)
    );
  });

  if (remainingPendingMessages.length === 0) {
    return {
      chat,
      remainingPendingMessages,
    };
  }

  const lastPendingMessage = remainingPendingMessages[remainingPendingMessages.length - 1]?.message;
  return {
    chat: {
      ...chat,
      lastMessagePreview:
        normalizeChatMessageMatchContent(lastPendingMessage?.content ?? '').slice(0, 120) ||
        chat.lastMessagePreview,
      messages: [
        ...chat.messages,
        ...remainingPendingMessages.map((entry) => entry.message),
      ],
    },
    remainingPendingMessages,
  };
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

function resolveSelectedServiceTier(
  selectedServiceTier: SelectedServiceTier,
  defaultServiceTier: ServiceTier | null | undefined
): ServiceTier | null {
  if (selectedServiceTier !== undefined) {
    return toFastModeServiceTier(selectedServiceTier);
  }

  return toFastModeServiceTier(defaultServiceTier);
}

function resolveSteerTargetTurnId(
  activeTurnId: string | null | undefined,
  snapshotActiveTurnId: string | null | undefined
): string | null {
  const normalizedActiveTurnId = activeTurnId?.trim() ?? '';
  if (normalizedActiveTurnId) {
    return normalizedActiveTurnId;
  }

  const normalizedSnapshotTurnId = snapshotActiveTurnId?.trim() ?? '';
  return normalizedSnapshotTurnId || null;
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

function getChatDraftsPath(): string | null {
  const base = FileSystem.documentDirectory;
  if (typeof base !== 'string' || base.trim().length === 0) {
    return null;
  }

  return `${base}${CHAT_DRAFTS_FILE}`;
}

function getChatPlanSnapshotsPath(): string | null {
  const base = FileSystem.documentDirectory;
  if (typeof base !== 'string' || base.trim().length === 0) {
    return null;
  }

  return `${base}${CHAT_PLAN_SNAPSHOTS_FILE}`;
}

function parseChatDrafts(raw: string): Record<string, string> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    const parsedRecord = toRecord(parsed);
    if (!parsedRecord || parsedRecord.version !== CHAT_DRAFTS_VERSION) {
      return {};
    }

    const entries = toRecord(parsedRecord.entries);
    if (!entries) {
      return {};
    }

    const result: Record<string, string> = {};
    for (const [rawKey, value] of Object.entries(entries)) {
      const normalizedKey = getDraftScopeKey(rawKey);
      const text = readString(value)?.replace(/\r\n/g, '\n');
      if (!text || text.length === 0) {
        continue;
      }
      result[normalizedKey] = text;
    }

    return result;
  } catch {
    return {};
  }
}

function getDraftScopeKey(threadId: string | null | undefined): string {
  const normalized = threadId?.trim();
  return normalized && normalized.length > 0 ? normalized : CHAT_NEW_DRAFT_KEY;
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

  const hasActivePlanSnapshot =
    Boolean(snapshot.plan) &&
    (Boolean(snapshot.activeTurnId) || snapshot.activity?.title === 'Planning');
  return snapshot.pendingUserInputRequest || hasActivePlanSnapshot ? 'plan' : 'default';
}

function resolveDisplayedThreadPlan(
  snapshotPlan: ActivePlanState | null,
  persistedPlan: ActivePlanState | null,
  snapshot: ThreadRuntimeSnapshot | null | undefined
): ActivePlanState | null {
  if (!persistedPlan) {
    return snapshotPlan;
  }

  if (!snapshotPlan) {
    return persistedPlan;
  }

  if (snapshotPlan.turnId === persistedPlan.turnId) {
    return {
      ...snapshotPlan,
      explanation: snapshotPlan.explanation ?? persistedPlan.explanation,
      steps: snapshotPlan.steps.length > 0 ? snapshotPlan.steps : persistedPlan.steps,
      updatedAt:
        snapshotPlan.updatedAt > persistedPlan.updatedAt
          ? snapshotPlan.updatedAt
          : persistedPlan.updatedAt,
    };
  }

  const hasActivePlanningSnapshot =
    Boolean(snapshot?.activeTurnId) || snapshot?.activity?.title === 'Planning';
  return hasActivePlanningSnapshot ? snapshotPlan : persistedPlan;
}

function toPersistedActivePlanState(
  plan: Chat['latestPlan'],
  fallbackUpdatedAt: string | null | undefined
): ActivePlanState | null {
  if (!plan) {
    return null;
  }

  return {
    threadId: plan.threadId,
    turnId: plan.turnId,
    explanation: plan.explanation,
    steps: plan.steps,
    deltaText: '',
    updatedAt: fallbackUpdatedAt ?? new Date(0).toISOString(),
  };
}

function resolveUndismissedPlanImplementationPrompt(
  prompt: PendingPlanImplementationPrompt | null | undefined,
  dismissedTurnId: string | null | undefined
): PendingPlanImplementationPrompt | null {
  if (!prompt) {
    return null;
  }

  return dismissedTurnId && dismissedTurnId === prompt.turnId ? null : prompt;
}

function resolvePersistedPlanImplementationPrompt(
  chat: Chat | null | undefined,
  dismissedTurnId: string | null | undefined
): PendingPlanImplementationPrompt | null {
  if (!chat?.latestTurnPlan) {
    return null;
  }

  if (dismissedTurnId && dismissedTurnId === chat.latestTurnPlan.turnId) {
    return null;
  }

  return isCompletedPlanTurnStatus(chat.latestTurnStatus)
    ? {
        threadId: chat.id,
        turnId: chat.latestTurnPlan.turnId,
      }
    : null;
}

function normalizePlanTurnStatus(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized.length > 0 ? normalized : null;
}

function isCompletedPlanTurnStatus(value: string | null | undefined): boolean {
  const normalized = normalizePlanTurnStatus(value);
  return (
    normalized === 'completed' ||
    normalized === 'complete' ||
    normalized === 'success' ||
    normalized === 'succeeded'
  );
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
  if (chat.latestTurnPlan) {
    return true;
  }

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

function formatAgentThreadOptionTitle(
  chat: ChatSummary,
  rootThreadId: string | null,
  ordinal: number | null
): string {
  const trimmedTitle = chat.title.trim();
  if (rootThreadId && chat.id === rootThreadId) {
    return trimmedTitle || 'Main thread';
  }
  const nickname = chat.agentNickname?.trim();
  if (nickname) {
    return nickname;
  }
  if (ordinal !== null) {
    return `Sub-agent ${String(ordinal)}`;
  }
  return 'Sub-agent';
}

function iconForAgentThread(
  chat: ChatSummary,
  rootThreadId: string | null
): ComponentProps<typeof Ionicons>['name'] {
  if (rootThreadId && chat.id === rootThreadId) {
    return 'chatbubble-ellipses-outline';
  }

  switch (chat.sourceKind) {
    case 'subAgentReview':
      return 'shield-checkmark-outline';
    case 'subAgentCompact':
      return 'layers-outline';
    default:
      return chat.status === 'running' ? 'sparkles-outline' : 'git-branch-outline';
  }
}

function stripMarkdownInline(value: string): string {
  return value
    .replace(/(^|\n)\s{0,3}#{1,6}\s*/g, '$1')
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

function formatLiveReasoningMessage(text: string): string {
  const normalized = text.trim();
  if (!normalized) {
    return '• Reasoning';
  }

  const lines = normalized
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return '• Reasoning';
  }

  const [first, ...rest] = lines;
  return ['• Reasoning', `  └ ${first}`, ...rest.map((line) => `    ${line}`)].join('\n');
}

function filterReasoningMessagesForEngine(
  messages: ChatTranscriptMessage[],
  engine: Chat['engine'] | undefined
): ChatTranscriptMessage[] {
  if (engine !== 'codex') {
    return messages;
  }

  return messages.filter((message) => message.systemKind !== 'reasoning');
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
  const threadSourceRecord = toRecord(threadRecord?.source);
  const turnRecord = toRecord(params?.turn) ?? toRecord(msg?.turn);
  const sourceRecord = toRecord(params?.source) ?? toRecord(msg?.source);
  const subagentThreadSpawnRecord = toRecord(
    toRecord(sourceRecord?.subagent ?? sourceRecord?.subAgent)?.thread_spawn
  );
  const threadSubagentThreadSpawnRecord = toRecord(
    toRecord(threadSourceRecord?.subagent ?? threadSourceRecord?.subAgent)?.thread_spawn
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
    readString(subagentThreadSpawnRecord?.parentThreadId) ??
    readString(threadSourceRecord?.parent_thread_id) ??
    readString(threadSourceRecord?.parentThreadId) ??
    readString(threadSubagentThreadSpawnRecord?.parent_thread_id) ??
    readString(threadSubagentThreadSpawnRecord?.parentThreadId) ??
    null
  );
}

function extractNotificationParentThreadId(
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
  const threadSourceRecord = toRecord(threadRecord?.source);
  const sourceRecord = toRecord(params?.source) ?? toRecord(msg?.source);
  const subagentThreadSpawnRecord = toRecord(
    toRecord(sourceRecord?.subagent ?? sourceRecord?.subAgent)?.thread_spawn
  );
  const threadSubagentThreadSpawnRecord = toRecord(
    toRecord(threadSourceRecord?.subagent ?? threadSourceRecord?.subAgent)?.thread_spawn
  );

  return (
    readString(sourceRecord?.parent_thread_id) ??
    readString(sourceRecord?.parentThreadId) ??
    readString(subagentThreadSpawnRecord?.parent_thread_id) ??
    readString(subagentThreadSpawnRecord?.parentThreadId) ??
    readString(threadSourceRecord?.parent_thread_id) ??
    readString(threadSourceRecord?.parentThreadId) ??
    readString(threadSubagentThreadSpawnRecord?.parent_thread_id) ??
    readString(threadSubagentThreadSpawnRecord?.parentThreadId) ??
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

const createWorkflowMarkdownStyles = (theme: AppTheme) => StyleSheet.create({
  body: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
  },
  paragraph: {
    ...theme.typography.body,
    color: theme.colors.textSecondary,
    marginTop: 0,
    marginBottom: theme.spacing.xs,
  },
  heading1: {
    ...theme.typography.headline,
    color: theme.colors.textPrimary,
    fontSize: 18,
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  },
  heading2: {
    ...theme.typography.headline,
    color: theme.colors.textPrimary,
    fontSize: 16,
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  },
  heading3: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '700',
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs / 2,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  heading4: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '700',
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs / 2,
  },
  heading5: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '700',
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs / 2,
  },
  heading6: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '700',
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs / 2,
  },
  bullet_list: {
    marginTop: 0,
    marginBottom: theme.spacing.xs,
  },
  ordered_list: {
    marginTop: 0,
    marginBottom: theme.spacing.xs,
  },
  list_item: {
    marginTop: 0,
    marginBottom: theme.spacing.xs / 2,
  },
  strong: {
    color: theme.colors.textPrimary,
    fontWeight: '700',
  },
  em: {
    color: theme.colors.textSecondary,
    fontStyle: 'italic',
  },
  code_inline: {
    ...theme.typography.mono,
    backgroundColor: theme.colors.inlineCodeBg,
    color: theme.colors.inlineCodeText,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.inlineCodeBorder,
    borderRadius: theme.radius.sm,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  code_block: {
    ...theme.typography.mono,
    backgroundColor: theme.colors.bgInput,
    color: theme.colors.textPrimary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderHighlight,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.md,
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  },
  fence: {
    ...theme.typography.mono,
    backgroundColor: theme.colors.bgInput,
    color: theme.colors.textPrimary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderHighlight,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.md,
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  },
  blockquote: {
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.borderHighlight,
    paddingLeft: theme.spacing.sm,
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  },
  link: {
    color: theme.colors.accent,
    textDecorationLine: 'underline',
  },
});

const createStyles = (theme: AppTheme) => {
  const agentPanelShadow = theme.isDark
    ? '0 12px 30px rgba(0, 0, 0, 0.22)'
    : '0 12px 24px rgba(15, 23, 42, 0.12)';

  return StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bgMain,
  },

  bodyContainer: {
    flex: 1,
    position: 'relative',
  },
  keyboardAvoiding: {
    flex: 1,
  },
  composerContainer: {
    backgroundColor: theme.colors.bgMain,
  },
  composerContainerOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 4,
  },
  composerContainerResting: {
    marginBottom: 0,
  },
  queuedMessageDock: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.xs,
    paddingBottom: theme.spacing.xs / 2,
  },
  activityDock: {
    backgroundColor: theme.colors.bgMain,
    paddingTop: theme.spacing.xs,
    paddingBottom: theme.spacing.xs / 2,
    zIndex: 3,
  },
  sessionMetaRow: {
    backgroundColor: theme.colors.bgMain,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderLight,
    paddingVertical: theme.spacing.sm,
  },
  sessionMetaRowContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
  },
  topCardsRow: {
    backgroundColor: theme.colors.bgMain,
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.sm,
    gap: theme.spacing.sm,
    zIndex: 2,
  },
  agentPanelWrap: {
    backgroundColor: theme.colors.bgMain,
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.sm,
  },
  agentPanelCard: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgElevated,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    gap: theme.spacing.sm,
    boxShadow: agentPanelShadow,
  },
  agentPanelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  agentPanelHeaderPressable: {
    borderRadius: theme.radius.md,
  },
  agentPanelHeaderPressed: {
    opacity: 0.84,
  },
  agentPanelHeaderCopy: {
    flex: 1,
    gap: 2,
  },
  agentPanelEyebrow: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  agentPanelSummary: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
  },
  agentPanelList: {
    gap: theme.spacing.sm,
  },
  agentPanelScroll: {
    flexGrow: 0,
  },
  agentPanelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    paddingHorizontal: theme.spacing.sm + 2,
    paddingVertical: theme.spacing.sm + 2,
  },
  agentPanelRowSelected: {
    borderColor: theme.colors.borderHighlight,
    backgroundColor: theme.colors.bgInput,
  },
  agentPanelRowPressed: {
    opacity: 0.84,
  },
  agentPanelAccent: {
    width: 4,
    alignSelf: 'stretch',
    borderRadius: 999,
    flexShrink: 0,
  },
  agentPanelCopy: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  agentPanelTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  agentPanelTitle: {
    ...theme.typography.body,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
    flex: 1,
  },
  agentPanelSelectedLabel: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontWeight: '600',
  },
  agentPanelDescription: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontSize: 11,
    lineHeight: 15,
  },
  agentPanelStatusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 5,
    maxWidth: '42%',
    flexShrink: 0,
  },
  agentPanelStatusText: {
    ...theme.typography.caption,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '700',
  },
  contextChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgItem,
    paddingHorizontal: theme.spacing.sm,
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
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '600',
  },
  modelChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgItem,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 5,
    flexShrink: 0,
  },
  modeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgItem,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 5,
    flexShrink: 0,
  },
  fastChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgItem,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 5,
    flexShrink: 0,
  },
  fastChipEnabled: {
    borderColor: theme.colors.borderHighlight,
    backgroundColor: theme.colors.inlineCodeBg,
  },
  modelChipPressed: {
    opacity: 0.86,
  },
  sessionMetaChipDisabled: {
    opacity: 0.5,
  },
  modelChipText: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
  },
  fastChipTextEnabled: {
    color: theme.colors.textPrimary,
  },
  planCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    borderRadius: 12,
    backgroundColor: theme.colors.bgItem,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.sm,
  },
  planOverlayCard: {
    marginBottom: 0,
    boxShadow: '0px 4px 10px rgba(0, 0, 0, 0.16)',
  },
  queuedMessageCard: {
    marginBottom: 0,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: 10,
  },
  queuedMessageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.xs / 2,
  },
  queuedMessageHeaderText: {
    flex: 1,
    gap: 2,
  },
  queuedMessageActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  queuedMessageSummary: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
  },
  queuedMessageBody: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    lineHeight: 18,
  },
  queuedMessageHint: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    marginTop: theme.spacing.xs,
  },
  workflowSection: {
    marginTop: theme.spacing.md,
    gap: theme.spacing.xs,
  },
  workflowSectionEyebrow: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  workflowScrollViewport: {
    marginTop: theme.spacing.xs,
  },
  workflowScrollContent: {
    paddingBottom: theme.spacing.xs,
  },
  workflowSummaryText: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    lineHeight: 18,
  },
  workflowMetaText: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
  },
  queuedMessageActionButton: {
    flexShrink: 0,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderHighlight,
    backgroundColor: theme.colors.inlineCodeBg,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 5,
  },
  queuedMessageActionButtonDestructive: {
    borderColor: theme.colors.error,
    backgroundColor: theme.colors.errorBg,
  },
  queuedMessageActionButtonDisabled: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgMain,
  },
  queuedMessageActionButtonPressed: {
    opacity: 0.88,
  },
  queuedMessageActionLabel: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '700',
  },
  queuedMessageActionLabelDestructive: {
    color: theme.colors.error,
  },
  queuedMessageActionLabelDisabled: {
    color: theme.colors.textMuted,
  },
  planCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  },
  planCardHeaderPressable: {
    marginBottom: 0,
  },
  planCardHeaderText: {
    flex: 1,
    gap: 2,
  },
  planCardTitle: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '700',
  },
  planCardSummary: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
  },
  planExplanationText: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    fontStyle: 'italic',
    marginTop: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  planStepsList: {
    gap: theme.spacing.xs,
  },
  planStepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.sm,
  },
  planStepMarkdownWrap: {
    flex: 1,
    minWidth: 0,
  },
  planStepStatus: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    marginTop: 1,
  },
  planStepStatusCompleted: {
    color: theme.colors.textMuted,
  },
  planStepStatusInProgress: {
    color: theme.colors.accent,
    fontWeight: '700',
  },
  planStepStatusPending: {
    color: theme.colors.textMuted,
  },
  planStepText: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    flex: 1,
  },
  planStepTextCompleted: {
    color: theme.colors.textMuted,
    textDecorationLine: 'line-through',
  },
  planStepTextInProgress: {
    color: theme.colors.textPrimary,
    fontWeight: '700',
  },
  planStepTextPending: {
    color: theme.colors.textPrimary,
  },
  planDeltaText: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    marginTop: theme.spacing.xs,
  },
  renameModalBackdrop: {
    flex: 1,
    backgroundColor: theme.colors.overlayBackdrop,
    paddingHorizontal: theme.spacing.lg,
  },
  renameModalKeyboardAvoider: {
    flex: 1,
  },
  renameModalKeyboardContent: {
    flex: 1,
    justifyContent: 'center',
  },
  workspaceModalLoading: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
  },
  slashSuggestions: {
    marginHorizontal: theme.spacing.lg,
    marginBottom: theme.spacing.xs,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    overflow: 'hidden',
  },
  slashSuggestionsContent: {
    paddingVertical: 0,
  },
  slashSuggestionItem: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderLight,
  },
  slashSuggestionItemLast: {
    borderBottomWidth: 0,
  },
  slashSuggestionItemPressed: {
    backgroundColor: theme.colors.bgInput,
  },
  slashSuggestionTitle: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
    fontWeight: '600',
  },
  slashSuggestionSummary: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    marginTop: 2,
  },
  renameModalCard: {
    backgroundColor: theme.colors.bgItem,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
  },
  renameModalTitle: {
    ...theme.typography.headline,
    color: theme.colors.textPrimary,
  },
  attachmentModalHint: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
  },
  attachmentSuggestionsList: {
    maxHeight: 170,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    borderRadius: 10,
    backgroundColor: theme.colors.bgMain,
  },
  attachmentSuggestionsListContent: {
    paddingVertical: 0,
  },
  attachmentSuggestionItem: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderLight,
  },
  attachmentSuggestionItemLast: {
    borderBottomWidth: 0,
  },
  attachmentSuggestionItemPressed: {
    backgroundColor: theme.colors.bgInput,
  },
  attachmentSuggestionText: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
  },
  renameModalInput: {
    color: theme.colors.textPrimary,
    backgroundColor: theme.colors.bgInput,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 10,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    fontSize: 15,
  },
  gitCheckoutHint: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    lineHeight: 18,
  },
  gitCheckoutPathButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 10,
    backgroundColor: theme.colors.bgMain,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  gitCheckoutPathButtonPressed: {
    opacity: 0.85,
  },
  gitCheckoutPathCopy: {
    flex: 1,
    gap: 2,
  },
  gitCheckoutPathLabel: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
  },
  gitCheckoutPathValue: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '600',
  },
  gitCheckoutSummary: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
  },
  gitCheckoutErrorText: {
    ...theme.typography.caption,
    color: theme.colors.error,
  },
  attachmentListColumn: {
    gap: theme.spacing.xs,
    maxHeight: 180,
  },
  attachmentListRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    borderRadius: 8,
    backgroundColor: theme.colors.bgMain,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  attachmentListPath: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    flex: 1,
  },
  attachmentRemoveButton: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgItem,
  },
  attachmentRemoveButtonPressed: {
    opacity: 0.8,
  },
  renameModalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.spacing.sm,
  },
  renameModalButton: {
    borderRadius: 10,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    borderWidth: 1,
  },
  renameModalButtonSecondary: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgMain,
  },
  renameModalButtonSecondaryText: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
  },
  renameModalButtonPrimary: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accent,
  },
  renameModalButtonPrimaryPressed: {
    backgroundColor: theme.colors.accentPressed,
    borderColor: theme.colors.accentPressed,
  },
  renameModalButtonDisabled: {
    opacity: 0.45,
  },
  renameModalButtonPressed: {
    opacity: 0.8,
  },
  renameModalButtonPrimaryText: {
    ...theme.typography.body,
    color: theme.colors.accentText,
    fontWeight: '600',
  },
  userInputModalBackdrop: {
    flex: 1,
    backgroundColor: theme.colors.overlayBackdrop,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
  },
  userInputModalCard: {
    backgroundColor: theme.colors.bgItem,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.borderHighlight,
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
    maxHeight: '80%',
  },
  planPromptModalCard: {
    backgroundColor: theme.colors.bgItem,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.borderHighlight,
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
  },
  userInputModalTitle: {
    ...theme.typography.headline,
    color: theme.colors.textPrimary,
  },
  planPromptOptionsColumn: {
    gap: theme.spacing.sm,
  },
  planPromptOptionButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgMain,
    borderRadius: 10,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    gap: theme.spacing.xs,
  },
  planPromptOptionButtonPressed: {
    opacity: 0.88,
  },
  planPromptOptionButtonDisabled: {
    opacity: 0.45,
  },
  planPromptOptionTitle: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
    fontWeight: '600',
  },
  planPromptOptionTitleDisabled: {
    color: theme.colors.textMuted,
  },
  planPromptOptionDescription: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
  },
  planPromptOptionDescriptionDisabled: {
    color: theme.colors.textMuted,
  },
  userInputQuestionsList: {
    maxHeight: 380,
  },
  userInputQuestionsListContent: {
    gap: theme.spacing.md,
  },
  userInputQuestionCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    borderRadius: 10,
    backgroundColor: theme.colors.bgMain,
    padding: theme.spacing.sm,
    gap: theme.spacing.xs,
  },
  userInputQuestionHeader: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '700',
  },
  userInputQuestionText: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
  },
  userInputOptionsColumn: {
    gap: theme.spacing.xs,
    marginTop: theme.spacing.xs,
  },
  userInputOptionButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgItem,
    borderRadius: 10,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    gap: 2,
  },
  userInputOptionButtonSelected: {
    borderColor: theme.colors.borderHighlight,
    backgroundColor: theme.colors.bgInput,
  },
  userInputOptionButtonPressed: {
    opacity: 0.85,
  },
  userInputOptionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  userInputOptionIndex: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontWeight: '700',
    minWidth: 18,
  },
  userInputOptionLabel: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    flex: 1,
    fontWeight: '600',
  },
  userInputOptionDescription: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
  },
  userInputAnswerInput: {
    color: theme.colors.textPrimary,
    backgroundColor: theme.colors.bgInput,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 8,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    minHeight: 42,
    textAlignVertical: 'top',
  },
  userInputAnswerInputSecret: {
    textAlignVertical: 'center',
  },
  userInputErrorText: {
    ...theme.typography.caption,
    color: theme.colors.error,
  },
  userInputSubmitButton: {
    borderWidth: 1,
    borderColor: theme.colors.borderHighlight,
    backgroundColor: theme.colors.bgInput,
    borderRadius: 10,
    paddingVertical: theme.spacing.sm,
    alignItems: 'center',
  },
  userInputSubmitButtonPressed: {
    opacity: 0.88,
  },
  userInputSubmitButtonDisabled: {
    opacity: 0.45,
  },
  userInputSubmitButtonText: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
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
    paddingHorizontal: theme.spacing.xl,
    paddingBottom: theme.spacing.xxl * 2,
  },
  composeContainerKeyboardOpen: {
    justifyContent: 'flex-start',
    paddingTop: theme.spacing.xl,
    paddingBottom: theme.spacing.xl,
  },
  composeIcon: {
    marginBottom: theme.spacing.lg,
  },
  composeTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.xs,
  },
  composeSubtitle: {
    ...theme.typography.body,
    color: theme.colors.textMuted,
    marginBottom: theme.spacing.lg,
  },
  workspaceSelectBtn: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    marginBottom: theme.spacing.xl * 2,
  },
  workspacePathSelectBtn: {
    alignItems: 'flex-start',
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.md,
  },
  workspaceSelectBtnPressed: {
    opacity: 0.85,
  },
  workspaceSelectLabel: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    flex: 1,
  },
  workspacePathSelectLabel: {
    flexShrink: 1,
    lineHeight: 18,
  },
  suggestions: {
    flexDirection: 'row',
    gap: theme.spacing.md,
    width: '100%',
  },
  suggestionCard: {
    flex: 1,
    backgroundColor: theme.colors.bgItem,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 12,
    padding: theme.spacing.md,
  },
  suggestionCardPressed: {
    backgroundColor: theme.colors.bgInput,
  },
  suggestionText: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
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
    padding: theme.spacing.lg,
    paddingTop: theme.spacing.lg,
    paddingBottom: theme.spacing.xl,
    gap: theme.spacing.xl,
  },
  chatMessageBlock: {
    gap: theme.spacing.sm,
  },
  messagePaginationWrap: {
    alignItems: 'flex-start',
    gap: theme.spacing.xs,
  },
  messagePaginationButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderHighlight,
    backgroundColor: theme.colors.bgItem,
    borderRadius: 999,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  messagePaginationButtonPressed: {
    backgroundColor: theme.colors.bgInput,
  },
  messagePaginationButtonText: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '600',
  },
  messagePaginationMeta: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    marginLeft: theme.spacing.xs,
  },
  inlineChoiceOptions: {
    marginLeft: theme.spacing.sm,
    gap: theme.spacing.xs,
  },
  inlineChoiceOptionButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgItem,
    borderRadius: 10,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    gap: 2,
  },
  inlineChoiceOptionButtonPressed: {
    backgroundColor: theme.colors.bgInput,
    borderColor: theme.colors.borderHighlight,
  },
  inlineChoiceOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  inlineChoiceOptionIndex: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontWeight: '700',
    minWidth: 18,
  },
  inlineChoiceOptionLabel: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '600',
    flex: 1,
  },
  inlineChoiceOptionDescription: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
  },
  inlineChoiceHint: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    marginTop: 2,
    marginLeft: theme.spacing.xs,
  },
  chatLoadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.xl,
  },
  chatLoadingText: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
  },

  // Streaming thinking text
  streamingText: {
    ...theme.typography.body,
    fontStyle: 'italic',
    color: theme.colors.textMuted,
    lineHeight: 20,
  },

  // Error
  errorText: {
    ...theme.typography.caption,
    color: theme.colors.error,
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.xs,
  },
});
};
