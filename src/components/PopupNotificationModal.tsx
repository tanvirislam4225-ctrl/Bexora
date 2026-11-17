import React, { useEffect, useState } from 'react';
import { ExternalLink, X } from 'lucide-react';
import {
  POPUP_THEME_LIBRARY,
  sanitizePopupBannerImageUrl,
  sanitizePopupDestinationUrl,
  type PopupNotificationCampaign,
} from '../lib/popupNotificationLogic';

interface PopupNotificationModalProps {
  campaign: Pick<
    PopupNotificationCampaign,
    'id' | 'title' | 'body' | 'themeId' | 'style' | 'bannerImageUrl' | 'deliveryMode'
  >;
  /** True when rendered inside the Admin live preview pane rather than a full-screen portal */
  previewMode?: boolean;
  /** Viewport preview simulation size inside Admin Live Preview */
  previewViewport?: 'desktop' | 'mobile';
  onDismiss?: () => void;
  onActionNavigate?: (destination: string) => void;
}

export const PopupNotificationModal: React.FC<PopupNotificationModalProps> = ({
  campaign,
  previewMode = false,
  previewViewport = 'desktop',
  onDismiss,
  onActionNavigate,
}) => {
  const [bannerError, setBannerError] = useState(false);

  useEffect(() => {
    setBannerError(false);
  }, [campaign.bannerImageUrl]);

  useEffect(() => {
    if (previewMode || !campaign.style.closeButtonEnabled || !onDismiss) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onDismiss();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [previewMode, campaign.style.closeButtonEnabled, onDismiss]);

  const { style } = campaign;
  const themePreset = POPUP_THEME_LIBRARY.find((t) => t.id === campaign.themeId);
  const safeBannerUrl = !bannerError ? sanitizePopupBannerImageUrl(campaign.bannerImageUrl) : '';
  const safeDest = sanitizePopupDestinationUrl(style.buttonDestination);
  const isExternalDest = safeDest.startsWith('https://');

  const backgroundCss = style.useGradient
    ? `linear-gradient(${style.gradientDirection}, ${style.gradientFrom}, ${style.gradientTo})`
    : style.backgroundColor;

  const widthCss =
    previewMode && previewViewport === 'mobile'
      ? 'min(100%, 340px)'
      : `min(calc(100vw - 24px), ${style.popupWidthPx}px)`;

  const heightCss =
    style.popupHeightMode === 'custom' ? `${style.popupHeightPx}px` : undefined;

  const headingFontPx = Math.round(style.fontSizePx * 1.38);

  const handleCtaClick = () => {
    if (previewMode) return;
    if (safeDest && !isExternalDest && onActionNavigate) {
      onActionNavigate(safeDest);
      return;
    }
    onDismiss?.();
  };

  const cardElement = (
    <div
      role={previewMode ? 'region' : 'dialog'}
      aria-modal={!previewMode ? true : undefined}
      aria-label={campaign.title || 'Platform Notification'}
      className="relative overflow-y-auto shadow-2xl transition-all duration-200 animate-in fade-in zoom-in-95"
      style={{
        width: widthCss,
        maxWidth: '100%',
        height: heightCss,
        maxHeight: previewMode ? '560px' : '90dvh',
        background: backgroundCss,
        color: style.textColor,
        borderColor: style.borderColor,
        borderWidth: '2px',
        borderStyle: 'solid',
        borderRadius: `${style.borderRadiusPx}px`,
        padding: `${style.paddingPx}px`,
        textAlign: style.textAlign,
        fontSize: `${style.fontSizePx}px`,
        fontWeight: Number(style.fontWeight),
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {style.closeButtonEnabled && (
        <button
          type="button"
          onClick={() => {
            if (!previewMode) onDismiss?.();
          }}
          aria-label="Close notification"
          className="absolute top-3 right-3 w-8 h-8 rounded-full flex items-center justify-center transition-opacity hover:opacity-100 opacity-85 border"
          style={{
            backgroundColor: 'rgba(0, 0, 0, 0.22)',
            borderColor: 'rgba(255, 255, 255, 0.28)',
            color: style.textColor,
          }}
        >
          <X className="w-4 h-4" />
        </button>
      )}

      {safeBannerUrl && (
        <div
          className="mb-4 overflow-hidden border"
          style={{
            borderRadius: `${Math.max(6, Math.min(18, style.borderRadiusPx - 4))}px`,
            borderColor: 'rgba(255, 255, 255, 0.18)',
          }}
        >
          <img
            src={safeBannerUrl}
            alt={campaign.title || 'Notification banner'}
            onError={() => setBannerError(true)}
            className="w-full max-h-48 object-cover block"
          />
        </div>
      )}

      {themePreset && (
        <div
          className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider px-2.5 py-0.5 rounded"
          style={{
            backgroundColor: 'rgba(0, 0, 0, 0.14)',
            color: style.accentColor,
            border: `1px solid ${style.accentColor}55`,
          }}
        >
          <span>{campaign.deliveryMode === 'targeted' ? 'Personal Notice' : themePreset.badgeText}</span>
        </div>
      )}

      <h2
        className="font-black leading-snug tracking-tight break-words pr-6"
        style={{
          fontSize: `${headingFontPx}px`,
          color: style.textColor,
          textAlign: style.textAlign,
        }}
      >
        {campaign.title || 'Untitled Notification'}
      </h2>

      <p
        className="mt-2.5 leading-relaxed whitespace-pre-line break-words opacity-95"
        style={{
          fontSize: `${style.fontSizePx}px`,
          fontWeight: Number(style.fontWeight),
          color: style.textColor,
          textAlign: style.textAlign,
        }}
      >
        {campaign.body || 'Add your announcement message here.'}
      </p>

      {(style.buttonEnabled || !style.closeButtonEnabled) && (
        <div
          className={`mt-5 flex flex-wrap items-center gap-2.5 ${
            style.textAlign === 'center'
              ? 'justify-center'
              : style.textAlign === 'right'
                ? 'justify-end'
                : 'justify-start'
          }`}
        >
          {style.buttonEnabled && (
            isExternalDest && !previewMode ? (
              <a
                href={safeDest}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => {
                  onDismiss?.();
                }}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 font-extrabold text-sm rounded-lg shadow-sm transition-transform hover:scale-[1.01] active:scale-[0.99]"
                style={{
                  backgroundColor: style.buttonBgColor,
                  color: style.buttonTextColor,
                }}
              >
                <span>{style.buttonText || 'Learn More'}</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            ) : (
              <button
                type="button"
                onClick={handleCtaClick}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 font-extrabold text-sm rounded-lg shadow-sm transition-transform hover:scale-[1.01] active:scale-[0.99]"
                style={{
                  backgroundColor: style.buttonBgColor,
                  color: style.buttonTextColor,
                }}
              >
                <span>{style.buttonText || 'Learn More'}</span>
                {isExternalDest && <ExternalLink className="w-3.5 h-3.5" />}
              </button>
            )
          )}

          {!style.closeButtonEnabled && !style.buttonEnabled && (
            <button
              type="button"
              onClick={() => {
                if (!previewMode) onDismiss?.();
              }}
              className="inline-flex items-center justify-center px-4 py-2 font-bold text-xs rounded-lg border opacity-90 hover:opacity-100"
              style={{
                borderColor: `${style.textColor}44`,
                color: style.textColor,
              }}
            >
              Continue
            </button>
          )}
        </div>
      )}
    </div>
  );

  if (previewMode) {
    return cardElement;
  }

  return (
    <div
      className="fixed inset-0 z-[115] flex items-center justify-center p-3 sm:p-6 bg-black/60 backdrop-blur-[2px]"
      onClick={() => {
        if (style.closeButtonEnabled) {
          onDismiss?.();
        }
      }}
    >
      {cardElement}
    </div>
  );
};
