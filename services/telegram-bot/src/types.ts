export interface BridgeRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export interface BridgeNotification {
  method: string;
  params?: unknown;
  eventId?: number;
}

export interface BridgeRpcResponse {
  id?: number | string | null;
  result?: unknown;
  error?: BridgeRpcErrorPayload;
  method?: string;
  params?: unknown;
  eventId?: number;
}

export interface BridgeStartThreadResponse {
  thread?: {
    id?: string;
  };
}

export interface BridgeResumeThreadResponse {
  thread?: {
    id?: string;
  };
}

export interface BridgeTurnStartResponse {
  turn?: {
    id?: string;
  };
}

export interface BridgeReadThreadResponse {
  thread?: unknown;
}

export interface PendingApproval {
  id: string;
  kind: 'commandExecution' | 'fileChange' | string;
  threadId: string;
  turnId: string;
  itemId: string;
  requestedAt: string;
  reason?: string;
  command?: string;
  cwd?: string;
  grantRoot?: string;
  proposedExecpolicyAmendment?: string[];
}

export interface PendingUserInputQuestionOption {
  label: string;
  description: string;
}

export interface PendingUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: PendingUserInputQuestionOption[] | null;
}

export interface PendingUserInputRequest {
  id: string;
  threadId: string;
  turnId: string;
  itemId: string;
  requestedAt: string;
  questions: PendingUserInputQuestion[];
}

export type ApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel';

export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number;
  };
}

export interface TelegramWebAppInfo {
  url: string;
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data?: string;
  web_app?: TelegramWebAppInfo;
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

export interface TelegramBotCommand {
  command: string;
  description: string;
}

export interface TurnRuntimeState {
  chatId: string;
  threadId: string;
  turnId: string;
  messageId: number;
  streamText: string;
  lastSentText: string;
  lastFlushAt: number;
  flushTimer: NodeJS.Timeout | null;
}

export interface PersistentState {
  version: 1;
  chats: Record<
    string,
    {
      threadId: string;
      updatedAt: string;
    }
  >;
}

export interface UserInputAnswerPayload {
  answers: string[];
}
