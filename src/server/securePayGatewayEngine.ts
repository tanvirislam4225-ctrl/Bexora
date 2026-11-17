import crypto from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import {
  buildTopupLedgerId,
  generateDealCode,
  shouldRecordLatePaymentReconciliation,
} from '../lib/walletTopupAndReservationLogic';

export interface SecurePayGatewayConfig {
  apiKey: string;
  siteUrl: string;
  isConfigured: boolean;
  supportedMethods: string[];
}

export interface CreateSecurePaySessionParams {
  sessionId: string;
  mode: 'buy_now' | 'accepted_bid_deal' | 'wallet_topup';
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
  mode: 'buy_now' | 'accepted_bid_deal' | 'wallet_topup';
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
  gatewayMethodId?: string;
  gatewayLabel?: string;
  reservationExpiresAtMs?: number;
  status: 'created' | 'pending' | 'completed' | 'failed' | 'cancelled' | 'expired';
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
    sessionId?: string;
    dealCode?: string;
  }
): Promise<{
  ok: boolean;
  alreadyPaid: boolean;
  lateReconciliation?: boolean;
  ledgerId: string;
  dealCode?: string;
}> {
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

    const existingDealCode = dealSnap.exists && dealSnap.data()?.dealCode
      ? String(dealSnap.data()?.dealCode)
      : undefined;

    // Idempotency check 1: Ledger already exists
    if (ledgerSnap.exists) {
      return { ok: true, alreadyPaid: true, lateReconciliation: false, ledgerId, dealCode: existingDealCode };
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
        return { ok: true, alreadyPaid: true, lateReconciliation: false, ledgerId, dealCode: existingDealCode };
      }
    }

    // Late-callback / double-sale protection for timed Buy Now checkout sessions
    if (listingSnap.exists && params.sessionId) {
      const lData = listingSnap.data() || {};
      const isSameAcceptedBidDeal =
        dealSnap.exists &&
        String(lData.activeDealId || '') === params.dealId &&
        String(lData.reservedBuyerId || '') === params.buyerUid;
      if (
        !isSameAcceptedBidDeal &&
        shouldRecordLatePaymentReconciliation({
          listingStatus: String(lData.status || ''),
          reservationSessionId: lData.reservationSessionId
            ? String(lData.reservationSessionId)
            : undefined,
          sessionId: params.sessionId,
          reservedBuyerId: lData.reservedBuyerId ? String(lData.reservedBuyerId) : undefined,
          buyerId: params.buyerUid,
        })
      ) {
        const recRef = firestore.collection('paymentReconciliations').doc(params.sessionId);
        tx.set(recRef, {
          sessionId: params.sessionId,
          listingId: params.listingId,
          dealId: params.dealId,
          buyerUid: params.buyerUid,
          buyerName: params.buyerName,
          amountMinor: params.buyerTotalMinor,
          currency: params.currency,
          transactionId: params.transactionId,
          gatewayProvider: params.gatewayProvider || 'securepaybd',
          listingStatusAtCallback: String(lData.status || ''),
          reason:
            'Late gateway callback arrived after listing reservation expired or listing was purchased by another buyer.',
          status: 'pending_review',
          createdAtMs: nowMs,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        return { ok: false, alreadyPaid: false, lateReconciliation: true, ledgerId };
      }
    }

    const resolvedDealCode =
      existingDealCode || params.dealCode || generateDealCode(params.dealId, nowMs);

    if (!dealSnap.exists) {
      tx.set(dealRef, {
        id: params.dealId,
        dealCode: resolvedDealCode,
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
        isDeleted: false,
        status: 'paid_deal_room_active',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      tx.update(dealRef, {
        dealCode: resolvedDealCode,
        status: 'paid_deal_room_active',
        paymentLedgerId: ledgerId,
        paymentGateway: params.gatewayProvider || 'securepaybd',
        externalTrxId: params.transactionId,
        paidAtMs: nowMs,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    // Mark listing as sold and clear active reservation timer metadata
    if (listingSnap.exists) {
      tx.update(listingRef, {
        status: 'sold',
        activeDealId: params.dealId,
        reservedBuyerId: FieldValue.delete(),
        reservedUntilMs: FieldValue.delete(),
        reservationExpiresAtMs: FieldValue.delete(),
        reservationSessionId: FieldValue.delete(),
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
      note: `Live Payment Gateway (${params.gatewayProvider || 'Secure Pay BD'}) payment confirmed for deal ${resolvedDealCode}. Transaction ID: ${params.transactionId}`,
      createdAt: FieldValue.serverTimestamp(),
    });

    return {
      ok: true,
      alreadyPaid: false,
      lateReconciliation: false,
      ledgerId,
      dealCode: resolvedDealCode,
    };
  });

  return result;
}

/**
 * Atomically credits a user's BEXORA wallet balance after server-side gateway verification.
 * Strictly idempotent via deterministic ledger doc `led_topup_<sessionId>`.
 */
export async function finalizeWalletTopupInFirestore(
  firestore: Firestore,
  params: {
    sessionId: string;
    buyerUid: string;
    buyerName: string;
    amountMinorBdt: number;
    amountBdt: number;
    transactionId: string;
    gatewayProvider?: string;
  }
): Promise<{
  ok: boolean;
  alreadyCredited: boolean;
  ledgerId: string;
  newBalanceMinor: number;
}> {
  const ledgerId = buildTopupLedgerId(params.sessionId);
  const nowMs = Date.now();

  const privRef = firestore.collection('privateUsers').doc(params.buyerUid);
  const ledgerRef = firestore.collection('walletLedger').doc(ledgerId);
  const sessionRef = firestore.collection('paymentSessions').doc(params.sessionId);

  return firestore.runTransaction(async (tx) => {
    const [privSnap, ledgerSnap, sessionSnap] = await Promise.all([
      tx.get(privRef),
      tx.get(ledgerRef),
      tx.get(sessionRef),
    ]);

    const currentBalanceMinor = Number(privSnap.data()?.walletBalanceMinor || 0);

    if (ledgerSnap.exists) {
      return {
        ok: true,
        alreadyCredited: true,
        ledgerId,
        newBalanceMinor: currentBalanceMinor,
      };
    }

    if (sessionSnap.exists && sessionSnap.data()?.status === 'completed') {
      return {
        ok: true,
        alreadyCredited: true,
        ledgerId,
        newBalanceMinor: currentBalanceMinor,
      };
    }

    if (!privSnap.exists) {
      throw new Error('Wallet account profile does not exist.');
    }

    const nextBalanceMinor = currentBalanceMinor + params.amountMinorBdt;

    tx.update(privRef, {
      walletBalanceMinor: nextBalanceMinor,
      updatedAt: FieldValue.serverTimestamp(),
    });

    tx.set(ledgerRef, {
      userId: params.buyerUid,
      kind: 'wallet_topup',
      gateway: params.gatewayProvider || 'securepaybd',
      amountMinor: params.amountMinorBdt,
      currency: 'BDT',
      referenceId: params.sessionId,
      externalTrxId: params.transactionId,
      note: `Live Wallet Top-Up of ৳${params.amountBdt.toLocaleString()} verified via ${params.gatewayProvider || 'Secure Pay BD'}. Transaction ID: ${params.transactionId}`,
      createdAt: FieldValue.serverTimestamp(),
    });

    if (sessionSnap.exists) {
      tx.update(sessionRef, {
        status: 'completed',
        transactionId: params.transactionId,
        verifiedAtMs: nowMs,
        ledgerId,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    return {
      ok: true,
      alreadyCredited: false,
      ledgerId,
      newBalanceMinor: nextBalanceMinor,
    };
  });
}
