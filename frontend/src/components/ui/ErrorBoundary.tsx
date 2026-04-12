import { Component, ReactNode, ErrorInfo } from 'react';

interface Props { children: ReactNode; }
interface State { hasError: boolean; error?: Error; }

/** React error boundary — catches render errors and shows fallback */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen mesh-bg flex items-center justify-center p-8">
          <div className="glass rounded-2xl p-8 max-w-md text-center">
            <div className="text-4xl mb-4">⚠</div>
            <h2 className="font-display text-xl text-white mb-2">Something crashed</h2>
            <p className="text-zinc-500 text-sm mb-4">{this.state.error?.message}</p>
            <button
              className="btn-primary"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
