import type {
  AccountEnforcementStatus,
  AlertPriority,
  ContentSurface,
  ModerationCategory,
  ModerationDecisionLevel,
  ModerationLanguage,
  ModerationPolicySettings,
  ModerationStrikeRecord,
  UserRestrictionRecord,
} from '../types/moderation';

export const PAUSED_CONVERSATION_NOTICE =
  'CONVERSATION TEMPORARILY PAUSED\n\n' +
  'Our automated safety system detected potentially concerning communication in this conversation.\n\n' +
  'Messaging has been temporarily paused while BEXORA reviews the issue.\n\n' +
  'This is a precautionary measure and does not mean that either participant has been permanently penalized.\n\n' +
  'Please wait for administrator review.';

export const FIRST_WARNING_TITLE = 'FIRST WARNING — COMMUNITY GUIDELINES VIOLATION';
export const FINAL_WARNING_TITLE = 'FINAL WARNING — SECOND POLICY VIOLATION';
export const PROTECTIVE_SUSPENSION_TITLE =
  'PROTECTIVE ACCOUNT SUSPENSION — PENDING ADMINISTRATOR REVIEW';
export const PERMANENT_BAN_TITLE = 'ACCOUNT PERMANENTLY BANNED BY BEXORA TRUST & SAFETY';

export const DEFAULT_MODERATION_POLICY_SETTINGS: ModerationPolicySettings = {
  enabledLanguages: ['bn', 'banglish', 'en', 'hi', 'ur', 'roman_hi_ur', 'mixed'],
  strictProfanityBlocking: true,
  blockOffPlatformScamLures: true,
  autoPauseSuspiciousChats: true,
  requireMediaAiVerification: true,
  failSafeQuarantineUncertainMedia: true,
  levelAConfidenceThreshold: 0.84,
  levelBConfidenceThreshold: 0.55,
  maxStrikesBeforeProtectiveSuspension: 3,
  protectiveSuspensionDurationHours: 0,
  reportRateLimitPerHour: 8,
  appealCooldownHours: 12,
  firstWarningTemplate:
    'Your submission was blocked because it violated BEXORA Community & Marketplace Safety Guidelines. This has been recorded as Strike 1 of 3. Repeated violations will lead to account restrictions.',
  finalWarningTemplate:
    'Your submission was blocked for a second verified policy violation (Strike 2 of 3). One further violation will trigger an immediate protective suspension of marketplace, messaging, and withdrawal privileges pending administrator review.',
  protectiveSuspensionTemplate:
    'Your account has reached 3 verified policy violations (or triggered a critical safety rule) and has been placed under Protective Suspension. Publishing listings, bidding, purchasing, messaging, and new withdrawal requests are paused while a BEXORA Human Administrator reviews your case. Your existing wallet balances and transaction history remain intact, and you may submit an appeal.',
  updatedAtMs: 0,
};

export interface NormalizationAnalysis {
  rawText: string;
  nfkcText: string;
  strippedControlText: string;
  foldedAsciiTokens: string;
  collapsedRepeatTokens: string;
  compactAlphaNum: string;
  compactIndicAndArabic: string;
  evasionSignals: string[];
  detectedLanguages: ModerationLanguage[];
}

export interface DeterministicModerationOutcome {
  decisionLevel: ModerationDecisionLevel;
  category: ModerationCategory;
  priority: AlertPriority;
  confidence: number;
  matchedSignals: string[];
  evasionSignals: string[];
  detectedLanguages: ModerationLanguage[];
  isLegitimateDisputeContext: boolean;
  shouldPauseConversation: boolean;
  normalizedPreview: string;
  reasoning: string;
}

const ZERO_WIDTH_AND_CONTROL_RE =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u00AD\u034F\u061C\u180E]/g;

const CONFUSABLE_HOMOGLYPH_MAP: Record<string, string> = {
  // Cyrillic / Greek lookalikes -> Latin
  '\u0430': 'a',
  '\u0410': 'a',
  '\u03B1': 'a',
  '\u0435': 'e',
  '\u0415': 'e',
  '\u03B5': 'e',
  '\u043E': 'o',
  '\u041E': 'o',
  '\u03BF': 'o',
  '\u0440': 'p',
  '\u0420': 'p',
  '\u0441': 'c',
  '\u0421': 'c',
  '\u0443': 'u',
  '\u0445': 'x',
  '\u0456': 'i',
  '\u0406': 'i',
  '\u03B9': 'i',
  '\u0455': 's',
  '\u04BB': 'h',
  '\u0501': 'd',
  '\u0261': 'g',
  '\uFF41': 'a',
  '\uFF42': 'b',
  '\uFF43': 'c',
  '\uFF44': 'd',
  '\uFF45': 'e',
  '\uFF46': 'f',
  '\uFF4B': 'k',
  '\uFF55': 'u',
};

const LEETSPEAK_CHAR_MAP: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  '$': 's',
  '!': 'i',
  '|': 'i',
};

/**
 * Safely wraps untrusted user text, OCR text, or transcripts before passing to Gemini
 * so adversarial instructions inside UGC cannot hijack the moderation system prompt.
 */
export function wrapUntrustedContentForAi(label: string, rawInput: string, maxChars = 6000): string {
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'content';
  const bounded = String(rawInput || '').slice(0, maxChars);
  const neutralized = bounded
    .replace(/<\/?untrusted_user_content[^>]*>/gi, '[escaped_delimiter_tag]')
    .replace(/<\/?system_instruction[^>]*>/gi, '[escaped_system_tag]');
  return `<untrusted_user_content source="${safeLabel}">\n${neutralized}\n</untrusted_user_content>`;
}

export function detectLanguagesInText(input: string): ModerationLanguage[] {
  const text = String(input || '');
  if (!text.trim()) return ['unknown'];

  const hasBengaliScript = /[\u0980-\u09FF]/.test(text);
  const hasDevanagariScript = /[\u0900-\u097F]/.test(text);
  const hasArabicUrduScript = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);
  const hasLatinScript = /[a-zA-Z]/.test(text);

  const lowerLatin = text.toLowerCase();
  const banglishHints =
    /\b(ami|tumi|tui|apni|bhalo|kemon|taka|korbo|koren|ache|nai|bhai|dada|bokachoda|chod|magi|khanki|haramjada|kuttar|sala|shala|chuda|mer[eo]|khu?n)\b/.test(
      lowerLatin,
    );
  const romanHiUrHints =
    /\b(madarchod|bhenchod|behenchod|chutiya|bhosdike|harami|randi|gandu|kutta|kaminey|saala|bhaijaan|paisa|tumhara|mera|teri|maa|behen|jaan\s+se\s+maar)\b/.test(
      lowerLatin,
    );

  const detected: ModerationLanguage[] = [];
  if (hasBengaliScript) detected.push('bn');
  if (hasDevanagariScript) detected.push('hi');
  if (hasArabicUrduScript) detected.push('ur');
  if (hasLatinScript) {
    if (banglishHints) detected.push('banglish');
    if (romanHiUrHints) detected.push('roman_hi_ur');
    if (!banglishHints && !romanHiUrHints) {
      detected.push('en');
    } else if (/\b(the|this|please|account|channel|payment|seller|buyer|fuck|shit|bitch|kill)\b/.test(lowerLatin)) {
      detected.push('en');
    }
  }

  if (detected.length === 0) return ['unknown'];
  if (detected.length > 1) return [...detected, 'mixed'];
  return detected;
}

export function normalizeForModeration(rawInput: string): NormalizationAnalysis {
  const rawText = String(rawInput || '');
  const evasionSignals: string[] = [];

  if (ZERO_WIDTH_AND_CONTROL_RE.test(rawText)) {
    evasionSignals.push('zero_width_or_invisible_chars');
  }
  const strippedControlText = rawText.replace(ZERO_WIDTH_AND_CONTROL_RE, '');
  const nfkcText = strippedControlText.normalize('NFKC');

  let homoglyphCount = 0;
  let homoglyphFolded = '';
  for (const ch of nfkcText) {
    if (CONFUSABLE_HOMOGLYPH_MAP[ch]) {
      homoglyphCount += 1;
      homoglyphFolded += CONFUSABLE_HOMOGLYPH_MAP[ch];
    } else {
      homoglyphFolded += ch;
    }
  }
  if (homoglyphCount > 0) {
    evasionSignals.push('unicode_homoglyph_substitution');
  }

  const lower = homoglyphFolded.toLowerCase();

  // Detect spaced / dotted / underscored single-character obfuscation like "f u c k", "b.o.k.a.c.h.o.d.a", "m_a_g_i"
  if (/(?:^|\s)(?:[a-z0-9@$!]\s*[._\-*+|/~]\s*){3,}[a-z0-9@$!](?:\s|$)/i.test(lower)) {
    evasionSignals.push('intra_word_symbol_separation');
  } else if (/(?:^|\s)(?:[a-z]\s+){3,}[a-z](?:\s|$)/i.test(lower)) {
    evasionSignals.push('spaced_single_letter_evasion');
  }

  // Fold leetspeak ONLY when adjacent to letters or inside mixed letter-symbol tokens (not pure prices like "1500" or "$450")
  const foldedAsciiTokens = lower
    .split(/(\s+)/)
    .map((token) => {
      if (/^\s+$/.test(token)) return ' ';
      const hasLetters = /[a-z]/.test(token);
      if (!hasLetters) return token;
      let leetUsed = false;
      let out = '';
      for (const ch of token) {
        if (LEETSPEAK_CHAR_MAP[ch]) {
          leetUsed = true;
          out += LEETSPEAK_CHAR_MAP[ch];
        } else {
          out += ch;
        }
      }
      if (leetUsed && /[013457@$!|]/.test(token) && !/^@[a-z0-9_]{3,}$/.test(token)) {
        if (!evasionSignals.includes('leetspeak_substitution')) {
          evasionSignals.push('leetspeak_substitution');
        }
      }
      return out;
    })
    .join('')
    .trim();

  // Collapse 3+ repeated identical characters ("fuuuuck" -> "fuck", "maaadarchod" -> "madarchod", "বোকাচোদাাা" -> "বোকাচোদা")
  if (/(.)\1{2,}/u.test(foldedAsciiTokens)) {
    evasionSignals.push('repeated_character_stretching');
  }
  const collapsedRepeatTokens = foldedAsciiTokens.replace(/(.)\1{2,}/gu, '$1');

  // Compact Latin alphanumeric string (strips dots, spaces, underscores, asterisks) for catching split slurs
  const compactAlphaNum = collapsedRepeatTokens.replace(/[^a-z0-9]+/g, '');

  // Normalize Bengali, Devanagari & Urdu punctuation/separators while keeping native letters & combining marks
  const compactIndicAndArabic = nfkcText
    .replace(/(.)\1{2,}/gu, '$1')
    .replace(/[\s._\-*+|/~،۔!?'"()[\]{}]+/gu, '');

  const detectedLanguages = detectLanguagesInText(rawText);

  return {
    rawText,
    nfkcText,
    strippedControlText,
    foldedAsciiTokens,
    collapsedRepeatTokens,
    compactAlphaNum,
    compactIndicAndArabic,
    evasionSignals,
    detectedLanguages,
  };
}

interface PatternRule {
  id: string;
  category: ModerationCategory;
  level: 'LEVEL_A' | 'LEVEL_B';
  priority: AlertPriority;
  confidence: number;
  tokenRegex?: RegExp;
  compactSubstrings?: string[];
  nativeSubstrings?: string[];
}

const MULTILINGUAL_MODERATION_RULES: PatternRule[] = [
  // 1. Severe Child Safety / Exploitation (Immediate Critical Level A)
  {
    id: 'severe_csam_exploitation',
    category: 'child_safety_severe',
    level: 'LEVEL_A',
    priority: 'CRITICAL',
    confidence: 0.99,
    tokenRegex: /\b(csam|child\s*porn|cp\s*links?|underage\s*nudes?|minor\s*sex)\b/i,
  },

  // 2. Violent Threats & Murder / Harm Threats (EN, BN, Banglish, HI, UR, Roman HI/UR)
  {
    id: 'violent_death_threat_multilingual',
    category: 'violent_threat',
    level: 'LEVEL_A',
    priority: 'CRITICAL',
    confidence: 0.96,
    tokenRegex:
      /\b(i\s*will\s*kill\s*you|gonna\s*kill\s*you|murder\s*you|shoot\s*you|slit\s*your\s*throat|rape\s*you|toke\s*mere\s*felbo|tomake\s*khun\s*korbo|tore\s*khu?n\s*korbo|jaan\s*se\s*maar\s*dunga|jaan\s*se\s*marunga|tujhe\s*maar\s*dalunga|qatal\s*kar\s*dunga)\b/i,
    nativeSubstrings: [
      'তোকেমেরেফেলব',
      'তোমাকেখুনকরব',
      'তোরেখুনকরমু',
      'গলাকেটেফেলব',
      'ধর্ষণকরব',
      'जानसेमारदूंगा',
      'तुझेमारडालूंगा',
      'बलात्कारकरूंगा',
      'جانسےماردوںگا',
      'قتلکردوںگا',
    ],
  },

  // 3. Extortion, Doxxing & Blackmail (Level A clear, Level B indirect)
  {
    id: 'direct_extortion_doxxing',
    category: 'extortion_coercion',
    level: 'LEVEL_A',
    priority: 'CRITICAL',
    confidence: 0.94,
    tokenRegex:
      /\b(leak\s*your\s*(nid|passport|private\s*photos|nudes|family\s*address)|send\s*money\s*or\s*i\s*will\s*(leak|expose|hack)|taka\s*na\s*dile\s*chobi\s*viral\s*kore\s*dibo|paisa\s*de\s*warna\s*(leak|viral)\s*kar\s*dunga)\b/i,
    nativeSubstrings: [
      'টাকানাদিলেছবিভাইরালকরেদিব',
      'টাকানাদিলেফাঁসকরেদিব',
      'पैसेदेवनालीककरदूंगा',
      'پیسےدےورنہلیککردوںگا',
    ],
  },

  // 4. Severe Multilingual Profanity, Slurs & Sexual Abuse (EN, BN, Banglish, HI, UR)
  {
    id: 'english_severe_profanity_slurs',
    category: 'profanity_vulgarity',
    level: 'LEVEL_A',
    priority: 'HIGH',
    confidence: 0.94,
    tokenRegex:
      /\b(motherfucker|motherfucking|fuck\s*you|fuck\s*off|go\s*fuck\s*yourself|dumb\s*fuck|piece\s*of\s*shit|son\s*of\s*a\s*bitch|stupid\s*bitch|cunt|cocksucker|whore|slut)\b/i,
    compactSubstrings: ['motherfucker', 'fuckyou', 'cocksucker', 'sonofabitch'],
  },
  {
    id: 'hate_speech_slurs',
    category: 'hate_speech',
    level: 'LEVEL_A',
    priority: 'CRITICAL',
    confidence: 0.97,
    tokenRegex: /\b(nigger|nigga|faggot|kike|kill\s*all\s*(muslims|hindus|jews|christians|dalits))\b/i,
    compactSubstrings: ['nigger', 'faggot'],
  },
  {
    id: 'bengali_and_banglish_profanity',
    category: 'profanity_vulgarity',
    level: 'LEVEL_A',
    priority: 'HIGH',
    confidence: 0.95,
    tokenRegex:
      /\b(bokachoda|boka\s*choda|madarchod|madar\s*chod|banchod|baanchod|bainchod|khankir\s*pola|khankir\s*chele|khanki\s*magi|magir\s*pola|kuttar\s*baccha|shuorer\s*baccha|haramjada|haramzadi|chudir\s*bhai|gudmarani|baler\s*pola|tor\s*mare\s*chudi|tor\s*make\s*chudi)\b/i,
    compactSubstrings: [
      'bokachoda',
      'khankirpola',
      'khankirchele',
      'khankimagi',
      'magirpola',
      'gudmarani',
      'chudirbhai',
      'tormarechudi',
      'tormakechudi',
    ],
    nativeSubstrings: [
      'বোকাচোদা',
      'মাদারচোদ',
      'বাইনচোদ',
      'খানকিরপোলা',
      'খানকিরছেলে',
      'খানকিমাগী',
      'মাগীরপোলা',
      'গুদমারানি',
      'চুদিরভাই',
      'তোরমারেচুদি',
      'তোরমাকেচুদি',
      'কুত্তারবাচ্চা',
      'শুয়োরেরবাচ্চা',
      'হারামজাদা',
    ],
  },
  {
    id: 'hindi_urdu_and_roman_profanity',
    category: 'profanity_vulgarity',
    level: 'LEVEL_A',
    priority: 'HIGH',
    confidence: 0.95,
    tokenRegex:
      /\b(madarchod|maadarchod|mc\s*bc|bhenchod|behenchod|behanchod|bhosdike|bhosdiwale|chutiya|chutiye|gandu|gaandu|randi\s*ke\s*bachhe|randi\s*ki\s*aulad|haramkhor|teri\s*maa\s*ki\s*chut|teri\s*behen\s*ki\s*chut|laude\s*ke\s*baal|lund\s*choos)\b/i,
    compactSubstrings: [
      'madarchod',
      'bhenchod',
      'behenchod',
      'bhosdike',
      'bhosdiwale',
      'terimaakichut',
      'teribehenkichut',
      'randikiaulad',
    ],
    nativeSubstrings: [
      'मादरचोद',
      'बहनचोद',
      'भोसड़ीके',
      'भोसडीके',
      'चूतिया',
      'गांडू',
      'रंडीकीऔलाद',
      'तेरीमांकीचूत',
      'مادرچود',
      'بہنچود',
      'بھوسڑیکے',
      'چوتیا',
      'گانڈو',
      'رنڈیکیاولاد',
      'تیریماںکیچوت',
    ],
  },
  {
    id: 'sexual_harassment_explicit',
    category: 'sexual_harassment',
    level: 'LEVEL_A',
    priority: 'HIGH',
    confidence: 0.92,
    tokenRegex:
      /\b(send\s*nudes|show\s*your\s*(boobs|breasts|body)|suck\s*my\s*dick|nengta\s*chobi\s*pathao|apnar\s*nude\s*dao)\b/i,
    nativeSubstrings: ['নেংটাছবিপাঠাও', 'নগ্নছবিদাও'],
  },

  // 5. Off-Platform Escrow Bypass & Phishing Lures (Level A when explicit payment bypass)
  {
    id: 'off_platform_escrow_bypass_scam',
    category: 'scam_off_platform',
    level: 'LEVEL_A',
    priority: 'HIGH',
    confidence: 0.9,
    tokenRegex:
      /\b(pay\s*me\s*directly\s*outside\s*bexora|skip\s*escrow\s*and\s*send\s*(bkash|nagad|usdt|crypto|binance)|send\s*payment\s*on\s*(whatsapp|telegram)\s*first|bexora\s*chara\s*direct\s*(bkash|nagad)\s*koro|escrow\s*bad\s*diye\s*direct\s*taka\s*pathao)\b/i,
    nativeSubstrings: [
      'এসক্রোবাদদিয়েডাইরেক্টবিকাশকরো',
      'বাইরেথেকেডাইরেক্টটাকাপাঠাও',
    ],
  },

  // 6. Level B — Suspicious / Indirect Coercion, Off-Platform Contact Push, Borderline Harassment
  {
    id: 'suspicious_chat_coercion_or_pressure',
    category: 'extortion_coercion',
    level: 'LEVEL_B',
    priority: 'HIGH',
    confidence: 0.72,
    tokenRegex:
      /\b(release\s*the\s*funds\s*right\s*now\s*or\s*you\s*will\s*regret|accept\s*delivery\s*before\s*i\s*give\s*password|confirm\s*deal\s*first\s*then\s*i\s*will\s*send\s*login|age\s*deal\s*complete\s*koro\s*tarpor\s*password\s*dibo|regret\s*what\s*happens\s*next|i\s*know\s*where\s*you\s*live|ami\s*jani\s*tumi\s*kothay\s*thako)\b/i,
    nativeSubstrings: [
      'আগেডিলকমপ্লিটকরোতারপরপাসওয়ার্ডদিব',
      'আমিজানিতুমিকোথায়থাকো',
      'পস্তাবেবলেদিলাম',
    ],
  },
  {
    id: 'suspicious_off_platform_contact_lure',
    category: 'scam_off_platform',
    level: 'LEVEL_B',
    priority: 'MEDIUM',
    confidence: 0.66,
    tokenRegex:
      /\b(message\s*me\s*on\s*(telegram|whatsapp)|contact\s*my\s*(telegram|whatsapp)|inbox\s*kor[eo]\s*(whatsapp|telegram)|আমার\s*(হোয়াটসঅ্যাপ|টেলিগ্রাম)|whatsapp\s*(number|no)\s*[:=-]?\s*\+?\d{8,14})\b/i,
    nativeSubstrings: ['হোয়াটসঅ্যাপেমেসেজদাও', 'টেলিগ্রামেযোগাযোগকরো'],
  },
  {
    id: 'borderline_hostile_insult',
    category: 'suspicious_conduct',
    level: 'LEVEL_B',
    priority: 'MEDIUM',
    confidence: 0.6,
    tokenRegex:
      /\b(you\s*are\s*a\s*(bloody\s*idiot|total\s*loser|pathetic\s*scumbag)|tui\s*ekta\s*(chagol|gadha|faltu\s*lok)|tum\s*ek\s*number\s*ke\s*gawar\s*ho)\b/i,
  },
];

const LEGITIMATE_MARKETPLACE_DISPUTE_RE =
  /\b(copyright\s*strike|community\s*guidelines?\s*strike|youtube\s*strike|monetization\s*(disabled|rejected)|seller\s*did\s*not\s*transfer|didn'?t\s*transfer\s*ownership|please\s*refund|escrow\s*dispute|admin\s*please\s*check|login\s*code\s*not\s*working|wrong\s*credentials|analytics\s*mismatch|subscriber\s*drop)\b/i;

/**
 * Evaluates text deterministically across Bengali, Banglish, English, Hindi, Urdu, and Romanized scripts.
 * Never mutates rawText; returns structured evidence + decision level.
 */
export function evaluateTextDeterministically(
  rawText: string,
  options?: {
    surface?: ContentSurface;
    isQuotedReportOrAppeal?: boolean;
    policy?: ModerationPolicySettings;
  },
): DeterministicModerationOutcome {
  const policy = options?.policy || DEFAULT_MODERATION_POLICY_SETTINGS;
  const surface = options?.surface || 'pre_deal_chat';
  const analysis = normalizeForModeration(rawText);

  if (!analysis.rawText.trim()) {
    return {
      decisionLevel: 'CLEAN',
      category: 'clean',
      priority: 'LOW',
      confidence: 1,
      matchedSignals: [],
      evasionSignals: [],
      detectedLanguages: ['unknown'],
      isLegitimateDisputeContext: false,
      shouldPauseConversation: false,
      normalizedPreview: '',
      reasoning: 'Empty input.',
    };
  }

  const isLegitimateDisputeContext = LEGITIMATE_MARKETPLACE_DISPUTE_RE.test(analysis.nfkcText);

  // If a user is submitting a User Report or Account Appeal and quoting what happened,
  // do NOT punish the reporter/appellant unless they are actively making a new violent death threat or CSAM submission.
  const isReportOrAppealSurface =
    Boolean(options?.isQuotedReportOrAppeal) ||
    surface === 'user_report' ||
    surface === 'account_appeal';

  const matchedRules: PatternRule[] = [];

  for (const rule of MULTILINGUAL_MODERATION_RULES) {
    if (
      rule.category === 'scam_off_platform' &&
      !policy.blockOffPlatformScamLures
    ) {
      continue;
    }
    if (
      rule.category === 'profanity_vulgarity' &&
      !policy.strictProfanityBlocking
    ) {
      continue;
    }

    let hit = false;
    if (rule.tokenRegex && (rule.tokenRegex.test(analysis.collapsedRepeatTokens) || rule.tokenRegex.test(analysis.nfkcText))) {
      hit = true;
    }
    if (!hit && rule.compactSubstrings && analysis.compactAlphaNum.length >= 4) {
      for (const sub of rule.compactSubstrings) {
        if (analysis.compactAlphaNum.includes(sub)) {
          hit = true;
          break;
        }
      }
    }
    if (!hit && rule.nativeSubstrings && analysis.compactIndicAndArabic.length >= 3) {
      for (const sub of rule.nativeSubstrings) {
        if (analysis.compactIndicAndArabic.includes(sub)) {
          hit = true;
          break;
        }
      }
    }

    if (hit) {
      matchedRules.push(rule);
    }
  }

  // Standalone single-word English "fuck" / "bitch" check when not part of benign substring ("scunthorpe", etc.)
  if (
    policy.strictProfanityBlocking &&
    matchedRules.length === 0 &&
    /\b(fuck|fucking|fucker|bitch|asshole|bastard)\b/i.test(analysis.collapsedRepeatTokens)
  ) {
    matchedRules.push({
      id: 'english_direct_profanity_token',
      category: 'profanity_vulgarity',
      level: 'LEVEL_A',
      priority: 'HIGH',
      confidence: 0.89,
    });
  } else if (
    policy.strictProfanityBlocking &&
    matchedRules.length === 0 &&
    analysis.evasionSignals.length > 0 &&
    (analysis.compactAlphaNum === 'fuck' ||
      analysis.compactAlphaNum.includes('fuckyou') ||
      analysis.compactAlphaNum.includes('bokachoda') ||
      analysis.compactAlphaNum.includes('madarchod') ||
      analysis.compactAlphaNum.includes('bhenchod'))
  ) {
    matchedRules.push({
      id: 'obfuscated_compact_profanity',
      category: 'profanity_vulgarity',
      level: 'LEVEL_A',
      priority: 'HIGH',
      confidence: 0.93,
    });
  }

  if (matchedRules.length === 0) {
    // Low-confidence evasion-only pattern check (Level C)
    if (analysis.evasionSignals.length >= 2) {
      return {
        decisionLevel: 'LEVEL_C',
        category: 'suspicious_conduct',
        priority: 'LOW',
        confidence: 0.42,
        matchedSignals: ['multiple_obfuscation_signals_without_explicit_slur'],
        evasionSignals: analysis.evasionSignals,
        detectedLanguages: analysis.detectedLanguages,
        isLegitimateDisputeContext,
        shouldPauseConversation: false,
        normalizedPreview: analysis.collapsedRepeatTokens.slice(0, 280),
        reasoning:
          'Detected heavy character obfuscation without a confirmed slur; allowed with background pattern logging (Level C).',
      };
    }

    return {
      decisionLevel: 'CLEAN',
      category: 'clean',
      priority: 'LOW',
      confidence: 0.98,
      matchedSignals: [],
      evasionSignals: analysis.evasionSignals,
      detectedLanguages: analysis.detectedLanguages,
      isLegitimateDisputeContext,
      shouldPauseConversation: false,
      normalizedPreview: analysis.collapsedRepeatTokens.slice(0, 280),
      reasoning: isLegitimateDisputeContext
        ? 'Legitimate marketplace transaction/dispute discussion with no abusive language.'
        : 'No policy violations detected.',
    };
  }

  // Sort matched rules by severity (LEVEL_A first, CRITICAL first, highest confidence first)
  const priorityRank: Record<AlertPriority, number> = {
    CRITICAL: 4,
    HIGH: 3,
    MEDIUM: 2,
    LOW: 1,
  };
  matchedRules.sort((a, b) => {
    if (a.level !== b.level) return a.level === 'LEVEL_A' ? -1 : 1;
    if (priorityRank[a.priority] !== priorityRank[b.priority]) {
      return priorityRank[b.priority] - priorityRank[a.priority];
    }
    return b.confidence - a.confidence;
  });

  const topRule = matchedRules[0];

  // Protect reporters/appellants quoting profanity or scam messages as evidence
  if (
    isReportOrAppealSurface &&
    topRule.category !== 'child_safety_severe' &&
    topRule.category !== 'violent_threat'
  ) {
    return {
      decisionLevel: 'LEVEL_C',
      category: topRule.category,
      priority: 'LOW',
      confidence: 0.5,
      matchedSignals: matchedRules.map((r) => r.id),
      evasionSignals: analysis.evasionSignals,
      detectedLanguages: analysis.detectedLanguages,
      isLegitimateDisputeContext: true,
      shouldPauseConversation: false,
      normalizedPreview: analysis.collapsedRepeatTokens.slice(0, 280),
      reasoning:
        'Quoted violation terms inside a User Report or Account Appeal are allowed for administrator review without penalizing the submitter.',
    };
  }

  const isChatSurface = surface === 'pre_deal_chat' || surface === 'deal_room_chat';
  const shouldPauseConversation =
    isChatSurface &&
    policy.autoPauseSuspiciousChats &&
    (topRule.level === 'LEVEL_B' ||
      topRule.category === 'violent_threat' ||
      topRule.category === 'extortion_coercion');

  return {
    decisionLevel: topRule.level,
    category: topRule.category,
    priority: topRule.priority,
    confidence: topRule.confidence,
    matchedSignals: matchedRules.map((r) => r.id),
    evasionSignals: analysis.evasionSignals,
    detectedLanguages: analysis.detectedLanguages,
    isLegitimateDisputeContext,
    shouldPauseConversation,
    normalizedPreview: analysis.collapsedRepeatTokens.slice(0, 280),
    reasoning:
      topRule.level === 'LEVEL_A'
        ? `High-confidence policy violation (${topRule.category}) matched rule ${topRule.id}.`
        : `Suspicious or coercive conduct (${topRule.category}) matched rule ${topRule.id}; routed for protective handling and administrator review.`,
  };
}

export interface WalletSnapshotForSafetyCheck {
  walletBalanceMinor: number;
  reservedBalanceMinor: number;
}

export interface StrikeTransitionInput {
  userId: string;
  userEmail?: string;
  userDisplayName?: string;
  eventKey: string;
  category: ModerationCategory;
  surface: ContentSurface;
  evidenceSnippet: string;
  nowMs: number;
  existingRestriction: UserRestrictionRecord | null;
  existingStrikes: ModerationStrikeRecord[];
  policy?: ModerationPolicySettings;
  walletSnapshot?: WalletSnapshotForSafetyCheck;
}

export interface StrikeTransitionOutput {
  alreadyRecordedForEvent: boolean;
  newStrikeRecord: ModerationStrikeRecord | null;
  updatedRestriction: UserRestrictionRecord;
  updatedStrikes: ModerationStrikeRecord[];
  userNoticeTitle: string;
  userNoticeMessage: string;
  walletSnapshotAfter?: WalletSnapshotForSafetyCheck;
}

/**
 * Pure, idempotent server-side strike state machine:
 * - Deduplicates by `eventKey` so retries or multiple words in 1 submission NEVER issue >1 strike.
 * - Strike 1 -> FIRST WARNING
 * - Strike 2 -> FINAL WARNING
 * - Strike 3 (or child_safety_severe) -> PROTECTIVE ACCOUNT SUSPENSION (`protective_suspension`),
 *   blocking new marketplace/chat/withdrawal actions while keeping wallet balances untouched and
 *   leaving irreversible `permanent_ban` strictly to Human Administrators.
 */
export function applyVerifiedStrikeIdempotent(
  input: StrikeTransitionInput,
): StrikeTransitionOutput {
  const policy = input.policy || DEFAULT_MODERATION_POLICY_SETTINGS;
  const maxStrikes = Math.max(1, policy.maxStrikesBeforeProtectiveSuspension || 3);

  const duplicate = input.existingStrikes.find(
    (s) => s.userId === input.userId && s.eventKey === input.eventKey && !s.reversed,
  );

  const currentActiveStrikes = input.existingStrikes.filter(
    (s) => s.userId === input.userId && !s.reversed,
  ).length;

  // Wallet invariant: balances are passed through identically without deduction or mutation
  const preservedWallet = input.walletSnapshot
    ? {
        walletBalanceMinor: input.walletSnapshot.walletBalanceMinor,
        reservedBalanceMinor: input.walletSnapshot.reservedBalanceMinor,
      }
    : undefined;

  if (duplicate && input.existingRestriction) {
    return {
      alreadyRecordedForEvent: true,
      newStrikeRecord: null,
      updatedRestriction: { ...input.existingRestriction },
      updatedStrikes: [...input.existingStrikes],
      userNoticeTitle: input.existingRestriction.latestWarningTitle || FIRST_WARNING_TITLE,
      userNoticeMessage:
        input.existingRestriction.latestWarningMessage || policy.firstWarningTemplate,
      walletSnapshotAfter: preservedWallet,
    };
  }

  // Severe child safety immediately escalates to Strike 3 protective suspension + critical human review
  const nextStrikeRaw =
    input.category === 'child_safety_severe'
      ? 3
      : Math.min(3, currentActiveStrikes + 1);
  const strikeNumber = (nextStrikeRaw <= 1 ? 1 : nextStrikeRaw === 2 ? 2 : 3) as 1 | 2 | 3;

  const newStrikeRecord: ModerationStrikeRecord = {
    id: `stk_${input.nowMs}_${Math.random().toString(36).slice(2, 8)}`,
    eventKey: input.eventKey,
    userId: input.userId,
    strikeNumber,
    category: input.category,
    surface: input.surface,
    summary:
      strikeNumber === 1
        ? FIRST_WARNING_TITLE
        : strikeNumber === 2
          ? FINAL_WARNING_TITLE
          : PROTECTIVE_SUSPENSION_TITLE,
    evidenceSnippet: String(input.evidenceSnippet || '').slice(0, 300),
    issuedBy: 'ai_protective_system',
    createdAtMs: input.nowMs,
  };

  const updatedStrikes = [...input.existingStrikes, newStrikeRecord];
  const activeCount = updatedStrikes.filter((s) => s.userId === input.userId && !s.reversed).length;
  const reachedProtectiveSuspension = activeCount >= maxStrikes || input.category === 'child_safety_severe';

  // Preserve permanent_ban if already banned by a Human Admin
  const priorStatus: AccountEnforcementStatus =
    input.existingRestriction?.accountStatus === 'permanent_ban'
      ? 'permanent_ban'
      : reachedProtectiveSuspension
        ? 'protective_suspension'
        : 'warned';

  const userNoticeTitle =
    priorStatus === 'permanent_ban'
      ? PERMANENT_BAN_TITLE
      : reachedProtectiveSuspension
        ? PROTECTIVE_SUSPENSION_TITLE
        : strikeNumber === 2
          ? FINAL_WARNING_TITLE
          : FIRST_WARNING_TITLE;

  const userNoticeMessage =
    reachedProtectiveSuspension
      ? policy.protectiveSuspensionTemplate
      : strikeNumber === 2
        ? policy.finalWarningTemplate
        : policy.firstWarningTemplate;

  const expiresAtMs =
    reachedProtectiveSuspension && policy.protectiveSuspensionDurationHours > 0
      ? input.nowMs + policy.protectiveSuspensionDurationHours * 3600 * 1000
      : 0;

  const isSuspendedOrBanned =
    priorStatus === 'protective_suspension' || priorStatus === 'permanent_ban';

  const updatedRestriction: UserRestrictionRecord = {
    userId: input.userId,
    userEmail: input.userEmail || input.existingRestriction?.userEmail,
    userDisplayName: input.userDisplayName || input.existingRestriction?.userDisplayName,
    accountStatus: priorStatus,
    activeStrikes: Math.min(3, activeCount),
    totalHistoricalStrikes: updatedStrikes.filter((s) => s.userId === input.userId).length,
    latestWarningTitle: userNoticeTitle,
    latestWarningMessage: userNoticeMessage,
    latestCategory: input.category,
    restrictListings: isSuspendedOrBanned || Boolean(input.existingRestriction?.restrictListings),
    restrictBidding: isSuspendedOrBanned || Boolean(input.existingRestriction?.restrictBidding),
    restrictPurchasing: isSuspendedOrBanned || Boolean(input.existingRestriction?.restrictPurchasing),
    restrictPreDealChat: isSuspendedOrBanned || Boolean(input.existingRestriction?.restrictPreDealChat),
    restrictDealChat: isSuspendedOrBanned || Boolean(input.existingRestriction?.restrictDealChat),
    restrictReviews: isSuspendedOrBanned || Boolean(input.existingRestriction?.restrictReviews),
    restrictProfileEdits: isSuspendedOrBanned || Boolean(input.existingRestriction?.restrictProfileEdits),
    restrictWithdrawals: isSuspendedOrBanned || Boolean(input.existingRestriction?.restrictWithdrawals),
    financialHoldActive: Boolean(input.existingRestriction?.financialHoldActive),
    financialHoldReason: input.existingRestriction?.financialHoldReason,
    requiresHumanPermanentBanReview: reachedProtectiveSuspension,
    reason: `Automated protective enforcement for ${input.category} (${activeCount}/${maxStrikes} strikes).`,
    enforcedBy:
      priorStatus === 'permanent_ban' ? 'human_admin' : 'ai_protective_system',
    enforcedByAdminId: input.existingRestriction?.enforcedByAdminId,
    expiresAtMs,
    createdAtMs: input.existingRestriction?.createdAtMs || input.nowMs,
    updatedAtMs: input.nowMs,
  };

  return {
    alreadyRecordedForEvent: false,
    newStrikeRecord,
    updatedRestriction,
    updatedStrikes,
    userNoticeTitle,
    userNoticeMessage,
    walletSnapshotAfter: preservedWallet,
  };
}

/**
 * Validates binary magic bytes of uploaded image or audio attachments (never trusts MIME type alone).
 */
export function verifyMediaMagicBytes(
  base64Data: string,
  claimedMimeType: string,
): { valid: boolean; detectedMimeType: string; byteLength: number; reason?: string } {
  const cleaned = String(base64Data || '').replace(/^data:[^;]+;base64,/, '').trim();
  if (!cleaned) {
    return { valid: false, detectedMimeType: 'empty', byteLength: 0, reason: 'Empty media payload.' };
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(cleaned, 'base64');
  } catch {
    return { valid: false, detectedMimeType: 'invalid_base64', byteLength: 0, reason: 'Malformed base64 encoding.' };
  }

  if (buf.length < 12) {
    return { valid: false, detectedMimeType: 'too_small', byteLength: buf.length, reason: 'Media payload too short.' };
  }
  if (buf.length > 4.5 * 1024 * 1024) {
    return { valid: false, detectedMimeType: 'oversized', byteLength: buf.length, reason: 'Media payload exceeds 4.5MB limit.' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { valid: true, detectedMimeType: 'image/png', byteLength: buf.length };
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { valid: true, detectedMimeType: 'image/jpeg', byteLength: buf.length };
  }
  // GIF: GIF87a / GIF89a
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return { valid: true, detectedMimeType: 'image/gif', byteLength: buf.length };
  }
  // RIFF (WEBP or WAV)
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
    const subType = buf.subarray(8, 12).toString('ascii');
    if (subType === 'WEBP') {
      return { valid: true, detectedMimeType: 'image/webp', byteLength: buf.length };
    }
    if (subType === 'WAVE') {
      return { valid: true, detectedMimeType: 'audio/wav', byteLength: buf.length };
    }
  }
  // WebM / Matroska (voice notes recorded in Chromium MediaRecorder): 1A 45 DF A3
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return {
      valid: true,
      detectedMimeType: claimedMimeType.startsWith('video/') ? 'video/webm' : 'audio/webm',
      byteLength: buf.length,
    };
  }
  // Ogg audio: OggS (4F 67 67 53)
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) {
    return { valid: true, detectedMimeType: 'audio/ogg', byteLength: buf.length };
  }
  // MP3 (ID3 tag or MPEG sync frame FF FB / FF F3 / FF F2)
  if (
    (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) ||
    (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)
  ) {
    return { valid: true, detectedMimeType: 'audio/mp3', byteLength: buf.length };
  }
  // MP4 / M4A container ('ftyp' at bytes 4..8)
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    return {
      valid: true,
      detectedMimeType: claimedMimeType.startsWith('audio/') ? 'audio/mp4' : 'video/mp4',
      byteLength: buf.length,
    };
  }

  return {
    valid: false,
    detectedMimeType: 'unknown_binary',
    byteLength: buf.length,
    reason: 'Unsupported or disguised binary signature (magic-byte mismatch).',
  };
}
