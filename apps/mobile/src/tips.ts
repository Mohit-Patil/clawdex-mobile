import { Platform } from 'react-native';
import Purchases, {
  LOG_LEVEL,
  PRODUCT_CATEGORY,
  PRODUCT_TYPE,
  PURCHASES_ERROR_CODE,
  type PurchasesError,
  type PurchasesOffering,
  type PurchasesPackage,
} from 'react-native-purchases';
import RevenueCatUI, { PAYWALL_RESULT } from 'react-native-purchases-ui';

import { env } from './config';

const MAX_TIP_TIERS = 5;

let revenueCatConfigured = false;
let configureRevenueCatPromise: Promise<boolean> | null = null;

export interface TipOfferingSnapshot {
  offering: PurchasesOffering;
  packages: PurchasesPackage[];
}

export type TipPaywallResult =
  | 'purchased'
  | 'restored'
  | 'cancelled'
  | 'notPresented';

export function isTipJarAvailable(): boolean {
  return getRevenueCatApiKey() !== null;
}

export function isTipPaywallTemplateAvailable(): boolean {
  return Platform.OS !== 'web' && !shouldUseRevenueCatTestStore() && isTipJarAvailable();
}

export function getTipJarUnavailableReason(): string {
  if (Platform.OS === 'web') {
    return 'Tips are available in the native iPhone and Android builds only.';
  }

  if (shouldUseRevenueCatTestStore()) {
    return 'This debug build is missing the RevenueCat Test Store API key for tip purchases.';
  }

  return 'This build is missing the RevenueCat public API key for tip purchases.';
}

export async function configureRevenueCatIfNeeded(): Promise<boolean> {
  if (revenueCatConfigured) {
    return true;
  }

  if (configureRevenueCatPromise) {
    return configureRevenueCatPromise;
  }

  configureRevenueCatPromise = (async () => {
    const apiKey = getRevenueCatApiKey();
    if (!apiKey) {
      return false;
    }

    try {
      await Purchases.setLogLevel(__DEV__ ? LOG_LEVEL.DEBUG : LOG_LEVEL.ERROR);
    } catch {
      // Best effort only.
    }

    Purchases.configure({
      apiKey,
    });
    revenueCatConfigured = true;
    return true;
  })();

  try {
    return await configureRevenueCatPromise;
  } catch (error) {
    configureRevenueCatPromise = null;
    throw error;
  }
}

export async function loadTipOffering(): Promise<TipOfferingSnapshot> {
  const configured = await configureRevenueCatIfNeeded();
  if (!configured) {
    throw new Error(getTipJarUnavailableReason());
  }

  const offerings = await Purchases.getOfferings();
  const requestedOfferingId = env.revenueCatTipsOfferingId;
  const offering = requestedOfferingId
    ? offerings.all[requestedOfferingId] ?? null
    : offerings.current;

  if (!offering) {
    throw new Error(
      requestedOfferingId
        ? `RevenueCat offering "${requestedOfferingId}" was not found.`
        : 'No RevenueCat tip offering is configured yet.'
    );
  }

  const packages = offering.availablePackages.filter(isTipPackage).slice(0, MAX_TIP_TIERS);
  if (packages.length === 0) {
    throw new Error(
      'The RevenueCat offering does not have any non-subscription tip tiers yet.'
    );
  }

  return {
    offering,
    packages,
  };
}

export async function purchaseTipPackage(aPackage: PurchasesPackage): Promise<void> {
  const configured = await configureRevenueCatIfNeeded();
  if (!configured) {
    throw new Error(getTipJarUnavailableReason());
  }

  await Purchases.purchasePackage(aPackage);
}

export async function presentTipPaywall(
  offering?: PurchasesOffering | null
): Promise<TipPaywallResult> {
  const configured = await configureRevenueCatIfNeeded();
  if (!configured) {
    throw new Error(getTipJarUnavailableReason());
  }

  const result = await RevenueCatUI.presentPaywall({
    offering: offering ?? undefined,
    displayCloseButton: true,
  });

  switch (result) {
    case PAYWALL_RESULT.PURCHASED:
      return 'purchased';
    case PAYWALL_RESULT.RESTORED:
      return 'restored';
    case PAYWALL_RESULT.CANCELLED:
      return 'cancelled';
    default:
      return 'notPresented';
  }
}

export function isRevenueCatPurchaseCancelled(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const purchasesError = error as Partial<PurchasesError>;
  return (
    purchasesError.code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR ||
    purchasesError.userCancelled === true
  );
}

export function getTipTierTitle(aPackage: PurchasesPackage): string {
  const cleanedTitle = cleanStoreProductTitle(aPackage.product.title);
  if (cleanedTitle) {
    return cleanedTitle;
  }

  return humanizeIdentifier(aPackage.identifier);
}

export function getTipTierDescription(aPackage: PurchasesPackage): string {
  const description = aPackage.product.description.trim();
  if (description.length > 0) {
    return description;
  }

  return 'One-time support for Clawdex development.';
}

export function getTipTierMeta(aPackage: PurchasesPackage): string {
  if (aPackage.product.productType === PRODUCT_TYPE.CONSUMABLE) {
    return 'One-time';
  }

  return 'In-app purchase';
}

export function getTipOfferingSummary(offering: PurchasesOffering | null, count: number): string {
  if (!offering) {
    return 'Optional one-time support';
  }

  const label =
    offering.serverDescription.trim() || humanizeIdentifier(offering.identifier);
  return `${label} · ${count} tier${count === 1 ? '' : 's'}`;
}

function getRevenueCatApiKey(): string | null {
  const usesTestStore = shouldUseRevenueCatTestStore();
  const value = usesTestStore
    ? env.revenueCatTestStoreApiKey
    : Platform.OS === 'ios'
      ? env.revenueCatIosApiKey
      : Platform.OS === 'android'
        ? env.revenueCatAndroidApiKey
        : null;

  const trimmed = value?.trim() ?? '';
  if (__DEV__) {
    console.info(
      `[tips] RevenueCat key source: ${
        usesTestStore ? 'test-store' : Platform.OS === 'ios' ? 'ios' : Platform.OS
      }`
    );
  }
  return trimmed.length > 0 ? trimmed : null;
}

function shouldUseRevenueCatTestStore(): boolean {
  return Platform.OS !== 'web' && __DEV__ && Boolean(env.revenueCatTestStoreApiKey);
}

function isTipPackage(aPackage: PurchasesPackage): boolean {
  return (
    aPackage.product.productCategory === PRODUCT_CATEGORY.NON_SUBSCRIPTION ||
    aPackage.product.productType === PRODUCT_TYPE.CONSUMABLE ||
    aPackage.product.productType === PRODUCT_TYPE.NON_CONSUMABLE
  );
}

function cleanStoreProductTitle(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  return trimmed.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function humanizeIdentifier(value: string): string {
  const normalized = value.trim().replace(/[-_]+/g, ' ');
  if (!normalized) {
    return 'Tip tier';
  }

  return normalized.replace(/\b\w/g, (match) => match.toUpperCase());
}
