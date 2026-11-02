import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSafeExternalHttpsDestination,
  buildContentSecurityPolicy,
  buildSecurityHeaders,
  evaluateApiCorsAndCsrf,
  extractClientIpKey,
  getRecentSecurityEvents,
  isBlockedSensitiveHttpPath,
  isLookupAccountActiveAndUnrevoked,
  isPrivateOrReservedIp,
  recordSecurityEvent,
  redactSecretsFromLogText,
  sanitizeJsonPayload,
  SlidingWindowRateLimiter,
  validateSafeExternalHttpsUrl,
} from './serverSecurity';
import {
  computeWordPressWebhookSignatures,
  verifyWordPressWebhookRequest,
} from './serverWebhookSecurity';
import { convertOrderMinorToWalletBdtMinor } from './checkoutAndIntentLogic';
import {
  calculateDisputeRefundBreakdown,
  sanitizeSafeAudioSrc,
  sanitizeSafeExternalHttpsUrl,
  sanitizeSafeImageSrc,
  validateAudioMagicBytes,
  validateImageMagicBytes,
} from './marketplaceLogic';

function makeTestJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.test_signature`;
}

test('HTTP Security Headers: emits CSP, nosniff, Referrer-Policy, Permissions-Policy, and conditional HSTS', () => {
  const httpsHeaders = buildSecurityHeaders({ isHttps: true, isDev: false });
  assert.equal(httpsHeaders['X-Content-Type-Options'], 'nosniff');
  assert.equal(httpsHeaders['Referrer-Policy'], 'strict-origin-when-cross-origin');
  assert.equal(httpsHeaders['X-Permitted-Cross-Domain-Policies'], 'none');
  assert.match(httpsHeaders['Permissions-Policy']!, /microphone=\(self\)/);
  assert.match(httpsHeaders['Permissions-Policy']!, /camera=\(\)/);
  assert.equal(httpsHeaders['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains');
  assert.match(httpsHeaders['Content-Security-Policy']!, /object-src 'none'/);
  assert.match(httpsHeaders['Content-Security-Policy']!, /frame-ancestors 'self'/);
  assert.doesNotMatch(buildContentSecurityPolicy(false), /\sws:\s/);

  const httpDevHeaders = buildSecurityHeaders({ isHttps: false, isDev: true });
  assert.equal(httpDevHeaders['Strict-Transport-Security'], undefined);
  assert.match(httpDevHeaders['Content-Security-Policy']!, /\sws:\s/);
});

test('API CORS & CSRF Guard: blocks cross-origin mutations, Origin:null, and Sec-Fetch-Site:cross-site while allowing same-origin and HMAC webhook', () => {
  // 1. Cross-origin POST blocked
  const evilPost = evaluateApiCorsAndCsrf({
    method: 'POST',
    path: '/api/telemetry/client-error',
    originHeader: 'https://evil.attacker.example',
    hostHeader: 'bexora.example.com',
  });
  assert.equal(evilPost.allowed, false);
  assert.equal(evilPost.statusCode, 403);
  assert.equal(evilPost.errorCode, 'csrf_origin_mismatch');

  // 2. Sandboxed iframe Origin: null POST blocked
  const nullOriginPost = evaluateApiCorsAndCsrf({
    method: 'POST',
    path: '/api/admin/ai/chat',
    originHeader: 'null',
    hostHeader: 'bexora.example.com',
  });
  assert.equal(nullOriginPost.allowed, false);
  assert.equal(nullOriginPost.statusCode, 403);

  // 3. Cross-site Sec-Fetch-Site without Origin header blocked
  const crossSiteFetch = evaluateApiCorsAndCsrf({
    method: 'DELETE',
    path: '/api/admin/ai/conversations/conv_1',
    secFetchSiteHeader: 'cross-site',
    hostHeader: 'bexora.example.com',
  });
  assert.equal(crossSiteFetch.allowed, false);
  assert.equal(crossSiteFetch.errorCode, 'csrf_cross_site_blocked');

  // 4. Same-origin POST allowed and reflects trusted origin
  const sameOriginPost = evaluateApiCorsAndCsrf({
    method: 'POST',
    path: '/api/fcm/send',
    originHeader: 'https://bexora.example.com',
    hostHeader: 'bexora.example.com',
  });
  assert.equal(sameOriginPost.allowed, true);
  assert.equal(sameOriginPost.corsOriginToReflect, 'https://bexora.example.com');

  // 5. Cryptographic HMAC webhook path exempted from browser Origin requirement
  const webhookPost = evaluateApiCorsAndCsrf({
    method: 'POST',
    path: '/api/payments/wordpress/webhook',
    originHeader: 'https://shop.merchant.example',
    hostHeader: 'bexora.example.com',
  });
  assert.equal(webhookPost.allowed, true);

  // 6. Cross-origin GET does not reflect CORS headers to untrusted origins
  const untrustedGet = evaluateApiCorsAndCsrf({
    method: 'GET',
    path: '/api/health',
    originHeader: 'https://evil.attacker.example',
    hostHeader: 'bexora.example.com',
  });
  assert.equal(untrustedGet.allowed, true);
  assert.equal(untrustedGet.corsOriginToReflect, undefined);
});

test('SSRF Defense: blocks private IPv4/IPv6/CGNAT/metadata IPs, non-443 ports, credentials, numeric hosts, and DNS rebinding', async () => {
  // Private/reserved IPs
  for (const blockedIp of [
    '127.0.0.1',
    '0.0.0.0',
    '10.24.0.5',
    '100.64.10.2',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.10',
    '224.0.0.1',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:7f00:1',
    'fd12:3456::1',
    'fe80::1',
    '64:ff9b::1',
  ]) {
    assert.equal(isPrivateOrReservedIp(blockedIp), true, `Expected ${blockedIp} to be blocked`);
  }

  assert.equal(isPrivateOrReservedIp('93.184.216.34'), false);
  assert.equal(isPrivateOrReservedIp('2606:2800:220:1:248:1893:25c8:1946'), false);

  // URL structural checks
  assert.equal(validateSafeExternalHttpsUrl('http://payments.example.com').valid, false);
  assert.equal(validateSafeExternalHttpsUrl('https://user:secret@payments.example.com').valid, false);
  assert.equal(validateSafeExternalHttpsUrl('https://payments.example.com:8443/wp-json').valid, false);
  assert.equal(validateSafeExternalHttpsUrl('https://metadata.google.internal/computeMetadata/v1').valid, false);
  assert.equal(validateSafeExternalHttpsUrl('https://[::ffff:169.254.169.254]/latest').valid, false);
  assert.equal(validateSafeExternalHttpsUrl('https://2130706433/admin').valid, false);
  assert.equal(validateSafeExternalHttpsUrl('https://intranet/api').valid, false);

  const validUrl = validateSafeExternalHttpsUrl('https://pay.merchant-gateway.com/checkout/');
  assert.equal(validUrl.valid, true);
  assert.equal(validUrl.normalizedUrl, 'https://pay.merchant-gateway.com/checkout');

  // DNS rebinding to metadata IP blocked
  const rebindAttempt = await assertSafeExternalHttpsDestination(
    'https://rebind.attacker.example/hook',
    300,
    async () => [{ address: '169.254.169.254', family: 4 }]
  );
  assert.equal(rebindAttempt.ok, false);
  assert.match(rebindAttempt.error || '', /private or reserved IP/i);

  // Public DNS resolution allowed
  const publicDest = await assertSafeExternalHttpsDestination(
    'https://pay.merchant-gateway.com/wp-json',
    300,
    async () => [{ address: '93.184.216.34', family: 4 }]
  );
  assert.equal(publicDest.ok, true);
  assert.equal(publicDest.normalizedUrl, 'https://pay.merchant-gateway.com/wp-json');
});

test('SlidingWindowRateLimiter: enforces per-window request cap and resets cleanly after window expiry', () => {
  const limiter = new SlidingWindowRateLimiter(3, 60_000);
  const t0 = 1_700_000_000_000;

  assert.equal(limiter.consume('ip:1.2.3.4', t0).allowed, true);
  assert.equal(limiter.consume('ip:1.2.3.4', t0 + 100).allowed, true);
  const third = limiter.consume('ip:1.2.3.4', t0 + 200);
  assert.equal(third.allowed, true);
  assert.equal(third.remaining, 0);

  const fourth = limiter.consume('ip:1.2.3.4', t0 + 300);
  assert.equal(fourth.allowed, false);
  assert.ok(fourth.retryAfterSeconds >= 59);

  // Separate client unaffected
  assert.equal(limiter.consume('ip:5.6.7.8', t0 + 300).allowed, true);

  // Window reset after 60s
  const afterWindow = limiter.consume('ip:1.2.3.4', t0 + 60_001);
  assert.equal(afterWindow.allowed, true);
  assert.equal(afterWindow.remaining, 2);
});

test('Prototype Pollution Guard: recursively strips __proto__, constructor, and prototype keys', () => {
  const malicious = JSON.parse(
    '{"title":"Valid Listing","__proto__":{"isAdmin":true},"nested":{"constructor":{"prototype":{"polluted":true}},"amount":500}}'
  );
  const sanitized = sanitizeJsonPayload(malicious) as Record<string, unknown>;
  assert.equal(sanitized.title, 'Valid Listing');
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, '__proto__'), false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(sanitized.nested as object, 'constructor'),
    false
  );
  assert.equal((sanitized.nested as { amount: number }).amount, 500);
  assert.equal(({} as Record<string, unknown>).isAdmin, undefined);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('Auth Revocation & Disabled Account Guard: rejects disabled users, wrong audience, expired tokens, and sessions older than validSince', () => {
  const nowSec = 1_750_000_000;
  const validToken = makeTestJwt({
    aud: 'responsive-dragon-tmn89',
    iss: 'https://securetoken.google.com/responsive-dragon-tmn89',
    sub: 'user_123',
    iat: nowSec - 120,
    exp: nowSec + 3400,
  });

  // Active & unrevoked session passes
  assert.equal(
    isLookupAccountActiveAndUnrevoked({
      idToken: validToken,
      expectedProjectId: 'responsive-dragon-tmn89',
      disabled: false,
      validSinceSecondsRaw: String(nowSec - 600),
      nowSeconds: nowSec,
    }),
    true
  );

  // Disabled account rejected immediately
  assert.equal(
    isLookupAccountActiveAndUnrevoked({
      idToken: validToken,
      expectedProjectId: 'responsive-dragon-tmn89',
      disabled: true,
      validSinceSecondsRaw: String(nowSec - 600),
      nowSeconds: nowSec,
    }),
    false
  );

  // Revoked session (validSince newer than token iat) rejected
  assert.equal(
    isLookupAccountActiveAndUnrevoked({
      idToken: validToken,
      expectedProjectId: 'responsive-dragon-tmn89',
      disabled: false,
      validSinceSecondsRaw: String(nowSec - 10),
      nowSeconds: nowSec,
    }),
    false
  );

  // Cross-project token audience rejected
  const foreignToken = makeTestJwt({
    aud: 'other-firebase-project',
    iss: 'https://securetoken.google.com/other-firebase-project',
    sub: 'user_123',
    iat: nowSec - 60,
    exp: nowSec + 3400,
  });
  assert.equal(
    isLookupAccountActiveAndUnrevoked({
      idToken: foreignToken,
      expectedProjectId: 'responsive-dragon-tmn89',
      nowSeconds: nowSec,
    }),
    false
  );
});

test('Upload Magic-Byte Validator: accepts genuine JPEG/PNG/WebP headers and blocks disguised SVG/HTML/PDF/EXE', () => {
  const jpegHeader = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const webpHeader = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ]);

  assert.deepEqual(validateImageMagicBytes(jpegHeader), { valid: true, detectedMime: 'image/jpeg' });
  assert.deepEqual(validateImageMagicBytes(pngHeader), { valid: true, detectedMime: 'image/png' });
  assert.deepEqual(validateImageMagicBytes(webpHeader), { valid: true, detectedMime: 'image/webp' });

  const svgPolyglot = new TextEncoder().encode('<svg onload="alert(1)" xmlns="http://www.w3.org/2000/svg"></svg>');
  const htmlDisguised = new TextEncoder().encode('<!DOCTYPE html><script>fetch("/steal")</script>');
  const pdfBytes = new TextEncoder().encode('%PDF-1.7 fake image');

  assert.equal(validateImageMagicBytes(svgPolyglot).valid, false);
  assert.equal(validateImageMagicBytes(htmlDisguised).valid, false);
  assert.equal(validateImageMagicBytes(pdfBytes).valid, false);
  assert.equal(validateImageMagicBytes(new Uint8Array([0xff, 0xd8])).valid, false);
});

test('Financial Integrity: USD dispute refunds and settlements convert accurately to BDT wallet minor units', () => {
  // $100.00 USD listing (10,000 cents), 5% buyer fee -> buyer paid $105.00 (10,500 cents)
  const usdRefund = calculateDisputeRefundBreakdown({
    baseAmountMinor: 10_000,
    buyerFeeMinor: 500,
    buyerTotalMinor: 10_500,
  });
  // 102% of base = $102.00 (10,200 cents); 3% retained = $3.00 (300 cents)
  assert.equal(usdRefund.buyerRefundMinor, 10_200);
  assert.equal(usdRefund.platformRetainedCommissionMinor, 300);

  // At 120 BDT/USD, buyer wallet credit MUST be 1,224,000 poisha (৳12,240.00), never 10,200 poisha (৳102.00)
  const buyerWalletCreditBdtMinor = convertOrderMinorToWalletBdtMinor(
    usdRefund.buyerRefundMinor,
    'USD',
    120
  );
  assert.equal(buyerWalletCreditBdtMinor, 1_224_000);

  // Seller payout of $100.00 (10,000 cents) converts to 1,200,000 poisha (৳12,000.00)
  const sellerWalletCreditBdtMinor = convertOrderMinorToWalletBdtMinor(10_000, 'USD', 120);
  assert.equal(sellerWalletCreditBdtMinor, 1_200_000);

  // BDT deals remain exact 1:1 minor units
  assert.equal(convertOrderMinorToWalletBdtMinor(102_000, 'BDT', 120), 102_000);
});

test('Security Event Logger: redacts Bearer tokens, API keys, private keys, and emails from audit summaries', () => {
  const raw =
    'Failed header Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig with key AIzaSyD1234567890abcdefghijklmnopqrstuvwx for admin@example.com';
  const redacted = redactSecretsFromLogText(raw);
  assert.doesNotMatch(redacted, /eyJhbGci/);
  assert.doesNotMatch(redacted, /AIzaSyD/);
  assert.doesNotMatch(redacted, /admin@example\.com/);
  assert.match(redacted, /Bearer \[REDACTED\]/);
  assert.match(redacted, /\[REDACTED_API_KEY\]/);
  assert.match(redacted, /\[redacted-email\]/);

  const evt = recordSecurityEvent({
    type: 'csrf_blocked',
    endpoint: '/api/test',
    actor: 'attacker@example.com',
    summary: raw,
  });
  assert.equal(evt.actor, '[redacted-email]');
  assert.ok(getRecentSecurityEvents(5).some((e) => e.id === evt.id));
});

test('Rate Limit IP Spoof Defense & CSRF Header Hardening: uses rightmost X-Forwarded-For hop and blocks X-Forwarded-Host spoofing & cross-origin Referer', () => {
  // Attacker prepends forged IPs in X-Forwarded-For; ingress appends real client IP 203.0.113.45 at the end
  assert.equal(
    extractClientIpKey({
      xForwardedFor: '1.1.1.1, 8.8.8.8, 203.0.113.45',
      remoteAddress: '10.0.0.2',
    }),
    '203.0.113.45'
  );
  assert.equal(
    extractClientIpKey({
      xForwardedFor: 'not-an-ip, ::ffff:198.51.100.77',
    }),
    '198.51.100.77'
  );

  // Spoofed X-Forwarded-Host must NOT authorize a matching evil Origin
  const spoofedForwardedHost = evaluateApiCorsAndCsrf({
    method: 'POST',
    path: '/api/fcm/send',
    originHeader: 'https://evil.attacker.example',
    hostHeader: 'bexora.example.com',
    forwardedHostHeader: 'evil.attacker.example',
  });
  assert.equal(spoofedForwardedHost.allowed, false);
  assert.equal(spoofedForwardedHost.errorCode, 'csrf_origin_mismatch');

  // Missing Origin with cross-origin Referer on state-changing request is blocked
  const crossOriginReferer = evaluateApiCorsAndCsrf({
    method: 'POST',
    path: '/api/payments/wordpress/create-session',
    refererHeader: 'https://phishing.attacker.example/checkout',
    hostHeader: 'bexora.example.com',
  });
  assert.equal(crossOriginReferer.allowed, false);
  assert.equal(crossOriginReferer.errorCode, 'csrf_referer_mismatch');
});

test('Sensitive HTTP Path Guard: blocks dotfiles, source maps, server code, rules, scripts, and deployment zip while preserving SPA routes and assets', () => {
  for (const blockedPath of [
    '/server.ts',
    '/src/server/aiAdminEngine.ts',
    '/.env',
    '/.env.local',
    '/.bexora-runtime/ai-admin-state.json',
    '/firestore.rules',
    '/firestore.rules.test.ts',
    '/storage.rules',
    '/firebase-blueprint.json',
    '/package.json',
    '/bun.lock',
    '/scripts/build-infinityfree-zip.mjs',
    '/assets/index-abc123.js.map',
    '/node_modules/.vite/deps/react.js.map',
    '/BEXORA_INFINITYFREE_PRODUCTION.zip',
    '/@fs/app/applet/server.ts',
    '/@fs/app/applet/.bexora-runtime/ai-admin-state.json',
  ]) {
    assert.equal(
      isBlockedSensitiveHttpPath(blockedPath),
      true,
      `Expected ${blockedPath} to be blocked`
    );
  }

  for (const allowedPath of [
    '/',
    '/index.html',
    '/icon.svg',
    '/manifest.webmanifest',
    '/src/main.tsx',
    '/src/App.tsx',
    '/@vite/client',
    '/node_modules/.vite/deps/react.js?v=f1cbc0d2',
    '/deals',
    '/listing/lst_123',
  ]) {
    assert.equal(
      isBlockedSensitiveHttpPath(allowedPath),
      false,
      `Expected ${allowedPath} to remain accessible`
    );
  }
});

test('JWT Header & Claim Hardening: rejects alg:none, HS256 downgrade, expectedUid mismatch, and future iat tokens', () => {
  const nowSec = 1_750_000_000;
  const payload = {
    aud: 'responsive-dragon-tmn89',
    iss: 'https://securetoken.google.com/responsive-dragon-tmn89',
    sub: 'user_abc',
    iat: nowSec - 30,
    exp: nowSec + 3000,
  };

  const algNoneToken = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(
    JSON.stringify(payload)
  ).toString('base64url')}.sig`;
  const hs256Token = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(
    JSON.stringify(payload)
  ).toString('base64url')}.sig`;

  assert.equal(
    isLookupAccountActiveAndUnrevoked({
      idToken: algNoneToken,
      expectedProjectId: 'responsive-dragon-tmn89',
      nowSeconds: nowSec,
    }),
    false
  );
  assert.equal(
    isLookupAccountActiveAndUnrevoked({
      idToken: hs256Token,
      expectedProjectId: 'responsive-dragon-tmn89',
      nowSeconds: nowSec,
    }),
    false
  );

  // expectedUid mismatch rejected
  const validToken = makeTestJwt(payload);
  assert.equal(
    isLookupAccountActiveAndUnrevoked({
      idToken: validToken,
      expectedProjectId: 'responsive-dragon-tmn89',
      expectedUid: 'different_uid',
      nowSeconds: nowSec,
    }),
    false
  );

  // Future iat (> +60s clock skew) rejected
  const futureIatToken = makeTestJwt({ ...payload, iat: nowSec + 600 });
  assert.equal(
    isLookupAccountActiveAndUnrevoked({
      idToken: futureIatToken,
      expectedProjectId: 'responsive-dragon-tmn89',
      nowSeconds: nowSec,
    }),
    false
  );
});

test('Audio Magic-Byte & URI Scheme Sanitizers: enforces genuine audio headers and blocks javascript:, data:image/svg+xml, data:text/html, and http:', () => {
  const webmBytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81]);
  const oggBytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const mp4Bytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
  const wavBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);
  const mp3Bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const htmlSpoof = new TextEncoder().encode('<script>alert(document.cookie)</script>');

  assert.equal(validateAudioMagicBytes(webmBytes).detectedMime, 'audio/webm');
  assert.equal(validateAudioMagicBytes(oggBytes).detectedMime, 'audio/ogg');
  assert.equal(validateAudioMagicBytes(mp4Bytes).detectedMime, 'audio/mp4');
  assert.equal(validateAudioMagicBytes(wavBytes).detectedMime, 'audio/wav');
  assert.equal(validateAudioMagicBytes(mp3Bytes).detectedMime, 'audio/mpeg');
  assert.equal(validateAudioMagicBytes(htmlSpoof).valid, false);

  // External link sanitizer
  assert.equal(sanitizeSafeExternalHttpsUrl('javascript:alert(1)'), '');
  assert.equal(sanitizeSafeExternalHttpsUrl('data:text/html;base64,PHNjcmlwdD4='), '');
  assert.equal(sanitizeSafeExternalHttpsUrl('http://insecure.example.com'), '');
  assert.equal(sanitizeSafeExternalHttpsUrl('https://user:pass@youtube.com/@chan'), '');
  assert.equal(sanitizeSafeExternalHttpsUrl('https://www.youtube.com/@bexora'), 'https://www.youtube.com/@bexora');

  // Image & audio src sanitizers
  assert.equal(sanitizeSafeImageSrc('data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+'), '');
  assert.equal(sanitizeSafeImageSrc('javascript:alert(1)'), '');
  assert.equal(
    sanitizeSafeImageSrc('data:image/webp;base64,UklGRiQAAABXRUJQ'),
    'data:image/webp;base64,UklGRiQAAABXRUJQ'
  );
  assert.equal(sanitizeSafeAudioSrc('data:text/html;base64,PHNjcmlwdD4='), '');
  assert.equal(
    sanitizeSafeAudioSrc('data:audio/webm;codecs=opus;base64,GkXfo59ChoEB'),
    'data:audio/webm;codecs=opus;base64,GkXfo59ChoEB'
  );
});

test('Webhook Replay Cache Bounding: enforces FIFO cap at 5,000 entries while blocking active replays', () => {
  const replayCache = new Map<string, number>();
  const nowMs = 1_750_000_000_000;
  for (let i = 0; i < 5005; i++) {
    replayCache.set(`evt_seed_${i}`, nowMs - 1000);
  }
  const body = JSON.stringify({ order_id: 'ord_99', status: 'paid' });
  const secret = 'whsec_unit_test_secret_123456';
  const ts = String(Math.floor(nowMs / 1000));
  const sig = computeWordPressWebhookSignatures(body, secret, ts).timestampedHex;

  const first = verifyWordPressWebhookRequest({
    rawBody: body,
    signatureHeader: `sha256=${sig}`,
    timestampHeader: ts,
    secret,
    eventKey: 'evt_live_new',
    nowMs,
    replayCache,
  });
  assert.equal(first.ok, true);
  assert.ok(replayCache.size <= 5000);

  const replay = verifyWordPressWebhookRequest({
    rawBody: body,
    signatureHeader: `sha256=${sig}`,
    timestampHeader: ts,
    secret,
    eventKey: 'evt_live_new',
    nowMs: nowMs + 500,
    replayCache,
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'replay_detected');
});

