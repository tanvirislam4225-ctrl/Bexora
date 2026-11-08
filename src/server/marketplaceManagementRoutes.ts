import crypto from 'node:crypto';
import type express from 'express';
import type { App as AdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore as getAdminFirestore } from 'firebase-admin/firestore';
import { getStorage as getAdminStorage } from 'firebase-admin/storage';
import {
  validateAccountAge,
  validateGamingFields,
  validateImageMagicBytes,
  validatePlatformAssetUrl,
  detectSensitiveOrOffPlatformContent,
} from '../lib/marketplaceLogic';
import {
  BUYER_WITHDRAW_BID_COPY,
  canSellerEditListingStatus,
  evaluateAdminUserDeletionEligibility,
  evaluateListingDeletionEligibility,
  LISTING_DELETE_CONFIRM_COPY,
  LISTING_UPDATED_REVIEW_NOTICE,
  MAX_GALLERY_LIMIT_MESSAGE,
  MAX_LISTING_IMAGES,
  SELLER_REJECT_BID_COPY,
} from '../lib/listingAndBidManagementLogic';
import {
  evaluateViewQualification,
  normalizeViewerKey,
  ViewDeduplicationCache,
  VIEW_DEDUPLICATION_WINDOW_MS,
} from '../lib/viewCountLogic';
import { recordSecurityEvent, SlidingWindowRateLimiter } from '../lib/serverSecurity';

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

interface MarketplaceManagementDeps<
  TCfg extends VerifiedFirebaseRuntimeConfig = VerifiedFirebaseRuntimeConfig
> {
  app: express.Express;
  loadVerifiedFirebaseConfig: () => TCfg;
  getOrInitFirebaseAdminApp: (projectId: string) => AdminApp;
  verifyCallerFirebaseToken: (req: express.Request, cfg: TCfg) => Promise<VerifiedCaller | null>;
  verifyAdminCaller: (req: express.Request, cfg: TCfg) => Promise<VerifiedAdminCaller | null>;
  getCallerClientKey: (req: express.Request) => string;
}

const VALID_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

interface FirestoreRestDoc {
  name?: string;
  fields?: Record<string, unknown>;
  createTime?: string;
  updateTime?: string;
}

function fromFirestoreRestValue(val: unknown): unknown {
  if (!val || typeof val !== 'object') return undefined;
  const v = val as Record<string, unknown>;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return Boolean(v.booleanValue);
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return String(v.stringValue ?? '');
  if ('timestampValue' in v) return String(v.timestampValue ?? '');
  if ('arrayValue' in v) {
    const arr = (v.arrayValue as { values?: unknown[] } | undefined)?.values;
    return Array.isArray(arr) ? arr.map(fromFirestoreRestValue) : [];
  }
  if ('mapValue' in v) {
    const fields = (v.mapValue as { fields?: Record<string, unknown> } | undefined)?.fields || {};
    const out: Record<string, unknown> = {};
    for (const [k, fv] of Object.entries(fields)) {
      out[k] = fromFirestoreRestValue(fv);
    }
    return out;
  }
  return undefined;
}

function parseRestDoc(doc: FirestoreRestDoc | null | undefined): Record<string, unknown> | null {
  if (!doc || !doc.fields) return null;
  const id = doc.name ? doc.name.split('/').pop() || '' : '';
  const data: Record<string, unknown> = { id };
  for (const [k, v] of Object.entries(doc.fields)) {
    data[k] = fromFirestoreRestValue(v);
  }
  return data;
}

function toFirestoreRestValue(val: unknown): Record<string, unknown> {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (val instanceof Date) return { timestampValue: val.toISOString() };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map((item) => toFirestoreRestValue(item)) } };
  }
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if (obj.__serverTimestamp === true) {
      return { timestampValue: new Date().toISOString() };
    }
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined) {
        fields[k] = toFirestoreRestValue(v);
      }
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function extractTimestampMs(raw: unknown): number {
  if (!raw) return 0;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : 0;
  }
  if (typeof raw === 'object') {
    const obj = raw as { toMillis?: () => number; _seconds?: number; seconds?: number };
    if (typeof obj.toMillis === 'function') return obj.toMillis();
    if (typeof obj._seconds === 'number') return obj._seconds * 1000;
    if (typeof obj.seconds === 'number') return obj.seconds * 1000;
  }
  return 0;
}

function validateShowcaseImagesServer(imagesRaw: unknown): {
  valid: boolean;
  images: string[];
  error?: string;
} {
  if (!Array.isArray(imagesRaw)) {
    return { valid: true, images: [] };
  }
  if (imagesRaw.length > MAX_LISTING_IMAGES) {
    return { valid: false, images: [], error: MAX_GALLERY_LIMIT_MESSAGE };
  }
  const validated: string[] = [];
  for (let i = 0; i < imagesRaw.length; i++) {
    const item = String(imagesRaw[i] || '').trim();
    if (!item || item.length < 12 || item.length > 250_000) {
      return {
        valid: false,
        images: [],
        error: `Image #${i + 1} is invalid or exceeds the 250KB showcase limit.`,
      };
    }
    if (item.startsWith('https://')) {
      validated.push(item);
      continue;
    }
    const b64Match = item.match(/^data:image\/(?:jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!b64Match) {
      return {
        valid: false,
        images: [],
        error: `Image #${i + 1} must be a valid JPEG, PNG, or WebP image.`,
      };
    }
    const rawBytes = Buffer.from(b64Match[1].replace(/\s+/g, ''), 'base64');
    const magic = validateImageMagicBytes(rawBytes);
    if (!magic.valid) {
      return {
        valid: false,
        images: [],
        error: `Image #${i + 1} failed binary format verification (${magic.error || 'unsupported image'}).`,
      };
    }
    validated.push(item);
  }
  return { valid: true, images: validated };
}

export function registerMarketplaceManagementRoutes<
  TCfg extends VerifiedFirebaseRuntimeConfig = VerifiedFirebaseRuntimeConfig
>(deps: MarketplaceManagementDeps<TCfg>): void {
  const {
    app,
    loadVerifiedFirebaseConfig,
    getOrInitFirebaseAdminApp,
    verifyCallerFirebaseToken,
    verifyAdminCaller,
    getCallerClientKey,
  } = deps;

  const listingMutationLimiter = new SlidingWindowRateLimiter(30, 60_000);
  const bidMutationLimiter = new SlidingWindowRateLimiter(40, 60_000);
  const publicEligibilityLimiter = new SlidingWindowRateLimiter(30, 60_000);
  const viewCounterCache = new ViewDeduplicationCache(VIEW_DEDUPLICATION_WINDOW_MS);
  const viewCounterLimiter = new SlidingWindowRateLimiter(60, 60_000);

  function buildFirestoreRestBase(cfg: VerifiedFirebaseRuntimeConfig): string {
    return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      cfg.projectId
    )}/databases/${encodeURIComponent(cfg.firestoreDatabaseId)}/documents`;
  }

  async function restGetDoc(
    cfg: VerifiedFirebaseRuntimeConfig,
    docPath: string,
    idToken: string
  ): Promise<Record<string, unknown> | null> {
    const res = await fetch(`${buildFirestoreRestBase(cfg)}/${docPath}`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`REST GET ${docPath} failed (${res.status})`);
    }
    const json = (await res.json()) as FirestoreRestDoc;
    return parseRestDoc(json);
  }

  async function restRunStructuredQuery(
    cfg: VerifiedFirebaseRuntimeConfig,
    structuredQuery: Record<string, unknown>,
    idToken: string,
    parentDocPath = ''
  ): Promise<Array<Record<string, unknown>>> {
    const parentUrl = parentDocPath
      ? `${buildFirestoreRestBase(cfg)}/${parentDocPath}:runQuery`
      : `${buildFirestoreRestBase(cfg)}:runQuery`;
    const res = await fetch(parentUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ structuredQuery }),
    });
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<{ document?: FirestoreRestDoc }>;
    const out: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const parsed = parseRestDoc(row.document);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  async function restCommitWrites(
    cfg: VerifiedFirebaseRuntimeConfig,
    writes: Array<Record<string, unknown>>,
    idToken: string
  ): Promise<boolean> {
    const commitUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      cfg.projectId
    )}/databases/${encodeURIComponent(cfg.firestoreDatabaseId)}/documents:commit`;
    const res = await fetch(commitUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ writes }),
    });
    return res.ok;
  }

  function docFullName(cfg: VerifiedFirebaseRuntimeConfig, docPath: string): string {
    return `projects/${cfg.projectId}/databases/${cfg.firestoreDatabaseId}/documents/${docPath}`;
  }

  function makeRestWriteWithServerTransforms(
    cfg: VerifiedFirebaseRuntimeConfig,
    docPath: string,
    fieldsObj: Record<string, unknown>,
    serverTimestampFields: string[],
    updateMaskFieldPaths?: string[],
    currentDocExists?: boolean
  ): Array<Record<string, unknown>> {
    const name = docFullName(cfg, docPath);
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fieldsObj)) {
      if (v !== undefined) {
        fields[k] = toFirestoreRestValue(v);
      }
    }
    const updateWrite: Record<string, unknown> = {
      update: { name, fields },
    };
    if (updateMaskFieldPaths && updateMaskFieldPaths.length > 0) {
      updateWrite.updateMask = { fieldPaths: updateMaskFieldPaths };
    }
    if (typeof currentDocExists === 'boolean') {
      updateWrite.currentDocument = { exists: currentDocExists };
    }
    const ops: Array<Record<string, unknown>> = [updateWrite];
    if (serverTimestampFields.length > 0) {
      ops.push({
        transform: {
          document: name,
          fieldTransforms: serverTimestampFields.map((fieldPath) => ({
            fieldPath,
            setToServerValue: 'REQUEST_TIME',
          })),
        },
      });
    }
    return ops;
  }

  async function appendAuditLog(
    cfg: VerifiedFirebaseRuntimeConfig,
    idToken: string,
    entry: {
      actorId: string;
      action: string;
      targetType: string;
      targetId: string;
      details: string;
    }
  ): Promise<void> {
    const logId = `aud_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const safeDetails = String(entry.details || '').slice(0, 950);
    try {
      const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
      const db = getAdminFirestore(adminApp, cfg.firestoreDatabaseId);
      await db.collection('auditLogs').doc(logId).set({
        actorId: entry.actorId,
        action: entry.action.slice(0, 80),
        targetType: entry.targetType.slice(0, 40),
        targetId: entry.targetId.slice(0, 128),
        details: safeDetails,
        createdAt: FieldValue.serverTimestamp(),
      });
      return;
    } catch {
      // Fallback to authenticated REST commit
    }
    try {
      const writes = makeRestWriteWithServerTransforms(
        cfg,
        `auditLogs/${logId}`,
        {
          actorId: entry.actorId,
          action: entry.action.slice(0, 80),
          targetType: entry.targetType.slice(0, 40),
          targetId: entry.targetId.slice(0, 128),
          details: safeDetails,
        },
        ['createdAt'],
        undefined,
        false
      );
      await restCommitWrites(cfg, writes, idToken);
    } catch {
      // Non-fatal
    }
  }

  async function inspectListingObligations(
    cfg: VerifiedFirebaseRuntimeConfig,
    listingId: string,
    callerUid: string,
    idToken: string
  ) {
    // Try Admin SDK first, then REST with caller's verified token
    try {
      const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
      const db = getAdminFirestore(adminApp, cfg.firestoreDatabaseId);
      const listingSnap = await db.collection('listings').doc(listingId).get();
      if (!listingSnap.exists) {
        return { found: false as const };
      }
      const listing: Record<string, unknown> = {
        id: listingSnap.id,
        ...(listingSnap.data() as Record<string, unknown>),
      };
      const [dealsSnap, bidsSnap, userReportsSnap] = await Promise.all([
        db.collection('deals').where('listingId', '==', listingId).get(),
        db.collection('bids').where('listingId', '==', listingId).get(),
        db
          .collection('userReports')
          .where('reportedUserId', '==', String(listing.sellerId || callerUid))
          .get(),
      ]);
      const deals: Array<Record<string, unknown>> = dealsSnap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Record<string, unknown>),
      }));
      const bids: Array<Record<string, unknown>> = bidsSnap.docs.map((b) => ({
        id: b.id,
        ...(b.data() as Record<string, unknown>),
      }));

      let openDealReportsCount = 0;
      for (const deal of deals) {
        if (Number(deal.unresolvedReportCount || 0) > 0) {
          openDealReportsCount += Number(deal.unresolvedReportCount || 0);
        }
      }
      const openUserReportsCount = userReportsSnap.docs.filter((docSnap) => {
        const d = docSnap.data();
        const st = String(d.status || '');
        const isOpen = st === 'submitted' || st === 'under_review' || st === 'needs_info';
        return isOpen && String(d.listingId || '') === listingId;
      }).length;

      return {
        found: true as const,
        viaAdminSdk: true,
        listing,
        deals,
        bids,
        openDealReportsCount,
        openUserReportsCount,
      };
    } catch {
      // Fallback to Firestore REST using caller's verified Bearer token
      const listing = await restGetDoc(cfg, `listings/${listingId}`, idToken);
      if (!listing) {
        return { found: false as const };
      }
      const [dealsAsSeller, bids] = await Promise.all([
        restRunStructuredQuery(
          cfg,
          {
            from: [{ collectionId: 'deals' }],
            where: {
              compositeFilter: {
                op: 'AND',
                filters: [
                  {
                    fieldFilter: {
                      field: { fieldPath: 'sellerId' },
                      op: 'EQUAL',
                      value: { stringValue: callerUid },
                    },
                  },
                  {
                    fieldFilter: {
                      field: { fieldPath: 'listingId' },
                      op: 'EQUAL',
                      value: { stringValue: listingId },
                    },
                  },
                ],
              },
            },
            limit: 50,
          },
          idToken
        ),
        restRunStructuredQuery(
          cfg,
          {
            from: [{ collectionId: 'bids' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'listingId' },
                op: 'EQUAL',
                value: { stringValue: listingId },
              },
            },
            limit: 100,
          },
          idToken
        ),
      ]);

      let openDealReportsCount = 0;
      for (const deal of dealsAsSeller) {
        if (Number(deal.unresolvedReportCount || 0) > 0) {
          openDealReportsCount += Number(deal.unresolvedReportCount || 0);
        }
      }

      return {
        found: true as const,
        viaAdminSdk: false,
        listing,
        deals: dealsAsSeller,
        bids,
        openDealReportsCount,
        openUserReportsCount: 0,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Public Registration Eligibility Check (Respects Superadmin Fraud Blocklist)
  // ---------------------------------------------------------------------------
  app.get('/api/auth/registration-eligibility', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const ipKey = getCallerClientKey(req);
    if (!publicEligibilityLimiter.consume(`reg_elig:${ipKey}`).allowed) {
      return res.status(429).json({ ok: false, eligible: true });
    }
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      return res.json({ ok: true, eligible: true });
    }
    const cfg = loadVerifiedFirebaseConfig();
    if (!cfg.configValid) {
      return res.json({ ok: true, eligible: true });
    }
    try {
      const emailHash = crypto.createHash('sha256').update(`email:${email}`).digest('hex');
      const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
      const db = getAdminFirestore(adminApp, cfg.firestoreDatabaseId);
      const banSnap = await db.collection('bannedIdentities').doc(`email_${emailHash.slice(0, 48)}`).get();
      if (banSnap.exists) {
        return res.status(403).json({
          ok: false,
          eligible: false,
          error:
            'This email address is permanently restricted from registering a new BEXORA account due to a prior security enforcement.',
        });
      }
    } catch {
      // Allow normal registration flow when Admin Firestore IAM is not attached
    }
    return res.json({ ok: true, eligible: true });
  });

  // ---------------------------------------------------------------------------
  // 2. Seller Listing Edit (Server-Verified Ownership, Revision History, Pending Re-Review)
  // ---------------------------------------------------------------------------
  app.post('/api/listings/:listingId/edit', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const caller = await verifyCallerFirebaseToken(req, cfg);
    if (!caller) {
      return res.status(401).json({ ok: false, error: 'Please sign in to edit your listing.' });
    }
    if (!listingMutationLimiter.consume(`edit_list:${caller.uid}`).allowed) {
      return res.status(429).json({ ok: false, error: 'Too many listing edit requests. Please wait a moment.' });
    }

    const listingId = String(req.params.listingId || '').trim();
    if (!VALID_ID_REGEX.test(listingId)) {
      return res.status(400).json({ ok: false, error: 'Invalid listing ID.' });
    }

    try {
      const inspection = await inspectListingObligations(cfg, listingId, caller.uid, caller.idToken);
      if (!inspection.found) {
        return res.status(404).json({ ok: false, error: 'Listing not found.' });
      }
      const existing = inspection.listing;
      if (String(existing.sellerId || '') !== caller.uid) {
        recordSecurityEvent({
          type: 'auth_failure',
          endpoint: `/api/listings/${listingId}/edit`,
          actor: caller.uid,
          summary: `Blocked unauthorized edit attempt on listing ${listingId} owned by another user.`,
        });
        return res.status(403).json({
          ok: false,
          error: 'You are not authorized to edit a listing owned by another seller.',
        });
      }

      const currentStatus = String(existing.status || '');
      const activeDealId = typeof existing.activeDealId === 'string' ? existing.activeDealId : null;
      if (!canSellerEditListingStatus(currentStatus, activeDealId)) {
        return res.status(409).json({
          ok: false,
          error:
            'This listing cannot be edited right now because it is reserved in an active deal, already sold, or suspended.',
        });
      }

      const body = (req.body || {}) as Record<string, unknown>;
      const saveAsDraft = body.saveAsDraft === true;
      const platform = String(existing.platform || 'youtube') as Parameters<
        typeof validatePlatformAssetUrl
      >[0];
      const title = String(body.title || '').trim();
      const description = String(body.description || '').trim();
      const subcategory = String(body.subcategory || existing.subcategory || '').trim().slice(0, 60);
      const priceMinor = Math.round(Number(body.priceMinor || 0));
      const ageYears = Math.floor(Number(body.ageYears ?? existing.ageYears ?? 0));
      const ageMonths = Math.floor(Number(body.ageMonths ?? existing.ageMonths ?? 0));
      const metricValue = Math.max(0, Math.floor(Number(body.metricValue ?? existing.metricValue ?? 0)));
      const monthlyRevenueMinor = Math.max(
        0,
        Math.round(Number(body.monthlyRevenueMinor ?? existing.monthlyRevenueMinor ?? 0))
      );
      const accountUrlRaw = String(body.accountUrl ?? existing.accountUrl ?? '').trim();
      const monetizationStatus = String(
        body.monetizationStatus || existing.monetizationStatus || 'non-monetized'
      );
      const claimedOptions = Array.isArray(body.claimedOptions)
        ? body.claimedOptions
            .map((c) => String(c || '').trim().slice(0, 64))
            .filter(Boolean)
            .slice(0, 15)
        : [];

      if (title.length < 8 || title.length > 120) {
        return res.status(400).json({ ok: false, error: 'Listing title must be between 8 and 120 characters.' });
      }
      if (description.length < 20 || description.length > 4000) {
        return res
          .status(400)
          .json({ ok: false, error: 'Listing description must be between 20 and 4,000 characters.' });
      }
      if (!subcategory || subcategory.length > 60) {
        return res.status(400).json({ ok: false, error: 'Select a valid subcategory.' });
      }
      if (!Number.isFinite(priceMinor) || priceMinor <= 0) {
        return res.status(400).json({ ok: false, error: 'Enter a valid positive listing price.' });
      }

      if (!saveAsDraft) {
        const sensitiveCheck = detectSensitiveOrOffPlatformContent(`${title}\n${description}`);
        if (sensitiveCheck.blocked) {
          return res.status(400).json({
            ok: false,
            error:
              sensitiveCheck.reason ||
              'Remove passwords, contact numbers, or off-platform links from public listing fields.',
          });
        }
      }

      const ageCheck = validateAccountAge(ageYears, ageMonths, platform !== 'gaming' && !saveAsDraft);
      if (!saveAsDraft && !ageCheck.valid) {
        return res.status(400).json({ ok: false, error: ageCheck.error || 'Invalid account age.' });
      }

      const urlCheck = validatePlatformAssetUrl(platform, accountUrlRaw);
      if (!saveAsDraft && !urlCheck.valid) {
        return res.status(400).json({ ok: false, error: urlCheck.error || 'Invalid asset URL.' });
      }

      const imgCheck = validateShowcaseImagesServer(body.images);
      if (!imgCheck.valid) {
        return res.status(400).json({ ok: false, error: imgCheck.error });
      }
      if (!saveAsDraft && imgCheck.images.length === 0) {
        return res.status(400).json({ ok: false, error: 'Upload at least 1 public showcase screenshot.' });
      }

      let gameFields: { gameName?: string; gameUid?: string; gameLevel?: number } = {};
      if (platform === 'gaming') {
        const gCheck = validateGamingFields(
          String(body.gameName || existing.gameName || ''),
          String(body.gameUid || existing.gameUid || ''),
          Number(body.gameLevel ?? existing.gameLevel ?? 1)
        );
        if (!saveAsDraft && !gCheck.valid) {
          return res.status(400).json({ ok: false, error: gCheck.error || 'Invalid gaming account details.' });
        }
        gameFields = {
          gameName: String(body.gameName || existing.gameName || '').trim().slice(0, 60),
          gameUid: String(body.gameUid || existing.gameUid || '').trim().slice(0, 64),
          gameLevel: Math.max(0, Math.min(10000, Math.floor(Number(body.gameLevel ?? existing.gameLevel ?? 1)))),
        };
      }

      const nextStatus = saveAsDraft ? 'draft' : 'pending';
      const nextVerificationState =
        monetizationStatus === 'monetized' && claimedOptions.length > 0
          ? 'submitted_for_verification'
          : 'not_claimed';

      const revisionId = `rev_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const changedFields: string[] = [];
      if (title !== String(existing.title || '')) changedFields.push('title');
      if (description !== String(existing.description || '')) changedFields.push('description');
      if (priceMinor !== Number(existing.priceMinor || 0)) changedFields.push('price');
      if (subcategory !== String(existing.subcategory || '')) changedFields.push('subcategory');
      if (
        imgCheck.images.length !==
        (Array.isArray(existing.images) ? existing.images.length : 0)
      ) {
        changedFields.push('images');
      }
      const changeSummary =
        changedFields.length > 0
          ? `Seller updated ${changedFields.join(', ')} (transitioned ${currentStatus} -> ${nextStatus}).`
          : `Seller resubmitted listing (${currentStatus} -> ${nextStatus}).`;

      const updateFields: Record<string, unknown> = {
        title,
        description,
        priceMinor,
        subcategory,
        monetizationStatus,
        claimedOptions,
        verifiedOptions: [],
        verificationState: nextVerificationState,
        ageYears: Math.max(0, Math.min(50, ageCheck.years)),
        ageMonths: Math.max(0, Math.min(11, ageCheck.months)),
        metricValue,
        monthlyRevenueMinor,
        accountUrl: urlCheck.valid ? urlCheck.normalizedUrl : '',
        urlValidationStatus: urlCheck.valid ? urlCheck.status : 'not_applicable',
        images: imgCheck.images,
        status: nextStatus,
        ...gameFields,
      };

      const revisionPayload = {
        listingId,
        sellerId: caller.uid,
        previousTitle: String(existing.title || '').slice(0, 140),
        previousDescription: String(existing.description || '').slice(0, 4000),
        previousPriceMinor: Math.max(0, Math.round(Number(existing.priceMinor || 0))),
        previousCurrency: existing.currency === 'USD' ? 'USD' : 'BDT',
        previousStatus: currentStatus.slice(0, 32),
        previousImagesCount: Array.isArray(existing.images) ? Math.min(10, existing.images.length) : 0,
        changeSummary: changeSummary.slice(0, 600),
        createdAtMs: Date.now(),
      };

      let savedServerSide = false;
      if (inspection.viaAdminSdk) {
        try {
          const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
          const db = getAdminFirestore(adminApp, cfg.firestoreDatabaseId);
          const batch = db.batch();
          batch.set(
            db.collection('listings').doc(listingId).collection('revisions').doc(revisionId),
            {
              ...revisionPayload,
              createdAt: FieldValue.serverTimestamp(),
            }
          );
          batch.update(db.collection('listings').doc(listingId), {
            ...updateFields,
            updatedAt: FieldValue.serverTimestamp(),
          });
          await batch.commit();
          savedServerSide = true;
        } catch {
          savedServerSide = false;
        }
      }

      if (!savedServerSide) {
        const fullMergedListing: Record<string, unknown> = { ...existing, ...updateFields };
        delete fullMergedListing.id;
        delete fullMergedListing.updatedAt;
        const maskKeys = [...Object.keys(updateFields)];
        const writes = [
          ...makeRestWriteWithServerTransforms(
            cfg,
            `listings/${listingId}/revisions/${revisionId}`,
            revisionPayload,
            ['createdAt'],
            undefined,
            false
          ),
          ...makeRestWriteWithServerTransforms(
            cfg,
            `listings/${listingId}`,
            updateFields,
            ['updatedAt'],
            maskKeys,
            true
          ),
        ];
        savedServerSide = await restCommitWrites(cfg, writes, caller.idToken);
      }

      if (!savedServerSide) {
        return res.status(500).json({
          ok: false,
          error: 'Could not save listing changes right now. Please try again.',
        });
      }

      await appendAuditLog(cfg, caller.idToken, {
        actorId: caller.uid,
        action: 'SELLER_EDITED_LISTING',
        targetType: 'listing',
        targetId: listingId,
        details: changeSummary,
      });

      return res.json({
        ok: true,
        listingId,
        revisionId,
        status: nextStatus,
        notice: LISTING_UPDATED_REVIEW_NOTICE,
      });
    } catch {
      return res.status(500).json({
        ok: false,
        error: 'An error occurred while updating your listing.',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 3. Seller Listing Delete Preflight & Atomic Deletion
  // ---------------------------------------------------------------------------
  app.get('/api/listings/:listingId/delete-preflight', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const caller = await verifyCallerFirebaseToken(req, cfg);
    if (!caller) {
      return res.status(401).json({ ok: false, error: 'Authentication required.' });
    }
    const listingId = String(req.params.listingId || '').trim();
    if (!VALID_ID_REGEX.test(listingId)) {
      return res.status(400).json({ ok: false, error: 'Invalid listing ID.' });
    }

    try {
      const inspection = await inspectListingObligations(cfg, listingId, caller.uid, caller.idToken);
      if (!inspection.found) {
        return res.status(404).json({ ok: false, error: 'Listing not found or already deleted.' });
      }
      const listing = inspection.listing;
      const isOwner = String(listing.sellerId || '') === caller.uid;
      const eligibility = evaluateListingDeletionEligibility({
        isOwner,
        listingStatus: String(listing.status || ''),
        activeDealId: typeof listing.activeDealId === 'string' ? listing.activeDealId : null,
        deals: inspection.deals as Array<{ id?: string; status?: string }>,
        bids: inspection.bids as Array<{ id?: string; status?: string; dealId?: string }>,
        openDealReportsCount: inspection.openDealReportsCount,
        openUserReportsCount: inspection.openUserReportsCount,
      });

      if (!isOwner) {
        return res.status(403).json({ ok: false, ...eligibility });
      }

      const images = Array.isArray(listing.images) ? listing.images : [];
      return res.json({
        ok: true,
        ...eligibility,
        listingId,
        listingTitle: String(listing.title || 'Untitled Asset'),
        platform: String(listing.platform || ''),
        thumbnailUrl: typeof images[0] === 'string' ? images[0] : '',
      });
    } catch {
      return res.status(500).json({ ok: false, error: 'Could not verify listing deletion eligibility.' });
    }
  });

  app.post('/api/listings/:listingId/delete', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const caller = await verifyCallerFirebaseToken(req, cfg);
    if (!caller) {
      return res.status(401).json({ ok: false, error: 'Authentication required.' });
    }
    if (!listingMutationLimiter.consume(`del_list:${caller.uid}`).allowed) {
      return res.status(429).json({ ok: false, error: 'Too many requests. Please wait a moment.' });
    }

    const listingId = String(req.params.listingId || '').trim();
    if (!VALID_ID_REGEX.test(listingId)) {
      return res.status(400).json({ ok: false, error: 'Invalid listing ID.' });
    }

    try {
      const inspection = await inspectListingObligations(cfg, listingId, caller.uid, caller.idToken);
      if (!inspection.found) {
        return res.status(404).json({ ok: false, error: 'Listing not found or already deleted.' });
      }
      const listing = inspection.listing;
      const isOwner = String(listing.sellerId || '') === caller.uid;
      const eligibility = evaluateListingDeletionEligibility({
        isOwner,
        listingStatus: String(listing.status || ''),
        activeDealId: typeof listing.activeDealId === 'string' ? listing.activeDealId : null,
        deals: inspection.deals as Array<{ id?: string; status?: string }>,
        bids: inspection.bids as Array<{ id?: string; status?: string; dealId?: string }>,
        openDealReportsCount: inspection.openDealReportsCount,
        openUserReportsCount: inspection.openUserReportsCount,
      });

      if (!isOwner) {
        recordSecurityEvent({
          type: 'auth_failure',
          endpoint: `/api/listings/${listingId}/delete`,
          actor: caller.uid,
          summary: `Blocked unauthorized delete attempt on listing ${listingId}.`,
        });
        return res.status(403).json({ ok: false, ...eligibility });
      }

      if (!eligibility.eligible) {
        return res.status(409).json({ ok: false, ...eligibility });
      }

      const pendingBids = inspection.bids.filter(
        (b) => String(b.status || '') === 'pending' && !b.dealId
      );

      let deletedOk = false;
      if (inspection.viaAdminSdk) {
        try {
          const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
          const db = getAdminFirestore(adminApp, cfg.firestoreDatabaseId);
          const batch = db.batch();
          for (const bid of pendingBids) {
            const bidId = String(bid.id || '');
            if (bidId) {
              batch.update(db.collection('bids').doc(bidId), {
                status: 'rejected',
                updatedAt: FieldValue.serverTimestamp(),
              });
            }
          }
          batch.delete(db.collection('listings').doc(listingId));
          batch.delete(db.collection('listingEvidence').doc(listingId));
          await batch.commit();
          deletedOk = true;
        } catch {
          deletedOk = false;
        }
      }

      if (!deletedOk) {
        const writes: Array<Record<string, unknown>> = [];
        for (const bid of pendingBids) {
          const bidId = String(bid.id || '');
          if (bidId) {
            writes.push(
              ...makeRestWriteWithServerTransforms(
                cfg,
                `bids/${bidId}`,
                { status: 'rejected' },
                ['updatedAt'],
                ['status'],
                true
              )
            );
          }
        }
        writes.push({
          delete: docFullName(cfg, `listings/${listingId}`),
          currentDocument: { exists: true },
        });
        const evidenceExists = await restGetDoc(cfg, `listingEvidence/${listingId}`, caller.idToken).catch(
          () => null
        );
        if (evidenceExists) {
          writes.push({
            delete: docFullName(cfg, `listingEvidence/${listingId}`),
          });
        }
        deletedOk = await restCommitWrites(cfg, writes, caller.idToken);
      }

      if (!deletedOk) {
        return res.status(500).json({
          ok: false,
          error: 'Could not delete listing right now. Please try again.',
        });
      }

      await appendAuditLog(cfg, caller.idToken, {
        actorId: caller.uid,
        action: 'SELLER_DELETED_LISTING',
        targetType: 'listing',
        targetId: listingId,
        details: `Seller deleted own listing "${String(listing.title || '').slice(0, 80)}" (${String(
          listing.platform || ''
        )}, status=${String(listing.status || '')}, rejectedPendingBids=${pendingBids.length}).`,
      });

      return res.json({
        ok: true,
        deletedListingId: listingId,
        rejectedPendingBidsCount: pendingBids.length,
        message: LISTING_DELETE_CONFIRM_COPY.successBanner,
      });
    } catch {
      return res.status(500).json({
        ok: false,
        error: 'An unexpected error occurred while deleting the listing.',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 4. Buyer Bid Withdrawal & Seller Bid Rejection (Atomic & Role-Verified)
  // ---------------------------------------------------------------------------
  app.post('/api/bids/:bidId/withdraw', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const caller = await verifyCallerFirebaseToken(req, cfg);
    if (!caller) {
      return res.status(401).json({ ok: false, error: 'Please sign in to withdraw your bid.' });
    }
    if (!bidMutationLimiter.consume(`bid_wd:${caller.uid}`).allowed) {
      return res.status(429).json({ ok: false, error: 'Too many requests. Please wait a moment.' });
    }
    const bidId = String(req.params.bidId || '').trim();
    if (!VALID_ID_REGEX.test(bidId)) {
      return res.status(400).json({ ok: false, error: 'Invalid bid ID.' });
    }

    try {
      let updatedViaAdmin = false;
      let listingId = '';
      try {
        const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
        const db = getAdminFirestore(adminApp, cfg.firestoreDatabaseId);
        const bidRef = db.collection('bids').doc(bidId);
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(bidRef);
          if (!snap.exists) throw new Error('BID_NOT_FOUND');
          const data = snap.data() as Record<string, unknown>;
          if (String(data.buyerId || '') !== caller.uid) throw new Error('FORBIDDEN_NOT_BUYER');
          if (String(data.status || '') !== 'pending' || data.dealId) {
            throw new Error('BID_NOT_PENDING');
          }
          listingId = String(data.listingId || '');
          tx.update(bidRef, {
            status: 'withdrawn',
            updatedAt: FieldValue.serverTimestamp(),
          });
        });
        updatedViaAdmin = true;
      } catch (txErr) {
        const code = txErr instanceof Error ? txErr.message : '';
        if (code === 'BID_NOT_FOUND') {
          return res.status(404).json({ ok: false, error: 'Bid not found.' });
        }
        if (code === 'FORBIDDEN_NOT_BUYER') {
          return res.status(403).json({ ok: false, error: 'You can only withdraw your own bid.' });
        }
        if (code === 'BID_NOT_PENDING') {
          return res.status(409).json({
            ok: false,
            error: 'This bid is no longer pending (it may have already been accepted, rejected, or withdrawn).',
          });
        }
      }

      if (!updatedViaAdmin) {
        const bidDoc = await restGetDoc(cfg, `bids/${bidId}`, caller.idToken);
        if (!bidDoc) {
          return res.status(404).json({ ok: false, error: 'Bid not found.' });
        }
        if (String(bidDoc.buyerId || '') !== caller.uid) {
          return res.status(403).json({ ok: false, error: 'You can only withdraw your own bid.' });
        }
        if (String(bidDoc.status || '') !== 'pending' || bidDoc.dealId) {
          return res.status(409).json({
            ok: false,
            error: 'This bid is no longer pending and cannot be withdrawn.',
          });
        }
        listingId = String(bidDoc.listingId || '');
        const writes = makeRestWriteWithServerTransforms(
          cfg,
          `bids/${bidId}`,
          { status: 'withdrawn' },
          ['updatedAt'],
          ['status'],
          true
        );
        const ok = await restCommitWrites(cfg, writes, caller.idToken);
        if (!ok) {
          return res.status(500).json({ ok: false, error: 'Could not withdraw bid right now.' });
        }
      }

      await appendAuditLog(cfg, caller.idToken, {
        actorId: caller.uid,
        action: 'BUYER_WITHDREW_BID',
        targetType: 'bid',
        targetId: bidId,
        details: `Buyer withdrew pending bid ${bidId} on listing ${listingId}.`,
      });

      return res.json({
        ok: true,
        bidId,
        status: 'withdrawn',
        message: BUYER_WITHDRAW_BID_COPY.successBanner,
      });
    } catch {
      return res.status(500).json({ ok: false, error: 'Failed to withdraw bid.' });
    }
  });

  app.post('/api/bids/:bidId/reject', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const caller = await verifyCallerFirebaseToken(req, cfg);
    if (!caller) {
      return res.status(401).json({ ok: false, error: 'Please sign in to manage offers on your listing.' });
    }
    if (!bidMutationLimiter.consume(`bid_rej:${caller.uid}`).allowed) {
      return res.status(429).json({ ok: false, error: 'Too many requests. Please wait a moment.' });
    }
    const bidId = String(req.params.bidId || '').trim();
    if (!VALID_ID_REGEX.test(bidId)) {
      return res.status(400).json({ ok: false, error: 'Invalid bid ID.' });
    }

    try {
      let updatedViaAdmin = false;
      let buyerId = '';
      let listingId = '';
      let listingTitle = 'Marketplace Asset';

      try {
        const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
        const db = getAdminFirestore(adminApp, cfg.firestoreDatabaseId);
        const bidRef = db.collection('bids').doc(bidId);
        await db.runTransaction(async (tx) => {
          const bidSnap = await tx.get(bidRef);
          if (!bidSnap.exists) throw new Error('BID_NOT_FOUND');
          const bidData = bidSnap.data() as Record<string, unknown>;
          listingId = String(bidData.listingId || '');
          buyerId = String(bidData.buyerId || '');
          const listingSnap = await tx.get(db.collection('listings').doc(listingId));
          if (!listingSnap.exists) throw new Error('LISTING_NOT_FOUND');
          const listingData = listingSnap.data() as Record<string, unknown>;
          listingTitle = String(listingData.title || 'Marketplace Asset');

          if (
            String(listingData.sellerId || '') !== caller.uid ||
            String(bidData.sellerId || '') !== caller.uid
          ) {
            throw new Error('FORBIDDEN_NOT_SELLER');
          }
          if (String(bidData.status || '') !== 'pending' || bidData.dealId) {
            throw new Error('BID_NOT_PENDING');
          }

          tx.update(bidRef, {
            status: 'rejected',
            updatedAt: FieldValue.serverTimestamp(),
          });

          const notifId = `ntf_bid_rej_${bidId}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
          tx.set(db.collection('notifications').doc(notifId), {
            recipientId: buyerId,
            actorId: caller.uid,
            actorRole: 'user',
            category: 'bid',
            severity: 'info',
            alertKind: 'normal',
            title: SELLER_REJECT_BID_COPY.buyerNotificationTitle,
            preview: SELLER_REJECT_BID_COPY.buyerNotificationBody,
            body: `${SELLER_REJECT_BID_COPY.buyerNotificationBody} Listing: "${listingTitle.slice(0, 90)}".`,
            refType: 'listing',
            refId: listingId,
            referenceLabel: listingTitle.slice(0, 100),
            destination: `/listing/${listingId}`,
            read: false,
            createdAtMs: Date.now(),
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        });
        updatedViaAdmin = true;
      } catch (txErr) {
        const code = txErr instanceof Error ? txErr.message : '';
        if (code === 'BID_NOT_FOUND' || code === 'LISTING_NOT_FOUND') {
          return res.status(404).json({ ok: false, error: 'Bid or listing not found.' });
        }
        if (code === 'FORBIDDEN_NOT_SELLER') {
          return res.status(403).json({
            ok: false,
            error: 'Only the verified listing owner can reject offers on this asset.',
          });
        }
        if (code === 'BID_NOT_PENDING') {
          return res.status(409).json({
            ok: false,
            error: 'This bid is no longer pending (it may have already been withdrawn, accepted, or rejected).',
          });
        }
      }

      if (!updatedViaAdmin) {
        const bidDoc = await restGetDoc(cfg, `bids/${bidId}`, caller.idToken);
        if (!bidDoc) {
          return res.status(404).json({ ok: false, error: 'Bid not found.' });
        }
        listingId = String(bidDoc.listingId || '');
        buyerId = String(bidDoc.buyerId || '');
        const listingDoc = await restGetDoc(cfg, `listings/${listingId}`, caller.idToken);
        if (!listingDoc) {
          return res.status(404).json({ ok: false, error: 'Listing not found.' });
        }
        listingTitle = String(listingDoc.title || 'Marketplace Asset');
        if (
          String(listingDoc.sellerId || '') !== caller.uid ||
          String(bidDoc.sellerId || '') !== caller.uid
        ) {
          return res.status(403).json({
            ok: false,
            error: 'Only the verified listing owner can reject offers on this asset.',
          });
        }
        if (String(bidDoc.status || '') !== 'pending' || bidDoc.dealId) {
          return res.status(409).json({
            ok: false,
            error: 'This bid is no longer pending and cannot be rejected.',
          });
        }

        const notifId = `ntf_bid_rej_${bidId}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
        const writes = [
          ...makeRestWriteWithServerTransforms(
            cfg,
            `bids/${bidId}`,
            { status: 'rejected' },
            ['updatedAt'],
            ['status'],
            true
          ),
          ...makeRestWriteWithServerTransforms(
            cfg,
            `notifications/${notifId}`,
            {
              recipientId: buyerId,
              actorId: caller.uid,
              actorRole: 'user',
              category: 'bid',
              severity: 'info',
              alertKind: 'normal',
              title: SELLER_REJECT_BID_COPY.buyerNotificationTitle,
              preview: SELLER_REJECT_BID_COPY.buyerNotificationBody,
              body: `${SELLER_REJECT_BID_COPY.buyerNotificationBody} Listing: "${listingTitle.slice(0, 90)}".`,
              refType: 'listing',
              refId: listingId,
              referenceLabel: listingTitle.slice(0, 100),
              destination: `/listing/${listingId}`,
              read: false,
              createdAtMs: Date.now(),
            },
            ['createdAt', 'updatedAt'],
            undefined,
            false
          ),
        ];
        const ok = await restCommitWrites(cfg, writes, caller.idToken);
        if (!ok) {
          return res.status(500).json({ ok: false, error: 'Could not reject bid right now.' });
        }
      }

      await appendAuditLog(cfg, caller.idToken, {
        actorId: caller.uid,
        action: 'SELLER_REJECTED_BID',
        targetType: 'bid',
        targetId: bidId,
        details: `Seller rejected pending bid ${bidId} on listing ${listingId}.`,
      });

      return res.json({
        ok: true,
        bidId,
        status: 'rejected',
        message: SELLER_REJECT_BID_COPY.successBanner,
      });
    } catch {
      return res.status(500).json({ ok: false, error: 'Failed to reject bid.' });
    }
  });

  // ---------------------------------------------------------------------------
  // 5. Admin Panel — ALL USERS Directory (Paginated, Searchable, PII-Protected)
  // ---------------------------------------------------------------------------
  async function loadAllUsersDatasetForAdmin(
    cfg: VerifiedFirebaseRuntimeConfig,
    adminIdToken: string
  ) {
    let publicDocs: Array<Record<string, unknown>> = [];
    let privateDocs: Array<Record<string, unknown>> = [];
    let restrictionDocs: Array<Record<string, unknown>> = [];
    let listingDocs: Array<Record<string, unknown>> = [];
    let dealDocs: Array<Record<string, unknown>> = [];
    const authUsersMap = new Map<
      string,
      {
        email: string;
        emailVerified: boolean;
        phoneNumber: string;
        disabled: boolean;
        creationTimeMs: number;
        lastSignInTimeMs: number;
      }
    >();

    // Optional Firebase Auth listUsers enrichment (graceful if IAM role is absent)
    try {
      const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
      const listRes = await getAdminAuth(adminApp).listUsers(1000);
      for (const u of listRes.users) {
        authUsersMap.set(u.uid, {
          email: String(u.email || '').toLowerCase(),
          emailVerified: Boolean(u.emailVerified),
          phoneNumber: String(u.phoneNumber || ''),
          disabled: Boolean(u.disabled),
          creationTimeMs: u.metadata?.creationTime ? Date.parse(u.metadata.creationTime) || 0 : 0,
          lastSignInTimeMs: u.metadata?.lastSignInTime ? Date.parse(u.metadata.lastSignInTime) || 0 : 0,
        });
      }
    } catch {
      // Proceed cleanly with Firestore collections
    }

    let loadedViaAdminSdk = false;
    try {
      const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
      const db = getAdminFirestore(adminApp, cfg.firestoreDatabaseId);
      const [pubSnap, privSnap, restSnap, listSnap, dealSnap] = await Promise.all([
        db.collection('publicProfiles').limit(500).get(),
        db.collection('privateUsers').limit(500).get(),
        db.collection('userRestrictions').limit(500).get(),
        db.collection('listings').limit(800).get(),
        db.collection('deals').limit(800).get(),
      ]);
      publicDocs = pubSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }));
      privateDocs = privSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }));
      restrictionDocs = restSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }));
      listingDocs = listSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }));
      dealDocs = dealSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }));
      loadedViaAdminSdk = true;
    } catch {
      loadedViaAdminSdk = false;
    }

    if (!loadedViaAdminSdk) {
      [publicDocs, privateDocs, restrictionDocs, listingDocs, dealDocs] = await Promise.all([
        restRunStructuredQuery(cfg, { from: [{ collectionId: 'publicProfiles' }], limit: 100 }, adminIdToken),
        restRunStructuredQuery(cfg, { from: [{ collectionId: 'privateUsers' }], limit: 300 }, adminIdToken),
        restRunStructuredQuery(cfg, { from: [{ collectionId: 'userRestrictions' }], limit: 300 }, adminIdToken),
        restRunStructuredQuery(cfg, { from: [{ collectionId: 'listings' }], limit: 400 }, adminIdToken),
        restRunStructuredQuery(cfg, { from: [{ collectionId: 'deals' }], limit: 400 }, adminIdToken),
      ]);
    }

    return {
      publicDocs,
      privateDocs,
      restrictionDocs,
      listingDocs,
      dealDocs,
      authUsersMap,
    };
  }

  app.get('/api/admin/users', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const adminCaller = await verifyAdminCaller(req, cfg);
    if (!adminCaller) {
      return res.status(403).json({ ok: false, error: 'Administrator authentication is required.' });
    }

    try {
      const { publicDocs, privateDocs, restrictionDocs, listingDocs, dealDocs, authUsersMap } =
        await loadAllUsersDatasetForAdmin(cfg, adminCaller.idToken);

      const pubByUid = new Map<string, Record<string, unknown>>();
      for (const d of publicDocs) {
        const uid = String(d.uid || d.id || '');
        if (uid) pubByUid.set(uid, d);
      }
      const privByUid = new Map<string, Record<string, unknown>>();
      for (const d of privateDocs) {
        const uid = String(d.uid || d.id || '');
        if (uid) privByUid.set(uid, d);
      }
      const restByUid = new Map<string, Record<string, unknown>>();
      for (const d of restrictionDocs) {
        const uid = String(d.userId || d.id || '');
        if (uid) restByUid.set(uid, d);
      }

      const listingsCountBySeller = new Map<string, { total: number; active: number }>();
      for (const l of listingDocs) {
        const sellerId = String(l.sellerId || '');
        if (!sellerId) continue;
        const curr = listingsCountBySeller.get(sellerId) || { total: 0, active: 0 };
        curr.total += 1;
        if (l.status === 'active' || l.status === 'reserved') curr.active += 1;
        listingsCountBySeller.set(sellerId, curr);
      }

      const dealsCountByUser = new Map<
        string,
        { buyerDeals: number; sellerDeals: number; activeDeals: number }
      >();
      const terminalDealSet = new Set(['settled', 'refunded', 'cancelled']);
      for (const dl of dealDocs) {
        const buyerId = String(dl.buyerId || '');
        const sellerId = String(dl.sellerId || '');
        const isActive = !terminalDealSet.has(String(dl.status || ''));
        if (buyerId) {
          const b = dealsCountByUser.get(buyerId) || { buyerDeals: 0, sellerDeals: 0, activeDeals: 0 };
          b.buyerDeals += 1;
          if (isActive) b.activeDeals += 1;
          dealsCountByUser.set(buyerId, b);
        }
        if (sellerId) {
          const s = dealsCountByUser.get(sellerId) || { buyerDeals: 0, sellerDeals: 0, activeDeals: 0 };
          s.sellerDeals += 1;
          if (isActive) s.activeDeals += 1;
          dealsCountByUser.set(sellerId, s);
        }
      }

      const allUids = new Set<string>([
        ...pubByUid.keys(),
        ...privByUid.keys(),
        ...authUsersMap.keys(),
      ]);

      const nowMs = Date.now();
      const sevenDaysAgoMs = nowMs - 7 * 24 * 3_600_000;

      const unifiedUsers = Array.from(allUids)
        .filter((uid) => Boolean(pubByUid.get(uid) || privByUid.get(uid) || authUsersMap.get(uid)))
        .map((uid) => {
          const pub = pubByUid.get(uid) || {};
          const priv = privByUid.get(uid) || {};
          const rest = restByUid.get(uid) || {};
          const authRec = authUsersMap.get(uid);
          const lStat = listingsCountBySeller.get(uid) || { total: 0, active: 0 };
          const dStat = dealsCountByUser.get(uid) || { buyerDeals: 0, sellerDeals: 0, activeDeals: 0 };

          const rawRestStatus = String(rest.accountStatus || 'active');
          let accountStatus: 'active' | 'warned' | 'restricted' | 'suspended' | 'banned' = 'active';
          if (rawRestStatus === 'permanent_ban' || authRec?.disabled) {
            accountStatus = 'banned';
          } else if (
            rawRestStatus === 'protective_suspension' ||
            rawRestStatus === 'temporary_suspension'
          ) {
            accountStatus = 'suspended';
          } else if (rawRestStatus === 'restricted') {
            accountStatus = 'restricted';
          } else if (rawRestStatus === 'warned') {
            accountStatus = 'warned';
          }

          const email = String(priv.email || authRec?.email || '').trim();
          const phone = String(priv.phone || authRec?.phoneNumber || '').trim();
          const phoneCountryCode = String(priv.phoneCountryCode || '').trim();
          const emailVerified = Boolean(priv.emailVerified || authRec?.emailVerified);
          const phoneVerified = Boolean(priv.phoneVerified || Boolean(authRec?.phoneNumber));
          const nidVerified = Boolean(pub.nidVerified || priv.nidStatus === 'verified');
          const createdAtMs =
            extractTimestampMs(pub.createdAt) ||
            extractTimestampMs(priv.createdAt) ||
            authRec?.creationTimeMs ||
            0;

          return {
            uid,
            displayName: String(pub.displayName || email.split('@')[0] || 'Member'),
            username: String(pub.username || ''),
            avatarUrl: typeof pub.avatarUrl === 'string' ? pub.avatarUrl : '',
            location: String(pub.location || ''),
            email,
            phone,
            phoneCountryCode,
            emailVerified,
            phoneVerified,
            nidVerified,
            nidStatus: String(priv.nidStatus || 'not_verified'),
            accountStatus,
            rawModerationStatus: rawRestStatus,
            activeStrikes: Number(rest.activeStrikes || 0),
            walletBalanceMinor: Number(priv.walletBalanceMinor || 0),
            reservedBalanceMinor: Number(priv.reservedBalanceMinor || 0),
            completedSales: Number(pub.completedSales || 0),
            completedPurchases: Number(pub.completedPurchases || 0),
            totalListings: lStat.total,
            activeListings: lStat.active,
            buyerDealsCount: dStat.buyerDeals,
            sellerDealsCount: dStat.sellerDeals,
            activeDealsCount: dStat.activeDeals,
            createdAtMs,
            lastSignInAtMs: authRec?.lastSignInTimeMs || null,
          };
        });

      // Compute summary KPIs across ALL registered users before search/filter slicing
      const summary = {
        totalUsers: unifiedUsers.length,
        activeUsers: unifiedUsers.filter((u) => u.accountStatus === 'active' || u.accountStatus === 'warned').length,
        suspendedUsers: unifiedUsers.filter(
          (u) => u.accountStatus === 'suspended' || u.accountStatus === 'restricted'
        ).length,
        bannedUsers: unifiedUsers.filter((u) => u.accountStatus === 'banned').length,
        verifiedUsers: unifiedUsers.filter((u) => u.emailVerified || u.phoneVerified || u.nidVerified).length,
        unverifiedUsers: unifiedUsers.filter((u) => !u.emailVerified && !u.phoneVerified && !u.nidVerified).length,
        recentlyRegistered7d: unifiedUsers.filter((u) => u.createdAtMs >= sevenDaysAgoMs).length,
      };

      const q = String(req.query.q || '').trim().toLowerCase();
      const qDigits = q.replace(/\D/g, '');
      const statusFilter = String(req.query.accountStatus || 'all');
      const emailVerFilter = String(req.query.emailVerified || 'all');
      const phoneVerFilter = String(req.query.phoneVerified || 'all');
      const sellerFilter = String(req.query.sellerStatus || 'all');
      const buyerFilter = String(req.query.buyerActivity || 'all');
      const registeredDays = Number(req.query.registeredDays || 0);

      if (q.length >= 2) {
        await appendAuditLog(cfg, adminCaller.idToken, {
          actorId: adminCaller.uid,
          action: 'ADMIN_SEARCHED_USERS_DIRECTORY',
          targetType: 'users_directory',
          targetId: 'search',
          details: `Admin (${adminCaller.role}) searched ALL USERS directory (queryLen=${q.length}).`,
        });
      }

      const filtered = unifiedUsers.filter((u) => {
        if (q) {
          const phoneDigits = u.phone.replace(/\D/g, '');
          const matchesQuery =
            u.uid.toLowerCase().includes(q) ||
            u.username.toLowerCase().includes(q.replace(/^@/, '')) ||
            u.displayName.toLowerCase().includes(q) ||
            u.email.toLowerCase().includes(q) ||
            u.phone.toLowerCase().includes(q) ||
            (qDigits.length >= 5 && phoneDigits.includes(qDigits));
          if (!matchesQuery) return false;
        }
        if (statusFilter !== 'all' && u.accountStatus !== statusFilter) return false;
        if (emailVerFilter === 'verified' && !u.emailVerified) return false;
        if (emailVerFilter === 'unverified' && u.emailVerified) return false;
        if (phoneVerFilter === 'verified' && !u.phoneVerified) return false;
        if (phoneVerFilter === 'unverified' && u.phoneVerified) return false;
        if (sellerFilter === 'has_listings' && u.totalListings === 0) return false;
        if (sellerFilter === 'verified_seller' && !u.nidVerified) return false;
        if (sellerFilter === 'no_listings' && u.totalListings > 0) return false;
        if (buyerFilter === 'has_purchases' && u.completedPurchases === 0 && u.buyerDealsCount === 0) {
          return false;
        }
        if (registeredDays > 0 && u.createdAtMs < nowMs - registeredDays * 24 * 3_600_000) {
          return false;
        }
        return true;
      });

      filtered.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));

      const pageSize = Math.max(1, Math.min(25, Number(req.query.pageSize) || 15));
      const totalMatched = filtered.length;
      const totalPages = Math.max(1, Math.ceil(totalMatched / pageSize));
      const page = Math.max(1, Math.min(totalPages, Number(req.query.page) || 1));
      const start = (page - 1) * pageSize;
      const items = filtered.slice(start, start + pageSize);

      return res.json({
        ok: true,
        adminRole: adminCaller.role,
        summary,
        pagination: {
          page,
          pageSize,
          totalMatched,
          totalPages,
        },
        users: items,
      });
    } catch {
      return res.status(500).json({
        ok: false,
        error: 'Could not load registered users directory right now.',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 6. Admin Complete User Profile Inspection (Real DB Records + PII Audit Log)
  // ---------------------------------------------------------------------------
  async function loadUserInspectionRecord(
    cfg: VerifiedFirebaseRuntimeConfig,
    targetUid: string,
    adminIdToken: string
  ) {
    let pub: Record<string, unknown> | null = null;
    let priv: Record<string, unknown> | null = null;
    let nidDoc: Record<string, unknown> | null = null;
    let restriction: Record<string, unknown> | null = null;
    let adminRecord: Record<string, unknown> | null = null;
    let listings: Array<Record<string, unknown>> = [];
    let buyerDeals: Array<Record<string, unknown>> = [];
    let sellerDeals: Array<Record<string, unknown>> = [];
    let buyerBids: Array<Record<string, unknown>> = [];
    let sellerAcceptedBids: Array<Record<string, unknown>> = [];
    let deposits: Array<Record<string, unknown>> = [];
    let withdrawals: Array<Record<string, unknown>> = [];
    let walletLedger: Array<Record<string, unknown>> = [];
    let reportsAgainst: Array<Record<string, unknown>> = [];
    let reportsSubmitted: Array<Record<string, unknown>> = [];
    let appeals: Array<Record<string, unknown>> = [];
    let recentAuditLogs: Array<Record<string, unknown>> = [];
    let authMeta: {
      existsInAuth: boolean;
      email: string;
      emailVerified: boolean;
      phoneNumber: string;
      disabled: boolean;
      creationTimeMs: number | null;
      lastSignInTimeMs: number | null;
      providers: string[];
    } | null = null;

    try {
      const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
      const u = await getAdminAuth(adminApp).getUser(targetUid);
      authMeta = {
        existsInAuth: true,
        email: String(u.email || ''),
        emailVerified: Boolean(u.emailVerified),
        phoneNumber: String(u.phoneNumber || ''),
        disabled: Boolean(u.disabled),
        creationTimeMs: u.metadata?.creationTime ? Date.parse(u.metadata.creationTime) || null : null,
        lastSignInTimeMs: u.metadata?.lastSignInTime ? Date.parse(u.metadata.lastSignInTime) || null : null,
        providers: (u.providerData || []).map((p) => p.providerId),
      };
    } catch {
      authMeta = null;
    }

    let loadedViaAdmin = false;
    try {
      const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
      const db = getAdminFirestore(adminApp, cfg.firestoreDatabaseId);
      const [
        pubSnap,
        privSnap,
        nidSnap,
        restSnap,
        admSnap,
        listSnap,
        bDealsSnap,
        sDealsSnap,
        bBidsSnap,
        sBidsSnap,
        depSnap,
        wdSnap,
        ledSnap,
        repAgainstSnap,
        repSubSnap,
        appSnap,
        audSnap,
      ] = await Promise.all([
        db.collection('publicProfiles').doc(targetUid).get(),
        db.collection('privateUsers').doc(targetUid).get(),
        db.collection('identityVerifications').doc(targetUid).get(),
        db.collection('userRestrictions').doc(targetUid).get(),
        db.collection('admins').doc(targetUid).get(),
        db.collection('listings').where('sellerId', '==', targetUid).get(),
        db.collection('deals').where('buyerId', '==', targetUid).get(),
        db.collection('deals').where('sellerId', '==', targetUid).get(),
        db.collection('bids').where('buyerId', '==', targetUid).get(),
        db.collection('bids').where('sellerId', '==', targetUid).get(),
        db.collection('deposits').where('userId', '==', targetUid).get(),
        db.collection('withdrawals').where('userId', '==', targetUid).get(),
        db.collection('walletLedger').where('userId', '==', targetUid).get(),
        db.collection('userReports').where('reportedUserId', '==', targetUid).get(),
        db.collection('userReports').where('reporterId', '==', targetUid).get(),
        db.collection('accountAppeals').where('userId', '==', targetUid).get(),
        db.collection('auditLogs').where('actorId', '==', targetUid).limit(30).get(),
      ]);

      pub = pubSnap.exists ? { id: pubSnap.id, ...(pubSnap.data() as Record<string, unknown>) } : null;
      priv = privSnap.exists ? { id: privSnap.id, ...(privSnap.data() as Record<string, unknown>) } : null;
      nidDoc = nidSnap.exists ? { id: nidSnap.id, ...(nidSnap.data() as Record<string, unknown>) } : null;
      restriction = restSnap.exists ? { id: restSnap.id, ...(restSnap.data() as Record<string, unknown>) } : null;
      adminRecord = admSnap.exists ? { id: admSnap.id, ...(admSnap.data() as Record<string, unknown>) } : null;
      listings = listSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }));
      buyerDeals = bDealsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }));
      sellerDeals = sDealsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }));
      buyerBids = bBidsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }));
      sellerAcceptedBids = sBidsSnap.docs
        .map((d): Record<string, unknown> => ({
          id: d.id,
          ...(d.data() as Record<string, unknown>),
        }))
        .filter((b) =>
          ['accepted_pending_payment', 'accepted', 'paid'].includes(String(b.status || ''))
        );
      deposits = depSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }));
      withdrawals = wdSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }));
      walletLedger = ledSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }));
      reportsAgainst = repAgainstSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }));
      reportsSubmitted = repSubSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }));
      appeals = appSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }));
      recentAuditLogs = audSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }));
      loadedViaAdmin = true;
    } catch {
      loadedViaAdmin = false;
    }

    if (!loadedViaAdmin) {
      const eq = (fieldPath: string) => ({
        fieldFilter: {
          field: { fieldPath },
          op: 'EQUAL',
          value: { stringValue: targetUid },
        },
      });
      [
        pub,
        priv,
        nidDoc,
        restriction,
        adminRecord,
        listings,
        buyerDeals,
        sellerDeals,
        buyerBids,
        sellerAcceptedBids,
        deposits,
        withdrawals,
        walletLedger,
        reportsAgainst,
        reportsSubmitted,
        appeals,
        recentAuditLogs,
      ] = await Promise.all([
        restGetDoc(cfg, `publicProfiles/${targetUid}`, adminIdToken).catch(() => null),
        restGetDoc(cfg, `privateUsers/${targetUid}`, adminIdToken).catch(() => null),
        restGetDoc(cfg, `identityVerifications/${targetUid}`, adminIdToken).catch(() => null),
        restGetDoc(cfg, `userRestrictions/${targetUid}`, adminIdToken).catch(() => null),
        restGetDoc(cfg, `admins/${targetUid}`, adminIdToken).catch(() => null),
        restRunStructuredQuery(cfg, { from: [{ collectionId: 'listings' }], where: eq('sellerId'), limit: 100 }, adminIdToken),
        restRunStructuredQuery(cfg, { from: [{ collectionId: 'deals' }], where: eq('buyerId'), limit: 100 }, adminIdToken),
        restRunStructuredQuery(cfg, { from: [{ collectionId: 'deals' }], where: eq('sellerId'), limit: 100 }, adminIdToken),
        restRunStructuredQuery(cfg, { from: [{ collectionId: 'bids' }], where: eq('buyerId'), limit: 100 }, adminIdToken),
        restRunStructuredQuery(cfg, { from: [{ collectionId: 'bids' }], where: eq('sellerId'), limit: 100 }, adminIdToken),
        restRunStructuredQuery(cfg, { from: [{ collectionId: 'deposits' }], where: eq('userId'), limit: 50 }, adminIdToken),
        restRunStructuredQuery(cfg, { from: [{ collectionId: 'withdrawals' }], where: eq('userId'), limit: 50 }, adminIdToken),
        restRunStructuredQuery(cfg, { from: [{ collectionId: 'walletLedger' }], where: eq('userId'), limit: 80 }, adminIdToken),
        restRunStructuredQuery(cfg, { from: [{ collectionId: 'userReports' }], where: eq('reportedUserId'), limit: 50 }, adminIdToken),
        restRunStructuredQuery(cfg, { from: [{ collectionId: 'userReports' }], where: eq('reporterId'), limit: 50 }, adminIdToken),
        restRunStructuredQuery(cfg, { from: [{ collectionId: 'accountAppeals' }], where: eq('userId'), limit: 30 }, adminIdToken),
        restRunStructuredQuery(cfg, { from: [{ collectionId: 'auditLogs' }], where: eq('actorId'), limit: 30 }, adminIdToken),
      ]);
      sellerAcceptedBids = sellerAcceptedBids.filter((b) =>
        ['accepted_pending_payment', 'accepted', 'paid'].includes(String(b.status || ''))
      );
    }

    return {
      loadedViaAdmin,
      pub,
      priv,
      nidDoc,
      restriction,
      adminRecord,
      authMeta,
      listings,
      buyerDeals,
      sellerDeals,
      buyerBids,
      sellerAcceptedBids,
      deposits,
      withdrawals,
      walletLedger,
      reportsAgainst,
      reportsSubmitted,
      appeals,
      recentAuditLogs,
    };
  }

  app.get('/api/admin/users/:uid/inspect', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const adminCaller = await verifyAdminCaller(req, cfg);
    if (!adminCaller) {
      return res.status(403).json({ ok: false, error: 'Administrator authentication is required.' });
    }
    const targetUid = String(req.params.uid || '').trim();
    if (!VALID_ID_REGEX.test(targetUid)) {
      return res.status(400).json({ ok: false, error: 'Invalid user ID.' });
    }

    try {
      const data = await loadUserInspectionRecord(cfg, targetUid, adminCaller.idToken);
      if (!data.pub && !data.priv && !data.authMeta) {
        return res.status(404).json({ ok: false, error: 'User account not found.' });
      }

      await appendAuditLog(cfg, adminCaller.idToken, {
        actorId: adminCaller.uid,
        action: 'ADMIN_USER_PROFILE_INSPECTED',
        targetType: 'user',
        targetId: targetUid,
        details: `Admin (${adminCaller.role}) inspected full user profile & contact verification record.`,
      });

      const allDealsMap = new Map<string, Record<string, unknown>>();
      for (const d of [...data.buyerDeals, ...data.sellerDeals]) {
        const id = String(d.id || '');
        if (id) allDealsMap.set(id, d);
      }
      const allDeals = Array.from(allDealsMap.values()).sort(
        (a, b) => extractTimestampMs(b.createdAt) - extractTimestampMs(a.createdAt)
      );
      const terminalDealSet = new Set(['settled', 'refunded', 'cancelled']);
      const activeDeals = allDeals.filter((d) => !terminalDealSet.has(String(d.status || '')));
      const completedDeals = allDeals.filter((d) => d.status === 'settled');
      const cancelledOrRefundedDeals = allDeals.filter(
        (d) => d.status === 'cancelled' || d.status === 'refunded'
      );

      const email = String(data.priv?.email || data.authMeta?.email || '');
      const phone = String(data.priv?.phone || data.authMeta?.phoneNumber || '');
      const phoneCountryCode = String(data.priv?.phoneCountryCode || '');
      const emailVerified = Boolean(data.priv?.emailVerified || data.authMeta?.emailVerified);
      const phoneVerified = Boolean(
        data.priv?.phoneVerified || Boolean(data.authMeta?.phoneNumber)
      );
      const createdAtMs =
        extractTimestampMs(data.pub?.createdAt) ||
        extractTimestampMs(data.priv?.createdAt) ||
        data.authMeta?.creationTimeMs ||
        null;

      const sortedLedger = [...data.walletLedger]
        .map((e) => ({
          id: String(e.id || ''),
          kind: String(e.kind || ''),
          amountMinor: Number(e.amountMinor || 0),
          currency: String(e.currency || 'BDT'),
          referenceId: String(e.referenceId || ''),
          note: String(e.note || ''),
          createdAtMs: extractTimestampMs(e.createdAt),
        }))
        .sort((a, b) => b.createdAtMs - a.createdAtMs)
        .slice(0, 30);

      const sortedListings = [...data.listings]
        .map((l) => ({
          id: String(l.id || ''),
          title: String(l.title || ''),
          platform: String(l.platform || ''),
          subcategory: String(l.subcategory || ''),
          priceMinor: Number(l.priceMinor || 0),
          currency: String(l.currency || 'BDT'),
          status: String(l.status || ''),
          imagesCount: Array.isArray(l.images) ? l.images.length : 0,
          createdAtMs: extractTimestampMs(l.createdAt),
        }))
        .sort((a, b) => b.createdAtMs - a.createdAtMs);

      return res.json({
        ok: true,
        adminRole: adminCaller.role,
        profile: {
          basicInfo: {
            uid: targetUid,
            displayName: String(data.pub?.displayName || email.split('@')[0] || 'Member'),
            username: String(data.pub?.username || ''),
            avatarUrl: typeof data.pub?.avatarUrl === 'string' ? data.pub.avatarUrl : '',
            bio: String(data.pub?.bio || ''),
            location: String(data.pub?.location || ''),
            createdAtMs,
            email,
            emailVerified,
            phone,
            phoneCountryCode,
            phoneVerified,
            nidStatus: String(data.priv?.nidStatus || (data.nidDoc?.status as string) || 'not_verified'),
            nidVerified: Boolean(data.pub?.nidVerified || data.priv?.nidStatus === 'verified'),
            adminRoleAssigned: data.adminRecord ? String(data.adminRecord.role || 'admin') : null,
            authProviders: data.authMeta?.providers || [],
            authDisabled: Boolean(data.authMeta?.disabled),
          },
          marketplaceInfo: {
            totalListings: sortedListings.length,
            activeListings: sortedListings.filter((l) => l.status === 'active').length,
            pendingListings: sortedListings.filter((l) => l.status === 'pending').length,
            rejectedListings: sortedListings.filter((l) => l.status === 'rejected').length,
            soldListings: sortedListings.filter((l) => l.status === 'sold').length,
            totalPurchases: Number(data.pub?.completedPurchases || 0),
            totalSales: Number(data.pub?.completedSales || 0),
            completedDealsCount: completedDeals.length,
            cancelledOrRefundedDealsCount: cancelledOrRefundedDeals.length,
            activeDealsCount: activeDeals.length,
            listings: sortedListings.slice(0, 25),
            recentDeals: allDeals.slice(0, 20).map((d) => ({
              id: String(d.id || ''),
              listingTitle: String(d.listingTitle || ''),
              role: String(d.buyerId || '') === targetUid ? 'buyer' : 'seller',
              baseAmountMinor: Number(d.baseAmountMinor || 0),
              currency: String(d.currency || 'BDT'),
              status: String(d.status || ''),
              createdAtMs: extractTimestampMs(d.createdAt),
            })),
          },
          walletInfo: {
            walletBalanceMinor: Number(data.priv?.walletBalanceMinor || 0),
            reservedBalanceMinor: Number(data.priv?.reservedBalanceMinor || 0),
            pendingDepositsCount: data.deposits.filter((d) => d.status === 'pending').length,
            approvedDepositsCount: data.deposits.filter((d) => d.status === 'approved').length,
            pendingWithdrawalsCount: data.withdrawals.filter((w) => w.status === 'pending').length,
            paidWithdrawalsCount: data.withdrawals.filter((w) => w.status === 'paid').length,
            ledgerEntries: sortedLedger,
          },
          securityModerationInfo: {
            accountStatus: String(data.restriction?.accountStatus || 'active'),
            activeStrikes: Number(data.restriction?.activeStrikes || 0),
            totalHistoricalStrikes: Number(data.restriction?.totalHistoricalStrikes || 0),
            financialHoldActive: Boolean(data.restriction?.financialHoldActive),
            reason: String(data.restriction?.reason || ''),
            latestWarningTitle: String(data.restriction?.latestWarningTitle || ''),
            reportsAgainstCount: data.reportsAgainst.length,
            openReportsAgainstCount: data.reportsAgainst.filter((r) =>
              ['submitted', 'under_review', 'needs_info'].includes(String(r.status || ''))
            ).length,
            reportsSubmittedCount: data.reportsSubmitted.length,
            appealsCount: data.appeals.length,
            reportsAgainst: data.reportsAgainst.slice(0, 15).map((r) => ({
              id: String(r.id || ''),
              trackingRef: String(r.trackingRef || ''),
              category: String(r.category || ''),
              surface: String(r.surface || ''),
              status: String(r.status || ''),
              createdAtMs: extractTimestampMs(r.createdAt),
            })),
            appeals: data.appeals.slice(0, 10).map((a) => ({
              id: String(a.id || ''),
              trackingRef: String(a.trackingRef || ''),
              status: String(a.status || ''),
              explanation: String(a.explanation || '').slice(0, 300),
              createdAtMs: extractTimestampMs(a.createdAt),
            })),
          },
          activityInfo: {
            lastSignInAtMs: data.authMeta?.lastSignInTimeMs || null,
            recentAuditEvents: data.recentAuditLogs
              .map((ev) => ({
                id: String(ev.id || ''),
                action: String(ev.action || ''),
                targetType: String(ev.targetType || ''),
                targetId: String(ev.targetId || ''),
                details: String(ev.details || ''),
                createdAtMs: extractTimestampMs(ev.createdAt),
              }))
              .sort((a, b) => b.createdAtMs - a.createdAtMs)
              .slice(0, 20),
          },
        },
      });
    } catch {
      return res.status(500).json({ ok: false, error: 'Failed to inspect user profile.' });
    }
  });

  // ---------------------------------------------------------------------------
  // 7. Superadmin Permanent User Deletion (Preflight + Multi-Service Cleanup)
  // ---------------------------------------------------------------------------
  async function computeAdminUserDeletePreflight(
    cfg: VerifiedFirebaseRuntimeConfig,
    adminCaller: VerifiedAdminCaller,
    targetUid: string
  ) {
    const data = await loadUserInspectionRecord(cfg, targetUid, adminCaller.idToken);
    if (!data.pub && !data.priv && !data.authMeta) {
      return { found: false as const };
    }

    const terminalDealSet = new Set(['settled', 'refunded', 'cancelled']);
    const allDeals = [...data.buyerDeals, ...data.sellerDeals];
    const uniqueActiveDeals = new Set(
      allDeals
        .filter((d) => !terminalDealSet.has(String(d.status || '')))
        .map((d) => String(d.id || ''))
    );

    const openDisputesCount = allDeals.reduce(
      (sum, d) => sum + Math.max(0, Number(d.unresolvedReportCount || 0)),
      0
    );

    const buyerAcceptedBids = data.buyerBids.filter((b) =>
      ['accepted_pending_payment', 'accepted', 'paid'].includes(String(b.status || ''))
    );
    const acceptedObligationBidsCount =
      buyerAcceptedBids.filter((b) => b.status === 'accepted_pending_payment').length +
      data.sellerAcceptedBids.filter((b) => b.status === 'accepted_pending_payment').length;

    const openModerationInvestigationsCount =
      data.reportsAgainst.filter((r) =>
        ['submitted', 'under_review', 'needs_info'].includes(String(r.status || ''))
      ).length +
      data.appeals.filter((a) => ['pending', 'under_review'].includes(String(a.status || ''))).length;

    const walletBalanceMinor = Number(data.priv?.walletBalanceMinor || 0);
    const reservedBalanceMinor = Number(data.priv?.reservedBalanceMinor || 0);
    const pendingDepositsCount = data.deposits.filter((d) => d.status === 'pending').length;
    const pendingWithdrawalsCount = data.withdrawals.filter((w) => w.status === 'pending').length;
    const financialHoldActive = Boolean(data.restriction?.financialHoldActive);

    const eligibility = evaluateAdminUserDeletionEligibility({
      callerRole: adminCaller.role,
      callerUid: adminCaller.uid,
      targetUid,
      walletBalanceMinor,
      reservedBalanceMinor,
      financialHoldActive,
      activeDealsCount: uniqueActiveDeals.size,
      acceptedObligationBidsCount,
      pendingDepositsCount,
      pendingWithdrawalsCount,
      openDisputesCount,
      openModerationInvestigationsCount,
    });

    const email = String(data.priv?.email || data.authMeta?.email || '');
    return {
      found: true as const,
      data,
      eligibility,
      summary: {
        uid: targetUid,
        displayName: String(data.pub?.displayName || email.split('@')[0] || 'Member'),
        username: String(data.pub?.username || ''),
        email,
        listingsCount: data.listings.length,
        activeDealsCount: uniqueActiveDeals.size,
        walletBalanceMinor,
        reservedBalanceMinor,
        pendingObligationsCount:
          uniqueActiveDeals.size +
          acceptedObligationBidsCount +
          pendingDepositsCount +
          pendingWithdrawalsCount +
          openDisputesCount,
      },
    };
  }

  app.get('/api/admin/users/:uid/delete-preflight', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const adminCaller = await verifyAdminCaller(req, cfg);
    if (!adminCaller) {
      return res.status(403).json({ ok: false, error: 'Administrator authentication is required.' });
    }
    const targetUid = String(req.params.uid || '').trim();
    if (!VALID_ID_REGEX.test(targetUid)) {
      return res.status(400).json({ ok: false, error: 'Invalid user ID.' });
    }

    try {
      const check = await computeAdminUserDeletePreflight(cfg, adminCaller, targetUid);
      if (!check.found) {
        return res.status(404).json({ ok: false, error: 'User account not found.' });
      }
      return res.json({
        ok: true,
        eligible: check.eligibility.eligible,
        blockers: check.eligibility.blockers,
        summary: check.summary,
      });
    } catch {
      return res.status(500).json({ ok: false, error: 'Could not run user deletion preflight check.' });
    }
  });

  app.post('/api/admin/users/:uid/permanent-delete', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    const adminCaller = await verifyAdminCaller(req, cfg);
    if (!adminCaller || adminCaller.role !== 'superadmin') {
      return res.status(403).json({
        ok: false,
        error: 'Only a verified Superadmin can permanently delete user accounts.',
      });
    }

    const targetUid = String(req.params.uid || '').trim();
    if (!VALID_ID_REGEX.test(targetUid)) {
      return res.status(400).json({ ok: false, error: 'Invalid user ID.' });
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const confirmPhrase = String(body.confirmPhrase || '').trim();
    const reason = String(body.reason || '').trim();
    const retainEmailSecurityBlock = body.retainEmailSecurityBlock === true;

    if (confirmPhrase !== 'DELETE USER') {
      return res.status(400).json({
        ok: false,
        error: 'Type DELETE USER exactly to confirm permanent account deletion.',
      });
    }
    if (reason.length < 6 || reason.length > 500) {
      return res.status(400).json({
        ok: false,
        error: 'Provide an administrative deletion reason (6–500 characters) for the audit log.',
      });
    }

    try {
      const check = await computeAdminUserDeletePreflight(cfg, adminCaller, targetUid);
      if (!check.found) {
        return res.status(404).json({ ok: false, error: 'User account not found or already deleted.' });
      }
      if (!check.eligibility.eligible) {
        return res.status(409).json({
          ok: false,
          eligible: false,
          blockers: check.eligibility.blockers,
          error: check.eligibility.blockers[0] || 'User cannot be deleted due to active obligations.',
        });
      }

      const { data, summary } = check;
      let firebaseAuthDeleted = false;

      // Step 1: Revoke sessions & delete Firebase Authentication record so email is freed for clean re-registration
      try {
        const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
        const auth = getAdminAuth(adminApp);
        await auth.revokeRefreshTokens(targetUid).catch(() => undefined);
        await auth.deleteUser(targetUid);
        firebaseAuthDeleted = true;
      } catch (authErr) {
        const errCode =
          authErr && typeof authErr === 'object' && 'code' in authErr
            ? String((authErr as { code?: unknown }).code || '')
            : '';
        if (errCode === 'auth/user-not-found') {
          firebaseAuthDeleted = true;
        }
      }

      // Step 2: Delete Storage NID artifacts if present (non-fatal)
      try {
        if (cfg.storageBucket) {
          const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
          const bucket = getAdminStorage(adminApp).bucket(cfg.storageBucket);
          await bucket.deleteFiles({ prefix: `nid_documents/${targetUid}/` });
        }
      } catch {
        // Non-fatal
      }

      // Step 3: Delete user documents & non-transactional listings while preserving immutable ledgers/audit/moderation logs
      const removableListings = data.listings.filter((l) =>
        ['draft', 'pending', 'active', 'rejected', 'archived'].includes(String(l.status || ''))
      );
      const pendingBuyerBids = data.buyerBids.filter(
        (b) => String(b.status || '') === 'pending' && !b.dealId
      );

      let firestoreCleaned = false;
      if (data.loadedViaAdmin) {
        try {
          const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
          const db = getAdminFirestore(adminApp, cfg.firestoreDatabaseId);
          const batch = db.batch();

          for (const b of pendingBuyerBids) {
            const bidId = String(b.id || '');
            if (bidId) {
              batch.update(db.collection('bids').doc(bidId), {
                status: 'withdrawn',
                updatedAt: FieldValue.serverTimestamp(),
              });
            }
          }

          for (const l of removableListings) {
            const lid = String(l.id || '');
            if (lid) {
              batch.delete(db.collection('listings').doc(lid));
              batch.delete(db.collection('listingEvidence').doc(lid));
            }
          }

          if (summary.username) {
            batch.delete(db.collection('usernames').doc(summary.username.toLowerCase()));
          }
          batch.delete(db.collection('admins').doc(targetUid));
          batch.delete(db.collection('identityVerifications').doc(targetUid));
          batch.delete(db.collection('publicProfiles').doc(targetUid));
          batch.delete(db.collection('privateUsers').doc(targetUid));

          if (retainEmailSecurityBlock && summary.email) {
            const emailHash = crypto
              .createHash('sha256')
              .update(`email:${summary.email.toLowerCase()}`)
              .digest('hex');
            batch.set(db.collection('bannedIdentities').doc(`email_${emailHash.slice(0, 48)}`), {
              identityHash: emailHash,
              kind: 'email',
              reason: reason.slice(0, 600),
              enforcedBy: adminCaller.uid,
              createdAtMs: Date.now(),
              createdAt: FieldValue.serverTimestamp(),
            });
          }

          await batch.commit();
          firestoreCleaned = true;
        } catch {
          firestoreCleaned = false;
        }
      }

      if (!firestoreCleaned) {
        const writes: Array<Record<string, unknown>> = [];
        for (const b of pendingBuyerBids) {
          const bidId = String(b.id || '');
          if (bidId) {
            writes.push(
              ...makeRestWriteWithServerTransforms(
                cfg,
                `bids/${bidId}`,
                { status: 'withdrawn' },
                ['updatedAt'],
                ['status'],
                true
              )
            );
          }
        }
        for (const l of removableListings) {
          const lid = String(l.id || '');
          if (lid) {
            writes.push({ delete: docFullName(cfg, `listings/${lid}`) });
          }
        }
        if (summary.username) {
          writes.push({ delete: docFullName(cfg, `usernames/${summary.username.toLowerCase()}`) });
        }
        if (data.adminRecord) {
          writes.push({ delete: docFullName(cfg, `admins/${targetUid}`) });
        }
        if (data.nidDoc) {
          writes.push({ delete: docFullName(cfg, `identityVerifications/${targetUid}`) });
        }
        if (data.pub) {
          writes.push({ delete: docFullName(cfg, `publicProfiles/${targetUid}`) });
        }
        if (data.priv) {
          writes.push({ delete: docFullName(cfg, `privateUsers/${targetUid}`) });
        }
        if (retainEmailSecurityBlock && summary.email) {
          const emailHash = crypto
            .createHash('sha256')
            .update(`email:${summary.email.toLowerCase()}`)
            .digest('hex');
          writes.push(
            ...makeRestWriteWithServerTransforms(
              cfg,
              `bannedIdentities/email_${emailHash.slice(0, 48)}`,
              {
                identityHash: emailHash,
                kind: 'email',
                reason: reason.slice(0, 600),
                enforcedBy: adminCaller.uid,
                createdAtMs: Date.now(),
              },
              ['createdAt'],
              undefined,
              false
            )
          );
        }
        firestoreCleaned = await restCommitWrites(cfg, writes, adminCaller.idToken);
      }

      if (!firestoreCleaned) {
        return res.status(500).json({
          ok: false,
          error: 'Could not complete Firestore profile deletion. Please check permissions and retry.',
        });
      }

      await appendAuditLog(cfg, adminCaller.idToken, {
        actorId: adminCaller.uid,
        action: 'USER_PERMANENTLY_DELETED',
        targetType: 'user',
        targetId: targetUid,
        details: `Superadmin permanently deleted user @${summary.username || targetUid} (removedListings=${
          removableListings.length
        }, authDeleted=${firebaseAuthDeleted}, retainEmailSecurityBlock=${retainEmailSecurityBlock}). Reason: ${reason}`,
      });

      return res.json({
        ok: true,
        deletedUid: targetUid,
        firebaseAuthDeleted,
        removedListingsCount: removableListings.length,
        retainEmailSecurityBlock,
        message: 'USER ACCOUNT PERMANENTLY DELETED',
      });
    } catch {
      return res.status(500).json({
        ok: false,
        error: 'An error occurred during permanent user deletion.',
      });
    }
  });

  /**
   * POST /api/listings/:listingId/view
   * Authoritative, real-time asset view counter endpoint.
   * Increments the public view count ONLY when a user/guest actually opens the asset details.
   * Deduplicates repeated visits within a 30-minute sliding window.
   * Excludes seller self-views and inactive listings.
   */
  app.post('/api/listings/:listingId/view', async (req, res) => {
    const listingId = String(req.params.listingId || '').trim();
    if (!VALID_ID_REGEX.test(listingId)) {
      return res.status(400).json({ ok: false, error: 'Invalid listing ID format.' });
    }

    const clientKey = getCallerClientKey(req);
    if (!viewCounterLimiter.consume(`view:${clientKey}`).allowed) {
      return res.status(429).json({
        ok: false,
        error: 'Too many view count requests. Please wait a moment.',
      });
    }

    const cfg = loadVerifiedFirebaseConfig();
    if (!cfg.configValid) {
      return res.status(503).json({ ok: false, error: 'Firebase configuration is unavailable.' });
    }

    // Caller can be authenticated or anonymous/guest
    let callerUid: string | null = null;
    try {
      const caller = await verifyCallerFirebaseToken(req, cfg);
      if (caller?.uid) {
        callerUid = caller.uid;
      }
    } catch {
      // Guest viewer (unauthenticated)
    }

    const viewerToken =
      typeof req.body?.viewerToken === 'string' ? req.body.viewerToken.trim() : undefined;
    const viewerKey = normalizeViewerKey({
      callerUid,
      viewerToken,
      clientIp: clientKey,
    });

    // Check sliding window deduplication cache first
    if (viewCounterCache.hasRecentView(listingId, viewerKey)) {
      return res.json({
        ok: true,
        counted: false,
        reason: 'deduplicated',
        message: 'View already recorded recently within the deduplication window.',
      });
    }

    try {
      const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
      const db = getAdminFirestore(adminApp, cfg.firestoreDatabaseId);
      const listingRef = db.collection('listings').doc(listingId);

      const result = await db.runTransaction(async (transaction) => {
        const docSnap = await transaction.get(listingRef);
        if (!docSnap.exists) {
          return { notFound: true, qualified: false, reason: 'not_found', currentViews: 0, newViews: 0 };
        }
        const data = docSnap.data() || {};
        const sellerId = typeof data.sellerId === 'string' ? data.sellerId : '';
        const status = typeof data.status === 'string' ? data.status : 'active';
        const existingViews =
          typeof data.views === 'number' && Number.isFinite(data.views)
            ? Math.max(0, Math.floor(data.views))
            : 0;

        const evalResult = evaluateViewQualification({
          listingId,
          sellerId,
          viewerKey,
          callerUid,
          listingStatus: status,
        });

        if (!evalResult.qualifies) {
          return {
            notFound: false,
            qualified: false,
            reason: evalResult.reason,
            currentViews: existingViews,
            newViews: existingViews,
          };
        }

        const nextViews = existingViews + 1;
        transaction.update(listingRef, {
          views: FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
        });

        return {
          notFound: false,
          qualified: true,
          reason: 'qualified',
          currentViews: existingViews,
          newViews: nextViews,
        };
      });

      if (result.notFound) {
        return res.status(404).json({ ok: false, error: 'Listing not found.' });
      }

      if (!result.qualified) {
        return res.json({
          ok: true,
          counted: false,
          reason: result.reason,
          views: result.currentViews,
        });
      }

      // Record in deduplication sliding cache
      viewCounterCache.recordView(listingId, viewerKey);

      return res.json({
        ok: true,
        counted: true,
        views: result.newViews,
      });
    } catch (err) {
      return res.json({
        ok: false,
        counted: false,
        reason: 'server_credentials_unavailable',
        message: 'Client-side Firestore rules update will be used.',
      });
    }
  });
}
