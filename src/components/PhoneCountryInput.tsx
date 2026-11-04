import React, { useMemo } from 'react';
import type { CountryCode } from 'libphonenumber-js';
import { AlertCircle, CheckCircle2, Clock, Phone, ShieldAlert } from 'lucide-react';
import {
  getSupportedCountryMeta,
  resolvePhoneFormatValidationUiState,
  resolvePhoneVerificationUiState,
  SUPPORTED_PHONE_COUNTRIES,
  validateAndNormalizePhone,
} from '../lib/phoneValidation';

interface PhoneCountryInputProps {
  idPrefix: string;
  label?: string;
  countryIso2: CountryCode;
  onCountryChange: (country: CountryCode) => void;
  phoneValue: string;
  onPhoneChange: (val: string) => void;
  savedPhoneE164?: string | null;
  phoneVerifiedInDb?: boolean;
  otpSentPending?: boolean;
  otpFailedMessage?: string | null;
  formatValidationOnly?: boolean;
  disabled?: boolean;
  required?: boolean;
  showStatusBanner?: boolean;
}

export const PhoneCountryInput: React.FC<PhoneCountryInputProps> = ({
  idPrefix,
  label = 'Mobile Phone Number',
  countryIso2,
  onCountryChange,
  phoneValue,
  onPhoneChange,
  savedPhoneE164 = null,
  phoneVerifiedInDb = false,
  otpSentPending = false,
  otpFailedMessage = null,
  formatValidationOnly = true,
  disabled = false,
  required = true,
  showStatusBanner = true,
}) => {
  const countryMeta = useMemo(() => getSupportedCountryMeta(countryIso2), [countryIso2]);
  const validation = useMemo(
    () => validateAndNormalizePhone(phoneValue, countryIso2),
    [phoneValue, countryIso2]
  );
  const uiState = useMemo(() => {
    if (formatValidationOnly) {
      const fmtState = resolvePhoneFormatValidationUiState({
        validation,
        savedPhoneE164,
      });
      return {
        status: fmtState.status,
        badgeLabel: fmtState.badgeLabel,
        primaryMessage: fmtState.primaryMessage,
        secondaryMessage: fmtState.secondaryMessage,
      };
    }
    return resolvePhoneVerificationUiState({
      validation,
      savedPhoneE164,
      phoneVerifiedInDb,
      otpSentPending,
      otpFailedMessage,
    });
  }, [
    formatValidationOnly,
    validation,
    savedPhoneE164,
    phoneVerifiedInDb,
    otpSentPending,
    otpFailedMessage,
  ]);

  const hasTyped = phoneValue.trim().length > 0;
  const isPositiveStatus =
    uiState.status === 'verified' ||
    uiState.status === 'format_validated' ||
    uiState.status === 'valid_unsaved';
  const isErrorStatus =
    uiState.status === 'invalid' || uiState.status === 'verification_failed';

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={`${idPrefix}-phone`} className="bx-label !mb-0">
          {label}
          {required ? ' *' : ''}
        </label>

        {hasTyped && (
          <span
            data-testid={`${idPrefix}-phone-status-badge`}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-extrabold"
            style={
              isPositiveStatus
                ? {
                    background: 'var(--green-soft)',
                    borderColor: 'var(--green)',
                    color: 'var(--green)',
                  }
                : isErrorStatus
                ? {
                    background: 'var(--red-soft)',
                    borderColor: 'var(--red)',
                    color: 'var(--red)',
                  }
                : {
                    background: 'var(--yellow-soft)',
                    borderColor: 'var(--orange)',
                    color: '#6E5600',
                  }
            }
          >
            {isPositiveStatus ? (
              <CheckCircle2 className="w-3 h-3 shrink-0" />
            ) : isErrorStatus ? (
              <AlertCircle className="w-3 h-3 shrink-0" />
            ) : uiState.status === 'verification_pending' ? (
              <Clock className="w-3 h-3 shrink-0" />
            ) : (
              <Phone className="w-3 h-3 shrink-0" />
            )}
            <span>{uiState.badgeLabel}</span>
          </span>
        )}
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <div className="sm:w-52 shrink-0">
          <label htmlFor={`${idPrefix}-country`} className="sr-only">
            Country Dialing Code
          </label>
          <select
            id={`${idPrefix}-country`}
            aria-label="Country Dialing Code"
            value={countryIso2}
            disabled={disabled}
            onChange={(e) => onCountryChange(e.target.value as CountryCode)}
            className="bx-select text-xs font-extrabold h-full"
          >
            {SUPPORTED_PHONE_COUNTRIES.map((c) => (
              <option key={c.iso2} value={c.iso2}>
                {c.name} ({c.dialCode})
              </option>
            ))}
          </select>
        </div>

        <div className="relative flex-1 min-w-0">
          <span
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs font-extrabold select-none tabular-nums"
            style={{ color: 'var(--text-2)' }}
          >
            {countryMeta.dialCode}
          </span>
          <input
            id={`${idPrefix}-phone`}
            type="tel"
            autoComplete="tel-national"
            inputMode="tel"
            value={phoneValue}
            disabled={disabled}
            required={required}
            onChange={(e) => onPhoneChange(e.target.value)}
            placeholder={
              countryIso2 === 'BD'
                ? '1712-345678 or 01712345678'
                : countryMeta.placeholder
            }
            className="bx-input !pl-14 tabular-nums"
          />
        </div>
      </div>

      {showStatusBanner && hasTyped && (
        <div
          data-testid={`${idPrefix}-phone-feedback`}
          role={isErrorStatus ? 'alert' : 'status'}
          className="rounded-xl border px-3 py-2 text-xs font-semibold leading-snug space-y-0.5"
          style={
            isPositiveStatus
              ? {
                  background: 'var(--green-soft)',
                  borderColor: 'var(--green)',
                  color: 'var(--green)',
                }
              : isErrorStatus
              ? {
                  background: 'var(--red-soft)',
                  borderColor: 'var(--red)',
                  color: 'var(--red)',
                }
              : {
                  background: 'var(--surface-2)',
                  borderColor: 'var(--border-soft)',
                  color: 'var(--text)',
                }
          }
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-extrabold inline-flex items-center gap-1.5">
              {isErrorStatus && <ShieldAlert className="w-3.5 h-3.5 shrink-0" />}
              <span>{uiState.primaryMessage}</span>
            </span>
            {validation.valid && (
              <span className="font-mono text-[11px] font-bold opacity-85 tabular-nums">
                E.164: {validation.e164}
              </span>
            )}
          </div>
          {uiState.secondaryMessage && (
            <p className="text-[11px] font-bold opacity-80">{uiState.secondaryMessage}</p>
          )}
        </div>
      )}
    </div>
  );
};
