import crypto from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';

export interface SecurePayGatewayConfig {
  apiKey: string;
  siteUrl: string;
  isConfigured: boolean;
  supportedMethods: string[];
}

export interface CreateSecurePaySessionParams {
  sessionId: string;
  mode: 'buy_now' | 'accepted_bid_deal';
  buyerUid: string;
  buyerName: string;
  buyerEmail: string;
  listingId: string;
  dealId: string;
  listingTitle: string;
  amountMinorBdt: number;
  originalCurrency: 'BDT' | 'USD';
  originalAmountMinor: number;
  returnUrl: string;
  webhookUrl: string;
  appUrl: string;
}

export interface SecurePaySessionRecord {
  sessionId: string;
  mode: 'buy_now' | 'accepted_bid_deal';
  buyerUid: string;
  buyerName: string;
  buyerEmail: string;
  listingId: string;
  dealId: string;
  listingTitle: string;
  amountMinorBdt: number;
  amountBdt: number;
  originalCurrency: 'BDT' | 'USD';
  originalAmountMinor: number;
  paymentUrl?: string;
  status: 'created' | 'pending' | 'completed' | 'failed' | 'cancelled';
  transactionId?: string;
  verifiedAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export const SECUREPAY_DEFAULT_SITE_URL = 'https://pay.securepaybd.xyz/';
export const SECUREPAY_SUPPORTED_METHODS = [
  'bKash',
  'Nagad',
  'Rocket',
  'Upay',
  'Visa',
  'Mastercard',
  'Amex',
  'All BD Gateways',
];

/**
 * Reads and validates the Secure Pay BD configuration from environment variables.
 */
export function getSecurePayConfig(env = process.env): SecurePayGatewayConfig {
  const rawKey =
    env.SECUREPAY_API_KEY ||
    env.PAYMENT_GATEWAY_API_KEY ||
    env.SECUREPAY_KEY ||
    '';
  const apiKey = String(rawKey).trim();
  const rawSiteUrl = String(env.SECUREPAY_SITE_URL || SECUREPAY_DEFAULT_SITE_URL).trim();
  const siteUrl = rawSiteUrl.endsWith('/') ? rawSiteUrl : `${rawSiteUrl}/`;

  return {
    apiKey,
    siteUrl,
    isConfigured: apiKey.length >= 8 && apiKey !== '###################',
    supportedMethods: SECUREPAY_SUPPORTED_METHODS,
  };
}

/**
 * In-memory fallback session cache for fast lookup during callbacks and verification.
 */
const sessionMemoryStore = new Map<string, SecurePaySessionRecord>();

export function storeSessionInMemory(session: SecurePaySessionRecord): void {
  sessionMemoryStore.set(session.sessionId, session);
  // Keep memory footprint bounded
  if (sessionMemoryStore.size > 1000) {
    const oldestKey = sessionMemoryStore.keys().next().value;
    if (oldestKey) sessionMemoryStore.delete(oldestKey);
  }
}

export function getSessionFromMemory(sessionId: string): SecurePaySessionRecord | undefined {
  return sessionMemoryStore.get(sessionId);
}

/**
 * Calls Secure Pay BD `POST /api/create` to initiate a payment checkout session.
 */
export async function requestSecurePayCreateApi(
  payload: {
    cus_name: string;
    cus_email: string;
    amount: number;
    webhook_url: string;
    success_url: string;
    cancel_url: string;
  },
  config: SecurePayGatewayConfig,
  fetchFn: typeof fetch = fetch
): Promise<{ ok: boolean; paymentUrl?: string; error?: string }> {
  if (!config.isConfigured) {
    return {
      ok: false,
      error:
        'Secure Pay BD API key is not configured. Please set SECUREPAY_API_KEY in server environment variables.',
    };
  }

  const endpoint = `${config.siteUrl}api/create`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'API-KEY': config.apiKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        error: `Secure Pay BD gateway returned error HTTP ${res.status}: ${text.slice(0, 300)}`,
      };
    }

    const data = (await res.json().catch(() => null)) as {
      result?: string;
      payment_url?: string;
      message?: string;
    } | null;

    if (!data || !data.payment_url) {
      return {
        ok: false,
        error: data?.message || 'Secure Pay BD response did not include a valid payment_url.',
      };
    }

    return {
      ok: true,
      paymentUrl: data.payment_url,
    };
  } catch (err: unknown) {
    clearTimeout(timer);
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : 'Failed to communicate with Secure Pay BD gateway endpoint.',
    };
  }
}

/**
 * Calls Secure Pay BD `POST /api/verify` with `transaction_id`.
 */
export async function requestSecurePayVerifyApi(
  transactionId: string,
  config: SecurePayGatewayConfig,
  fetchFn: typeof fetch = fetch
): Promise<{
  ok: boolean;
  status: string;
  amount?: number;
  cusEmail?: string;
  error?: string;
}> {
  if (!config.isConfigured) {
    return {
      ok: false,
      status: 'UNCONFIGURED',
      error: 'Secure Pay BD API key is not configured on this server.',
    };
  }

  const endpoint = `${config.siteUrl}api/verify`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'API-KEY': config.apiKey,
      },
      body: JSON.stringify({
        transaction_id: transactionId,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        status: 'HTTP_ERROR',
        error: `Secure Pay BD verification failed (HTTP ${res.status}): ${text.slice(0, 300)}`,
      };
    }

    const data = (await res.json().catch(() => null)) as {
      status?: string;
      amount?: string | number;
      cus_email?: string;
      message?: string;
    } | null;

    if (!data || typeof data.status !== 'string') {
      return {
        ok: false,
        status: 'INVALID_PAYLOAD',
        error: 'Secure Pay BD verification response did not contain a valid status.',
      };
    }

    const numericAmount =
      data.amount !== undefined ? Number(data.amount) : undefined;

    return {
      ok: true,
      status: String(data.status).toUpperCase(),
      amount: Number.isFinite(numericAmount) ? numericAmount : undefined,
      cusEmail: data.cus_email,
    };
  } catch (err: unknown) {
    clearTimeout(timer);
    return {
      ok: false,
      status: 'NETWORK_ERROR',
      error:
        err instanceof Error
          ? err.message
          : 'Unable to contact Secure Pay BD verification service.',
    };
  }
}

/**
 * Atomically marks an Escrow Deal as paid (`paid_deal_room_active`) in Firestore
 * after cryptographic or API-level verification has succeeded.
 *
 * Implements strict idempotency via deterministic ledger id `led_pay_${dealId}`.
 */
export async function finalizeDealEscrowPaymentInFirestore(
  firestore: Firestore,
  params: {
    dealId: string;
    listingId: string;
    buyerUid: string;
    buyerName: string;
    sellerId: string;
    sellerName: string;
    listingTitle: string;
    platform: string;
    buyerTotalMinor: number;
    currency: 'BDT' | 'USD';
    baseAmountMinor: number;
    buyerFeeMinor: number;
    buyerFeePct: number;
    sellerFeeMinor: number;
    sellerFeePct: number;
    sellerPayoutMinor: number;
    platformCommissionMinor: number;
    protectionDurationHours: number;
    transactionId: string;
    gatewayProvider?: string;
  }
): Promise<{ ok: boolean; alreadyPaid: boolean; ledgerId: string }> {
  const ledgerId = `led_pay_${params.dealId}`;
  const nowMs = Date.now();

  const dealRef = firestore.collection('deals').doc(params.dealId);
  const listingRef = firestore.collection('listings').doc(params.listingId);
  const ledgerRef = firestore.collection('walletLedger').doc(ledgerId);

  const result = await firestore.runTransaction(async (tx) => {
    const [dealSnap, ledgerSnap, listingSnap] = await Promise.all([
      tx.get(dealRef),
      tx.get(ledgerRef),
      tx.get(listingRef),
    ]);

    // Idempotency check 1: Ledger already exists
    if (ledgerSnap.exists) {
      return { ok: true, alreadyPaid: true, ledgerId };
    }

    // Idempotency check 2: Deal is already active or completed
    if (dealSnap.exists) {
      const currentStatus = dealSnap.data()?.status;
      if (
        currentStatus === 'paid_deal_room_active' ||
        currentStatus === 'paid' ||
        currentStatus === 'settled' ||
        currentStatus === 'protection_active'
      ) {
        return { ok: true, alreadyPaid: true, ledgerId };
      }
    }

    // Update Deal or create if it was an Instant Buy Now without pre-existing deal doc
    const dealData = dealSnap.exists ? dealSnap.data() : null;

    if (!dealSnap.exists) {
      tx.set(dealRef, {
        id: params.dealId,
        listingId: params.listingId,
        listingTitle: params.listingTitle,
        platform: params.platform,
        buyerId: params.buyerUid,
        buyerName: params.buyerName,
        sellerId: params.sellerId,
        sellerName: params.sellerName,
        baseAmountMinor: params.baseAmountMinor,
        buyerFeePct: params.buyerFeePct,
        sellerFeePct: params.sellerFeePct,
        buyerFeeMinor: params.buyerFeeMinor,
        sellerFeeMinor: params.sellerFeeMinor,
        buyerTotalMinor: params.buyerTotalMinor,
        sellerPayoutMinor: params.sellerPayoutMinor,
        platformCommissionMinor: params.platformCommissionMinor,
        currency: params.currency,
        protectionDurationHours: params.protectionDurationHours,
        confirmedAtMs: 0,
        originalDeadlineMs: 0,
        unresolvedReportCount: 0,
        paymentLedgerId: ledgerId,
        paymentGateway: params.gatewayProvider || 'securepaybd',
        externalTrxId: params.transactionId,
        paidAtMs: nowMs,
        transferSubmissionCount: 0,
        status: 'paid_deal_room_active',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      tx.update(dealRef, {
        status: 'paid_deal_room_active',
        paymentLedgerId: ledgerId,
        paymentGateway: params.gatewayProvider || 'securepaybd',
        externalTrxId: params.transactionId,
        paidAtMs: nowMs,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    // Mark listing as sold
    if (listingSnap.exists) {
      tx.update(listingRef, {
        status: 'sold',
        activeDealId: params.dealId,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    // Record immutable audit ledger entry
    tx.set(ledgerRef, {
      userId: params.buyerUid,
      kind: 'escrow_debit',
      gateway: params.gatewayProvider || 'securepaybd',
      amountMinor: params.buyerTotalMinor,
      currency: params.currency,
      referenceId: params.dealId,
      externalTrxId: params.transactionId,
      note: `Live Payment Gateway (${params.gatewayProvider || 'Secure Pay BD'}) payment confirmed for deal #${params.dealId.slice(0, 10)}. Transaction ID: ${params.transactionId}`,
      createdAt: FieldValue.serverTimestamp(),
    });

    return { ok: true, alreadyPaid: false, ledgerId };
  });

  return result;
}
