import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, Type } from '@google/genai';
import {
  type App as AdminApp,
  applicationDefault,
  cert,
  getApps,
  initializeApp as initializeAdminApp,
  type ServiceAccount,
} from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getMessaging as getAdminMessaging } from 'firebase-admin/messaging';
import {
  assertSafeExternalHttpsDestination,
  buildSecurityHeaders,
  evaluateApiCorsAndCsrf,
  extractClientIpKey,
  getRecentSecurityEvents,
  isBlockedSensitiveHttpPath,
  isLookupAccountActiveAndUnrevoked,
  recordSecurityEvent,
  redactSecretsFromLogText,
  sanitizeJsonPayload,
  SlidingWindowRateLimiter,
  validateSafeExternalHttpsUrl,
  type SecurityAuditEvent,
} from './src/lib/serverSecurity';
import { validateImageMagicBytes } from './src/lib/marketplaceLogic';
import { verifyWordPressWebhookRequest } from './src/lib/serverWebhookSecurity';
import { createAiAdminEngine } from './src/server/aiAdminEngine';
import {
  mergeAndSortTickerItems,
  parseRawPublicActivityItem,
} from './src/lib/activityTickerLogic';
import { computeVerifiedMarketplaceStats } from './src/lib/reviewsAndStatsLogic';
import type { PublicActivityItem, ReviewRecord } from './src/types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;

function getGeminiClient(): GoogleGenAI | null {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key === 'MY_GEMINI_API_KEY' || key === 'YOUR_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey: key,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

interface RawBodyRequest extends express.Request {
  rawBody?: string;
}

function parseOptionalServiceAccountJson(): ServiceAccount | null {
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw || raw === '""' || raw === "''" || raw.startsWith('YOUR_')) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed.project_id === 'string' &&
      typeof parsed.client_email === 'string' &&
      typeof parsed.private_key === 'string' &&
      parsed.private_key.includes('BEGIN PRIVATE KEY')
    ) {
      return {
        projectId: parsed.project_id,
        clientEmail: parsed.client_email,
        privateKey: parsed.private_key.replace(/\\n/g, '\n'),
      };
    }
  } catch {
    // Fall back safely to keyless Managed Application Default Credentials
  }
  return null;
}

async function startServer() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  const webhookReplayCache = new Map<string, number>();
  const isProdRuntime =
    process.env.NODE_ENV === 'production' &&
    fs.existsSync(path.join(__dirname, 'dist', 'index.html'));

  function getCallerClientKey(req: express.Request): string {
    return extractClientIpKey({
      xForwardedFor:
        typeof req.headers['x-forwarded-for'] === 'string'
          ? req.headers['x-forwarded-for']
          : undefined,
      reqIp: req.ip,
      remoteAddress: req.socket?.remoteAddress,
    });
  }

  function makeRateLimitMiddleware(
    bucketName: string,
    limiter: SlidingWindowRateLimiter
  ): express.RequestHandler {
    return (req, res, next) => {
      const clientKey = `${bucketName}:${getCallerClientKey(req)}`;
      const decision = limiter.consume(clientKey);
      res.setHeader('X-RateLimit-Limit', String(decision.limit));
      res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
      if (!decision.allowed) {
        res.setHeader('Retry-After', String(decision.retryAfterSeconds));
        recordSecurityEvent({
          type: 'rate_limited',
          endpoint: req.originalUrl.split('?')[0] || req.path,
          actor: getCallerClientKey(req),
          summary: `Rate limit exceeded on ${bucketName} (retryAfter=${decision.retryAfterSeconds}s).`,
        });
        return res.status(429).json({
          ok: false,
          error: 'Too many requests. Please slow down and try again shortly.',
          retryAfterSeconds: decision.retryAfterSeconds,
        });
      }
      next();
    };
  }

  function consumeAuthenticatedUidLimit(
    req: express.Request,
    res: express.Response,
    bucketName: string,
    uid: string,
    limiter: SlidingWindowRateLimiter
  ): boolean {
    const decision = limiter.consume(`${bucketName}:uid:${uid}`);
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      recordSecurityEvent({
        type: 'rate_limited',
        endpoint: req.originalUrl.split('?')[0] || req.path,
        actor: uid,
        summary: `Authenticated UID rate limit exceeded on ${bucketName} (retryAfter=${decision.retryAfterSeconds}s).`,
      });
      res.status(429).json({
        ok: false,
        error: 'Too many requests for this account. Please wait briefly before retrying.',
        retryAfterSeconds: decision.retryAfterSeconds,
      });
      return false;
    }
    return true;
  }

  const diagnosticProbeLimiter = new SlidingWindowRateLimiter(30, 60_000);
  const cloudAdminMutationLimiter = new SlidingWindowRateLimiter(12, 60_000);
  const fcmDispatchLimiter = new SlidingWindowRateLimiter(45, 60_000);
  const aiComputeLimiter = new SlidingWindowRateLimiter(20, 60_000);
  const adminApiLimiter = new SlidingWindowRateLimiter(60, 60_000);
  const paymentSessionLimiter = new SlidingWindowRateLimiter(20, 60_000);
  const webhookLimiter = new SlidingWindowRateLimiter(120, 60_000);
  const telemetryLimiter = new SlidingWindowRateLimiter(20, 60_000, 4000);

  // Global HTTP Security Headers (CSP, HSTS on HTTPS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy)
  app.use((req, res, next) => {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]!
      .trim()
      .toLowerCase();
    const isHttps = req.secure || forwardedProto === 'https';
    const secHeaders = buildSecurityHeaders({ isHttps, isDev: !isProdRuntime });
    for (const [hdrKey, hdrVal] of Object.entries(secHeaders)) {
      res.setHeader(hdrKey, hdrVal);
    }
    next();
  });

  // Block direct HTTP access to server code, security rules, dotfiles, source maps, runtime state, and archives
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/') && isBlockedSensitiveHttpPath(req.originalUrl || req.url)) {
      return res.status(404).type('text/plain').send('Not Found');
    }
    next();
  });

  // Restrictive API CORS + Cross-Origin State-Changing CSRF Protection
  const configuredAllowedOrigins = String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  app.use('/api', (req, res, next) => {
    const fullPath = req.originalUrl.split('?')[0] || req.path;
    const decision = evaluateApiCorsAndCsrf({
      method: req.method,
      path: fullPath,
      originHeader: typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
      refererHeader: typeof req.headers.referer === 'string' ? req.headers.referer : undefined,
      hostHeader: req.get('host'),
      forwardedHostHeader:
        typeof req.headers['x-forwarded-host'] === 'string'
          ? req.headers['x-forwarded-host']
          : undefined,
      secFetchSiteHeader:
        typeof req.headers['sec-fetch-site'] === 'string'
          ? req.headers['sec-fetch-site']
          : undefined,
      allowedOrigins: configuredAllowedOrigins,
    });

    if (!decision.allowed) {
      recordSecurityEvent({
        type: 'csrf_blocked',
        endpoint: fullPath,
        actor: getCallerClientKey(req),
        summary: `Blocked cross-origin ${req.method} request (${decision.errorCode || 'csrf_blocked'}).`,
      });
      return res.status(decision.statusCode || 403).json({
        ok: false,
        error: 'Cross-origin state-changing API request blocked.',
        errorCode: decision.errorCode || 'csrf_blocked',
      });
    }

    if (decision.corsOriginToReflect) {
      res.setHeader('Access-Control-Allow-Origin', decision.corsOriginToReflect);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    }

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    next();
  });

  // Route-scoped JSON body size caps (5MB only for evidence screenshot check; 256KB everywhere else) + Prototype-Pollution Sanitizer
  const verifyEvidenceJsonParser = express.json({ limit: '5mb' });
  const defaultJsonParser = express.json({
    limit: '256kb',
    verify: (req, _res, buf) => {
      (req as RawBodyRequest).rawBody = buf.toString('utf8');
    },
  });

  app.use((req, res, next) => {
    const cleanPath = req.originalUrl.split('?')[0] || req.path;
    if (cleanPath === '/api/ai/verify-evidence') {
      return verifyEvidenceJsonParser(req, res, next);
    }
    return defaultJsonParser(req, res, next);
  });

  app.use((req, _res, next) => {
    if (req.body && typeof req.body === 'object') {
      req.body = sanitizeJsonPayload(req.body);
    }
    next();
  });

  app.use('/api/admin', makeRateLimitMiddleware('admin_api', adminApiLimiter));

  // 1. Health & Runtime Capabilities Endpoint
  app.get('/api/health', (_req, res) => {
    const aiConfigured = Boolean(getGeminiClient());
    const cfg = loadVerifiedFirebaseConfig();
    const explicitSa = parseOptionalServiceAccountJson();
    let firebaseAdminInitialized = false;
    try {
      if (cfg.configValid) {
        const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
        firebaseAdminInitialized = Boolean(adminApp?.options?.projectId === cfg.projectId);
      }
    } catch {
      firebaseAdminInitialized = false;
    }
    res.json({
      status: 'ok',
      service: 'bexora-backend',
      timestamp: new Date().toISOString(),
      aiVerificationConfigured: aiConfigured,
      firebaseAdminInitialized,
      credentialMode: explicitSa ? 'service_account_json' : 'managed_adc',
      manualPaymentEnv: {
        bkash: Boolean(process.env.BKASH_PAYMENT_NUMBER?.trim()),
        nagad: Boolean(process.env.NAGAD_PAYMENT_NUMBER?.trim()),
        rocket: Boolean(process.env.ROCKET_PAYMENT_NUMBER?.trim()),
      },
      liveGatewaysEnabled: Boolean(process.env.WORDPRESS_WEBHOOK_SECRET && process.env.WORDPRESS_WEBHOOK_SECRET.trim().length >= 16),
      twilioRequired: false,
    });
  });

  // 2. Safe Manual Payment Destination Endpoint (No secrets exposed)
  app.get('/api/config/payments', (_req, res) => {
    res.json({
      bkashNumber: (process.env.BKASH_PAYMENT_NUMBER || '').trim(),
      nagadNumber: (process.env.NAGAD_PAYMENT_NUMBER || '').trim(),
      rocketNumber: (process.env.ROCKET_PAYMENT_NUMBER || '').trim(),
      superadminPhoneConfigured: Boolean(process.env.BEXORA_SUPERADMIN_PHONE?.trim()),
    });
  });

  // 2B. Server-Side Firebase Auth & Token Service Diagnostic + Safe Enablement Endpoints
  type ServerTokenServiceStatus =
    | 'enabled_verified'
    | 'disabled'
    | 'enablement_pending'
    | 'permission_denied'
    | 'unable_to_verify'
    | 'config_mismatch';

  let lastEnableAttemptStatus: 'none' | 'enablement_pending' | 'permission_denied' = 'none';
  let lastEnableAttemptAtMs = 0;
  let cachedSandboxServiceAccount: string | null = null;

  async function resolveSandboxServiceAccountEmail(): Promise<string> {
    if (cachedSandboxServiceAccount !== null) return cachedSandboxServiceAccount;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const resp = await fetch(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email',
        {
          headers: { 'Metadata-Flavor': 'Google' },
          signal: controller.signal,
        }
      );
      clearTimeout(timer);
      if (resp.ok) {
        cachedSandboxServiceAccount = (await resp.text()).trim();
        return cachedSandboxServiceAccount;
      }
    } catch {
      // Metadata server not reachable outside GCP runtime
    }
    cachedSandboxServiceAccount = '';
    return '';
  }

  async function fetchSandboxMetadataAccessToken(): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const resp = await fetch(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        {
          headers: { 'Metadata-Flavor': 'Google' },
          signal: controller.signal,
        }
      );
      clearTimeout(timer);
      if (!resp.ok) return null;
      const json = (await resp.json()) as { access_token?: string };
      return typeof json.access_token === 'string' && json.access_token ? json.access_token : null;
    } catch {
      return null;
    }
  }

  function loadVerifiedFirebaseConfig() {
    const cfgPath = path.join(__dirname, 'firebase-applet-config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const apiKey = String(cfg.apiKey || '').trim();
    const projectId = String(cfg.projectId || '').trim();
    const projectNumber = String(cfg.messagingSenderId || '448578956301').trim();
    const appId = String(cfg.appId || '1:448578956301:web:091629c6e19eafa50ef944').trim();
    const firestoreDatabaseId = String(cfg.firestoreDatabaseId || '(default)').trim();
    const configValid =
      Boolean(apiKey) &&
      Boolean(projectId) &&
      projectId !== 'remixed-project-id' &&
      Boolean(projectNumber);
    const tokenServiceActivationUrl = `https://console.cloud.google.com/apis/library/securetoken.googleapis.com?project=${encodeURIComponent(
      projectId || projectNumber
    )}`;
    const iamConsoleUrl = `https://console.cloud.google.com/iam-admin/iam?project=${encodeURIComponent(
      projectId || projectNumber
    )}`;
    const firebaseAuthConsoleUrl = projectId
      ? `https://console.firebase.google.com/project/${encodeURIComponent(projectId)}/authentication/providers`
      : 'https://console.firebase.google.com/';
    const authDomain = String(cfg.authDomain || `${projectId}.firebaseapp.com`).trim();
    const storageBucket = String(cfg.storageBucket || `${projectId}.firebasestorage.app`).trim();
    return {
      apiKey,
      projectId,
      projectNumber,
      appId,
      authDomain,
      storageBucket,
      firestoreDatabaseId,
      configValid,
      tokenServiceActivationUrl,
      iamConsoleUrl,
      firebaseAuthConsoleUrl,
    };
  }

  async function probeSecureTokenStatus(cfg: ReturnType<typeof loadVerifiedFirebaseConfig>): Promise<{
    status: ServerTokenServiceStatus;
    httpStatus: number | null;
    detailMessage: string;
  }> {
    if (!cfg.configValid) {
      return {
        status: 'config_mismatch',
        httpStatus: null,
        detailMessage: 'Firebase configuration is missing projectId, messagingSenderId, or apiKey.',
      };
    }

    try {
      const tokenRes = await fetch(`https://securetoken.googleapis.com/v1/token?key=${cfg.apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: 'capability_probe_only',
        }),
      });
      const bodyText = await tokenRes.text().catch(() => '');

      if (
        tokenRes.status === 400 &&
        (bodyText.includes('INVALID_REFRESH_TOKEN') ||
          bodyText.includes('MISSING_REFRESH_TOKEN') ||
          bodyText.includes('INVALID_GRANT_TYPE'))
      ) {
        lastEnableAttemptStatus = 'none';
        return {
          status: 'enabled_verified',
          httpStatus: 400,
          detailMessage: `Token Service API (securetoken.googleapis.com) is verified active for project ${cfg.projectId} (${cfg.projectNumber}).`,
        };
      }

      if (tokenRes.status === 403) {
        if (
          bodyText.includes('SERVICE_DISABLED') ||
          bodyText.includes('securetoken.googleapis.com') ||
          bodyText.includes('Token Service API')
        ) {
          const withinPendingWindow =
            lastEnableAttemptStatus === 'enablement_pending' &&
            Date.now() - lastEnableAttemptAtMs < 5 * 60 * 1000;
          if (withinPendingWindow) {
            return {
              status: 'enablement_pending',
              httpStatus: 403,
              detailMessage:
                'Token Service API enablement succeeded in Google Cloud and is propagating (usually 1–3 minutes). Click Re-check Status shortly.',
            };
          }
          if (lastEnableAttemptStatus === 'permission_denied') {
            return {
              status: 'permission_denied',
              httpStatus: 403,
              detailMessage: `Token Service API is disabled in project ${cfg.projectId} (${cfg.projectNumber}), and the AI Studio runtime service account lacks Service Usage Admin permission to enable it automatically.`,
            };
          }
          return {
            status: 'disabled',
            httpStatus: 403,
            detailMessage: `Token Service API (securetoken.googleapis.com) is currently disabled in Google Cloud project ${cfg.projectId} (${cfg.projectNumber}).`,
          };
        }
        return {
          status: 'config_mismatch',
          httpStatus: 403,
          detailMessage:
            'API key restrictions or project mismatch blocked securetoken.googleapis.com verification.',
        };
      }

      if (bodyText.includes('API_KEY_INVALID') || bodyText.includes('PROJECT_NOT_FOUND')) {
        return {
          status: 'config_mismatch',
          httpStatus: tokenRes.status,
          detailMessage: 'Configured Firebase web API key does not match the active project.',
        };
      }

      return {
        status: 'unable_to_verify',
        httpStatus: tokenRes.status,
        detailMessage: `Could not conclusively verify Token Service API status (HTTP ${tokenRes.status}).`,
      };
    } catch {
      return {
        status: 'unable_to_verify',
        httpStatus: null,
        detailMessage: 'Network error while reaching Google Token Service endpoint.',
      };
    }
  }

  const authCapabilitiesCache = new Map<string, { expiresAtMs: number; payload: Record<string, unknown> }>();

  app.get(
    '/api/auth/capabilities',
    makeRateLimitMiddleware('auth_capabilities', diagnosticProbeLimiter),
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      try {
        const cfg = loadVerifiedFirebaseConfig();
        const isAdmin = Boolean(await verifyAdminCaller(req, cfg));
        const forceRefresh = req.query.refresh === '1' && isAdmin;
        const rawHost = String(req.get('host') || 'localhost:3000');
        const hostname = rawHost.split(':')[0]!.toLowerCase();
        const origin = `${req.protocol}://${rawHost}`;
        const sandboxServiceAccountEmail = isAdmin ? await resolveSandboxServiceAccountEmail() : '';
        const firebaseAuthorizedDomainsUrl = cfg.projectId
          ? `https://console.firebase.google.com/project/${encodeURIComponent(cfg.projectId)}/authentication/settings`
          : 'https://console.firebase.google.com/';

        if (!cfg.configValid) {
          return res.json({
            projectId: cfg.projectId,
            projectNumber: cfg.projectNumber,
            googleEnabled: false,
            googleProviderStatus: 'disabled',
            emailPasswordEnabled: false,
            emailPasswordStatus: 'disabled',
            phoneSmsEnabled: false,
            authorizedDomains: isAdmin ? [] : [],
            currentDomainAuthorized: false,
            tokenServiceEnabled: false,
            tokenServiceStatus: 'config_mismatch',
            tokenServiceMessage: 'Firebase configuration mismatch detected.',
            tokenServiceActivationUrl: isAdmin ? cfg.tokenServiceActivationUrl : '',
            iamConsoleUrl: isAdmin ? cfg.iamConsoleUrl : '',
            firebaseAuthConsoleUrl: isAdmin ? cfg.firebaseAuthConsoleUrl : '',
            firebaseAuthorizedDomainsUrl: isAdmin ? firebaseAuthorizedDomainsUrl : '',
            sandboxServiceAccountEmail,
            requiredRole: 'roles/serviceusage.serviceUsageAdmin',
            checkedAtMs: Date.now(),
          });
        }

        const cached = authCapabilitiesCache.get(hostname);
        if (!forceRefresh && cached && Date.now() < cached.expiresAtMs) {
          return res.json({
            ...cached.payload,
            tokenServiceActivationUrl: isAdmin ? cfg.tokenServiceActivationUrl : '',
            iamConsoleUrl: isAdmin ? cfg.iamConsoleUrl : '',
            firebaseAuthConsoleUrl: isAdmin ? cfg.firebaseAuthConsoleUrl : '',
            firebaseAuthorizedDomainsUrl: isAdmin ? firebaseAuthorizedDomainsUrl : '',
            sandboxServiceAccountEmail,
          });
        }

        const [googleRes, pwdRes, phoneRes, projCfgRes, tokenProbe] = await Promise.all([
          fetch(`https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${cfg.apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ providerId: 'google.com', continueUri: origin }),
          }).catch(() => null),
          fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${cfg.apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: 'capability-probe-nonexistent@bexora.invalid',
              password: 'probe_only_password_check',
              returnSecureToken: false,
            }),
          }).catch(() => null),
          fetch(`https://identitytoolkit.googleapis.com/v1/accounts:sendVerificationCode?key=${cfg.apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          }).catch(() => null),
          fetch(`https://identitytoolkit.googleapis.com/v1/projects?key=${cfg.apiKey}`).catch(() => null),
          probeSecureTokenStatus(cfg),
        ]);

        let googleProviderStatus: 'enabled' | 'disabled' | 'unable_to_verify' = 'unable_to_verify';
        let currentDomainAuthorized: boolean | null = null;
        if (googleRes) {
          const gText = await googleRes.text().catch(() => '');
          if (googleRes.status >= 500 || googleRes.status === 429) {
            googleProviderStatus = 'unable_to_verify';
          } else if (gText.includes('OPERATION_NOT_ALLOWED')) {
            googleProviderStatus = 'disabled';
            currentDomainAuthorized = true;
          } else if (gText.includes('UNAUTHORIZED_DOMAIN')) {
            googleProviderStatus = 'enabled';
            currentDomainAuthorized = false;
          } else if (googleRes.ok) {
            googleProviderStatus = 'enabled';
            currentDomainAuthorized = true;
          }
        }

        let emailPasswordStatus: 'enabled' | 'disabled' | 'unable_to_verify' = 'unable_to_verify';
        if (pwdRes) {
          const pwdText = await pwdRes.text().catch(() => '');
          if (pwdRes.status >= 500 || pwdRes.status === 429) {
            emailPasswordStatus = 'unable_to_verify';
          } else if (
            pwdText.includes('PASSWORD_LOGIN_DISABLED') ||
            pwdText.includes('OPERATION_NOT_ALLOWED')
          ) {
            emailPasswordStatus = 'disabled';
          } else if (
            pwdRes.ok ||
            (pwdRes.status === 400 &&
              (pwdText.includes('EMAIL_NOT_FOUND') ||
                pwdText.includes('INVALID_LOGIN_CREDENTIALS') ||
                pwdText.includes('INVALID_PASSWORD') ||
                pwdText.includes('INVALID_EMAIL') ||
                pwdText.includes('USER_DISABLED') ||
                pwdText.includes('TOO_MANY_ATTEMPTS_TRY_LATER')))
          ) {
            emailPasswordStatus = 'enabled';
          }
        }

        let phoneSmsEnabled = true;
        if (phoneRes) {
          const phoneJson = (await phoneRes.json().catch(() => ({}))) as { error?: { message?: string } };
          const phoneMsg = String(phoneJson?.error?.message || '');
          if (phoneMsg.includes('OPERATION_NOT_ALLOWED') || phoneMsg.includes('BILLING_NOT_ENABLED')) {
            phoneSmsEnabled = false;
          }
        }

        let authorizedDomains: string[] = [];
        if (projCfgRes && projCfgRes.ok) {
          const projJson = (await projCfgRes.json().catch(() => ({}))) as { authorizedDomains?: unknown };
          if (Array.isArray(projJson.authorizedDomains)) {
            authorizedDomains = projJson.authorizedDomains.filter((d): d is string => typeof d === 'string');
            if (authorizedDomains.length > 0 && hostname) {
              currentDomainAuthorized = authorizedDomains.some((d) => d.toLowerCase() === hostname);
            }
          }
        }

        const basePayload: Record<string, unknown> = {
          projectId: cfg.projectId,
          projectNumber: cfg.projectNumber,
          googleEnabled: googleProviderStatus !== 'disabled',
          googleProviderStatus,
          emailPasswordEnabled: emailPasswordStatus !== 'disabled',
          emailPasswordStatus,
          phoneSmsEnabled,
          authorizedDomains,
          currentDomainAuthorized,
          tokenServiceEnabled: tokenProbe.status === 'enabled_verified',
          tokenServiceStatus: tokenProbe.status,
          tokenServiceMessage: tokenProbe.detailMessage,
          requiredRole: 'roles/serviceusage.serviceUsageAdmin',
          checkedAtMs: Date.now(),
        };

        authCapabilitiesCache.set(hostname, {
          expiresAtMs: Date.now() + 20_000,
          payload: basePayload,
        });

        return res.json({
          ...basePayload,
          tokenServiceActivationUrl: isAdmin ? cfg.tokenServiceActivationUrl : '',
          iamConsoleUrl: isAdmin ? cfg.iamConsoleUrl : '',
          firebaseAuthConsoleUrl: isAdmin ? cfg.firebaseAuthConsoleUrl : '',
          firebaseAuthorizedDomainsUrl: isAdmin ? firebaseAuthorizedDomainsUrl : '',
          sandboxServiceAccountEmail,
        });
      } catch {
        return res.json({
          googleEnabled: true,
          googleProviderStatus: 'unable_to_verify',
          emailPasswordEnabled: true,
          emailPasswordStatus: 'unable_to_verify',
          phoneSmsEnabled: false,
          authorizedDomains: [],
          currentDomainAuthorized: null,
          tokenServiceEnabled: false,
          tokenServiceStatus: 'unable_to_verify',
          tokenServiceMessage: 'Temporary network issue while probing Firebase Auth capabilities.',
          sandboxServiceAccountEmail: '',
          iamConsoleUrl: '',
          checkedAtMs: Date.now(),
        });
      }
    }
  );

  app.post(
    '/api/auth/enable-token-service',
    makeRateLimitMiddleware('enable_token_service', cloudAdminMutationLimiter),
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const cfg = loadVerifiedFirebaseConfig();
        const adminCaller = await verifyAdminCaller(req, cfg);
        if (!adminCaller) {
          recordSecurityEvent({
            type: 'admin_denied',
            endpoint: '/api/auth/enable-token-service',
            actor: getCallerClientKey(req),
            summary: 'Non-admin caller blocked from Cloud Token Service enablement.',
          });
          return res.status(403).json({
            ok: false,
            tokenServiceStatus: 'permission_denied' as ServerTokenServiceStatus,
            tokenServiceEnabled: false,
            message: 'Administrator authentication is required to manage Cloud Token Service settings.',
          });
        }
        const sandboxServiceAccountEmail = await resolveSandboxServiceAccountEmail();

      if (!cfg.configValid) {
        return res.json({
          ok: false,
          tokenServiceStatus: 'config_mismatch' as ServerTokenServiceStatus,
          tokenServiceEnabled: false,
          projectId: cfg.projectId,
          projectNumber: cfg.projectNumber,
          tokenServiceActivationUrl: cfg.tokenServiceActivationUrl,
          iamConsoleUrl: cfg.iamConsoleUrl,
          firebaseAuthConsoleUrl: cfg.firebaseAuthConsoleUrl,
          sandboxServiceAccountEmail,
          requiredRole: 'roles/serviceusage.serviceUsageAdmin',
          message: `Safety check blocked modification: invalid or uninitialized Firebase project configuration (${cfg.projectId || 'missing'}).`,
        });
      }

      // First verify whether securetoken.googleapis.com is already active
      const currentProbe = await probeSecureTokenStatus(cfg);
      if (currentProbe.status === 'enabled_verified') {
        return res.json({
          ok: true,
          tokenServiceStatus: 'enabled_verified' as ServerTokenServiceStatus,
          tokenServiceEnabled: true,
          projectId: cfg.projectId,
          projectNumber: cfg.projectNumber,
          tokenServiceActivationUrl: cfg.tokenServiceActivationUrl,
          iamConsoleUrl: cfg.iamConsoleUrl,
          sandboxServiceAccountEmail,
          requiredRole: 'roles/serviceusage.serviceUsageAdmin',
          message: `Token Service API (securetoken.googleapis.com) is verified active for ${cfg.projectId} (${cfg.projectNumber}).`,
        });
      }

      // Rate-limit repeated enablement calls within 6 seconds
      if (Date.now() - lastEnableAttemptAtMs < 6000 && lastEnableAttemptStatus !== 'none') {
        return res.json({
          ok: lastEnableAttemptStatus === 'enablement_pending',
          tokenServiceStatus: lastEnableAttemptStatus as ServerTokenServiceStatus,
          tokenServiceEnabled: false,
          projectId: cfg.projectId,
          projectNumber: cfg.projectNumber,
          tokenServiceActivationUrl: cfg.tokenServiceActivationUrl,
          iamConsoleUrl: cfg.iamConsoleUrl,
          sandboxServiceAccountEmail,
          requiredRole: 'roles/serviceusage.serviceUsageAdmin',
          message:
            lastEnableAttemptStatus === 'enablement_pending'
              ? 'Enablement request already sent and propagating in Google Cloud. Please wait ~60 seconds and click Re-check Status.'
              : `Automatic enablement requires Service Usage Admin (${sandboxServiceAccountEmail || 'runtime service account'}) on project ${cfg.projectId}, or 1-click activation in Google Cloud Console.`,
        });
      }

      lastEnableAttemptAtMs = Date.now();
      const accessToken = await fetchSandboxMetadataAccessToken();
      if (!accessToken) {
        lastEnableAttemptStatus = 'permission_denied';
        return res.json({
          ok: false,
          tokenServiceStatus: 'permission_denied' as ServerTokenServiceStatus,
          tokenServiceEnabled: false,
          projectId: cfg.projectId,
          projectNumber: cfg.projectNumber,
          tokenServiceActivationUrl: cfg.tokenServiceActivationUrl,
          iamConsoleUrl: cfg.iamConsoleUrl,
          sandboxServiceAccountEmail,
          requiredRole: 'roles/serviceusage.serviceUsageAdmin',
          message: `No Google Cloud Service Usage credentials are attached to this server runtime. Enable Token Service API directly in Google Cloud Console for project ${cfg.projectId} (${cfg.projectNumber}).`,
        });
      }

      const enableRes = await fetch(
        `https://serviceusage.googleapis.com/v1/projects/${encodeURIComponent(
          cfg.projectId
        )}/services/securetoken.googleapis.com:enable`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'X-Goog-User-Project': cfg.projectId,
          },
          body: JSON.stringify({}),
        }
      );

      if (enableRes.ok) {
        // Poll up to 2 times for fast propagation
        for (let attempt = 0; attempt < 2; attempt++) {
          await new Promise((r) => setTimeout(r, 1200));
          const verifyAfter = await probeSecureTokenStatus(cfg);
          if (verifyAfter.status === 'enabled_verified') {
            lastEnableAttemptStatus = 'none';
            return res.json({
              ok: true,
              tokenServiceStatus: 'enabled_verified' as ServerTokenServiceStatus,
              tokenServiceEnabled: true,
              projectId: cfg.projectId,
              projectNumber: cfg.projectNumber,
              tokenServiceActivationUrl: cfg.tokenServiceActivationUrl,
              iamConsoleUrl: cfg.iamConsoleUrl,
              sandboxServiceAccountEmail,
              requiredRole: 'roles/serviceusage.serviceUsageAdmin',
              message: `Token Service API (securetoken.googleapis.com) was enabled and verified active on ${cfg.projectId}!`,
            });
          }
        }

        lastEnableAttemptStatus = 'enablement_pending';
        return res.json({
          ok: true,
          tokenServiceStatus: 'enablement_pending' as ServerTokenServiceStatus,
          tokenServiceEnabled: false,
          projectId: cfg.projectId,
          projectNumber: cfg.projectNumber,
          tokenServiceActivationUrl: cfg.tokenServiceActivationUrl,
          iamConsoleUrl: cfg.iamConsoleUrl,
          sandboxServiceAccountEmail,
          requiredRole: 'roles/serviceusage.serviceUsageAdmin',
          message:
            'Google Cloud accepted the Token Service API enablement request. Propagation takes 1–3 minutes — click Re-check Status shortly.',
        });
      }

      lastEnableAttemptStatus = 'permission_denied';
      return res.json({
        ok: false,
        tokenServiceStatus: 'permission_denied' as ServerTokenServiceStatus,
        tokenServiceEnabled: false,
        projectId: cfg.projectId,
        projectNumber: cfg.projectNumber,
        tokenServiceActivationUrl: cfg.tokenServiceActivationUrl,
        iamConsoleUrl: cfg.iamConsoleUrl,
        firebaseAuthConsoleUrl: cfg.firebaseAuthConsoleUrl,
        sandboxServiceAccountEmail,
        requiredRole: 'roles/serviceusage.serviceUsageAdmin',
        message: sandboxServiceAccountEmail
          ? `Google Cloud IAM denied automatic enablement because ${sandboxServiceAccountEmail} lacks Service Usage Admin (roles/serviceusage.serviceUsageAdmin) on project ${cfg.projectId} (${cfg.projectNumber}). Open Cloud Console specifically for project ${cfg.projectId} (not another project) to click Enable, or link a clean self-owned Firebase project where your account holds Project Owner.`
          : `Google Cloud IAM denied automatic Service Usage enablement on project ${cfg.projectId} (${cfg.projectNumber}). Enable Token Service API directly in Google Cloud Console for project ${cfg.projectId}.`,
      });
    } catch {
      return res.json({
        ok: false,
        tokenServiceStatus: 'unable_to_verify' as ServerTokenServiceStatus,
        tokenServiceEnabled: false,
        message: 'Could not reach Google Cloud Service Usage API. Check connectivity and try again.',
      });
    }
  });

  // 2C. Server-Side Firebase Admin & Cloud Messaging (Managed ADC, Official FCM Public VAPID & FCM HTTP v1 Delivery)
  const BOOTSTRAPPED_SUPERADMIN_UID = 'FFiOzaXKxBMuCzoQXM68sy3aPax2';
  const BOOTSTRAPPED_SUPERADMIN_EMAIL = 'tanvirislam7574@gmail.com';
  const FCM_OFFICIAL_DEFAULT_VAPID_PUBLIC_KEY =
    'BDOU99-h67HcA6JeFXHbSNMu7e2yNNu3RzoMj8TM4W88jITfq7ZmPvIM1Iv-4_l2LxQcYwhqby2xGpWwzjfAnG4';

  function isValidServerVapidPublicKey(rawKey: string | undefined): boolean {
    if (typeof rawKey !== 'string') return false;
    const trimmed = rawKey.trim();
    if (!trimmed || trimmed.length < 84 || trimmed.length > 92) return false;
    if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return false;
    try {
      const base64 = trimmed.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
      const bytes = Buffer.from(padded, 'base64');
      return bytes.length === 65 && bytes[0] === 0x04;
    } catch {
      return false;
    }
  }

  async function resolveServerCloudAccessToken(): Promise<string | null> {
    return fetchSandboxMetadataAccessToken();
  }

  function getOrInitFirebaseAdminApp(projectId: string): AdminApp {
    const appName = `bexora-fcm-${projectId}`;
    const existingApp = getApps().find((a) => a.name === appName);
    if (existingApp) return existingApp;

    const explicitSa = parseOptionalServiceAccountJson();
    return initializeAdminApp(
      {
        credential: explicitSa ? cert(explicitSa) : applicationDefault(),
        projectId,
      },
      appName
    );
  }

  async function verifyCallerFirebaseToken(
    req: express.Request,
    cfg: ReturnType<typeof loadVerifiedFirebaseConfig>
  ): Promise<{ uid: string; email: string; emailVerified: boolean; idToken: string } | null> {
    const authHeader = String(req.headers.authorization || '');
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!idToken || !cfg.configValid) return null;
    try {
      const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
      const decoded = await getAdminAuth(adminApp).verifyIdToken(idToken, true);
      const uid = String(decoded.uid || '').trim();
      if (uid) {
        return {
          uid,
          email: String(decoded.email || '').trim().toLowerCase(),
          emailVerified: Boolean(decoded.email_verified),
          idToken,
        };
      }
    } catch (verifyErr) {
      const errCode =
        verifyErr && typeof verifyErr === 'object' && 'code' in verifyErr
          ? String((verifyErr as { code?: unknown }).code || '')
          : '';
      if (
        errCode === 'auth/id-token-revoked' ||
        errCode === 'auth/user-disabled' ||
        errCode === 'auth/id-token-expired' ||
        errCode === 'auth/argument-error'
      ) {
        recordSecurityEvent({
          type: 'auth_failure',
          endpoint: req.originalUrl.split('?')[0] || req.path,
          actor: getCallerClientKey(req),
          summary: `Rejected Firebase ID token (${errCode}).`,
        });
        return null;
      }
      // Fallback to Identity Toolkit accounts:lookup when public cert fetch or securetoken is restricted
    }
    try {
      const lookupRes = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(cfg.apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        }
      );
      if (!lookupRes.ok) return null;
      const lookupJson = (await lookupRes.json()) as {
        users?: Array<{
          localId?: string;
          email?: string;
          emailVerified?: boolean;
          disabled?: boolean;
          validSince?: string;
        }>;
      };
      const u = lookupJson.users?.[0];
      const uid = String(u?.localId || '').trim();
      if (!uid) return null;
      if (
        !isLookupAccountActiveAndUnrevoked({
          idToken,
          expectedProjectId: cfg.projectId,
          expectedUid: uid,
          disabled: u?.disabled,
          validSinceSecondsRaw: u?.validSince,
        })
      ) {
        recordSecurityEvent({
          type: 'auth_failure',
          endpoint: req.originalUrl.split('?')[0] || req.path,
          actor: uid,
          summary: 'Rejected disabled or revoked Firebase session during Identity Toolkit lookup.',
        });
        return null;
      }
      return {
        uid,
        email: String(u?.email || '').trim().toLowerCase(),
        emailVerified: Boolean(u?.emailVerified),
        idToken,
      };
    } catch {
      return null;
    }
  }

  async function verifyAdminCaller(
    req: express.Request,
    cfg: ReturnType<typeof loadVerifiedFirebaseConfig>
  ): Promise<{ uid: string; email: string; role: 'admin' | 'superadmin'; idToken: string } | null> {
    const caller = await verifyCallerFirebaseToken(req, cfg);
    if (!caller) return null;
    if (
      caller.uid === BOOTSTRAPPED_SUPERADMIN_UID ||
      (caller.emailVerified && caller.email === BOOTSTRAPPED_SUPERADMIN_EMAIL)
    ) {
      return { uid: caller.uid, email: caller.email, role: 'superadmin', idToken: caller.idToken };
    }
    try {
      const firestoreBaseUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
        cfg.projectId
      )}/databases/${encodeURIComponent(cfg.firestoreDatabaseId)}/documents`;
      const adminDocRes = await fetch(`${firestoreBaseUrl}/admins/${encodeURIComponent(caller.uid)}`, {
        headers: { Authorization: `Bearer ${caller.idToken}` },
      });
      if (!adminDocRes.ok) return null;
      const adminDoc = (await adminDocRes.json()) as {
        fields?: Record<string, { stringValue?: string }>;
      };
      const roleVal = adminDoc.fields?.role?.stringValue;
      if (roleVal === 'admin' || roleVal === 'superadmin') {
        return { uid: caller.uid, email: caller.email, role: roleVal, idToken: caller.idToken };
      }
    } catch {
      return null;
    }
    return null;
  }

  async function isAiEmergencyStopActive(
    cfg: ReturnType<typeof loadVerifiedFirebaseConfig>
  ): Promise<boolean> {
    if (!cfg.configValid) return false;
    try {
      const firestoreBaseUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
        cfg.projectId
      )}/databases/${encodeURIComponent(cfg.firestoreDatabaseId)}/documents`;
      const resp = await fetch(`${firestoreBaseUrl}/publicConfig/settings?key=${encodeURIComponent(cfg.apiKey)}`);
      if (!resp.ok) return false;
      const docJson = (await resp.json()) as {
        fields?: Record<string, { booleanValue?: boolean }>;
      };
      return docJson.fields?.aiEmergencyStop?.booleanValue === true;
    } catch {
      return false;
    }
  }

  // Eagerly initialize Firebase Admin SDK (`firebase-admin/app`, `firebase-admin/auth`, `firebase-admin/messaging`)
  // at server startup using Google Cloud Run Managed Application Default Credentials (zero private keys).
  try {
    const bootCfg = loadVerifiedFirebaseConfig();
    if (bootCfg.configValid) {
      const bootAdmin = getOrInitFirebaseAdminApp(bootCfg.projectId);
      getAdminAuth(bootAdmin);
      getAdminMessaging(bootAdmin);
    }
  } catch {
    // Non-fatal in isolated test environments without metadata server
  }

  function sanitizeServerPushDestination(rawDest: unknown): string {
    if (typeof rawDest !== 'string') return '';
    const trimmed = rawDest.trim();
    if (!trimmed || trimmed.length > 160) return '';
    const lower = trimmed.toLowerCase();
    if (
      lower.startsWith('http:') ||
      lower.startsWith('https:') ||
      lower.startsWith('javascript:') ||
      lower.startsWith('data:') ||
      lower.startsWith('//') ||
      trimmed.includes('..') ||
      trimmed.includes('<') ||
      trimmed.includes('>') ||
      trimmed.includes('\\')
    ) {
      return '';
    }
    return /^[a-zA-Z0-9_:-]{1,160}$/.test(trimmed) ? trimmed : '';
  }

  function redactSensitivePreviewServer(text: unknown): string {
    return String(text || '')
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
      .replace(/(?:\+?\d[\d\s-]{8,16}\d)/g, '[redacted-number]')
      .replace(/(?:৳|\$|BDT\s*|USD\s*)\s*\d[\d,.]*/gi, '[escrow amount]')
      .replace(/\b[A-Za-z0-9_-]{36,}\b/g, '[id]')
      .trim();
  }

  function readFirestoreStringField(docJson: Record<string, unknown> | null, key: string): string {
    if (!docJson || typeof docJson !== 'object') return '';
    const fields = (docJson as { fields?: Record<string, { stringValue?: string }> }).fields;
    return typeof fields?.[key]?.stringValue === 'string' ? fields[key].stringValue! : '';
  }

  function readFirestoreBooleanField(docJson: Record<string, unknown> | null, key: string): boolean {
    if (!docJson || typeof docJson !== 'object') return false;
    const fields = (docJson as { fields?: Record<string, { booleanValue?: boolean }> }).fields;
    return Boolean(fields?.[key]?.booleanValue);
  }

  function readFirestoreNumberField(docJson: Record<string, unknown> | null, key: string): number {
    if (!docJson || typeof docJson !== 'object') return 0;
    const fields = (docJson as {
      fields?: Record<string, { integerValue?: string | number; doubleValue?: number }>;
    }).fields;
    const f = fields?.[key];
    if (!f) return 0;
    if (f.integerValue !== undefined) return Number(f.integerValue) || 0;
    if (f.doubleValue !== undefined) return Number(f.doubleValue) || 0;
    return 0;
  }

  function readFirestoreTimestampMs(docJson: Record<string, unknown> | null, key: string): number {
    if (!docJson || typeof docJson !== 'object') return 0;
    const fields = (docJson as {
      fields?: Record<string, { timestampValue?: string; integerValue?: string | number }>;
    }).fields;
    const f = fields?.[key];
    if (!f) return 0;
    if (typeof f.timestampValue === 'string') {
      const parsed = Date.parse(f.timestampValue);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    if (f.integerValue !== undefined) return Number(f.integerValue) || 0;
    return 0;
  }

  async function runPublicFirestoreQuery(
    cfg: ReturnType<typeof loadVerifiedFirebaseConfig>,
    structuredQuery: Record<string, unknown>
  ): Promise<Array<{ id: string; doc: Record<string, unknown> }>> {
    if (!cfg.configValid || !cfg.apiKey) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    try {
      const queryUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
        cfg.projectId
      )}/databases/${encodeURIComponent(
        cfg.firestoreDatabaseId
      )}/documents:runQuery?key=${encodeURIComponent(cfg.apiKey)}`;
      const res = await fetch(queryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ structuredQuery }),
        signal: controller.signal,
      });
      if (!res.ok) return [];
      const rows = (await res.json()) as Array<{ document?: { name?: string; fields?: unknown } }>;
      if (!Array.isArray(rows)) return [];
      const out: Array<{ id: string; doc: Record<string, unknown> }> = [];
      for (const row of rows) {
        if (!row?.document?.name) continue;
        const parts = row.document.name.split('/');
        const id = parts[parts.length - 1] || '';
        if (id) {
          out.push({ id, doc: row.document as unknown as Record<string, unknown> });
        }
      }
      return out;
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  let cachedPublicActivityTickers: {
    expiresAtMs: number;
    payload: {
      ok: true;
      sold: PublicActivityItem[];
      payout: PublicActivityItem[];
      updatedAtMs: number;
    };
  } | null = null;

  app.get(
    '/api/public/activity-tickers',
    makeRateLimitMiddleware('public_activity_tickers', diagnosticProbeLimiter),
    async (_req, res) => {
      res.setHeader('Cache-Control', 'public, max-age=10');
      try {
        if (cachedPublicActivityTickers && Date.now() < cachedPublicActivityTickers.expiresAtMs) {
          return res.json(cachedPublicActivityTickers.payload);
        }
        const cfg = loadVerifiedFirebaseConfig();
        const docs = await runPublicFirestoreQuery(cfg, {
          from: [{ collectionId: 'publicActivity' }],
          orderBy: [{ field: { fieldPath: 'completedAtMs' }, direction: 'DESCENDING' }],
          limit: 35,
        });

        const parsed: PublicActivityItem[] = [];
        for (const entry of docs) {
          const item = parseRawPublicActivityItem(entry.id, {
            kind: readFirestoreStringField(entry.doc, 'kind'),
            actorDisplayName: readFirestoreStringField(entry.doc, 'actorDisplayName'),
            actorVerified: readFirestoreBooleanField(entry.doc, 'actorVerified'),
            assetTitle: readFirestoreStringField(entry.doc, 'assetTitle'),
            platform: readFirestoreStringField(entry.doc, 'platform'),
            amountMinor: readFirestoreNumberField(entry.doc, 'amountMinor'),
            currency: readFirestoreStringField(entry.doc, 'currency'),
            completedAtMs: readFirestoreNumberField(entry.doc, 'completedAtMs'),
          });
          if (item) parsed.push(item);
        }

        const sold = mergeAndSortTickerItems(
          parsed.filter((item) => item.kind === 'sold'),
          18
        );
        const payout = mergeAndSortTickerItems(
          parsed.filter((item) => item.kind === 'payout'),
          18
        );
        const payload = {
          ok: true as const,
          sold,
          payout,
          updatedAtMs: Date.now(),
        };
        cachedPublicActivityTickers = {
          expiresAtMs: Date.now() + 15_000,
          payload,
        };
        return res.json(payload);
      } catch {
        return res.json({
          ok: true,
          sold: [],
          payout: [],
          updatedAtMs: Date.now(),
        });
      }
    }
  );

  let cachedPublicMarketplaceStats: {
    expiresAtMs: number;
    payload: Record<string, unknown>;
  } | null = null;

  app.get(
    '/api/public/marketplace-stats',
    makeRateLimitMiddleware('public_marketplace_stats', diagnosticProbeLimiter),
    async (_req, res) => {
      res.setHeader('Cache-Control', 'public, max-age=15');
      try {
        if (cachedPublicMarketplaceStats && Date.now() < cachedPublicMarketplaceStats.expiresAtMs) {
          return res.json(cachedPublicMarketplaceStats.payload);
        }
        const cfg = loadVerifiedFirebaseConfig();
        const [listingDocs, profileDocs, activityDocs, reviewDocs] = await Promise.all([
          runPublicFirestoreQuery(cfg, {
            from: [{ collectionId: 'listings' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'status' },
                op: 'IN',
                value: {
                  arrayValue: {
                    values: [{ stringValue: 'active' }, { stringValue: 'reserved' }],
                  },
                },
              },
            },
            limit: 100,
          }),
          runPublicFirestoreQuery(cfg, {
            from: [{ collectionId: 'publicProfiles' }],
            limit: 100,
          }),
          runPublicFirestoreQuery(cfg, {
            from: [{ collectionId: 'publicActivity' }],
            orderBy: [{ field: { fieldPath: 'completedAtMs' }, direction: 'DESCENDING' }],
            limit: 40,
          }),
          runPublicFirestoreQuery(cfg, {
            from: [{ collectionId: 'reviews' }],
            limit: 100,
          }),
        ]);

        const listings = listingDocs.map((e) => ({
          status: (readFirestoreStringField(e.doc, 'status') || 'active') as 'active' | 'reserved',
        }));
        const publicProfiles = profileDocs.map((e) => ({
          nidVerified: readFirestoreBooleanField(e.doc, 'nidVerified'),
          completedSales: readFirestoreNumberField(e.doc, 'completedSales'),
        }));
        const publicActivities: PublicActivityItem[] = [];
        for (const e of activityDocs) {
          const item = parseRawPublicActivityItem(e.id, {
            kind: readFirestoreStringField(e.doc, 'kind'),
            actorDisplayName: readFirestoreStringField(e.doc, 'actorDisplayName'),
            actorVerified: readFirestoreBooleanField(e.doc, 'actorVerified'),
            assetTitle: readFirestoreStringField(e.doc, 'assetTitle'),
            platform: readFirestoreStringField(e.doc, 'platform'),
            amountMinor: readFirestoreNumberField(e.doc, 'amountMinor'),
            currency: readFirestoreStringField(e.doc, 'currency'),
            completedAtMs: readFirestoreNumberField(e.doc, 'completedAtMs'),
          });
          if (item) publicActivities.push(item);
        }
        const reviews: ReviewRecord[] = reviewDocs.map((e) => ({
          id: e.id,
          dealId: readFirestoreStringField(e.doc, 'dealId'),
          sellerId: readFirestoreStringField(e.doc, 'sellerId'),
          reviewerId: readFirestoreStringField(e.doc, 'reviewerId'),
          reviewerName: readFirestoreStringField(e.doc, 'reviewerName'),
          score: readFirestoreNumberField(e.doc, 'score'),
          comment: readFirestoreStringField(e.doc, 'comment'),
          moderationStatus:
            readFirestoreStringField(e.doc, 'moderationStatus') === 'hidden'
              ? 'hidden'
              : 'published',
          createdAtMs:
            readFirestoreTimestampMs(e.doc, 'createdAt') || Date.now(),
        }));

        const stats = computeVerifiedMarketplaceStats({
          listings,
          publicProfiles,
          publicActivities,
          reviews,
          nowMs: Date.now(),
        });

        const payload = { ok: true, stats };
        cachedPublicMarketplaceStats = {
          expiresAtMs: Date.now() + 20_000,
          payload,
        };
        return res.json(payload);
      } catch {
        return res.json({
          ok: true,
          stats: computeVerifiedMarketplaceStats({
            listings: [],
            publicProfiles: [],
            publicActivities: [],
            reviews: [],
            nowMs: Date.now(),
          }),
        });
      }
    }
  );

  let cachedFcmStatus: { expiresAtMs: number; payload: Record<string, unknown> } | null = null;

  app.get(
    '/api/fcm/status',
    makeRateLimitMiddleware('fcm_status', diagnosticProbeLimiter),
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const cfg = loadVerifiedFirebaseConfig();
        const isAdmin = Boolean(await verifyAdminCaller(req, cfg));
        const forceRefresh = req.query.refresh === '1' && isAdmin;
        const sandboxServiceAccountEmail = isAdmin ? await resolveSandboxServiceAccountEmail() : '';

        if (!forceRefresh && cachedFcmStatus && Date.now() < cachedFcmStatus.expiresAtMs) {
          const cachedDetail = String(cachedFcmStatus.payload.detailMessage || '');
          const publicSafeDetail =
            !isAdmin && cachedFcmStatus.payload.fcmSendApiStatus === 'permission_denied'
              ? `Server runtime (Managed ADC) needs roles/firebasecloudmessaging.admin and roles/datastore.user on project ${cfg.projectId} to dispatch closed-tab background pushes.`
              : cachedDetail;
          return res.json({
            ...cachedFcmStatus.payload,
            sandboxServiceAccountEmail,
            iamConsoleUrl: isAdmin ? cfg.iamConsoleUrl : '',
            firebaseCloudMessagingConsoleUrl: isAdmin
              ? cachedFcmStatus.payload.firebaseCloudMessagingConsoleUrl
              : '',
            fcmRegistrationsActivationUrl: isAdmin
              ? cachedFcmStatus.payload.fcmRegistrationsActivationUrl
              : '',
            fcmV1ActivationUrl: isAdmin ? cachedFcmStatus.payload.fcmV1ActivationUrl : '',
            firebaseInstallationsActivationUrl: isAdmin
              ? cachedFcmStatus.payload.firebaseInstallationsActivationUrl
              : '',
            detailMessage: publicSafeDetail,
          });
        }

        const fullSandboxEmail = await resolveSandboxServiceAccountEmail();
        const envMap = process.env as Record<string, string | undefined>;
        const rawCustomVapid = String(envMap['VITE_FIREBASE_VAPID_KEY'] || '').trim();
        const hasCustomEnvVapid = Boolean(
          rawCustomVapid &&
            rawCustomVapid !== 'YOUR_FIREBASE_VAPID_KEY' &&
            rawCustomVapid !== 'MY_FIREBASE_VAPID_KEY' &&
            rawCustomVapid !== 'PASTE_YOUR_VAPID_KEY_HERE' &&
            rawCustomVapid !== FCM_OFFICIAL_DEFAULT_VAPID_PUBLIC_KEY
        );
        const effectiveVapidKey = hasCustomEnvVapid
          ? rawCustomVapid
          : FCM_OFFICIAL_DEFAULT_VAPID_PUBLIC_KEY;
        const envVapidConfigured = true;
        const envVapidValid = isValidServerVapidPublicKey(effectiveVapidKey);
        const vapidMode: 'custom_env' | 'fcm_managed_default' =
          hasCustomEnvVapid && envVapidValid ? 'custom_env' : 'fcm_managed_default';

        let adminSdkInitialized = false;
        if (cfg.configValid) {
          try {
            const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
            getAdminAuth(adminApp);
            getAdminMessaging(adminApp);
            adminSdkInitialized = true;
          } catch {
            adminSdkInitialized = false;
          }
        }

        const firebaseCloudMessagingConsoleUrl = `https://console.firebase.google.com/project/${encodeURIComponent(
          cfg.projectId
        )}/settings/cloudmessaging`;
        const fcmRegistrationsActivationUrl = `https://console.cloud.google.com/apis/library/fcmregistrations.googleapis.com?project=${encodeURIComponent(
          cfg.projectId
        )}`;
        const fcmV1ActivationUrl = `https://console.cloud.google.com/apis/library/fcm.googleapis.com?project=${encodeURIComponent(
          cfg.projectId
        )}`;
        const firebaseInstallationsActivationUrl = `https://console.cloud.google.com/apis/library/firebaseinstallations.googleapis.com?project=${encodeURIComponent(
          cfg.projectId
        )}`;

        // 1. Probe FCM HTTP v1 API service enablement (`fcm.googleapis.com`)
        let fcmV1ApiStatus: 'enabled_verified' | 'disabled' | 'unable_to_verify' = 'unable_to_verify';
        // 2. Probe FCM Registration API (`fcmregistrations.googleapis.com`)
        let fcmRegistrationsApiStatus: 'enabled_verified' | 'disabled' | 'unable_to_verify' = 'unable_to_verify';
        // 3. Probe Firebase Installations API (`firebaseinstallations.googleapis.com`)
        let firebaseInstallationsApiStatus: 'enabled_verified' | 'disabled' | 'unable_to_verify' = 'unable_to_verify';

        if (cfg.configValid) {
          const [v1ProbeRes, regProbeRes, fidProbeRes] = await Promise.all([
            fetch(
              `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(
                cfg.projectId
              )}/messages:send?key=${encodeURIComponent(cfg.apiKey)}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
              }
            ).catch(() => null),
            fetch(
              `https://fcmregistrations.googleapis.com/v1/projects/${encodeURIComponent(
                cfg.projectId
              )}/registrations?key=${encodeURIComponent(cfg.apiKey)}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
              }
            ).catch(() => null),
            fetch(
              `https://firebaseinstallations.googleapis.com/v1/projects/${encodeURIComponent(
                cfg.projectId
              )}/installations?key=${encodeURIComponent(cfg.apiKey)}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
              }
            ).catch(() => null),
          ]);

          if (v1ProbeRes) {
            const v1Text = await v1ProbeRes.text().catch(() => '');
            if (v1ProbeRes.status === 401 || v1ProbeRes.status === 400) {
              fcmV1ApiStatus = 'enabled_verified';
            } else if (
              v1ProbeRes.status === 403 &&
              (v1Text.includes('SERVICE_DISABLED') || v1Text.includes('fcm.googleapis.com'))
            ) {
              fcmV1ApiStatus = 'disabled';
            }
          }

          if (regProbeRes) {
            const regText = await regProbeRes.text().catch(() => '');
            if (regProbeRes.status === 400 || regProbeRes.status === 401) {
              fcmRegistrationsApiStatus = 'enabled_verified';
            } else if (
              regProbeRes.status === 403 &&
              (regText.includes('SERVICE_DISABLED') || regText.includes('fcmregistrations.googleapis.com'))
            ) {
              fcmRegistrationsApiStatus = 'disabled';
            }
          }

          if (fidProbeRes) {
            const fidText = await fidProbeRes.text().catch(() => '');
            if (fidProbeRes.status === 400 || fidProbeRes.status === 401) {
              firebaseInstallationsApiStatus = 'enabled_verified';
            } else if (
              fidProbeRes.status === 403 &&
              (fidText.includes('SERVICE_DISABLED') || fidText.includes('firebaseinstallations.googleapis.com'))
            ) {
              firebaseInstallationsApiStatus = 'disabled';
            }
          }
        }

        // 4. Probe Firebase Admin SDK FCM HTTP v1 Send IAM authorization (`dryRun = true` — sends zero messages)
        let fcmSendApiStatus:
          | 'enabled_verified'
          | 'permission_denied'
          | 'disabled'
          | 'no_credentials'
          | 'unable_to_verify' = 'unable_to_verify';
        const cloudToken = await resolveServerCloudAccessToken();
        const credentialSource: 'managed_adc' | 'service_account_env' | 'none' = cloudToken
          ? 'managed_adc'
          : 'none';
        if (!cloudToken) {
          fcmSendApiStatus = 'no_credentials';
        } else if (cfg.configValid) {
          try {
            const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
            await getAdminMessaging(adminApp).send(
              {
                token: 'dry_run_capability_probe_token',
                data: { probe: '1' },
              },
              true
            );
            fcmSendApiStatus = 'enabled_verified';
          } catch (err) {
            const code =
              err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code || '') : '';
            const msg = err instanceof Error ? err.message : String(err);
            const combined = `${code} ${msg}`;
            if (
              code === 'messaging/invalid-argument' ||
              code === 'messaging/registration-token-not-registered' ||
              code === 'messaging/invalid-registration-token'
            ) {
              fcmSendApiStatus = 'enabled_verified';
            } else if (combined.includes('SERVICE_DISABLED') || fcmV1ApiStatus === 'disabled') {
              fcmSendApiStatus = 'disabled';
            } else if (
              code === 'messaging/mismatched-credential' ||
              combined.includes('cloudmessaging.messages.create') ||
              combined.includes('PERMISSION_DENIED') ||
              combined.includes('permission-denied') ||
              combined.includes('authentication-error') ||
              combined.includes('third-party-auth-error') ||
              combined.includes('403')
            ) {
              fcmSendApiStatus = 'permission_denied';
            } else {
              fcmSendApiStatus = 'unable_to_verify';
            }
          }
        }

        const requiredRoles = [
          'roles/firebasecloudmessaging.admin',
          'roles/datastore.user',
          'roles/serviceusage.serviceUsageAdmin',
        ];

        const vapidConsoleErrorDiagnosis =
          fcmRegistrationsApiStatus === 'disabled'
            ? `Firebase Admin SDK (Managed ADC) and Firebase Cloud Messaging's official built-in P-256 public VAPID key are configured and active. Enable fcmregistrations.googleapis.com on project ${cfg.projectId} (${cfg.projectNumber}) so browsers can issue FCM registration tokens.`
            : `All FCM Cloud APIs and Web Push public VAPID configuration are active on ${cfg.projectId}.`;

        let detailMessage = 'Firebase Admin SDK (Managed ADC) and FCM Web Push are fully configured and verified.';
        if (fcmRegistrationsApiStatus === 'disabled') {
          detailMessage = `FCM Registration API (fcmregistrations.googleapis.com) is currently disabled in Google Cloud project ${cfg.projectId}. Enable it in Google Cloud Console so browsers can register push tokens.`;
        } else if (fcmSendApiStatus === 'permission_denied') {
          detailMessage = isAdmin
            ? `Server runtime (${fullSandboxEmail || 'Managed ADC'}) needs roles/firebasecloudmessaging.admin and roles/datastore.user on project ${cfg.projectId} to dispatch closed-tab background pushes.`
            : `Server runtime (Managed ADC) needs roles/firebasecloudmessaging.admin and roles/datastore.user on project ${cfg.projectId} to dispatch closed-tab background pushes.`;
        }

        const fullPayload: Record<string, unknown> = {
          ok: envVapidValid && fcmRegistrationsApiStatus === 'enabled_verified' && fcmSendApiStatus === 'enabled_verified',
          projectId: cfg.projectId,
          projectNumber: cfg.projectNumber,
          appId: cfg.appId,
          adminSdkInitialized,
          credentialSource,
          vapidMode,
          envVapidConfigured,
          envVapidValid,
          fcmV1ApiStatus,
          fcmRegistrationsApiStatus,
          firebaseInstallationsApiStatus,
          fcmSendApiStatus,
          requiredRoles,
          firebaseCloudMessagingConsoleUrl,
          fcmRegistrationsActivationUrl,
          fcmV1ActivationUrl,
          firebaseInstallationsActivationUrl,
          vapidConsoleErrorDiagnosis,
          detailMessage:
            fcmSendApiStatus === 'permission_denied'
              ? `Server runtime (${fullSandboxEmail || 'Managed ADC'}) needs roles/firebasecloudmessaging.admin and roles/datastore.user on project ${cfg.projectId} to dispatch closed-tab background pushes.`
              : detailMessage,
        };

        cachedFcmStatus = {
          expiresAtMs: Date.now() + 20_000,
          payload: fullPayload,
        };

        return res.json({
          ...fullPayload,
          sandboxServiceAccountEmail,
          iamConsoleUrl: isAdmin ? cfg.iamConsoleUrl : '',
          firebaseCloudMessagingConsoleUrl: isAdmin ? firebaseCloudMessagingConsoleUrl : '',
          fcmRegistrationsActivationUrl: isAdmin ? fcmRegistrationsActivationUrl : '',
          fcmV1ActivationUrl: isAdmin ? fcmV1ActivationUrl : '',
          firebaseInstallationsActivationUrl: isAdmin ? firebaseInstallationsActivationUrl : '',
          detailMessage,
        });
      } catch {
        return res.json({
          ok: false,
          projectId: 'responsive-dragon-tmn89',
          projectNumber: '448578956301',
          appId: '1:448578956301:web:091629c6e19eafa50ef944',
          adminSdkInitialized: false,
          credentialSource: 'none',
          vapidMode: 'fcm_managed_default',
          envVapidConfigured: true,
          envVapidValid: true,
          fcmV1ApiStatus: 'unable_to_verify',
          fcmRegistrationsApiStatus: 'unable_to_verify',
          firebaseInstallationsApiStatus: 'unable_to_verify',
          fcmSendApiStatus: 'unable_to_verify',
          sandboxServiceAccountEmail: '',
          requiredRoles: ['roles/firebasecloudmessaging.admin', 'roles/datastore.user'],
          firebaseCloudMessagingConsoleUrl: '',
          fcmRegistrationsActivationUrl: '',
          fcmV1ActivationUrl: '',
          firebaseInstallationsActivationUrl: '',
          iamConsoleUrl: '',
          vapidConsoleErrorDiagnosis: 'Unable to probe Google Cloud APIs due to temporary network error.',
          detailMessage: 'Unable to probe FCM status due to temporary network error.',
        });
      }
    }
  );

  app.post(
    '/api/fcm/enable-cloud-apis',
    makeRateLimitMiddleware('enable_fcm_apis', cloudAdminMutationLimiter),
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const cfg = loadVerifiedFirebaseConfig();
        const adminCaller = await verifyAdminCaller(req, cfg);
        if (!adminCaller) {
          recordSecurityEvent({
            type: 'admin_denied',
            endpoint: '/api/fcm/enable-cloud-apis',
            actor: getCallerClientKey(req),
            summary: 'Non-admin caller blocked from FCM Cloud API enablement.',
          });
          return res.status(403).json({
            ok: false,
            fcmRegistrationsApiStatus: 'permission_denied',
            message: 'Administrator authentication is required to enable Cloud Messaging APIs.',
          });
        }
        const sandboxServiceAccountEmail = await resolveSandboxServiceAccountEmail();
        if (!cfg.configValid) {
          return res.json({
            ok: false,
            fcmRegistrationsApiStatus: 'unable_to_verify',
            message: 'Invalid Firebase project configuration.',
          });
        }

        const accessToken = await fetchSandboxMetadataAccessToken();
        if (!accessToken) {
          return res.json({
            ok: false,
            fcmRegistrationsApiStatus: 'disabled',
            message: `Enable fcmregistrations.googleapis.com directly in Google Cloud Console for project ${cfg.projectId}.`,
          });
        }

        const servicesToEnable = [
          'fcmregistrations.googleapis.com',
          'fcm.googleapis.com',
          'firebaseinstallations.googleapis.com',
        ];
        let allAccepted = true;
        for (const svc of servicesToEnable) {
          const enableRes = await fetch(
            `https://serviceusage.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/services/${svc}:enable`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'X-Goog-User-Project': cfg.projectId,
              },
              body: JSON.stringify({}),
            }
          );
          if (!enableRes.ok) {
            allAccepted = false;
          }
        }

        if (allAccepted) {
          return res.json({
            ok: true,
            fcmRegistrationsApiStatus: 'enabled_verified',
            message: `Google Cloud accepted enablement for FCM Registration API on ${cfg.projectId}. Allow ~60 seconds for propagation and click Recheck Cloud Status.`,
          });
        }

        return res.json({
          ok: false,
          fcmRegistrationsApiStatus: 'disabled',
          message: sandboxServiceAccountEmail
            ? `Google Cloud IAM requires either clicking Enable on fcmregistrations.googleapis.com in Cloud Console for project ${cfg.projectId}, or granting roles/serviceusage.serviceUsageAdmin to ${sandboxServiceAccountEmail}.`
            : `Enable fcmregistrations.googleapis.com directly in Google Cloud Console for project ${cfg.projectId}.`,
        });
      } catch {
        return res.json({
          ok: false,
          fcmRegistrationsApiStatus: 'unable_to_verify',
          message: 'Could not reach Google Cloud Service Usage API.',
        });
      }
    }
  );

  app.post(
    '/api/fcm/send',
    makeRateLimitMiddleware('fcm_send', fcmDispatchLimiter),
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const cfg = loadVerifiedFirebaseConfig();
        if (!cfg.configValid) {
          return res.status(503).json({ ok: false, deliveryStatus: 'config_mismatch' });
        }

        const authHeader = String(req.headers.authorization || '');
        const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
        if (!idToken) {
          return res.status(401).json({ ok: false, deliveryStatus: 'missing_bearer_token' });
        }

        // 1. Cryptographically verify caller Firebase ID Token using `firebase-admin/auth` + Identity Toolkit live status
        const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
        let decodedTokenUid = '';
        try {
          const decoded = await getAdminAuth(adminApp).verifyIdToken(idToken, true);
          decodedTokenUid = String(decoded.uid || '').trim();
        } catch {
          return res.status(401).json({ ok: false, deliveryStatus: 'invalid_id_token' });
        }

        const lookupRes = await fetch(
          `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(cfg.apiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken }),
          }
        );
        if (!lookupRes.ok) {
          return res.status(401).json({ ok: false, deliveryStatus: 'invalid_id_token' });
        }
        const lookupJson = (await lookupRes.json()) as {
          users?: Array<{
            localId?: string;
            email?: string;
            emailVerified?: boolean;
            disabled?: boolean;
            validSince?: string;
          }>;
        };
        const verifiedUser = lookupJson.users?.[0];
        const callerUid = String(verifiedUser?.localId || '').trim();
        const callerEmail = String(verifiedUser?.email || '').trim().toLowerCase();
        const callerEmailVerified = Boolean(verifiedUser?.emailVerified);
        if (
          !callerUid ||
          callerUid !== decodedTokenUid ||
          !isLookupAccountActiveAndUnrevoked({
            idToken,
            expectedProjectId: cfg.projectId,
            expectedUid: callerUid,
            disabled: verifiedUser?.disabled,
            validSinceSecondsRaw: verifiedUser?.validSince,
          })
        ) {
          return res.status(401).json({ ok: false, deliveryStatus: 'invalid_caller' });
        }

        if (!consumeAuthenticatedUidLimit(req, res, 'fcm_send', callerUid, fcmDispatchLimiter)) {
          return;
        }

      const body = (req.body || {}) as Record<string, unknown>;
      const recipientId = String(body.recipientId || '').trim();
      const notificationId = String(body.notificationId || '').trim();
      const dealId = String(body.dealId || '').trim();
      const listingId = String(body.listingId || '').trim();
      const alertKind = body.alertKind === 'deal_room_created' ? 'deal_room_created' : 'normal';
      const privacyMode = body.privacyMode === 'standard' ? 'standard' : 'minimal';
      const destination = sanitizeServerPushDestination(body.destination);

      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(recipientId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(notificationId)) {
        return res.status(400).json({ ok: false, deliveryStatus: 'invalid_recipient_or_notification_id' });
      }

      const firestoreBaseUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
        cfg.projectId
      )}/databases/${encodeURIComponent(cfg.firestoreDatabaseId)}/documents`;

      const isCallerBootstrappedAdmin =
        callerUid === BOOTSTRAPPED_SUPERADMIN_UID ||
        (callerEmailVerified && callerEmail === BOOTSTRAPPED_SUPERADMIN_EMAIL);

      // 2. Zero-Trust Recipient & Counterparty Verification using caller's own Firestore permissions
      let authorized = false;
      if (recipientId === callerUid || isCallerBootstrappedAdmin) {
        authorized = true;
      } else {
        // Check if caller is an authorized Admin in /admins/{callerUid}
        const adminCheck = await fetch(`${firestoreBaseUrl}/admins/${encodeURIComponent(callerUid)}`, {
          headers: { Authorization: `Bearer ${idToken}` },
        }).catch(() => null);
        if (adminCheck && adminCheck.ok) {
          authorized = true;
        }
      }

      if (!authorized && dealId && /^[a-zA-Z0-9_-]{1,128}$/.test(dealId)) {
        // Verify deal participants in /deals/{dealId} using caller's ID token
        const dealCheck = await fetch(`${firestoreBaseUrl}/deals/${encodeURIComponent(dealId)}`, {
          headers: { Authorization: `Bearer ${idToken}` },
        }).catch(() => null);
        if (dealCheck && dealCheck.ok) {
          const dealDoc = (await dealCheck.json()) as Record<string, unknown>;
          const buyerId = readFirestoreStringField(dealDoc, 'buyerId');
          const sellerId = readFirestoreStringField(dealDoc, 'sellerId');
          const dealStatus = readFirestoreStringField(dealDoc, 'status');
          const callerInDeal = callerUid === buyerId || callerUid === sellerId;
          const validDealRecipient =
            recipientId === buyerId ||
            recipientId === sellerId ||
            recipientId === BOOTSTRAPPED_SUPERADMIN_UID;

          // Deal-room creation alert strictly requires a funded deal status!
          const dealIsFunded = ![
            'accepted_pending_payment',
            'awaiting_payment',
            'payment_pending_verification',
            'cancelled',
          ].includes(dealStatus);

          if (callerInDeal && validDealRecipient && (alertKind !== 'deal_room_created' || dealIsFunded)) {
            authorized = true;
          }
        }
      }

      if (!authorized && listingId && /^[a-zA-Z0-9_-]{1,128}$/.test(listingId) && alertKind !== 'deal_room_created') {
        const listingCheck = await fetch(`${firestoreBaseUrl}/listings/${encodeURIComponent(listingId)}`, {
          headers: { Authorization: `Bearer ${idToken}` },
        }).catch(() => null);
        if (listingCheck && listingCheck.ok) {
          const listingDoc = (await listingCheck.json()) as Record<string, unknown>;
          const sellerId = readFirestoreStringField(listingDoc, 'sellerId');
          if (sellerId === recipientId || sellerId === callerUid) {
            authorized = true;
          }
        }
      }

      if (!authorized) {
        return res.status(403).json({ ok: false, deliveryStatus: 'unauthorized_recipient' });
      }

      // 3. Load recipient's active FCM push tokens (self token via caller idToken, cross-user via server Cloud token)
      const cloudToken = await resolveServerCloudAccessToken();
      const firestoreBearer = recipientId === callerUid ? idToken : cloudToken;
      if (!firestoreBearer) {
        return res.json({
          ok: false,
          deliveryStatus: 'server_credentials_missing_retryable',
          retryable: true,
        });
      }

      const tokensRes = await fetch(
        `${firestoreBaseUrl}/privateUsers/${encodeURIComponent(recipientId)}/pushTokens`,
        {
          headers: { Authorization: `Bearer ${firestoreBearer}` },
        }
      );

      if (!tokensRes.ok) {
        return res.json({
          ok: false,
          deliveryStatus:
            tokensRes.status === 403 ? 'server_firestore_iam_required_retryable' : 'token_lookup_failed',
          retryable: true,
        });
      }

      const tokensJson = (await tokensRes.json()) as {
        documents?: Array<{ name?: string; fields?: Record<string, unknown> }>;
      };
      const rawDocs = Array.isArray(tokensJson.documents) ? tokensJson.documents : [];
      const activeTokens: Array<{ docName: string; fcmToken: string }> = [];

      for (const docItem of rawDocs) {
        const enabled = readFirestoreBooleanField(docItem as Record<string, unknown>, 'enabled');
        const tokenStr = readFirestoreStringField(docItem as Record<string, unknown>, 'token');
        if (enabled && tokenStr.length >= 20 && docItem.name) {
          activeTokens.push({ docName: docItem.name, fcmToken: tokenStr });
        }
      }

      if (activeTokens.length === 0) {
        return res.json({ ok: true, deliveryStatus: 'no_registered_tokens', deliveredCount: 0 });
      }

      if (!cloudToken) {
        return res.json({
          ok: false,
          deliveryStatus: 'fcm_credentials_missing_retryable',
          retryable: true,
        });
      }

      // 4. Read recipient's saved notification preferences if accessible (falls back safely to minimal privacy + Strong vibration)
      let effectivePrivacyMode: 'minimal' | 'standard' = privacyMode;
      let recipientVibrationEnabled = body.vibrationEnabled !== false;
      let recipientVibrationStrength: 'standard' | 'strong' =
        body.vibrationStrength === 'standard' ? 'standard' : 'strong';

      try {
        const recipientUserRes = await fetch(
          `${firestoreBaseUrl}/privateUsers/${encodeURIComponent(recipientId)}`,
          { headers: { Authorization: `Bearer ${firestoreBearer}` } }
        );
        if (recipientUserRes.ok) {
          const recipientDoc = (await recipientUserRes.json()) as {
            fields?: {
              notificationPrefs?: {
                mapValue?: { fields?: Record<string, { booleanValue?: boolean; stringValue?: string }> };
              };
            };
          };
          const prefFields = recipientDoc.fields?.notificationPrefs?.mapValue?.fields;
          if (prefFields) {
            if (prefFields.lockScreenPrivacyMode?.stringValue === 'standard') {
              effectivePrivacyMode = 'standard';
            } else if (prefFields.lockScreenPrivacyMode?.stringValue === 'minimal') {
              effectivePrivacyMode = 'minimal';
            }
            if (typeof prefFields.vibrationEnabled?.booleanValue === 'boolean') {
              recipientVibrationEnabled = prefFields.vibrationEnabled.booleanValue;
            }
            if (prefFields.vibrationStrength?.stringValue === 'standard') {
              recipientVibrationStrength = 'standard';
            } else if (prefFields.vibrationStrength?.stringValue === 'strong') {
              recipientVibrationStrength = 'strong';
            }
            if (
              body.category === 'bid' &&
              alertKind !== 'deal_room_created' &&
              prefFields.bidUpdatesEnabled?.booleanValue === false
            ) {
              return res.json({
                ok: true,
                deliveryStatus: 'skipped_by_user_preference',
                deliveredCount: 0,
              });
            }
            if (
              body.category === 'listing' &&
              String(notificationId).includes('seller_new_listing') &&
              prefFields.followedSellerListingsEnabled?.booleanValue === false
            ) {
              return res.json({
                ok: true,
                deliveryStatus: 'skipped_by_user_preference',
                deliveredCount: 0,
              });
            }
          }
        }
      } catch {
        // Fallback to defaults if recipient doc lookup is unavailable
      }

      // 5. Construct minimal, privacy-safe DATA-ONLY FCM HTTP v1 payload via Firebase Admin SDK.
      // Omitting top-level `notification` and `webpush.notification` guarantees:
      // - Zero duplicate notifications when foreground `onMessage` and Firestore `onSnapshot` are active.
      // - Deterministic single-notification rendering + `data.destination` click routing in `firebase-messaging-sw.js`.
      const safeTitle =
        alertKind === 'deal_room_created'
          ? 'New Deal Room Created'
          : effectivePrivacyMode === 'minimal'
          ? 'BEXORA Notification'
          : redactSensitivePreviewServer(body.title || 'BEXORA Notification').slice(0, 110);

      const safeBody =
        alertKind === 'deal_room_created'
          ? 'Payment confirmed in BEXORA Escrow. Tap to open your private 3-party Deal Room.'
          : effectivePrivacyMode === 'minimal'
          ? 'You have a new update on BEXORA. Tap to view safely.'
          : redactSensitivePreviewServer(body.preview || 'Open BEXORA to view your update.').slice(0, 160);

      const adminMessaging = getAdminMessaging(adminApp);

      let deliveredCount = 0;
      let cleanedInvalidTokens = 0;
      let permissionDenied = false;

      for (const entry of activeTokens) {
        try {
          await adminMessaging.send({
            token: entry.fcmToken,
            data: {
              notificationId,
              alertKind,
              destination,
              title: safeTitle,
              body: safeBody,
              vibrationEnabled: String(recipientVibrationEnabled),
              vibrationStrength: recipientVibrationStrength,
            },
            webpush: {
              headers: {
                Urgency: alertKind === 'deal_room_created' ? 'high' : 'normal',
                TTL: alertKind === 'deal_room_created' ? '86400' : '43200',
              },
              fcmOptions: {
                link: destination ? `/?dest=${encodeURIComponent(destination)}` : '/',
              },
            },
          });
          deliveredCount += 1;
        } catch (sendErr) {
          const code =
            sendErr && typeof sendErr === 'object' && 'code' in sendErr
              ? String((sendErr as { code?: unknown }).code || '')
              : '';
          const msg = sendErr instanceof Error ? sendErr.message : String(sendErr);
          const combined = `${code} ${msg}`;

          if (
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token' ||
            combined.includes('UNREGISTERED')
          ) {
            await fetch(`https://firestore.googleapis.com/v1/${entry.docName}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${firestoreBearer}` },
            }).catch(() => {});
            cleanedInvalidTokens += 1;
          } else if (
            code === 'messaging/mismatched-credential' ||
            combined.includes('cloudmessaging.messages.create') ||
            combined.includes('PERMISSION_DENIED') ||
            combined.includes('permission-denied') ||
            combined.includes('authentication-error') ||
            combined.includes('third-party-auth-error') ||
            combined.includes('403')
          ) {
            permissionDenied = true;
          }
        }
      }

      if (permissionDenied && deliveredCount === 0) {
        return res.json({
          ok: false,
          deliveryStatus: 'fcm_iam_permission_denied_retryable',
          retryable: true,
          cleanedInvalidTokens,
        });
      }

      return res.json({
        ok: deliveredCount > 0,
        deliveryStatus: deliveredCount > 0 ? 'delivered' : 'no_valid_tokens',
        deliveredCount,
        cleanedInvalidTokens,
      });
    } catch {
      return res.status(502).json({
        ok: false,
        deliveryStatus: 'server_dispatch_error_retryable',
        retryable: true,
      });
    }
  });

  // 2B. Admin-Triggered Follower New-Listing Web Push Fan-Out (Non-Blocking & Preference-Aware)
  app.post(
    '/api/fcm/fanout-followers',
    makeRateLimitMiddleware('fcm_fanout', fcmDispatchLimiter),
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const cfg = loadVerifiedFirebaseConfig();
        if (!cfg.configValid) {
          return res.status(503).json({ ok: false, deliveryStatus: 'config_mismatch' });
        }

        const adminCaller = await verifyAdminCaller(req, cfg);
        if (!adminCaller) {
          recordSecurityEvent({
            type: 'admin_denied',
            endpoint: '/api/fcm/fanout-followers',
            actor: getCallerClientKey(req),
            summary: 'Non-admin caller blocked from follower push fanout.',
          });
          return res.status(403).json({ ok: false, deliveryStatus: 'admin_required' });
        }

      const body = (req.body || {}) as Record<string, unknown>;
      const listingId = String(body.listingId || '').trim();
      const destination = sanitizeServerPushDestination(body.destination || `listing:${listingId}`);
      const rawTitle = redactSensitivePreviewServer(body.title || 'New Listing from Followed Seller').slice(0, 110);
      const rawPreview = redactSensitivePreviewServer(
        body.preview || 'A seller you follow just published a new listing on BEXORA.'
      ).slice(0, 160);

      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(listingId)) {
        return res.status(400).json({ ok: false, deliveryStatus: 'invalid_listing_id' });
      }

      const cloudToken = await resolveServerCloudAccessToken();
      if (!cloudToken) {
        return res.json({
          ok: false,
          deliveryStatus: 'fcm_credentials_missing_retryable',
          deliveredCount: 0,
        });
      }

      const firestoreBaseUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
        cfg.projectId
      )}/databases/${encodeURIComponent(cfg.firestoreDatabaseId)}/documents`;

      // Verify listing actually exists and is currently published (`active`)
      const listingRes = await fetch(`${firestoreBaseUrl}/listings/${encodeURIComponent(listingId)}`, {
        headers: { Authorization: `Bearer ${cloudToken}` },
      }).catch(() => null);

      if (listingRes && listingRes.ok) {
        const listingDoc = (await listingRes.json()) as Record<string, unknown>;
        const listingStatus = readFirestoreStringField(listingDoc, 'status');
        if (listingStatus && listingStatus !== 'active') {
          return res.json({ ok: false, deliveryStatus: 'listing_not_active', deliveredCount: 0 });
        }
      }

      const rawRecipients = Array.isArray(body.recipients) ? body.recipients.slice(0, 500) : [];
      const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
      const adminMessaging = getAdminMessaging(adminApp);

      let deliveredCount = 0;
      let skippedCount = 0;

      for (const item of rawRecipients) {
        const recObj = (item || {}) as Record<string, unknown>;
        const recipientId = String(recObj.recipientId || '').trim();
        const notificationId = String(recObj.notificationId || `ntf_fol_${listingId}`).trim();
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(recipientId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(notificationId)) {
          continue;
        }

        // Check follower privacy mode + followedSellerListingsEnabled preference
        let privacyMode: 'minimal' | 'standard' = 'minimal';
        try {
          const userRes = await fetch(
            `${firestoreBaseUrl}/privateUsers/${encodeURIComponent(recipientId)}`,
            { headers: { Authorization: `Bearer ${cloudToken}` } }
          );
          if (userRes.ok) {
            const userDoc = (await userRes.json()) as {
              fields?: {
                notificationPrefs?: {
                  mapValue?: { fields?: Record<string, { booleanValue?: boolean; stringValue?: string }> };
                };
              };
            };
            const prefs = userDoc.fields?.notificationPrefs?.mapValue?.fields;
            if (prefs?.followedSellerListingsEnabled?.booleanValue === false) {
              skippedCount += 1;
              continue;
            }
            if (prefs?.lockScreenPrivacyMode?.stringValue === 'standard') {
              privacyMode = 'standard';
            }
          }
        } catch {
          // Proceed with safe minimal defaults
        }

        const tokensRes = await fetch(
          `${firestoreBaseUrl}/privateUsers/${encodeURIComponent(recipientId)}/pushTokens`,
          { headers: { Authorization: `Bearer ${cloudToken}` } }
        ).catch(() => null);
        if (!tokensRes || !tokensRes.ok) continue;

        const tokensJson = (await tokensRes.json()) as {
          documents?: Array<{ name?: string; fields?: Record<string, unknown> }>;
        };
        const docs = Array.isArray(tokensJson.documents) ? tokensJson.documents : [];

        const pushTitle = privacyMode === 'minimal' ? 'BEXORA Followed Seller Alert' : rawTitle;
        const pushBody =
          privacyMode === 'minimal'
            ? 'A seller you follow published a new listing on BEXORA. Tap to view.'
            : rawPreview;

        for (const tDoc of docs) {
          const enabled = readFirestoreBooleanField(tDoc as Record<string, unknown>, 'enabled');
          const fcmToken = readFirestoreStringField(tDoc as Record<string, unknown>, 'token');
          if (!enabled || fcmToken.length < 20) continue;
          try {
            await adminMessaging.send({
              token: fcmToken,
              data: {
                notificationId,
                alertKind: 'normal',
                destination,
                title: pushTitle,
                body: pushBody,
                vibrationEnabled: 'false',
                vibrationStrength: 'standard',
              },
              webpush: {
                headers: {
                  Urgency: 'normal',
                  TTL: '43200',
                },
                fcmOptions: {
                  link: destination ? `/?dest=${encodeURIComponent(destination)}` : '/',
                },
              },
            });
            deliveredCount += 1;
          } catch {
            // Non-blocking per-token fault isolation
          }
        }
      }

      return res.json({
        ok: true,
        deliveryStatus: 'fanout_completed',
        deliveredCount,
        skippedCount,
      });
    } catch {
      return res.json({
        ok: false,
        deliveryStatus: 'fanout_error_non_blocking',
        deliveredCount: 0,
      });
    }
  });

  // 3. Server-Side AI Monetization Evidence Verification Pipeline (Authenticated Sellers & Admins; Emergency-Stop Enforced)
  app.post(
    '/api/ai/verify-evidence',
    makeRateLimitMiddleware('ai_verify_evidence', aiComputeLimiter),
    async (req, res) => {
      try {
        const cfg = loadVerifiedFirebaseConfig();
        const caller = await verifyCallerFirebaseToken(req, cfg);
        if (!caller) {
          return res.status(401).json({
            available: false,
            outcome: 'human_review_required',
            summary: 'Sign in required to run AI screenshot assessment.',
            method: 'auth_required',
          });
        }

        if (!consumeAuthenticatedUidLimit(req, res, 'ai_verify_evidence', caller.uid, aiComputeLimiter)) {
          return;
        }

        if (await isAiEmergencyStopActive(cfg)) {
          return res.status(423).json({
            available: false,
            outcome: 'human_review_required',
            summary: 'AI operations are currently paused by Administrator Emergency Stop. Queued for manual review.',
            method: 'emergency_stop_active',
          });
        }

        const ai = getGeminiClient();
        if (!ai) {
          return res.status(503).json({
            available: false,
            outcome: 'human_review_required',
            summary:
              'AI screenshot analysis is not configured in this environment. Queued for manual administrator evidence review.',
            method: 'manual_queue_fallback',
          });
        }

        const { platform, claimedOptions, imageDataUrl } = req.body || {};
        if (!platform || !Array.isArray(claimedOptions) || typeof imageDataUrl !== 'string') {
          return res.status(400).json({ error: 'Missing platform, claimedOptions, or imageDataUrl.' });
        }

        const safePlatform = String(platform).slice(0, 64);
        const safeClaimed = claimedOptions
          .filter((item): item is string => typeof item === 'string')
          .slice(0, 12)
          .map((item) => item.slice(0, 64));

        const match = imageDataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/);
        if (!match) {
          return res.status(400).json({ error: 'Unsupported evidence image format. Use PNG, JPEG, or WebP.' });
        }

        const mimeType = match[1];
        const base64Data = match[2]!.replace(/\s+/g, '');
        const decodedBytes = new Uint8Array(Buffer.from(base64Data, 'base64'));
        const magicCheck = validateImageMagicBytes(decodedBytes);
        if (!magicCheck.valid || magicCheck.detectedMime !== mimeType) {
          recordSecurityEvent({
            type: 'payload_rejected',
            endpoint: '/api/ai/verify-evidence',
            actor: caller.uid,
            summary: 'Rejected evidence upload failing server-side raster magic-byte verification.',
          });
          return res.status(400).json({
            error: magicCheck.error || 'Evidence file binary signature does not match declared raster MIME type.',
          });
        }

        const response = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: {
            parts: [
              { inlineData: { mimeType, data: base64Data } },
              {
                text: `Inspect this seller-submitted screenshot for a ${safePlatform} digital asset claiming monetization programs: ${safeClaimed.join(', ')}.
Assess strictly without overclaiming:
1. Does the screenshot match ${safePlatform}?
2. Is status text readable and showing Active/Enabled vs Eligible/In Review/Rejected?
3. Are any passwords, OTPs, or recovery codes exposed?
Remember: a screenshot alone is never direct platform API verification. Recommend 'in_review' whenever uncertain.`,
              },
            ],
          },
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                platformMatched: { type: Type.BOOLEAN },
                detectedState: {
                  type: Type.STRING,
                  description: 'One of: active_indicators, eligible_only, in_review, rejected_or_disabled, unreadable_or_unrelated',
                },
                privateDataExposed: { type: Type.BOOLEAN },
                recommendedOutcome: {
                  type: Type.STRING,
                  description: 'One of: human_review_required, request_new_evidence',
                },
                summary: { type: Type.STRING },
              },
              required: ['platformMatched', 'detectedState', 'privateDataExposed', 'recommendedOutcome', 'summary'],
            },
          },
        });

        const parsed = JSON.parse((response.text || '{}').trim());
        return res.json({
          available: true,
          method: 'ai_assessed_screenshot',
          ...parsed,
        });
      } catch (error) {
        console.error('AI evidence verification error:', error instanceof Error ? error.message : String(error));
        return res.status(502).json({
          available: false,
          outcome: 'human_review_required',
          summary: 'AI provider returned an error or timed out. Listing kept safely in pending human review.',
          method: 'error_fallback_human_review',
        });
      }
    }
  );

  // 4. Server-Side AI Developer Chat (Admin Panel Only + Server-Side Emergency-Stop Gate)
  app.post(
    '/api/ai/developer-chat',
    makeRateLimitMiddleware('ai_developer_chat', aiComputeLimiter),
    async (req, res) => {
      try {
        const cfg = loadVerifiedFirebaseConfig();
        const adminCaller = await verifyAdminCaller(req, cfg);
        if (!adminCaller) {
          recordSecurityEvent({
            type: 'admin_denied',
            endpoint: '/api/ai/developer-chat',
            actor: getCallerClientKey(req),
            summary: 'Non-admin caller blocked from AI Developer endpoint.',
          });
          return res.status(403).json({
            available: false,
            reply: 'Administrator authentication is required to use BEXORA AI Developer.',
          });
        }

      if (!consumeAuthenticatedUidLimit(req, res, 'ai_developer_chat', adminCaller.uid, aiComputeLimiter)) {
        return;
      }

      if (await isAiEmergencyStopActive(cfg)) {
        return res.status(423).json({
          available: false,
          reply: 'AI Emergency Stop is currently ACTIVE. Clear Emergency Stop in the Admin Governance Center before running AI Developer queries.',
        });
      }

      const ai = getGeminiClient();
      if (!ai) {
        return res.status(503).json({
          available: false,
          reply:
            'GEMINI_API_KEY is not configured on this server. Deterministic health monitoring, proposal queue, and Emergency Stop remain active.',
        });
      }

      const { message, systemContext } = req.body || {};
      if (typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'Prompt message is required.' });
      }

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: message.slice(0, 4000),
        config: {
          systemInstruction: `You are the BEXORA Production-Safe AI Developer inside the BEXORA Admin Panel.
Follow strict safety rules:
- Never claim to auto-deploy changes to production without explicit human Approve action.
- Never weaken Firestore Security Rules or expose secrets.
- Explain root causes, affected files, risks, and staged test plans clearly in concise language for a non-technical project owner.
Current system snapshot: ${typeof systemContext === 'string' ? systemContext.slice(0, 1500) : 'Standard Firebase + React architecture'}`,
        },
      });

      return res.json({
        available: true,
        reply: response.text || 'Analysis complete.',
      });
    } catch (error) {
      console.error('AI Developer chat error:', error instanceof Error ? error.message : String(error));
      return res.status(502).json({
        available: false,
        reply: 'AI Developer service encountered a temporary error. Deterministic diagnostics remain operational.',
      });
    }
  });

  // 4B. Continuous Non-Destructive System Health Prober & Admin Diagnostics Endpoint
  interface ContinuousHealthSnapshot {
    status: 'ok' | 'degraded';
    checkedAt: string;
    uptimeSeconds: number;
    projectId: string;
    firestoreDatabaseId: string;
    firestoreReachable: boolean;
    tokenServiceStatus: ServerTokenServiceStatus;
    geminiConfigured: boolean;
    aiEmergencyStop: boolean;
    firebaseAdminCredentialMode: 'service_account_json' | 'managed_adc';
    wordpressBridgeEnabled: boolean;
    wordpressWebhookSecretConfigured: boolean;
    anomalies: string[];
    recentSecurityEvents: SecurityAuditEvent[];
    adminConsoleLinks: {
      firebaseAuthProvidersUrl: string;
      firebaseCloudMessagingUrl: string;
      tokenServiceActivationUrl: string;
      iamConsoleUrl: string;
    };
  }

  let latestContinuousHealth: ContinuousHealthSnapshot | null = null;

  async function runContinuousHealthProbe(): Promise<ContinuousHealthSnapshot> {
    const cfg = loadVerifiedFirebaseConfig();
    const explicitSa = parseOptionalServiceAccountJson();
    const anomalies: string[] = [];
    let firestoreReachable = false;
    let aiEmergencyStop = false;
    let wordpressBridgeEnabled = false;

    if (cfg.configValid) {
      try {
        const firestoreBaseUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
          cfg.projectId
        )}/databases/${encodeURIComponent(cfg.firestoreDatabaseId)}/documents`;
        const resp = await fetch(`${firestoreBaseUrl}/publicConfig/settings?key=${encodeURIComponent(cfg.apiKey)}`);
        firestoreReachable = resp.status === 200 || resp.status === 404;
        if (resp.ok) {
          const docJson = (await resp.json()) as {
            fields?: Record<string, { booleanValue?: boolean }>;
          };
          aiEmergencyStop = docJson.fields?.aiEmergencyStop?.booleanValue === true;
          wordpressBridgeEnabled = docJson.fields?.wordpressPaymentEnabled?.booleanValue === true;
        }
      } catch {
        firestoreReachable = false;
      }
    }

    if (!firestoreReachable) {
      anomalies.push('Firestore publicConfig endpoint could not be verified on latest probe.');
    }

    const tokenProbe = await probeSecureTokenStatus(cfg);
    if (tokenProbe.status !== 'enabled_verified') {
      anomalies.push(
        `Token Service API status is "${tokenProbe.status}" (client 3-stage session continuity fallback is active).`
      );
    }

    const wpSecretOk = Boolean(process.env.WORDPRESS_WEBHOOK_SECRET && process.env.WORDPRESS_WEBHOOK_SECRET.trim().length >= 16);
    if (wordpressBridgeEnabled && !wpSecretOk) {
      anomalies.push('WordPress Live Payment is enabled in settings, but WORDPRESS_WEBHOOK_SECRET is not set on server (live gateways safely locked).');
    }

    const snap: ContinuousHealthSnapshot = {
      status: firestoreReachable ? 'ok' : 'degraded',
      checkedAt: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      projectId: cfg.projectId,
      firestoreDatabaseId: cfg.firestoreDatabaseId,
      firestoreReachable,
      tokenServiceStatus: tokenProbe.status,
      geminiConfigured: Boolean(getGeminiClient()),
      aiEmergencyStop,
      firebaseAdminCredentialMode: explicitSa ? 'service_account_json' : 'managed_adc',
      wordpressBridgeEnabled,
      wordpressWebhookSecretConfigured: wpSecretOk,
      anomalies,
      recentSecurityEvents: getRecentSecurityEvents(25),
      adminConsoleLinks: {
        firebaseAuthProvidersUrl: cfg.firebaseAuthConsoleUrl,
        firebaseCloudMessagingUrl: `https://console.firebase.google.com/project/${encodeURIComponent(
          cfg.projectId
        )}/settings/cloudmessaging`,
        tokenServiceActivationUrl: cfg.tokenServiceActivationUrl,
        iamConsoleUrl: cfg.iamConsoleUrl,
      },
    };
    latestContinuousHealth = snap;
    return snap;
  }

  // Schedule periodic non-destructive background health check every 5 minutes (.unref() so tests never hang)
  const healthTimer = setInterval(() => {
    void runContinuousHealthProbe().catch(() => {});
  }, 5 * 60 * 1000);
  if (typeof healthTimer.unref === 'function') {
    healthTimer.unref();
  }
  void runContinuousHealthProbe().catch(() => {});

  app.get('/api/admin/system-health', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const adminCaller = await verifyAdminCaller(req, cfg);
    if (!adminCaller) {
      recordSecurityEvent({
        type: 'admin_denied',
        endpoint: '/api/admin/system-health',
        actor: getCallerClientKey(req),
        summary: 'Unauthorized access attempt to /api/admin/system-health.',
      });
      return res.status(403).json({ error: 'Administrator authentication is required.' });
    }
    const forceRefresh = req.query.refresh === '1' || !latestContinuousHealth;
    const snap = forceRefresh
      ? await runContinuousHealthProbe()
      : { ...latestContinuousHealth!, recentSecurityEvents: getRecentSecurityEvents(25) };
    return res.json(snap);
  });

  // 4C. Unified BEXORA AI Assistant, Check-Now Website Audit & Unattended Daily Scheduler (Asia/Dhaka)
  const aiAdminEngine = createAiAdminEngine({
    workspaceRoot: __dirname,
    getFirebaseConfig: () => loadVerifiedFirebaseConfig(),
    getFirebaseAdminApp: (projectId: string) => getOrInitFirebaseAdminApp(projectId),
    isEmergencyStopActive: async () => isAiEmergencyStopActive(loadVerifiedFirebaseConfig()),
    getSystemHealthSnapshot: async () => {
      const snap = latestContinuousHealth || (await runContinuousHealthProbe());
      return {
        ...snap,
        firestorePublicReadOk: snap.firestoreReachable,
        tokenServiceOk: snap.tokenServiceStatus === 'enabled_verified',
        fcmAdminCredentialMode: snap.firebaseAdminCredentialMode,
      };
    },
  });

  // Start single non-duplicating background daily audit scheduler automatically on server startup
  aiAdminEngine.startBackgroundDailyScheduler();

  // Rate-limited, strictly privacy-redacted operational error telemetry beacon (zero private chat/PII)
  app.post('/api/telemetry/client-error', (req, res) => {
    const decision = telemetryLimiter.consume(`telemetry:${getCallerClientKey(req)}`);
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      return res.status(429).json({ ok: false });
    }
    const body = (req.body || {}) as Record<string, unknown>;
    aiAdminEngine.recordClientTelemetryEvent({
      kind: typeof body.kind === 'string' ? body.kind.slice(0, 64) : 'runtime_error',
      route: typeof body.route === 'string' ? body.route.slice(0, 160) : '/',
      componentOrEndpoint:
        typeof body.componentOrEndpoint === 'string' ? body.componentOrEndpoint.slice(0, 120) : 'window',
      message: typeof body.message === 'string' ? redactSecretsFromLogText(body.message).slice(0, 240) : '',
    });
    return res.json({ ok: true });
  });

  app.get('/api/admin/ai/overview', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const adminCaller = await verifyAdminCaller(req, cfg);
    if (!adminCaller) {
      return res.status(403).json({ error: 'Administrator authentication is required.' });
    }
    const overview = await aiAdminEngine.getRuntimeOverview(adminCaller.idToken);
    return res.json({
      ...overview,
      conversations: aiAdminEngine.getConversationsList(),
      serverStagedProposals: aiAdminEngine.getStagedProposals(),
    });
  });

  app.get('/api/admin/ai/audit/status', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const adminCaller = await verifyAdminCaller(req, cfg);
    if (!adminCaller) {
      return res.status(403).json({ error: 'Administrator authentication is required.' });
    }
    return res.json(aiAdminEngine.getActiveAuditStatus());
  });

  app.post('/api/admin/ai/audit/run', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const adminCaller = await verifyAdminCaller(req, cfg);
    if (!adminCaller) {
      return res.status(403).json({ error: 'Administrator authentication is required.' });
    }
    if (!consumeAuthenticatedUidLimit(req, res, 'ai_audit_run', adminCaller.uid, cloudAdminMutationLimiter)) {
      return;
    }
    try {
      const result = await aiAdminEngine.runComprehensiveWebsiteAudit({
        trigger: 'manual',
        adminIdToken: adminCaller.idToken,
      });
      return res.json(result);
    } catch (err) {
      return res.status(500).json({
        error: redactSecretsFromLogText(
          err instanceof Error ? err.message : 'Website audit encountered an unexpected failure.'
        ),
      });
    }
  });

  app.get('/api/admin/ai/reports/:reportId', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const adminCaller = await verifyAdminCaller(req, cfg);
    if (!adminCaller) {
      return res.status(403).json({ error: 'Administrator authentication is required.' });
    }
    const report = aiAdminEngine.getReportById(String(req.params.reportId || 'latest'));
    if (!report) {
      return res.status(404).json({ error: 'Audit report not found.' });
    }
    return res.json({ report });
  });

  app.put('/api/admin/ai/schedule', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const adminCaller = await verifyAdminCaller(req, cfg);
    if (!adminCaller) {
      return res.status(403).json({ error: 'Administrator authentication is required.' });
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const updated = aiAdminEngine.updateDailySchedule(
      {
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        hour: body.hour !== undefined ? Number(body.hour) : undefined,
        minute: body.minute !== undefined ? Number(body.minute) : undefined,
        timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
        notifyInApp: typeof body.notifyInApp === 'boolean' ? body.notifyInApp : undefined,
        notifyTelegram: typeof body.notifyTelegram === 'boolean' ? body.notifyTelegram : undefined,
        notifyEmail: typeof body.notifyEmail === 'boolean' ? body.notifyEmail : undefined,
      },
      adminCaller.uid
    );
    const overview = await aiAdminEngine.getRuntimeOverview(adminCaller.idToken);
    return res.json({
      schedule: updated,
      nextScheduledRunFormatted: overview.nextScheduledRunFormatted,
      nextScheduledRunIso: overview.nextScheduledRunIso,
    });
  });

  app.get('/api/admin/ai/conversations', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const adminCaller = await verifyAdminCaller(req, cfg);
    if (!adminCaller) {
      return res.status(403).json({ error: 'Administrator authentication is required.' });
    }
    return res.json({ conversations: aiAdminEngine.getConversationsList() });
  });

  app.get('/api/admin/ai/conversations/:conversationId', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const adminCaller = await verifyAdminCaller(req, cfg);
    if (!adminCaller) {
      return res.status(403).json({ error: 'Administrator authentication is required.' });
    }
    const convId = String(req.params.conversationId || '');
    return res.json({
      conversationId: convId,
      messages: aiAdminEngine.getConversationMessages(convId),
    });
  });

  app.delete('/api/admin/ai/conversations/:conversationId', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const adminCaller = await verifyAdminCaller(req, cfg);
    if (!adminCaller) {
      return res.status(403).json({ error: 'Administrator authentication is required.' });
    }
    const deleted = aiAdminEngine.deleteConversation(String(req.params.conversationId || ''));
    return res.json({ deleted });
  });

  app.post('/api/admin/ai/chat', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const adminCaller = await verifyAdminCaller(req, cfg);
    if (!adminCaller) {
      return res.status(403).json({ error: 'Administrator authentication is required.' });
    }
    if (!consumeAuthenticatedUidLimit(req, res, 'ai_admin_chat', adminCaller.uid, aiComputeLimiter)) {
      return;
    }
    const body = (req.body || {}) as {
      conversationId?: string;
      message?: string;
      pinnedContext?: { reportId?: string; issueId?: string; proposalId?: string };
    };
    if (typeof body.message !== 'string' || !body.message.trim()) {
      return res.status(400).json({ error: 'Message text is required.' });
    }
    try {
      const chatRes = await aiAdminEngine.handleAdminAssistantChat({
        conversationId: typeof body.conversationId === 'string' ? body.conversationId : undefined,
        message: body.message,
        actorUid: adminCaller.uid,
        adminIdToken: adminCaller.idToken,
        pinnedContext: body.pinnedContext,
      });
      return res.json(chatRes);
    } catch (err) {
      return res.status(500).json({
        error: redactSecretsFromLogText(
          err instanceof Error ? err.message : 'Assistant conversation request failed.'
        ),
      });
    }
  });

  app.post('/api/admin/ai/proposals/:proposalId/mark-synced', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const adminCaller = await verifyAdminCaller(req, cfg);
    if (!adminCaller) {
      return res.status(403).json({ error: 'Administrator authentication is required.' });
    }
    aiAdminEngine.markStagedProposalSynced(String(req.params.proposalId || ''));
    return res.json({ ok: true });
  });

  // Authenticated Admin-Only Deployment Archive Download (prevents unauthenticated public bundle zip scraping)
  app.get('/api/admin/deployment-archive', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const adminCaller = await verifyAdminCaller(req, cfg);
    if (!adminCaller) {
      recordSecurityEvent({
        type: 'admin_denied',
        endpoint: '/api/admin/deployment-archive',
        actor: getCallerClientKey(req),
        summary: 'Blocked unauthenticated or non-admin deployment archive download attempt.',
      });
      return res.status(403).json({ error: 'Administrator authentication is required.' });
    }
    const zipPath = path.join(__dirname, 'BEXORA_INFINITYFREE_PRODUCTION.zip');
    if (!fs.existsSync(zipPath)) {
      return res.status(404).json({ error: 'Deployment archive has not been generated yet. Run npm run build first.' });
    }
    recordSecurityEvent({
      type: 'admin_action',
      endpoint: '/api/admin/deployment-archive',
      actor: adminCaller.uid,
      summary: 'Administrator downloaded BEXORA_INFINITYFREE_PRODUCTION.zip deployment archive.',
    });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="BEXORA_INFINITYFREE_PRODUCTION.zip"');
    return res.sendFile(zipPath);
  });

  // 5. WordPress Multi-Gateway Live Payment Bridge (Zero-Fake-Payment Architecture + DNS-Verified SSRF Guard)
  function isSafeExternalHttpsWordPressUrl(rawUrl: string): { valid: boolean; normalizedUrl: string; error?: string } {
    const check = validateSafeExternalHttpsUrl(rawUrl, 200);
    return { valid: check.valid, normalizedUrl: check.normalizedUrl, error: check.error };
  }

  function readFirestoreIntegerField(docJson: Record<string, unknown> | null, key: string): number {
    if (!docJson || typeof docJson !== 'object') return 0;
    const fields = (docJson as { fields?: Record<string, { integerValue?: string; doubleValue?: number }> }).fields;
    if (typeof fields?.[key]?.integerValue === 'string') {
      return Number(fields[key].integerValue) || 0;
    }
    if (typeof fields?.[key]?.doubleValue === 'number') {
      return Math.round(fields[key].doubleValue!);
    }
    return 0;
  }

  async function readPublicWordPressSettings(cfg: ReturnType<typeof loadVerifiedFirebaseConfig>): Promise<{
    enabledInSettings: boolean;
    siteUrl: string;
    bridgeEndpoint: string;
    buyerFeeEnabled: boolean;
    buyerFeePct: number;
    sellerFeeEnabled: boolean;
    sellerFeePct: number;
  }> {
    const defaults = {
      enabledInSettings: false,
      siteUrl: '',
      bridgeEndpoint: '/wp-json/bexora/v1',
      buyerFeeEnabled: true,
      buyerFeePct: 5,
      sellerFeeEnabled: false,
      sellerFeePct: 0,
    };
    if (!cfg.configValid) return defaults;
    try {
      const firestoreBaseUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
        cfg.projectId
      )}/databases/${encodeURIComponent(cfg.firestoreDatabaseId)}/documents`;
      const resp = await fetch(`${firestoreBaseUrl}/publicConfig/settings?key=${encodeURIComponent(cfg.apiKey)}`);
      if (!resp.ok) return defaults;
      const docJson = (await resp.json()) as Record<string, unknown>;
      const fields = (docJson as { fields?: Record<string, { booleanValue?: boolean; doubleValue?: number; integerValue?: string }> }).fields;
      const rawEndpoint = readFirestoreStringField(docJson, 'wordpressBridgeEndpoint') || '/wp-json/bexora/v1';
      return {
        enabledInSettings: readFirestoreBooleanField(docJson, 'wordpressPaymentEnabled'),
        siteUrl: readFirestoreStringField(docJson, 'wordpressSiteUrl'),
        bridgeEndpoint:
          /^\/[A-Za-z0-9_/-]{1,100}$/.test(rawEndpoint) && !rawEndpoint.includes('..')
            ? rawEndpoint
            : '/wp-json/bexora/v1',
        buyerFeeEnabled: typeof fields?.buyerFeeEnabled?.booleanValue === 'boolean' ? fields.buyerFeeEnabled.booleanValue : true,
        buyerFeePct:
          typeof fields?.buyerFeePct?.doubleValue === 'number'
            ? fields.buyerFeePct.doubleValue
            : typeof fields?.buyerFeePct?.integerValue === 'string'
            ? Number(fields.buyerFeePct.integerValue)
            : 5,
        sellerFeeEnabled: typeof fields?.sellerFeeEnabled?.booleanValue === 'boolean' ? fields.sellerFeeEnabled.booleanValue : false,
        sellerFeePct:
          typeof fields?.sellerFeePct?.doubleValue === 'number'
            ? fields.sellerFeePct.doubleValue
            : typeof fields?.sellerFeePct?.integerValue === 'string'
            ? Number(fields.sellerFeePct.integerValue)
            : 0,
      };
    } catch {
      return defaults;
    }
  }

  function signWordPressPayload(secret: string, bodyString: string): string {
    return crypto.createHmac('sha256', secret).update(bodyString, 'utf8').digest('hex');
  }

  function verifyWordPressSignature(secret: string, bodyString: string, providedSig: string): boolean {
    if (!secret || !providedSig) return false;
    const expected = signWordPressPayload(secret, bodyString);
    const cleanProvided = providedSig.trim().replace(/^sha256=/i, '');
    if (cleanProvided.length !== expected.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(cleanProvided, 'utf8'));
    } catch {
      return false;
    }
  }

  // 5A. Discover active WordPress payment methods (supports multi-gateway WordPress/WooCommerce plugins)
  app.get(
    '/api/payments/wordpress/methods',
    makeRateLimitMiddleware('wp_methods', diagnosticProbeLimiter),
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const cfg = loadVerifiedFirebaseConfig();
        const saved = await readPublicWordPressSettings(cfg);
        const webhookSecret = String(process.env.WORDPRESS_WEBHOOK_SECRET || '').trim();
        const webhookSecretConfigured = webhookSecret.length >= 16;

        // Optional admin preview override for testing draft URLs in Admin Console before saving
        let enabledInSettings = saved.enabledInSettings;
        let siteUrl = saved.siteUrl;
        let bridgeEndpoint = saved.bridgeEndpoint;

        if (typeof req.query.siteUrl === 'string' && req.query.testDraft === '1') {
          const caller = await verifyCallerFirebaseToken(req, cfg);
          const isSuperAdmin =
            caller &&
            (caller.uid === BOOTSTRAPPED_SUPERADMIN_UID ||
              (caller.emailVerified && caller.email === BOOTSTRAPPED_SUPERADMIN_EMAIL));
          if (isSuperAdmin) {
            enabledInSettings = req.query.enabled !== 'false';
            siteUrl = String(req.query.siteUrl || '').trim();
            const draftBridge = String(req.query.bridgeEndpoint || '').trim();
            if (/^\/[A-Za-z0-9_/-]{1,100}$/.test(draftBridge) && !draftBridge.includes('..')) {
              bridgeEndpoint = draftBridge;
            }
          }
        }

        const urlCheck = isSafeExternalHttpsWordPressUrl(siteUrl);
        if (!siteUrl || !urlCheck.valid || !enabledInSettings || !webhookSecretConfigured) {
          if (siteUrl && !urlCheck.valid) {
            recordSecurityEvent({
              type: 'ssrf_blocked',
              endpoint: '/api/payments/wordpress/methods',
              actor: getCallerClientKey(req),
              summary: urlCheck.error || 'Blocked unsafe WordPress URL.',
            });
          }
          return res.json({
            ok: true,
            enabledInSettings,
            siteUrl: urlCheck.valid ? urlCheck.normalizedUrl : '',
            bridgeEndpoint,
            liveVerified: false,
            webhookSecretConfigured,
            rawMethods: [],
            errorHint: !siteUrl ? undefined : urlCheck.error,
          });
        }

        const dnsCheck = await assertSafeExternalHttpsDestination(urlCheck.normalizedUrl, 200);
        if (!dnsCheck.ok) {
          recordSecurityEvent({
            type: 'ssrf_blocked',
            endpoint: '/api/payments/wordpress/methods',
            actor: getCallerClientKey(req),
            summary: dnsCheck.error || 'WordPress hostname failed DNS SSRF check.',
          });
          return res.json({
            ok: true,
            enabledInSettings,
            siteUrl: '',
            bridgeEndpoint,
            liveVerified: false,
            webhookSecretConfigured,
            rawMethods: [],
            errorHint: dnsCheck.error || 'Destination hostname failed safety verification.',
          });
        }

        const cleanBase = dnsCheck.normalizedUrl;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);

        try {
          const probeTs = String(Date.now());
          const bridgeUrl = `${cleanBase}${bridgeEndpoint.replace(/\/+$/, '')}/methods`;
          const bridgeRes = await fetch(bridgeUrl, {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              'X-Bexora-Timestamp': probeTs,
              'X-Bexora-Signature': signWordPressPayload(webhookSecret, `GET:${probeTs}`),
            },
            redirect: 'error',
            signal: controller.signal,
          }).catch(() => null);

          if (bridgeRes && bridgeRes.ok) {
            clearTimeout(timer);
            const json = (await bridgeRes.json().catch(() => ({}))) as { methods?: unknown[] } | unknown[];
            const rawMethods = Array.isArray(json)
              ? json
              : Array.isArray(json?.methods)
              ? json.methods
              : [];
            return res.json({
              ok: true,
              enabledInSettings: true,
              siteUrl: cleanBase,
              bridgeEndpoint,
              liveVerified: true,
              webhookSecretConfigured: true,
              rawMethods,
            });
          }

          // Optional fallback to WooCommerce REST v3 payment_gateways if consumer credentials are set
          const wcKey = String(process.env.WORDPRESS_CONSUMER_KEY || '').trim();
          const wcSecret = String(process.env.WORDPRESS_CONSUMER_SECRET || '').trim();
          if (wcKey && wcSecret) {
            const basic = Buffer.from(`${wcKey}:${wcSecret}`).toString('base64');
            const wcRes = await fetch(`${cleanBase}/wp-json/wc/v3/payment_gateways`, {
              method: 'GET',
              headers: {
                Accept: 'application/json',
                Authorization: `Basic ${basic}`,
              },
              redirect: 'error',
              signal: controller.signal,
            }).catch(() => null);
            clearTimeout(timer);

            if (wcRes && wcRes.ok) {
              const wcJson = (await wcRes.json().catch(() => [])) as unknown[];
              return res.json({
                ok: true,
                enabledInSettings: true,
                siteUrl: cleanBase,
                bridgeEndpoint,
                liveVerified: true,
                webhookSecretConfigured: true,
                rawMethods: Array.isArray(wcJson) ? wcJson : [],
              });
            }
          }

          clearTimeout(timer);
          return res.json({
            ok: true,
            enabledInSettings: true,
            siteUrl: cleanBase,
            bridgeEndpoint,
            liveVerified: false,
            webhookSecretConfigured: true,
            rawMethods: [],
            errorHint: `WordPress endpoint ${cleanBase}${bridgeEndpoint}/methods did not return an active gateway list (HTTP ${bridgeRes?.status || 'unreachable'}).`,
          });
        } catch {
          clearTimeout(timer);
          return res.json({
            ok: true,
            enabledInSettings: true,
            siteUrl: cleanBase,
            bridgeEndpoint,
            liveVerified: false,
            webhookSecretConfigured: true,
            rawMethods: [],
            errorHint: 'Timed out reaching WordPress Live Payment endpoint.',
          });
        }
      } catch {
        return res.json({
          ok: false,
          enabledInSettings: false,
          siteUrl: '',
          bridgeEndpoint: '/wp-json/bexora/v1',
          liveVerified: false,
          webhookSecretConfigured: false,
          rawMethods: [],
        });
      }
    }
  );

  // 5B. Create a real signed WordPress Live Payment checkout session (NEVER fakes payment completion)
  app.post(
    '/api/payments/wordpress/create-session',
    makeRateLimitMiddleware('wp_create_session', paymentSessionLimiter),
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const cfg = loadVerifiedFirebaseConfig();
        const caller = await verifyCallerFirebaseToken(req, cfg);
        if (!caller) {
          return res.status(401).json({ ok: false, errorCode: 'unauthorized', message: 'Sign in required to initiate checkout.' });
        }

        if (!consumeAuthenticatedUidLimit(req, res, 'wp_create_session', caller.uid, paymentSessionLimiter)) {
          return;
        }

        const saved = await readPublicWordPressSettings(cfg);
        const webhookSecret = String(process.env.WORDPRESS_WEBHOOK_SECRET || '').trim();
        const dnsCheck = saved.siteUrl
          ? await assertSafeExternalHttpsDestination(saved.siteUrl, 200)
          : { ok: false, normalizedUrl: '', error: 'Not configured' };

        if (!saved.enabledInSettings || !dnsCheck.ok || webhookSecret.length < 16) {
          if (saved.enabledInSettings && saved.siteUrl && !dnsCheck.ok) {
            recordSecurityEvent({
              type: 'ssrf_blocked',
              endpoint: '/api/payments/wordpress/create-session',
              actor: caller.uid,
              summary: dnsCheck.error || 'Blocked unsafe WordPress checkout endpoint.',
            });
          }
          return res.status(409).json({
            ok: false,
            errorCode: 'wordpress_not_configured',
            message:
              'Live WordPress payment gateways are not yet connected and verified on this server. Please complete your purchase using BEXORA Wallet Balance.',
          });
        }

        const body = (req.body || {}) as Record<string, unknown>;
        const gatewayId = String(body.gatewayId || '').trim();
        const mode = body.mode === 'accepted_bid_deal' ? 'accepted_bid_deal' : 'buy_now';
        const listingId = String(body.listingId || '').trim();
        const dealId = String(body.dealId || '').trim();
        const returnOrigin = `${req.protocol}://${String(req.get('host') || 'localhost:3000')}`;

        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(gatewayId)) {
          return res.status(400).json({ ok: false, errorCode: 'invalid_gateway', message: 'Select a valid live payment method.' });
        }

        const firestoreBaseUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
          cfg.projectId
        )}/databases/${encodeURIComponent(cfg.firestoreDatabaseId)}/documents`;

        let verifiedAmountMinor = 0;
        let verifiedCurrency = 'BDT';
        let verifiedTitle = '';
        let targetListingId = listingId;
        let targetDealId = dealId;

        if (mode === 'accepted_bid_deal') {
          if (!/^[a-zA-Z0-9_-]{1,128}$/.test(dealId)) {
            return res.status(400).json({ ok: false, errorCode: 'invalid_deal', message: 'Invalid deal identifier.' });
          }
          const dealRes = await fetch(`${firestoreBaseUrl}/deals/${encodeURIComponent(dealId)}`, {
            headers: { Authorization: `Bearer ${caller.idToken}` },
          });
          if (!dealRes.ok) {
            return res.status(404).json({ ok: false, errorCode: 'deal_not_found', message: 'Reserved deal could not be loaded.' });
          }
          const dealDoc = (await dealRes.json()) as Record<string, unknown>;
          const buyerId = readFirestoreStringField(dealDoc, 'buyerId');
          const status = readFirestoreStringField(dealDoc, 'status');
          if (buyerId !== caller.uid) {
            return res.status(403).json({ ok: false, errorCode: 'forbidden', message: 'Only the reserved buyer can fund this deal.' });
          }
          if (!['accepted_pending_payment', 'awaiting_payment', 'payment_pending_verification'].includes(status)) {
            return res.status(409).json({ ok: false, errorCode: 'already_paid', message: 'This deal is already funded or closed.' });
          }
          verifiedAmountMinor = readFirestoreIntegerField(dealDoc, 'buyerTotalMinor');
          verifiedCurrency = readFirestoreStringField(dealDoc, 'currency') === 'USD' ? 'USD' : 'BDT';
          verifiedTitle = readFirestoreStringField(dealDoc, 'listingTitle') || 'BEXORA Escrow Deal';
          targetListingId = readFirestoreStringField(dealDoc, 'listingId');
        } else {
          if (!/^[a-zA-Z0-9_-]{1,128}$/.test(listingId)) {
            return res.status(400).json({ ok: false, errorCode: 'invalid_listing', message: 'Invalid listing identifier.' });
          }
          const listingRes = await fetch(`${firestoreBaseUrl}/listings/${encodeURIComponent(listingId)}`, {
            headers: { Authorization: `Bearer ${caller.idToken}` },
          });
          if (!listingRes.ok) {
            return res.status(404).json({ ok: false, errorCode: 'listing_not_found', message: 'Listing could not be loaded.' });
          }
          const listingDoc = (await listingRes.json()) as Record<string, unknown>;
          const sellerId = readFirestoreStringField(listingDoc, 'sellerId');
          const status = readFirestoreStringField(listingDoc, 'status');
          if (sellerId === caller.uid) {
            return res.status(400).json({ ok: false, errorCode: 'self_purchase', message: 'Sellers cannot purchase their own listing.' });
          }
          if (status !== 'active') {
            return res.status(409).json({ ok: false, errorCode: 'listing_unavailable', message: 'This listing is no longer available for Buy Now.' });
          }
          const basePriceMinor = readFirestoreIntegerField(listingDoc, 'priceMinor');
          const effectiveBuyerFeePct = saved.buyerFeeEnabled ? saved.buyerFeePct : 0;
          const buyerFeeMinor = Math.round((basePriceMinor * effectiveBuyerFeePct) / 100);
          verifiedAmountMinor = basePriceMinor + buyerFeeMinor;
          verifiedCurrency = readFirestoreStringField(listingDoc, 'currency') === 'USD' ? 'USD' : 'BDT';
          verifiedTitle = readFirestoreStringField(listingDoc, 'title') || 'BEXORA Digital Asset';
          targetDealId = `deal_wp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        }

        if (verifiedAmountMinor <= 0) {
          return res.status(400).json({ ok: false, errorCode: 'invalid_amount', message: 'Calculated order total must be positive.' });
        }

        const sessionId = `wps_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        const returnQuery =
          mode === 'accepted_bid_deal'
            ? `?view=checkout&dealId=${encodeURIComponent(targetDealId)}&wp_session=${encodeURIComponent(sessionId)}`
            : `?view=checkout&listingId=${encodeURIComponent(targetListingId)}&wp_session=${encodeURIComponent(sessionId)}`;

        const sessionPayload = {
          sessionId,
          mode,
          gatewayId,
          buyerUid: caller.uid,
          buyerEmail: caller.email,
          listingId: targetListingId,
          dealId: targetDealId,
          title: verifiedTitle,
          amountMinor: verifiedAmountMinor,
          currency: verifiedCurrency,
          returnUrl: `${returnOrigin}/${returnQuery}`,
          webhookUrl: `${returnOrigin}/api/payments/wordpress/webhook`,
          createdAtMs: Date.now(),
        };
        const payloadStr = JSON.stringify(sessionPayload);
        const signature = signWordPressPayload(webhookSecret, payloadStr);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const createUrl = `${dnsCheck.normalizedUrl}${saved.bridgeEndpoint.replace(/\/+$/, '')}/create-checkout`;
        const wpRes = await fetch(createUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Bexora-Signature': signature,
          },
          body: payloadStr,
          redirect: 'error',
          signal: controller.signal,
        }).catch(() => null);
        clearTimeout(timer);

        if (!wpRes || !wpRes.ok) {
          return res.status(502).json({
            ok: false,
            errorCode: 'wordpress_session_failed',
            message:
              'WordPress payment gateway could not initialize a live checkout session right now. No charge was made. You can pay immediately using BEXORA Wallet Balance.',
          });
        }

        const wpJson = (await wpRes.json().catch(() => ({}))) as { redirectUrl?: string };
        const rawRedirect = String(wpJson.redirectUrl || '').trim();
        const redirectDnsCheck = await assertSafeExternalHttpsDestination(rawRedirect, 300);
        if (!redirectDnsCheck.ok) {
          recordSecurityEvent({
            type: 'ssrf_blocked',
            endpoint: '/api/payments/wordpress/create-session',
            actor: caller.uid,
            summary: redirectDnsCheck.error || 'Blocked unsafe redirectUrl from WordPress gateway.',
          });
          return res.status(502).json({
            ok: false,
            errorCode: 'invalid_redirect_url',
            message: 'WordPress gateway returned an invalid HTTPS redirect URL. No payment was initiated.',
          });
        }

        const parsedRedirect = new URL(rawRedirect);
        return res.json({
          ok: true,
          sessionId,
          redirectUrl: parsedRedirect.toString(),
        });
      } catch {
        return res.status(502).json({
          ok: false,
          errorCode: 'bridge_error',
          message: 'Unexpected error communicating with WordPress payment gateway. No charge was made.',
        });
      }
    }
  );

  // 5C. Verify WordPress payment session on return (STRICT: never marks paid without verified WordPress signature)
  app.get(
    '/api/payments/wordpress/verify-session',
    makeRateLimitMiddleware('wp_verify_session', paymentSessionLimiter),
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const cfg = loadVerifiedFirebaseConfig();
        const caller = await verifyCallerFirebaseToken(req, cfg);
        if (!caller) {
          return res.status(401).json({ ok: false, paid: false, message: 'Sign in required to verify payment status.' });
        }
        const sessionId = String(req.query.sessionId || '').trim();
        if (!/^wps_[a-zA-Z0-9_]{8,64}$/.test(sessionId)) {
          return res.status(400).json({ ok: false, paid: false, message: 'Invalid WordPress payment session reference.' });
        }
        const saved = await readPublicWordPressSettings(cfg);
        const webhookSecret = String(process.env.WORDPRESS_WEBHOOK_SECRET || '').trim();
        const dnsCheck = saved.siteUrl
          ? await assertSafeExternalHttpsDestination(saved.siteUrl, 200)
          : { ok: false, normalizedUrl: '', error: 'Not configured' };
        if (!saved.enabledInSettings || !dnsCheck.ok || webhookSecret.length < 16) {
          return res.json({
            ok: false,
            paid: false,
            status: 'unconfigured',
            message: 'WordPress payment verification is not active on this server. Order remains unpaid.',
          });
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 6000);
        const verifyUrl = `${dnsCheck.normalizedUrl}${saved.bridgeEndpoint.replace(/\/+$/, '')}/session-status?sessionId=${encodeURIComponent(
          sessionId
        )}`;
        const wpRes = await fetch(verifyUrl, {
          headers: {
            Accept: 'application/json',
            'X-Bexora-Signature': signWordPressPayload(webhookSecret, `VERIFY:${sessionId}`),
          },
          redirect: 'error',
          signal: controller.signal,
        }).catch(() => null);
        clearTimeout(timer);

        if (!wpRes || !wpRes.ok) {
          return res.json({
            ok: false,
            paid: false,
            status: 'pending_or_unreachable',
            message: 'Payment has not been confirmed by WordPress gateway yet. Order remains unpaid.',
          });
        }

        const rawText = await wpRes.text();
        const respSig = String(wpRes.headers.get('x-bexora-signature') || '');
        if (!verifyWordPressSignature(webhookSecret, rawText, respSig)) {
          recordSecurityEvent({
            type: 'webhook_rejected',
            endpoint: '/api/payments/wordpress/verify-session',
            actor: caller.uid,
            summary: 'WordPress session-status response failed HMAC signature verification.',
          });
          return res.status(403).json({
            ok: false,
            paid: false,
            status: 'signature_invalid',
            message: 'WordPress payment verification signature check failed. Order cannot be marked paid.',
          });
        }

        const statusJson = JSON.parse(rawText) as {
          paid?: boolean;
          paymentStatus?: string;
          buyerUid?: string;
          dealId?: string;
        };
        const isPaid = statusJson.paid === true && statusJson.paymentStatus === 'paid' && statusJson.buyerUid === caller.uid;

        return res.json({
          ok: true,
          paid: isPaid,
          dealId: typeof statusJson.dealId === 'string' ? statusJson.dealId : undefined,
          status: isPaid ? 'verified_paid' : String(statusJson.paymentStatus || 'unpaid'),
          message: isPaid
            ? 'Live payment verified by WordPress gateway.'
            : 'Payment was not completed or is still pending gateway confirmation.',
        });
      } catch {
        return res.json({
          ok: false,
          paid: false,
          status: 'verification_error',
          message: 'Could not verify live payment status. Order remains unpaid.',
        });
      }
    }
  );

  // 5D. Cryptographically verified WordPress Payment Webhook (Raw-Body HMAC-SHA256 + Timestamp Skew + Replay Guard)
  app.post(
    '/api/payments/wordpress/webhook',
    makeRateLimitMiddleware('wp_webhook', webhookLimiter),
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const webhookSecret = String(process.env.WORDPRESS_WEBHOOK_SECRET || '').trim();
      if (webhookSecret.length < 16) {
        return res.status(503).json({ ok: false, error: 'Webhook verification secret is not configured.' });
      }
      const providedSig = String(
        req.headers['x-bexora-signature'] || req.headers['x-wc-webhook-signature'] || ''
      );
      const timestampHeader = String(req.headers['x-bexora-timestamp'] || '');
      const rawBody =
        typeof (req as RawBodyRequest).rawBody === 'string'
          ? (req as RawBodyRequest).rawBody!
          : JSON.stringify(req.body || {});
      const payload = (req.body || {}) as Record<string, unknown>;
      const eventKey = String(
        payload.eventId || payload.sessionId || payload.transactionId || ''
      ).trim();

      const verification = verifyWordPressWebhookRequest({
        rawBody,
        signatureHeader: providedSig,
        timestampHeader,
        secret: webhookSecret,
        eventKey: eventKey || `hash_${crypto.createHash('sha256').update(rawBody).digest('hex').slice(0, 24)}`,
        replayCache: webhookReplayCache,
      });

      if (!verification.ok) {
        recordSecurityEvent({
          type: 'webhook_rejected',
          endpoint: '/api/payments/wordpress/webhook',
          actor: getCallerClientKey(req),
          summary: verification.reason || 'Webhook verification failed.',
        });
        return res.status(verification.status).json({
          ok: false,
          error: verification.reason || 'Webhook verification failed.',
        });
      }

      if (payload.paymentStatus !== 'paid') {
        return res.json({ ok: true, acknowledged: true, action: 'ignored_non_paid_event' });
      }
      return res.json({ ok: true, acknowledged: true, action: 'verified_paid_webhook_received' });
    }
  );

  // Safe API Error Handler (prevents stack trace leakage on malformed JSON or oversized bodies)
  app.use(
    '/api',
    (
      err: Error & { status?: number; statusCode?: number; type?: string },
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (res.headersSent) {
        return next(err);
      }
      if (err?.type === 'entity.too.large' || err?.status === 413 || err?.statusCode === 413) {
        recordSecurityEvent({
          type: 'payload_rejected',
          endpoint: req.originalUrl.split('?')[0] || req.path,
          actor: getCallerClientKey(req),
          summary: 'Rejected oversized API request body.',
        });
        return res.status(413).json({
          ok: false,
          error: 'Request payload exceeds maximum allowed size.',
        });
      }
      if (err instanceof SyntaxError && 'body' in err) {
        recordSecurityEvent({
          type: 'payload_rejected',
          endpoint: req.originalUrl.split('?')[0] || req.path,
          actor: getCallerClientKey(req),
          summary: 'Rejected malformed JSON request body.',
        });
        return res.status(400).json({
          ok: false,
          error: 'Malformed JSON request body.',
        });
      }
      return res.status(500).json({
        ok: false,
        error: 'Unexpected internal server error.',
      });
    }
  );

  const httpServer = http.createServer(app);
  const isProd = isProdRuntime;
  if (isProd) {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath, { dotfiles: 'deny', index: false }));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const hmrDisabled = process.env.DISABLE_HMR === 'true';
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: { server: httpServer },
        ws: hmrDisabled ? false : { server: httpServer },
        hmr: hmrDisabled ? false : { overlay: false },
        watch: hmrDisabled ? null : {},
        forwardConsole: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`BEXORA server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start BEXORA server:', err);
  process.exit(1);
});
