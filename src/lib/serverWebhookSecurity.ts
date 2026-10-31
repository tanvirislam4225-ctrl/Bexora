import { createHmac, timingSafeEqual } from 'node:crypto';

export interface WebhookVerificationInput {
  rawBody: string;
  signatureHeader: string;
  timestampHeader?: string;
  secret: string;
  eventKey?: string;
  eventId?: string;
  nowMs?: number;
  maxSkewMs?: number;
  replayCache?: Map<string, number>;
}

export type WebhookErrorCode =
  | 'unconfigured'
  | 'missing_signature'
  | 'empty_payload'
  | 'stale_timestamp'
  | 'invalid_signature'
  | 'replay_detected';

export interface WebhookVerificationResult {
  ok: boolean;
  status: number;
  code?: WebhookErrorCode;
  reason?: string;
}

const DEFAULT_MAX_SKEW_MS = 5 * 60 * 1000; // 5 minutes
const REPLAY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function computeWordPressWebhookSignatures(
  rawBody: string,
  secret: string,
  timestampHeader?: string
): {
  hex: string;
  base64: string;
  timestampedHex: string;
  timestampedBase64: string;
} {
  const cleanTs = String(timestampHeader || '').trim();
  const tsPayload = cleanTs ? `${cleanTs}.${rawBody}` : rawBody;
  return {
    hex: createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex'),
    base64: createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64'),
    timestampedHex: createHmac('sha256', secret).update(tsPayload, 'utf8').digest('hex'),
    timestampedBase64: createHmac('sha256', secret).update(tsPayload, 'utf8').digest('base64'),
  };
}

function safeEqualString(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyWordPressWebhookRequest(
  input: WebhookVerificationInput
): WebhookVerificationResult {
  const secret = String(input.secret || '').trim();
  if (!secret) {
    return {
      ok: false,
      status: 503,
      code: 'unconfigured',
      reason: 'WORDPRESS_WEBHOOK_SECRET is not configured on this server.',
    };
  }

  const rawSig = String(input.signatureHeader || '')
    .trim()
    .replace(/^sha256=/i, '');
  if (!rawSig) {
    return {
      ok: false,
      status: 401,
      code: 'missing_signature',
      reason: 'Missing webhook signature header.',
    };
  }

  const rawBody = typeof input.rawBody === 'string' ? input.rawBody : '';
  if (!rawBody) {
    return {
      ok: false,
      status: 400,
      code: 'empty_payload',
      reason: 'Empty webhook payload.',
    };
  }

  const nowMs = input.nowMs ?? Date.now();
  const maxSkewMs = input.maxSkewMs ?? DEFAULT_MAX_SKEW_MS;
  const cleanTs = String(input.timestampHeader || '').trim();

  if (cleanTs) {
    const rawTs = Number(cleanTs);
    const parsedTsMs = rawTs > 0 && rawTs < 10_000_000_000 ? rawTs * 1000 : rawTs;
    if (!Number.isFinite(parsedTsMs) || Math.abs(nowMs - parsedTsMs) > maxSkewMs) {
      return {
        ok: false,
        status: 401,
        code: 'stale_timestamp',
        reason: 'Webhook timestamp is expired or outside the allowed clock skew window.',
      };
    }
  }

  const expected = computeWordPressWebhookSignatures(rawBody, secret, cleanTs);
  const signatureMatches =
    safeEqualString(rawSig, expected.hex) ||
    safeEqualString(rawSig, expected.base64) ||
    (Boolean(cleanTs) &&
      (safeEqualString(rawSig, expected.timestampedHex) ||
        safeEqualString(rawSig, expected.timestampedBase64)));

  if (!signatureMatches) {
    return {
      ok: false,
      status: 401,
      code: 'invalid_signature',
      reason: 'Invalid webhook HMAC-SHA256 signature.',
    };
  }

  const cleanEventKey = String(input.eventKey || input.eventId || '').trim();
  if (cleanEventKey && input.replayCache) {
    for (const [key, seenAt] of input.replayCache.entries()) {
      if (nowMs - seenAt > REPLAY_TTL_MS) {
        input.replayCache.delete(key);
      }
    }
    if (input.replayCache.has(cleanEventKey)) {
      return {
        ok: false,
        status: 409,
        code: 'replay_detected',
        reason: 'Duplicate or replayed webhook event ignored.',
      };
    }
    input.replayCache.set(cleanEventKey, nowMs);
  }

  return { ok: true, status: 200 };
}
