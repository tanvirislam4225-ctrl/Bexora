import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { buildApiUrl } from '../lib/apiClient';
import { clearRuntimeCachesAndReload, isChunkLoadError } from '../lib/chunkRetry';

interface AdminErrorBoundaryProps {
  children: React.ReactNode;
  onRetry?: () => void;
  onBackHome?: () => void;
}

interface AdminErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
  isChunkError: boolean;
}

export class AdminErrorBoundary extends React.Component<
  AdminErrorBoundaryProps,
  AdminErrorBoundaryState
> {
  public state: AdminErrorBoundaryState = {
    hasError: false,
    errorMessage: '',
    isChunkError: false,
  };

  public static getDerivedStateFromError(error: Error): AdminErrorBoundaryState {
    const chunkErr = isChunkLoadError(error);
    return {
      hasError: true,
      isChunkError: chunkErr,
      errorMessage: chunkErr
        ? 'A newer version of BEXORA was published while this tab was open. Reloading will fetch the latest Admin Console bundle.'
        : error?.message || 'Unexpected error rendering the Admin Console.',
    };
  }

  public componentDidCatch(error: Error): void {
    console.error('BEXORA AdminErrorBoundary caught error:', error);
    try {
      void fetch(buildApiUrl('/api/telemetry/client-error'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'runtime_error',
          route: '/?view=admin',
          componentOrEndpoint: 'AdminDashboard',
          message: String(error?.message || 'Admin render error').slice(0, 240),
        }),
      }).catch(() => {});
    } catch {
      // Non-fatal
    }
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="bx-wrap py-12">
          <div className="bx-card max-w-lg mx-auto p-6 sm:p-8 text-center space-y-4">
            <div
              className="w-12 h-12 rounded-2xl mx-auto flex items-center justify-center"
              style={{ background: 'var(--red-soft)', color: 'var(--red)' }}
            >
              <AlertTriangle className="w-6 h-6" />
            </div>
            <h2 className="text-xl font-extrabold" style={{ color: 'var(--text)' }}>
              Admin Console Could Not Load
            </h2>
            <p className="text-sm" style={{ color: 'var(--text-2)' }}>
              {this.state.errorMessage || 'A temporary error occurred while opening the Admin Console.'}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => {
                  if (this.state.isChunkError) {
                    void clearRuntimeCachesAndReload();
                    return;
                  }
                  this.setState({ hasError: false, errorMessage: '', isChunkError: false });
                  this.props.onRetry?.();
                }}
                className="bx-btn bx-btn-primary inline-flex items-center gap-2"
              >
                <RefreshCw className="w-4 h-4" />
                {this.state.isChunkError ? 'Reload Latest Console' : 'Retry Admin Console'}
              </button>
              {this.props.onBackHome && (
                <button
                  type="button"
                  onClick={this.props.onBackHome}
                  className="bx-btn"
                >
                  Back to Marketplace
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
