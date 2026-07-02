/**
 * Top-level React error boundary for the showcase. Wraps the whole router in
 * `main.tsx` so an uncaught render/lifecycle error in any page shows a
 * legible failure card (with a reload escape hatch) instead of unmounting the
 * entire app to a blank screen.
 */
import React from "react";

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  React.PropsWithChildren,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[showcase] uncaught render error:", error, info.componentStack);
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div
          className="min-h-screen flex items-center justify-center px-6"
          style={{ background: "#0a0d12" }}
        >
          <div className="max-w-md text-center">
            <h1 className="font-display text-lg font-semibold text-slate-100 mb-2">
              Something went wrong
            </h1>
            <p className="text-sm text-slate-400 mb-1">
              The page hit an unexpected error and could not render.
            </p>
            <p className="text-xs font-mono text-slate-500 mb-5 break-words">
              {this.state.error.message}
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => window.location.reload()}
                className="px-3 py-1.5 rounded text-xs font-medium text-slate-200 border border-white/20 transition-colors hover:bg-white/10"
              >
                Reload
              </button>
              {/* Plain anchor, not <Link>: the boundary may sit above (or have
                  lost) the router, so navigate with a full document load. */}
              <a
                href="/"
                className="px-3 py-1.5 rounded text-xs font-medium text-slate-400 transition-colors hover:text-cyan-300"
              >
                Back to home
              </a>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
