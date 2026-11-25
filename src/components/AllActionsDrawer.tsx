import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Loader2,
  Trash2,
  X,
} from 'lucide-react';
import type { ActionActivityEntry, ActionLogCategory, ActionLogStatus } from '../types.ts';

interface AllActionsDrawerProps {
  open: boolean;
  actions: ActionActivityEntry[];
  clearing?: boolean;
  onClose: () => void;
  onClear: () => void;
}

type FilterMode = 'all' | 'errors';

const CATEGORY_LABELS: Record<ActionLogCategory, string> = {
  source_url: 'Source URL',
  ai_detect: 'AI Detect',
  youtube_extract: 'YouTube Extract',
  claude_edit: 'Claude Editing',
  gemini_sensor: 'Gemini Sensor',
  ffmpeg_render: 'FFmpeg Render',
  site_music: 'Website Music',
  zernio_upload: 'Zernio Upload',
  stream_pipeline: 'Live Pipeline',
};

function formatClockTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString([], {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatStatusLabel(status: ActionLogStatus): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Running';
    case 'success':
      return 'Success';
    case 'error':
      return 'Error';
  }
}

function StatusGlyph({ status }: { status: ActionLogStatus }) {
  switch (status) {
    case 'queued':
      return <Clock className="h-3.5 w-3.5 text-slate-400 shrink-0" />;
    case 'running':
      return <Loader2 className="h-3.5 w-3.5 text-amber-400 animate-spin shrink-0" />;
    case 'success':
      return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />;
    case 'error':
      return <AlertCircle className="h-3.5 w-3.5 text-red-400 shrink-0" />;
  }
}

function statusTextColor(status: ActionLogStatus): string {
  switch (status) {
    case 'queued':
      return 'text-slate-300';
    case 'running':
      return 'text-amber-300';
    case 'success':
      return 'text-emerald-300';
    case 'error':
      return 'text-red-300';
  }
}

function formatEntryForCopy(entry: ActionActivityEntry): string {
  const lines = [
    `[${entry.timestamp}] [${formatStatusLabel(entry.status).toUpperCase()}] [${CATEGORY_LABELS[entry.category] || entry.category}] ${entry.actionName}${entry.sourceRef ? ` (${entry.sourceRef})` : ''}`,
    `Summary: ${entry.summary}`,
  ];
  if (entry.details && entry.details.trim()) {
    lines.push('Details:');
    lines.push(entry.details.trim());
  }
  return lines.join('\n');
}

export function AllActionsDrawer({
  open,
  actions,
  clearing = false,
  onClose,
  onClear,
}: AllActionsDrawerProps) {
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const errorCount = useMemo(
    () => actions.filter((a) => a.status === 'error').length,
    [actions]
  );

  const runningCount = useMemo(
    () => actions.filter((a) => a.status === 'running' || a.status === 'queued').length,
    [actions]
  );

  const filteredActions = useMemo(() => {
    if (filterMode === 'errors') {
      return actions.filter((a) => a.status === 'error');
    }
    return actions;
  }, [actions, filterMode]);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleCopyAll = async () => {
    const text =
      filteredActions.length > 0
        ? filteredActions.map(formatEntryForCopy).join('\n\n----------------------------------------\n\n')
        : 'No action logs recorded.';
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId('__all__');
      setTimeout(() => setCopiedId((curr) => (curr === '__all__' ? null : curr)), 1800);
    } catch {
      // Ignore clipboard failures
    }
  };

  const handleCopyEntry = async (entry: ActionActivityEntry) => {
    try {
      await navigator.clipboard.writeText(formatEntryForCopy(entry));
      setCopiedId(entry.id);
      setTimeout(() => setCopiedId((curr) => (curr === entry.id ? null : curr)), 1800);
    } catch {
      // Ignore clipboard failures
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-label="All Actions Activity Log"
    >
      <button
        type="button"
        aria-label="Close activity drawer"
        onClick={onClose}
        className="flex-1 cursor-default"
      />

      <section className="flex h-full w-full max-w-2xl flex-col border-l border-slate-800 bg-[#0D1017] shadow-2xl">
        {/* Header */}
        <header className="flex items-center justify-between gap-3 border-b border-slate-800/90 px-4 py-3.5 sm:px-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-orange-400 shrink-0" />
              <h2 className="font-display text-base font-bold tracking-tight text-slate-50 truncate">
                All Actions Activity Log
              </h2>
            </div>
            <p className="mt-0.5 text-xs text-slate-400 tabular-nums">
              {actions.length} total · {runningCount} active ·{' '}
              <span className={errorCount > 0 ? 'text-red-300 font-medium' : ''}>
                {errorCount} errors
              </span>
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close All Actions drawer"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-800 bg-slate-900 text-slate-300 hover:bg-slate-800 hover:text-slate-50"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* Controls Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-slate-800/80 bg-[#090B10] px-4 py-3 sm:px-6">
          <div
            role="tablist"
            aria-label="Filter action logs"
            className="inline-flex rounded-xl border border-slate-800 bg-[#0D1017] p-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={filterMode === 'all'}
              onClick={() => setFilterMode('all')}
              className={`min-h-[36px] rounded-lg px-3 text-xs font-semibold transition-colors whitespace-nowrap ${
                filterMode === 'all'
                  ? 'bg-slate-800 text-slate-50'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              All ({actions.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={filterMode === 'errors'}
              onClick={() => setFilterMode('errors')}
              className={`min-h-[36px] rounded-lg px-3 text-xs font-semibold transition-colors whitespace-nowrap ${
                filterMode === 'errors'
                  ? 'bg-red-950/70 text-red-200'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Errors Only ({errorCount})
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleCopyAll()}
              disabled={filteredActions.length === 0}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900 px-3 text-xs font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap"
            >
              {copiedId === '__all__' ? (
                <Check className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <Copy className="h-3.5 w-3.5 text-slate-400" />
              )}
              <span>{copiedId === '__all__' ? 'Copied' : 'Copy Logs'}</span>
            </button>

            <button
              type="button"
              onClick={onClear}
              disabled={clearing || actions.length === 0}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900 px-3 text-xs font-semibold text-slate-300 hover:border-red-900/70 hover:bg-red-950/30 hover:text-red-200 disabled:opacity-40 whitespace-nowrap"
            >
              {clearing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              <span>Clear Logs</span>
            </button>
          </div>
        </div>

        {/* Log Stream List */}
        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6 space-y-2.5">
          {filteredActions.length === 0 ? (
            <div className="rounded-2xl border border-slate-800/80 bg-[#090B10] px-5 py-10 text-center">
              <p className="text-sm font-medium text-slate-300">
                {filterMode === 'errors' ? 'No errors recorded' : 'No actions recorded yet'}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {filterMode === 'errors'
                  ? 'Pipeline steps, FFmpeg renders, and Zernio uploads have run cleanly.'
                  : 'Source URL changes, AI Detect, YouTube extraction, Claude edits, Gemini sensor checks, FFmpeg renders, website music, and Zernio uploads appear here live.'}
              </p>
            </div>
          ) : (
            filteredActions.map((entry) => {
              const hasDetails = Boolean(entry.details && entry.details.trim());
              const isExpanded = Boolean(expandedIds[entry.id]);

              return (
                <article
                  key={entry.id}
                  className={`rounded-xl border p-3.5 transition-colors ${
                    entry.status === 'error'
                      ? 'border-red-900/60 bg-red-950/15'
                      : entry.status === 'running'
                      ? 'border-amber-800/50 bg-amber-950/10'
                      : 'border-slate-800/90 bg-[#090B10]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-400">
                        <span className="font-mono tabular-nums text-slate-300">
                          {formatClockTime(entry.timestamp)}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-medium text-slate-300">
                          {CATEGORY_LABELS[entry.category] || entry.category}
                        </span>
                        {entry.sourceRef && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono text-slate-400 break-all">
                              {entry.sourceRef}
                            </span>
                          </>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        <StatusGlyph status={entry.status} />
                        <h3 className="text-xs font-semibold text-slate-100 break-words">
                          {entry.actionName}
                        </h3>
                        <span
                          className={`text-[11px] font-medium ${statusTextColor(entry.status)}`}
                        >
                          {formatStatusLabel(entry.status)}
                        </span>
                      </div>

                      <p className="text-xs leading-relaxed text-slate-300 break-words">
                        {entry.summary}
                      </p>
                    </div>

                    {hasDetails && (
                      <button
                        type="button"
                        onClick={() => toggleExpand(entry.id)}
                        aria-expanded={isExpanded}
                        className="inline-flex min-h-[36px] shrink-0 items-center gap-1 rounded-lg border border-slate-800 bg-[#11151F] px-2.5 text-[11px] font-medium text-slate-300 hover:bg-slate-800 hover:text-slate-100 whitespace-nowrap"
                      >
                        <span>{isExpanded ? 'Hide Details' : 'Details'}</span>
                        {isExpanded ? (
                          <ChevronUp className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}
                  </div>

                  {hasDetails && isExpanded && (
                    <div className="mt-3 border-t border-slate-800/80 pt-2.5 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-medium text-slate-400">
                          Full Output &amp; Error Diagnostics
                        </span>
                        <button
                          type="button"
                          onClick={() => void handleCopyEntry(entry)}
                          className="inline-flex min-h-[32px] items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-2.5 text-[11px] font-medium text-slate-200 hover:bg-slate-800"
                        >
                          {copiedId === entry.id ? (
                            <Check className="h-3 w-3 text-emerald-400" />
                          ) : (
                            <Copy className="h-3 w-3 text-slate-400" />
                          )}
                          <span>{copiedId === entry.id ? 'Copied' : 'Copy Details'}</span>
                        </button>
                      </div>
                      <pre className="max-h-72 overflow-auto rounded-lg border border-slate-800 bg-[#05070B] p-3 font-mono text-[11px] leading-relaxed text-slate-200 whitespace-pre-wrap break-words">
                        {entry.details}
                      </pre>
                    </div>
                  )}
                </article>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
