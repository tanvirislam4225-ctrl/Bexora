import React, { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ImagePlus,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  ZoomIn,
} from 'lucide-react';
import type { DealRecord } from '../types';
import { validateAndProcessImageFile } from '../lib/firebase';
import {
  detectSensitiveOrOffPlatformContent,
  getPlatformTransferChecklist,
  PLATFORM_CATALOG,
  validateTransferSubmissionInput,
} from '../lib/marketplaceLogic';
import { ImageLightboxModal } from './ImageLightboxModal';

interface SellerAssetTransferBoxProps {
  deal: DealRecord;
  busy: boolean;
  onSubmitTransfer: (payload: {
    screenshots: string[];
    transferNote: string;
    completedSteps: string[];
  }) => Promise<void>;
}

export const SellerAssetTransferBox: React.FC<SellerAssetTransferBoxProps> = ({
  deal,
  busy,
  onSubmitTransfer,
}) => {
  const checklistItems = useMemo(
    () => getPlatformTransferChecklist(deal.platform),
    [deal.platform]
  );
  const platformLabel = PLATFORM_CATALOG[deal.platform]?.name || deal.platform;

  const [screenshots, setScreenshots] = useState<string[]>([]);
  const [checkedSteps, setCheckedSteps] = useState<Record<string, boolean>>({});
  const [transferNote, setTransferNote] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [processingSlot, setProcessingSlot] = useState<number | 'append' | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const appendInputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const [replaceTargetIndex, setReplaceTargetIndex] = useState<number | null>(null);

  const nextVersion = (deal.transferSubmissionCount || 0) + 1;
  const completedSteps = useMemo(
    () => checklistItems.filter((step) => Boolean(checkedSteps[step])),
    [checklistItems, checkedSteps]
  );

  const handleAppendFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;

    setLocalError(null);
    const remainingSlots = 3 - screenshots.length;
    if (remainingSlots <= 0) {
      setLocalError('Maximum 3 transfer proof screenshots allowed. Use Replace on an existing slot.');
      return;
    }

    setProcessingSlot('append');
    try {
      const toProcess = files.slice(0, remainingSlots);
      const processed: string[] = [];
      for (const file of toProcess) {
        const dataUrl = await validateAndProcessImageFile(file);
        processed.push(dataUrl);
      }
      setScreenshots((prev) => [...prev, ...processed].slice(0, 3));
      if (files.length > remainingSlots) {
        setLocalError('Only up to 3 screenshots can be attached per transfer submission.');
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Could not process screenshot image.');
    } finally {
      setProcessingSlot(null);
    }
  };

  const handleReplaceFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    const idx = replaceTargetIndex;
    setReplaceTargetIndex(null);
    if (!file || idx === null || idx < 0 || idx >= screenshots.length) return;

    setLocalError(null);
    setProcessingSlot(idx);
    try {
      const dataUrl = await validateAndProcessImageFile(file);
      setScreenshots((prev) => prev.map((existing, i) => (i === idx ? dataUrl : existing)));
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Could not replace screenshot image.');
    } finally {
      setProcessingSlot(null);
    }
  };

  const handleRemoveIndex = (index: number) => {
    setScreenshots((prev) => prev.filter((_, idx) => idx !== index));
    setLocalError(null);
  };

  const toggleStep = (step: string) => {
    setCheckedSteps((prev) => ({ ...prev, [step]: !prev[step] }));
    setLocalError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    const moderationIssue = detectSensitiveOrOffPlatformContent(transferNote);
    if (moderationIssue.blocked) {
      setLocalError(moderationIssue.reason || 'Sensitive or off-platform content is not allowed.');
      return;
    }

    const validation = validateTransferSubmissionInput({
      screenshots,
      transferNote,
      completedSteps,
    });

    if (!validation.valid) {
      setLocalError(validation.error || 'Please complete all transfer proof requirements.');
      return;
    }

    await onSubmitTransfer({
      screenshots,
      transferNote: validation.cleanNote,
      completedSteps: validation.cleanSteps,
    });

    setScreenshots([]);
    setTransferNote('');
    setCheckedSteps({});
  };

  return (
    <section
      aria-label="Seller Asset Transfer Proof Submission"
      className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 sm:p-6 space-y-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span>Seller-Only Asset Handover</span>
            <span aria-hidden="true">·</span>
            <span>Submission v{nextVersion}</span>
            <span aria-hidden="true">·</span>
            <span>{platformLabel}</span>
          </div>
          <h4 className="mt-1 text-base font-bold text-slate-900 dark:text-white">
            {deal.status === 'transfer_rejected'
              ? 'Resubmit Updated Asset Transfer Proof'
              : 'Submit Official Asset Transfer Proof'}
          </h4>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Upload <strong>2 to 3 clear transfer screenshots</strong>, check off completed {platformLabel} handover steps, and write handover confirmation notes for the buyer and BEXORA Admin. Never paste raw passwords in notes.
          </p>
        </div>
        <div className="text-right text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
          <div>Screenshots: {screenshots.length} / 3 (min 2)</div>
          <div>Checklist: {completedSteps.length} / {checklistItems.length}</div>
        </div>
      </div>

      {deal.status === 'transfer_rejected' && deal.latestRejectionReason && (
        <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50/80 dark:bg-amber-950/30 p-3.5 text-xs text-amber-900 dark:text-amber-200 space-y-1">
          <div className="flex items-center gap-1.5 font-semibold">
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span>Buyer Rejected Previous Transfer Submission</span>
          </div>
          <p className="leading-relaxed">
            Reason recorded: <span className="font-medium">&ldquo;{deal.latestRejectionReason}&rdquo;</span>. Prior evidence remains preserved in the audit log below. Address the issue and upload 2–3 fresh verification screenshots.
          </p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Step 1: 2 to 3 Proof Screenshots */}
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="text-xs font-semibold text-slate-800 dark:text-slate-200">
              1. Transfer Proof Screenshots (Required: 2 to 3 JPG/PNG/WebP images)
            </label>
            {screenshots.length < 3 && (
              <button
                type="button"
                disabled={busy || processingSlot !== null}
                onClick={() => appendInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                <ImagePlus className="w-3.5 h-3.5" />
                {processingSlot === 'append' ? 'Compressing...' : `Add Screenshot (${screenshots.length}/3)`}
              </button>
            )}
          </div>

          <input
            ref={appendInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            onChange={handleAppendFiles}
            className="hidden"
          />
          <input
            ref={replaceInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={handleReplaceFile}
            className="hidden"
          />

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[0, 1, 2].map((slotIdx) => {
              const imgSrc = screenshots[slotIdx];
              const isRequiredSlot = slotIdx < 2;
              if (imgSrc) {
                return (
                  <div
                    key={slotIdx}
                    className="group relative overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950"
                  >
                    <button
                      type="button"
                      onClick={() => setLightboxIndex(slotIdx)}
                      aria-label={`Enlarge proof screenshot ${slotIdx + 1}`}
                      className="block w-full h-36 overflow-hidden focus:outline-none"
                    >
                      <img
                        src={imgSrc}
                        alt={`Transfer proof screenshot ${slotIdx + 1}`}
                        referrerPolicy="no-referrer"
                        className="h-full w-full object-cover transition-transform duration-150 group-hover:scale-[1.02]"
                      />
                    </button>
                    <div className="flex items-center justify-between gap-1 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-2 text-xs">
                      <button
                        type="button"
                        onClick={() => setLightboxIndex(slotIdx)}
                        className="inline-flex items-center gap-1 font-medium text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white"
                      >
                        <ZoomIn className="w-3.5 h-3.5" />
                        <span>Proof #{slotIdx + 1}</span>
                      </button>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          disabled={busy || processingSlot !== null}
                          onClick={() => {
                            setReplaceTargetIndex(slotIdx);
                            replaceInputRef.current?.click();
                          }}
                          aria-label={`Replace proof screenshot ${slotIdx + 1}`}
                          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                        >
                          <RefreshCw className="w-3 h-3" />
                          Replace
                        </button>
                        <button
                          type="button"
                          disabled={busy || processingSlot !== null}
                          onClick={() => handleRemoveIndex(slotIdx)}
                          aria-label={`Remove proof screenshot ${slotIdx + 1}`}
                          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors"
                        >
                          <Trash2 className="w-3 h-3" />
                          Remove
                        </button>
                      </div>
                    </div>
                  </div>
                );
              }

              return (
                <button
                  key={slotIdx}
                  type="button"
                  disabled={busy || processingSlot !== null}
                  onClick={() => appendInputRef.current?.click()}
                  className="flex h-44 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-950/40 p-4 text-center hover:border-slate-400 dark:hover:border-slate-600 transition-colors disabled:opacity-50"
                >
                  <ImagePlus className="w-5 h-5 text-slate-400" />
                  <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    Screenshot Slot #{slotIdx + 1}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                    {isRequiredSlot ? 'Required proof image' : 'Optional 3rd proof image'}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Step 2: Platform Handover Checklist */}
        <div className="space-y-2">
          <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
            2. Completed {platformLabel} Transfer Steps (Check at least 1)
          </div>
          <div className="grid grid-cols-1 gap-2">
            {checklistItems.map((step) => {
              const checked = Boolean(checkedSteps[step]);
              return (
                <label
                  key={step}
                  className={`flex items-start gap-2.5 rounded-lg border p-3 text-xs cursor-pointer transition-colors ${
                    checked
                      ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/20 text-slate-900 dark:text-white'
                      : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/40'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleStep(step)}
                    className="mt-0.5 h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                  />
                  <span className="leading-relaxed">{step}</span>
                </label>
              );
            })}
          </div>
        </div>

        {/* Step 3: Handover Note */}
        <div className="space-y-1.5">
          <label
            htmlFor={`transfer-note-${deal.id}`}
            className="block text-xs font-semibold text-slate-800 dark:text-slate-200"
          >
            3. Seller Transfer Confirmation Note
          </label>
          <textarea
            id={`transfer-note-${deal.id}`}
            rows={3}
            value={transferNote}
            onChange={(e) => {
              setTransferNote(e.target.value);
              if (localError) setLocalError(null);
            }}
            placeholder="Describe which email/admin invite was granted, what each screenshot shows, and what the buyer should verify right now..."
            className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2.5 text-sm text-slate-900 dark:text-white focus:outline-none focus:border-slate-900 dark:focus:border-amber-400"
          />
          <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
            <span>Visible only to Buyer, Seller, and BEXORA Admin inside this Deal Room.</span>
            <span className="font-mono tabular-nums">{transferNote.trim().length} / 1500</span>
          </div>
        </div>

        {localError && (
          <div
            role="alert"
            className="rounded-lg border border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/40 px-3.5 py-2.5 text-xs text-rose-700 dark:text-rose-300"
          >
            {localError}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span>
              Buyer approval starts the{' '}
              <strong>
                {deal.platform === 'youtube' ? '7-day (168h)' : '40-hour'}
              </strong>{' '}
              escrow security timer.
            </span>
          </div>
          <button
            type="submit"
            disabled={busy || processingSlot !== null || screenshots.length < 2}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-900 dark:bg-amber-500 px-4 py-2.5 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-amber-400 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
            {busy ? 'Submitting Proof...' : `Submit Transfer Proof (v${nextVersion})`}
          </button>
        </div>
      </form>

      <ImageLightboxModal
        images={screenshots.map((src, idx) => ({
          src,
          caption: `Draft Transfer Proof Screenshot #${idx + 1} (Submission v${nextVersion})`,
        }))}
        activeIndex={lightboxIndex}
        title={`Draft Transfer Proof · ${deal.listingTitle}`}
        onClose={() => setLightboxIndex(null)}
        onChangeIndex={setLightboxIndex}
      />
    </section>
  );
};
