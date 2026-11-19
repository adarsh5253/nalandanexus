import React from 'react';

/**
 * Catches render-time errors so one broken subtree cannot blank the whole app.
 *
 * Without a boundary anywhere in the tree, React unmounts the entire root when
 * any component throws during render - leaving a white page with nothing but a
 * console message and no way out but a manual reload. This keeps the shell
 * alive, says what happened, and offers both a re-render of the failed subtree
 * and a full reload.
 *
 * Errors are NOT swallowed: the real error is logged to the console (and shown
 * in full in development) so the cause stays diagnosable. Only the stack trace
 * is kept away from the user-facing message.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Kept on console deliberately - a boundary that hides the error makes the
    // bug behind it invisible to whoever has to fix it.
    console.error('[ErrorBoundary] Uncaught render error:', error, info?.componentStack);
    this.props.onError?.(error, info);
  }

  handleReset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) {
      return typeof this.props.fallback === 'function'
        ? this.props.fallback({ error, reset: this.handleReset })
        : this.props.fallback;
    }

    return (
      <div className="min-h-[60vh] w-full flex items-center justify-center p-6 bg-[#EDEAE0]">
        <div className="max-w-md w-full text-center space-y-4 rounded-2xl border border-[#DFDACB] bg-white p-8 shadow-card">
          <div className="w-12 h-12 mx-auto rounded-2xl bg-[#C1352B]/10 text-[#C1352B] flex items-center justify-center text-xl font-bold">
            !
          </div>
          <h2 className="font-heading font-bold text-lg text-[#22355E]">
            {this.props.title || 'Something went wrong on this screen'}
          </h2>
          <p className="text-sm text-[#2B2B28]/80 leading-relaxed">
            {this.props.description ||
              'This part of the page failed to render. Your session is intact — try loading it again.'}
          </p>
          {import.meta.env.DEV && (
            <pre className="text-left text-[11px] leading-snug bg-[#F7F5EE] text-[#C1352B] rounded-lg p-3 overflow-auto max-h-40 border border-[#DFDACB]">
              {String(error?.stack || error?.message || error)}
            </pre>
          )}
          <div className="flex items-center justify-center gap-3 pt-1">
            <button
              type="button"
              onClick={this.handleReset}
              className="px-5 py-2.5 rounded-xl bg-[#22355E] text-white text-xs font-bold shadow-xs hover:bg-[#1a2a4a] transition-colors"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-5 py-2.5 rounded-xl border border-[#DFDACB] text-[#2B2B28] text-xs font-semibold hover:bg-[#F7F5EE] transition-colors"
            >
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
