import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COUNTRIES_CATALOG,
  filterCountries,
  validateWithdrawalAmount,
  convertCurrency,
  DEFAULT_WITHDRAWAL_METHODS,
  DEFAULT_MANUAL_PAYMENT_METHODS,
} from '../lib/countryCurrencyCatalog';

test('Country Catalog Serial Numbers and Filtering', () => {
  assert.equal(COUNTRIES_CATALOG.length >= 20, true);
  assert.equal(COUNTRIES_CATALOG[0].name, 'Bangladesh');
  assert.equal(COUNTRIES_CATALOG[0].serial, 1);
  assert.equal(COUNTRIES_CATALOG[0].currencyCode, 'BDT');

  // Search by name
  const filteredByName = filterCountries(COUNTRIES_CATALOG, 'india');
  assert.equal(filteredByName.length, 1);
  assert.equal(filteredByName[0].code, 'IN');

  // Search by currency code
  const filteredByCurr = filterCountries(COUNTRIES_CATALOG, 'bdt');
  assert.equal(filteredByCurr.length, 1);
  assert.equal(filteredByCurr[0].name, 'Bangladesh');

  // Search by serial number
  const filteredBySerial = filterCountries(COUNTRIES_CATALOG, '5');
  assert.equal(filteredBySerial.some((c) => c.serial === 5), true);
});

test('Withdrawal Amount Validation with Minimum Limits', () => {
  const bkashMethod = DEFAULT_WITHDRAWAL_METHODS.find((m) => m.id === 'bkash')!;
  assert.equal(bkashMethod.minLimit, 500);

  // Less than min limit
  const resLow = validateWithdrawalAmount(200, bkashMethod);
  assert.equal(resLow.valid, false);
  assert.equal(resLow.error?.includes('500'), true);

  // Equal to min limit
  const resExact = validateWithdrawalAmount(500, bkashMethod);
  assert.equal(resExact.valid, true);

  // Above min limit
  const resHigh = validateWithdrawalAmount(1500, bkashMethod);
  assert.equal(resHigh.valid, true);

  // USDT Method with 10 USDT minimum
  const usdtMethod = DEFAULT_WITHDRAWAL_METHODS.find((m) => m.id === 'usdt')!;
  assert.equal(usdtMethod.minLimit, 10);

  const resUsdtLow = validateWithdrawalAmount(5, usdtMethod);
  assert.equal(resUsdtLow.valid, false);

  const resUsdtOk = validateWithdrawalAmount(25, usdtMethod);
  assert.equal(resUsdtOk.valid, true);
});

test('Currency Conversion with Configurable Country Exchange Rates', () => {
  // Bangladesh rate: 1 USDT = 125 BDT
  const bdtRate = 125;
  const bdtFromUsdt = convertCurrency(10, 'USDT', 'LOCAL', bdtRate);
  assert.equal(bdtFromUsdt, 1250);

  const usdtFromBdt = convertCurrency(1250, 'LOCAL', 'USDT', bdtRate);
  assert.equal(usdtFromBdt, 10);

  // Custom rate change: 1 USDT = 130 BDT
  const newRate = 130;
  assert.equal(convertCurrency(5, 'USDT', 'LOCAL', newRate), 650);

  // India rate: 1 USDT = 86.5 INR
  const inrRate = 86.5;
  assert.equal(convertCurrency(10, 'USDT', 'LOCAL', inrRate), 865);
});

test('Manual Payment Methods Default Configuration and Active Invariants', () => {
  assert.equal(DEFAULT_MANUAL_PAYMENT_METHODS.length >= 4, true);

  const bkash = DEFAULT_MANUAL_PAYMENT_METHODS.find((m) => m.id === 'bkash')!;
  assert.equal(bkash.enabled, true);
  assert.equal(Boolean(bkash.receivingNumber), true);
  assert.equal(Boolean(bkash.instructions), true);

  const binance = DEFAULT_MANUAL_PAYMENT_METHODS.find((m) => m.id === 'binance')!;
  assert.equal(binance.enabled, true);
  assert.equal(binance.type, 'binance');
});
