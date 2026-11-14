import { SIMPLE_EMAIL_REGEX, validateStrongPassword, validateUsername } from './marketplaceLogic';
import { validateAndNormalizePhone } from './phoneValidation';

export interface RegistrationValidationInput {
  fullName: string;
  username: string;
  phoneCountry?: string;
  phone: string;
  email: string;
  password: string;
  confirmPassword: string;
}

export interface RegistrationValidationResult {
  valid: boolean;
  cleanName: string;
  normalizedUsername: string;
  normalizedPhone: string;
  phoneCountryCode: string;
  cleanEmail: string;
  error?: string;
}

export function validateRegistrationInput(
  input: RegistrationValidationInput
): RegistrationValidationResult {
  const cleanName = String(input.fullName || '').trim();
  const unameCheck = validateUsername(input.username || '');
  const selectedCountry = (String(input.phoneCountry || 'BD').trim().toUpperCase() || 'BD') as Parameters<
    typeof validateAndNormalizePhone
  >[1];
  const phoneCheck = validateAndNormalizePhone(input.phone || '', selectedCountry);
  const normalizedPhone = phoneCheck.valid
    ? phoneCheck.e164
    : String(input.phone || '').trim().replace(/[\s-]/g, '');
  const cleanEmail = String(input.email || '').trim().toLowerCase();

  if (cleanName.length < 2 || cleanName.length > 80) {
    return {
      valid: false,
      cleanName,
      normalizedUsername: unameCheck.normalized,
      normalizedPhone,
      phoneCountryCode: phoneCheck.dialCode,
      cleanEmail,
      error: 'Full name must be between 2 and 80 characters.',
    };
  }

  if (!unameCheck.valid) {
    return {
      valid: false,
      cleanName,
      normalizedUsername: unameCheck.normalized,
      normalizedPhone,
      phoneCountryCode: phoneCheck.dialCode,
      cleanEmail,
      error: unameCheck.error || 'Invalid username.',
    };
  }

  if (!phoneCheck.valid) {
    return {
      valid: false,
      cleanName,
      normalizedUsername: unameCheck.normalized,
      normalizedPhone,
      phoneCountryCode: phoneCheck.dialCode,
      cleanEmail,
      error: phoneCheck.error || 'Please enter a valid mobile number.',
    };
  }

  if (!cleanEmail || !SIMPLE_EMAIL_REGEX.test(cleanEmail) || cleanEmail.length > 160) {
    return {
      valid: false,
      cleanName,
      normalizedUsername: unameCheck.normalized,
      normalizedPhone,
      phoneCountryCode: phoneCheck.dialCode,
      cleanEmail,
      error: 'Enter a valid email address.',
    };
  }

  const pwdCheck = validateStrongPassword(input.password || '');
  if (!pwdCheck.valid) {
    return {
      valid: false,
      cleanName,
      normalizedUsername: unameCheck.normalized,
      normalizedPhone,
      phoneCountryCode: phoneCheck.dialCode,
      cleanEmail,
      error:
        pwdCheck.error ||
        'Password must be at least 8 characters long and include both letters and numbers.',
    };
  }

  if (input.password !== input.confirmPassword) {
    return {
      valid: false,
      cleanName,
      normalizedUsername: unameCheck.normalized,
      normalizedPhone,
      phoneCountryCode: phoneCheck.dialCode,
      cleanEmail,
      error: 'Password and Confirm Password do not match.',
    };
  }

  return {
    valid: true,
    cleanName,
    normalizedUsername: unameCheck.normalized,
    normalizedPhone: phoneCheck.e164,
    phoneCountryCode: phoneCheck.dialCode,
    cleanEmail,
  };
}
