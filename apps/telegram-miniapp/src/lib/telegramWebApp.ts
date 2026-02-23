export interface TelegramWebAppUser {
  id?: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramWebApp {
  ready: () => void;
  expand?: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  initDataUnsafe?: {
    user?: TelegramWebAppUser;
  };
}

interface TelegramWindow extends Window {
  Telegram?: {
    WebApp?: TelegramWebApp;
  };
}

export function initializeTelegramWebApp(): TelegramWebApp | null {
  const telegramWindow = window as TelegramWindow;
  const webApp = telegramWindow.Telegram?.WebApp ?? null;

  if (!webApp) {
    return null;
  }

  try {
    webApp.ready();
    webApp.expand?.();
    webApp.setHeaderColor?.('#101922');
    webApp.setBackgroundColor?.('#f6efe6');
  } catch {
    // Best effort; Mini App still works if host methods are unavailable.
  }

  return webApp;
}

export function formatTelegramUserLabel(user: TelegramWebAppUser | undefined): string | null {
  if (!user) {
    return null;
  }

  if (typeof user.username === 'string' && user.username.trim().length > 0) {
    return `@${user.username.trim()}`;
  }

  const parts = [user.first_name, user.last_name]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());

  if (parts.length > 0) {
    return parts.join(' ');
  }

  if (typeof user.id === 'number') {
    return `user ${String(user.id)}`;
  }

  return null;
}
