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
import { getMessaging as getAdminMessaging } from 'firebase-admin/messaging';

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

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '6mb' }));

  // 1. Health & Runtime Capabilities Endpoint
  app.get('/api/health', (_req, res) => {
    const aiConfigured = Boolean(getGeminiClient());
    res.json({
      status: 'ok',
      service: 'bexora-backend',
      timestamp: new Date().toISOString(),
      aiVerificationConfigured: aiConfigured,
      manualPaymentEnv: {
        bkash: Boolean(process.env.BKASH_PAYMENT_NUMBER?.trim()),
        nagad: Boolean(process.env.NAGAD_PAYMENT_NUMBER?.trim()),
        rocket: Boolean(process.env.ROCKET_PAYMENT_NUMBER?.trim()),
      },
      liveGatewaysEnabled: false,
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

  app.post('/api/auth/enable-token-service', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const cfg = loadVerifiedFirebaseConfig();
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

  // 2C. Server-Side Firebase Cloud Messaging (VAPID, FCM Registration API & FCM HTTP v1 Delivery)
  const BOOTSTRAPPED_SUPERADMIN_UID = 'FFiOzaXKxBMuCzoQXM68sy3aPax2';
  const BOOTSTRAPPED_SUPERADMIN_EMAIL = 'tanvirislam7574@gmail.com';

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

  let cachedSaToken: { token: string; expiresAtMs: number } | null = null;

  async function resolveServerCloudAccessToken(): Promise<string | null> {
    const rawSaJson = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
    if (rawSaJson) {
      if (cachedSaToken && Date.now() < cachedSaToken.expiresAtMs - 60_000) {
        return cachedSaToken.token;
      }
      try {
        const sa = JSON.parse(rawSaJson) as {
          client_email?: string;
          private_key?: string;
          token_uri?: string;
        };
        if (sa.client_email && sa.private_key) {
          const nowSec = Math.floor(Date.now() / 1000);
          const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
          const headerB64 = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
          const claimB64 = Buffer.from(
            JSON.stringify({
              iss: sa.client_email,
              scope: 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/datastore',
              aud: tokenUri,
              iat: nowSec,
              exp: nowSec + 3600,
            })
          ).toString('base64url');
          const unsignedJwt = `${headerB64}.${claimB64}`;
          const signer = crypto.createSign('RSA-SHA256');
          signer.update(unsignedJwt);
          signer.end();
          const sigB64 = signer.sign(sa.private_key).toString('base64url');
          const assertion = `${unsignedJwt}.${sigB64}`;

          const tokenResp = await fetch(tokenUri, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
              assertion,
            }).toString(),
          });
          if (tokenResp.ok) {
            const json = (await tokenResp.json()) as { access_token?: string; expires_in?: number };
            if (json.access_token) {
              cachedSaToken = {
                token: json.access_token,
                expiresAtMs: Date.now() + (Number(json.expires_in) || 3500) * 1000,
              };
              return json.access_token;
            }
          }
        }
      } catch {
        // Fall through to metadata ADC token
      }
    }
    return fetchSandboxMetadataAccessToken();
  }

  function getOrInitFirebaseAdminApp(projectId: string): AdminApp {
    const appName = `bexora-fcm-${projectId}`;
    const existingApp = getApps().find((a) => a.name === appName);
    if (existingApp) return existingApp;

    const rawSaJson = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
    if (rawSaJson) {
      try {
        const parsed = JSON.parse(rawSaJson) as ServiceAccount & {
          client_email?: string;
          private_key?: string;
        };
        if (parsed.client_email && parsed.private_key) {
          return initializeAdminApp(
            {
              credential: cert(parsed),
              projectId,
            },
            appName
          );
        }
      } catch {
        // Fall through to Application Default Credentials
      }
    }

    return initializeAdminApp(
      {
        credential: applicationDefault(),
        projectId,
      },
      appName
    );
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
      const rawVapid = (process.env.VITE_FIREBASE_VAPID_KEY || '').trim();
      const envVapidConfigured = Boolean(
        rawVapid &&
          rawVapid !== 'YOUR_FIREBASE_VAPID_KEY' &&
          rawVapid !== 'MY_FIREBASE_VAPID_KEY' &&
          rawVapid !== 'PASTE_YOUR_VAPID_KEY_HERE'
      );
      const envVapidValid = isValidServerVapidPublicKey(rawVapid);

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
          ? `Firebase Console "Generate key pair" fails with "An unknown server error occurred." because FCM Registration API (fcmregistrations.googleapis.com) is currently DISABLED on project ${cfg.projectId} (${cfg.projectNumber}), and the signed-in account must hold Service Usage Admin (serviceusage.services.enable) + Firebase Admin (roles/firebase.admin) on ${cfg.projectId} to provision Web Push certificates.`
          : `FCM APIs (fcm.googleapis.com, fcmregistrations.googleapis.com, firebaseinstallations.googleapis.com) are enabled on ${cfg.projectId}. If "Generate key pair" fails in Firebase Console, ensure your Google account holds roles/firebase.admin (or Editor/Owner) on ${cfg.projectId}.`;

      let detailMessage = 'Firebase Cloud Messaging is fully configured and verified.';
      if (fcmRegistrationsApiStatus === 'disabled') {
        detailMessage = `FCM Registration API (fcmregistrations.googleapis.com) is disabled in project ${cfg.projectId}. Enable it in Google Cloud Console first so Firebase Console can generate the Web Push VAPID key pair and browsers can register tokens.`;
      } else if (!envVapidValid) {
        detailMessage =
          'Web Push VAPID public key (VITE_FIREBASE_VAPID_KEY) is not set yet. Generate or copy the public key in Firebase Console > Project Settings > Cloud Messaging.';
      } else if (fcmSendApiStatus === 'permission_denied') {
        detailMessage = `Server runtime (${sandboxServiceAccountEmail || 'ADC'}) lacks roles/firebasecloudmessaging.admin on project ${cfg.projectId} to dispatch closed-tab background pushes.`;
      }

      return res.json({
        ok: envVapidValid && fcmRegistrationsApiStatus === 'enabled_verified' && fcmSendApiStatus === 'enabled_verified',
        projectId: cfg.projectId,
        projectNumber: cfg.projectNumber,
        appId: cfg.appId,
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
        envVapidConfigured: false,
        envVapidValid: false,
        fcmV1ApiStatus: 'unable_to_verify',
        fcmRegistrationsApiStatus: 'unable_to_verify',
        firebaseInstallationsApiStatus: 'unable_to_verify',
        fcmSendApiStatus: 'unable_to_verify',
        sandboxServiceAccountEmail: '',
        requiredRoles: ['roles/firebasecloudmessaging.admin'],
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

      // 1. Verify caller Firebase ID Token against Identity Toolkit for project responsive-dragon-tmn89
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
      if (!callerUid) {
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

      const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
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

  // 3. Server-Side AI Monetization Evidence Verification Pipeline
  app.post('/api/ai/verify-evidence', async (req, res) => {
    try {
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

  // 4. Server-Side AI Developer Chat (Admin Panel Only)
  app.post('/api/ai/developer-chat', async (req, res) => {
    try {
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
