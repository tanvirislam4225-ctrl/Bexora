import crypto from 'node:crypto';
import type express from 'express';
import type { App as AdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore as getAdminFirestore } from 'firebase-admin/firestore';
import {
  POPUP_THEME_LIBRARY,
  computePopupNotificationDashboardStats,
  isPopupCampaignLiveNow,
  mergePopupStyleWithThemeDefaults,
  sanitizePopupBannerImageUrl,
  type PopupNotificationCampaign,
  type PopupNotificationDeliveryMode,
  type PopupNotificationFrequency,
  type PopupNotificationStoredStatus,
  type PopupNotificationStyleConfig,
  type PopupNotificationTargetUser,
  type PopupNotificationThemeId,
} from '../lib/popupNotificationLogic';
import { SlidingWindowRateLimiter } from '../lib/serverSecurity';

export interface VerifiedFirebaseRuntimeConfig {
  configValid: boolean;
  projectId: string;
  projectNumber: string;
  apiKey: string;
  firestoreDatabaseId: string;
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

interface PopupNotificationRouteDeps<
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
}

function fromRestVal(val: unknown): unknown {
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
    return Array.isArray(arr) ? arr.map(fromRestVal) : [];
  }
  if ('mapValue' in v) {
    const fields = (v.mapValue as { fields?: Record<string, unknown> } | undefined)?.fields || {};
    const out: Record<string, unknown> = {};
    for (const [k, fv] of Object.entries(fields)) {
      out[k] = fromRestVal(fv);
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
    data[k] = fromRestVal(v);
  }
  return data;
}

function toRestVal(val: unknown): Record<string, unknown> {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (val instanceof Date) return { timestampValue: val.toISOString() };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map((item) => toRestVal(item)) } };
  }
  if (typeof val === 'object') {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v !== undefined) fields[k] = toRestVal(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function extractTsMs(raw: unknown): number {
  if (!raw) return 0;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const p = Date.parse(raw);
    return Number.isFinite(p) ? p : 0;
  }
  if (typeof raw === 'object') {
    const obj = raw as { toMillis?: () => number; _seconds?: number; seconds?: number };
    if (typeof obj.toMillis === 'function') return obj.toMillis();
    if (typeof obj._seconds === 'number') return obj._seconds * 1000;
    if (typeof obj.seconds === 'number') return obj.seconds * 1000;
  }
  return 0;
}

function isValidThemeId(val: unknown): val is PopupNotificationThemeId {
  return POPUP_THEME_LIBRARY.some((t) => t.id === val);
}

function isValidFrequency(val: unknown): val is PopupNotificationFrequency {
  return (
    val === 'once_per_user' ||
    val === 'once_per_session' ||
    val === 'every_open' ||
    val === 'until_dismissed'
  );
}

function isValidStoredStatus(val: unknown): val is PopupNotificationStoredStatus {
  return val === 'draft' || val === 'active' || val === 'paused';
}

function normalizeCampaignRecord(
  id: string,
  raw: Record<string, unknown>
): PopupNotificationCampaign {
  const themeId: PopupNotificationThemeId = isValidThemeId(raw.themeId)
    ? raw.themeId
    : 'modern_gradient';
  const deliveryMode: PopupNotificationDeliveryMode =
    raw.deliveryMode === 'targeted' ? 'targeted' : 'global';
  const frequency: PopupNotificationFrequency = isValidFrequency(raw.frequency)
    ? raw.frequency
    : 'once_per_user';
  const storedStatus: PopupNotificationStoredStatus = isValidStoredStatus(raw.storedStatus)
    ? raw.storedStatus
    : 'draft';

  const targetUserIds =
    deliveryMode === 'targeted' && Array.isArray(raw.targetUserIds)
      ? Array.from(
          new Set(
            raw.targetUserIds
              .map((u) => String(u || '').trim())
              .filter((u) => VALID_ID_REGEX.test(u))
          )
        ).slice(0, 200)
      : [];

  return {
    id,
    title: String(raw.title || '').slice(0, 140),
    body: String(raw.body || '').slice(0, 2000),
    deliveryMode,
    targetUserIds,
    themeId,
    style: mergePopupStyleWithThemeDefaults(
      themeId,
      (raw.style || {}) as Partial<PopupNotificationStyleConfig>
    ),
    bannerImageUrl: sanitizePopupBannerImageUrl(raw.bannerImageUrl),
    frequency,
    storedStatus,
    startAtMs: Math.max(0, Math.round(Number(raw.startAtMs || 0))),
    expiresAtMs: Math.max(0, Math.round(Number(raw.expiresAtMs || 0))),
    viewCount: Math.max(0, Math.round(Number(raw.viewCount || 0))),
    dismissCount: Math.max(0, Math.round(Number(raw.dismissCount || 0))),
    createdBy: String(raw.createdBy || ''),
    createdAtMs: extractTsMs(raw.createdAtMs || raw.createdAt),
    updatedAtMs: extractTsMs(raw.updatedAtMs || raw.updatedAt),
  };
}

export function registerPopupNotificationRoutes<
  TCfg extends VerifiedFirebaseRuntimeConfig = VerifiedFirebaseRuntimeConfig
>(deps: PopupNotificationRouteDeps<TCfg>): void {
  const {
    app,
    loadVerifiedFirebaseConfig,
    getOrInitFirebaseAdminApp,
    verifyCallerFirebaseToken,
    verifyAdminCaller,
    getCallerClientKey,
  } = deps;

  const trackRateLimiter = new SlidingWindowRateLimiter(80, 60_000);
  const trackDedupeCache = new Map<string, number>();

  function restBase(cfg: TCfg): string {
    return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      cfg.projectId
    )}/databases/${encodeURIComponent(cfg.firestoreDatabaseId)}/documents`;
  }

  function docFullName(cfg: TCfg, docPath: string): string {
    return `projects/${cfg.projectId}/databases/${cfg.firestoreDatabaseId}/documents/${docPath}`;
  }

  async function restGetDoc(
    cfg: TCfg,
    docPath: string,
    idToken?: string
  ): Promise<Record<string, unknown> | null> {
    const headers: Record<string, string> = {};
    if (idToken) headers.Authorization = `Bearer ${idToken}`;
    const res = await fetch(`${restBase(cfg)}/${docPath}`, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`REST GET ${docPath} failed (${res.status})`);
    const json = (await res.json()) as FirestoreRestDoc;
    return parseRestDoc(json);
  }

  async function restRunQuery(
    cfg: TCfg,
    structuredQuery: Record<string, unknown>,
    idToken?: string
  ): Promise<Array<Record<string, unknown>>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (idToken) headers.Authorization = `Bearer ${idToken}`;
    const res = await fetch(`${restBase(cfg)}:runQuery`, {
      method: 'POST',
      headers,
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

  function buildRestWrite(
    cfg: TCfg,
    docPath: string,
    fieldsObj: Record<string, unknown>,
    serverTimestampFields: string[],
    updateMaskFieldPaths?: string[]
  ): Array<Record<string, unknown>> {
    const name = docFullName(cfg, docPath);
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fieldsObj)) {
      if (v !== undefined) fields[k] = toRestVal(v);
    }
    const updateWrite: Record<string, unknown> = { update: { name, fields } };
    if (updateMaskFieldPaths && updateMaskFieldPaths.length > 0) {
      updateWrite.updateMask = { fieldPaths: updateMaskFieldPaths };
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

  async function restCommit(
    cfg: TCfg,
    writes: Array<Record<string, unknown>>,
    idToken: string
  ): Promise<boolean> {
    if (writes.length === 0) return true;
    const res = await fetch(`${restBase(cfg)}:commit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ writes }),
    });
    return res.ok;
  }

  async function resolveUsersDirectoryMap(
    cfg: TCfg,
    adminIdToken: string
  ): Promise<Map<string, PopupNotificationTargetUser>> {
    const result = new Map<string, PopupNotificationTargetUser>();
    let pubDocs: Array<Record<string, unknown>> = [];
    let privDocs: Array<Record<string, unknown>> = [];
    const authMap = new Map<string, { email: string; displayName: string }>();

    try {
      const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
      const db = getAdminFirestore(adminApp, cfg.firestoreDatabaseId);
      const [pubSnap, privSnap] = await Promise.all([
        db.collection('publicProfiles').limit(1000).get(),
        db.collection('privateUsers').limit(1000).get(),
      ]);
      pubDocs = pubSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      privDocs = privSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch {
      const [pubRest, privRest] = await Promise.all([
        restRunQuery(cfg, { from: [{ collectionId: 'publicProfiles' }], limit: 1000 }, adminIdToken),
        restRunQuery(cfg, { from: [{ collectionId: 'privateUsers' }], limit: 1000 }, adminIdToken),
      ]);
      pubDocs = pubRest;
      privDocs = privRest;
    }

    try {
      const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
      const adminAuth = getAdminAuth(adminApp);
      const listed = await adminAuth.listUsers(1000);
      for (const u of listed.users) {
        authMap.set(u.uid, {
          email: String(u.email || ''),
          displayName: String(u.displayName || ''),
        });
      }
    } catch {
      // Optional enrichment when Auth Admin ADC isn't available locally
    }

    const pubByUid = new Map<string, Record<string, unknown>>();
    for (const p of pubDocs) {
      const uid = String(p.uid || p.id || '');
      if (uid) pubByUid.set(uid, p);
    }
    const privByUid = new Map<string, Record<string, unknown>>();
    for (const p of privDocs) {
      const uid = String(p.uid || p.id || '');
      if (uid) privByUid.set(uid, p);
    }

    const allUids = new Set<string>([
      ...pubByUid.keys(),
      ...privByUid.keys(),
      ...authMap.keys(),
    ]);

    for (const uid of allUids) {
      if (!VALID_ID_REGEX.test(uid)) continue;
      const pub = pubByUid.get(uid) || {};
      const priv = privByUid.get(uid) || {};
      const authInfo = authMap.get(uid);
      const email = String(priv.email || authInfo?.email || '').trim();
      const displayName = String(
        pub.displayName || authInfo?.displayName || email.split('@')[0] || 'Member'
      ).trim();
      const username = String(pub.username || '').trim();
      result.set(uid, { uid, displayName, username, email });
    }

    return result;
  }

  function buildTargetPayload(
    campaignId: string,
    targetUid: string,
    campaign: Omit<PopupNotificationCampaign, 'id' | 'targetUsers'>,
    nowMs: number
  ) {
    return {
      campaignId,
      targetUid,
      title: campaign.title,
      body: campaign.body,
      themeId: campaign.themeId,
      style: campaign.style,
      bannerImageUrl: campaign.bannerImageUrl,
      frequency: campaign.frequency,
      storedStatus: campaign.storedStatus,
      startAtMs: campaign.startAtMs,
      expiresAtMs: campaign.expiresAtMs,
      updatedAtMs: nowMs,
    };
  }

  function sanitizeCampaignInput(
    rawBody: Record<string, unknown>,
    existing?: PopupNotificationCampaign | null
  ): { ok: true; data: Omit<PopupNotificationCampaign, 'id' | 'targetUsers'> } | { ok: false; error: string } {
    const title = String(rawBody.title || '').trim();
    const body = String(rawBody.body || '').trim();
    if (title.length < 1 || title.length > 140) {
      return { ok: false, error: 'Notification title must be between 1 and 140 characters.' };
    }
    if (body.length < 1 || body.length > 2000) {
      return { ok: false, error: 'Notification description must be between 1 and 2000 characters.' };
    }

    const deliveryMode: PopupNotificationDeliveryMode =
      rawBody.deliveryMode === 'targeted' ? 'targeted' : 'global';
    const rawTargets = Array.isArray(rawBody.targetUserIds) ? rawBody.targetUserIds : [];
    const targetUserIds =
      deliveryMode === 'targeted'
        ? Array.from(
            new Set(
              rawTargets
                .map((u) => String(u || '').trim())
                .filter((u) => VALID_ID_REGEX.test(u))
            )
          ).slice(0, 200)
        : [];

    if (deliveryMode === 'targeted' && targetUserIds.length === 0) {
      return {
        ok: false,
        error: 'Please select at least one user for a Specific User Notification.',
      };
    }

    const themeId: PopupNotificationThemeId = isValidThemeId(rawBody.themeId)
      ? rawBody.themeId
      : existing?.themeId || 'modern_gradient';
    const style = mergePopupStyleWithThemeDefaults(
      themeId,
      (rawBody.style || {}) as Partial<PopupNotificationStyleConfig>
    );
    const bannerImageUrl = sanitizePopupBannerImageUrl(rawBody.bannerImageUrl);
    if (rawBody.bannerImageUrl && String(rawBody.bannerImageUrl).trim() && !bannerImageUrl) {
      return {
        ok: false,
        error: 'Banner image must be an https:// URL or a JPEG/PNG/WebP image under 250KB.',
      };
    }

    const frequency: PopupNotificationFrequency = isValidFrequency(rawBody.frequency)
      ? rawBody.frequency
      : 'once_per_user';
    const storedStatus: PopupNotificationStoredStatus = isValidStoredStatus(rawBody.storedStatus)
      ? rawBody.storedStatus
      : 'draft';

    const startAtMs = Math.max(0, Math.round(Number(rawBody.startAtMs || 0)));
    const expiresAtMs = Math.max(0, Math.round(Number(rawBody.expiresAtMs || 0)));
    if (expiresAtMs > 0 && startAtMs > 0 && expiresAtMs <= startAtMs) {
      return {
        ok: false,
        error: 'Expiration time (Asia/Dhaka) must be later than the scheduled start time.',
      };
    }

    const nowMs = Date.now();
    return {
      ok: true,
      data: {
        title,
        body,
        deliveryMode,
        targetUserIds,
        themeId,
        style,
        bannerImageUrl,
        frequency,
        storedStatus,
        startAtMs,
        expiresAtMs,
        viewCount: existing?.viewCount ?? 0,
        dismissCount: existing?.dismissCount ?? 0,
        createdBy: existing?.createdBy || '',
        createdAtMs: existing?.createdAtMs || nowMs,
        updatedAtMs: nowMs,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // 1. Admin User Search for Specific User Targeting (username, email, UID)
  // ---------------------------------------------------------------------------
  app.get('/api/admin/popup-notifications/users', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    if (!cfg.configValid) {
      return res.status(503).json({ ok: false, error: 'Firebase configuration unavailable.' });
    }
    const adminCaller = await verifyAdminCaller(req, cfg);
    if (!adminCaller) {
      return res.status(403).json({ ok: false, error: 'Administrator authentication required.' });
    }

    try {
      const q = String(req.query.q || '').trim().toLowerCase();
      const qClean = q.replace(/^@/, '');
      const usersMap = await resolveUsersDirectoryMap(cfg, adminCaller.idToken);
      const allUsers = Array.from(usersMap.values());
      const matched = (q
        ? allUsers.filter(
            (u) =>
              u.uid.toLowerCase().includes(q) ||
              u.username.toLowerCase().includes(qClean) ||
              u.displayName.toLowerCase().includes(q) ||
              u.email.toLowerCase().includes(q)
          )
        : allUsers
      ).slice(0, 30);

      return res.json({ ok: true, users: matched });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Unable to search users.',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 2. Admin List All Popup Notification Campaigns + Stats
  // ---------------------------------------------------------------------------
  app.get('/api/admin/popup-notifications', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    if (!cfg.configValid) {
      return res.status(503).json({ ok: false, error: 'Firebase configuration unavailable.' });
    }
    const adminCaller = await verifyAdminCaller(req, cfg);
    if (!adminCaller) {
      return res.status(403).json({ ok: false, error: 'Administrator authentication required.' });
    }

    try {
      let rawDocs: Array<Record<string, unknown>> = [];
      try {
        const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
        const db = getAdminFirestore(adminApp, cfg.firestoreDatabaseId);
        const snap = await db.collection('popupNotifications').limit(250).get();
        rawDocs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      } catch {
        rawDocs = await restRunQuery(
          cfg,
          { from: [{ collectionId: 'popupNotifications' }], limit: 250 },
          adminCaller.idToken
        );
      }

      const usersMap = await resolveUsersDirectoryMap(cfg, adminCaller.idToken).catch(
        () => new Map<string, PopupNotificationTargetUser>()
      );

      const campaigns: PopupNotificationCampaign[] = rawDocs
        .map((raw) => {
          const id = String(raw.id || '');
          const c = normalizeCampaignRecord(id, raw);
          const targetUsers: PopupNotificationTargetUser[] = c.targetUserIds.map((uid) => {
            const found = usersMap.get(uid);
            return (
              found || {
                uid,
                displayName: `Member (${uid.slice(0, 8)})`,
                username: '',
                email: '',
              }
            );
          });
          return { ...c, targetUsers };
        })
        .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));

      const stats = computePopupNotificationDashboardStats(campaigns);
      return res.json({ ok: true, campaigns, stats });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Unable to load popup notifications.',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 3. Admin Create Campaign
  // ---------------------------------------------------------------------------
  app.post('/api/admin/popup-notifications', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    if (!cfg.configValid) {
      return res.status(503).json({ ok: false, error: 'Firebase configuration unavailable.' });
    }
    const adminCaller = await verifyAdminCaller(req, cfg);
    if (!adminCaller) {
      return res.status(403).json({ ok: false, error: 'Administrator authentication required.' });
    }

    const parsed = sanitizeCampaignInput((req.body || {}) as Record<string, unknown>, null);
    if (!parsed.ok) {
      return res.status(400).json({ ok: false, error: parsed.error });
    }

    const campaignId = `pnc_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    const nowMs = Date.now();
    const campaignDocData = {
      ...parsed.data,
      viewCount: 0,
      dismissCount: 0,
      createdBy: adminCaller.uid,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };

    try {
      let written = false;
      try {
        const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
        const db = getAdminFirestore(adminApp, cfg.firestoreDatabaseId);
        const batch = db.batch();
        batch.set(db.collection('popupNotifications').doc(campaignId), {
          ...campaignDocData,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        for (const targetUid of campaignDocData.targetUserIds) {
          const targetId = `${campaignId}_${targetUid}`;
          batch.set(db.collection('popupNotificationTargets').doc(targetId), {
            ...buildTargetPayload(campaignId, targetUid, campaignDocData, nowMs),
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
        batch.set(db.collection('auditLogs').doc(), {
          actorId: adminCaller.uid,
          action: 'admin_create_popup_notification',
          targetType: 'popup_notification',
          targetId: campaignId,
          details: `Created ${campaignDocData.deliveryMode} popup "${campaignDocData.title}" (${campaignDocData.storedStatus}, targets=${campaignDocData.targetUserIds.length}).`,
          createdAt: FieldValue.serverTimestamp(),
        });
        await batch.commit();
        written = true;
      } catch {
        // Fall back to authenticated REST commit for local dev sandbox
      }

      if (!written) {
        const writes: Array<Record<string, unknown>> = [
          ...buildRestWrite(
            cfg,
            `popupNotifications/${campaignId}`,
            campaignDocData,
            ['createdAt', 'updatedAt']
          ),
        ];
        for (const targetUid of campaignDocData.targetUserIds) {
          const targetId = `${campaignId}_${targetUid}`;
          writes.push(
            ...buildRestWrite(
              cfg,
              `popupNotificationTargets/${targetId}`,
              buildTargetPayload(campaignId, targetUid, campaignDocData, nowMs),
              ['createdAt', 'updatedAt']
            )
          );
        }
        const auditId = `aud_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
        writes.push(
          ...buildRestWrite(
            cfg,
            `auditLogs/${auditId}`,
            {
              actorId: adminCaller.uid,
              action: 'admin_create_popup_notification',
              targetType: 'popup_notification',
              targetId: campaignId,
              details: `Created ${campaignDocData.deliveryMode} popup "${campaignDocData.title}" (${campaignDocData.storedStatus}, targets=${campaignDocData.targetUserIds.length}).`,
            },
            ['createdAt']
          )
        );
        const ok = await restCommit(cfg, writes, adminCaller.idToken);
        if (!ok) {
          return res.status(500).json({ ok: false, error: 'Failed to save popup notification.' });
        }
      }

      return res.json({
        ok: true,
        campaign: {
          id: campaignId,
          ...campaignDocData,
        },
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Unable to create popup notification.',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 4. Admin Update / Edit Campaign + Sync Targeted Projections
  // ---------------------------------------------------------------------------
  app.put('/api/admin/popup-notifications/:id', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    if (!cfg.configValid) {
      return res.status(503).json({ ok: false, error: 'Firebase configuration unavailable.' });
    }
    const adminCaller = await verifyAdminCaller(req, cfg);
    if (!adminCaller) {
      return res.status(403).json({ ok: false, error: 'Administrator authentication required.' });
    }

    const campaignId = String(req.params.id || '').trim();
    if (!VALID_ID_REGEX.test(campaignId)) {
      return res.status(400).json({ ok: false, error: 'Invalid notification ID.' });
    }

    try {
      let rawExisting: Record<string, unknown> | null = null;
      let useAdminSdk = true;
      try {
        const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
        const db = getAdminFirestore(adminApp, cfg.firestoreDatabaseId);
        const snap = await db.collection('popupNotifications').doc(campaignId).get();
        if (snap.exists) rawExisting = { id: snap.id, ...snap.data() };
      } catch {
        useAdminSdk = false;
        rawExisting = await restGetDoc(cfg, `popupNotifications/${campaignId}`, adminCaller.idToken);
      }

      if (!rawExisting) {
        return res.status(404).json({ ok: false, error: 'Popup notification not found.' });
      }

      const existing = normalizeCampaignRecord(campaignId, rawExisting);
      const parsed = sanitizeCampaignInput((req.body || {}) as Record<string, unknown>, existing);
      if (!parsed.ok) {
        return res.status(400).json({ ok: false, error: parsed.error });
      }

      const nowMs = Date.now();
      const updatedFields = {
        ...parsed.data,
        viewCount: existing.viewCount,
        dismissCount: existing.dismissCount,
        createdBy: existing.createdBy || adminCaller.uid,
        createdAtMs: existing.createdAtMs || nowMs,
        updatedAtMs: nowMs,
      };

      const oldTargets = new Set(existing.targetUserIds);
      const newTargets = new Set(updatedFields.targetUserIds);
      const toDelete = Array.from(oldTargets).filter((u) => !newTargets.has(u));

      if (useAdminSdk) {
        try {
          const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
          const db = getAdminFirestore(adminApp, cfg.firestoreDatabaseId);
          const batch = db.batch();
          batch.update(db.collection('popupNotifications').doc(campaignId), {
            ...updatedFields,
            updatedAt: FieldValue.serverTimestamp(),
          });
          for (const uid of toDelete) {
            batch.delete(db.collection('popupNotificationTargets').doc(`${campaignId}_${uid}`));
          }
          for (const uid of newTargets) {
            const targetRef = db.collection('popupNotificationTargets').doc(`${campaignId}_${uid}`);
            const targetSnap = await targetRef.get();
            if (targetSnap.exists) {
              batch.update(targetRef, {
                ...buildTargetPayload(campaignId, uid, updatedFields, nowMs),
                updatedAt: FieldValue.serverTimestamp(),
              });
            } else {
              batch.set(targetRef, {
                ...buildTargetPayload(campaignId, uid, updatedFields, nowMs),
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
              });
            }
          }
          batch.set(db.collection('auditLogs').doc(), {
            actorId: adminCaller.uid,
            action: 'admin_update_popup_notification',
            targetType: 'popup_notification',
            targetId: campaignId,
            details: `Updated popup "${updatedFields.title}" (${updatedFields.deliveryMode}, ${updatedFields.storedStatus}).`,
            createdAt: FieldValue.serverTimestamp(),
          });
          await batch.commit();
        } catch {
          useAdminSdk = false;
        }
      }

      if (!useAdminSdk) {
        const writes: Array<Record<string, unknown>> = [
          ...buildRestWrite(
            cfg,
            `popupNotifications/${campaignId}`,
            updatedFields,
            ['updatedAt'],
            [
              'title',
              'body',
              'deliveryMode',
              'targetUserIds',
              'themeId',
              'style',
              'bannerImageUrl',
              'frequency',
              'storedStatus',
              'startAtMs',
              'expiresAtMs',
              'updatedAtMs',
              'updatedAt',
            ]
          ),
        ];
        for (const uid of toDelete) {
          writes.push({ delete: docFullName(cfg, `popupNotificationTargets/${campaignId}_${uid}`) });
        }
        for (const uid of newTargets) {
          const existingTarget = await restGetDoc(
            cfg,
            `popupNotificationTargets/${campaignId}_${uid}`,
            adminCaller.idToken
          ).catch(() => null);
          if (existingTarget) {
            writes.push(
              ...buildRestWrite(
                cfg,
                `popupNotificationTargets/${campaignId}_${uid}`,
                buildTargetPayload(campaignId, uid, updatedFields, nowMs),
                ['updatedAt'],
                [
                  'title',
                  'body',
                  'themeId',
                  'style',
                  'bannerImageUrl',
                  'frequency',
                  'storedStatus',
                  'startAtMs',
                  'expiresAtMs',
                  'updatedAtMs',
                  'updatedAt',
                ]
              )
            );
          } else {
            writes.push(
              ...buildRestWrite(
                cfg,
                `popupNotificationTargets/${campaignId}_${uid}`,
                buildTargetPayload(campaignId, uid, updatedFields, nowMs),
                ['createdAt', 'updatedAt']
              )
            );
          }
        }
        const auditId = `aud_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
        writes.push(
          ...buildRestWrite(
            cfg,
            `auditLogs/${auditId}`,
            {
              actorId: adminCaller.uid,
              action: 'admin_update_popup_notification',
              targetType: 'popup_notification',
              targetId: campaignId,
              details: `Updated popup "${updatedFields.title}" (${updatedFields.deliveryMode}, ${updatedFields.storedStatus}).`,
            },
            ['createdAt']
          )
        );
        const ok = await restCommit(cfg, writes, adminCaller.idToken);
        if (!ok) {
          return res.status(500).json({ ok: false, error: 'Failed to update popup notification.' });
        }
      }

      return res.json({
        ok: true,
        campaign: {
          id: campaignId,
          ...updatedFields,
        },
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Unable to update popup notification.',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 5. Admin Quick Status Toggle (Publish/Activate, Pause, Draft)
  // ---------------------------------------------------------------------------
  app.post('/api/admin/popup-notifications/:id/status', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    if (!cfg.configValid) {
      return res.status(503).json({ ok: false, error: 'Firebase configuration unavailable.' });
    }
    const adminCaller = await verifyAdminCaller(req, cfg);
    if (!adminCaller) {
      return res.status(403).json({ ok: false, error: 'Administrator authentication required.' });
    }

    const campaignId = String(req.params.id || '').trim();
    if (!VALID_ID_REGEX.test(campaignId)) {
      return res.status(400).json({ ok: false, error: 'Invalid notification ID.' });
    }

    const nextStatus = req.body?.storedStatus;
    if (!isValidStoredStatus(nextStatus)) {
      return res.status(400).json({ ok: false, error: 'Invalid notification status.' });
    }

    try {
      let rawExisting: Record<string, unknown> | null = null;
      let useAdminSdk = true;
      try {
        const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
        const db = getAdminFirestore(adminApp, cfg.firestoreDatabaseId);
        const snap = await db.collection('popupNotifications').doc(campaignId).get();
        if (snap.exists) rawExisting = { id: snap.id, ...snap.data() };
      } catch {
        useAdminSdk = false;
        rawExisting = await restGetDoc(cfg, `popupNotifications/${campaignId}`, adminCaller.idToken);
      }

      if (!rawExisting) {
        return res.status(404).json({ ok: false, error: 'Popup notification not found.' });
      }

      const existing = normalizeCampaignRecord(campaignId, rawExisting);
      const nowMs = Date.now();

      if (useAdminSdk) {
        try {
          const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
          const db = getAdminFirestore(adminApp, cfg.firestoreDatabaseId);
          const batch = db.batch();
          batch.update(db.collection('popupNotifications').doc(campaignId), {
            storedStatus: nextStatus,
            updatedAtMs: nowMs,
            updatedAt: FieldValue.serverTimestamp(),
          });
          for (const uid of existing.targetUserIds) {
            batch.update(db.collection('popupNotificationTargets').doc(`${campaignId}_${uid}`), {
              storedStatus: nextStatus,
              updatedAtMs: nowMs,
              updatedAt: FieldValue.serverTimestamp(),
            });
          }
          batch.set(db.collection('auditLogs').doc(), {
            actorId: adminCaller.uid,
            action: 'admin_toggle_popup_notification_status',
            targetType: 'popup_notification',
            targetId: campaignId,
            details: `Changed popup "${existing.title}" status to ${nextStatus}.`,
            createdAt: FieldValue.serverTimestamp(),
          });
          await batch.commit();
        } catch {
          useAdminSdk = false;
        }
      }

      if (!useAdminSdk) {
        const writes: Array<Record<string, unknown>> = [
          ...buildRestWrite(
            cfg,
            `popupNotifications/${campaignId}`,
            { storedStatus: nextStatus, updatedAtMs: nowMs },
            ['updatedAt'],
            ['storedStatus', 'updatedAtMs', 'updatedAt']
          ),
        ];
        for (const uid of existing.targetUserIds) {
          writes.push(
            ...buildRestWrite(
              cfg,
              `popupNotificationTargets/${campaignId}_${uid}`,
              { storedStatus: nextStatus, updatedAtMs: nowMs },
              ['updatedAt'],
              ['storedStatus', 'updatedAtMs', 'updatedAt']
            )
          );
        }
        const auditId = `aud_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
        writes.push(
          ...buildRestWrite(
            cfg,
            `auditLogs/${auditId}`,
            {
              actorId: adminCaller.uid,
              action: 'admin_toggle_popup_notification_status',
              targetType: 'popup_notification',
              targetId: campaignId,
              details: `Changed popup "${existing.title}" status to ${nextStatus}.`,
            },
            ['createdAt']
          )
        );
        const ok = await restCommit(cfg, writes, adminCaller.idToken);
        if (!ok) {
          return res.status(500).json({ ok: false, error: 'Failed to update status.' });
        }
      }

      return res.json({ ok: true, id: campaignId, storedStatus: nextStatus, updatedAtMs: nowMs });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Unable to update popup status.',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 6. Admin Delete Campaign + Targeted Copies
  // ---------------------------------------------------------------------------
  app.delete('/api/admin/popup-notifications/:id', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    if (!cfg.configValid) {
      return res.status(503).json({ ok: false, error: 'Firebase configuration unavailable.' });
    }
    const adminCaller = await verifyAdminCaller(req, cfg);
    if (!adminCaller) {
      return res.status(403).json({ ok: false, error: 'Administrator authentication required.' });
    }

    const campaignId = String(req.params.id || '').trim();
    if (!VALID_ID_REGEX.test(campaignId)) {
      return res.status(400).json({ ok: false, error: 'Invalid notification ID.' });
    }

    try {
      let rawExisting: Record<string, unknown> | null = null;
      let useAdminSdk = true;
      try {
        const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
        const db = getAdminFirestore(adminApp, cfg.firestoreDatabaseId);
        const snap = await db.collection('popupNotifications').doc(campaignId).get();
        if (snap.exists) rawExisting = { id: snap.id, ...snap.data() };
      } catch {
        useAdminSdk = false;
        rawExisting = await restGetDoc(cfg, `popupNotifications/${campaignId}`, adminCaller.idToken);
      }

      if (!rawExisting) {
        return res.status(404).json({ ok: false, error: 'Popup notification not found.' });
      }
      const existing = normalizeCampaignRecord(campaignId, rawExisting);

      if (useAdminSdk) {
        try {
          const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
          const db = getAdminFirestore(adminApp, cfg.firestoreDatabaseId);
          const batch = db.batch();
          batch.delete(db.collection('popupNotifications').doc(campaignId));
          for (const uid of existing.targetUserIds) {
            batch.delete(db.collection('popupNotificationTargets').doc(`${campaignId}_${uid}`));
          }
          batch.set(db.collection('auditLogs').doc(), {
            actorId: adminCaller.uid,
            action: 'admin_delete_popup_notification',
            targetType: 'popup_notification',
            targetId: campaignId,
            details: `Deleted popup notification "${existing.title}" (${campaignId}).`,
            createdAt: FieldValue.serverTimestamp(),
          });
          await batch.commit();
        } catch {
          useAdminSdk = false;
        }
      }

      if (!useAdminSdk) {
        const writes: Array<Record<string, unknown>> = [
          { delete: docFullName(cfg, `popupNotifications/${campaignId}`) },
          ...existing.targetUserIds.map((uid) => ({
            delete: docFullName(cfg, `popupNotificationTargets/${campaignId}_${uid}`),
          })),
        ];
        const auditId = `aud_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
        writes.push(
          ...buildRestWrite(
            cfg,
            `auditLogs/${auditId}`,
            {
              actorId: adminCaller.uid,
              action: 'admin_delete_popup_notification',
              targetType: 'popup_notification',
              targetId: campaignId,
              details: `Deleted popup notification "${existing.title}" (${campaignId}).`,
            },
            ['createdAt']
          )
        );
        const ok = await restCommit(cfg, writes, adminCaller.idToken);
        if (!ok) {
          return res.status(500).json({ ok: false, error: 'Failed to delete popup notification.' });
        }
      }

      return res.json({ ok: true, deletedId: campaignId });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Unable to delete popup notification.',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 7. Public / Authenticated Active Popups Feed (Strict Target Privacy)
  // ---------------------------------------------------------------------------
  app.get('/api/popup-notifications/active', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    if (!cfg.configValid) {
      return res.status(503).json({ ok: false, error: 'Firebase configuration unavailable.' });
    }

    try {
      const caller = await verifyCallerFirebaseToken(req, cfg);
      const nowMs = Date.now();
      let globalRaw: Array<Record<string, unknown>> = [];
      let targetRaw: Array<Record<string, unknown>> = [];

      try {
        const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
        const db = getAdminFirestore(adminApp, cfg.firestoreDatabaseId);
        const gSnap = await db
          .collection('popupNotifications')
          .where('deliveryMode', '==', 'global')
          .where('storedStatus', '==', 'active')
          .limit(20)
          .get();
        globalRaw = gSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

        if (caller?.uid) {
          const tSnap = await db
            .collection('popupNotificationTargets')
            .where('targetUid', '==', caller.uid)
            .where('storedStatus', '==', 'active')
            .limit(20)
            .get();
          targetRaw = tSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
        }
      } catch {
        globalRaw = await restRunQuery(
          cfg,
          {
            from: [{ collectionId: 'popupNotifications' }],
            where: {
              compositeFilter: {
                op: 'AND',
                filters: [
                  {
                    fieldFilter: {
                      field: { fieldPath: 'deliveryMode' },
                      op: 'EQUAL',
                      value: { stringValue: 'global' },
                    },
                  },
                  {
                    fieldFilter: {
                      field: { fieldPath: 'storedStatus' },
                      op: 'EQUAL',
                      value: { stringValue: 'active' },
                    },
                  },
                ],
              },
            },
            limit: 20,
          },
          caller?.idToken
        );
        if (caller?.uid) {
          targetRaw = await restRunQuery(
            cfg,
            {
              from: [{ collectionId: 'popupNotificationTargets' }],
              where: {
                compositeFilter: {
                  op: 'AND',
                  filters: [
                    {
                      fieldFilter: {
                        field: { fieldPath: 'targetUid' },
                        op: 'EQUAL',
                        value: { stringValue: caller.uid },
                      },
                    },
                    {
                      fieldFilter: {
                        field: { fieldPath: 'storedStatus' },
                        op: 'EQUAL',
                        value: { stringValue: 'active' },
                      },
                    },
                  ],
                },
              },
              limit: 20,
            },
            caller.idToken
          );
        }
      }

      const byCampaignId = new Map<string, PopupNotificationCampaign>();

      // Strictly strip any targetUserIds or admin-only metadata before returning to client
      for (const raw of targetRaw) {
        const campaignId = String(raw.campaignId || '');
        if (!campaignId) continue;
        const normalized = normalizeCampaignRecord(campaignId, {
          ...raw,
          deliveryMode: 'targeted',
          targetUserIds: [],
        });
        if (isPopupCampaignLiveNow(normalized, nowMs)) {
          byCampaignId.set(campaignId, normalized);
        }
      }

      for (const raw of globalRaw) {
        const campaignId = String(raw.id || '');
        if (!campaignId || byCampaignId.has(campaignId)) continue;
        const normalized = normalizeCampaignRecord(campaignId, {
          ...raw,
          deliveryMode: 'global',
          targetUserIds: [],
        });
        if (isPopupCampaignLiveNow(normalized, nowMs)) {
          byCampaignId.set(campaignId, normalized);
        }
      }

      const activePopups = Array.from(byCampaignId.values()).sort(
        (a, b) => (b.updatedAtMs || b.createdAtMs || 0) - (a.updatedAtMs || a.createdAtMs || 0)
      );

      return res.json({ ok: true, notifications: activePopups });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Unable to fetch active notifications.',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 8. Deduplicated View & Dismissal Analytics + Cross-Device Receipt Sync
  // ---------------------------------------------------------------------------
  app.post('/api/popup-notifications/:id/track', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = loadVerifiedFirebaseConfig();
    if (!cfg.configValid) {
      return res.status(503).json({ ok: false, error: 'Firebase configuration unavailable.' });
    }

    const clientIpKey = getCallerClientKey(req);
    const rateDecision = trackRateLimiter.consume(`popup_track:${clientIpKey}`);
    if (!rateDecision.allowed) {
      return res.status(429).json({ ok: false, error: 'Too many tracking requests.' });
    }

    const campaignId = String(req.params.id || '').trim();
    if (!VALID_ID_REGEX.test(campaignId)) {
      return res.status(400).json({ ok: false, error: 'Invalid notification ID.' });
    }

    const event = req.body?.event === 'dismiss' ? 'dismiss' : 'view';
    const sessionKey = String(req.body?.sessionKey || '').trim().slice(0, 64);

    try {
      const caller = await verifyCallerFirebaseToken(req, cfg);
      const actorKey = caller?.uid ? `u_${caller.uid}` : `v_${sessionKey || clientIpKey}`;
      const dedupeKey = `${campaignId}:${event}:${actorKey}`;
      const nowMs = Date.now();

      // Prevent StrictMode / rapid double-counting within 30s for views or permanent in-session duplicate
      const prevTs = trackDedupeCache.get(dedupeKey);
      if (prevTs && nowMs - prevTs < 30_000) {
        return res.json({ ok: true, deduplicated: true });
      }
      trackDedupeCache.set(dedupeKey, nowMs);
      if (trackDedupeCache.size > 5000) {
        for (const [k, ts] of trackDedupeCache.entries()) {
          if (nowMs - ts > 600_000) trackDedupeCache.delete(k);
        }
      }

      try {
        const adminApp = getOrInitFirebaseAdminApp(cfg.projectId);
        const db = getAdminFirestore(adminApp, cfg.firestoreDatabaseId);

        await db.runTransaction(async (tx) => {
          const campRef = db.collection('popupNotifications').doc(campaignId);
          const campSnap = await tx.get(campRef);
          if (!campSnap.exists) return;
          const campData = campSnap.data() || {};
          const deliveryMode = campData.deliveryMode === 'targeted' ? 'targeted' : 'global';
          const frequency = isValidFrequency(campData.frequency)
            ? campData.frequency
            : 'once_per_user';

          if (deliveryMode === 'targeted') {
            if (!caller?.uid) return;
            const targetIds = Array.isArray(campData.targetUserIds) ? campData.targetUserIds : [];
            if (!targetIds.includes(caller.uid)) return;
          }

          let shouldIncrementView = event === 'view';
          let shouldIncrementDismiss = event === 'dismiss';

          if (caller?.uid) {
            const receiptId = `pnr_${campaignId}_${caller.uid}`;
            const receiptRef = db.collection('popupNotificationReceipts').doc(receiptId);
            const rSnap = await tx.get(receiptRef);
            const existingR = rSnap.exists ? rSnap.data() || {} : {};
            const alreadyViewed = Boolean(existingR.viewed);
            const alreadyDismissed = Boolean(existingR.dismissed);

            if (event === 'view' && frequency === 'once_per_user' && alreadyViewed) {
              shouldIncrementView = false;
            }
            if (event === 'dismiss' && alreadyDismissed) {
              shouldIncrementDismiss = false;
            }

            if (rSnap.exists) {
              tx.update(receiptRef, {
                viewed: true,
                dismissed: event === 'dismiss' ? true : alreadyDismissed,
                viewedAtMs: existingR.viewedAtMs ? Number(existingR.viewedAtMs) : nowMs,
                dismissedAtMs:
                  event === 'dismiss' && !alreadyDismissed
                    ? nowMs
                    : Number(existingR.dismissedAtMs || 0),
                updatedAt: FieldValue.serverTimestamp(),
              });
            } else {
              tx.set(receiptRef, {
                campaignId,
                uid: caller.uid,
                viewed: true,
                dismissed: event === 'dismiss',
                viewedAtMs: nowMs,
                dismissedAtMs: event === 'dismiss' ? nowMs : 0,
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
              });
            }
          }

          if (shouldIncrementView || shouldIncrementDismiss) {
            const updates: Record<string, unknown> = {
              updatedAtMs: nowMs,
              updatedAt: FieldValue.serverTimestamp(),
            };
            if (shouldIncrementView) {
              updates.viewCount = FieldValue.increment(1);
            }
            if (shouldIncrementDismiss) {
              updates.dismissCount = FieldValue.increment(1);
            }
            tx.update(campRef, updates);
          }
        });
      } catch {
        // Non-fatal in local sandbox if Admin ADC lacks permission; signed-in receipts also sync client-side
      }

      return res.json({ ok: true });
    } catch {
      return res.json({ ok: true });
    }
  });
}
