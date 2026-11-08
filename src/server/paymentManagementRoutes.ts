import type express from 'express';
import type { App as AdminApp } from 'firebase-admin/app';
import { FieldValue, getFirestore as getAdminFirestore } from 'firebase-admin/firestore';
import { SlidingWindowRateLimiter, recordSecurityEvent } from '../lib/serverSecurity';
import {
  calculateExactBdtSerial,
  matchExactPaymentLink,
  validateLivePaymentLinkInput,
  getDefaultManualPaymentMethods,
  EXACT_LINK_UNAVAILABLE_MESSAGE,
  ManualPaymentMethod,
  LivePaymentLink,
  ManualPaymentRequest,
} from '../lib/paymentManagementLogic';
import {
  DEFAULT_WITHDRAWAL_METHODS,
  DEFAULT_MANUAL_PAYMENT_METHODS,
  WithdrawalMethodSetting,
  ManualPaymentMethodSetting,
} from '../lib/countryCurrencyCatalog';
import { finalizeDealEscrowPaymentInFirestore } from './securePayGatewayEngine';
import type { CurrencyCode, DealRecord } from '../types';

export interface VerifiedFirebaseRuntimeConfig {
  configValid: boolean;
  projectId: string;
  projectNumber: string;
  apiKey: string;
  firestoreDatabaseId: string;
  storageBucket?: string;
}

export interface VerifiedCaller {
  uid: string;
  email: string;
  emailVerified: boolean;
  idToken: string;
}

export interface VerifiedAdminCaller {
  uid: string;
  email: string;
  role: 'admin' | 'superadmin';
  idToken: string;
}

interface PaymentManagementDeps<
  TCfg extends VerifiedFirebaseRuntimeConfig = VerifiedFirebaseRuntimeConfig
> {
  app: express.Express;
  loadVerifiedFirebaseConfig: () => TCfg;
  getOrInitFirebaseAdminApp: (projectId: string) => AdminApp;
  verifyCallerFirebaseToken: (
    req: express.Request,
    cfg: TCfg
  ) => Promise<VerifiedCaller | null>;
  verifyAdminCaller: (
    req: express.Request,
    cfg: TCfg
  ) => Promise<VerifiedAdminCaller | null>;
  getCallerClientKey: (req: express.Request) => string;
}

export function registerPaymentManagementRoutes<
  TCfg extends VerifiedFirebaseRuntimeConfig = VerifiedFirebaseRuntimeConfig
>(deps: PaymentManagementDeps<TCfg>): void {
  const {
    app,
    loadVerifiedFirebaseConfig,
    getOrInitFirebaseAdminApp,
    verifyCallerFirebaseToken,
    verifyAdminCaller,
    getCallerClientKey,
  } = deps;

  const paymentRateLimiter = new SlidingWindowRateLimiter(60, 60000);

  function getFirestoreInstance() {
    const cfg = loadVerifiedFirebaseConfig();
    const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
    return getAdminFirestore(adminApp);
  }

  // -------------------------------------------------------------
  // 1. PUBLIC PAYMENT CONFIGURATION & ACTIVE MANUAL METHODS
  // -------------------------------------------------------------
  app.get('/api/payments/public-config', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const db = getFirestoreInstance();
      const settingsSnap = await db.collection('publicConfig').doc('settings').get();
      const settingsData = settingsSnap.data() || {};

      const usdtToBdtRate = typeof settingsData.usdtToBdtRate === 'number' && settingsData.usdtToBdtRate > 0
        ? settingsData.usdtToBdtRate
        : 125;
      const livePaymentLinksEnabled = settingsData.livePaymentLinksEnabled !== false;
      const manualPaymentEnabled = settingsData.manualPaymentEnabled !== false;

      const withdrawalMethods = Array.isArray(settingsData.withdrawalMethods)
        ? settingsData.withdrawalMethods
        : DEFAULT_WITHDRAWAL_METHODS;
      const manualPaymentConfig = Array.isArray(settingsData.manualPaymentConfig)
        ? settingsData.manualPaymentConfig
        : DEFAULT_MANUAL_PAYMENT_METHODS;
      const countryRates = settingsData.countryRates || { BD: usdtToBdtRate, US: 1, IN: 86.5, GB: 0.78, AE: 3.67, SA: 3.75, EU: 0.92 };
      const activeCountryCode = settingsData.activeCountryCode || 'BD';

      // Fetch active manual payment methods
      const manualMethodsSnap = await db
        .collection('manualPaymentMethods')
        .where('enabled', '==', true)
        .get();

      let activeMethods: ManualPaymentMethod[] = [];
      if (!manualMethodsSnap.empty) {
        activeMethods = manualMethodsSnap.docs
          .map((d) => d.data() as ManualPaymentMethod)
          .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
      } else {
        // Fallback default methods
        activeMethods = getDefaultManualPaymentMethods().filter((m) => m.enabled);
      }

      return res.json({
        ok: true,
        usdtToBdtRate,
        usdToBdtRate: usdtToBdtRate,
        livePaymentLinksEnabled,
        manualPaymentEnabled,
        withdrawalMethods,
        manualPaymentConfig,
        countryRates,
        activeCountryCode,
        activeManualMethods: activeMethods,
      });
    } catch (err: unknown) {
      return res.json({
        ok: true,
        usdtToBdtRate: 125,
        usdToBdtRate: 125,
        livePaymentLinksEnabled: true,
        manualPaymentEnabled: true,
        withdrawalMethods: DEFAULT_WITHDRAWAL_METHODS,
        manualPaymentConfig: DEFAULT_MANUAL_PAYMENT_METHODS,
        countryRates: { BD: 125, US: 1, IN: 86.5, GB: 0.78, AE: 3.67, SA: 3.75, EU: 0.92 },
        activeCountryCode: 'BD',
        activeManualMethods: getDefaultManualPaymentMethods(),
      });
    }
  });

  // -------------------------------------------------------------
  // 2. ADMIN: MANUAL PAYMENT METHODS MANAGEMENT
  // -------------------------------------------------------------
  app.get('/api/admin/payments/manual-methods', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const admin = await verifyAdminCaller(req, cfg);
    if (!admin) {
      return res.status(403).json({ ok: false, error: 'Administrator authentication required.' });
    }

    try {
      const db = getFirestoreInstance();
      const snap = await db.collection('manualPaymentMethods').get();

      if (snap.empty) {
        // Seed default methods into Firestore
        const defaults = getDefaultManualPaymentMethods();
        const batch = db.batch();
        for (const method of defaults) {
          batch.set(db.collection('manualPaymentMethods').doc(method.id), method);
        }
        await batch.commit();
        return res.json({ ok: true, methods: defaults });
      }

      const methods = snap.docs
        .map((d) => d.data() as ManualPaymentMethod)
        .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));

      return res.json({ ok: true, methods });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to retrieve manual payment methods.';
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  app.post('/api/admin/payments/manual-methods', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const admin = await verifyAdminCaller(req, cfg);
    if (!admin) {
      return res.status(403).json({ ok: false, error: 'Administrator authentication required.' });
    }

    const { name, type, accountNumber, accountHolder, instructions, logoUrl, enabled, displayOrder } = req.body || {};
    if (!name || typeof name !== 'string' || !accountNumber || typeof accountNumber !== 'string') {
      return res.status(400).json({ ok: false, error: 'Method name and account number are required.' });
    }

    try {
      const db = getFirestoreInstance();
      const methodId = `method_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const now = Date.now();

      const newMethod: ManualPaymentMethod = {
        id: methodId,
        name: name.trim(),
        type: ['bkash', 'nagad', 'rocket', 'binance', 'bank', 'custom'].includes(type) ? type : 'custom',
        accountNumber: accountNumber.trim(),
        accountHolder: typeof accountHolder === 'string' ? accountHolder.trim() : '',
        instructions: typeof instructions === 'string' ? instructions.trim() : '',
        logoUrl: typeof logoUrl === 'string' ? logoUrl.trim() : '',
        enabled: enabled !== false,
        displayOrder: typeof displayOrder === 'number' ? displayOrder : 10,
        createdAtMs: now,
        updatedAtMs: now,
      };

      await db.collection('manualPaymentMethods').doc(methodId).set(newMethod);
      return res.json({ ok: true, method: newMethod });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save manual payment method.';
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  app.put('/api/admin/payments/manual-methods/:id', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const admin = await verifyAdminCaller(req, cfg);
    if (!admin) {
      return res.status(403).json({ ok: false, error: 'Administrator authentication required.' });
    }

    const { id } = req.params;
    const { name, type, accountNumber, accountHolder, instructions, logoUrl, enabled, displayOrder } = req.body || {};

    try {
      const db = getFirestoreInstance();
      const docRef = db.collection('manualPaymentMethods').doc(id);
      const docSnap = await docRef.get();
      if (!docSnap.exists) {
        return res.status(404).json({ ok: false, error: 'Manual payment method not found.' });
      }

      const updates: Partial<ManualPaymentMethod> = {
        updatedAtMs: Date.now(),
      };
      if (typeof name === 'string') updates.name = name.trim();
      if (typeof type === 'string' && ['bkash', 'nagad', 'rocket', 'binance', 'bank', 'custom'].includes(type)) {
        updates.type = type as ManualPaymentMethod['type'];
      }
      if (typeof accountNumber === 'string') updates.accountNumber = accountNumber.trim();
      if (typeof accountHolder === 'string') updates.accountHolder = accountHolder.trim();
      if (typeof instructions === 'string') updates.instructions = instructions.trim();
      if (typeof logoUrl === 'string') updates.logoUrl = logoUrl.trim();
      if (typeof enabled === 'boolean') updates.enabled = enabled;
      if (typeof displayOrder === 'number') updates.displayOrder = displayOrder;

      await docRef.update(updates);
      const updated = { ...(docSnap.data() as ManualPaymentMethod), ...updates };
      return res.json({ ok: true, method: updated });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to update manual payment method.';
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  app.delete('/api/admin/payments/manual-methods/:id', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const admin = await verifyAdminCaller(req, cfg);
    if (!admin) {
      return res.status(403).json({ ok: false, error: 'Administrator authentication required.' });
    }

    const { id } = req.params;
    try {
      const db = getFirestoreInstance();
      await db.collection('manualPaymentMethods').doc(id).delete();
      return res.json({ ok: true, deletedId: id });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to delete manual payment method.';
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  // -------------------------------------------------------------
  // 3. ADMIN: LIVE PAYMENT LINKS (LARGE-SCALE PAGINATION & SEARCH)
  // -------------------------------------------------------------
  app.get('/api/admin/payments/live-links', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const admin = await verifyAdminCaller(req, cfg);
    if (!admin) {
      return res.status(403).json({ ok: false, error: 'Administrator authentication required.' });
    }

    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const pageSize = Math.min(200, Math.max(10, parseInt(String(req.query.pageSize || '50'), 10) || 50));
    const searchSerial = req.query.searchSerial ? String(req.query.searchSerial).trim() : '';
    const statusFilter = String(req.query.statusFilter || 'all').toLowerCase(); // 'all' | 'active' | 'disabled'

    try {
      const db = getFirestoreInstance();
      const col = db.collection('livePaymentLinks');

      // If searching by specific serial number
      if (searchSerial) {
        const num = parseInt(searchSerial, 10);
        if (Number.isInteger(num)) {
          const directDoc = await col.doc(`link_${num}`).get();
          if (directDoc.exists) {
            const data = directDoc.data() as LivePaymentLink;
            if (statusFilter === 'all' || (statusFilter === 'active' && data.enabled) || (statusFilter === 'disabled' && !data.enabled)) {
              return res.json({
                ok: true,
                links: [data],
                totalCount: 1,
                page: 1,
                pageSize,
                totalPages: 1,
              });
            }
          }
          return res.json({
            ok: true,
            links: [],
            totalCount: 0,
            page: 1,
            pageSize,
            totalPages: 0,
          });
        }
      }

      // Large-scale querying with indexed filters
      let query: FirebaseFirestore.Query = col;
      if (statusFilter === 'active') {
        query = query.where('enabled', '==', true);
      } else if (statusFilter === 'disabled') {
        query = query.where('enabled', '==', false);
      }

      query = query.orderBy('serialNumber', 'asc');

      // Get count and paginated slice
      const countSnap = await query.count().get();
      const totalCount = countSnap.data().count;

      const offset = (page - 1) * pageSize;
      const snap = await query.offset(offset).limit(pageSize).get();

      const links = snap.docs.map((d) => d.data() as LivePaymentLink);
      const totalPages = Math.ceil(totalCount / pageSize) || 1;

      return res.json({
        ok: true,
        links,
        totalCount,
        page,
        pageSize,
        totalPages,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to query live payment links.';
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  app.post('/api/admin/payments/live-links', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const admin = await verifyAdminCaller(req, cfg);
    if (!admin) {
      return res.status(403).json({ ok: false, error: 'Administrator authentication required.' });
    }

    const { serialNumber, paymentUrl, enabled } = req.body || {};
    const validation = validateLivePaymentLinkInput(serialNumber, paymentUrl);
    if (!validation.valid) {
      return res.status(400).json({ ok: false, error: validation.error });
    }

    try {
      const db = getFirestoreInstance();
      const docId = `link_${validation.serialNumber}`;
      const docRef = db.collection('livePaymentLinks').doc(docId);
      const existing = await docRef.get();

      const now = Date.now();
      const linkRecord: LivePaymentLink = {
        serialNumber: validation.serialNumber,
        amountBdt: validation.serialNumber, // Invariant: amountBdt == serialNumber
        paymentUrl: validation.paymentUrl,
        enabled: enabled !== false,
        usageCount: existing.exists ? (existing.data()?.usageCount || 0) : 0,
        createdAtMs: existing.exists ? (existing.data()?.createdAtMs || now) : now,
        updatedAtMs: now,
      };

      await docRef.set(linkRecord);
      return res.json({ ok: true, link: linkRecord });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save live payment link.';
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  app.put('/api/admin/payments/live-links/:serial', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const admin = await verifyAdminCaller(req, cfg);
    if (!admin) {
      return res.status(403).json({ ok: false, error: 'Administrator authentication required.' });
    }

    const serialNum = parseInt(req.params.serial, 10);
    if (!Number.isInteger(serialNum) || serialNum <= 0) {
      return res.status(400).json({ ok: false, error: 'Invalid serial number.' });
    }

    const { paymentUrl, enabled } = req.body || {};
    try {
      const db = getFirestoreInstance();
      const docRef = db.collection('livePaymentLinks').doc(`link_${serialNum}`);
      const snap = await docRef.get();
      if (!snap.exists) {
        return res.status(404).json({ ok: false, error: 'Live payment link not found.' });
      }

      const updates: Partial<LivePaymentLink> = {
        updatedAtMs: Date.now(),
      };
      if (paymentUrl !== undefined) {
        const v = validateLivePaymentLinkInput(serialNum, paymentUrl);
        if (!v.valid) return res.status(400).json({ ok: false, error: v.error });
        updates.paymentUrl = v.paymentUrl;
      }
      if (typeof enabled === 'boolean') {
        updates.enabled = enabled;
      }

      await docRef.update(updates);
      const updated = { ...(snap.data() as LivePaymentLink), ...updates };
      return res.json({ ok: true, link: updated });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to update live payment link.';
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  app.delete('/api/admin/payments/live-links/:serial', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const admin = await verifyAdminCaller(req, cfg);
    if (!admin) {
      return res.status(403).json({ ok: false, error: 'Administrator authentication required.' });
    }

    const serialNum = parseInt(req.params.serial, 10);
    if (!Number.isInteger(serialNum) || serialNum <= 0) {
      return res.status(400).json({ ok: false, error: 'Invalid serial number.' });
    }

    try {
      const db = getFirestoreInstance();
      await db.collection('livePaymentLinks').doc(`link_${serialNum}`).delete();
      return res.json({ ok: true, deletedSerial: serialNum });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to delete live payment link.';
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  // -------------------------------------------------------------
  // 4. ADMIN: PAYMENT SETTINGS (USDT RATE & TOGGLES)
  // -------------------------------------------------------------
  app.put('/api/admin/payments/settings', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const admin = await verifyAdminCaller(req, cfg);
    if (!admin) {
      return res.status(403).json({ ok: false, error: 'Administrator authentication required.' });
    }

    const {
      usdtToBdtRate,
      usdToBdtRate,
      livePaymentLinksEnabled,
      manualPaymentEnabled,
      withdrawalMethods,
      manualPaymentConfig,
      countryRates,
      activeCountryCode,
    } = req.body || {};

    const effectiveUsdtRate = typeof usdtToBdtRate === 'number' && usdtToBdtRate > 0
      ? usdtToBdtRate
      : (typeof usdToBdtRate === 'number' && usdToBdtRate > 0 ? usdToBdtRate : undefined);

    if (effectiveUsdtRate !== undefined && (!Number.isFinite(effectiveUsdtRate) || effectiveUsdtRate <= 0)) {
      return res.status(400).json({ ok: false, error: 'USDT exchange rate must be a positive number.' });
    }

    try {
      const db = getFirestoreInstance();
      const settingsRef = db.collection('publicConfig').doc('settings');
      const updates: Record<string, unknown> = {
        updatedAtMs: Date.now(),
      };
      if (effectiveUsdtRate !== undefined) {
        const roundedRate = Math.round(effectiveUsdtRate * 100) / 100;
        updates.usdtToBdtRate = roundedRate;
        updates.usdToBdtRate = roundedRate;
      }
      if (livePaymentLinksEnabled !== undefined) updates.livePaymentLinksEnabled = Boolean(livePaymentLinksEnabled);
      if (manualPaymentEnabled !== undefined) updates.manualPaymentEnabled = Boolean(manualPaymentEnabled);
      if (Array.isArray(withdrawalMethods)) updates.withdrawalMethods = withdrawalMethods;
      if (Array.isArray(manualPaymentConfig)) {
        updates.manualPaymentConfig = manualPaymentConfig;
        // Sync legacy top-level numbers for backwards compatibility
        const bkash = manualPaymentConfig.find((m: ManualPaymentMethodSetting) => m.type === 'bkash');
        const nagad = manualPaymentConfig.find((m: ManualPaymentMethodSetting) => m.type === 'nagad');
        const rocket = manualPaymentConfig.find((m: ManualPaymentMethodSetting) => m.type === 'rocket');
        if (bkash?.receivingNumber) updates.bkashNumber = bkash.receivingNumber;
        if (nagad?.receivingNumber) updates.nagadNumber = nagad.receivingNumber;
        if (rocket?.receivingNumber) updates.rocketNumber = rocket.receivingNumber;
      }
      if (countryRates && typeof countryRates === 'object') updates.countryRates = countryRates;
      if (typeof activeCountryCode === 'string') updates.activeCountryCode = activeCountryCode.trim().toUpperCase();

      await settingsRef.set(updates, { merge: true });
      return res.json({ ok: true, settings: updates });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to update payment settings.';
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  // -------------------------------------------------------------
  // 5. BUYER: EXACT LIVE PAYMENT LINK CHECKOUT LOOKUP
  // -------------------------------------------------------------
  app.post('/api/payments/checkout-link', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const caller = await verifyCallerFirebaseToken(req, cfg);
    if (!caller) {
      return res.status(401).json({ ok: false, error: 'Authentication required to checkout.' });
    }

    const { dealId, listingId } = req.body || {};
    if (!dealId || typeof dealId !== 'string') {
      return res.status(400).json({ ok: false, error: 'Deal ID is required.' });
    }

    try {
      const db = getFirestoreInstance();
      const dealSnap = await db.collection('deals').doc(dealId).get();
      if (!dealSnap.exists) {
        return res.status(404).json({ ok: false, error: 'Deal record not found.' });
      }

      const deal = dealSnap.data() as DealRecord;
      if (deal.buyerId !== caller.uid) {
        return res.status(403).json({ ok: false, error: 'Unauthorized: You are not the buyer of this deal.' });
      }

      if (deal.status !== 'accepted_pending_payment' && deal.status !== 'awaiting_payment' && deal.status !== 'payment_pending_verification') {
        return res.status(400).json({
          ok: false,
          error: 'invalid_deal_status',
          message: `Deal is currently in '${deal.status}' status and cannot accept checkout.`,
        });
      }

      // Fetch current USDT exchange rate snapshot from publicConfig
      const settingsSnap = await db.collection('publicConfig').doc('settings').get();
      const settings = settingsSnap.data() || {};
      const usdtToBdtRate = typeof settings.usdtToBdtRate === 'number' && settings.usdtToBdtRate > 0
        ? settings.usdtToBdtRate
        : 125;

      // Calculate exact integer BDT serial number
      const serialResult = calculateExactBdtSerial(deal.buyerTotalMinor, deal.currency, usdtToBdtRate);
      if (!serialResult.ok) {
        return res.status(400).json({
          ok: false,
          error: serialResult.error,
          message: serialResult.reason,
        });
      }

      // Fetch the exact link from Firestore
      const requiredSerial = serialResult.serialNumber;
      const linkSnap = await db.collection('livePaymentLinks').doc(`link_${requiredSerial}`).get();

      if (!linkSnap.exists) {
        return res.status(400).json({
          ok: false,
          error: 'exact_link_unavailable',
          message: EXACT_LINK_UNAVAILABLE_MESSAGE,
        });
      }

      const linkData = linkSnap.data() as LivePaymentLink;
      const matchResult = matchExactPaymentLink(requiredSerial, [linkData]);
      if (!matchResult.ok) {
        return res.status(400).json({
          ok: false,
          error: 'exact_link_unavailable',
          message: matchResult.reason,
        });
      }

      // Atomically increment usage count for telemetry
      void db
        .collection('livePaymentLinks')
        .doc(`link_${requiredSerial}`)
        .update({
          usageCount: FieldValue.increment(1),
          updatedAtMs: Date.now(),
        })
        .catch(() => {});

      // Record checkout snapshot with immutable exchange rate and serial
      const trackingId = `trk_${deal.id}_${Date.now()}`;
      await db.collection('livePaymentSnapshots').doc(trackingId).set({
        trackingId,
        dealId: deal.id,
        listingId: deal.listingId || listingId,
        buyerUid: caller.uid,
        serialNumber: requiredSerial,
        amountBdt: serialResult.amountBdt,
        originalAmountMinor: deal.buyerTotalMinor,
        originalCurrency: deal.currency,
        usdtToBdtRateSnapshot: usdtToBdtRate,
        paymentUrl: matchResult.link.paymentUrl,
        createdAtMs: Date.now(),
      });

      return res.json({
        ok: true,
        trackingId,
        serialNumber: requiredSerial,
        amountBdt: serialResult.amountBdt,
        usdtRate: usdtToBdtRate,
        paymentUrl: matchResult.link.paymentUrl,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to retrieve checkout payment link.';
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  // -------------------------------------------------------------
  // 6. BUYER: SUBMIT MANUAL PAYMENT PROOF (TRXID)
  // -------------------------------------------------------------
  app.post('/api/payments/manual-submit', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const caller = await verifyCallerFirebaseToken(req, cfg);
    if (!caller) {
      return res.status(401).json({ ok: false, error: 'Authentication required to submit payment proof.' });
    }

    const {
      dealId,
      listingId,
      methodId,
      submittedTrxId,
      senderNumberOrAccount,
      screenshotData,
    } = req.body || {};

    if (!dealId || !submittedTrxId || typeof submittedTrxId !== 'string') {
      return res.status(400).json({ ok: false, error: 'Deal ID and Transaction ID (TrxID) are required.' });
    }

    const cleanTrxId = submittedTrxId.trim();
    if (cleanTrxId.length < 4) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid Transaction ID (minimum 4 characters).' });
    }

    try {
      const db = getFirestoreInstance();
      const dealRef = db.collection('deals').doc(dealId);
      const dealSnap = await dealRef.get();
      if (!dealSnap.exists) {
        return res.status(404).json({ ok: false, error: 'Deal not found.' });
      }

      const deal = dealSnap.data() as DealRecord;
      if (deal.buyerId !== caller.uid) {
        return res.status(403).json({ ok: false, error: 'Unauthorized: You are not the buyer of this deal.' });
      }

      if (deal.status === 'paid_deal_room_active' || deal.status === 'paid' || deal.status === 'settled') {
        return res.status(400).json({ ok: false, error: 'This deal is already funded and active in escrow.' });
      }

      // Look up manual payment method details
      let methodName = 'Manual Transfer';
      let accountNumber = '';
      if (methodId) {
        const methodSnap = await db.collection('manualPaymentMethods').doc(methodId).get();
        if (methodSnap.exists) {
          const m = methodSnap.data() as ManualPaymentMethod;
          methodName = m.name;
          accountNumber = m.accountNumber;
        }
      }

      // Calculate BDT equivalent if currency is USD
      const settingsSnap = await db.collection('publicConfig').doc('settings').get();
      const usdtToBdtRate = settingsSnap.data()?.usdtToBdtRate || 125;
      const convertedBdt = deal.currency === 'BDT'
        ? deal.buyerTotalMinor / 100
        : Math.round((deal.buyerTotalMinor / 100) * usdtToBdtRate);

      const requestId = `manreq_${deal.id}_${Date.now()}`;
      const now = Date.now();

      const requestDoc: ManualPaymentRequest = {
        id: requestId,
        dealId: deal.id,
        listingId: deal.listingId || listingId,
        listingTitle: deal.listingTitle || 'Marketplace Asset',
        buyerUid: caller.uid,
        buyerName: deal.buyerName || caller.email,
        buyerEmail: caller.email,
        sellerUid: deal.sellerId,
        sellerName: deal.sellerName,
        methodId: methodId || 'custom',
        methodName,
        accountNumber,
        expectedAmountMinor: deal.buyerTotalMinor,
        currency: deal.currency,
        convertedAmountBdt: convertedBdt,
        submittedTrxId: cleanTrxId,
        senderNumberOrAccount: senderNumberOrAccount ? String(senderNumberOrAccount).trim() : undefined,
        screenshotData: screenshotData && typeof screenshotData === 'string' ? screenshotData.slice(0, 500000) : undefined,
        status: 'pending',
        createdAtMs: now,
        updatedAtMs: now,
      };

      // Atomic update: write request and set deal status to payment_pending_verification
      const batch = db.batch();
      batch.set(db.collection('manualPaymentRequests').doc(requestId), requestDoc);
      batch.update(dealRef, {
        status: 'payment_pending_verification',
        pendingManualPaymentRequestId: requestId,
        latestSubmittedTrxId: cleanTrxId,
        updatedAtMs: now,
      });

      // Append audit event
      const auditRef = db.collection('dealAudits').doc(`audit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
      batch.set(auditRef, {
        id: auditRef.id,
        dealId: deal.id,
        actorId: caller.uid,
        actorName: caller.email,
        actorRole: 'buyer',
        eventType: 'manual_payment_submitted',
        summary: `Buyer submitted manual payment proof via ${methodName}. TrxID: ${cleanTrxId}. Status: Awaiting Admin Verification.`,
        createdAtMs: now,
      });

      await batch.commit();

      return res.json({
        ok: true,
        requestId,
        status: 'payment_pending_verification',
        message: 'Payment proof submitted successfully. BEXORA administrators will verify your transaction shortly.',
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to submit manual payment proof.';
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  // -------------------------------------------------------------
  // 7. ADMIN: MANUAL PAYMENT VERIFICATION REQUESTS
  // -------------------------------------------------------------
  app.get('/api/admin/payments/manual-requests', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const admin = await verifyAdminCaller(req, cfg);
    if (!admin) {
      return res.status(403).json({ ok: false, error: 'Administrator authentication required.' });
    }

    const statusFilter = String(req.query.status || 'pending').toLowerCase(); // 'pending' | 'confirmed' | 'rejected' | 'all'

    try {
      const db = getFirestoreInstance();
      let query: FirebaseFirestore.Query = db.collection('manualPaymentRequests');

      if (statusFilter !== 'all') {
        query = query.where('status', '==', statusFilter);
      }

      query = query.orderBy('createdAtMs', 'desc').limit(100);
      const snap = await query.get();

      const requests = snap.docs.map((d) => d.data() as ManualPaymentRequest);
      return res.json({ ok: true, requests });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load manual payment requests.';
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  app.post('/api/admin/payments/manual-requests/:id/confirm', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const admin = await verifyAdminCaller(req, cfg);
    if (!admin) {
      return res.status(403).json({ ok: false, error: 'Administrator authentication required.' });
    }

    const { id } = req.params;
    try {
      const db = getFirestoreInstance();
      const reqRef = db.collection('manualPaymentRequests').doc(id);
      const reqSnap = await reqRef.get();

      if (!reqSnap.exists) {
        return res.status(404).json({ ok: false, error: 'Manual payment request not found.' });
      }

      const paymentReq = reqSnap.data() as ManualPaymentRequest;
      if (paymentReq.status === 'confirmed') {
        return res.json({ ok: true, message: 'This request has already been confirmed.' });
      }

      const dealRef = db.collection('deals').doc(paymentReq.dealId);
      const dealSnap = await dealRef.get();
      if (!dealSnap.exists) {
        return res.status(404).json({ ok: false, error: 'Associated deal record not found.' });
      }

      const deal = dealSnap.data() as DealRecord;

      // Finalize deal escrow atomically using deterministic ledger id led_pay_${deal.id}
      const finalizeResult = await finalizeDealEscrowPaymentInFirestore(db, {
        dealId: deal.id,
        listingId: deal.listingId,
        buyerUid: deal.buyerId,
        buyerName: deal.buyerName,
        sellerId: deal.sellerId,
        sellerName: deal.sellerName,
        listingTitle: deal.listingTitle,
        platform: deal.platform,
        buyerTotalMinor: deal.buyerTotalMinor,
        currency: deal.currency,
        baseAmountMinor: deal.baseAmountMinor,
        buyerFeeMinor: deal.buyerFeeMinor,
        buyerFeePct: deal.buyerFeePct,
        sellerFeeMinor: deal.sellerFeeMinor,
        sellerFeePct: deal.sellerFeePct,
        sellerPayoutMinor: deal.sellerPayoutMinor,
        platformCommissionMinor: deal.platformCommissionMinor,
        protectionDurationHours: deal.protectionDurationHours,
        transactionId: paymentReq.submittedTrxId,
        gatewayProvider: `Manual Payment (${paymentReq.methodName})`,
      });

      const now = Date.now();
      // Update manual payment request to confirmed
      await reqRef.update({
        status: 'confirmed',
        adminUid: admin.uid,
        adminName: admin.email,
        reviewedAtMs: now,
        paymentLedgerId: finalizeResult.ledgerId,
        updatedAtMs: now,
      });

      // Send in-app notification to buyer
      void db.collection('notifications').add({
        recipientId: deal.buyerId,
        actorId: admin.uid,
        actorRole: 'admin',
        category: 'deal',
        severity: 'success',
        alertKind: 'deal_room_created',
        title: 'Manual Payment Verified!',
        preview: `Your payment for "${deal.listingTitle}" has been verified and deposited into BEXORA Escrow.`,
        body: `Admin approved transaction ID ${paymentReq.submittedTrxId}. Escrow protection is now active. You may now coordinate asset transfer in the deal room.`,
        refType: 'deal',
        refId: deal.id,
        referenceLabel: deal.listingTitle,
        destination: `/deals?dealId=${deal.id}`,
        read: false,
        createdAtMs: now,
      }).catch(() => {});

      // Send in-app notification to seller
      void db.collection('notifications').add({
        recipientId: deal.sellerId,
        actorId: admin.uid,
        actorRole: 'admin',
        category: 'deal',
        severity: 'success',
        alertKind: 'deal_room_created',
        title: 'Buyer Payment Secured in Escrow!',
        preview: `Buyer's manual payment for "${deal.listingTitle}" was verified by admin.`,
        body: `Funds are 100% secured in BEXORA Escrow. Please proceed to the deal room and transfer the asset credentials safely.`,
        refType: 'deal',
        refId: deal.id,
        referenceLabel: deal.listingTitle,
        destination: `/deals?dealId=${deal.id}`,
        read: false,
        createdAtMs: now,
      }).catch(() => {});

      return res.json({
        ok: true,
        status: 'confirmed',
        ledgerId: finalizeResult.ledgerId,
        message: 'Payment verified and escrow deal room successfully activated.',
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to confirm manual payment request.';
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  app.post('/api/admin/payments/manual-requests/:id/reject', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const admin = await verifyAdminCaller(req, cfg);
    if (!admin) {
      return res.status(403).json({ ok: false, error: 'Administrator authentication required.' });
    }

    const { id } = req.params;
    const { reason } = req.body || {};
    const rejectionReason = typeof reason === 'string' && reason.trim().length > 0
      ? reason.trim()
      : 'Transaction ID could not be verified in BEXORA payment records.';

    try {
      const db = getFirestoreInstance();
      const reqRef = db.collection('manualPaymentRequests').doc(id);
      const reqSnap = await reqRef.get();

      if (!reqSnap.exists) {
        return res.status(404).json({ ok: false, error: 'Manual payment request not found.' });
      }

      const paymentReq = reqSnap.data() as ManualPaymentRequest;
      const now = Date.now();

      // Update manual payment request
      await reqRef.update({
        status: 'rejected',
        rejectionReason,
        adminUid: admin.uid,
        adminName: admin.email,
        reviewedAtMs: now,
        updatedAtMs: now,
      });

      // Update deal status back to awaiting_payment so buyer can retry
      const dealRef = db.collection('deals').doc(paymentReq.dealId);
      await dealRef.update({
        status: 'awaiting_payment',
        latestRejectionReason: rejectionReason,
        updatedAtMs: now,
      });

      // Append audit event
      await db.collection('dealAudits').add({
        id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        dealId: paymentReq.dealId,
        actorId: admin.uid,
        actorName: admin.email,
        actorRole: 'admin',
        eventType: 'manual_payment_rejected',
        summary: `Admin rejected manual payment proof: ${rejectionReason}`,
        createdAtMs: now,
      });

      // Notify buyer of rejection
      void db.collection('notifications').add({
        recipientId: paymentReq.buyerUid,
        actorId: admin.uid,
        actorRole: 'admin',
        category: 'deal',
        severity: 'warning',
        title: 'Manual Payment Not Verified',
        preview: `Payment proof for "${paymentReq.listingTitle}" was rejected.`,
        body: `Reason: ${rejectionReason}. Please double-check your Transaction ID or use BEXORA Wallet / Live Payment.`,
        refType: 'deal',
        refId: paymentReq.dealId,
        referenceLabel: paymentReq.listingTitle,
        destination: `/checkout?dealId=${paymentReq.dealId}`,
        read: false,
        createdAtMs: now,
      }).catch(() => {});

      return res.json({
        ok: true,
        status: 'rejected',
        rejectionReason,
        message: 'Payment proof rejected and buyer notified.',
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to reject manual payment request.';
      return res.status(500).json({ ok: false, error: msg });
    }
  });
}
