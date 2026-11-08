import {
  parsePhoneNumberFromString,
  getCountryCallingCode,
  type CountryCode,
} from 'libphonenumber-js';

export interface SupportedPhoneCountry {
  iso2: CountryCode;
  name: string;
  dialCode: string;
  exampleNational: string;
  placeholder: string;
}

export const SUPPORTED_PHONE_COUNTRIES: SupportedPhoneCountry[] = [
  { iso2: 'BD', name: 'Bangladesh', dialCode: '+880', exampleNational: '1712345678', placeholder: '1712-345678' },
  { iso2: 'IN', name: 'India', dialCode: '+91', exampleNational: '9876543210', placeholder: '98765-43210' },
  { iso2: 'PK', name: 'Pakistan', dialCode: '+92', exampleNational: '3001234567', placeholder: '300-1234567' },
  { iso2: 'US', name: 'United States', dialCode: '+1', exampleNational: '2025550143', placeholder: '(202) 555-0143' },
  { iso2: 'GB', name: 'United Kingdom', dialCode: '+44', exampleNational: '7911123456', placeholder: '7911 123456' },
  { iso2: 'SA', name: 'Saudi Arabia', dialCode: '+966', exampleNational: '501234567', placeholder: '50 123 4567' },
  { iso2: 'AE', name: 'United Arab Emirates', dialCode: '+971', exampleNational: '501234567', placeholder: '50 123 4567' },
  { iso2: 'MY', name: 'Malaysia', dialCode: '+60', exampleNational: '123456789', placeholder: '12-345 6789' },
  { iso2: 'SG', name: 'Singapore', dialCode: '+65', exampleNational: '81234567', placeholder: '8123 4567' },
  { iso2: 'CA', name: 'Canada', dialCode: '+1', exampleNational: '4165550199', placeholder: '(416) 555-0199' },
  { iso2: 'AU', name: 'Australia', dialCode: '+61', exampleNational: '412345678', placeholder: '412 345 678' },
  { iso2: 'DE', name: 'Germany', dialCode: '+49', exampleNational: '15123456789', placeholder: '1512 3456789' },
  { iso2: 'FR', name: 'France', dialCode: '+33', exampleNational: '612345678', placeholder: '6 12 34 56 78' },
  { iso2: 'IT', name: 'Italy', dialCode: '+39', exampleNational: '3123456789', placeholder: '312 345 6789' },
  { iso2: 'ES', name: 'Spain', dialCode: '+34', exampleNational: '612345678', placeholder: '612 34 56 78' },
  { iso2: 'QA', name: 'Qatar', dialCode: '+974', exampleNational: '33123456', placeholder: '3312 3456' },
  { iso2: 'KW', name: 'Kuwait', dialCode: '+965', exampleNational: '50012345', placeholder: '5001 2345' },
  { iso2: 'OM', name: 'Oman', dialCode: '+968', exampleNational: '92123456', placeholder: '9212 3456' },
  { iso2: 'BH', name: 'Bahrain', dialCode: '+973', exampleNational: '36001234', placeholder: '3600 1234' },
  { iso2: 'NP', name: 'Nepal', dialCode: '+977', exampleNational: '9841234567', placeholder: '984-1234567' },
  { iso2: 'LK', name: 'Sri Lanka', dialCode: '+94', exampleNational: '712345678', placeholder: '71 234 5678' },
  { iso2: 'ID', name: 'Indonesia', dialCode: '+62', exampleNational: '81234567890', placeholder: '812-3456-7890' },
  { iso2: 'PH', name: 'Philippines', dialCode: '+63', exampleNational: '9171234567', placeholder: '917 123 4567' },
  { iso2: 'NG', name: 'Nigeria', dialCode: '+234', exampleNational: '8021234567', placeholder: '802 123 4567' },
  { iso2: 'ZA', name: 'South Africa', dialCode: '+27', exampleNational: '821234567', placeholder: '82 123 4567' },
  { iso2: 'BR', name: 'Brazil', dialCode: '+55', exampleNational: '11987654321', placeholder: '(11) 98765-4321' },
  { iso2: 'TR', name: 'Turkey', dialCode: '+90', exampleNational: '5321234567', placeholder: '532 123 45 67' },
  { iso2: 'EG', name: 'Egypt', dialCode: '+20', exampleNational: '1001234567', placeholder: '100 123 4567' },
  { iso2: 'TH', name: 'Thailand', dialCode: '+66', exampleNational: '812345678', placeholder: '81 234 5678' },
  { iso2: 'VN', name: 'Vietnam', dialCode: '+84', exampleNational: '912345678', placeholder: '91 234 56 78' },
  { iso2: 'JP', name: 'Japan', dialCode: '+81', exampleNational: '9012345678', placeholder: '90-1234-5678' },
  { iso2: 'KR', name: 'South Korea', dialCode: '+82', exampleNational: '1012345678', placeholder: '10-1234-5678' },
  { iso2: 'NL', name: 'Netherlands', dialCode: '+31', exampleNational: '612345678', placeholder: '6 12345678' },
  { iso2: 'SE', name: 'Sweden', dialCode: '+46', exampleNational: '701234567', placeholder: '70-123 45 67' },
  { iso2: 'CH', name: 'Switzerland', dialCode: '+41', exampleNational: '781234567', placeholder: '78 123 45 67' },
  { iso2: 'IE', name: 'Ireland', dialCode: '+353', exampleNational: '851234567', placeholder: '85 123 4567' },
  { iso2: 'NZ', name: 'New Zealand', dialCode: '+64', exampleNational: '211234567', placeholder: '21 123 4567' },
];

export type PhoneValidationErrorCode =
  | 'empty'
  | 'invalid_characters'
  | 'country_code_mismatch'
  | 'missing_digits'
  | 'excess_digits'
  | 'invalid_bd_prefix'
  | 'invalid_number';

export interface PhoneValidationResult {
  valid: boolean;
  e164: string;
  nationalNumber: string;
  countryIso2: CountryCode;
  dialCode: string;
  formattedInternational: string;
  errorCode?: PhoneValidationErrorCode;
  error?: string;
}

export function getSupportedCountryMeta(countryIso2: string | undefined): SupportedPhoneCountry {
  const upper = String(countryIso2 || 'BD').trim().toUpperCase();
  return (
    SUPPORTED_PHONE_COUNTRIES.find((c) => c.iso2 === upper) || SUPPORTED_PHONE_COUNTRIES[0]
  );
}

/**
 * Infers the ISO2 country code and local/national input string from an existing saved E.164 phone number.
 */
export function splitSavedPhoneForCountryInput(
  savedPhoneRaw: string | undefined | null,
  fallbackCountry: CountryCode = 'BD'
): { countryIso2: CountryCode; localInput: string } {
  const raw = String(savedPhoneRaw || '').trim();
  if (!raw) {
    return { countryIso2: fallbackCountry, localInput: '' };
  }
  const candidate = raw.startsWith('+') ? raw : `+${raw.replace(/^00/, '')}`;
  const parsed = parsePhoneNumberFromString(candidate);
  if (parsed) {
    if (parsed.country) {
      const matched = SUPPORTED_PHONE_COUNTRIES.find((c) => c.iso2 === parsed.country);
      if (matched) {
        return {
          countryIso2: matched.iso2,
          localInput: parsed.nationalNumber,
        };
      }
    }
    if (parsed.countryCallingCode) {
      const dial = `+${parsed.countryCallingCode}`;
      const byDial = SUPPORTED_PHONE_COUNTRIES.find((c) => c.dialCode === dial);
      if (byDial) {
        return {
          countryIso2: byDial.iso2,
          localInput: parsed.nationalNumber,
        };
      }
    }
  }
  if (raw.startsWith('+880')) {
    return { countryIso2: 'BD', localInput: raw.slice(4) };
  }
  if (/^01\d{9}$/.test(raw)) {
    return { countryIso2: 'BD', localInput: raw.slice(1) };
  }
  return { countryIso2: fallbackCountry, localInput: raw };
}

/**
 * Country-aware international phone number validator & E.164 normalizer.
 *
 * Strictly enforces:
 * - Bangladesh (`BD`, `+880`):
 *   - Standard mobile format: `+8801XXXXXXXXX` (`+880` + 10 national significant digits = 13 digits excluding `+`).
 *   - Valid Bangladesh mobile operator prefixes: `13`, `14`, `15`, `16`, `17`, `18`, `19`.
 *   - Normalizes local `01XXXXXXXXX` (11 digits) or `1XXXXXXXXX` (10 digits) or `8801XXXXXXXXX` -> `+8801XXXXXXXXX`.
 *   - Rejects missing digits, excess digits (e.g. `+88001...` if extra digits remain or >10 national digits), wrong calling code, or non-mobile prefixes.
 * - All supported international countries via `libphonenumber-js` `isValid()` + calling-code match.
 * - NEVER marks ownership verified — format validation and OTP verification are strictly separate.
 */
export function validateAndNormalizePhone(
  rawInput: string,
  selectedCountry: CountryCode = 'BD'
): PhoneValidationResult {
  const countryMeta = getSupportedCountryMeta(selectedCountry);
  const iso2 = countryMeta.iso2;
  const expectedCallingCode = getCountryCallingCode(iso2);
  const dialCode = `+${expectedCallingCode}`;

  const trimmed = String(rawInput || '').trim();
  if (!trimmed) {
    return {
      valid: false,
      e164: '',
      nationalNumber: '',
      countryIso2: iso2,
      dialCode,
      formattedInternational: '',
      errorCode: 'empty',
      error:
        iso2 === 'BD'
          ? 'Please enter a valid Bangladesh mobile number.'
          : `Please enter a valid ${countryMeta.name} phone number.`,
    };
  }

  // Reject letters or unexpected symbols (allow digits, +, spaces, hyphens, parentheses, dots)
  if (!/^[+\d\s\-().]+$/.test(trimmed)) {
    return {
      valid: false,
      e164: '',
      nationalNumber: '',
      countryIso2: iso2,
      dialCode,
      formattedInternational: '',
      errorCode: 'invalid_characters',
      error:
        iso2 === 'BD'
          ? 'Please enter a valid Bangladesh mobile number.'
          : 'Phone number contains invalid characters. Use digits only.',
    };
  }

  // Strip formatting characters while keeping a leading '+' if present
  const hasLeadingPlus = trimmed.startsWith('+') || trimmed.startsWith('00');
  const digitsOnly = trimmed.replace(/\D/g, '');
  if (!digitsOnly) {
    return {
      valid: false,
      e164: '',
      nationalNumber: '',
      countryIso2: iso2,
      dialCode,
      formattedInternational: '',
      errorCode: 'empty',
      error:
        iso2 === 'BD'
          ? 'Please enter a valid Bangladesh mobile number.'
          : `Please enter a valid ${countryMeta.name} phone number.`,
    };
  }

  const normalizedDigitsAfter00 = trimmed.startsWith('00') ? digitsOnly.slice(2) : digitsOnly;

  // If user typed an explicit international prefix (+ or 00), verify calling code matches selectedCountry
  if (hasLeadingPlus) {
    if (!normalizedDigitsAfter00.startsWith(expectedCallingCode)) {
      const parsedAny = parsePhoneNumberFromString(`+${normalizedDigitsAfter00}`);
      const detectedDial = parsedAny?.countryCallingCode ? `+${parsedAny.countryCallingCode}` : 'another country code';
      return {
        valid: false,
        e164: '',
        nationalNumber: '',
        countryIso2: iso2,
        dialCode,
        formattedInternational: '',
        errorCode: 'country_code_mismatch',
        error: `Number starts with ${detectedDial}, which does not match ${countryMeta.name} (${dialCode}). Select the matching country or enter a ${dialCode} number.`,
      };
    }
  }

  // Dedicated strict Bangladesh (+880) validation rules
  if (iso2 === 'BD') {
    let national = normalizedDigitsAfter00;
    if (hasLeadingPlus && national.startsWith('880')) {
      national = national.slice(3);
      // Reject accidentaltrunk zero after explicit +880 if user typed +88001712345678 (11 digits after +880 -> excess digit!)
      if (national.startsWith('0')) {
        return {
          valid: false,
          e164: '',
          nationalNumber: national,
          countryIso2: 'BD',
          dialCode: '+880',
          formattedInternational: '',
          errorCode: 'excess_digits',
          error: 'Please enter a valid Bangladesh mobile number (omit the leading 0 after +880, e.g. +880 1712-345678).',
        };
      }
    } else if (!hasLeadingPlus) {
      if (national.startsWith('880') && national.length >= 12) {
        national = national.slice(3);
        if (national.startsWith('0')) {
          return {
            valid: false,
            e164: '',
            nationalNumber: national,
            countryIso2: 'BD',
            dialCode: '+880',
            formattedInternational: '',
            errorCode: 'excess_digits',
            error: 'Please enter a valid Bangladesh mobile number.',
          };
        }
      } else if (national.startsWith('0')) {
        // Local format: 01XXXXXXXXX (11 digits) -> strip trunk '0' to 1XXXXXXXXX (10 national digits)
        national = national.slice(1);
      }
    }

    if (national.length < 10) {
      return {
        valid: false,
        e164: '',
        nationalNumber: national,
        countryIso2: 'BD',
        dialCode: '+880',
        formattedInternational: '',
        errorCode: 'missing_digits',
        error: 'Please enter a valid Bangladesh mobile number (10 digits after +880, e.g. 1712-345678).',
      };
    }

    if (national.length > 10) {
      return {
        valid: false,
        e164: '',
        nationalNumber: national,
        countryIso2: 'BD',
        dialCode: '+880',
        formattedInternational: '',
        errorCode: 'excess_digits',
        error: 'Please enter a valid Bangladesh mobile number (too many digits entered).',
      };
    }

    // Must start with valid Bangladesh mobile operator prefix 13–19
    if (!/^1[3-9]\d{8}$/.test(national)) {
      return {
        valid: false,
        e164: '',
        nationalNumber: national,
        countryIso2: 'BD',
        dialCode: '+880',
        formattedInternational: '',
        errorCode: 'invalid_bd_prefix',
        error: 'Please enter a valid Bangladesh mobile number starting with 013–019.',
      };
    }

    const candidateE164 = `+880${national}`;
    const parsedBd = parsePhoneNumberFromString(candidateE164, 'BD');
    if (!parsedBd || !parsedBd.isValid() || parsedBd.country !== 'BD') {
      return {
        valid: false,
        e164: '',
        nationalNumber: national,
        countryIso2: 'BD',
        dialCode: '+880',
        formattedInternational: '',
        errorCode: 'invalid_number',
        error: 'Please enter a valid Bangladesh mobile number.',
      };
    }

    return {
      valid: true,
      e164: parsedBd.number, // +8801XXXXXXXXX (14 chars including +, 13 digits)
      nationalNumber: parsedBd.nationalNumber,
      countryIso2: 'BD',
      dialCode: '+880',
      formattedInternational: parsedBd.formatInternational(),
    };
  }

  // International country validation via libphonenumber-js
  const parseInput = hasLeadingPlus ? `+${normalizedDigitsAfter00}` : trimmed;
  const parsed = parsePhoneNumberFromString(parseInput, iso2);

  if (!parsed || !parsed.isValid()) {
    // Check if length looks too short or too long for clearer feedback
    const isTooShort = normalizedDigitsAfter00.length < 7;
    const isTooLong = normalizedDigitsAfter00.length > 15;
    return {
      valid: false,
      e164: '',
      nationalNumber: parsed?.nationalNumber || '',
      countryIso2: iso2,
      dialCode,
      formattedInternational: '',
      errorCode: isTooShort ? 'missing_digits' : isTooLong ? 'excess_digits' : 'invalid_number',
      error: `Please enter a valid ${countryMeta.name} phone number (${dialCode} ${countryMeta.placeholder}).`,
    };
  }

  if (parsed.countryCallingCode !== expectedCallingCode) {
    return {
      valid: false,
      e164: '',
      nationalNumber: parsed.nationalNumber,
      countryIso2: iso2,
      dialCode,
      formattedInternational: '',
      errorCode: 'country_code_mismatch',
      error: `Phone number does not match selected country ${countryMeta.name} (${dialCode}).`,
    };
  }

  return {
    valid: true,
    e164: parsed.number,
    nationalNumber: parsed.nationalNumber,
    countryIso2: iso2,
    dialCode,
    formattedInternational: parsed.formatInternational(),
  };
}

export type PhoneVerificationUiStatus =
  | 'empty'
  | 'invalid'
  | 'valid_unverified'
  | 'verification_pending'
  | 'verified'
  | 'verification_failed';

export interface PhoneVerificationUiState {
  status: PhoneVerificationUiStatus;
  badgeLabel: string;
  primaryMessage: string;
  secondaryMessage?: string;
  isOwnershipVerified: boolean;
}

/**
 * Computes honest UI verification state, strictly separating format validity from OTP ownership verification.
 * Format validation NEVER sets `isOwnershipVerified: true`.
 */
export function resolvePhoneVerificationUiState(params: {
  validation: PhoneValidationResult;
  savedPhoneE164?: string | null;
  phoneVerifiedInDb?: boolean;
  otpSentPending?: boolean;
  otpFailedMessage?: string | null;
}): PhoneVerificationUiState {
  const {
    validation,
    savedPhoneE164,
    phoneVerifiedInDb = false,
    otpSentPending = false,
    otpFailedMessage = null,
  } = params;

  if (validation.errorCode === 'empty') {
    return {
      status: 'empty',
      badgeLabel: 'Required',
      primaryMessage: 'Select your country code and enter your mobile number.',
      isOwnershipVerified: false,
    };
  }

  if (!validation.valid) {
    return {
      status: 'invalid',
      badgeLabel: 'Invalid Number',
      primaryMessage: validation.error || 'Invalid phone number format.',
      isOwnershipVerified: false,
    };
  }

  // Ownership is ONLY verified when phoneVerifiedInDb === true AND the normalized E.164 matches savedPhoneE164
  const cleanSaved = String(savedPhoneE164 || '').trim();
  if (phoneVerifiedInDb && cleanSaved && cleanSaved === validation.e164) {
    return {
      status: 'verified',
      badgeLabel: 'Verified',
      primaryMessage: 'Phone number successfully verified.',
      isOwnershipVerified: true,
    };
  }

  if (otpFailedMessage && otpFailedMessage.trim().length > 0) {
    return {
      status: 'verification_failed',
      badgeLabel: 'Verification Failed',
      primaryMessage: otpFailedMessage.trim(),
      secondaryMessage: 'Phone number verification required.',
      isOwnershipVerified: false,
    };
  }

  if (otpSentPending) {
    return {
      status: 'verification_pending',
      badgeLabel: 'Verification Pending',
      primaryMessage: `Enter the 6-digit SMS code sent to ${validation.e164}.`,
      secondaryMessage: 'Phone number verification required.',
      isOwnershipVerified: false,
    };
  }

  return {
    status: 'valid_unverified',
    badgeLabel: 'Valid Format',
    primaryMessage: 'Valid phone number format.',
    secondaryMessage: 'Phone number verification required.',
    isOwnershipVerified: false,
  };
}

export type PhoneFormatUiStatus = 'empty' | 'invalid' | 'valid_unsaved' | 'format_validated';

export interface PhoneFormatUiState {
  status: PhoneFormatUiStatus;
  badgeLabel: string;
  primaryMessage: string;
  secondaryMessage?: string;
  isFormatValidated: boolean;
  isOwnershipVerified: false;
}

/**
 * Computes OTP-free Account Settings / Registration phone validation state.
 * - Uses strict country-code + libphonenumber-js format validation (`+8801XXXXXXXXX` for BD, E.164 for international).
 * - Displays "Format Validated" once saved (or "Valid Format" while typing a valid number).
 * - Strictly keeps `isOwnershipVerified: false` so format validation NEVER grants OTP/KYC/NID ownership verification.
 */
export function resolvePhoneFormatValidationUiState(params: {
  validation: PhoneValidationResult;
  savedPhoneE164?: string | null;
}): PhoneFormatUiState {
  const { validation, savedPhoneE164 } = params;

  if (validation.errorCode === 'empty') {
    return {
      status: 'empty',
      badgeLabel: 'Not Set',
      primaryMessage: 'Select your country code and enter your mobile number.',
      isFormatValidated: false,
      isOwnershipVerified: false,
    };
  }

  if (!validation.valid) {
    return {
      status: 'invalid',
      badgeLabel: 'Invalid Number',
      primaryMessage: validation.error || 'Invalid phone number format.',
      isFormatValidated: false,
      isOwnershipVerified: false,
    };
  }

  const cleanSaved = String(savedPhoneE164 || '').trim();
  if (cleanSaved && cleanSaved === validation.e164) {
    return {
      status: 'format_validated',
      badgeLabel: 'Format Validated',
      primaryMessage: 'International phone format validated and saved in E.164.',
      isFormatValidated: true,
      isOwnershipVerified: false,
    };
  }

  return {
    status: 'valid_unsaved',
    badgeLabel: 'Format Validated',
    primaryMessage: cleanSaved
      ? 'Valid international phone format — click Save Phone Number to update.'
      : 'Valid international phone format.',
    isFormatValidated: true,
    isOwnershipVerified: false,
  };
}

