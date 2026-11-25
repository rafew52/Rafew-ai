import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Radio, Square, Trash2 } from 'lucide-react';
import type {
  ClipItem,
  StreamJob,
  StreamStatus,
  SystemReadiness,
  ThirdPartyExportSettings,
  VideoAspectMode,
} from '../types.ts';
import { ConfirmModal } from './ConfirmModal.tsx';
import { IdeaFinderCard } from './IdeaFinderCard.tsx';
import { StreamIntakeCard } from './StreamIntakeCard.tsx';
import { ThirdPartyExportCard } from './ThirdPartyExportCard.tsx';
import { YouTubeLiveStudioCard } from './YouTubeLiveStudioCard.tsx';

const FALLBACK_THIRD_PARTY: ThirdPartyExportSettings = {
  webhookUrl: '',
  webhookConfigured: false,
  preferredPlatform: 'custom_webhook',
  autoSendOnComplete: false,
};

interface LiveMonitorsViewProps {
  streams: StreamJob[];
  clips: ClipItem[];
  readiness: SystemReadiness;
  loading: boolean;
  onRefresh: () => void;
  onNavigateClips: () => void;
  onOpenZernioConnect?: () => void;
}

function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(
    2,
    '0'
  )}`;
}

function getStreamStatusMeta(status: StreamStatus): {
  label: string;
  textClass: string;
  isActive: boolean;
} {
  switch (status) {
    case 'monitoring':
      return { label: 'Live Monitoring', textClass: 'text-emerald-400', isActive: true };
    case 'initializing':
      return { label: 'Starting Monitor', textClass: 'text-amber-400', isActive: true };
    case 'stopping':
      return { label: 'Stopping', textClass: 'text-amber-400', isActive: false };
    case 'ended':
      return { label: 'Stopped (Stream Ended)', textClass: 'text-slate-300', isActive: false };
    case 'error':
      return { label: 'Stopped (Error)', textClass: 'text-red-400', isActive: false };
    default:
      return { label: 'Monitoring Stopped', textClass: 'text-slate-400', isActive: false };
  }
}

export function LiveMonitorsView({
  streams,
  clips,
  readiness,
  loading,
  onRefresh,
  onNavigateClips,
  onOpenZernioConnect,
}: LiveMonitorsViewProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [expandedLogs, setExpandedLogs] = useState<Record<string, boolean>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<StreamJob | null>(null);

  const latestCompletedClip = useMemo(
    () =>
      clips.find(
        (c) =>
          c.status === 'completed' &&
          (c.aspectMode as VideoAspectMode | undefined) !== 'landscape'
      ) ||
      clips.find((c) => c.status === 'completed') ||
      null,
    [clips]
  );

  const hasActiveStream = streams.some(
    (s) => s.status === 'monitoring' || s.status === 'initializing'
  );

  useEffect(() => {
    if (!hasActiveStream) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasActiveStream]);

  const metrics = useMemo(() => {
    const activeStream =
      streams.find((s) => s.status === 'monitoring' || s.status === 'initializing') ||
      streams[0];

    let streamDurationSeconds = 0;
    let liveRunningSeconds: number | null = null;
    if (activeStream) {
      const start = new Date(activeStream.startedAt).getTime();
      const end = activeStream.endedAt
        ? new Date(activeStream.endedAt).getTime()
        : nowMs;
      streamDurationSeconds = Math.max(0, Math.floor((end - start) / 1000));

      if (activeStream.liveStartedAt) {
        const liveStart = new Date(activeStream.liveStartedAt).getTime();
        if (!Number.isNaN(liveStart)) {
          liveRunningSeconds = Math.max(0, Math.floor((end - liveStart) / 1000));
        }
      }
    }

    const momentsDetected = streams.reduce((acc, s) => acc + s.momentsDetected, 0);
    const queued = clips.filter((c) => c.status === 'queued').length;
    const processing = clips.filter((c) => c.status === 'processing').length;
    const completed = clips.filter((c) => c.status === 'completed').length;
    const failed = clips.filter((c) => c.status === 'failed').length;

    const monitoringLabel = hasActiveStream
      ? 'Active'
      : streams.length === 0
      ? 'Idle (Not Started)'
      : activeStream?.status === 'ended'
      ? 'Stopped (Stream Ended)'
      : activeStream?.status === 'error'
      ? 'Stopped (Error)'
      : 'Stopped';

    const queueLabel =
      processing > 0 || readiness.queueRunning
        ? 'Processing Clips'
        : queued > 0
        ? 'Queued'
        : 'Stopped (Idle)';

    return {
      streamDurationSeconds,
      liveRunningSeconds,
      momentsDetected,
      queued,
      processing,
      completed,
      failed,
      monitoringLabel,
      queueLabel,
    };
  }, [streams, clips, nowMs, hasActiveStream, readiness.queueRunning]);

  const handleStopStream = async (streamId: string) => {
    setBusyId(streamId);
    try {
      await fetch(`/api/streams/${streamId}/stop`, { method: 'POST' });
      onRefresh();
    } finally {
      setBusyId(null);
    }
  };

  const handleRemoveStream = async () => {
    if (!confirmRemove) return;
    setBusyId(confirmRemove.id);
    try {
      await fetch(`/api/streams/${confirmRemove.id}`, { method: 'DELETE' });
      setConfirmRemove(null);
      onRefresh();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Missing Configuration Alert */}
      {(!readiness.geminiConfigured || !readiness.ffmpegAvailable) && (
        <div
          role="alert"
          className="rounded-2xl border border-amber-800/70 bg-amber-950/35 px-4 py-3.5 text-sm text-amber-200"
        >
          {!readiness.geminiConfigured && (
            <p>
              AI detection requires at least one usable Gemini API key. Add key(s) in{' '}
              <strong>System Setup</strong> or set <code className="font-mono">GEMINI_API_KEY</code>{' '}
              in <strong>Settings &gt; Secrets</strong>.
            </p>
          )}
          {!readiness.ffmpegAvailable && (
            <p className="mt-1">
              FFmpeg binary is missing on the server host. Video clipping requires FFmpeg.
            </p>
          )}
        </div>
      )}

      {/* AI Idea-to-Video Discovery & Autonomous Clipping */}
      <IdeaFinderCard
        readiness={readiness}
        onStarted={onRefresh}
        onOpenZernioConnect={onOpenZernioConnect}
      />

      {/* Primary Workflow Intake */}
      <StreamIntakeCard
        readiness={readiness}
        onStarted={onRefresh}
        onOpenZernioConnect={onOpenZernioConnect}
      />

      {/* Link-to-YouTube Live Studio & Broadcast */}
      <YouTubeLiveStudioCard onRefresh={onRefresh} />

      {/* Optional External Fallback Publish & Export Helper (Collapsed by Default) */}
      <ThirdPartyExportCard
        compactCollapsible
        settings={readiness.thirdPartyExport || FALLBACK_THIRD_PARTY}
        latestClip={latestCompletedClip}
        onUpdated={onRefresh}
      />

      {/* Live Processing Dashboard Counters */}
      <section aria-label="Live Processing Metrics" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-100">Live Processing Status</h2>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
            <span>
              Monitor:{' '}
              <strong
                className={
                  hasActiveStream ? 'text-emerald-400' : 'text-slate-200'
                }
              >
                {metrics.monitoringLabel}
              </strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Queue:{' '}
              <strong
                className={
                  metrics.processing > 0 ? 'text-orange-400' : 'text-slate-200'
                }
              >
                {metrics.queueLabel}
              </strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              YouTube:{' '}
              <strong
                className={
                  readiness.youtubeAutoUpload.connected &&
                  readiness.youtubeAutoUpload.autoUploadEnabled
                    ? 'text-emerald-400'
                    : readiness.youtubeAutoUpload.tokenExpired
                    ? 'text-amber-400'
                    : 'text-slate-300'
                }
              >
                {readiness.youtubeAutoUpload.connected &&
                readiness.youtubeAutoUpload.autoUploadEnabled
                  ? `Auto (${readiness.youtubeAutoUpload.privacyStatus})`
                  : readiness.youtubeAutoUpload.connected
                  ? 'Ready'
                  : readiness.youtubeAutoUpload.tokenExpired
                  ? 'Expired'
                  : 'Off'}
              </strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Zernio:{' '}
              <strong
                className={
                  readiness.zernio?.connected &&
                  readiness.zernio?.autoUploadEnabled &&
                  readiness.zernio.selectedAccountIds.length > 0
                    ? 'text-indigo-300'
                    : readiness.zernio?.connected
                    ? 'text-emerald-400'
                    : 'text-slate-300'
                }
              >
                {readiness.zernio?.connected &&
                readiness.zernio?.autoUploadEnabled &&
                readiness.zernio.selectedAccountIds.length > 0
                  ? `Auto (${readiness.zernio.selectedAccountIds.length} acct${
                      readiness.zernio.selectedAccountIds.length === 1 ? '' : 's'
                    }${readiness.zernio.hasTikTokAccount ? ' + TikTok' : ''})`
                  : readiness.zernio?.connected
                  ? `${readiness.zernio.accounts.length} Connected`
                  : 'Off'}
              </strong>
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 divide-y divide-slate-800 rounded-2xl border border-slate-800/90 bg-[#11151F] sm:grid-cols-3 lg:grid-cols-6 sm:divide-x lg:divide-y-0">
          <div className="p-4">
            <div className="text-xs text-slate-400">Monitor Duration</div>
            <div className="mt-1 font-mono text-xl font-semibold text-slate-50 tabular-nums">
              {formatDuration(metrics.streamDurationSeconds)}
            </div>
            {metrics.liveRunningSeconds !== null && (
              <div className="mt-0.5 font-mono text-[11px] text-red-400 tabular-nums">
                Live Running {formatDuration(metrics.liveRunningSeconds)}
              </div>
            )}
          </div>
          <div className="p-4">
            <div className="text-xs text-slate-400">Moments Detected</div>
            <div className="mt-1 font-mono text-xl font-semibold text-slate-50 tabular-nums">
              {metrics.momentsDetected}
            </div>
          </div>
          <div className="p-4">
            <div className="text-xs text-slate-400">Clips Queued</div>
            <div className="mt-1 font-mono text-xl font-semibold text-slate-50 tabular-nums">
              {metrics.queued}
            </div>
          </div>
          <div className="p-4">
            <div className="text-xs text-slate-400">Processing</div>
            <div className="mt-1 font-mono text-xl font-semibold text-orange-400 tabular-nums">
              {metrics.processing}
            </div>
          </div>
          <div className="p-4">
            <div className="text-xs text-slate-400">Completed</div>
            <button
              type="button"
              onClick={onNavigateClips}
              className="mt-1 block text-left font-mono text-xl font-semibold text-emerald-400 hover:underline tabular-nums"
            >
              {metrics.completed}
            </button>
          </div>
          <div className="p-4">
            <div className="text-xs text-slate-400">Failed Clips</div>
            <div className="mt-1 font-mono text-xl font-semibold text-red-400 tabular-nums">
              {metrics.failed}
            </div>
          </div>
        </div>
      </section>

      {/* Active & Past Stream Workers */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold text-slate-100">Stream Sessions & Logs</h2>

        {loading && streams.length === 0 ? (
          <div className="rounded-2xl border border-slate-800 bg-[#11151F] p-5">
            <div className="h-4 w-48 animate-pulse rounded bg-slate-800" />
            <div className="mt-3 h-3 w-72 animate-pulse rounded bg-slate-800/70" />
          </div>
        ) : streams.length === 0 ? (
          <div className="rounded-2xl border border-slate-800 bg-[#11151F] px-6 py-10 text-center">
            <p className="text-sm text-slate-400">
              No streams monitored yet. Enter an authorized stream URL or upload a recording above
              to start detecting clips.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-800 rounded-2xl border border-slate-800/90 bg-[#11151F] overflow-hidden">
            {streams.map((stream) => {
              const statusMeta = getStreamStatusMeta(stream.status);
              const isLogsOpen = expandedLogs[stream.id] !== false;
              const sessionEndMs = stream.endedAt ? new Date(stream.endedAt).getTime() : nowMs;
              const elapsedSec = Math.max(
                0,
                Math.floor((sessionEndMs - new Date(stream.startedAt).getTime()) / 1000)
              );
              const liveStartedMs = stream.liveStartedAt
                ? new Date(stream.liveStartedAt).getTime()
                : Number.NaN;
              const liveElapsedSec =
                !Number.isNaN(liveStartedMs)
                  ? Math.max(0, Math.floor((sessionEndMs - liveStartedMs) / 1000))
                  : null;
              const displayTitle = stream.liveTitle || stream.label;

              return (
                <div key={stream.id} className="p-4 sm:p-5">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div className="flex min-w-0 flex-1 flex-col gap-3.5 sm:flex-row sm:items-start">
                      {stream.streamThumbnailUrl && (
                        <div className="relative w-full sm:w-44 aspect-video shrink-0 overflow-hidden rounded-xl border border-slate-800 bg-black">
                          <img
                            src={stream.streamThumbnailUrl}
                            alt={displayTitle}
                            className="h-full w-full object-cover"
                            loading="lazy"
                          />
                          {stream.isLiveBroadcast && statusMeta.isActive && (
                            <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded bg-red-600/95 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-white shadow">
                              <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" />
                              LIVE
                            </span>
                          )}
                        </div>
                      )}

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <h3
                            className="truncate text-base font-semibold text-slate-50"
                            title={displayTitle}
                          >
                            {displayTitle}
                          </h3>
                          <span className="font-mono text-[11px] font-semibold text-orange-300">
                            {stream.formatMode === 'long'
                              ? `LONG-FORM (${stream.aspectMode === 'landscape' ? '16:9' : '9:16'})`
                              : 'SHORTS (9:16)'}
                          </span>
                          <span
                            className={`inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap ${statusMeta.textClass}`}
                          >
                            {statusMeta.isActive && (
                              <span
                                className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"
                                aria-hidden="true"
                              />
                            )}
                            <span>{statusMeta.label}</span>
                          </span>
                        </div>

                        {stream.channelName && (
                          <div className="mt-1.5 flex items-center gap-2 text-xs text-slate-200">
                            {stream.channelAvatarUrl ? (
                              <img
                                src={stream.channelAvatarUrl}
                                alt={stream.channelName}
                                className="h-5 w-5 rounded-full border border-slate-700 object-cover shrink-0"
                                loading="lazy"
                              />
                            ) : (
                              <Radio className="h-3.5 w-3.5 text-red-400 shrink-0" />
                            )}
                            <span className="font-medium truncate">{stream.channelName}</span>
                            {liveElapsedSec !== null && (
                              <>
                                <span className="text-slate-600" aria-hidden="true">
                                  ·
                                </span>
                                <span className="font-mono font-semibold text-red-400 tabular-nums">
                                  Live Running: {formatDuration(liveElapsedSec)}
                                </span>
                              </>
                            )}
                          </div>
                        )}

                        {!stream.channelName && liveElapsedSec !== null && (
                          <div className="mt-1.5 font-mono text-xs font-semibold text-red-400 tabular-nums">
                            Live Running: {formatDuration(liveElapsedSec)}
                          </div>
                        )}

                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400 tabular-nums">
                          <span className="truncate max-w-xs sm:max-w-md font-mono">
                            {stream.sourceUrl}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>Monitor {formatDuration(elapsedSec)}</span>
                          <span aria-hidden="true">·</span>
                          <span>{stream.chunksProcessed} segments scanned</span>
                          <span aria-hidden="true">·</span>
                          <span>{stream.momentsDetected} moments</span>
                        </div>

                        <p className="mt-1 text-xs text-slate-400">
                          Stage: <span className="text-slate-200">{stream.currentStage}</span>
                        </p>

                        {stream.errorMessage && (
                          <p className="mt-1.5 text-xs text-red-400 break-words">{stream.errorMessage}</p>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedLogs((prev) => ({
                            ...prev,
                            [stream.id]: prev[stream.id] === undefined ? false : !prev[stream.id],
                          }))
                        }
                        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-700 px-3.5 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800 whitespace-nowrap"
                      >
                        {isLogsOpen ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                        <span>Logs</span>
                      </button>

                      {statusMeta.isActive && (
                        <button
                          type="button"
                          onClick={() => handleStopStream(stream.id)}
                          disabled={busyId === stream.id}
                          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-red-900/70 bg-red-950/45 px-4 text-xs font-semibold text-red-200 transition-colors hover:bg-red-900/60 disabled:opacity-50 whitespace-nowrap"
                        >
                          <Square className="h-3.5 w-3.5 fill-current" />
                          <span>Stop</span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => setConfirmRemove(stream)}
                        disabled={busyId === stream.id}
                        className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-800 text-slate-400 transition-colors hover:border-slate-700 hover:bg-slate-800 hover:text-red-300 disabled:opacity-50"
                        aria-label={`Remove ${stream.label}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  {isLogsOpen && (
                    <div className="mt-4 rounded-xl border border-slate-800/90 bg-[#090B10] p-3 font-mono text-xs">
                      {stream.logs.length === 0 ? (
                        <div className="text-slate-500">Waiting for stream logs...</div>
                      ) : (
                        <div className="max-h-40 space-y-1 overflow-y-auto pr-1">
                          {stream.logs.map((entry) => {
                            const color =
                              entry.level === 'error'
                                ? 'text-red-400'
                                : entry.level === 'success'
                                ? 'text-emerald-400'
                                : entry.level === 'warn'
                                ? 'text-amber-300'
                                : 'text-slate-300';
                            return (
                              <div key={entry.id} className="flex gap-2.5 leading-relaxed">
                                <span className="text-slate-500 shrink-0 tabular-nums">
                                  {entry.timestamp}
                                </span>
                                <span className={`${color} min-w-0 break-words`}>{entry.message}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <ConfirmModal
        open={Boolean(confirmRemove)}
        title="Remove stream session?"
        description={
          confirmRemove
            ? `This removes "${confirmRemove.label}" from the session log${
                confirmRemove.status === 'monitoring' ? ' and stops active monitoring' : ''
              }. Completed clips stay in your Clips Gallery.`
            : ''
        }
        confirmLabel="Remove Session"
        destructive
        busy={busyId === confirmRemove?.id}
        onConfirm={handleRemoveStream}
        onCancel={() => setConfirmRemove(null)}
      />
    </div>
  );
}
