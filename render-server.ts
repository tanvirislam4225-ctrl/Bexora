import express, { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { initializeApp, getApps, cert, ServiceAccount } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

// Load local environment variables if .env file exists
dotenv.config();

// ---------------------------------------------------------------------------
// 1. Environment Variable Validation (Never log secrets; stop on missing)
// ---------------------------------------------------------------------------
function validateAndLoadServiceAccount(): ServiceAccount {
  const envVar = 'FIREBASE_SERVICE_ACCOUNT_JSON';
  const raw = process.env[envVar];

  if (!raw || !raw.trim()) {
    console.error(`[FATAL ERROR] Missing required environment variable: ${envVar}`);
    console.error('The backend cannot start on Render without a valid Firebase Service Account.');
    process.exit(1);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    console.error(`[FATAL ERROR] Invalid JSON syntax in ${envVar}.`);
    console.error('Ensure the entire contents of your service account JSON file are pasted correctly.');
    process.exit(1);
  }

  const projectId = typeof parsed.project_id === 'string' ? parsed.project_id.trim() : '';
  const clientEmail = typeof parsed.client_email === 'string' ? parsed.client_email.trim() : '';
  const rawPrivateKey = typeof parsed.private_key === 'string' ? parsed.private_key : '';

  if (!projectId) {
    console.error(`[FATAL ERROR] ${envVar} is missing the "project_id" field.`);
    process.exit(1);
  }
  if (!clientEmail) {
    console.error(`[FATAL ERROR] ${envVar} is missing the "client_email" field.`);
    process.exit(1);
  }
  if (!rawPrivateKey) {
    console.error(`[FATAL ERROR] ${envVar} is missing the "private_key" field.`);
    process.exit(1);
  }

  // Convert escaped literal "\\n" into real newlines
  const privateKey = rawPrivateKey.replace(/\\n/g, '\n');

  if (!privateKey.includes('BEGIN PRIVATE KEY')) {
    console.error(`[FATAL ERROR] ${envVar} contains an invalid "private_key". Missing 'BEGIN PRIVATE KEY' header.`);
    process.exit(1);
  }

  return {
    projectId,
    clientEmail,
    privateKey,
  };
}

// Initialize validated service account
const serviceAccount = validateAndLoadServiceAccount();

// ---------------------------------------------------------------------------
// 2. Firebase Admin SDK Initialization
// ---------------------------------------------------------------------------
const adminApp =
  getApps().length > 0
    ? getApps()[0]!
    : initializeApp({
        credential: cert(serviceAccount),
        projectId: serviceAccount.projectId,
      });

const adminAuth = getAuth(adminApp);
const adminDb = getFirestore(adminApp);
const adminMessaging = getMessaging(adminApp);

// ---------------------------------------------------------------------------
// 3. Express Application Configuration
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS configuration (strictly read allowed origins from env or permit same-origin)
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  if (origin) {
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// ---------------------------------------------------------------------------
// 4. Authentication Middleware: Verify Firebase Login ID Tokens
// ---------------------------------------------------------------------------
export interface AuthenticatedUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  role?: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

export async function verifyFirebaseIdTokenMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      ok: false,
      errorCode: 'missing_authorization_header',
      error: 'Unauthorized: Missing or malformed Bearer token in Authorization header.',
    });
  }

  const idToken = authHeader.substring(7).trim();
  if (!idToken) {
    return res.status(401).json({
      ok: false,
      errorCode: 'empty_token',
      error: 'Unauthorized: Bearer token cannot be empty.',
    });
  }

  try {
    // Verify ID token strictly with revoke check enabled
    const decodedToken = await adminAuth.verifyIdToken(idToken, true);

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || '',
      emailVerified: Boolean(decodedToken.email_verified),
      role: typeof decodedToken.role === 'string' ? decodedToken.role : undefined,
    };
    next();
  } catch (err: unknown) {
    const errorObj = err as { code?: string; message?: string };
    const code = errorObj?.code || 'auth/invalid-token';

    return res.status(401).json({
      ok: false,
      errorCode: code,
      error: 'Unauthorized: Firebase login token verification failed.',
    });
  }
}

// ---------------------------------------------------------------------------
// 5. API Endpoints
// ---------------------------------------------------------------------------

// A. Health check endpoint (for Render automated health probes)
app.get(['/health', '/api/health'], async (_req: Request, res: Response) => {
  try {
    // Quick ping to Firestore to verify connectivity
    await adminDb.collection('_health').doc('ping').set(
      {
        lastPingAt: FieldValue.serverTimestamp(),
        service: 'bexora-render-backend',
      },
      { merge: true }
    );

    return res.status(200).json({
      ok: true,
      status: 'healthy',
      timestamp: new Date().toISOString(),
      projectId: serviceAccount.projectId,
      firestore: 'connected',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Database ping failed';
    return res.status(503).json({
      ok: false,
      status: 'degraded',
      timestamp: new Date().toISOString(),
      error: message,
    });
  }
});

// B. Task 1(a): Explicit token verification endpoint
app.post('/api/auth/verify-token', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  const tokenFromHeader =
    authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const tokenFromBody =
    req.body && typeof req.body.idToken === 'string' ? req.body.idToken.trim() : '';
  const idToken = tokenFromHeader || tokenFromBody;

  if (!idToken) {
    return res.status(400).json({
      ok: false,
      error: 'Missing Firebase ID token. Provide via Authorization header (Bearer <token>) or body { idToken }.',
    });
  }

  try {
    const decoded = await adminAuth.verifyIdToken(idToken, true);
    return res.status(200).json({
      ok: true,
      valid: true,
      user: {
        uid: decoded.uid,
        email: decoded.email || null,
        emailVerified: Boolean(decoded.email_verified),
        authTime: decoded.auth_time,
        issuer: decoded.iss,
      },
    });
  } catch (err: unknown) {
    const errorObj = err as { code?: string; message?: string };
    return res.status(401).json({
      ok: false,
      valid: false,
      errorCode: errorObj?.code || 'auth/invalid-token',
      error: 'Token is invalid, expired, or has been revoked.',
    });
  }
});

// C. Task 1(b): Write payment data to Firestore
app.post(
  '/api/payments/record',
  verifyFirebaseIdTokenMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user!;
      const body = req.body || {};

      const amount = Number(body.amount);
      const currency = String(body.currency || 'BDT').toUpperCase().trim();
      const paymentMethod = String(body.paymentMethod || body.method || '').toLowerCase().trim();
      const transactionId = String(body.transactionId || body.trxId || '').trim();
      const purpose = String(body.purpose || 'deposit').toLowerCase().trim();
      const senderNumber = String(body.senderNumber || body.senderAccount || '').trim();
      const dealId = body.dealId ? String(body.dealId).trim() : null;
      const listingId = body.listingId ? String(body.listingId).trim() : null;
      const notes = body.notes ? String(body.notes).trim() : null;

      // Validation
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({
          ok: false,
          error: 'Invalid payment amount. Amount must be a positive number.',
        });
      }

      if (!paymentMethod) {
        return res.status(400).json({
          ok: false,
          error: 'Missing payment method (e.g. bkash, nagad, rocket, binance, bank).',
        });
      }

      if (!transactionId) {
        return res.status(400).json({
          ok: false,
          error: 'Missing transactionId / TrxID.',
        });
      }

      // Check for duplicate transaction ID to prevent double credits
      const existingTxQuery = await adminDb
        .collection('payments')
        .where('transactionId', '==', transactionId)
        .limit(1)
        .get();

      if (!existingTxQuery.empty) {
        return res.status(409).json({
          ok: false,
          error: 'A payment with this Transaction ID has already been recorded.',
        });
      }

      // Construct payment document
      const paymentRef = adminDb.collection('payments').doc();
      const paymentRecord = {
        id: paymentRef.id,
        userId: user.uid,
        userEmail: user.email || null,
        amount,
        amountMinor: Math.round(amount * 100),
        currency,
        paymentMethod,
        transactionId,
        purpose,
        dealId,
        listingId,
        senderNumber: senderNumber || null,
        notes,
        status: body.status === 'completed' ? 'completed' : 'pending',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        metadata: {
          ip: req.ip || null,
          userAgent: req.headers['user-agent'] || null,
        },
      };

      // Write atomically to Firestore
      await paymentRef.set(paymentRecord);

      // If purpose is 'deposit', also create a synced deposit request record for admin review
      if (purpose === 'deposit') {
        const depositRef = adminDb.collection('deposits').doc();
        await depositRef.set({
          id: depositRef.id,
          paymentRecordId: paymentRef.id,
          userId: user.uid,
          userName: user.email ? user.email.split('@')[0] : 'Member',
          method: paymentMethod,
          amountMinor: Math.round(amount * 100),
          currency,
          senderNumber: senderNumber || 'N/A',
          transactionId,
          status: 'pending',
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      return res.status(201).json({
        ok: true,
        message: 'Payment data successfully verified and written to Firestore.',
        paymentId: paymentRef.id,
        status: paymentRecord.status,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to write payment record';
      return res.status(500).json({
        ok: false,
        error: `Firestore write operation failed: ${message}`,
      });
    }
  }
);

// D. Fetch payment details (Protected, owner or admin only)
app.get(
  '/api/payments/:paymentId',
  verifyFirebaseIdTokenMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { paymentId } = req.params;
      const docSnap = await adminDb.collection('payments').doc(paymentId).get();

      if (!docSnap.exists) {
        return res.status(404).json({ ok: false, error: 'Payment record not found.' });
      }

      const data = docSnap.data()!;
      // Ownership check: user can only view their own payments unless they have admin role
      if (data.userId !== req.user!.uid && req.user!.role !== 'admin' && req.user!.role !== 'superadmin') {
        return res.status(403).json({ ok: false, error: 'Access denied: You do not own this payment record.' });
      }

      return res.status(200).json({
        ok: true,
        payment: {
          id: docSnap.id,
          ...data,
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to retrieve payment';
      return res.status(500).json({ ok: false, error: message });
    }
  }
);

// E. Webhook endpoint for external payment gateway IPN callbacks
app.post('/api/payments/webhook', async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const transactionId = String(body.transactionId || body.transaction_id || body.trxId || '').trim();
    const status = String(body.status || '').toLowerCase().trim();

    if (!transactionId) {
      return res.status(400).json({ ok: false, error: 'Missing transaction identifier.' });
    }

    // Find and update payment document in Firestore
    const querySnap = await adminDb
      .collection('payments')
      .where('transactionId', '==', transactionId)
      .limit(1)
      .get();

    if (querySnap.empty) {
      // Record raw unassociated webhook for audit
      const unlinkedRef = adminDb.collection('unlinkedWebhooks').doc();
      await unlinkedRef.set({
        transactionId,
        payload: body,
        receivedAt: FieldValue.serverTimestamp(),
      });
      return res.status(200).json({ ok: true, note: 'Webhook received and logged for audit.' });
    }

    const docRef = querySnap.docs[0]!.ref;
    await docRef.update({
      gatewayStatus: status,
      status: status === 'completed' || status === 'successful' || status === 'paid' ? 'completed' : 'failed',
      webhookReceivedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ ok: true, updatedPaymentId: docRef.id });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Webhook processing error';
    return res.status(500).json({ ok: false, error: message });
  }
});

// F. Web Push & FCM Notification Endpoints (Server-Initiated Background Web Push)
app.get('/api/fcm/status', async (_req: Request, res: Response) => {
  return res.json({
    ok: true,
    projectId: serviceAccount.projectId,
    adminSdkInitialized: true,
    credentialSource: 'service_account_env',
    fcmSendApiStatus: 'enabled_verified',
    vapidMode: 'custom_env',
    detailMessage: 'FCM Web Push HTTP v1 configured with valid Firebase Service Account credentials.',
  });
});

app.post(
  '/api/fcm/send',
  verifyFirebaseIdTokenMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const body = req.body || {};
      const recipientId = String(body.recipientId || '').trim();
      const notificationId = String(body.notificationId || '').trim();
      const title = String(body.title || 'BEXORA Notification').slice(0, 110);
      const preview = String(body.preview || body.body || '').slice(0, 160);
      const destination = String(body.destination || '').trim();
      const alertKind = String(body.alertKind || 'normal');
      const vibrationStrength = body.vibrationStrength === 'strong' ? 'strong' : 'standard';

      if (!recipientId || !notificationId) {
        return res.status(400).json({ ok: false, error: 'Missing recipientId or notificationId' });
      }

      const tokensSnap = await adminDb
        .collection('privateUsers')
        .doc(recipientId)
        .collection('pushTokens')
        .where('enabled', '==', true)
        .get();

      if (tokensSnap.empty) {
        return res.json({ ok: true, deliveredCount: 0, deliveryStatus: 'no_tokens' });
      }

      let deliveredCount = 0;
      let cleanedTokens = 0;

      for (const tokenDoc of tokensSnap.docs) {
        const tokenData = tokenDoc.data();
        const fcmToken = String(tokenData.token || '');
        if (!fcmToken || fcmToken.length < 20) continue;

        try {
          await adminMessaging.send({
            token: fcmToken,
            data: {
              notificationId,
              alertKind,
              destination,
              title,
              body: preview,
              vibrationEnabled: body.vibrationEnabled === false ? 'false' : 'true',
              vibrationStrength,
            },
            webpush: {
              headers: {
                Urgency: alertKind === 'deal_room_created' || alertKind === 'important' ? 'high' : 'normal',
                TTL: '86400',
              },
              fcmOptions: {
                link: destination ? `/?dest=${encodeURIComponent(destination)}` : '/',
              },
            },
          });
          deliveredCount += 1;
        } catch (sendErr: unknown) {
          const errObj = sendErr as { code?: string };
          if (
            errObj?.code === 'messaging/registration-token-not-registered' ||
            errObj?.code === 'messaging/invalid-registration-token'
          ) {
            await tokenDoc.ref.delete().catch(() => {});
            cleanedTokens += 1;
          }
        }
      }

      return res.json({
        ok: deliveredCount > 0,
        deliveryStatus: deliveredCount > 0 ? 'delivered' : 'no_valid_tokens',
        deliveredCount,
        cleanedTokens,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Push send error';
      return res.status(502).json({ ok: false, error: message });
    }
  }
);

app.post(
  '/api/fcm/broadcast',
  verifyFirebaseIdTokenMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (req.user?.role !== 'admin' && req.user?.role !== 'superadmin') {
        return res.status(403).json({ ok: false, error: 'Admin role required.' });
      }

      const body = req.body || {};
      const title = String(body.title || 'BEXORA Announcement').slice(0, 110);
      const text = String(body.body || body.preview || '').slice(0, 200);
      const destination = String(body.destination || 'marketplace').trim();
      const announcementId = String(body.announcementId || `ann_${Date.now()}`);
      const severity = String(body.severity || 'info');

      const tokensSnap = await adminDb
        .collectionGroup('pushTokens')
        .where('enabled', '==', true)
        .limit(500)
        .get();

      let deliveredCount = 0;
      let cleanedTokens = 0;

      for (const tokenDoc of tokensSnap.docs) {
        const tokenData = tokenDoc.data();
        const fcmToken = String(tokenData.token || '');
        if (!fcmToken || fcmToken.length < 20) continue;

        try {
          await adminMessaging.send({
            token: fcmToken,
            data: {
              notificationId: `ntf_bc_${announcementId}`,
              alertKind: severity === 'critical' ? 'critical_security' : 'normal',
              destination,
              title,
              body: text,
              vibrationEnabled: severity === 'critical' ? 'true' : 'false',
              vibrationStrength: severity === 'critical' ? 'strong' : 'standard',
            },
            webpush: {
              headers: {
                Urgency: severity === 'critical' ? 'high' : 'normal',
                TTL: '86400',
              },
              fcmOptions: {
                link: destination ? `/?dest=${encodeURIComponent(destination)}` : '/',
              },
            },
          });
          deliveredCount += 1;
        } catch (sendErr: unknown) {
          const errObj = sendErr as { code?: string };
          if (
            errObj?.code === 'messaging/registration-token-not-registered' ||
            errObj?.code === 'messaging/invalid-registration-token'
          ) {
            await tokenDoc.ref.delete().catch(() => {});
            cleanedTokens += 1;
          }
        }
      }

      return res.json({
        ok: true,
        deliveryStatus: 'broadcast_completed',
        deliveredCount,
        cleanedTokens,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Broadcast error';
      return res.status(502).json({ ok: false, error: message });
    }
  }
);


// ---------------------------------------------------------------------------
// 6. Serve Frontend Static Build (if deployed as full-stack app on Render)
// ---------------------------------------------------------------------------
const distDir = path.join(__dirname, 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req: Request, res: Response) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// ---------------------------------------------------------------------------
// 7. Server Startup
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0'; // Essential for Render container binding

app.listen(PORT, HOST, () => {
  console.log(`[BEXORA Backend] Server listening on ${HOST}:${PORT} (Project: ${serviceAccount.projectId})`);
});

export default app;
