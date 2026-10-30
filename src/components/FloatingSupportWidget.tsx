import React, { useState } from 'react';
import { Headset, Mail, MessageCircle, Send, X } from 'lucide-react';
import { PublicSettings } from '../types';

interface FloatingSupportWidgetProps {
  settings: PublicSettings;
}

export const FloatingSupportWidget: React.FC<FloatingSupportWidgetProps> = ({ settings }) => {
  const [open, setOpen] = useState(false);

  const cleanWaDigits = (settings.supportWhatsapp || '').replace(/[^0-9]/g, '');
  const waHref = cleanWaDigits ? `https://wa.me/${cleanWaDigits}` : '';

  const rawTg = (settings.supportTelegram || '').trim();
  const tgHref = rawTg
    ? rawTg.startsWith('https://')
      ? rawTg
      : `https://t.me/${rawTg.replace(/^@/, '')}`
    : '';

  const email = (settings.supportEmail || '').trim();
  const mailHref = email ? `mailto:${email}` : '';

  const anyConfigured = Boolean(waHref || tgHref || mailHref);

  return (
    <div className="fixed bottom-20 md:bottom-6 right-4 z-40 flex flex-col items-end gap-2">
      {open && (
        <div
          role="dialog"
          aria-label="BEXORA Support Channels"
          className="bx-card w-72 p-4 space-y-3 shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-[var(--bx-border)] pb-2">
            <div>
              <h3 className="text-sm font-black">BEXORA Support</h3>
              <p className="text-[11px] opacity-75">Official escrow & verification desk</p>
            </div>
            <button
              type="button"
              aria-label="Close support menu"
              onClick={() => setOpen(false)}
              className="p-1 hover:opacity-75"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {!anyConfigured ? (
            <p className="text-xs opacity-80 leading-relaxed">
              Support channels have not been configured yet by the Administrator in Admin Panel → Support Contact Settings.
            </p>
          ) : (
            <div className="space-y-2">
              {waHref && (
                <a
                  href={waHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="bx-btn bx-btn-ghost w-full px-3 py-2 text-xs font-extrabold flex items-center justify-between"
                >
                  <span className="inline-flex items-center gap-2">
                    <MessageCircle className="w-4 h-4 text-emerald-600" />
                    WhatsApp Support
                  </span>
                  <span className="opacity-70">{settings.supportWhatsapp}</span>
                </a>
              )}

              {tgHref && (
                <a
                  href={tgHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="bx-btn bx-btn-ghost w-full px-3 py-2 text-xs font-extrabold flex items-center justify-between"
                >
                  <span className="inline-flex items-center gap-2">
                    <Send className="w-4 h-4 text-sky-500" />
                    Telegram Desk
                  </span>
                  <span className="opacity-70">Open</span>
                </a>
              )}

              {mailHref && (
                <a
                  href={mailHref}
                  className="bx-btn bx-btn-ghost w-full px-3 py-2 text-xs font-extrabold flex items-center justify-between"
                >
                  <span className="inline-flex items-center gap-2">
                    <Mail className="w-4 h-4 text-[#FF6500]" />
                    Email Support
                  </span>
                  <span className="opacity-70 truncate max-w-[120px]">{email}</span>
                </a>
              )}
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        aria-label="Open BEXORA Support"
        onClick={() => setOpen((v) => !v)}
        className="bx-btn bx-btn-primary h-12 px-4 rounded-full font-extrabold text-xs inline-flex items-center gap-2"
      >
        <Headset className="w-4 h-4" />
        <span>Support</span>
      </button>
    </div>
  );
};
