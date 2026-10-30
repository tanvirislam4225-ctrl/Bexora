import React, { useEffect } from 'react';
import { ChevronLeft, ChevronRight, X, ZoomIn } from 'lucide-react';

export interface LightboxImageItem {
  src: string;
  caption?: string;
}

interface ImageLightboxModalProps {
  images: LightboxImageItem[];
  activeIndex: number | null;
  title?: string;
  onClose: () => void;
  onChangeIndex: (index: number) => void;
}

export const ImageLightboxModal: React.FC<ImageLightboxModalProps> = ({
  images,
  activeIndex,
  title = 'Evidence Inspection',
  onClose,
  onChangeIndex,
}) => {
  const isOpen = activeIndex !== null && activeIndex >= 0 && activeIndex < images.length;

  useEffect(() => {
    if (!isOpen || activeIndex === null) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'ArrowLeft' && images.length > 1) {
        event.preventDefault();
        onChangeIndex((activeIndex - 1 + images.length) % images.length);
      } else if (event.key === 'ArrowRight' && images.length > 1) {
        event.preventDefault();
        onChangeIndex((activeIndex + 1) % images.length);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, activeIndex, images.length, onClose, onChangeIndex]);

  if (!isOpen || activeIndex === null) return null;

  const current = images[activeIndex];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900 text-slate-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 border-b border-slate-800 px-5 py-3.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <ZoomIn className="h-4 w-4 shrink-0 text-amber-400" />
            <span className="truncate text-sm font-semibold">{title}</span>
            <span className="text-xs text-slate-400 font-mono tabular-nums shrink-0">
              · Image {activeIndex + 1} of {images.length}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close enlarged image preview"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="relative flex min-h-[320px] flex-1 items-center justify-center overflow-auto bg-slate-950 p-4">
          <img
            src={current.src}
            alt={current.caption || `${title} ${activeIndex + 1}`}
            referrerPolicy="no-referrer"
            className="max-h-[74vh] w-auto max-w-full rounded-lg object-contain select-none"
          />

          {images.length > 1 && (
            <>
              <button
                type="button"
                onClick={() => onChangeIndex((activeIndex - 1 + images.length) % images.length)}
                aria-label="Previous screenshot"
                className="absolute left-3 top-1/2 -translate-y-1/2 inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-700 bg-slate-900/90 text-white hover:bg-slate-800 transition-colors"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={() => onChangeIndex((activeIndex + 1) % images.length)}
                aria-label="Next screenshot"
                className="absolute right-3 top-1/2 -translate-y-1/2 inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-700 bg-slate-900/90 text-white hover:bg-slate-800 transition-colors"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 px-5 py-3 text-xs text-slate-400">
          <span className="truncate">{current.caption || `Submitted proof screenshot #${activeIndex + 1}`}</span>
          {images.length > 1 && (
            <div className="flex items-center gap-1.5">
              {images.map((item, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => onChangeIndex(idx)}
                  aria-label={`View screenshot ${idx + 1}`}
                  className={`h-9 w-12 overflow-hidden rounded border transition-all ${
                    idx === activeIndex
                      ? 'border-amber-400 ring-1 ring-amber-400'
                      : 'border-slate-700 opacity-65 hover:opacity-100'
                  }`}
                >
                  <img
                    src={item.src}
                    alt={`Thumbnail ${idx + 1}`}
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover"
                  />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
