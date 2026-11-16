import React from 'react';
import { Megaphone, Send } from 'lucide-react';
import type {
  AnnouncementRecord,
  NotificationCategory,
  NotificationSeverity,
} from '../../types';
import { DismissibleNotice } from '../DismissibleNotice';

interface AdminAnnouncementsSectionProps {
  notifMode: 'broadcast_announcement' | 'targeted_user';
  setNotifMode: (v: 'broadcast_announcement' | 'targeted_user') => void;
  notifTargetUid: string;
  setNotifTargetUid: (v: string) => void;
  notifCategory: NotificationCategory;
  setNotifCategory: (v: NotificationCategory) => void;
  notifSeverity: NotificationSeverity;
  setNotifSeverity: (v: NotificationSeverity) => void;
  notifTitle: string;
  setNotifTitle: (v: string) => void;
  notifPreview: string;
  setNotifPreview: (v: string) => void;
  notifBody: string;
  setNotifBody: (v: string) => void;
  notifDestination: string;
  setNotifDestination: (v: string) => void;
  notifPersistBanner: boolean;
  setNotifPersistBanner: (v: boolean) => void;
  sendingAdminNotif: boolean;
  announcements: AnnouncementRecord[];
  onPublishAdminAlert: (e: React.FormEvent) => void;
  onArchiveAnnouncement: (announcementId: string) => void;
}

export const AdminAnnouncementsSection: React.FC<AdminAnnouncementsSectionProps> = ({
  notifMode,
  setNotifMode,
  notifTargetUid,
  setNotifTargetUid,
  notifCategory,
  setNotifCategory,
  notifSeverity,
  setNotifSeverity,
  notifTitle,
  setNotifTitle,
  notifPreview,
  setNotifPreview,
  notifBody,
  setNotifBody,
  notifDestination,
  setNotifDestination,
  notifPersistBanner,
  setNotifPersistBanner,
  sendingAdminNotif,
  announcements,
  onPublishAdminAlert,
  onArchiveAnnouncement,
}) => (
  <div className="space-y-6">
    <div className="bx-card p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--bx-border)] pb-3">
        <div className="w-full">
          <h1 className="text-xl font-black flex items-center gap-2">
            <Megaphone className="w-5 h-5 text-[#FF6500]" />
            Platform Announcements &amp; Targeted User Alerts
          </h1>
          <DismissibleNotice id="announcements-intro" className="mt-1">
            <p className="text-xs opacity-75">
              Publish official BEXORA announcements to the Header Notification Center or send direct notices to an individual member UID.
            </p>
          </DismissibleNotice>
        </div>
      </div>

      <form onSubmit={onPublishAdminAlert} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="block space-y-1 text-xs font-bold">
            <span>Delivery Mode</span>
            <select
              value={notifMode}
              onChange={(e) => setNotifMode(e.target.value as 'broadcast_announcement' | 'targeted_user')}
              className="bx-input w-full px-3 py-2 text-xs font-bold"
            >
              <option value="broadcast_announcement">Platform Broadcast Announcement</option>
              <option value="targeted_user">Targeted Single User (by UID)</option>
            </select>
          </label>

          <label className="block space-y-1 text-xs font-bold">
            <span>Severity</span>
            <select
              value={notifSeverity}
              onChange={(e) => setNotifSeverity(e.target.value as NotificationSeverity)}
              className="bx-input w-full px-3 py-2 text-xs font-bold"
            >
              <option value="info">Info</option>
              <option value="success">Success</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical Security / Maintenance</option>
            </select>
          </label>

          <label className="block space-y-1 text-xs font-bold">
            <span>Optional Destination Button</span>
            <select
              value={notifDestination}
              onChange={(e) => setNotifDestination(e.target.value)}
              className="bx-input w-full px-3 py-2 text-xs font-bold"
            >
              <option value="">None (Read-Only Message)</option>
              <option value="marketplace">Marketplace Home</option>
              <option value="deals">Escrow Deals</option>
              <option value="wallet">Wallet</option>
              <option value="profile">Account Profile</option>
              <option value="profile:nid">NID Verification</option>
            </select>
          </label>
        </div>

        {notifMode === 'targeted_user' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block space-y-1 text-xs font-bold">
              <span>Target User UID</span>
              <input
                type="text"
                required
                value={notifTargetUid}
                onChange={(e) => setNotifTargetUid(e.target.value)}
                placeholder="Paste member Firebase UID"
                className="bx-input w-full px-3 py-2 text-xs font-mono"
              />
            </label>
            <label className="block space-y-1 text-xs font-bold">
              <span>Category</span>
              <select
                value={notifCategory}
                onChange={(e) => setNotifCategory(e.target.value as NotificationCategory)}
                className="bx-input w-full px-3 py-2 text-xs font-bold"
              >
                <option value="system">System Notice</option>
                <option value="security">Security Alert</option>
                <option value="verification">Verification</option>
                <option value="deal">Escrow Deal</option>
                <option value="wallet">Wallet</option>
                <option value="listing">Listing Moderation</option>
              </select>
            </label>
          </div>
        ) : (
          <label className="inline-flex items-center gap-2 text-xs font-bold cursor-pointer">
            <input
              type="checkbox"
              checked={notifPersistBanner}
              onChange={(e) => setNotifPersistBanner(e.target.checked)}
            />
            <span>Also keep active in public `/announcements` feed for visitors and future sign-ups</span>
          </label>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block space-y-1 text-xs font-bold">
            <span>Notification Title (max 140 chars)</span>
            <input
              type="text"
              required
              maxLength={140}
              value={notifTitle}
              onChange={(e) => setNotifTitle(e.target.value)}
              placeholder="e.g. Scheduled Escrow Verification Upgrade"
              className="bx-input w-full px-3 py-2 text-xs"
            />
          </label>
          <label className="block space-y-1 text-xs font-bold">
            <span>Short List Preview (optional, max 240 chars)</span>
            <input
              type="text"
              maxLength={240}
              value={notifPreview}
              onChange={(e) => setNotifPreview(e.target.value)}
              placeholder="Concise summary shown in the header dropdown"
              className="bx-input w-full px-3 py-2 text-xs"
            />
          </label>
        </div>

        <label className="block space-y-1 text-xs font-bold">
          <span>Full Notification Content (shown when user clicks View, max 2000 chars)</span>
          <textarea
            required
            rows={4}
            maxLength={2000}
            value={notifBody}
            onChange={(e) => setNotifBody(e.target.value)}
            placeholder="Write the complete notification message..."
            className="bx-input w-full px-3 py-2 text-xs"
          />
        </label>

        <button
          type="submit"
          disabled={sendingAdminNotif}
          className="bx-btn bx-btn-primary px-5 py-2.5 text-xs font-extrabold inline-flex items-center gap-2"
        >
          <Send className="w-4 h-4" />
          {sendingAdminNotif
            ? 'Publishing Notification…'
            : notifMode === 'broadcast_announcement'
            ? 'Publish Broadcast Announcement'
            : 'Send Direct User Notification'}
        </button>
      </form>
    </div>

    <div className="bx-card p-6 space-y-4">
      <h2 className="text-base font-black">Broadcast Announcements History ({announcements.length})</h2>
      {announcements.length === 0 ? (
        <p className="text-xs opacity-75">No broadcast announcements published yet.</p>
      ) : (
        <div className="space-y-3">
          {announcements.map((ann) => (
            <div
              key={ann.id}
              className="p-4 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            >
              <div className="space-y-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`text-[10px] font-black uppercase px-2 py-0.5 border border-black ${
                      ann.active ? 'bg-emerald-600 text-white' : 'bg-zinc-500 text-white'
                    }`}
                  >
                    {ann.active ? 'Active' : 'Archived'}
                  </span>
                  <span className="text-[11px] font-bold uppercase opacity-75">{ann.severity}</span>
                  <span className="text-sm font-black truncate">{ann.title}</span>
                </div>
                <p className="text-xs opacity-80 line-clamp-2">{ann.body}</p>
              </div>
              {ann.active && (
                <button
                  type="button"
                  onClick={() => onArchiveAnnouncement(ann.id)}
                  className="bx-btn bx-btn-ghost px-3 py-1.5 text-xs font-extrabold shrink-0"
                >
                  Archive
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  </div>
);
