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
import { verifyWordPressWebhookRequest } from './src/lib/serverWebhookSecurity';

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
  const webhookReplayCache = new Map<string, number>();

  app.use(
    express.json({
      limit: '6mb',
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = buf.toString('utf8');
      },
    })
  );

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
    return {
      apiKey,
      projectId,
      projectNumber,
      appId,
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

  app.get('/api/auth/capabilities', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    try {
      const cfg = loadVerifiedFirebaseConfig();
      const rawHost = String(req.get('host') || 'localhost:3000');
      const hostname = rawHost.split(':')[0].toLowerCase();
      const origin = `${req.protocol}://${rawHost}`;
      const sandboxServiceAccountEmail = await resolveSandboxServiceAccountEmail();
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
          authorizedDomains: [],
          currentDomainAuthorized: false,
          tokenServiceEnabled: false,
          tokenServiceStatus: 'config_mismatch',
          tokenServiceMessage: 'Firebase configuration mismatch detected.',
          tokenServiceActivationUrl: cfg.tokenServiceActivationUrl,
          iamConsoleUrl: cfg.iamConsoleUrl,
          firebaseAuthConsoleUrl: cfg.firebaseAuthConsoleUrl,
          firebaseAuthorizedDomainsUrl,
          sandboxServiceAccountEmail,
          requiredRole: 'roles/serviceusage.serviceUsageAdmin',
          checkedAtMs: Date.now(),
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

      return res.json({
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
        tokenServiceActivationUrl: cfg.tokenServiceActivationUrl,
        iamConsoleUrl: cfg.iamConsoleUrl,
        firebaseAuthConsoleUrl: cfg.firebaseAuthConsoleUrl,
        firebaseAuthorizedDomainsUrl,
        sandboxServiceAccountEmail,
        requiredRole: 'roles/serviceusage.serviceUsageAdmin',
        checkedAtMs: Date.now(),
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
        checkedAtMs: Date.now(),
      });
    }
  });

  app.post('/api/auth/enable-token-service', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const cfg = loadVerifiedFirebaseConfig();
      const adminCaller = await verifyAdminCaller(req, cfg);
      if (!adminCaller) {
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
      const decoded = await getAdminAuth(adminApp).verifyIdToken(idToken);
      const uid = String(decoded.uid || '').trim();
      if (uid) {
        return {
          uid,
          email: String(decoded.email || '').trim().toLowerCase(),
          emailVerified: Boolean(decoded.email_verified),
          idToken,
        };
      }
    } catch {
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
        users?: Array<{ localId?: string; email?: string; emailVerified?: boolean }>;
      };
      const u = lookupJson.users?.[0];
      const uid = String(u?.localId || '').trim();
      if (!uid) return null;
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

  app.get('/api/fcm/status', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const cfg = loadVerifiedFirebaseConfig();
      const sandboxServiceAccountEmail = await resolveSandboxServiceAccountEmail();
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
        detailMessage = `Server runtime (${sandboxServiceAccountEmail || 'Managed ADC'}) needs roles/firebasecloudmessaging.admin and roles/datastore.user on project ${cfg.projectId} to dispatch closed-tab background pushes.`;
      }

      return res.json({
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
        sandboxServiceAccountEmail,
        requiredRoles,
        firebaseCloudMessagingConsoleUrl,
        fcmRegistrationsActivationUrl,
        fcmV1ActivationUrl,
        firebaseInstallationsActivationUrl,
        iamConsoleUrl: cfg.iamConsoleUrl,
        vapidConsoleErrorDiagnosis,
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
        firebaseCloudMessagingConsoleUrl:
          'https://console.firebase.google.com/project/responsive-dragon-tmn89/settings/cloudmessaging',
        fcmRegistrationsActivationUrl:
          'https://console.cloud.google.com/apis/library/fcmregistrations.googleapis.com?project=responsive-dragon-tmn89',
        fcmV1ActivationUrl:
          'https://console.cloud.google.com/apis/library/fcm.googleapis.com?project=responsive-dragon-tmn89',
        firebaseInstallationsActivationUrl:
          'https://console.cloud.google.com/apis/library/firebaseinstallations.googleapis.com?project=responsive-dragon-tmn89',
        iamConsoleUrl: 'https://console.cloud.google.com/iam-admin/iam?project=responsive-dragon-tmn89',
        vapidConsoleErrorDiagnosis: 'Unable to probe Google Cloud APIs due to temporary network error.',
        detailMessage: 'Unable to probe FCM status due to temporary network error.',
      });
    }
  });

  app.post('/api/fcm/enable-cloud-apis', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const cfg = loadVerifiedFirebaseConfig();
      const adminCaller = await verifyAdminCaller(req, cfg);
      if (!adminCaller) {
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
  });

  app.post('/api/fcm/send', async (req, res) => {
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
        const decoded = await getAdminAuth(adminApp).verifyIdToken(idToken);
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
        users?: Array<{ localId?: string; email?: string; emailVerified?: boolean }>;
      };
      const verifiedUser = lookupJson.users?.[0];
      const callerUid = String(verifiedUser?.localId || '').trim();
      const callerEmail = String(verifiedUser?.email || '').trim().toLowerCase();
      const callerEmailVerified = Boolean(verifiedUser?.emailVerified);
      if (!callerUid || callerUid !== decodedTokenUid) {
        return res.status(401).json({ ok: false, deliveryStatus: 'invalid_caller' });
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
  app.post('/api/fcm/fanout-followers', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const cfg = loadVerifiedFirebaseConfig();
      if (!cfg.configValid) {
        return res.status(503).json({ ok: false, deliveryStatus: 'config_mismatch' });
      }

      const adminCaller = await verifyAdminCaller(req, cfg);
      if (!adminCaller) {
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
  app.post('/api/ai/verify-evidence', async (req, res) => {
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

      const match = imageDataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
      if (!match) {
        return res.status(400).json({ error: 'Unsupported evidence image format. Use PNG, JPEG, or WebP.' });
      }

      const mimeType = match[1];
      const base64Data = match[2];

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: {
          parts: [
            { inlineData: { mimeType, data: base64Data } },
            {
              text: `Inspect this seller-submitted screenshot for a ${platform} digital asset claiming monetization programs: ${claimedOptions.join(', ')}.
Assess strictly without overclaiming:
1. Does the screenshot match ${platform}?
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
  });

  // 4. Server-Side AI Developer Chat (Admin Panel Only + Server-Side Emergency-Stop Gate)
  app.post('/api/ai/developer-chat', async (req, res) => {
    try {
      const cfg = loadVerifiedFirebaseConfig();
      const adminCaller = await verifyAdminCaller(req, cfg);
      if (!adminCaller) {
        return res.status(403).json({
          available: false,
          reply: 'Administrator authentication is required to use BEXORA AI Developer.',
        });
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
      return res.status(403).json({ error: 'Administrator authentication is required.' });
    }
    const forceRefresh = req.query.refresh === '1' || !latestContinuousHealth;
    const snap = forceRefresh ? await runContinuousHealthProbe() : latestContinuousHealth!;
    return res.json(snap);
  });

  // 5. WordPress Multi-Gateway Live Payment Bridge (Zero-Fake-Payment Architecture)
  function isSafeExternalHttpsWordPressUrl(rawUrl: string): { valid: boolean; normalizedUrl: string; error?: string } {
    const trimmed = String(rawUrl || '').trim();
    if (!trimmed) return { valid: false, normalizedUrl: '', error: 'WordPress HTTPS URL is empty.' };
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return { valid: false, normalizedUrl: '', error: 'Invalid URL format.' };
    }
    if (parsed.protocol !== 'https:') {
      return { valid: false, normalizedUrl: '', error: 'WordPress Live Payment URL must use https://.' };
    }
    if (parsed.username || parsed.password) {
      return { valid: false, normalizedUrl: '', error: 'Credentials are not allowed in the WordPress URL.' };
    }
    const host = parsed.hostname.toLowerCase();
    // SSRF guard: block private / loopback / metadata hostnames
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host.endsWith('.internal') ||
      host.endsWith('.local') ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      return { valid: false, normalizedUrl: '', error: 'Private or internal network hosts are forbidden.' };
    }
    const normalizedUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
    if (normalizedUrl.length > 200) {
      return { valid: false, normalizedUrl: '', error: 'WordPress URL exceeds 200 characters.' };
    }
    return { valid: true, normalizedUrl };
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
        bridgeEndpoint: /^\/[A-Za-z0-9_/-]{1,100}$/.test(rawEndpoint) ? rawEndpoint : '/wp-json/bexora/v1',
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
  app.get('/api/payments/wordpress/methods', async (req, res) => {
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
          if (/^\/[A-Za-z0-9_/-]{1,100}$/.test(draftBridge)) {
            bridgeEndpoint = draftBridge;
          }
        }
      }

      const urlCheck = isSafeExternalHttpsWordPressUrl(siteUrl);
      if (!siteUrl || !urlCheck.valid || !enabledInSettings || !webhookSecretConfigured) {
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

      const cleanBase = urlCheck.normalizedUrl;
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
  });

  // 5B. Create a real signed WordPress Live Payment checkout session (NEVER fakes payment completion)
  app.post('/api/payments/wordpress/create-session', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const cfg = loadVerifiedFirebaseConfig();
      const caller = await verifyCallerFirebaseToken(req, cfg);
      if (!caller) {
        return res.status(401).json({ ok: false, errorCode: 'unauthorized', message: 'Sign in required to initiate checkout.' });
      }

      const saved = await readPublicWordPressSettings(cfg);
      const webhookSecret = String(process.env.WORDPRESS_WEBHOOK_SECRET || '').trim();
      const urlCheck = isSafeExternalHttpsWordPressUrl(saved.siteUrl);

      if (!saved.enabledInSettings || !urlCheck.valid || webhookSecret.length < 16) {
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
      const createUrl = `${urlCheck.normalizedUrl}${saved.bridgeEndpoint.replace(/\/+$/, '')}/create-checkout`;
      const wpRes = await fetch(createUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Bexora-Signature': signature,
        },
        body: payloadStr,
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
      const redirectCheck = isSafeExternalHttpsWordPressUrl(String(wpJson.redirectUrl || ''));
      if (!redirectCheck.valid) {
        return res.status(502).json({
          ok: false,
          errorCode: 'invalid_redirect_url',
          message: 'WordPress gateway returned an invalid HTTPS redirect URL. No payment was initiated.',
        });
      }

      return res.json({
        ok: true,
        sessionId,
        redirectUrl: redirectCheck.normalizedUrl,
      });
    } catch {
      return res.status(502).json({
        ok: false,
        errorCode: 'bridge_error',
        message: 'Unexpected error communicating with WordPress payment gateway. No charge was made.',
      });
    }
  });

  // 5C. Verify WordPress payment session on return (STRICT: never marks paid without verified WordPress signature)
  app.get('/api/payments/wordpress/verify-session', async (req, res) => {
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
      const urlCheck = isSafeExternalHttpsWordPressUrl(saved.siteUrl);
      if (!saved.enabledInSettings || !urlCheck.valid || webhookSecret.length < 16) {
        return res.json({
          ok: false,
          paid: false,
          status: 'unconfigured',
          message: 'WordPress payment verification is not active on this server. Order remains unpaid.',
        });
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const verifyUrl = `${urlCheck.normalizedUrl}${saved.bridgeEndpoint.replace(/\/+$/, '')}/session-status?sessionId=${encodeURIComponent(
        sessionId
      )}`;
      const wpRes = await fetch(verifyUrl, {
        headers: {
          Accept: 'application/json',
          'X-Bexora-Signature': signWordPressPayload(webhookSecret, `VERIFY:${sessionId}`),
        },
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
  });

  // 5D. Cryptographically verified WordPress Payment Webhook (Raw-Body HMAC-SHA256 + Timestamp Skew + Replay Guard)
  app.post('/api/payments/wordpress/webhook', async (req, res) => {
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
      return res.status(verification.status).json({
        ok: false,
        error: verification.reason || 'Webhook verification failed.',
      });
    }

    if (payload.paymentStatus !== 'paid') {
      return res.json({ ok: true, acknowledged: true, action: 'ignored_non_paid_event' });
    }
    return res.json({ ok: true, acknowledged: true, action: 'verified_paid_webhook_received' });
  });

  const httpServer = http.createServer(app);
  const isProd = process.env.NODE_ENV === 'production' && fs.existsSync(path.join(__dirname, 'dist', 'index.html'));
  if (isProd) {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
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
