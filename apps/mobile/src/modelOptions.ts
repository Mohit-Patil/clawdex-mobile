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

  if (parts.length === 0) {
    return model.id;
  }

  return parts.join(' · ');
}
