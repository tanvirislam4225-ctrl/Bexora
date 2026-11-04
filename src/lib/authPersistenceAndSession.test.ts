import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BEXORA_BRAND_AUTH_DOMAIN_PRIORITY,
  classifySessionErrorDisposition,
  evaluateCustomAuthDomainReadiness,
  isSafeFirebaseAuthProxyPath,
  PRIMARY_VERIFIED_BEXORA_AUTH_DOMAIN,
  resolveEffectiveFirebaseAuthDomain,
  shouldKeepProactiveTokenRefreshEnabled,
  shouldShowProtectedRouteLoading,
  VERIFIED_FIRST_PARTY_AUTH_DOMAINS,
} from './authDomainAndPersistenceLogic';
import {
  parseRouteFromSearch,
  resolveCanonicalPathnameForNavigation,
} from './checkoutAndIntentLogic';

const LEGACY_FIREBASE_HOST = 'responsive-dragon-tmn89' + '.firebaseapp.com';

test('resolveEffectiveFirebaseAuthDomain replaces legacy firebaseapp host across ALL verified BEXORA HTTPS origins including mobile preview and custom domains', () => {
  assert.equal(PRIMARY_VERIFIED_BEXORA_AUTH_DOMAIN, 'bexora.ai.studio');
  assert.deepEqual(BEXORA_BRAND_AUTH_DOMAIN_PRIORITY, [
    'auth.bexora.com',
    'bexora.com',
    'bexora.ai.studio',
  ]);
  assert.equal(
    VERIFIED_FIRST_PARTY_AUTH_DOMAINS.has(
      'ais-mob-45y7auub4nznkdwaxyqbcw-496121292925.asia-southeast1.run.app'
    ),
    true
  );
  assert.equal(VERIFIED_FIRST_PARTY_AUTH_DOMAINS.has('bexora.com'), true);
  assert.equal(VERIFIED_FIRST_PARTY_AUTH_DOMAINS.has('auth.bexora.com'), true);

  for (const host of VERIFIED_FIRST_PARTY_AUTH_DOMAINS) {
    assert.equal(
      resolveEffectiveFirebaseAuthDomain({
        configuredAuthDomain: LEGACY_FIREBASE_HOST,
        windowHostname: host,
        windowProtocol: 'https:',
        envCustomAuthDomain: '',
      }),
      host
    );
  }
});

test('resolveEffectiveFirebaseAuthDomain promotes verified centralized BEXORA brand domain across Cloud Run and AI Studio preview origins', () => {
  assert.equal(
    resolveEffectiveFirebaseAuthDomain({
      configuredAuthDomain: LEGACY_FIREBASE_HOST,
      windowHostname: 'ais-mob-45y7auub4nznkdwaxyqbcw-496121292925.asia-southeast1.run.app',
      windowProtocol: 'https:',
      envCustomAuthDomain: '',
      verifiedBrandAuthDomain: 'bexora.ai.studio',
    }),
    'bexora.ai.studio'
  );

  assert.equal(
    resolveEffectiveFirebaseAuthDomain({
      configuredAuthDomain: LEGACY_FIREBASE_HOST,
      windowHostname: 'bexora-448578956301.asia-southeast1.run.app',
      windowProtocol: 'https:',
      envCustomAuthDomain: '',
      verifiedBrandAuthDomain: 'auth.bexora.com',
    }),
    'auth.bexora.com'
  );
});

test('resolveEffectiveFirebaseAuthDomain preserves fallback on localhost, HTTP, and unverified hosts so OAuth never hits redirect_uri_mismatch', () => {
  assert.equal(
    resolveEffectiveFirebaseAuthDomain({
      configuredAuthDomain: LEGACY_FIREBASE_HOST,
      windowHostname: 'localhost',
      windowProtocol: 'http:',
      envCustomAuthDomain: '',
    }),
    LEGACY_FIREBASE_HOST
  );

  assert.equal(
    resolveEffectiveFirebaseAuthDomain({
      configuredAuthDomain: LEGACY_FIREBASE_HOST,
      windowHostname: 'bexora.ai.studio',
      windowProtocol: 'http:',
      envCustomAuthDomain: '',
    }),
    LEGACY_FIREBASE_HOST
  );

  assert.equal(
    resolveEffectiveFirebaseAuthDomain({
      configuredAuthDomain: LEGACY_FIREBASE_HOST,
      windowHostname: 'unverified-preview.example.org',
      windowProtocol: 'https:',
      envCustomAuthDomain: '',
    }),
    LEGACY_FIREBASE_HOST
  );
});

test('resolveEffectiveFirebaseAuthDomain honors valid VITE_FIREBASE_CUSTOM_AUTH_DOMAIN and ignores placeholders', () => {
  assert.equal(
    resolveEffectiveFirebaseAuthDomain({
      configuredAuthDomain: LEGACY_FIREBASE_HOST,
      windowHostname: 'localhost',
      windowProtocol: 'http:',
      envCustomAuthDomain: 'https://auth.bexora.com/path',
    }),
    'auth.bexora.com'
  );

  assert.equal(
    resolveEffectiveFirebaseAuthDomain({
      configuredAuthDomain: LEGACY_FIREBASE_HOST,
      windowHostname: 'localhost',
      windowProtocol: 'http:',
      envCustomAuthDomain: 'your_custom_domain.example.com',
    }),
    LEGACY_FIREBASE_HOST
  );
});

test('evaluateCustomAuthDomainReadiness rejects unverified/parked domains and approves fully verified BEXORA relay domains', () => {
  const parkedAuthSubdomain = evaluateCustomAuthDomainReadiness({
    domain: 'auth.bexora.com',
    handlerStatus: 200,
    handlerHasFireauthWidget: false,
    iframeStatus: 200,
    iframeHasAuthRelay: false,
    inFirebaseAuthorizedDomains: false,
    googleOAuthStatus: 400,
    googleOAuthRedirectMismatch: true,
  });
  assert.equal(parkedAuthSubdomain.readyForSameOriginAuth, false);
  assert.equal(parkedAuthSubdomain.readyForCrossOriginCentralizedAuth, false);
  assert.equal(parkedAuthSubdomain.missingSteps.length, 3);

  const sameOriginOnlyStudio = evaluateCustomAuthDomainReadiness({
    domain: 'bexora.ai.studio',
    handlerStatus: 200,
    handlerHasFireauthWidget: true,
    iframeStatus: 200,
    iframeHasAuthRelay: true,
    iframeCspHeader: "frame-ancestors 'self' https://*.google.com",
    inFirebaseAuthorizedDomains: true,
    googleOAuthStatus: 200,
    googleOAuthRedirectMismatch: false,
  });
  assert.equal(sameOriginOnlyStudio.readyForSameOriginAuth, true);
  assert.equal(sameOriginOnlyStudio.readyForCrossOriginCentralizedAuth, false);
  assert.equal(sameOriginOnlyStudio.missingSteps.length, 1);

  const fullyReadyStudio = evaluateCustomAuthDomainReadiness({
    domain: 'bexora.ai.studio',
    handlerStatus: 200,
    handlerHasFireauthWidget: true,
    iframeStatus: 200,
    iframeHasAuthRelay: true,
    iframeCspHeader: null,
    iframeXFrameOptionsHeader: null,
    inFirebaseAuthorizedDomains: true,
    googleOAuthStatus: 200,
    googleOAuthRedirectMismatch: false,
  });
  assert.equal(fullyReadyStudio.readyForSameOriginAuth, true);
  assert.equal(fullyReadyStudio.readyForCrossOriginCentralizedAuth, true);
  assert.deepEqual(fullyReadyStudio.missingSteps, []);
});

test('Clean Google OAuth Consent legal routes (/privacy and /terms) parse to InfoCenter topics and reset cleanly on navigation', () => {
  assert.deepEqual(parseRouteFromSearch('', '/privacy'), {
    page: 'info',
    infoTopic: 'privacy-policy',
  });
  assert.deepEqual(parseRouteFromSearch('', '/privacy-policy/'), {
    page: 'info',
    infoTopic: 'privacy-policy',
  });
  assert.deepEqual(parseRouteFromSearch('', '/terms'), {
    page: 'info',
    infoTopic: 'terms-of-service',
  });
  assert.deepEqual(parseRouteFromSearch('', '/terms-of-service'), {
    page: 'info',
    infoTopic: 'terms-of-service',
  });

  // Navigating away from /privacy normalizes pathname back to '/'
  assert.equal(
    resolveCanonicalPathnameForNavigation('/privacy', { page: 'home' }),
    '/'
  );
  assert.equal(
    resolveCanonicalPathnameForNavigation('/privacy', {
      page: 'info',
      infoTopic: 'privacy-policy',
    }),
    '/privacy'
  );
  assert.equal(
    resolveCanonicalPathnameForNavigation('/terms', {
      page: 'info',
      infoTopic: 'privacy-policy',
    }),
    '/'
  );
});

test('isSafeFirebaseAuthProxyPath strictly allowlists Firebase Auth relay endpoints and blocks path traversal', () => {
  assert.equal(isSafeFirebaseAuthProxyPath('/__/auth/handler'), true);
  assert.equal(isSafeFirebaseAuthProxyPath('/__/auth/handler?apiKey=abc&authType=signInViaPopup'), true);
  assert.equal(isSafeFirebaseAuthProxyPath('/__/auth/iframe'), true);
  assert.equal(isSafeFirebaseAuthProxyPath('/__/auth/handler.js'), true);
  assert.equal(isSafeFirebaseAuthProxyPath('/__/auth/iframe.js'), true);
  assert.equal(isSafeFirebaseAuthProxyPath('/__/auth/experiments.js'), true);
  assert.equal(isSafeFirebaseAuthProxyPath('/__/auth/action'), true);
  assert.equal(isSafeFirebaseAuthProxyPath('/__/firebase/init.json'), true);
  assert.equal(isSafeFirebaseAuthProxyPath('/__/firebase/init.js'), true);

  assert.equal(isSafeFirebaseAuthProxyPath('/__/auth/../server.ts'), false);
  assert.equal(isSafeFirebaseAuthProxyPath('/__/auth//evil.com'), false);
  assert.equal(isSafeFirebaseAuthProxyPath('/__/auth/unknown'), false);
  assert.equal(isSafeFirebaseAuthProxyPath('/api/auth/capabilities'), false);
  assert.equal(isSafeFirebaseAuthProxyPath(''), false);
});

test('shouldKeepProactiveTokenRefreshEnabled keeps Firebase ProactiveRefresh active across transient/unknown states', () => {
  assert.equal(shouldKeepProactiveTokenRefreshEnabled('enabled_verified'), true);
  assert.equal(shouldKeepProactiveTokenRefreshEnabled('unable_to_verify'), true);
  assert.equal(shouldKeepProactiveTokenRefreshEnabled('enablement_pending'), true);
  assert.equal(shouldKeepProactiveTokenRefreshEnabled(null), true);
  assert.equal(shouldKeepProactiveTokenRefreshEnabled(undefined), true);
  assert.equal(shouldKeepProactiveTokenRefreshEnabled('disabled'), false);
});

test('classifySessionErrorDisposition never logs out on offline, sleep-wake, or normal 60m ID token expiry', () => {
  assert.equal(
    classifySessionErrorDisposition(new Error('Firebase: Error (auth/network-request-failed).')),
    'preserve_session_transient'
  );
  assert.equal(
    classifySessionErrorDisposition(new Error('Failed to fetch')),
    'preserve_session_transient'
  );
  assert.equal(
    classifySessionErrorDisposition(new Error('Service unavailable (503)')),
    'preserve_session_transient'
  );
  assert.equal(
    classifySessionErrorDisposition({ code: 'auth/id-token-expired', message: 'ID token expired' }),
    'retry_token_refresh'
  );

  // Explicit account revocation / disablement / deletion MUST sign out safely
  assert.equal(
    classifySessionErrorDisposition({ code: 'auth/user-disabled', message: 'USER_DISABLED' }),
    'sign_out_revoked'
  );
  assert.equal(
    classifySessionErrorDisposition(new Error('INVALID_REFRESH_TOKEN')),
    'sign_out_revoked'
  );
  assert.equal(
    classifySessionErrorDisposition({ code: 'auth/user-token-expired', message: 'TOKEN_EXPIRED' }),
    'sign_out_revoked'
  );
  assert.equal(
    classifySessionErrorDisposition({ code: 'auth/user-not-found', message: 'USER_NOT_FOUND' }),
    'sign_out_revoked'
  );
});

test('shouldShowProtectedRouteLoading waits for authReady and profile hydration before showing signed-out UI', () => {
  // Initial boot before onAuthStateChanged fires -> must show loading, NOT signed-out prompt
  assert.equal(
    shouldShowProtectedRouteLoading({
      authReady: false,
      hasFbUser: false,
    }),
    true
  );

  // Authenticated user restored from browserLocalPersistence, waiting on Firestore profile -> show loading
  assert.equal(
    shouldShowProtectedRouteLoading({
      authReady: true,
      hasFbUser: true,
      needsProfile: true,
      hasProfile: false,
      needsPrivateUser: true,
      hasPrivateUser: false,
    }),
    true
  );

  // Admin route waiting for profileBootstrapped -> show loading instead of "Administrator Access Required"
  assert.equal(
    shouldShowProtectedRouteLoading({
      authReady: true,
      hasFbUser: true,
      needsProfileBootstrapped: true,
      profileBootstrapped: false,
    }),
    true
  );

  // Fully hydrated authenticated user -> render protected page
  assert.equal(
    shouldShowProtectedRouteLoading({
      authReady: true,
      hasFbUser: true,
      needsProfile: true,
      hasProfile: true,
      needsPrivateUser: true,
      hasPrivateUser: true,
    }),
    false
  );

  // Confirmed guest (authReady === true && hasFbUser === false) -> render sign-in prompt immediately
  assert.equal(
    shouldShowProtectedRouteLoading({
      authReady: true,
      hasFbUser: false,
      needsProfile: true,
      hasProfile: false,
    }),
    false
  );

  // Intentional user Logout in progress -> never block on loading spinner
  assert.equal(
    shouldShowProtectedRouteLoading({
      authReady: true,
      signingOut: true,
      hasFbUser: true,
      needsProfile: true,
      hasProfile: false,
    }),
    false
  );
});
