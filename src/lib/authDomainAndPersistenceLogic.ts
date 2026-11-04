import type { TokenServiceStatus } from '../types';

/**
 * Primary live verified BEXORA authentication domain currently active with SSL,
 * `/__/auth/handler` + `/__/auth/iframe` relay, Firebase Authorized Domains, and Google OAuth redirect URI.
 */
export const PRIMARY_VERIFIED_BEXORA_AUTH_DOMAIN = 'bexora.ai.studio';

/**
 * Brand-priority order for BEXORA's centralized OAuth authentication domain.
 * Promotes `auth.bexora.com` or `bexora.com` automatically as soon as DNS, SSL, Firebase Authorized Domains,
 * and Google OAuth redirect URI checks pass; uses `bexora.ai.studio` while external registrar DNS is pending.
 */
export const BEXORA_BRAND_AUTH_DOMAIN_PRIORITY: readonly string[] = [
  'auth.bexora.com',
  'bexora.com',
  'bexora.ai.studio',
];

const DIRECT_BEXORA_BRAND_HOSTS: ReadonlySet<string> = new Set([
  'bexora.com',
  'www.bexora.com',
  'auth.bexora.com',
  'bexora.ai.studio',
]);

/**
 * Verified first-party HTTPS hostnames served by BEXORA's Express server (`server.ts`, which proxies
 * `/__/auth/*` and `/__/firebase/*`) and registered in Firebase Authentication + Google OAuth Web Client
 * (`448578956301-804b7ckehcuraasdn6ji54i850iu4bk4`) — plus `bexora.com` / `auth.bexora.com` once pointed
 * at this service. Includes desktop, shared, and mobile (`ais-mob-*`) preview origins so no user ever falls
 * back to `responsive-dragon-tmn89.firebaseapp.com`.
 */
export const VERIFIED_FIRST_PARTY_AUTH_DOMAINS: ReadonlySet<string> = new Set([
  'bexora.com',
  'www.bexora.com',
  'auth.bexora.com',
  'bexora.ai.studio',
  'bexora-448578956301.asia-southeast1.run.app',
  'ais-pre-45y7auub4nznkdwaxyqbcw-496121292925.asia-southeast1.run.app',
  'ais-dev-45y7auub4nznkdwaxyqbcw-496121292925.asia-southeast1.run.app',
  'ais-mob-45y7auub4nznkdwaxyqbcw-496121292925.asia-southeast1.run.app',
]);

const VALID_HOSTNAME_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export interface ResolveAuthDomainInput {
  configuredAuthDomain: string;
  windowHostname?: string | null;
  windowProtocol?: string | null;
  envCustomAuthDomain?: string | null;
  verifiedBrandAuthDomain?: string | null;
}

function normalizeCandidateHostname(raw: string | null | undefined): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
  if (
    !cleaned ||
    cleaned.includes('example.com') ||
    cleaned.startsWith('your_') ||
    cleaned.startsWith('paste_') ||
    !VALID_HOSTNAME_RE.test(cleaned)
  ) {
    return '';
  }
  return cleaned;
}

/**
 * Safely resolves the effective Firebase `authDomain`:
 * 1. Explicit `VITE_FIREBASE_CUSTOM_AUTH_DOMAIN` override if valid and non-placeholder.
 * 2. Current browser HTTPS hostname when already on a direct BEXORA brand domain (`bexora.com`, `auth.bexora.com`, `bexora.ai.studio`).
 * 3. Live-verified centralized BEXORA brand domain (`auth.bexora.com` -> `bexora.com` -> `bexora.ai.studio`) when
 *    confirmed cross-origin embeddable on a verified HTTPS origin.
 * 4. Current browser HTTPS hostname when in `VERIFIED_FIRST_PARTY_AUTH_DOMAINS` (including `ais-mob-*`, `ais-dev-*`, `ais-pre-*`).
 * 5. `configuredAuthDomain` fallback on `http://localhost`, SSR/Node tests, or unverified hosts so OAuth never hits `redirect_uri_mismatch`.
 */
export function resolveEffectiveFirebaseAuthDomain(input: ResolveAuthDomainInput): string {
  const fallback = String(input.configuredAuthDomain || '').trim();
  const explicitEnv = normalizeCandidateHostname(input.envCustomAuthDomain);
  if (explicitEnv) {
    return explicitEnv;
  }

  const host = String(input.windowHostname || '').trim().toLowerCase();
  const proto = String(input.windowProtocol || '').trim().toLowerCase();

  if (proto === 'https:' && host && DIRECT_BEXORA_BRAND_HOSTS.has(host)) {
    return host;
  }

  const verifiedBrand = normalizeCandidateHostname(input.verifiedBrandAuthDomain);
  if (
    proto === 'https:' &&
    host &&
    verifiedBrand &&
    VERIFIED_FIRST_PARTY_AUTH_DOMAINS.has(host)
  ) {
    return verifiedBrand;
  }

  if (proto === 'https:' && host && VERIFIED_FIRST_PARTY_AUTH_DOMAINS.has(host)) {
    return host;
  }

  return fallback;
}

export interface CustomAuthDomainProbeInput {
  domain: string;
  handlerStatus: number;
  handlerHasFireauthWidget: boolean;
  iframeStatus: number;
  iframeHasAuthRelay: boolean;
  iframeCspHeader?: string | null;
  iframeXFrameOptionsHeader?: string | null;
  inFirebaseAuthorizedDomains: boolean;
  googleOAuthStatus: number;
  googleOAuthRedirectMismatch: boolean;
  oauthClientId?: string;
  firebaseProjectId?: string;
}

export interface CustomAuthDomainReadinessResult {
  domain: string;
  handlerServingFirebaseWidget: boolean;
  crossOriginIframeAllowed: boolean;
  firebaseAuthorizedDomain: boolean;
  googleOAuthRedirectUriAllowed: boolean;
  readyForSameOriginAuth: boolean;
  readyForCrossOriginCentralizedAuth: boolean;
  missingSteps: string[];
}

/**
 * Evaluates whether a candidate custom domain (`auth.bexora.com`, `bexora.com`, `bexora.ai.studio`)
 * can safely serve as the Google Sign-In / Firebase OAuth `authDomain` without breaking login.
 */
export function evaluateCustomAuthDomainReadiness(
  input: CustomAuthDomainProbeInput
): CustomAuthDomainReadinessResult {
  const domain = String(input.domain || '').trim().toLowerCase();
  const projectId = String(input.firebaseProjectId || 'responsive-dragon-tmn89').trim();
  const clientId = String(
    input.oauthClientId || '448578956301-804b7ckehcuraasdn6ji54i850iu4bk4.apps.googleusercontent.com'
  ).trim();

  const handlerServingFirebaseWidget =
    input.handlerStatus === 200 && Boolean(input.handlerHasFireauthWidget);

  const cspLower = String(input.iframeCspHeader || '').toLowerCase();
  const xfoLower = String(input.iframeXFrameOptionsHeader || '').toLowerCase();
  const blocksCrossOriginFraming =
    cspLower.includes('frame-ancestors') ||
    xfoLower.includes('deny') ||
    xfoLower.includes('sameorigin');

  const crossOriginIframeAllowed =
    input.iframeStatus === 200 && Boolean(input.iframeHasAuthRelay) && !blocksCrossOriginFraming;

  const firebaseAuthorizedDomain = Boolean(input.inFirebaseAuthorizedDomains);
  const googleOAuthRedirectUriAllowed =
    input.googleOAuthStatus === 200 && !input.googleOAuthRedirectMismatch;

  const missingSteps: string[] = [];
  if (!handlerServingFirebaseWidget) {
    missingSteps.push(
      `Connect and verify ${domain} in DNS + SSL (Firebase Hosting or Cloud Run Custom Domain mapping for project ${projectId}) so https://${domain}/__/auth/handler serves the BEXORA Firebase Auth relay with HTTP 200.`
    );
  } else if (!crossOriginIframeAllowed) {
    missingSteps.push(
      `Redeploy BEXORA so https://${domain}/__/auth/iframe serves AuthRelay without restrictive frame-ancestors / X-Frame-Options headers.`
    );
  }
  if (!firebaseAuthorizedDomain) {
    missingSteps.push(
      `Add ${domain} to Firebase Console -> Project ${projectId} -> Authentication -> Settings -> Authorized domains.`
    );
  }
  if (!googleOAuthRedirectUriAllowed) {
    missingSteps.push(
      `Add https://${domain}/__/auth/handler to Authorized redirect URIs on Google Cloud OAuth 2.0 Web Client (${clientId}).`
    );
  }

  const readyForSameOriginAuth =
    handlerServingFirebaseWidget && firebaseAuthorizedDomain && googleOAuthRedirectUriAllowed;
  const readyForCrossOriginCentralizedAuth =
    readyForSameOriginAuth && crossOriginIframeAllowed;

  return {
    domain,
    handlerServingFirebaseWidget,
    crossOriginIframeAllowed,
    firebaseAuthorizedDomain,
    googleOAuthRedirectUriAllowed,
    readyForSameOriginAuth,
    readyForCrossOriginCentralizedAuth,
    missingSteps,
  };
}

const ALLOWED_FIREBASE_AUTH_PROXY_PATHS: ReadonlySet<string> = new Set([
  '/__/auth/handler',
  '/__/auth/handler.js',
  '/__/auth/iframe',
  '/__/auth/iframe.js',
  '/__/auth/experiments.js',
  '/__/auth/action',
  '/__/auth/action.js',
  '/__/auth/links',
  '/__/auth/links.js',
  '/__/firebase/init.json',
  '/__/firebase/init.js',
]);

/**
 * Strictly validates requests targeting the first-party Firebase Auth reverse proxy (`/__/auth/*`, `/__/firebase/*`)
 * so only genuine Firebase Auth helper endpoints are forwarded and path-traversal / SSRF attempts are rejected.
 */
export function isSafeFirebaseAuthProxyPath(rawPathname: string): boolean {
  if (typeof rawPathname !== 'string' || !rawPathname) return false;
  const clean = rawPathname.split('?')[0] || '';
  if (clean.includes('\0') || clean.includes('..') || clean.includes('\\') || clean.includes('//')) {
    return false;
  }
  return ALLOWED_FIREBASE_AUTH_PROXY_PATHS.has(clean);
}

/**
 * Determines whether Firebase Auth's native `ProactiveRefresh` should stay active.
 * Always defaults to `true` unless the Google Cloud Token Service API is conclusively confirmed `'disabled'`.
 * Never disables proactive refresh on `'unable_to_verify'`, `'enablement_pending'`, `null`, or network hiccups.
 */
export function shouldKeepProactiveTokenRefreshEnabled(
  status?: TokenServiceStatus | null
): boolean {
  return status !== 'disabled';
}

export type SessionErrorDisposition =
  | 'sign_out_revoked'
  | 'retry_token_refresh'
  | 'preserve_session_transient';

/**
 * Classifies errors encountered while validating or refreshing an existing persisted Firebase Auth session:
 * - `'sign_out_revoked'`: ONLY when Firebase Auth / Identity Toolkit confirms the account was disabled,
 *   deleted, or had its refresh token explicitly revoked (`USER_DISABLED`, `TOKEN_EXPIRED`, `INVALID_REFRESH_TOKEN`, `USER_NOT_FOUND`).
 * - `'retry_token_refresh'`: when a 60-minute ID token expired normally (`auth/id-token-expired`) and should be refreshed.
 * - `'preserve_session_transient'`: network offline, sleep/wake reconnect, 5xx, or rate-limit — NEVER log the user out!
 */
export function classifySessionErrorDisposition(err: unknown): SessionErrorDisposition {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: unknown }).code || '')
      : '';
  const msg = err instanceof Error ? err.message : String(err || '');
  const combined = `${code} ${msg}`;

  if (
    combined.includes('auth/user-disabled') ||
    combined.includes('USER_DISABLED') ||
    combined.includes('auth/user-token-expired') ||
    combined.includes('TOKEN_EXPIRED') ||
    combined.includes('INVALID_REFRESH_TOKEN') ||
    combined.includes('auth/invalid-user-token') ||
    combined.includes('auth/user-not-found') ||
    combined.includes('USER_NOT_FOUND')
  ) {
    return 'sign_out_revoked';
  }

  if (combined.includes('auth/id-token-expired') || combined.includes('ID_TOKEN_EXPIRED')) {
    return 'retry_token_refresh';
  }

  return 'preserve_session_transient';
}

export interface ProtectedRouteHydrationInput {
  authReady: boolean;
  signingOut?: boolean;
  hasFbUser: boolean;
  needsProfile?: boolean;
  hasProfile?: boolean;
  needsPrivateUser?: boolean;
  hasPrivateUser?: boolean;
  needsProfileBootstrapped?: boolean;
  profileBootstrapped?: boolean;
}

/**
 * Prevents protected views from flashing signed-out cards, access-denied messages, or login redirects
 * while `onAuthStateChanged` and Firestore profile listeners are still hydrating a persisted session.
 */
export function shouldShowProtectedRouteLoading(input: ProtectedRouteHydrationInput): boolean {
  if (input.signingOut) {
    return false;
  }
  if (!input.authReady) {
    return true;
  }
  if (!input.hasFbUser) {
    return false;
  }
  if (input.needsProfileBootstrapped && !input.profileBootstrapped) {
    return true;
  }
  if (input.needsProfile && !input.hasProfile) {
    return true;
  }
  if (input.needsPrivateUser && !input.hasPrivateUser) {
    return true;
  }
  return false;
}
