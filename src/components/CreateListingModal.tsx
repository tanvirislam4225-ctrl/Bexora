import React, { useEffect, useRef, useState } from 'react';
import {
  addDoc,
  collection,
  deleteField,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { ArrowLeft, ImagePlus, ShieldAlert, Trash2, Upload } from 'lucide-react';
import {
  CurrencyCode,
  MarketplaceListing,
  MonetizationStatus,
  PlatformId,
  PublicProfile,
  PublicSettings,
} from '../types';
import {
  auth,
  db,
  extractUserFacingFirestoreError,
  handleFirestoreError,
  OperationType,
  validateAndProcessImageFile,
} from '../lib/firebase';
import {
  detectSensitiveOrOffPlatformContent,
  formatAccountAge,
  formatMoneyFromMinor,
  getCategoryMetricLabel,
  normalizeDraftListingFields,
  PLATFORM_CATALOG,
  PLATFORM_LIST,
  validateAccountAge,
  validateGamingFields,
  validatePlatformAssetUrl,
} from '../lib/marketplaceLogic';
import { emitUserNotification } from '../lib/notificationService';
import { PlatformIcon } from './Icons';

interface CreateListingModalProps {
  onClose: () => void;
  userUid: string | null;
  profile: PublicProfile | null;
  settings: PublicSettings;
  editingListing?: MarketplaceListing | null;
  onRequireAuth: () => void;
  onCreated: (msg: string) => void;
}

export const CreateListingModal: React.FC<CreateListingModalProps> = ({
  onClose,
  userUid,
  profile,
  settings,
  editingListing = null,
  onRequireAuth,
  onCreated,
}) => {
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);
  const [platform, setPlatform] = useState<PlatformId | ''>('');
  const [subcategory, setSubcategory] = useState('');
  const [title, setTitle] = useState('');

  // Step 2: Category-specific attributes & Monetization
  const [monetizationStatus, setMonetizationStatus] = useState<'' | 'monetized' | 'non-monetized'>('');
  const [claimedOptions, setClaimedOptions] = useState<string[]>([]);
  const [ageYears, setAgeYears] = useState('');
  const [ageMonths, setAgeMonths] = useState('');
  const [metricValue, setMetricValue] = useState('');
  const [monthlyRevenue, setMonthlyRevenue] = useState('');
  const [accountUrl, setAccountUrl] = useState('');

  // Gaming-only fields
  const [gameName, setGameName] = useState('');
  const [gameUid, setGameUid] = useState('');
  const [gameLevel, setGameLevel] = useState('');

  // Step 3: Pricing, Description, Listing Showcase Images & Private Monetization Evidence
  const [currency, setCurrency] = useState<CurrencyCode>('BDT');
  const [price, setPrice] = useState('');
  const [description, setDescription] = useState('');
  const [listingImages, setListingImages] = useState<string[]>([]);
  const [evidenceImages, setEvidenceImages] = useState<string[]>([]);

  const [uploadingImg, setUploadingImg] = useState(false);
  const [uploadingEvidence, setUploadingEvidence] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [error, setError] = useState('');

  const listingImgInputRef = useRef<HTMLInputElement | null>(null);
  const evidenceImgInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editingListing) return;
    setStep(0);
    setPlatform(editingListing.platform);
    setSubcategory(
      editingListing.subcategory || PLATFORM_CATALOG[editingListing.platform]?.subcategories[0] || ''
    );
    setTitle(editingListing.title === 'Untitled Asset Draft' ? '' : editingListing.title);
    setMonetizationStatus(
      editingListing.monetizationStatus === 'monetized'
        ? 'monetized'
        : editingListing.monetizationStatus === 'non-monetized'
        ? 'non-monetized'
        : ''
    );
    setClaimedOptions(editingListing.claimedOptions || []);
    setAgeYears(String(editingListing.ageYears ?? ''));
    setAgeMonths(String(editingListing.ageMonths ?? ''));
    setMetricValue(String(editingListing.metricValue ?? ''));
    setMonthlyRevenue(
      editingListing.monthlyRevenueMinor > 0
        ? String(editingListing.monthlyRevenueMinor / 100)
        : ''
    );
    setAccountUrl(editingListing.accountUrl || '');
    setGameName(editingListing.gameName || settings.gamingTitles[0] || 'Free Fire');
    setGameUid(editingListing.gameUid || '');
    setGameLevel(editingListing.gameLevel !== undefined ? String(editingListing.gameLevel) : '');
    setCurrency(editingListing.currency || 'BDT');
    setPrice(editingListing.priceMinor > 100 ? String(editingListing.priceMinor / 100) : '');
    setDescription(
      editingListing.description === 'Draft digital asset listing saved by seller.'
        ? ''
        : editingListing.description
    );
    setListingImages(editingListing.images || []);
    setError('');

    if (editingListing.id) {
      getDoc(doc(db, 'listingEvidence', editingListing.id))
        .then((snap) => {
          if (snap.exists() && Array.isArray(snap.data().evidenceImages)) {
            setEvidenceImages(snap.data().evidenceImages as string[]);
          }
        })
        .catch(() => {});
    }
  }, [editingListing, settings.gamingTitles]);

  const platformDef = platform ? PLATFORM_CATALOG[platform] : null;
  const enabledMonetizationOptions = platformDef
    ? platformDef.monetizationOptions.filter((o) => !settings.disabledMonetizationIds.includes(o.id))
    : [];

  const supportsMonetizationHere =
    Boolean(platformDef?.supportsMonetization) &&
    !(platform === 'facebook' && subcategory === 'Facebook Group');

  const selectPlatform = (p: PlatformId) => {
    setPlatform(p);
    setSubcategory(PLATFORM_CATALOG[p].subcategories[0]);
    // Clear stale category-specific values so hidden fields never contaminate submission
    setMonetizationStatus('');
    setClaimedOptions([]);
    setAccountUrl('');
    setMetricValue('');
    setMonthlyRevenue('');
    setGameName(p === 'gaming' ? settings.gamingTitles[0] || 'Free Fire' : '');
    setGameUid('');
    setGameLevel('');
    setError('');
  };

  const handleListingImageFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError('');
    setUploadingImg(true);
    try {
      const remainingSlots = Math.max(0, 4 - listingImages.length);
      if (remainingSlots === 0) {
        setError('Maximum 4 showcase images can be attached to a listing.');
        return;
      }
      const selected = Array.from(files).slice(0, remainingSlots);
      const processed: string[] = [];
      for (const f of selected) {
        const compressed = await validateAndProcessImageFile(f, 960, 0.75);
        processed.push(compressed);
      }
      setListingImages((prev) => [...prev, ...processed]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to process listing image.');
    } finally {
      setUploadingImg(false);
      if (listingImgInputRef.current) listingImgInputRef.current.value = '';
    }
  };

  const handleEvidenceImageFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError('');
    setUploadingEvidence(true);
    try {
      const remainingSlots = Math.max(0, 3 - evidenceImages.length);
      if (remainingSlots === 0) {
        setError('Maximum 3 monetization evidence screenshots allowed.');
        return;
      }
      const selected = Array.from(files).slice(0, remainingSlots);
      const processed: string[] = [];
      for (const f of selected) {
        const compressed = await validateAndProcessImageFile(f, 1024, 0.78);
        processed.push(compressed);
      }
      setEvidenceImages((prev) => [...prev, ...processed]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to process evidence screenshot.');
    } finally {
      setUploadingEvidence(false);
      if (evidenceImgInputRef.current) evidenceImgInputRef.current.value = '';
    }
  };

  const validateCurrentStep = (): string => {
    if (step === 0) {
      if (!platform) return 'Select an asset platform to continue.';
      if (!subcategory) return 'Select the asset subcategory.';
      const cleanTitle = title.trim();
      if (cleanTitle.length < 8 || cleanTitle.length > 120) {
        return 'Listing title must be between 8 and 120 characters.';
      }
      const safety = detectSensitiveOrOffPlatformContent(cleanTitle);
      if (safety.blocked) return safety.reason || 'Title contains prohibited contact details.';
    }

    if (step === 1 && platform && platformDef) {
      const ageRes = validateAccountAge(ageYears, ageMonths, true);
      if (!ageRes.valid) return ageRes.error || 'Enter valid Account Age in Years and Months.';

      if (platform === 'gaming') {
        const gmRes = validateGamingFields(gameName, gameUid, gameLevel, settings.gamingTitles);
        if (!gmRes.valid) return gmRes.error || 'Invalid Gaming account details.';
      } else {
        const urlRes = validatePlatformAssetUrl(platform, accountUrl);
        if (!urlRes.valid) return urlRes.error || 'Enter a valid official HTTPS asset link.';

        if (metricValue.trim() === '' || Number(metricValue) < 0 || !Number.isFinite(Number(metricValue))) {
          return `Enter a valid number for ${getCategoryMetricLabel(platform, subcategory)}.`;
        }

        if (supportsMonetizationHere) {
          if (!monetizationStatus) {
            return 'Explicitly choose either Monetized or Non-Monetized before continuing.';
          }
          if (monetizationStatus === 'monetized' && claimedOptions.length === 0) {
            return `Select at least one ${platformDef.name} monetization program.`;
          }
        }
      }
    }

    if (step === 2) {
      const numericPrice = Number(price);
      if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
        return 'Enter a valid asking price greater than 0.';
      }
      const cleanDesc = description.trim();
      if (cleanDesc.length < 20 || cleanDesc.length > 4000) {
        return 'Description must be between 20 and 4,000 characters.';
      }
      const descSafety = detectSensitiveOrOffPlatformContent(cleanDesc);
      if (descSafety.blocked) {
        return descSafety.reason || 'Description contains prohibited off-platform contact details.';
      }
      if (listingImages.length === 0) {
        return 'Upload at least 1 product/asset showcase screenshot.';
      }
      if (supportsMonetizationHere && monetizationStatus === 'monetized' && evidenceImages.length === 0) {
        return 'Upload at least 1 private screenshot proving your claimed monetization program.';
      }
    }

    return '';
  };

  const handleNext = () => {
    const validationErr = validateCurrentStep();
    if (validationErr) {
      setError(validationErr);
      return;
    }
    setError('');
    setStep((s) => Math.min(3, s + 1) as 0 | 1 | 2 | 3);
  };

  const handleSaveDraft = async () => {
    if (!userUid || !profile) {
      onRequireAuth();
      return;
    }
    if (!platform || !platformDef) {
      setError('Select an asset platform first before saving a draft.');
      return;
    }
    setSavingDraft(true);
    setError('');
    try {
      const normalized = normalizeDraftListingFields({
        platform,
        subcategory,
        title,
        description,
        price,
        ageYears,
        ageMonths,
      });
      if (!normalized.valid) {
        setError(normalized.error || 'Draft contains prohibited off-platform contact details.');
        return;
      }

      const urlRes = validatePlatformAssetUrl(platform, accountUrl);
      const finalMonStatus: MonetizationStatus = !supportsMonetizationHere
        ? 'not_applicable'
        : monetizationStatus === 'monetized'
        ? 'monetized'
        : 'non-monetized';
      const finalClaimed = finalMonStatus === 'monetized' ? claimedOptions : [];
      const revMinor =
        supportsMonetizationHere && monetizationStatus === 'monetized' && Number(monthlyRevenue) > 0
          ? Math.round(Number(monthlyRevenue) * 100)
          : 0;

      const baseFields: Record<string, unknown> = {
        subcategory: normalized.subcategory,
        title: normalized.title,
        description: normalized.description,
        priceMinor: normalized.priceMinor,
        monetizationStatus: finalMonStatus,
        claimedOptions: finalClaimed,
        verificationState:
          finalMonStatus === 'monetized' ? 'submitted_for_verification' : 'not_claimed',
        ageYears: normalized.ageYears,
        ageMonths: normalized.ageMonths,
        metricValue:
          platform === 'gaming'
            ? Math.max(0, Math.round(Number(gameLevel) || 0))
            : Math.max(0, Math.round(Number(metricValue) || 0)),
        monthlyRevenueMinor: revMinor,
        accountUrl:
          platform === 'gaming'
            ? ''
            : urlRes.valid
            ? urlRes.normalizedUrl
            : accountUrl.trim().slice(0, 300),
        urlValidationStatus:
          platform === 'gaming' || !urlRes.valid ? 'not_applicable' : urlRes.status,
        images: listingImages,
        status: 'draft',
        updatedAt: serverTimestamp(),
      };

      if (platform === 'gaming') {
        baseFields.gameName = (gameName || settings.gamingTitles[0] || 'Free Fire').slice(0, 60);
        baseFields.gameUid = gameUid.trim().slice(0, 64);
        baseFields.gameLevel = Math.max(0, Math.min(10000, Math.round(Number(gameLevel) || 1)));
      }

      let draftId = editingListing?.id || '';
      if (editingListing?.id) {
        try {
          await updateDoc(doc(db, 'listings', editingListing.id), {
            ...baseFields,
            verifiedOptions: [],
            rejectionReason: deleteField(),
          });
        } catch (e) {
          handleFirestoreError(e, OperationType.UPDATE, `listings/${editingListing.id}`);
        }
      } else {
        try {
          const ref = await addDoc(collection(db, 'listings'), {
            ...baseFields,
            sellerId: userUid,
            sellerName: profile.displayName,
            sellerUsername: profile.username,
            sellerVerified: Boolean(profile.nidVerified),
            platform,
            currency,
            verifiedOptions: [],
            views: 0,
            createdAt: serverTimestamp(),
          });
          draftId = ref.id;
        } catch (e) {
          handleFirestoreError(e, OperationType.CREATE, 'listings');
        }
      }

      if (finalMonStatus === 'monetized' && evidenceImages.length > 0 && draftId) {
        const evRef = doc(db, 'listingEvidence', draftId);
        const evSnap = await getDoc(evRef).catch(() => null);
        if (evSnap?.exists()) {
          await updateDoc(evRef, {
            evidenceImages,
            updatedAt: serverTimestamp(),
          });
        } else {
          await setDoc(evRef, {
            listingId: draftId,
            sellerId: userUid,
            evidenceImages,
            aiSummary: 'Draft evidence saved by seller.',
            aiMethod: 'draft_saved',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      }

      onCreated('Draft saved to Profile → My Listings.');
      onClose();
    } catch (err) {
      setError(extractUserFacingFirestoreError(err, 'Failed to save listing draft.'));
    } finally {
      setSavingDraft(false);
    }
  };

  const handleSubmit = async () => {
    if (!userUid || !profile) {
      onRequireAuth();
      return;
    }
    if (!platform || !platformDef) return;

    setSubmitting(true);
    setError('');
    try {
      const ageRes = validateAccountAge(ageYears, ageMonths, true);
      const urlRes = validatePlatformAssetUrl(platform, accountUrl);
      const priceMinor = Math.round(Number(price) * 100);
      const revMinor =
        supportsMonetizationHere && monetizationStatus === 'monetized' && Number(monthlyRevenue) > 0
          ? Math.round(Number(monthlyRevenue) * 100)
          : 0;

      const finalMonStatus: MonetizationStatus = !supportsMonetizationHere
        ? 'not_applicable'
        : monetizationStatus === 'monetized'
        ? 'monetized'
        : 'non-monetized';

      const finalClaimed = finalMonStatus === 'monetized' ? claimedOptions : [];

      const mutableFields: Record<string, unknown> = {
        subcategory,
        title: title.trim(),
        description: description.trim(),
        priceMinor,
        monetizationStatus: finalMonStatus,
        claimedOptions: finalClaimed,
        verificationState:
          finalMonStatus === 'monetized' ? 'submitted_for_verification' : 'not_claimed',
        ageYears: ageRes.years,
        ageMonths: ageRes.months,
        metricValue:
          platform === 'gaming'
            ? Math.round(Number(gameLevel) || 1)
            : Math.round(Number(metricValue) || 0),
        monthlyRevenueMinor: revMinor,
        accountUrl: platform === 'gaming' ? '' : urlRes.normalizedUrl,
        urlValidationStatus: platform === 'gaming' ? 'not_applicable' : urlRes.status,
        images: listingImages,
        status: 'pending',
        updatedAt: serverTimestamp(),
      };

      if (platform === 'gaming') {
        mutableFields.gameName = gameName;
        mutableFields.gameUid = gameUid.trim();
        mutableFields.gameLevel = Math.round(Number(gameLevel) || 1);
      }

      let targetListingId = editingListing?.id || '';
      if (editingListing?.id) {
        try {
          await updateDoc(doc(db, 'listings', editingListing.id), {
            ...mutableFields,
            verifiedOptions: [],
            rejectionReason: deleteField(),
          });
        } catch (e) {
          handleFirestoreError(e, OperationType.UPDATE, `listings/${editingListing.id}`);
        }
      } else {
        try {
          const ref = await addDoc(collection(db, 'listings'), {
            ...mutableFields,
            sellerId: userUid,
            sellerName: profile.displayName,
            sellerUsername: profile.username,
            sellerVerified: Boolean(profile.nidVerified),
            platform,
            currency,
            verifiedOptions: [], // Never self-verified! Only admin review can populate verifiedOptions
            views: 0,
            createdAt: serverTimestamp(),
          });
          targetListingId = ref.id;
        } catch (e) {
          handleFirestoreError(e, OperationType.CREATE, 'listings');
        }
      }

      // Store private monetization evidence & invoke optional AI screenshot assessment
      if (finalMonStatus === 'monetized' && evidenceImages.length > 0 && targetListingId) {
        let aiSummary = 'Queued for manual administrator verification.';
        let aiMethod = 'manual_review_queue';
        try {
          const idToken = auth.currentUser ? await auth.currentUser.getIdToken().catch(() => '') : '';
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (idToken) {
            headers.Authorization = `Bearer ${idToken}`;
          }
          const resp = await fetch('/api/ai/verify-evidence', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              platform,
              claimedOptions: finalClaimed,
              imageDataUrl: evidenceImages[0],
            }),
          });
          if (resp.ok) {
            const aiData = await resp.json();
            if (aiData?.summary) {
              aiSummary = `[${aiData.detectedState || 'assessed'}] ${aiData.summary}`;
              aiMethod = aiData.method || 'ai_assessed_screenshot';
            }
          }
        } catch {
          // Graceful fallback when running on static InfinityFree hosting without Express backend
        }

        try {
          const evRef = doc(db, 'listingEvidence', targetListingId);
          const existingEv = await getDoc(evRef).catch(() => null);
          if (existingEv?.exists()) {
            await updateDoc(evRef, {
              evidenceImages,
              updatedAt: serverTimestamp(),
            });
          } else {
            await setDoc(evRef, {
              listingId: targetListingId,
              sellerId: userUid,
              evidenceImages,
              aiSummary: aiSummary.slice(0, 2000),
              aiMethod: aiMethod.slice(0, 80),
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          }
        } catch (e) {
          handleFirestoreError(e, OperationType.CREATE, `listingEvidence/${targetListingId}`);
        }
      }

      if (targetListingId) {
        await emitUserNotification({
          recipientId: userUid,
          eventKey: `listing_submitted_${targetListingId}_${Date.now()}`,
          category: 'listing',
          severity: 'info',
          title: editingListing ? 'Listing Resubmitted for Moderation' : 'Listing Submitted for Moderation',
          preview: `"${title.trim()}" is queued for BEXORA administrator verification.`,
          body: `Your ${platformDef.name} listing "${title.trim()}" has been submitted with Pending Review status. You will receive an immediate notification here once BEXORA Moderation approves or reviews your submission.`,
          refType: 'listing',
          refId: targetListingId,
          referenceLabel: `${platformDef.name} · ${subcategory}`,
          destination: `listing:${targetListingId}`,
        });
      }

      onCreated(
        editingListing
          ? 'Listing updated and resubmitted for administrator moderation.'
          : 'Listing submitted for administrator moderation.'
      );
      onClose();
    } catch (err) {
      setError(extractUserFacingFirestoreError(err, 'Failed to submit listing.'));
    } finally {
      setSubmitting(false);
    }
  };

  const allSelected =
    enabledMonetizationOptions.length > 0 &&
    enabledMonetizationOptions.every((o) => claimedOptions.includes(o.id));

  return (
    <section className="bx-wrap py-6 sm:py-8 space-y-6" aria-label="Create digital asset listing">
      <div className="max-w-4xl mx-auto flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onClose}
          className="bx-btn bx-btn-sm inline-flex items-center gap-2"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Marketplace</span>
        </button>

        <span className="bx-hint">
          Step {step + 1} of 4 — Verified Moderation Workflow
        </span>
      </div>

      <div className="bx-card max-w-4xl mx-auto p-5 sm:p-8 space-y-6">
        {/* Header */}
        <div className="pb-4 border-b flex flex-wrap items-start justify-between gap-3" style={{ borderColor: 'var(--border-soft)' }}>
          <div>
            <h1 className="text-xl sm:text-2xl font-black">
              {editingListing
                ? editingListing.status === 'rejected'
                  ? 'Edit & Resubmit Listing'
                  : 'Resume Asset Draft'
                : 'Sell a Digital Asset'}
            </h1>
            <p className="bx-hint mt-0.5">
              Complete all 4 verification steps to list your asset with BEXORA 3-party Escrow protection, or save a draft at any time.
            </p>
            {editingListing?.rejectionReason && (
              <p className="text-xs font-bold text-red-600 mt-1.5">
                Moderator Feedback: {editingListing.rejectionReason}
              </p>
            )}
          </div>
          {platform && (
            <button
              type="button"
              disabled={savingDraft || submitting}
              onClick={handleSaveDraft}
              className="bx-btn bx-btn-sm font-extrabold"
            >
              {savingDraft ? 'Saving Draft…' : 'Save as Draft'}
            </button>
          )}
        </div>

        {/* Step Indicator */}
        <div className="grid grid-cols-4 gap-2">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-1.5 rounded-full transition-colors"
              style={{ background: i <= step ? 'var(--orange)' : 'var(--border-soft)' }}
            />
          ))}
        </div>

        {error && (
          <div
            className="p-3 rounded-xl text-xs font-bold flex items-start gap-2"
            style={{ background: 'var(--red-soft)', color: 'var(--red)' }}
            role="alert"
          >
            <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* STEP 1: Platform, Subcategory & Title */}
        {step === 0 && (
          <div className="space-y-4">
            <div>
              <span className="bx-label">1. Choose Platform</span>
              <div className="bx-cat-grid">
                {PLATFORM_LIST.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => selectPlatform(p)}
                    className={`bx-cat-card ${platform === p ? 'active' : ''}`}
                    aria-pressed={platform === p}
                  >
                    <PlatformIcon id={p} size={24} />
                    <span className="text-[11px] font-bold truncate max-w-full">
                      {PLATFORM_CATALOG[p].name}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {platformDef && platformDef.subcategories.length > 1 && (
              <div>
                <label htmlFor="crt-subcat" className="bx-label">
                  Asset Subcategory
                </label>
                <select
                  id="crt-subcat"
                  value={subcategory}
                  onChange={(e) => {
                    setSubcategory(e.target.value);
                    if (e.target.value === 'Facebook Group') {
                      setMonetizationStatus('');
                      setClaimedOptions([]);
                    }
                  }}
                  className="bx-select"
                >
                  {platformDef.subcategories.map((sub) => (
                    <option key={sub} value={sub}>
                      {sub}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label htmlFor="crt-title" className="bx-label">
                Listing Title
              </label>
              <input
                id="crt-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Tech Review YouTube Channel — Organic Audience"
                className="bx-input"
              />
              <p className="bx-hint mt-1">{title.trim().length}/120 characters (no phone numbers or emails).</p>
            </div>
          </div>
        )}

        {/* STEP 2: Category-Specific Details, Age, Link / Gaming UID, and Dynamic Monetization */}
        {step === 1 && platform && platformDef && (
          <div className="space-y-4">
            {/* Required Account Age (Years & Months 0–11) */}
            <div>
              <span className="bx-label">
                {platform === 'youtube' ? 'Channel Age' : 'Account / Asset Age'} (Required)
              </span>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="crt-age-years" className="bx-hint block mb-1">
                    Years (0–50)
                  </label>
                  <input
                    id="crt-age-years"
                    type="number"
                    min="0"
                    max="50"
                    inputMode="numeric"
                    value={ageYears}
                    onChange={(e) => setAgeYears(e.target.value)}
                    placeholder="e.g. 2"
                    className="bx-input"
                  />
                </div>
                <div>
                  <label htmlFor="crt-age-months" className="bx-hint block mb-1">
                    Months (0–11)
                  </label>
                  <input
                    id="crt-age-months"
                    type="number"
                    min="0"
                    max="11"
                    inputMode="numeric"
                    value={ageMonths}
                    onChange={(e) => setAgeMonths(e.target.value)}
                    placeholder="e.g. 5"
                    className="bx-input"
                  />
                </div>
              </div>
            </div>

            {platform === 'gaming' ? (
              <div className="space-y-3.5 p-4 rounded-xl bx-soft">
                <div>
                  <label htmlFor="crt-game-name" className="bx-label">
                    Select Game (Required)
                  </label>
                  <select
                    id="crt-game-name"
                    value={gameName}
                    onChange={(e) => setGameName(e.target.value)}
                    className="bx-select"
                  >
                    {settings.gamingTitles.map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="crt-game-uid" className="bx-label">
                      Game UID / Player ID (Required)
                    </label>
                    <input
                      id="crt-game-uid"
                      type="text"
                      value={gameUid}
                      onChange={(e) => setGameUid(e.target.value)}
                      placeholder="e.g. 5129948210"
                      className="bx-input"
                    />
                  </div>
                  <div>
                    <label htmlFor="crt-game-lvl" className="bx-label">
                      Account Level (Required)
                    </label>
                    <input
                      id="crt-game-lvl"
                      type="number"
                      min="1"
                      inputMode="numeric"
                      value={gameLevel}
                      onChange={(e) => setGameLevel(e.target.value)}
                      placeholder="e.g. 68"
                      className="bx-input"
                    />
                  </div>
                </div>
              </div>
            ) : (
              <>
                {/* Official HTTPS Asset Link */}
                <div>
                  <label htmlFor="crt-url" className="bx-label">
                    Direct Account / Page HTTPS URL (Required & Public)
                  </label>
                  <input
                    id="crt-url"
                    type="url"
                    value={accountUrl}
                    onChange={(e) => setAccountUrl(e.target.value)}
                    placeholder={platformDef.urlHint}
                    className="bx-input"
                  />
                  <p className="bx-hint mt-1">
                    Validated against official {platformDef.name} domains. Visible publicly to all visitors; never include passwords or tokens.
                  </p>
                </div>

                {/* Exact Numeric Audience Metric */}
                <div>
                  <label htmlFor="crt-metric" className="bx-label">
                    {getCategoryMetricLabel(platform, subcategory)}
                  </label>
                  <input
                    id="crt-metric"
                    type="number"
                    min="0"
                    inputMode="numeric"
                    value={metricValue}
                    onChange={(e) => setMetricValue(e.target.value)}
                    placeholder="Enter exact count"
                    className="bx-input"
                  />
                </div>

                {/* Explicit Monetized vs Non-Monetized Selection */}
                {supportsMonetizationHere && (
                  <div className="space-y-3">
                    <span className="bx-label">Monetization Status (Explicit Selection Required)</span>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setMonetizationStatus('monetized')}
                        className="py-3 px-4 rounded-xl font-bold text-sm border-2 transition-colors"
                        style={{
                          borderColor:
                            monetizationStatus === 'monetized' ? 'var(--orange)' : 'var(--border-soft)',
                          background:
                            monetizationStatus === 'monetized' ? 'var(--orange-soft)' : 'var(--surface)',
                          color: 'var(--text)',
                        }}
                      >
                        Monetized
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setMonetizationStatus('non-monetized');
                          setClaimedOptions([]);
                          setMonthlyRevenue('');
                        }}
                        className="py-3 px-4 rounded-xl font-bold text-sm border-2 transition-colors"
                        style={{
                          borderColor:
                            monetizationStatus === 'non-monetized'
                              ? 'var(--purple)'
                              : 'var(--border-soft)',
                          background:
                            monetizationStatus === 'non-monetized'
                              ? 'var(--purple-soft)'
                              : 'var(--surface)',
                          color: 'var(--text)',
                        }}
                      >
                        Non-Monetized
                      </button>
                    </div>

                    {monetizationStatus === 'monetized' && (
                      <div className="p-4 rounded-xl bx-soft space-y-3">
                        <span className="bx-label">
                          Select Active {platformDef.name} Monetization Programs
                        </span>
                        {enabledMonetizationOptions.length > 0 ? (
                          <div className="space-y-2">
                            <label className="flex items-center gap-2.5 p-2.5 rounded-lg border cursor-pointer text-xs font-extrabold" style={{ background: 'var(--surface)', borderColor: 'var(--border-soft)' }}>
                              <input
                                type="checkbox"
                                checked={allSelected}
                                onChange={(e) =>
                                  setClaimedOptions(
                                    e.target.checked ? enabledMonetizationOptions.map((o) => o.id) : []
                                  )
                                }
                                className="w-4 h-4 accent-purple-700"
                              />
                              <span>All Monetization ({enabledMonetizationOptions.length})</span>
                            </label>
                            {enabledMonetizationOptions.map((opt) => (
                              <label
                                key={opt.id}
                                className="flex items-center gap-2.5 p-2.5 rounded-lg border cursor-pointer text-xs font-bold"
                                style={{ background: 'var(--surface)', borderColor: 'var(--border-soft)' }}
                              >
                                <input
                                  type="checkbox"
                                  checked={claimedOptions.includes(opt.id)}
                                  onChange={() =>
                                    setClaimedOptions((prev) =>
                                      prev.includes(opt.id)
                                        ? prev.filter((x) => x !== opt.id)
                                        : [...prev, opt.id]
                                    )
                                  }
                                  className="w-4 h-4 accent-purple-700"
                                />
                                <span>{opt.name}</span>
                              </label>
                            ))}
                          </div>
                        ) : (
                          <p className="bx-hint">No monetization programs are currently enabled for this platform.</p>
                        )}

                        <div>
                          <label htmlFor="crt-rev" className="bx-label">
                            Average Monthly Revenue ({currency}, Optional)
                          </label>
                          <input
                            id="crt-rev"
                            type="number"
                            min="0"
                            inputMode="numeric"
                            value={monthlyRevenue}
                            onChange={(e) => setMonthlyRevenue(e.target.value)}
                            placeholder="0"
                            className="bx-input"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* STEP 3: Pricing, Description, Listing Showcase Images & Monetization Evidence */}
        {step === 2 && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label htmlFor="crt-currency" className="bx-label">
                  Currency
                </label>
                <select
                  id="crt-currency"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
                  className="bx-select"
                >
                  <option value="BDT">BDT (৳)</option>
                  <option value="USD">USD ($)</option>
                </select>
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="crt-price" className="bx-label">
                  Asking Price ({currency})
                </label>
                <input
                  id="crt-price"
                  type="number"
                  min="1"
                  inputMode="decimal"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="e.g. 25000"
                  className="bx-input"
                />
              </div>
            </div>

            <div>
              <label htmlFor="crt-desc" className="bx-label">
                Detailed Asset Description
              </label>
              <textarea
                id="crt-desc"
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe audience demographics, content niche, growth history, and handover readiness…"
                className="bx-textarea"
              />
              <p className="bx-hint mt-1">
                Do not include phone numbers, email addresses, WhatsApp handles, or passwords.
              </p>
            </div>

            {/* Product Listing Showcase Image Upload (Restored & Fully Functional) */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="bx-label !mb-0">
                  Product / Asset Showcase Images ({listingImages.length}/4)
                </span>
                <input
                  ref={listingImgInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  onChange={(e) => handleListingImageFiles(e.target.files)}
                  className="hidden"
                />
                <button
                  type="button"
                  disabled={uploadingImg || listingImages.length >= 4}
                  onClick={() => listingImgInputRef.current?.click()}
                  className="bx-btn bx-btn-sm"
                >
                  <ImagePlus className="w-4 h-4" />
                  <span>{uploadingImg ? 'Processing…' : 'Upload Images'}</span>
                </button>
              </div>
              <p className="bx-hint">
                JPEG, PNG, or WebP up to 5 MB each. Publicly visible on your listing card and gallery.
              </p>

              {listingImages.length === 0 ? (
                <button
                  type="button"
                  onClick={() => listingImgInputRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    handleListingImageFiles(e.dataTransfer.files);
                  }}
                  className="w-full p-6 rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-2 text-center transition-colors"
                  style={{ borderColor: 'var(--border-soft)', background: 'var(--surface-2)' }}
                >
                  <Upload className="w-6 h-6" style={{ color: 'var(--orange)' }} />
                  <span className="text-xs font-bold">
                    Click or drag & drop asset screenshots here
                  </span>
                </button>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  {listingImages.map((src, idx) => (
                    <div key={idx} className="relative aspect-[16/10] rounded-xl overflow-hidden border" style={{ borderColor: 'var(--border-soft)' }}>
                      <img src={src} alt={`Listing preview ${idx + 1}`} className="w-full h-full object-cover" />
                      <button
                        type="button"
                        onClick={() => setListingImages((prev) => prev.filter((_, i) => i !== idx))}
                        className="absolute top-1.5 right-1.5 w-7 h-7 rounded-lg bg-black/75 text-white grid place-items-center"
                        aria-label={`Remove image ${idx + 1}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Private Monetization Verification Evidence Upload */}
            {supportsMonetizationHere && monetizationStatus === 'monetized' && (
              <div className="p-4 rounded-xl bx-soft space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="bx-label !mb-0">
                    Private Monetization Proof Screenshots ({evidenceImages.length}/3)
                  </span>
                  <input
                    ref={evidenceImgInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    multiple
                    onChange={(e) => handleEvidenceImageFiles(e.target.files)}
                    className="hidden"
                  />
                  <button
                    type="button"
                    disabled={uploadingEvidence || evidenceImages.length >= 3}
                    onClick={() => evidenceImgInputRef.current?.click()}
                    className="bx-btn bx-btn-sm bx-btn-purple"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>{uploadingEvidence ? 'Processing…' : 'Attach Proof'}</span>
                  </button>
                </div>
                <p className="bx-hint">
                  Stored privately for administrator & AI evidence review only. Never include passwords or recovery codes.
                </p>

                {evidenceImages.length > 0 && (
                  <div className="grid grid-cols-3 gap-2">
                    {evidenceImages.map((src, idx) => (
                      <div key={idx} className="relative aspect-[16/10] rounded-lg overflow-hidden border" style={{ borderColor: 'var(--border-soft)' }}>
                        <img src={src} alt={`Monetization proof ${idx + 1}`} className="w-full h-full object-cover" />
                        <button
                          type="button"
                          onClick={() => setEvidenceImages((prev) => prev.filter((_, i) => i !== idx))}
                          className="absolute top-1 right-1 w-6 h-6 rounded bg-black/75 text-white grid place-items-center"
                          aria-label={`Remove proof ${idx + 1}`}
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* STEP 4: Review & Submit */}
        {step === 3 && platform && platformDef && (
          <div className="space-y-4">
            <div className="p-4 rounded-xl bx-soft space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <span style={{ color: 'var(--text-2)' }}>Platform & Type</span>
                <span className="font-bold">
                  {platformDef.name} · {subcategory}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span style={{ color: 'var(--text-2)' }}>Title</span>
                <span className="font-bold text-right">{title}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span style={{ color: 'var(--text-2)' }}>Age</span>
                <span className="font-bold">
                  {formatAccountAge(Number(ageYears), Number(ageMonths))}
                </span>
              </div>
              {platform === 'gaming' ? (
                <div className="flex justify-between gap-4">
                  <span style={{ color: 'var(--text-2)' }}>Game & UID</span>
                  <span className="font-bold">
                    {gameName} · UID {gameUid} (Lvl {gameLevel})
                  </span>
                </div>
              ) : (
                <div className="flex justify-between gap-4">
                  <span style={{ color: 'var(--text-2)' }}>Asset Link</span>
                  <span className="font-bold truncate max-w-[240px]">{accountUrl}</span>
                </div>
              )}
              <div className="flex justify-between gap-4">
                <span style={{ color: 'var(--text-2)' }}>Asking Price</span>
                <span className="font-extrabold">
                  {formatMoneyFromMinor(Math.round(Number(price) * 100), currency, currency)}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span style={{ color: 'var(--text-2)' }}>Showcase Images</span>
                <span className="font-bold">{listingImages.length} attached</span>
              </div>
            </div>

            <div className="p-3.5 rounded-xl text-xs font-semibold leading-relaxed" style={{ background: 'var(--yellow-soft)', color: '#6E5600' }}>
              Your listing enters <strong>Pending Review</strong>. Claimed monetization programs are displayed as verified only after administrator evidence verification completes.
            </div>
          </div>
        )}

        {/* Navigation Actions */}
        <div className="flex flex-wrap items-center gap-2.5 pt-2">
          {step > 0 && (
            <button
              type="button"
              disabled={submitting || savingDraft}
              onClick={() => {
                setError('');
                setStep((s) => (s - 1) as 0 | 1 | 2 | 3);
              }}
              className="bx-btn"
            >
              Back
            </button>
          )}
          {platform && (
            <button
              type="button"
              disabled={submitting || savingDraft}
              onClick={handleSaveDraft}
              className="bx-btn font-bold"
            >
              {savingDraft ? 'Saving…' : 'Save Draft'}
            </button>
          )}
          {step < 3 ? (
            <button type="button" onClick={handleNext} className="bx-btn bx-btn-primary flex-1">
              Continue
            </button>
          ) : (
            <button
              type="button"
              disabled={submitting || savingDraft}
              onClick={handleSubmit}
              className="bx-btn bx-btn-primary flex-1"
            >
              {submitting
                ? 'Submitting Listing…'
                : editingListing
                ? 'Resubmit Listing for Review'
                : 'Submit Listing for Review'}
            </button>
          )}
        </div>
      </div>
    </section>
  );
};
