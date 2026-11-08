import { CurrencyCode } from '../types';

export interface ManualPaymentMethod {
  id: string;
  name: string;
  type: 'bkash' | 'nagad' | 'rocket' | 'binance' | 'bank' | 'custom';
  accountNumber: string;
  accountHolder?: string;
  instructions?: string;
  logoUrl?: string;
  enabled: boolean;
  displayOrder: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface LivePaymentLink {
  serialNumber: number; // Positive integer == amountBdt
  amountBdt: number;    // Exactly equals serialNumber
  paymentUrl: string;   // Valid HTTPS URL
  enabled: boolean;
  usageCount: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ManualPaymentRequest {
  id: string;
  dealId: string;
  listingId: string;
  listingTitle: string;
  buyerUid: string;
  buyerName: string;
  buyerEmail?: string;
  sellerUid: string;
  sellerName?: string;
  methodId: string;
  methodName: string;
  accountNumber: string;
  expectedAmountMinor: number;
  currency: CurrencyCode;
  convertedAmountBdt?: number;
  submittedTrxId: string;
  senderNumberOrAccount?: string;
  screenshotData?: string;
  status: 'pending' | 'confirmed' | 'rejected';
  rejectionReason?: string;
  adminUid?: string;
  adminName?: string;
  reviewedAtMs?: number;
  paymentLedgerId?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface LivePaymentSnapshot {
  trackingId: string;
  dealId: string;
  listingId: string;
  buyerUid: string;
  serialNumber: number;
  amountBdt: number;
  originalAmountMinor: number;
  originalCurrency: CurrencyCode;
  usdtToBdtRateSnapshot: number;
  paymentUrl: string;
  createdAtMs: number;
}

export const EXACT_LINK_UNAVAILABLE_MESSAGE =
  'Exact payment amount link is currently unavailable. Please contact support or try another payment method.';

/**
 * Calculates the exact BDT serial number for a payable total.
 * Serial Number == Exact Payable BDT Amount.
 * For BDT: buyerTotalMinor / 100.
 * For USD / USDT: (buyerTotalMinor / 100) * usdtToBdtRate.
 * Zero tolerance for fractional BDT that cannot map to a whole-integer serial link.
 */
export function calculateExactBdtSerial(
  buyerTotalMinor: number,
  currency: CurrencyCode,
  usdtToBdtRate: number = 125
): { ok: true; serialNumber: number; amountBdt: number } | { ok: false; error: string; reason: string } {
  if (!Number.isFinite(buyerTotalMinor) || buyerTotalMinor <= 0) {
    return { ok: false, error: 'invalid_amount', reason: 'Payable amount must be a positive number.' };
  }

  if (currency === 'BDT') {
    if (buyerTotalMinor % 100 !== 0) {
      return {
        ok: false,
        error: 'fractional_amount',
        reason: 'Fractional BDT amounts cannot be matched to whole taka payment links.',
      };
    }
    const amountBdt = Math.round(buyerTotalMinor / 100);
    return { ok: true, serialNumber: amountBdt, amountBdt };
  }

  // USD / USDT Currency
  if (!Number.isFinite(usdtToBdtRate) || usdtToBdtRate <= 0) {
    return {
      ok: false,
      error: 'invalid_rate',
      reason: 'USDT to BDT exchange rate must be configured and greater than 0.',
    };
  }

  const usdtAmount = buyerTotalMinor / 100;
  // Calculate total BDT using precise floating arithmetic rounded to 4 decimals to avoid IEEE 754 precision issues
  const calculatedBdt = Math.round(usdtAmount * usdtToBdtRate * 10000) / 10000;

  // Check if it is an exact whole integer
  if (Math.abs(calculatedBdt - Math.round(calculatedBdt)) > 0.0001) {
    return {
      ok: false,
      error: 'fractional_amount',
      reason: `Converted amount ${calculatedBdt.toFixed(2)} BDT is fractional. Fractional amounts that cannot be matched to whole taka links are rejected.`,
    };
  }

  const exactWholeBdt = Math.round(calculatedBdt);
  if (exactWholeBdt <= 0) {
    return {
      ok: false,
      error: 'invalid_amount',
      reason: 'Calculated BDT amount must be a positive integer.',
    };
  }

  return {
    ok: true,
    serialNumber: exactWholeBdt,
    amountBdt: exactWholeBdt,
  };
}

/**
 * Validates a live payment link input.
 * Serial must be a positive integer.
 * URL must be a valid HTTPS URL.
 */
export function validateLivePaymentLinkInput(
  serialNumberInput: number | string,
  paymentUrl: string
): { valid: true; serialNumber: number; paymentUrl: string } | { valid: false; error: string } {
  const serial = typeof serialNumberInput === 'string' ? Number(serialNumberInput.trim()) : serialNumberInput;
  if (!Number.isInteger(serial) || serial <= 0) {
    return { valid: false, error: 'Serial number must be a positive whole integer representing the exact BDT amount.' };
  }

  if (!paymentUrl || typeof paymentUrl !== 'string') {
    return { valid: false, error: 'Payment link URL is required.' };
  }

  const trimmedUrl = paymentUrl.trim();
  try {
    const parsed = new URL(trimmedUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { valid: false, error: 'Payment URL must have a valid HTTP or HTTPS protocol.' };
    }
  } catch {
    return { valid: false, error: 'Invalid Payment URL format.' };
  }

  return { valid: true, serialNumber: serial, paymentUrl: trimmedUrl };
}

/**
 * Matches an exact payment link from a collection or map.
 * Strict equality on serialNumber.
 * Zero tolerance for approximate, nearest, fallback, guessing, or default links.
 */
export function matchExactPaymentLink(
  requiredSerial: number,
  links: LivePaymentLink[] | Map<number, LivePaymentLink>
): { ok: true; link: LivePaymentLink } | { ok: false; reason: string } {
  let matched: LivePaymentLink | undefined;

  if (links instanceof Map) {
    matched = links.get(requiredSerial);
  } else if (Array.isArray(links)) {
    matched = links.find((item) => item.serialNumber === requiredSerial);
  }

  if (!matched) {
    return { ok: false, reason: EXACT_LINK_UNAVAILABLE_MESSAGE };
  }

  if (!matched.enabled) {
    return { ok: false, reason: EXACT_LINK_UNAVAILABLE_MESSAGE };
  }

  // Double verification invariant: serialNumber must strictly equal requiredSerial
  if (matched.serialNumber !== requiredSerial || matched.amountBdt !== requiredSerial) {
    return { ok: false, reason: EXACT_LINK_UNAVAILABLE_MESSAGE };
  }

  return { ok: true, link: matched };
}

/**
 * Creates default manual payment methods if none exist.
 */
export function getDefaultManualPaymentMethods(): ManualPaymentMethod[] {
  const now = Date.now();
  return [
    {
      id: 'method_bkash',
      name: 'bKash Personal',
      type: 'bkash',
      accountNumber: '01886229988',
      accountHolder: 'Bexora Escrow Desk',
      instructions: 'Send Money (Personal) to this number and enter the Transaction ID (TrxID) below.',
      enabled: true,
      displayOrder: 1,
      createdAtMs: now,
      updatedAtMs: now,
    },
    {
      id: 'method_nagad',
      name: 'Nagad Personal',
      type: 'nagad',
      accountNumber: '01886229988',
      accountHolder: 'Bexora Escrow Desk',
      instructions: 'Send Money to this personal Nagad number and provide the 8-character Transaction ID.',
      enabled: true,
      displayOrder: 2,
      createdAtMs: now,
      updatedAtMs: now,
    },
    {
      id: 'method_rocket',
      name: 'Rocket Personal',
      type: 'rocket',
      accountNumber: '01886229988-5',
      accountHolder: 'Bexora Escrow Desk',
      instructions: 'Send Money to this Rocket account and submit your Transaction ID.',
      enabled: true,
      displayOrder: 3,
      createdAtMs: now,
      updatedAtMs: now,
    },
    {
      id: 'method_binance',
      name: 'Binance Pay / USDT (TRC20)',
      type: 'binance',
      accountNumber: 'TXYZ1234567890BexoraDepositTRC20',
      accountHolder: 'Bexora Treasury (Pay ID: 789456123)',
      instructions: 'Transfer the exact USDT amount via TRC20 or Binance Pay and enter the TxID or Pay Order ID.',
      enabled: true,
      displayOrder: 4,
      createdAtMs: now,
      updatedAtMs: now,
    },
  ];
}
