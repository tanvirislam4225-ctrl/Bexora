import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateExactBdtSerial,
  matchExactPaymentLink,
  validateLivePaymentLinkInput,
  EXACT_LINK_UNAVAILABLE_MESSAGE,
  LivePaymentLink,
} from '../lib/paymentManagementLogic';

test('BDT exact amount to serial calculations', () => {
  // 1 BDT (100 minor) -> Serial 1
  const res1 = calculateExactBdtSerial(100, 'BDT');
  assert.equal(res1.ok, true);
  if (res1.ok) {
    assert.equal(res1.serialNumber, 1);
    assert.equal(res1.amountBdt, 1);
  }

  // 10 BDT (1000 minor) -> Serial 10
  const res10 = calculateExactBdtSerial(1000, 'BDT');
  assert.equal(res10.ok, true);
  if (res10.ok) {
    assert.equal(res10.serialNumber, 10);
    assert.equal(res10.amountBdt, 10);
  }

  // 145 BDT (14500 minor) -> Serial 145
  const res145 = calculateExactBdtSerial(14500, 'BDT');
  assert.equal(res145.ok, true);
  if (res145.ok) {
    assert.equal(res145.serialNumber, 145);
    assert.equal(res145.amountBdt, 145);
  }

  // 625 BDT (62500 minor) -> Serial 625
  const res625 = calculateExactBdtSerial(62500, 'BDT');
  assert.equal(res625.ok, true);
  if (res625.ok) {
    assert.equal(res625.serialNumber, 625);
    assert.equal(res625.amountBdt, 625);
  }

  // Fractional BDT (e.g. 10.50 BDT = 1050 minor) -> Rejected
  const resFractional = calculateExactBdtSerial(1050, 'BDT');
  assert.equal(resFractional.ok, false);
});

test('USD/USDT converted amount to serial calculations at 125 BDT/USDT', () => {
  const rate = 125;

  // 1 USDT (100 minor) @ 125 -> 125 BDT -> Serial 125
  const res1 = calculateExactBdtSerial(100, 'USD', rate);
  assert.equal(res1.ok, true);
  if (res1.ok) {
    assert.equal(res1.serialNumber, 125);
    assert.equal(res1.amountBdt, 125);
  }

  // 2 USDT (200 minor) @ 125 -> 250 BDT -> Serial 250
  const res2 = calculateExactBdtSerial(200, 'USD', rate);
  assert.equal(res2.ok, true);
  if (res2.ok) {
    assert.equal(res2.serialNumber, 250);
    assert.equal(res2.amountBdt, 250);
  }

  // 5 USDT (500 minor) @ 125 -> 625 BDT -> Serial 625
  const res5 = calculateExactBdtSerial(500, 'USD', rate);
  assert.equal(res5.ok, true);
  if (res5.ok) {
    assert.equal(res5.serialNumber, 625);
    assert.equal(res5.amountBdt, 625);
  }

  // 1.16 USDT (116 minor) @ 125 -> 1.16 * 125 = 145 BDT -> Serial 145
  const res116 = calculateExactBdtSerial(116, 'USD', rate);
  assert.equal(res116.ok, true);
  if (res116.ok) {
    assert.equal(res116.serialNumber, 145);
    assert.equal(res116.amountBdt, 145);
  }

  // 1.50 USDT (150 minor) @ 125 -> 187.50 BDT -> Fractional amount, strictly rejected
  const res150 = calculateExactBdtSerial(150, 'USD', rate);
  assert.equal(res150.ok, false);
  if (!res150.ok) {
    assert.equal(res150.error, 'fractional_amount');
  }
});

test('Strict exact matching invariants and zero fallback tolerance', () => {
  const linkList: LivePaymentLink[] = [
    {
      serialNumber: 1,
      amountBdt: 1,
      paymentUrl: 'https://gateway.example/pay/serial_1',
      enabled: true,
      usageCount: 0,
      createdAtMs: 1000,
      updatedAtMs: 1000,
    },
    {
      serialNumber: 10,
      amountBdt: 10,
      paymentUrl: 'https://gateway.example/pay/serial_10',
      enabled: true,
      usageCount: 5,
      createdAtMs: 1000,
      updatedAtMs: 1000,
    },
    {
      serialNumber: 150,
      amountBdt: 150,
      paymentUrl: 'https://gateway.example/pay/serial_150',
      enabled: true,
      usageCount: 1,
      createdAtMs: 1000,
      updatedAtMs: 1000,
    },
    {
      serialNumber: 625,
      amountBdt: 625,
      paymentUrl: 'https://gateway.example/pay/serial_625',
      enabled: true,
      usageCount: 12,
      createdAtMs: 1000,
      updatedAtMs: 1000,
    },
    {
      serialNumber: 999,
      amountBdt: 999,
      paymentUrl: 'https://gateway.example/pay/serial_999',
      enabled: false, // Disabled link
      usageCount: 0,
      createdAtMs: 1000,
      updatedAtMs: 1000,
    },
  ];

  // 1. Serial 1 must return serial 1, NEVER 10
  const match1 = matchExactPaymentLink(1, linkList);
  assert.equal(match1.ok, true);
  if (match1.ok) {
    assert.equal(match1.link.serialNumber, 1);
    assert.equal(match1.link.paymentUrl, 'https://gateway.example/pay/serial_1');
  }

  // 2. Serial 10 must return serial 10, NEVER 1
  const match10 = matchExactPaymentLink(10, linkList);
  assert.equal(match10.ok, true);
  if (match10.ok) {
    assert.equal(match10.link.serialNumber, 10);
  }

  // 3. Serial 145 requested when only 150 exists -> MUST NOT fallback to 150
  const match145 = matchExactPaymentLink(145, linkList);
  assert.equal(match145.ok, false);
  if (!match145.ok) {
    assert.equal(match145.reason, EXACT_LINK_UNAVAILABLE_MESSAGE);
  }

  // 4. Serial 625 requested -> returns 625, never 145 or 150
  const match625 = matchExactPaymentLink(625, linkList);
  assert.equal(match625.ok, true);
  if (match625.ok) {
    assert.equal(match625.link.serialNumber, 625);
  }

  // 5. Disabled link must be rejected with EXACT_LINK_UNAVAILABLE_MESSAGE
  const matchDisabled = matchExactPaymentLink(999, linkList);
  assert.equal(matchDisabled.ok, false);
  if (!matchDisabled.ok) {
    assert.equal(matchDisabled.reason, EXACT_LINK_UNAVAILABLE_MESSAGE);
  }

  // 6. Non-existent serial
  const matchMissing = matchExactPaymentLink(404, linkList);
  assert.equal(matchMissing.ok, false);
  if (!matchMissing.ok) {
    assert.equal(matchMissing.reason, EXACT_LINK_UNAVAILABLE_MESSAGE);
  }
});

test('Reusable link invariant: multiple checkouts can reuse the same serial link', () => {
  const linkList: LivePaymentLink[] = [
    {
      serialNumber: 625,
      amountBdt: 625,
      paymentUrl: 'https://gateway.example/pay/serial_625',
      enabled: true,
      usageCount: 0,
      createdAtMs: 1000,
      updatedAtMs: 1000,
    },
  ];

  // User A checkouts for 625
  const userACheckout = matchExactPaymentLink(625, linkList);
  assert.equal(userACheckout.ok, true);

  // User B checkouts for 625 simultaneously or later
  const userBCheckout = matchExactPaymentLink(625, linkList);
  assert.equal(userBCheckout.ok, true);

  // Both receive the exact same permanent reusable payment link
  if (userACheckout.ok && userBCheckout.ok) {
    assert.equal(userACheckout.link.paymentUrl, userBCheckout.link.paymentUrl);
  }
});

test('Validate live payment link inputs', () => {
  const valid = validateLivePaymentLinkInput(625, 'https://pay.example.com/checkout');
  assert.equal(valid.valid, true);

  const invalidSerial = validateLivePaymentLinkInput(-5, 'https://pay.example.com');
  assert.equal(invalidSerial.valid, false);

  const zeroSerial = validateLivePaymentLinkInput(0, 'https://pay.example.com');
  assert.equal(zeroSerial.valid, false);

  const nonIntSerial = validateLivePaymentLinkInput('625.5', 'https://pay.example.com');
  assert.equal(nonIntSerial.valid, false);

  const invalidUrl = validateLivePaymentLinkInput(625, 'ftp://invalid-protocol');
  assert.equal(invalidUrl.valid, false);
});
