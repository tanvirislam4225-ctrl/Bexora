import React from 'react';

interface State {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  public state: State = { hasError: false, errorMessage: '' };

  public static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      errorMessage: error?.message || 'An unexpected interface error occurred.',
    };
  }

  public componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('BEXORA UI ErrorBoundary caught error:', error, info.componentStack);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-6" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
          <div className="bx-card max-w-md w-full p-6 text-center space-y-4">
            <h1 className="text-xl font-extrabold">Recoverable View Error</h1>
            <p className="text-sm" style={{ color: 'var(--text-2)' }}>
              BEXORA encountered an unexpected issue while rendering this section. Your account and wallet data remain safe.
            </p>
            <button
              type="button"
              onClick={() => {
                this.setState({ hasError: false, errorMessage: '' });
                window.location.reload();
              }}
              className="bx-btn bx-btn-primary w-full"
            >
              Reload BEXORA
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
