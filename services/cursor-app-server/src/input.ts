import { z } from 'zod';

const textInputSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const mentionInputSchema = z.object({
  type: z.literal('mention'),
  path: z.string(),
  name: z.string().optional(),
});

const localImageInputSchema = z.object({
  type: z.literal('localImage'),
  path: z.string(),
});

const unsupportedInputSchema = z.object({
  type: z.string(),
});

const turnParamsSchema = z.object({
  threadId: z.string().min(1),
  input: z.array(z.unknown()).min(1),
  model: z.string().optional().nullable(),
});

const threadStartParamsSchema = z.object({
  cwd: z.string().optional().nullable(),
  name: z.string().optional().nullable(),
  threadName: z.string().optional().nullable(),
  model: z.string().optional().nullable(),
});

const threadIdParamsSchema = z.object({
  threadId: z.string().min(1),
});

const listParamsSchema = z.object({
  cwd: z.string().optional().nullable(),
  limit: z.number().int().positive().max(1000).optional(),
  cursor: z.string().optional().nullable(),
});

export interface ParsedThreadStartParams {
  cwd: string | null;
  name: string | null;
  model: string | null;
}

export interface ParsedTurnStartParams {
  threadId: string;
  prompt: string;
  imagePaths: string[];
  model: string | null;
}

export interface ParsedThreadIdParams {
  threadId: string;
}

export interface ParsedListParams {
  cwd: string | null;
  limit?: number;
  cursor?: string;
}

export function parseThreadStartParams(value: unknown): ParsedThreadStartParams {
  const parsed = threadStartParamsSchema.parse(value ?? {});
  return {
    cwd: normalizeNullableString(parsed.cwd),
    name: normalizeNullableString(parsed.threadName) ?? normalizeNullableString(parsed.name),
    model: normalizeNullableString(parsed.model),
  };
}

export function parseTurnStartParams(value: unknown): ParsedTurnStartParams {
  const parsed = turnParamsSchema.parse(value ?? {});
  const input = turnInputToPromptAndImages(parsed.input);
  return {
    threadId: parsed.threadId.trim(),
    prompt: input.prompt,
    imagePaths: input.imagePaths,
    model: normalizeNullableString(parsed.model),
  };
}

export function parseThreadIdParams(value: unknown): ParsedThreadIdParams {
  const parsed = threadIdParamsSchema.parse(value ?? {});
  return {
    threadId: parsed.threadId.trim(),
  };
}

export function parseListParams(value: unknown): ParsedListParams {
  const parsed = listParamsSchema.parse(value ?? {});
  return {
    cwd: normalizeNullableString(parsed.cwd),
    limit: parsed.limit,
    cursor: normalizeNullableString(parsed.cursor) ?? undefined,
  };
}

function turnInputToPromptAndImages(input: unknown[]): { prompt: string; imagePaths: string[] } {
  const textParts: string[] = [];
  const mentions: string[] = [];
  const imagePaths: string[] = [];

  for (const entry of input) {
    const text = textInputSchema.safeParse(entry);
    if (text.success) {
      const value = text.data.text.trim();
      if (value) {
        textParts.push(value);
      }
      continue;
    }

    const mention = mentionInputSchema.safeParse(entry);
    if (mention.success) {
      const path = mention.data.path.trim();
      if (path) {
        mentions.push(mention.data.name ? `${mention.data.name}: ${path}` : path);
      }
      continue;
    }

    const localImage = localImageInputSchema.safeParse(entry);
    if (localImage.success) {
      const path = localImage.data.path.trim();
      if (path) {
        imagePaths.push(path);
      }
      continue;
    }

    const unsupported = unsupportedInputSchema.safeParse(entry);
    const type = unsupported.success ? unsupported.data.type : typeof entry;
    throw new Error(`unsupported Cursor turn input item: ${type}`);
  }

  if (textParts.length === 0 && mentions.length === 0 && imagePaths.length === 0) {
    throw new Error('turn/start requires non-empty text or mention input');
  }

  const prompt = [
    textParts.join('\n\n'),
    mentions.length > 0
      ? `Referenced workspace paths:\n${mentions.map((path) => `- ${path}`).join('\n')}`
      : '',
  ]
    .filter((part) => part.trim().length > 0)
    .join('\n\n');

  return {
    prompt: prompt || 'Analyze the attached image.',
    imagePaths,
  };
}

function normalizeNullableString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
