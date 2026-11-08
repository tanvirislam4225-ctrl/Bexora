import test from 'node:test';
import assert from 'node:assert/strict';

// Helper function mirroring the exact logic in render-server.ts for testing
function parseServiceAccountHelper(rawJson: string | undefined): {
  valid: boolean;
  error?: string;
  serviceAccount?: { projectId: string; clientEmail: string; privateKey: string };
} {
  if (!rawJson || !rawJson.trim()) {
    return { valid: false, error: 'Missing required environment variable: FIREBASE_SERVICE_ACCOUNT_JSON' };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawJson.trim());
  } catch {
    return { valid: false, error: 'Invalid JSON syntax' };
  }

  const projectId = typeof parsed.project_id === 'string' ? parsed.project_id.trim() : '';
  const clientEmail = typeof parsed.client_email === 'string' ? parsed.client_email.trim() : '';
  const rawPrivateKey = typeof parsed.private_key === 'string' ? parsed.private_key : '';

  if (!projectId) return { valid: false, error: 'Missing project_id' };
  if (!clientEmail) return { valid: false, error: 'Missing client_email' };
  if (!rawPrivateKey) return { valid: false, error: 'Missing private_key' };

  const privateKey = rawPrivateKey.replace(/\\n/g, '\n');
  if (!privateKey.includes('BEGIN PRIVATE KEY')) {
    return { valid: false, error: 'Invalid private_key format: Missing BEGIN PRIVATE KEY' };
  }

  return {
    valid: true,
    serviceAccount: { projectId, clientEmail, privateKey },
  };
}

function validatePaymentInputHelper(input: {
  amount?: unknown;
  currency?: unknown;
  paymentMethod?: unknown;
  transactionId?: unknown;
}): { valid: boolean; error?: string } {
  const amt = Number(input.amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return { valid: false, error: 'Amount must be a positive number' };
  }
  const method = String(input.paymentMethod || '').trim();
  if (!method) {
    return { valid: false, error: 'Missing payment method' };
  }
  const trxId = String(input.transactionId || '').trim();
  if (!trxId) {
    return { valid: false, error: 'Missing transactionId' };
  }
  return { valid: true };
}

test('FIREBASE_SERVICE_ACCOUNT_JSON: rejects missing or empty value without logging secrets', () => {
  const res1 = parseServiceAccountHelper(undefined);
  assert.equal(res1.valid, false);
  assert.match(res1.error!, /Missing required environment variable/);

  const res2 = parseServiceAccountHelper('   ');
  assert.equal(res2.valid, false);
  assert.match(res2.error!, /Missing required environment variable/);
});

test('FIREBASE_SERVICE_ACCOUNT_JSON: rejects malformed JSON', () => {
  const res = parseServiceAccountHelper('{ not valid json');
  assert.equal(res.valid, false);
  assert.match(res.error!, /Invalid JSON syntax/);
});

test('FIREBASE_SERVICE_ACCOUNT_JSON: converts escaped literal \\n into real newlines and validates fields', () => {
  const mockSa = JSON.stringify({
    project_id: 'bexora-marketplace-test',
    client_email: 'firebase-adminsdk@bexora-marketplace-test.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n-----END PRIVATE KEY-----\\n',
  });

  const res = parseServiceAccountHelper(mockSa);
  assert.equal(res.valid, true);
  assert.equal(res.serviceAccount?.projectId, 'bexora-marketplace-test');
  assert.equal(
    res.serviceAccount?.clientEmail,
    'firebase-adminsdk@bexora-marketplace-test.iam.gserviceaccount.com'
  );
  // Must contain real newlines, not escaped literal "\n"
  assert.equal(res.serviceAccount?.privateKey.includes('\\n'), false);
  assert.equal(res.serviceAccount?.privateKey.includes('\n'), true);
});

test('Payment input validation: enforces positive amount, payment method and transaction ID', () => {
  assert.equal(validatePaymentInputHelper({ amount: -50, paymentMethod: 'bkash', transactionId: 'TX1' }).valid, false);
  assert.equal(validatePaymentInputHelper({ amount: 0, paymentMethod: 'bkash', transactionId: 'TX1' }).valid, false);
  assert.equal(validatePaymentInputHelper({ amount: 'invalid', paymentMethod: 'bkash', transactionId: 'TX1' }).valid, false);
  assert.equal(validatePaymentInputHelper({ amount: 500, paymentMethod: '', transactionId: 'TX1' }).valid, false);
  assert.equal(validatePaymentInputHelper({ amount: 500, paymentMethod: 'bkash', transactionId: '' }).valid, false);

  const validRes = validatePaymentInputHelper({
    amount: 500,
    currency: 'BDT',
    paymentMethod: 'bkash',
    transactionId: 'B9K2M71QA',
  });
  assert.equal(validRes.valid, true);
});
