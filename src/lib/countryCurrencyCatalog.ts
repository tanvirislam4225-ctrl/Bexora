export interface CountryCurrencyItem {
  serial: number;
  code: string;
  name: string;
  currencyCode: string;
  currencySymbol: string;
  defaultRateToUsdt: number;
  flagEmoji?: string;
}

export const COUNTRIES_CATALOG: CountryCurrencyItem[] = [
  { serial: 1, code: 'BD', name: 'Bangladesh', currencyCode: 'BDT', currencySymbol: '৳', defaultRateToUsdt: 125, flagEmoji: '🇧🇩' },
  { serial: 2, code: 'US', name: 'United States', currencyCode: 'USD', currencySymbol: '$', defaultRateToUsdt: 1, flagEmoji: '🇺🇸' },
  { serial: 3, code: 'IN', name: 'India', currencyCode: 'INR', currencySymbol: '₹', defaultRateToUsdt: 86.5, flagEmoji: '🇮🇳' },
  { serial: 4, code: 'GB', name: 'United Kingdom', currencyCode: 'GBP', currencySymbol: '£', defaultRateToUsdt: 0.78, flagEmoji: '🇬🇧' },
  { serial: 5, code: 'AE', name: 'United Arab Emirates', currencyCode: 'AED', currencySymbol: 'د.إ', defaultRateToUsdt: 3.67, flagEmoji: '🇦🇪' },
  { serial: 6, code: 'SA', name: 'Saudi Arabia', currencyCode: 'SAR', currencySymbol: '﷼', defaultRateToUsdt: 3.75, flagEmoji: '🇸🇦' },
  { serial: 7, code: 'EU', name: 'Eurozone (European Union)', currencyCode: 'EUR', currencySymbol: '€', defaultRateToUsdt: 0.92, flagEmoji: '🇪🇺' },
  { serial: 8, code: 'CA', name: 'Canada', currencyCode: 'CAD', currencySymbol: 'C$', defaultRateToUsdt: 1.38, flagEmoji: '🇨🇦' },
  { serial: 9, code: 'AU', name: 'Australia', currencyCode: 'AUD', currencySymbol: 'A$', defaultRateToUsdt: 1.54, flagEmoji: '🇦🇺' },
  { serial: 10, code: 'SG', name: 'Singapore', currencyCode: 'SGD', currencySymbol: 'S$', defaultRateToUsdt: 1.34, flagEmoji: '🇸🇬' },
  { serial: 11, code: 'MY', name: 'Malaysia', currencyCode: 'MYR', currencySymbol: 'RM', defaultRateToUsdt: 4.45, flagEmoji: '🇲🇾' },
  { serial: 12, code: 'PK', name: 'Pakistan', currencyCode: 'PKR', currencySymbol: '₨', defaultRateToUsdt: 278, flagEmoji: '🇵🇰' },
  { serial: 13, code: 'QA', name: 'Qatar', currencyCode: 'QAR', currencySymbol: 'ر.ق', defaultRateToUsdt: 3.64, flagEmoji: '🇶🇦' },
  { serial: 14, code: 'KW', name: 'Kuwait', currencyCode: 'KWD', currencySymbol: 'د.ك', defaultRateToUsdt: 0.31, flagEmoji: '🇰🇼' },
  { serial: 15, code: 'OM', name: 'Oman', currencyCode: 'OMR', currencySymbol: 'ر.ع', defaultRateToUsdt: 0.38, flagEmoji: '🇴🇲' },
  { serial: 16, code: 'TR', name: 'Turkey', currencyCode: 'TRY', currencySymbol: '₺', defaultRateToUsdt: 34.5, flagEmoji: '🇹🇷' },
  { serial: 17, code: 'ID', name: 'Indonesia', currencyCode: 'IDR', currencySymbol: 'Rp', defaultRateToUsdt: 15850, flagEmoji: '🇮🇩' },
  { serial: 18, code: 'PH', name: 'Philippines', currencyCode: 'PHP', currencySymbol: '₱', defaultRateToUsdt: 58.6, flagEmoji: '🇵🇭' },
  { serial: 19, code: 'NG', name: 'Nigeria', currencyCode: 'NGN', currencySymbol: '₦', defaultRateToUsdt: 1650, flagEmoji: '🇳🇬' },
  { serial: 20, code: 'BR', name: 'Brazil', currencyCode: 'BRL', currencySymbol: 'R$', defaultRateToUsdt: 5.75, flagEmoji: '🇧🇷' },
];

export interface WithdrawalMethodSetting {
  id: string;
  name: string;
  currency: string;
  enabled: boolean;
  minLimit: number;
  instructions?: string;
  accountPlaceholder?: string;
  badge?: string;
}

export const DEFAULT_WITHDRAWAL_METHODS: WithdrawalMethodSetting[] = [
  {
    id: 'bkash',
    name: 'bKash Personal',
    currency: 'BDT',
    enabled: true,
    minLimit: 500,
    instructions: 'Enter your 11-digit personal bKash account number. Payout processed within 1–6 hours.',
    accountPlaceholder: '01XXXXXXXXX',
    badge: 'Mobile Banking',
  },
  {
    id: 'nagad',
    name: 'Nagad Personal',
    currency: 'BDT',
    enabled: true,
    minLimit: 500,
    instructions: 'Enter your 11-digit personal Nagad number. Payout processed within 1–6 hours.',
    accountPlaceholder: '01XXXXXXXXX',
    badge: 'Mobile Banking',
  },
  {
    id: 'rocket',
    name: 'Rocket Personal',
    currency: 'BDT',
    enabled: true,
    minLimit: 500,
    instructions: 'Enter your 12-digit Rocket account number with check digit.',
    accountPlaceholder: '01XXXXXXXXX-X',
    badge: 'Mobile Banking',
  },
  {
    id: 'bank',
    name: 'Bank Transfer (EFT / NPSB)',
    currency: 'BDT',
    enabled: true,
    minLimit: 1000,
    instructions: 'Provide Bank Name, Branch Name, Account Name, Account Number and Routing Number.',
    accountPlaceholder: 'Bank Name, A/C: XXXXXXXXX, Branch, Routing: XXXXXXXX',
    badge: 'Direct Bank',
  },
  {
    id: 'usdt',
    name: 'Binance Pay / USDT (TRC20)',
    currency: 'USDT',
    enabled: true,
    minLimit: 10,
    instructions: 'Enter your Binance Pay ID or USDT TRC20 address. Payout processed within 1–3 hours.',
    accountPlaceholder: 'Binance Pay ID (e.g. 12345678) or TRC20 Address (T...)',
    badge: 'Crypto',
  },
  {
    id: 'upay',
    name: 'Upay Personal',
    currency: 'BDT',
    enabled: false,
    minLimit: 500,
    instructions: 'Enter your 11-digit personal Upay account number.',
    accountPlaceholder: '01XXXXXXXXX',
    badge: 'Mobile Banking',
  },
];

export interface ManualPaymentMethodSetting {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  receivingNumber: string;
  accountHolder?: string;
  instructions: string;
  minDeposit?: number;
  badge?: string;
  color?: string;
}

export const DEFAULT_MANUAL_PAYMENT_METHODS: ManualPaymentMethodSetting[] = [
  {
    id: 'bkash',
    name: 'bKash Personal',
    type: 'bkash',
    enabled: true,
    receivingNumber: '01886229988',
    accountHolder: 'BEXORA Official Escrow Desk',
    instructions: `1. Open your bKash app and tap "Send Money".\n2. Enter our official receiving number shown above.\n3. Enter the exact deposit amount and confirm with your PIN.\n4. Copy the Transaction ID (TrxID) and enter it below along with your sender number.`,
    minDeposit: 10,
    badge: 'Instant Transfer',
    color: '#E2136E',
  },
  {
    id: 'nagad',
    name: 'Nagad Personal',
    type: 'nagad',
    enabled: true,
    receivingNumber: '01886229988',
    accountHolder: 'BEXORA Official Escrow Desk',
    instructions: `1. Open your Nagad app and select "Send Money".\n2. Enter our official Nagad number above.\n3. Enter your deposit amount and confirm transfer.\n4. Copy your 8-character Transaction ID (TrxID) and submit it below.`,
    minDeposit: 10,
    badge: 'Fast Processing',
    color: '#F7941D',
  },
  {
    id: 'rocket',
    name: 'Rocket Personal',
    type: 'rocket',
    enabled: true,
    receivingNumber: '01886229988-5',
    accountHolder: 'BEXORA Official Escrow Desk',
    instructions: `1. Dial *322# or open Rocket app and choose "Send Money".\n2. Enter our Rocket receiving number with check digit.\n3. Complete the transfer and note down the TxnID.\n4. Enter the TxnID and sender number in the verification form below.`,
    minDeposit: 10,
    badge: 'DBBL Secure',
    color: '#8C3494',
  },
  {
    id: 'binance',
    name: 'Binance Pay / USDT (TRC20)',
    type: 'binance',
    enabled: true,
    receivingNumber: 'TXYZ1234567890BexoraDepositTRC20',
    accountHolder: 'BEXORA Treasury (Binance Pay ID: 789456123)',
    instructions: `1. Open Binance app > Pay > Send, or withdraw USDT via TRC20 network.\n2. Paste our Binance Pay ID or USDT TRC20 address.\n3. Transfer the exact amount in USDT.\n4. Copy your Binance Pay Order ID or TxID and submit it below.`,
    minDeposit: 1,
    badge: 'Crypto USDT',
    color: '#F3BA2F',
  },
  {
    id: 'bank',
    name: 'Bank Transfer (EFT / NPSB)',
    type: 'bank',
    enabled: false,
    receivingNumber: 'City Bank - A/C: 1502938475001, Bexora Tech Ltd',
    accountHolder: 'Bexora Tech Ltd (Gulshan Branch, Routing: 225272186)',
    instructions: `1. Transfer via your mobile banking app or internet banking using NPSB / BEFTN.\n2. Note down the transfer reference or transaction number.\n3. Enter the transaction reference and your sender account name below.`,
    minDeposit: 500,
    badge: 'Direct Bank',
    color: '#005BAC',
  },
];

/**
 * Filter countries by search query.
 */
export function filterCountries(countries: CountryCurrencyItem[], query: string): CountryCurrencyItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return countries;
  return countries.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.code.toLowerCase().includes(q) ||
      c.currencyCode.toLowerCase().includes(q) ||
      String(c.serial).includes(q)
  );
}

/**
 * Validates a withdrawal request amount against method minimum.
 */
export function validateWithdrawalAmount(
  amount: number,
  method: WithdrawalMethodSetting | undefined
): { valid: boolean; error?: string } {
  if (!Number.isFinite(amount) || amount <= 0) {
    return { valid: false, error: 'Please enter a valid positive withdrawal amount.' };
  }
  const min = method ? method.minLimit : 10;
  if (amount < min) {
    const symbol = method?.currency === 'USDT' || method?.currency === 'USD' ? 'USDT ' : '৳';
    return {
      valid: false,
      error: `Minimum withdrawal amount for ${method?.name || 'this method'} is ${symbol}${min}. You entered ${symbol}${amount}.`,
    };
  }
  return { valid: true };
}

/**
 * Converts an amount from one currency to another using the country exchange rate.
 */
export function convertCurrency(
  amount: number,
  from: 'USDT' | 'USD' | 'LOCAL',
  to: 'USDT' | 'USD' | 'LOCAL',
  rateToUsdt: number
): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (!Number.isFinite(rateToUsdt) || rateToUsdt <= 0) return amount;
  if (from === to) return amount;

  if (from === 'USDT' || from === 'USD') {
    // 1 USDT = [rate] LOCAL
    return Math.round(amount * rateToUsdt * 100) / 100;
  }
  // from LOCAL to USDT
  return Math.round((amount / rateToUsdt) * 100) / 100;
}
