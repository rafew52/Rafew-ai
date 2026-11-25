import { useCallback, useEffect, useMemo, useState } from 'react';
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
} from 'lucide-react';
import { ACTIONS_UPDATED_EVENT } from '../lib/actionLog.ts';
import type { ActionActivityEntry, ActionLogCategory, ActionLogStatus } from '../types.ts';

interface LiveActionsBoxProps {
  activeWork?: boolean;
}

const CATEGORY_LABELS: Record<ActionLogCategory, string> = {
  source_url: 'Source URL',
  ai_detect: 'AI Detect',
  youtube_extract: 'YouTube / yt-dlp',
  claude_edit: 'Claude Editing',
  gemini_sensor: 'Gemini / Facecam',
  ffmpeg_render: 'FFmpeg Render',
  site_music: 'Website Music',
  zernio_upload: 'Zernio Upload',
  stream_pipeline: 'Live Pipeline',
};

function formatClock(iso: string): string {
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

function StatusIcon({ status }: { status: ActionLogStatus }) {
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

function statusBadgeLabel(status: ActionLogStatus): string {
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

function statusBadgeClasses(status: ActionLogStatus): string {
  switch (status) {
    case 'queued':
      return 'border-slate-700 bg-slate-900 text-slate-300';
    case 'running':
      return 'border-amber-700/80 bg-amber-950/50 text-amber-200';
    case 'success':
      return 'border-emerald-800/70 bg-emerald-950/40 text-emerald-300';
    case 'error':
      return 'border-red-800/80 bg-red-950/50 text-red-300';
  }
}

export function LiveActionsBox({ activeWork = false }: LiveActionsBoxProps) {
  const [actions, setActions] = useState<ActionActivityEntry[]>([]);
  const [fetchWarning, setFetchWarning] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<'all' | 'errors'>('all');
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const fetchActions = useCallback(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch('/api/actions', { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      if (Array.isArray(data?.actions)) {
        setActions(data.actions as ActionActivityEntry[]);
      }
      setFetchWarning(null);
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) {
        setFetchWarning(
          err instanceof Error ? `Live log sync paused (${err.message})` : 'Live log sync paused'
        );
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }, []);

  useEffect(() => {
    void fetchActions();
    const onUpdate = () => {
      void fetchActions();
    };
    window.addEventListener(ACTIONS_UPDATED_EVENT, onUpdate);
    return () => window.removeEventListener(ACTIONS_UPDATED_EVENT, onUpdate);
  }, [fetchActions]);

  const runningCount = useMemo(
    () => actions.filter((a) => a.status === 'running' || a.status === 'queued').length,
    [actions]
  );
  const errorCount = useMemo(
    () => actions.filter((a) => a.status === 'error').length,
    [actions]
  );

  useEffect(() => {
    const intervalMs = activeWork || runningCount > 0 ? 1200 : 4000;
    const timer = setInterval(() => {
      void fetchActions();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [activeWork, runningCount, fetchActions]);

  const visibleActions = useMemo(() => {
    const base = filterMode === 'errors' ? actions.filter((a) => a.status === 'error') : actions;
    return base.slice(0, 40);
  }, [actions, filterMode]);

  const handleCopyAll = async () => {
    const text =
      visibleActions.length > 0
        ? visibleActions
            .map((e) =>
              [
                `[${e.timestamp}] [${statusBadgeLabel(e.status).toUpperCase()}] [${CATEGORY_LABELS[e.category] || e.category}] ${e.actionName}${e.sourceRef ? ` (${e.sourceRef})` : ''}`,
                e.summary,
                e.details ? e.details.trim() : '',
              ]
                .filter(Boolean)
                .join('\n')
            )
            .join('\n\n---\n\n')
        : 'No live actions recorded.';
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId('__all__');
      setTimeout(() => setCopiedId((c) => (c === '__all__' ? null : c)), 1600);
    } catch {}
  };

  const handleClear = async () => {
    setClearing(true);
    try {
      const res = await fetch('/api/actions', { method: 'DELETE' });
      if (res.ok) {
        setActions([]);
      }
    } finally {
      setClearing(false);
    }
  };

  return (
    <section
      aria-label="Live Actions Pipeline Log"
      className="rounded-2xl border border-slate-800/90 bg-[#11151F] p-4 sm:p-5 space-y-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${
              errorCount > 0
                ? 'border-red-800/70 bg-red-950/40 text-red-400'
                : activeWork || runningCount > 0
                ? 'border-amber-700/70 bg-amber-950/40 text-amber-300'
                : 'border-slate-800 bg-[#090B10] text-orange-400'
            }`}
          >
            {activeWork || runningCount > 0 ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Activity className="h-4 w-4" />
            )}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-display text-sm font-bold tracking-tight text-slate-50">
                Live Actions
              </h2>
              {(activeWork || runningCount > 0) && (
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                  <span>Streaming</span>
                </span>
              )}
              <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                {actions.length} events · {runningCount} active ·{' '}
                <span className={errorCount > 0 ? 'text-red-300 font-semibold' : ''}>
                  {errorCount} errors
                </span>
              </span>
            </div>
            <p className="text-[11px] text-slate-500 truncate">
              AI Detect · YouTube/yt-dlp · Facecam Region · Claude Edit · Gemini Sensor · FFmpeg 9:16 · Zernio
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            role="tablist"
            aria-label="Filter live actions"
            className="inline-flex rounded-xl border border-slate-800 bg-[#090B10] p-0.5"
          >
            <button
              type="button"
              role="tab"
              aria-selected={filterMode === 'all'}
              onClick={() => setFilterMode('all')}
              className={`min-h-[34px] rounded-lg px-2.5 text-[11px] font-semibold transition-colors ${
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
              className={`min-h-[34px] rounded-lg px-2.5 text-[11px] font-semibold transition-colors ${
                filterMode === 'errors'
                  ? 'bg-red-950/70 text-red-200'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Errors ({errorCount})
            </button>
          </div>

          <button
            type="button"
            onClick={() => void handleCopyAll()}
            disabled={visibleActions.length === 0}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900 px-2.5 text-[11px] font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-40"
          >
            {copiedId === '__all__' ? (
              <Check className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <Copy className="h-3.5 w-3.5 text-slate-400" />
            )}
            <span>{copiedId === '__all__' ? 'Copied' : 'Copy'}</span>
          </button>

          <button
            type="button"
            onClick={() => void handleClear()}
            disabled={clearing || actions.length === 0}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900 px-2.5 text-[11px] font-semibold text-slate-300 hover:border-red-900/70 hover:bg-red-950/30 hover:text-red-200 disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>Clear</span>
          </button>
        </div>
      </div>

      {fetchWarning && (
        <div className="rounded-lg border border-amber-800/60 bg-amber-950/30 px-3 py-1.5 text-[11px] text-amber-200">
          {fetchWarning}
        </div>
      )}

      <div className="max-h-64 overflow-y-auto rounded-xl border border-slate-800/90 bg-[#090B10] divide-y divide-slate-800/70">
        {visibleActions.length === 0 ? (
          <div className="px-4 py-3.5 text-xs text-slate-400">
            {filterMode === 'errors'
              ? 'No errors recorded — all steps completed cleanly.'
              : 'Ready — live steps for AI Detect, YouTube extraction, Facecam detection, Claude editing, Gemini sensor audit, FFmpeg 9:16 split-screen rendering, and Zernio upload will stream here automatically.'}
          </div>
        ) : (
          visibleActions.map((entry) => {
            const hasDetails = Boolean(entry.details && entry.details.trim());
            // Auto-expand full diagnostic logs for errors so failures are immediately visible
            const isExpanded =
              entry.status === 'error'
                ? expandedIds[entry.id] !== false
                : Boolean(expandedIds[entry.id]);

            return (
              <div
                key={entry.id}
                className={`px-3.5 py-2.5 text-xs ${
                  entry.status === 'error'
                    ? 'bg-red-950/15'
                    : entry.status === 'running'
                    ? 'bg-amber-950/10'
                    : ''
                }`}
              >
                <div className="flex items-start justify-between gap-2.5">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <StatusIcon status={entry.status} />
                      <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                        {formatClock(entry.timestamp)}
                      </span>
                      <span
                        className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold ${statusBadgeClasses(
                          entry.status
                        )}`}
                      >
                        {statusBadgeLabel(entry.status)}
                      </span>
                      <span className="text-[11px] font-medium text-slate-300">
                        {CATEGORY_LABELS[entry.category] || entry.category}
                      </span>
                      <span className="font-semibold text-slate-100">{entry.actionName}</span>
                      {entry.sourceRef && (
                        <span className="font-mono text-[11px] text-slate-400 break-all">
                          · {entry.sourceRef}
                        </span>
                      )}
                    </div>
                    <p className="pl-5 text-[11px] leading-relaxed text-slate-300 break-words">
                      {entry.summary}
                    </p>
                  </div>

                  {hasDetails && (
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedIds((prev) => ({ ...prev, [entry.id]: !isExpanded }))
                      }
                      className="inline-flex min-h-[30px] shrink-0 items-center gap-1 rounded-lg border border-slate-800 bg-[#11151F] px-2 text-[11px] font-medium text-slate-300 hover:bg-slate-800"
                    >
                      <span>{isExpanded ? 'Hide Log' : 'Full Log'}</span>
                      {isExpanded ? (
                        <ChevronUp className="h-3 w-3" />
                      ) : (
                        <ChevronDown className="h-3 w-3" />
                      )}
                    </button>
                  )}
                </div>

                {hasDetails && isExpanded && (
                  <pre className="mt-2 ml-5 max-h-44 overflow-auto rounded-lg border border-slate-800 bg-[#05070B] p-2.5 font-mono text-[11px] leading-relaxed text-slate-200 whitespace-pre-wrap break-words">
                    {entry.details}
                  </pre>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
