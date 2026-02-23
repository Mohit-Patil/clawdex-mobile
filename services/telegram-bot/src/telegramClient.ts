import type { Logger } from './logger';
import type {
  TelegramApiResponse,
  TelegramBotCommand,
  TelegramInlineKeyboardMarkup,
  TelegramMessage,
  TelegramUpdate,
} from './types';

interface TelegramClientOptions {
  apiBaseUrl: string;
  botToken: string;
  logger: Logger;
}

interface GetUpdatesOptions {
  offset?: number;
  timeoutSec: number;
  limit: number;
}

interface SendMessageOptions {
  chatId: string;
  text: string;
  replyMarkup?: TelegramInlineKeyboardMarkup;
}

interface EditMessageOptions {
  chatId: string;
  messageId: number;
  text: string;
  replyMarkup?: TelegramInlineKeyboardMarkup;
}

interface AnswerCallbackOptions {
  callbackQueryId: string;
  text?: string;
  showAlert?: boolean;
}

interface ChatMenuButtonOptions {
  text: string;
  webAppUrl: string;
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly retryAfterSec?: number
  ) {
    super(message);
  }
}

export class TelegramClient {
  private readonly baseUrl: string;

  constructor(private readonly options: TelegramClientOptions) {
    this.baseUrl = `${options.apiBaseUrl}/bot${options.botToken}`;
  }

  async getUpdates(options: GetUpdatesOptions): Promise<TelegramUpdate[]> {
    return await this.call<TelegramUpdate[]>('getUpdates', {
      offset: options.offset,
      timeout: options.timeoutSec,
      limit: options.limit,
      allowed_updates: ['message', 'callback_query'],
    });
  }

  async sendMessage(options: SendMessageOptions): Promise<TelegramMessage> {
    return await this.call<TelegramMessage>('sendMessage', {
      chat_id: options.chatId,
      text: options.text,
      reply_markup: options.replyMarkup,
      disable_web_page_preview: true,
    });
  }

  async editMessageText(options: EditMessageOptions): Promise<TelegramMessage> {
    return await this.call<TelegramMessage>('editMessageText', {
      chat_id: options.chatId,
      message_id: options.messageId,
      text: options.text,
      reply_markup: options.replyMarkup,
      disable_web_page_preview: true,
    });
  }

  async answerCallback(options: AnswerCallbackOptions): Promise<void> {
    await this.call<boolean>('answerCallbackQuery', {
      callback_query_id: options.callbackQueryId,
      text: options.text,
      show_alert: options.showAlert ?? false,
    });
  }

  async setMyCommands(commands: TelegramBotCommand[]): Promise<void> {
    await this.call<boolean>('setMyCommands', {
      commands,
    });
  }

  async setChatMenuButton(options: ChatMenuButtonOptions): Promise<void> {
    await this.call<boolean>('setChatMenuButton', {
      menu_button: {
        type: 'web_app',
        text: options.text,
        web_app: {
          url: options.webAppUrl,
        },
      },
    });
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const payload = (await response.json()) as TelegramApiResponse<T>;
    if (payload.ok) {
      return payload.result as T;
    }

    const message = payload.description ?? `Telegram API call failed: ${method}`;
    const retryAfterSec = payload.parameters?.retry_after;
    const error = new TelegramApiError(message, payload.error_code, retryAfterSec);

    if (error.code === 429 && retryAfterSec && retryAfterSec > 0) {
      this.options.logger.warn('Telegram rate limited request', {
        method,
        retryAfterSec,
      });
    }

    throw error;
  }
}
