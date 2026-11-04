import React, { useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, X, ZoomIn } from 'lucide-react';
import { sanitizeSafeImageSrc } from '../lib/marketplaceLogic';

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
  title = 'Image Preview',
  onClose,
  onChangeIndex,
}) => {
  const isOpen = activeIndex !== null && activeIndex >= 0 && activeIndex < images.length;
  const touchStartXRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isOpen || activeIndex === null) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

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
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, activeIndex, images.length, onClose, onChangeIndex]);

  if (!isOpen || activeIndex === null) return null;

  const current = images[activeIndex];
  const goPrev = () => {
    if (images.length > 1) {
      onChangeIndex((activeIndex - 1 + images.length) % images.length);
    }
  };
  const goNext = () => {
    if (images.length > 1) {
      onChangeIndex((activeIndex + 1) % images.length);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid="image-lightbox-modal"
      className="fixed inset-0 z-[100] flex flex-col justify-between bg-black/92 p-3 sm:p-5 backdrop-blur-sm select-none"
      onClick={onClose}
    >
      {/* Top Bar: Title, Counter (e.g. 3/10), and Upper-Right Close Button */}
      <div
        className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 rounded-xl border border-white/15 bg-zinc-950/90 px-4 py-3 text-white shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <ZoomIn className="h-4 w-4 shrink-0 text-[#FF6500]" />
          <span className="truncate text-xs sm:text-sm font-bold">{title}</span>
          <span
            data-testid="lightbox-counter"
            className="rounded-md border border-white/15 bg-white/10 px-2 py-0.5 text-xs font-extrabold font-mono tabular-nums shrink-0"
          >
            {activeIndex + 1}/{images.length}
          </span>
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close full-screen image preview"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/20 bg-white/10 text-white hover:bg-[#FF6500] hover:border-[#FF6500] transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Main Centered Image Viewport with Touch Swipe Support & Zero Page Zoom */}
      <div
        className="relative mx-auto my-2 flex w-full max-w-6xl flex-1 items-center justify-center overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => {
          const touch = e.touches[0];
          if (touch) {
            touchStartXRef.current = touch.clientX;
            touchStartYRef.current = touch.clientY;
          }
        }}
        onTouchEnd={(e) => {
          const touch = e.changedTouches[0];
          if (!touch || touchStartXRef.current === null || touchStartYRef.current === null) return;
          const dx = touch.clientX - touchStartXRef.current;
          const dy = touch.clientY - touchStartYRef.current;
          touchStartXRef.current = null;
          touchStartYRef.current = null;
          if (Math.abs(dx) >= 45 && Math.abs(dx) > Math.abs(dy)) {
            if (dx < 0) goNext();
            else goPrev();
          }
        }}
      >
        <img
          src={sanitizeSafeImageSrc(current.src)}
          alt={current.caption || `${title} (${activeIndex + 1}/${images.length})`}
          referrerPolicy="no-referrer"
          className="max-h-[72vh] sm:max-h-[76vh] w-auto max-w-full rounded-lg object-contain shadow-2xl"
        />

        {images.length > 1 && (
          <>
            <button
              type="button"
              onClick={goPrev}
              aria-label="Previous image"
              className="absolute left-2 sm:left-4 top-1/2 -translate-y-1/2 inline-flex h-10 w-10 sm:h-11 sm:w-11 items-center justify-center rounded-xl border border-white/25 bg-zinc-950/85 text-white hover:bg-[#FF6500] hover:border-[#FF6500] transition-colors shadow-lg"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={goNext}
              aria-label="Next image"
              className="absolute right-2 sm:right-4 top-1/2 -translate-y-1/2 inline-flex h-10 w-10 sm:h-11 sm:w-11 items-center justify-center rounded-xl border border-white/25 bg-zinc-950/85 text-white hover:bg-[#FF6500] hover:border-[#FF6500] transition-colors shadow-lg"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </>
        )}
      </div>

      {/* Bottom Caption & Up-to-10 Thumbnail Strip */}
      <div
        className="mx-auto flex w-full max-w-6xl flex-col sm:flex-row sm:items-center justify-between gap-2.5 rounded-xl border border-white/15 bg-zinc-950/90 px-4 py-2.5 text-xs text-zinc-300"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="truncate font-semibold">
          {current.caption || `${title} — Image ${activeIndex + 1} of ${images.length}`}
        </span>
        {images.length > 1 && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
            {images.map((item, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => onChangeIndex(idx)}
                aria-label={`Select image ${idx + 1} of ${images.length}`}
                className={`h-10 w-14 shrink-0 overflow-hidden rounded-lg border-2 transition-all ${
                  idx === activeIndex
                    ? 'border-[#FF6500] opacity-100 scale-105'
                    : 'border-white/20 opacity-60 hover:opacity-100'
                }`}
              >
                <img
                  src={sanitizeSafeImageSrc(item.src)}
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
  );
};
