import { useEffect, useState, useCallback } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const DISMISS_SESSION_KEY = 'bx_pwa_dismissed_session';
const DISMISS_COOLDOWN_KEY = 'bx_pwa_dismissed_until';
const DEFAULT_DELAY_SECONDS = 180; // ~3 minutes active visit time (within 2-4 min window)

export function usePWAInstall(isBusyFlow = false) {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState<boolean>(false);
  const [isIOS, setIsIOS] = useState<boolean>(false);
  const [showDelayedBanner, setShowDelayedBanner] = useState<boolean>(false);
  const [showManualGuide, setShowManualGuide] = useState<boolean>(false);

  useEffect(() => {
    const checkStandalone = () => {
      const standalone =
        window.matchMedia('(display-mode: standalone)').matches ||
        (window.navigator as unknown as { standalone?: boolean }).standalone === true;
      setIsInstalled(standalone);
      return standalone;
    };

    const alreadyStandalone = checkStandalone();
    const ua = window.navigator.userAgent.toLowerCase();
    setIsIOS(/iphone|ipad|ipod/.test(ua));

    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const onAppInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
      setShowDelayedBanner(false);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);

    // Track active visible visit time (pauses when tab is hidden)
    let activeSeconds = 0;
    const interval = window.setInterval(() => {
      if (alreadyStandalone || document.hidden) return;
      if (sessionStorage.getItem(DISMISS_SESSION_KEY) === '1') return;
      const cooldownUntil = Number(localStorage.getItem(DISMISS_COOLDOWN_KEY) || '0');
      if (cooldownUntil > Date.now()) return;

      activeSeconds += 5;
      if (activeSeconds >= DEFAULT_DELAY_SECONDS) {
        setShowDelayedBanner(true);
        window.clearInterval(interval);
      }
    }, 5000);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
      window.clearInterval(interval);
    };
  }, []);

  const triggerInstall = useCallback(async () => {
    if (deferredPrompt) {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        setIsInstalled(true);
        setDeferredPrompt(null);
        setShowDelayedBanner(false);
        return 'installed';
      }
      return 'dismissed';
    }
    setShowManualGuide(true);
    return 'manual_guide';
  }, [deferredPrompt]);

  const dismissBanner = useCallback(() => {
    setShowDelayedBanner(false);
    sessionStorage.setItem(DISMISS_SESSION_KEY, '1');
    localStorage.setItem(DISMISS_COOLDOWN_KEY, String(Date.now() + 24 * 3600 * 1000));
  }, []);

  return {
    isInstalled,
    isNativePromptAvailable: Boolean(deferredPrompt),
    isIOS,
    showDelayedBanner: showDelayedBanner && !isInstalled && !isBusyFlow,
    showManualGuide,
    setShowManualGuide,
    triggerInstall,
    dismissBanner,
  };
}
