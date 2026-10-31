import React, { useCallback, useEffect, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  updateProfile,
  User,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import {
  auth,
  clearPendingSignupProfile,
  db,
  detectFirebaseAuthCapabilities,
  ensureUserProfileInitialized,
  FirebaseAuthCapabilities,
  formatFirebaseAuthError,
  googleProvider,
  recordLiveEmailPasswordOutcome,
  registerPendingSignupProfile,
  safeSendEmailVerification,
  safeSendPasswordResetEmail,
  syncProactiveRefreshWithCapabilities,
} from '../lib/firebase';
import { BexoraLogo } from './Icons';
import {
  isPrivacySafeResetError,
  validateLoginInput,
  validatePasswordResetInput,
  validateRegistrationInput,
  validateStrongPassword,
} from '../lib/marketplaceLogic';
import {
  describePendingAuthIntent,
  PendingAuthIntent,
} from '../lib/checkoutAndIntentLogic';

interface AuthModalProps {
  initialMode?: 'login' | 'register' | 'forgot';
  pendingIntent?: PendingAuthIntent | null;
  onModeChange?: (mode: 'login' | 'register' | 'forgot') => void;
  onClose: () => void;
  onSuccess: (msg: string) => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  initialMode = 'login',
  pendingIntent = null,
  onModeChange,
  onClose,
  onSuccess,
}) => {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>(initialMode);

  // Independent Login state
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);

  // Independent Registration state
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [phone, setPhone] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showRegPassword, setShowRegPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [registerBusy, setRegisterBusy] = useState(false);
  const [partialSignupUid, setPartialSignupUid] = useState<string | null>(null);

  // Independent Forgot Password & Google Sign-In states
  const [recoveryTarget, setRecoveryTarget] = useState('');
  const [forgotBusy, setForgotBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);

  const [checkingCaps, setCheckingCaps] = useState(false);
  const [resetCooldownSec, setResetCooldownSec] = useState(0);
  const [capabilities, setCapabilities] = useState<FirebaseAuthCapabilities | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const isAnyBusy = loginBusy || registerBusy || forgotBusy || googleBusy;

  const clearFeedbackAndVisibility = useCallback(() => {
    setError('');
    setInfo('');
    setShowLoginPassword(false);
    setShowRegPassword(false);
    setShowConfirmPassword(false);
  }, []);

  const switchMode = useCallback(
    (nextMode: 'login' | 'register' | 'forgot') => {
      if (isAnyBusy) return;
      clearFeedbackAndVisibility();
      if (nextMode === 'forgot' && !recoveryTarget.trim() && loginEmail.trim()) {
        setRecoveryTarget(loginEmail.trim());
      }
      setMode(nextMode);
      onModeChange?.(nextMode);
    },
    [isAnyBusy, clearFeedbackAndVisibility, recoveryTarget, loginEmail, onModeChange]
  );

  useEffect(() => {
    setMode(initialMode);
    clearFeedbackAndVisibility();
  }, [initialMode, clearFeedbackAndVisibility]);

  useEffect(() => {
    if (resetCooldownSec <= 0) return;
    const timer = window.setInterval(() => {
      setResetCooldownSec((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resetCooldownSec]);

  useEffect(() => {
    let active = true;
    detectFirebaseAuthCapabilities().then((caps) => {
      if (active) setCapabilities(caps);
    });

    const handleWindowFocus = () => {
      detectFirebaseAuthCapabilities(true).then((caps) => {
        if (active) setCapabilities(caps);
      });
    };
    window.addEventListener('focus', handleWindowFocus);
    return () => {
      active = false;
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, []);

  const handleRecheckProviders = async () => {
    if (checkingCaps) return;
    setCheckingCaps(true);
    setError('');
    try {
      const caps = await detectFirebaseAuthCapabilities(true);
      setCapabilities(caps);
      if (caps.emailPasswordStatus === 'enabled') {
        setInfo('Direct Email/Password sign-in is active. You can sign in or create an account below.');
      } else if (caps.emailPasswordStatus === 'unable_to_verify') {
        setInfo('Could not verify sign-in status right now due to network connectivity. You can still submit the form directly or use Connect with Google.');
      } else {
        setInfo('Direct Email/Password sign-in is currently unavailable. Click Connect with Google above to sign in or create your account immediately.');
      }
    } finally {
      setCheckingCaps(false);
    }
  };

  const syncProviderOutcomeFromError = (err: unknown) => {
    const raw = err instanceof Error ? err.message : String(err || '');
    if (
      raw.includes('PASSWORD_LOGIN_DISABLED') ||
      raw.includes('auth/operation-not-allowed') ||
      raw.includes('OPERATION_NOT_ALLOWED')
    ) {
      const updated = recordLiveEmailPasswordOutcome('disabled');
      if (updated) setCapabilities(updated);
    }
  };

  const emailProviderStatus = capabilities?.emailPasswordStatus ?? null;
  const emailProviderConfirmedDisabled = emailProviderStatus === 'disabled';
  const emailProviderUnableToVerify = emailProviderStatus === 'unable_to_verify';
  const domainNotAuthorized = capabilities?.currentDomainAuthorized === false;

  const isLoginIncomplete = !loginEmail.trim() || !loginPassword;
  const isRegisterIncomplete =
    !fullName.trim() ||
    !username.trim() ||
    !phone.trim() ||
    !regEmail.trim() ||
    (!partialSignupUid && (!regPassword || !confirmPassword));
  const isForgotIncomplete = !recoveryTarget.trim();

  const regPasswordCheck = regPassword ? validateStrongPassword(regPassword) : null;
  const regPasswordsMismatch =
    Boolean(confirmPassword) && regPassword !== confirmPassword;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isAnyBusy) return;
    setError('');
    setInfo('');

    const validation = validateLoginInput(loginEmail, loginPassword);
    if (!validation.valid) {
      setError(validation.error || 'Enter a valid email address and password.');
      return;
    }

    setLoginBusy(true);
    try {
      const cred = await signInWithEmailAndPassword(auth, validation.cleanEmail, loginPassword);
      const updatedCaps = recordLiveEmailPasswordOutcome('enabled');
      if (updatedCaps) setCapabilities(updatedCaps);
      syncProactiveRefreshWithCapabilities(cred.user, Boolean(capabilities?.tokenServiceEnabled));
      await ensureUserProfileInitialized(cred.user);
      onSuccess('Signed in successfully.');
      onClose();
    } catch (err) {
      syncProviderOutcomeFromError(err);
      setError(formatFirebaseAuthError(err));
    } finally {
      setLoginBusy(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isAnyBusy) return;
    setError('');
    setInfo('');

    const existingMatchingUser: User | null =
      auth.currentUser &&
      ((partialSignupUid && auth.currentUser.uid === partialSignupUid) ||
        (auth.currentUser.email &&
          auth.currentUser.email.trim().toLowerCase() === regEmail.trim().toLowerCase()))
        ? auth.currentUser
        : null;

    const validation = validateRegistrationInput({
      fullName,
      username,
      phone,
      email: regEmail,
      password: existingMatchingUser && !regPassword ? 'RecoveryPass1' : regPassword,
      confirmPassword:
        existingMatchingUser && !confirmPassword ? 'RecoveryPass1' : confirmPassword,
    });

    if (!validation.valid) {
      setError(validation.error || 'Please review your registration details.');
      return;
    }

    setRegisterBusy(true);
    let createdOrMatchedUser: User | null = existingMatchingUser;
    try {
      // Pre-check username availability before creating or completing Auth profile
      const unameSnap = await getDoc(doc(db, 'usernames', validation.normalizedUsername));
      if (
        unameSnap.exists() &&
        (!createdOrMatchedUser || unameSnap.data()?.uid !== createdOrMatchedUser.uid)
      ) {
        setError(
          `Username "@${validation.normalizedUsername}" is already taken. Please choose another.`
        );
        return;
      }

      registerPendingSignupProfile(validation.cleanEmail, {
        displayName: validation.cleanName,
        username: validation.normalizedUsername,
        phone: validation.normalizedPhone,
      });

      if (!createdOrMatchedUser) {
        const cred = await createUserWithEmailAndPassword(
          auth,
          validation.cleanEmail,
          regPassword
        );
        createdOrMatchedUser = cred.user;
        const updatedCaps = recordLiveEmailPasswordOutcome('enabled');
        if (updatedCaps) setCapabilities(updatedCaps);
        syncProactiveRefreshWithCapabilities(
          cred.user,
          Boolean(capabilities?.tokenServiceEnabled)
        );
      }

      if (createdOrMatchedUser.displayName !== validation.cleanName) {
        await updateProfile(createdOrMatchedUser, { displayName: validation.cleanName });
      }

      await ensureUserProfileInitialized(createdOrMatchedUser, {
        displayName: validation.cleanName,
        username: validation.normalizedUsername,
        phone: validation.normalizedPhone,
      });

      setPartialSignupUid(null);

      let verificationNote = 'Verify your email anytime in Account Settings.';
      try {
        await safeSendEmailVerification(createdOrMatchedUser);
        verificationNote = `Verification link sent to ${validation.cleanEmail}! Check your inbox and Spam folder.`;
      } catch {
        // Non-blocking if rate-limited; user can trigger manual resend in Account Settings
      }

      onSuccess(`Account created! ${verificationNote}`);
      onClose();
    } catch (err) {
      clearPendingSignupProfile(validation.cleanEmail);
      syncProviderOutcomeFromError(err);

      if (createdOrMatchedUser) {
        setPartialSignupUid(createdOrMatchedUser.uid);
        if (err instanceof Error && err.message === 'USERNAME_TAKEN') {
          setError(
            `Your authentication account is ready, but "@${validation.normalizedUsername}" was just claimed. Pick another username and click Complete Profile Setup.`
          );
        } else {
          setError(
            `Your authentication account was created, and only marketplace profile setup remains (${formatFirebaseAuthError(
              err
            )}). Click Complete Profile Setup to finish without creating a duplicate account.`
          );
        }
      } else if (err instanceof Error && err.message === 'USERNAME_TAKEN') {
        setError(
          'That username was just claimed by another user. Please choose a different username.'
        );
      } else {
        setError(formatFirebaseAuthError(err));
      }
    } finally {
      setRegisterBusy(false);
    }
  };

  const handleGoogleSignIn = async () => {
    if (isAnyBusy) return;
    setError('');
    setInfo('');
    setGoogleBusy(true);
    try {
      const cred = await signInWithPopup(auth, googleProvider);
      syncProactiveRefreshWithCapabilities(cred.user, Boolean(capabilities?.tokenServiceEnabled));
      await ensureUserProfileInitialized(cred.user);
      onSuccess('Signed in with Google.');
      onClose();
    } catch (err) {
      setError(formatFirebaseAuthError(err));
    } finally {
      setGoogleBusy(false);
    }
  };

  const handlePasswordRecovery = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isAnyBusy || resetCooldownSec > 0) return;
    setError('');
    setInfo('');

    const validation = validatePasswordResetInput(recoveryTarget);
    if (!validation.valid) {
      setError(validation.error || 'Enter a valid registered email address.');
      return;
    }

    const privacySafeConfirmation =
      'If an account is registered with that email address, a secure password-reset link has been sent. Check your inbox and Spam folder.';

    setForgotBusy(true);
    try {
      await safeSendPasswordResetEmail(validation.cleanEmail);
      setResetCooldownSec(60);
      setInfo(privacySafeConfirmation);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (isPrivacySafeResetError(raw)) {
        setResetCooldownSec(60);
        setInfo(privacySafeConfirmation);
      } else {
        setError(formatFirebaseAuthError(err));
      }
    } finally {
      setForgotBusy(false);
    }
  };

  const currentHostLabel =
    typeof window !== 'undefined' && window.location?.hostname
      ? window.location.hostname
      : 'this domain';
  const isLocalDevHost =
    currentHostLabel === 'localhost' || currentHostLabel === '127.0.0.1';
  const errorIsProviderDisabled = error.includes('Authentication → Sign-in method');

  const intentBanner = describePendingAuthIntent(pendingIntent);

  return (
    <section className="bx-wrap py-6 sm:py-10 space-y-6" aria-label="Account authentication">
      {/* Top Back Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onClose}
          disabled={isAnyBusy}
          className="bx-btn bx-btn-sm inline-flex items-center gap-2"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>{intentBanner?.backLabel || 'Back to Marketplace'}</span>
        </button>

        <span className="bx-hint">
          Protected Firebase Authentication · Session &amp; Action Continuation Enabled
        </span>
      </div>

      {/* Saved Action Continuation Banner (shown when logged-out user clicked Buy Now, Place Bid, Message Seller, etc.) */}
      {intentBanner && (
        <div
          role="region"
          aria-label="Saved marketplace action"
          className="bx-card p-4 sm:p-5 flex items-start gap-3.5"
          style={{
            background: 'var(--yellow-soft)',
            borderColor: 'var(--orange)',
          }}
        >
          <div
            className="w-9 h-9 rounded-xl grid place-items-center shrink-0 text-white"
            style={{ background: 'var(--orange)' }}
          >
            <Lock className="w-4 h-4" />
          </div>
          <div className="space-y-1 min-w-0">
            <h2 className="text-sm sm:text-base font-extrabold">{intentBanner.heading}</h2>
            <p className="text-xs sm:text-sm font-semibold" style={{ color: 'var(--text-2)' }}>
              {intentBanner.detail}
            </p>
          </div>
        </div>
      )}

      {/* Full-Screen 2-Column Authentication Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left Column: BEXORA Account & Escrow Security Overview */}
        <div className="lg:col-span-5 space-y-5 order-2 lg:order-1">
          <div className="bx-card p-6 space-y-4">
            <div className="flex items-center gap-2.5">
              <BexoraLogo compact />
            </div>
            <h1 className="text-xl sm:text-2xl font-black leading-tight">
              Trade Verifiable Digital Assets with 3-Party Escrow Protection
            </h1>
            <p className="text-xs sm:text-sm leading-relaxed" style={{ color: 'var(--text-2)' }}>
              Your BEXORA account connects your public trader profile, BDT/USD escrow wallet, live bidding history, and private 3-party Deal Rooms.
            </p>

            <div className="space-y-3 pt-2 text-xs">
              <div className="p-3 rounded-xl bx-soft flex items-start gap-2.5">
                <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--green)' }} />
                <div>
                  <strong className="font-extrabold block">Seamless Action Continuation</strong>
                  <span style={{ color: 'var(--text-2)' }}>
                    Sign in or create an account and continue directly to your selected listing, saved bid, or Buy Now checkout.
                  </span>
                </div>
              </div>
              <div className="p-3 rounded-xl bx-soft flex items-start gap-2.5">
                <Lock className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--orange)' }} />
                <div>
                  <strong className="font-extrabold block">Protected Escrow Settlement</strong>
                  <span style={{ color: 'var(--text-2)' }}>
                    Funds remain locked in BEXORA Escrow until seller transfer proof is verified and the category protection window completes.
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Sign In / Create Account / Password Recovery Form Card */}
        <div className="lg:col-span-7 order-1 lg:order-2">
          <div className="bx-card p-5 sm:p-7 space-y-4">
            {/* Mode Switcher */}
            {mode !== 'forgot' ? (
              <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bx-soft" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'login'}
                  disabled={isAnyBusy}
                  onClick={() => switchMode('login')}
                  className="py-2.5 rounded-lg text-sm font-extrabold transition-colors"
                  style={{
                    background: mode === 'login' ? 'var(--surface)' : 'transparent',
                    color: mode === 'login' ? 'var(--text)' : 'var(--text-2)',
                  }}
                >
                  Sign In
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'register'}
                  disabled={isAnyBusy}
                  onClick={() => switchMode('register')}
                  className="py-2.5 rounded-lg text-sm font-extrabold transition-colors"
                  style={{
                    background: mode === 'register' ? 'var(--surface)' : 'transparent',
                    color: mode === 'register' ? 'var(--text)' : 'var(--text-2)',
                  }}
                >
                  Create Account
                </button>
              </div>
            ) : (
              <div className="space-y-1">
                <h2 className="text-lg font-extrabold flex items-center gap-2">
                  <KeyRound className="w-5 h-5" style={{ color: 'var(--orange)' }} />
                  <span>Recover Your Password</span>
                </h2>
                <p className="bx-hint">
                  Receive a secure Firebase Authentication password-reset link at your registered email
                  address.
                </p>
              </div>
            )}

        {/* Google Sign-In Button — Exact Label "Connect with Google" */}
        {mode !== 'forgot' && (
          <>
            <button
              type="button"
              onClick={handleGoogleSignIn}
              disabled={isAnyBusy}
              className="bx-btn w-full justify-center"
            >
              {googleBusy ? (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="#EA4335"
                    d="M12 10.2v3.9h5.5c-.2 1.3-1.6 3.8-5.5 3.8-3.3 0-6-2.7-6-6s2.7-6 6-6c1.9 0 3.2.8 3.9 1.5l2.7-2.6C16.9 3.2 14.7 2.2 12 2.2 6.6 2.2 2.2 6.6 2.2 12S6.6 21.8 12 21.8c6.9 0 9.6-4.8 9.6-7.3 0-.5-.1-.9-.1-1.3H12Z"
                  />
                </svg>
              )}
              <span>{googleBusy ? 'Connecting with Google…' : 'Connect with Google'}</span>
            </button>

            {domainNotAuthorized && !isLocalDevHost && (
              <div
                className="p-2.5 rounded-xl text-xs font-bold leading-snug border"
                style={{
                  background: 'var(--surface-2, rgba(255, 101, 0, 0.06))',
                  borderColor: 'var(--border)',
                  color: 'var(--text-2)',
                }}
                role="note"
              >
                <div className="flex items-start gap-2">
                  <Info className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--orange)' }} />
                  <span>
                    Google Sign-In popup is restricted on <code>{currentHostLabel}</code>. Please open the official BEXORA domain or sign in with Email below.
                  </span>
                </div>
              </div>
            )}

            <div className="flex items-center gap-3 text-xs font-bold" style={{ color: 'var(--text-3)' }}>
              <div className="h-px flex-1" style={{ background: 'var(--border-soft)' }} />
              <span>OR CONTINUE WITH EMAIL</span>
              <div className="h-px flex-1" style={{ background: 'var(--border-soft)' }} />
            </div>
          </>
        )}

        {/* Confirmed Disabled Provider Advisory (Customer-clean, non-blocking) */}
        {mode !== 'forgot' && emailProviderConfirmedDisabled && !errorIsProviderDisabled && (
          <div
            className="p-2.5 rounded-xl text-xs font-bold leading-snug space-y-2 border"
            style={{
              background: 'var(--surface-2, rgba(255, 101, 0, 0.08))',
              borderColor: 'var(--orange)',
              color: 'var(--text)',
            }}
            role="note"
          >
            <div className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--orange)' }} />
              <span>
                <strong>Direct Email/Password sign-in is currently unavailable.</strong> Use{' '}
                <strong>Connect with Google</strong> above to sign in or create your BEXORA account immediately.
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleRecheckProviders}
                disabled={checkingCaps}
                className="bx-btn bx-btn-sm inline-flex items-center gap-1.5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${checkingCaps ? 'animate-spin' : ''}`} />
                <span>{checkingCaps ? 'Checking…' : 'Re-check Sign-In Status'}</span>
              </button>
            </div>
          </div>
        )}

        {/* Unable-to-Verify Provider Advisory (Distinct from confirmed disabled) */}
        {mode !== 'forgot' && emailProviderUnableToVerify && !error && (
          <div
            className="p-2.5 rounded-xl text-xs font-bold leading-snug flex items-center justify-between gap-2 border"
            style={{
              background: 'var(--surface-2)',
              borderColor: 'var(--border)',
              color: 'var(--text-2)',
            }}
            role="note"
          >
            <div className="flex items-start gap-2">
              <Info className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--orange)' }} />
              <span>
                Provider pre-check could not be verified right now. Forms remain active below.
              </span>
            </div>
            <button
              type="button"
              onClick={handleRecheckProviders}
              disabled={checkingCaps}
              className="bx-btn bx-btn-sm shrink-0 inline-flex items-center gap-1"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${checkingCaps ? 'animate-spin' : ''}`} />
              <span>Retry</span>
            </button>
          </div>
        )}

        {error && (
          <div
            className="p-3 rounded-xl text-xs font-bold leading-snug space-y-2"
            style={{ background: 'var(--red-soft)', color: 'var(--red)' }}
            role="alert"
          >
            <div className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
            {errorIsProviderDisabled && (
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                <button
                  type="button"
                  onClick={handleRecheckProviders}
                  disabled={checkingCaps}
                  className="bx-btn bx-btn-sm inline-flex items-center gap-1.5"
                  style={{ color: 'var(--text)' }}
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${checkingCaps ? 'animate-spin' : ''}`} />
                  <span>{checkingCaps ? 'Checking…' : 'Re-check Sign-In Status'}</span>
                </button>
              </div>
            )}
          </div>
        )}

        {info && (
          <div
            className="p-3 rounded-xl text-xs font-bold leading-snug flex items-start gap-2"
            style={{ background: 'var(--green-soft)', color: 'var(--green)' }}
            role="status"
          >
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{info}</span>
          </div>
        )}

        {mode === 'login' && (
          <form onSubmit={handleLogin} noValidate className="space-y-3.5">
            <div>
              <label htmlFor="auth-login-email" className="bx-label">
                Email Address
              </label>
              <input
                id="auth-login-email"
                type="email"
                autoComplete="email"
                value={loginEmail}
                onChange={(e) => {
                  setLoginEmail(e.target.value);
                  if (error) setError('');
                }}
                placeholder="you@gmail.com"
                className="bx-input"
                disabled={loginBusy}
                required
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label htmlFor="auth-login-password" className="bx-label !mb-0">
                  Password
                </label>
                <button
                  type="button"
                  disabled={isAnyBusy}
                  onClick={() => switchMode('forgot')}
                  className="text-xs font-bold underline"
                  style={{ color: 'var(--orange)' }}
                >
                  Forgot password?
                </button>
              </div>
              <div className="relative">
                <input
                  id="auth-login-password"
                  type={showLoginPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={loginPassword}
                  onChange={(e) => {
                    setLoginPassword(e.target.value);
                    if (error) setError('');
                  }}
                  placeholder="Enter your password"
                  className="bx-input !pr-12"
                  disabled={loginBusy}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowLoginPassword((v) => !v)}
                  aria-label={showLoginPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg"
                  style={{ color: 'var(--text-2)' }}
                >
                  {showLoginPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={isAnyBusy || isLoginIncomplete}
              className="bx-btn bx-btn-primary w-full justify-center"
            >
              {loginBusy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
              <span>{loginBusy ? 'Signing in…' : 'Sign In'}</span>
            </button>
          </form>
        )}

        {mode === 'register' && (
          <form onSubmit={handleRegister} noValidate className="space-y-3">
            {partialSignupUid && (
              <div
                className="p-3 rounded-xl text-xs font-bold leading-relaxed border"
                style={{
                  background: 'var(--surface-2)',
                  borderColor: 'var(--orange)',
                  color: 'var(--text)',
                }}
                role="status"
              >
                Authentication credentials are already created for this session. Confirm your
                username and profile details below and click <strong>Complete Profile Setup</strong>.
              </div>
            )}

            <div>
              <label htmlFor="reg-fullname" className="bx-label">
                Full Name
              </label>
              <input
                id="reg-fullname"
                type="text"
                autoComplete="name"
                value={fullName}
                onChange={(e) => {
                  setFullName(e.target.value);
                  if (error) setError('');
                }}
                placeholder="e.g. Tanvir Islam"
                className="bx-input"
                disabled={registerBusy}
                required
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="reg-username" className="bx-label">
                  Unique Username
                </label>
                <input
                  id="reg-username"
                  type="text"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value);
                    if (error) setError('');
                  }}
                  placeholder="e.g. tanvir_bd"
                  className="bx-input"
                  disabled={registerBusy}
                  required
                />
              </div>
              <div>
                <label htmlFor="reg-phone" className="bx-label">
                  Phone Number
                </label>
                <input
                  id="reg-phone"
                  type="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(e) => {
                    setPhone(e.target.value);
                    if (error) setError('');
                  }}
                  placeholder="+8801XXXXXXXXX"
                  className="bx-input"
                  disabled={registerBusy}
                  required
                />
              </div>
            </div>

            <div>
              <label htmlFor="reg-email" className="bx-label">
                Email Address
              </label>
              <input
                id="reg-email"
                type="email"
                autoComplete="email"
                value={regEmail}
                onChange={(e) => {
                  setRegEmail(e.target.value);
                  if (partialSignupUid) setPartialSignupUid(null);
                  if (error) setError('');
                }}
                placeholder="you@gmail.com"
                className="bx-input"
                disabled={registerBusy || Boolean(partialSignupUid)}
                required
              />
            </div>

            {!partialSignupUid && (
              <>
                {/* Independent Password Field + Eye Icon */}
                <div>
                  <label htmlFor="reg-password" className="bx-label">
                    Password
                  </label>
                  <div className="relative">
                    <input
                      id="reg-password"
                      type={showRegPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      value={regPassword}
                      onChange={(e) => {
                        setRegPassword(e.target.value);
                        if (error) setError('');
                      }}
                      placeholder="Minimum 8 characters (letters & numbers)"
                      className="bx-input !pr-12"
                      disabled={registerBusy}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowRegPassword((v) => !v)}
                      aria-label={showRegPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg"
                      style={{ color: 'var(--text-2)' }}
                    >
                      {showRegPassword ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                  {regPasswordCheck && !regPasswordCheck.valid && (
                    <p className="mt-1 text-[11px] font-bold" style={{ color: 'var(--orange)' }}>
                      {regPasswordCheck.error}
                    </p>
                  )}
                </div>

                {/* Independent Confirm Password Field + Separate Eye Icon */}
                <div>
                  <label htmlFor="reg-confirm-password" className="bx-label">
                    Confirm Password
                  </label>
                  <div className="relative">
                    <input
                      id="reg-confirm-password"
                      type={showConfirmPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(e) => {
                        setConfirmPassword(e.target.value);
                        if (error) setError('');
                      }}
                      placeholder="Re-enter password"
                      className="bx-input !pr-12"
                      disabled={registerBusy}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword((v) => !v)}
                      aria-label={
                        showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'
                      }
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
                  {regPasswordsMismatch && (
                    <p className="mt-1 text-[11px] font-bold" style={{ color: 'var(--red)' }}>
                      Password and Confirm Password do not match.
                    </p>
                  )}
                </div>
              </>
            )}

            <button
              type="submit"
              disabled={isAnyBusy || isRegisterIncomplete}
              className="bx-btn bx-btn-primary w-full justify-center"
            >
              {registerBusy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
              <span>
                {registerBusy
                  ? partialSignupUid
                    ? 'Completing profile…'
                    : 'Creating account…'
                  : partialSignupUid
                  ? 'Complete Profile Setup'
                  : 'Create Account'}
              </span>
            </button>
          </form>
        )}

        {mode === 'forgot' && (
          <form onSubmit={handlePasswordRecovery} noValidate className="space-y-4">
            <div className="p-3 rounded-xl bx-soft flex items-center gap-2 text-xs font-bold">
              <Mail className="w-4 h-4 shrink-0" style={{ color: 'var(--orange)' }} />
              <span>Firebase Email Action Link (Gmail & Custom Domains Supported)</span>
            </div>

            <div>
              <label htmlFor="recovery-target" className="bx-label">
                Registered Email Address
              </label>
              <input
                id="recovery-target"
                type="email"
                autoComplete="email"
                value={recoveryTarget}
                onChange={(e) => {
                  setRecoveryTarget(e.target.value);
                  if (error) setError('');
                }}
                placeholder="you@gmail.com"
                className="bx-input"
                disabled={forgotBusy}
                required
              />
            </div>

            <button
              type="submit"
              disabled={isAnyBusy || isForgotIncomplete || resetCooldownSec > 0}
              className="bx-btn bx-btn-primary w-full justify-center"
            >
              {forgotBusy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
              <span>
                {forgotBusy
                  ? 'Sending reset link…'
                  : resetCooldownSec > 0
                  ? `Resend available in ${resetCooldownSec}s`
                  : 'Send Password Reset Link'}
              </span>
            </button>

            <button
              type="button"
              disabled={isAnyBusy}
              onClick={() => switchMode('login')}
              className="bx-btn w-full justify-center"
            >
              Back to Sign In
            </button>
          </form>
        )}
          </div>
        </div>
      </div>
    </section>
  );
};
