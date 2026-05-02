import type { ModelOption } from './api/types';

export function formatModelOptionLabel(model: ModelOption | null | undefined): string {
  if (!model) {
    return 'Default model';
  }

  const providerName = model.providerName?.trim();
  if (providerName) {
    return `${providerName} · ${model.displayName}`;
  }

  return model.displayName;
}

export function formatModelOptionDescription(model: ModelOption): string {
  const parts: string[] = [];
  const providerName = model.providerName?.trim();
  const description = model.description?.trim();

  if (providerName) {
    parts.push(providerName);
  }
  if (description) {
    parts.push(description);
  }
  if (model.contextWindow && model.contextWindow > 0) {
    parts.push(`${formatContextWindow(model.contextWindow)} context`);
  }

  if (parts.length === 0) {
    return model.id;
  }

  return parts.join(' · ');
}

function formatContextWindow(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions >= 10 ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }

  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${thousands >= 10 ? thousands.toFixed(0) : thousands.toFixed(1)}K`;
  }

  return String(value);
}
