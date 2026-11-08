import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import './index.css';

if (typeof window !== 'undefined') {
  const isFirestoreInternalAssertion = (val: unknown): boolean => {
    const text = String(val instanceof Error ? val.message || val.stack : val || '');
    return (
      text.includes('FIRESTORE') &&
      (text.includes('INTERNAL ASSERTION FAILED') ||
        text.includes('ca9') ||
        text.includes('b815') ||
        text.includes('Unexpected state'))
    );
  };

  window.addEventListener('error', (event) => {
    if (isFirestoreInternalAssertion(event.message) || isFirestoreInternalAssertion(event.error)) {
      console.warn('Suppressed transient Firestore watch stream assertion error:', event.message);
      event.preventDefault();
      event.stopImmediatePropagation?.();
    }
  });

  window.addEventListener('unhandledrejection', (event) => {
    if (isFirestoreInternalAssertion(event.reason)) {
      console.warn('Suppressed transient Firestore watch stream unhandled rejection:', event.reason);
      event.preventDefault();
      event.stopImmediatePropagation?.();
    }
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
