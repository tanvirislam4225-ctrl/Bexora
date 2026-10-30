import React, { useEffect, useState } from 'react';
import {
  applyActionCode,
  confirmPasswordReset,
  verifyPasswordResetCode,
} from 'firebase/auth';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { CheckCircle2, Eye, EyeOff, KeyRound, MailCheck, ShieldAlert, X } from 'lucide-react';
import { auth, db, formatFirebaseAuthError, safeRefreshCurrentUserToken } from '../lib/firebase';
import { validateStrongPassword } from '../lib/marketplaceLogic';
import { emitUserNotification } from '../lib/notificationService';
import { BexoraLogo } from './Icons';

export interface FirebaseAuthActionParams {
  mode: 'verifyEmail' | 'resetPassword';
  oobCode: string;
}

interface FirebaseAuthActionModalProps {
  action: FirebaseAuthActionParams;
  onClose: () => void;
  onVerifiedEmail: () => Promise<void> | void;
  onOpenSignIn: () => void;
  onOpenForgotPassword: () => void;
}

export const FirebaseAuthActionModal: React.FC<FirebaseAuthActionModalProps> = ({
  action,
  onClose,
  onVerifiedEmail,
  onOpenSignIn,
  onOpenForgotPassword,
}) => {
  const [status, setStatus] = useState<'verifying' | 'ready' | 'submitting' | 'success' | 'error'>(
    'verifying'
  );
  const [targetEmail, setTargetEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    let active = true;

    async function handleInitialAction() {
      if (!action.oobCode || action.oobCode.trim().length < 6) {
        if (!active) return;
        setErrorMessage(
          'This email action link is incomplete or invalid. Please request a fresh link.'
        );
        setStatus('error');
        return;
      }

      if (action.mode === 'verifyEmail') {
        try {
          await applyActionCode(auth, action.oobCode);
          if (auth.currentUser) {
            const refreshRes = await safeRefreshCurrentUserToken();
            if (refreshRes.tokenRefreshed) {
              try {
                await updateDoc(doc(db, 'privateUsers', auth.currentUser.uid), {
                  emailVerified: true,
                  updatedAt: serverTimestamp(),
                });
              } catch {
                // Ignore if signed into a different account or profile not yet initialized
              }
            }
            await emitUserNotification({
              recipientId: auth.currentUser.uid,
              eventKey: 'email_verified_confirmed',
              category: 'verification',
              severity: 'success',
              title: 'Email Address Verified',
              preview: 'Your email address has been verified via Firebase Authentication.',
              body: `Your BEXORA account email (${auth.currentUser.email || 'primary email'}) is now verified. Verified email status strengthens your account security and trader trust profile.`,
              refType: 'profile',
              refId: auth.currentUser.uid,
              referenceLabel: 'Email Verification',
              destination: 'profile',
            });
          }
          if (!active) return;
          setStatus('success');
          await onVerifiedEmail();
        } catch (err) {
          if (!active) return;
          setErrorMessage(formatFirebaseAuthError(err));
          setStatus('error');
        }
        return;
      }

      if (action.mode === 'resetPassword') {
        try {
          const email = await verifyPasswordResetCode(auth, action.oobCode);
          if (!active) return;
          setTargetEmail(email);
          setStatus('ready');
        } catch (err) {
          if (!active) return;
          setErrorMessage(formatFirebaseAuthError(err));
          setStatus('error');
        }
      }
    }

    handleInitialAction();
    return () => {
      active = false;
    };
  }, [action.mode, action.oobCode]);

  const handleConfirmReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage('');
    const pwdCheck = validateStrongPassword(newPassword);
    if (!pwdCheck.valid) {
      setErrorMessage(pwdCheck.error || 'New password must be at least 8 characters with letters and numbers.');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setErrorMessage('New password and Confirm password do not match.');
      return;
    }

    setStatus('submitting');
    try {
      await confirmPasswordReset(auth, action.oobCode, newPassword);
      if (auth.currentUser && (!targetEmail || auth.currentUser.email?.toLowerCase() === targetEmail.toLowerCase())) {
        await emitUserNotification({
          recipientId: auth.currentUser.uid,
          eventKey: `password_reset_${Date.now()}`,
          category: 'security',
          severity: 'warning',
          title: 'Account Password Reset Completed',
          preview: 'Your BEXORA account password was reset using a verified email link.',
          body: `Your password for ${targetEmail || 'your BEXORA account'} was just reset via a Firebase Authentication recovery link. If you did not perform this change, secure your email inbox immediately.`,
          refType: 'profile',
          refId: auth.currentUser.uid,
          referenceLabel: 'Security Alert',
          destination: 'profile:settings',
        });
      }
      setStatus('success');
    } catch (err) {
      setErrorMessage(formatFirebaseAuthError(err));
      setStatus('ready');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/65 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={
        action.mode === 'verifyEmail' ? 'Email verification' : 'Reset forgotten password'
      }
    >
      <div
        className="bx-card w-full max-w-md max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-2xl p-5 sm:p-6 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <BexoraLogo compact />
          <button
            type="button"
            onClick={onClose}
            className="bx-icon-btn !w-9 !h-9"
            aria-label="Close action dialog"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-1">
          <h2 className="text-lg font-extrabold flex items-center gap-2">
            {action.mode === 'verifyEmail' ? (
              <>
                <MailCheck className="w-5 h-5" style={{ color: 'var(--orange)' }} />
                <span>Verify Email Address</span>
              </>
            ) : (
              <>
                <KeyRound className="w-5 h-5" style={{ color: 'var(--orange)' }} />
                <span>Set a New Password</span>
              </>
            )}
          </h2>
          {targetEmail && (
            <p className="bx-hint">
              Account: <strong>{targetEmail}</strong>
            </p>
          )}
        </div>

        {status === 'verifying' && (
          <div className="p-4 rounded-xl bx-soft text-xs font-bold">
            Validating your secure Firebase email link…
          </div>
        )}

        {status === 'error' && (
          <div className="space-y-4">
            <div
              className="p-3.5 rounded-xl text-xs font-bold leading-relaxed flex items-start gap-2.5"
              style={{ background: 'var(--red-soft)', color: 'var(--red)' }}
              role="alert"
            >
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{errorMessage}</span>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              {action.mode === 'resetPassword' ? (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenForgotPassword();
                  }}
                  className="bx-btn bx-btn-primary flex-1 justify-center"
                >
                  Request a New Reset Link
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onClose}
                  className="bx-btn bx-btn-primary flex-1 justify-center"
                >
                  Continue to BEXORA
                </button>
              )}
              <button type="button" onClick={onClose} className="bx-btn justify-center">
                Close
              </button>
            </div>
          </div>
        )}

        {action.mode === 'verifyEmail' && status === 'success' && (
          <div className="space-y-4">
            <div
              className="p-3.5 rounded-xl text-xs font-bold leading-relaxed flex items-start gap-2.5"
              style={{ background: 'var(--green-soft)', color: 'var(--green)' }}
              role="status"
            >
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                Your email address has been verified via Firebase Authentication and your security
                token is refreshed.
              </span>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="bx-btn bx-btn-primary w-full justify-center"
            >
              Continue to BEXORA
            </button>
          </div>
        )}

        {action.mode === 'resetPassword' && (status === 'ready' || status === 'submitting') && (
          <form onSubmit={handleConfirmReset} className="space-y-3.5">
            {errorMessage && (
              <div
                className="p-3 rounded-xl text-xs font-bold leading-relaxed"
                style={{ background: 'var(--red-soft)', color: 'var(--red)' }}
                role="alert"
              >
                {errorMessage}
              </div>
            )}

            <div>
              <label htmlFor="oob-new-password" className="bx-label">
                New Password
              </label>
              <div className="relative">
                <input
                  id="oob-new-password"
                  type={showNewPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Minimum 8 characters (letters & numbers)"
                  className="bx-input !pr-12"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowNewPassword((v) => !v)}
                  aria-label={showNewPassword ? 'Hide new password' : 'Show new password'}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg"
                  style={{ color: 'var(--text-2)' }}
                >
                  {showNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label htmlFor="oob-confirm-password" className="bx-label">
                Confirm New Password
              </label>
              <div className="relative">
                <input
                  id="oob-confirm-password"
                  type={showConfirmPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={confirmNewPassword}
                  onChange={(e) => setConfirmNewPassword(e.target.value)}
                  placeholder="Re-enter new password"
                  className="bx-input !pr-12"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword((v) => !v)}
                  aria-label={showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg"
                  style={{ color: 'var(--text-2)' }}
                >
                  {showConfirmPassword ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={status === 'submitting'}
              className="bx-btn bx-btn-primary w-full justify-center"
            >
              {status === 'submitting' ? 'Updating password…' : 'Save New Password'}
            </button>
          </form>
        )}

        {action.mode === 'resetPassword' && status === 'success' && (
          <div className="space-y-4">
            <div
              className="p-3.5 rounded-xl text-xs font-bold leading-relaxed flex items-start gap-2.5"
              style={{ background: 'var(--green-soft)', color: 'var(--green)' }}
              role="status"
            >
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                Your password has been updated! You can now sign in with your new password.
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenSignIn();
              }}
              className="bx-btn bx-btn-primary w-full justify-center"
            >
              Sign In Now
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
