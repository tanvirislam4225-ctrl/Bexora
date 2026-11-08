import React, { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Film,
  Flag,
  ImagePlus,
  Lock,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import { UserProfile } from '../types';
import { UserReportCategory, UserReportRecord } from '../types/moderation';
import { validateAndProcessImageFile } from '../lib/firebase';
import {
  extractVideoFramesBase64,
  formatSurfaceLabel,
  ReportModalTarget,
  stripDataUrlPrefix,
  submitUserReportClient,
  USER_REPORT_CATEGORIES,
} from '../lib/moderationClient';

interface ReportUserModalProps {
  target: ReportModalTarget | null;
  currentUser: { uid: string; displayName?: string | null } | null;
  onClose: () => void;
  onRequireAuth: () => void;
  onSubmitted?: (report: UserReportRecord) => void;
}

interface AttachedEvidenceItem {
  id: string;
  label: string;
  mimeType: string;
  base64Data: string;
  previewDataUrl: string;
}

export function ReportUserModal({
  target,
  currentUser,
  onClose,
  onRequireAuth,
  onSubmitted,
}: ReportUserModalProps) {
  const [category, setCategory] = useState<UserReportCategory>(
    target?.defaultCategory || 'scam_fraud_attempt'
  );
  const [description, setDescription] = useState('');
  const [attachments, setAttachments] = useState<AttachedEvidenceItem[]>([]);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submittedReport, setSubmittedReport] = useState<UserReportRecord | null>(null);

  if (!target) return null;

  const selectedCategoryInfo =
    USER_REPORT_CATEGORIES.find((c) => c.value === category) || USER_REPORT_CATEGORIES[0]!;
  const trimmedLen = description.trim().length;
  const isSelfReport = Boolean(currentUser && currentUser.uid === target.reportedUserId);

  const handleAttachEvidence = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (attachments.length >= 3) {
      setErrorMessage('Maximum 3 evidence attachments allowed per report.');
      return;
    }

    setErrorMessage(null);
    setUploadingMedia(true);
    try {
      const lowerType = String(file.type || '').toLowerCase();
      if (lowerType.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(file.name)) {
        const frames = await extractVideoFramesBase64(file, Math.min(2, 3 - attachments.length), 640);
        const nextItems: AttachedEvidenceItem[] = frames.map((fr, idx) => ({
          id: `vid_${Date.now()}_${idx}`,
          label: `${file.name} (${fr.frameTimestampSec}s frame)`,
          mimeType: fr.mimeType,
          base64Data: fr.base64Data,
          previewDataUrl: `data:${fr.mimeType};base64,${fr.base64Data}`,
        }));
        setAttachments((prev) => [...prev, ...nextItems].slice(0, 3));
      } else {
        const processedDataUrl = await validateAndProcessImageFile(file, 900, 0.72, 175_000);
        const stripped = stripDataUrlPrefix(processedDataUrl);
        setAttachments((prev) =>
          [
            ...prev,
            {
              id: `img_${Date.now()}`,
              label: file.name || 'screenshot.jpg',
              mimeType: stripped.mimeType,
              base64Data: stripped.base64Data,
              previewDataUrl: processedDataUrl,
            },
          ].slice(0, 3)
        );
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Could not process the selected evidence file.'
      );
    } finally {
      setUploadingMedia(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!currentUser) {
      setErrorMessage('Please sign in to submit a verified Trust & Safety report.');
      return;
    }
    if (isSelfReport) {
      setErrorMessage('You cannot submit a report against your own account.');
      return;
    }
    if (trimmedLen < 15) {
      setErrorMessage(
        'Please provide at least 15 characters explaining what happened so our Trust & Safety team can investigate.'
      );
      return;
    }
    if (trimmedLen > 3000) {
      setErrorMessage('Report explanation must be 3,000 characters or fewer.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await submitUserReportClient({
        reporterName: currentUser.displayName || 'Verified Member',
        reportedUserId: target.reportedUserId,
        reportedUserName: target.reportedUserName || 'Marketplace Account',
        category,
        surface: target.surface,
        description: description.trim(),
        listingId: target.listingId,
        dealId: target.dealId,
        conversationId: target.conversationId,
        messageId: target.messageId,
        reviewId: target.reviewId,
        quotedContent: target.quotedContent,
        evidenceAttachments: attachments.map((att) => ({
          mimeType: att.mimeType,
          base64Data: att.base64Data,
          fileName: att.label,
        })),
      });

      if (!res.ok || !res.report) {
        setErrorMessage(res.error || 'Could not submit report. Please try again.');
        return;
      }

      setSubmittedReport(res.report);
      onSubmitted?.(res.report);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="report-user-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-sm p-4 overflow-y-auto"
    >
      <div className="w-full max-w-xl rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden my-auto">
        <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2.5 min-w-0">
            <ShieldAlert className="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0" />
            <div className="min-w-0">
              <h2
                id="report-user-modal-title"
                className="text-base font-bold text-slate-900 dark:text-white truncate"
              >
                Report Account or Conduct
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                {target.reportedUserName} · {formatSurfaceLabel(target.surface)}
                {target.listingTitle ? ` · ${target.listingTitle}` : ''}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close report dialog"
            className="p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {submittedReport ? (
          <div className="p-6 space-y-4">
            <div className="rounded-xl border border-emerald-200 dark:border-emerald-800/60 bg-emerald-50/70 dark:bg-emerald-950/30 p-4 flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
              <div className="space-y-1.5 text-sm">
                <p className="font-semibold text-slate-900 dark:text-white">
                  Report Submitted to BEXORA Trust & Safety
                </p>
                <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                  Our 24/7 AI triage system has logged your evidence and alerted human Trust & Safety
                  administrators for investigation. Your identity remains strictly confidential and is
                  never disclosed to the reported account.
                </p>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-4 space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">Tracking Reference</span>
                <span className="font-mono font-bold text-slate-900 dark:text-white tabular-nums">
                  {submittedReport.trackingRef}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">Initial AI Triage Priority</span>
                <span className="font-semibold text-slate-800 dark:text-slate-200">
                  {submittedReport.aiTriagePriority}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">Status</span>
                <span className="font-medium text-emerald-700 dark:text-emerald-400">
                  Queued for Administrator Review
                </span>
              </div>
            </div>

            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl bg-slate-900 dark:bg-emerald-600 hover:bg-slate-800 dark:hover:bg-emerald-500 text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-5 space-y-4">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 p-3 flex items-start gap-2.5 text-xs text-slate-600 dark:text-slate-300">
              <Lock className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
              <p className="leading-relaxed">
                <span className="font-semibold text-slate-900 dark:text-white">
                  Confidential Reporting:
                </span>{' '}
                Your identity is never shared with {target.reportedUserName}. Quoting abusive words or
                attaching scam screenshots inside this report will never penalize your account.
              </p>
            </div>

            {!currentUser && (
              <div className="rounded-xl border border-amber-200 dark:border-amber-800/60 bg-amber-50/80 dark:bg-amber-950/30 p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="text-xs text-amber-900 dark:text-amber-200">
                  Sign in to your BEXORA account to submit an authenticated report with tracking.
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onRequireAuth();
                  }}
                  className="px-3.5 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
                >
                  Sign In to Report
                </button>
              </div>
            )}

            {target.quotedContent && (
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-3 space-y-1">
                <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  Referenced Context Snapshot
                </div>
                <p className="text-xs text-slate-700 dark:text-slate-300 line-clamp-3 break-words">
                  {target.quotedContent}
                </p>
              </div>
            )}

            <div>
              <label
                htmlFor="report-category-select"
                className="block text-xs font-semibold text-slate-700 dark:text-slate-200 mb-1.5"
              >
                Violation Category
              </label>
              <select
                id="report-category-select"
                value={category}
                onChange={(e) => setCategory(e.target.value as UserReportCategory)}
                className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
              >
                {USER_REPORT_CATEGORIES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                {selectedCategoryInfo.hint}
              </p>
            </div>

            <div>
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <label
                  htmlFor="report-description-textarea"
                  className="text-xs font-semibold text-slate-700 dark:text-slate-200"
                >
                  Detailed Explanation (Required)
                </label>
                <span
                  className={`text-[11px] font-mono tabular-nums ${
                    trimmedLen > 0 && trimmedLen < 15
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-slate-500 dark:text-slate-400'
                  }`}
                >
                  {trimmedLen} / 3000 chars (min 15)
                </span>
              </div>
              <textarea
                id="report-description-textarea"
                rows={4}
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  if (errorMessage) setErrorMessage(null);
                }}
                placeholder="Describe what happened, including any relevant messages, payment requests, or listing discrepancies..."
                className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2.5 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 resize-y"
              />
            </div>

            <div>
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                  Optional Evidence (Screenshots or Short Video Clip, max 3)
                </span>
                <span className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                  {attachments.length} / 3 attached
                </span>
              </div>

              {attachments.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 mb-2.5">
                  {attachments.map((att) => (
                    <div
                      key={att.id}
                      className="relative rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 overflow-hidden p-2 flex items-center gap-2"
                    >
                      <img
                        src={att.previewDataUrl}
                        alt={att.label}
                        referrerPolicy="no-referrer"
                        className="w-10 h-10 rounded-lg object-cover shrink-0 bg-slate-200 dark:bg-slate-800"
                      />
                      <span className="text-[11px] text-slate-700 dark:text-slate-300 truncate flex-1">
                        {att.label}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setAttachments((prev) => prev.filter((item) => item.id !== att.id))
                        }
                        aria-label={`Remove ${att.label}`}
                        className="p-1 rounded-md text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 shrink-0"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {attachments.length < 3 && (
                <label className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 hover:bg-slate-50 dark:hover:bg-slate-800/70 text-xs font-medium text-slate-700 dark:text-slate-200 cursor-pointer transition-colors">
                  <ImagePlus className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <Film className="w-4 h-4 text-slate-400 shrink-0" />
                  <span className="whitespace-nowrap">
                    {uploadingMedia ? 'Processing Evidence...' : 'Attach Screenshot or Video'}
                  </span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime"
                    onChange={handleAttachEvidence}
                    disabled={uploadingMedia || submitting}
                    className="sr-only"
                  />
                </label>
              )}
            </div>

            {errorMessage && (
              <div
                role="alert"
                className="rounded-xl border border-rose-200 dark:border-rose-800/70 bg-rose-50 dark:bg-rose-950/40 px-3.5 py-2.5 flex items-start gap-2 text-xs text-rose-700 dark:text-rose-300"
              >
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{errorMessage}</span>
              </div>
            )}

            <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="px-4 py-2 rounded-xl border border-slate-300 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting || uploadingMedia || isSelfReport}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
              >
                <Flag className="w-3.5 h-3.5 shrink-0" />
                <span>{submitting ? 'Submitting Report...' : 'Submit Confidential Report'}</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
