export class Logger {
  info(message: string, meta?: unknown): void {
    this.write('INFO', message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.write('WARN', message, meta);
  }

  error(message: string, meta?: unknown): void {
    this.write('ERROR', message, meta);
  }

  private write(level: 'INFO' | 'WARN' | 'ERROR', message: string, meta?: unknown): void {
    const timestamp = new Date().toISOString();
    if (meta === undefined) {
      console.log(`[${timestamp}] [telegram-bot] [${level}] ${message}`);
      return;
    }

    console.log(`[${timestamp}] [telegram-bot] [${level}] ${message}`, meta);
  }
}
