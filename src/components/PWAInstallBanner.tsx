import React from 'react';
import { Download, MoreVertical, Share, X } from 'lucide-react';
import { BexoraLogo } from './Icons';

interface PWAInstallBannerProps {
  showBanner: boolean;
  showManualGuide: boolean;
  isIOS: boolean;
  onInstall: () => void;
  onDismissBanner: () => void;
  onCloseManualGuide: () => void;
}

export const PWAInstallBanner: React.FC<PWAInstallBannerProps> = ({
  showBanner,
  showManualGuide,
  isIOS,
  onInstall,
  onDismissBanner,
  onCloseManualGuide,
}) => {
  return (
    <>
      {showBanner && (
        <div
          role="region"
          aria-label="Install BEXORA App Prompt"
          className="fixed bottom-20 md:bottom-6 left-4 right-4 md:right-auto md:w-96 z-40 bx-card p-4 space-y-3"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <BexoraLogo compact />
              <div>
                <h3 className="text-sm font-black">Install BEXORA</h3>
                <p className="text-xs opacity-80">
                  Add BEXORA to your home screen for instant deal alerts and standalone app access.
                </p>
              </div>
            </div>
            <button
              type="button"
              aria-label="Dismiss install banner"
              onClick={onDismissBanner}
              className="p-1 opacity-70 hover:opacity-100"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onDismissBanner}
              className="bx-btn bx-btn-ghost px-3 py-1.5 text-xs font-bold"
            >
              Not Now
            </button>
            <button
              type="button"
              onClick={onInstall}
              className="bx-btn bx-btn-primary px-4 py-1.5 text-xs font-extrabold inline-flex items-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5" />
              Install App
            </button>
          </div>
        </div>
      )}

      {showManualGuide && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Install BEXORA Instructions"
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
        >
          <div className="bx-card max-w-md w-full p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <BexoraLogo compact />
                <h2 className="text-base font-black">Install BEXORA App</h2>
              </div>
              <button
                type="button"
                aria-label="Close install instructions"
                onClick={onCloseManualGuide}
                className="p-1 hover:opacity-75"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {isIOS ? (
              <div className="space-y-3 text-sm">
                <p className="opacity-85">To install BEXORA on iPhone or iPad (Safari):</p>
                <ol className="list-decimal pl-5 space-y-2 text-xs font-bold">
                  <li>
                    Tap the browser <Share className="w-3.5 h-3.5 inline mx-1" /> <strong>Share</strong> button at the bottom of Safari.
                  </li>
                  <li>
                    Scroll down and tap <strong>Add to Home Screen</strong>.
                  </li>
                  <li>
                    Tap <strong>Add</strong> in the top-right corner to launch BEXORA in standalone mode.
                  </li>
                </ol>
              </div>
            ) : (
              <div className="space-y-3 text-sm">
                <p className="opacity-85">
                  To install BEXORA on Chrome, Edge, or Android when the automatic prompt is hidden or inside a preview frame:
                </p>
                <ol className="list-decimal pl-5 space-y-2 text-xs font-bold">
                  <li>
                    Open BEXORA directly in a full browser tab over HTTPS.
                  </li>
                  <li>
                    Click the browser <MoreVertical className="w-3.5 h-3.5 inline mx-0.5" /> <strong>Menu</strong> (top-right) or the install icon in the address bar.
                  </li>
                  <li>
                    Select <strong>Install BEXORA</strong> or <strong>Add to Home screen</strong>.
                  </li>
                </ol>
              </div>
            )}

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={onCloseManualGuide}
                className="bx-btn bx-btn-primary px-5 py-2 text-xs font-extrabold"
              >
                Got It
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
