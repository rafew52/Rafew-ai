import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, AlertTriangle, RefreshCw } from 'lucide-react';
import App from './App.tsx';
import { AllActionsDrawer } from './components/AllActionsDrawer.tsx';
import { recordClientAction } from './lib/actionLog.ts';
import type { ActionActivityEntry } from './types.ts';
import './index.css';

declare global {
  interface Window {
    __CLIPS_AI_MARK_MOUNTED__?: () => void;
  }
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
  actionsOpen: boolean;
  actions: ActionActivityEntry[];
  clearingActions: boolean;
}

class AppErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    error: null,
    componentStack: null,
    actionsOpen: false,
    actions: [],
    clearingActions: false,
  };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI render error:', error, info);
    this.setState({ componentStack: info.componentStack || null });
    void recordClientAction({
      category: 'stream_pipeline',
      actionName: 'Preview UI Runtime Error',
      sourceRef: 'AppErrorBoundary',
      status: 'error',
      summary: error.message || 'Unhandled React rendering error.',
      details: [error.stack || '', info.componentStack || ''].filter(Boolean).join('\n\n'),
    });
  }

  private loadAndOpenAllActions = async () => {
    this.setState({ actionsOpen: true });
    try {
      const res = await fetch('/api/actions');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data?.actions)) {
          this.setState({ actions: data.actions as ActionActivityEntry[] });
        }
      }
    } catch {
      // Keep existing actions list if backend is unreachable
    }
  };

  private handleClearActions = async () => {
    this.setState({ clearingActions: true });
    try {
      const res = await fetch('/api/actions', { method: 'DELETE' });
      if (res.ok) {
        this.setState({ actions: [] });
      }
    } finally {
      this.setState({ clearingActions: false });
    }
  };

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-[#090B10] p-6 text-slate-100">
          <div className="w-full max-w-xl rounded-2xl border border-red-900/70 bg-[#11151F] p-6 shadow-2xl space-y-4">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-red-800/70 bg-red-950/40 text-red-400">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h1 className="font-display text-lg font-bold text-red-200">
                  Preview Recovery — Dashboard Render Error
                </h1>
                <p className="mt-1 text-sm text-slate-300 break-words">
                  {this.state.error.message || 'An unexpected runtime error prevented the UI from rendering.'}
                </p>
              </div>
            </div>

            {(this.state.error.stack || this.state.componentStack) && (
              <pre className="max-h-48 overflow-auto rounded-xl border border-slate-800 bg-[#090B10] p-3 font-mono text-[11px] leading-relaxed text-slate-300 whitespace-pre-wrap break-words">
                {[this.state.error.stack, this.state.componentStack].filter(Boolean).join('\n\n')}
              </pre>
            )}

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-orange-600 px-4 text-sm font-semibold text-white hover:bg-orange-500"
              >
                <RefreshCw className="h-4 w-4" />
                <span>Reload Preview</span>
              </button>

              <button
                type="button"
                onClick={() => void this.loadAndOpenAllActions()}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 text-sm font-semibold text-slate-100 hover:bg-slate-800"
              >
                <Activity className="h-4 w-4 text-orange-400" />
                <span>Open All Actions</span>
              </button>
            </div>
          </div>

          <AllActionsDrawer
            open={this.state.actionsOpen}
            actions={this.state.actions}
            clearing={this.state.clearingActions}
            onClose={() => this.setState({ actionsOpen: false })}
            onClear={() => void this.handleClearActions()}
          />
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById('root');
if (rootEl) {
  try {
    createRoot(rootEl).render(
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    );
    window.__CLIPS_AI_MARK_MOUNTED__?.();
  } catch (err) {
    console.error('Root mount failure:', err);
  }
}
