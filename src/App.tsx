import { useCallback, useEffect, useState } from 'react';
import { Activity, CheckCircle2, Clapperboard, FileText, Loader2, Radio, Settings2, Stethoscope } from 'lucide-react';
import { AllActionsDrawer } from './components/AllActionsDrawer.tsx';
import { AutoDoctorView } from './components/AutoDoctorView.tsx';
import { GoogleSignInButton } from './components/GoogleSignInButton.tsx';
import { LiveMonitorsView } from './components/LiveMonitorsView.tsx';
import { ManualClipStudioCard } from './components/ManualClipStudioCard.tsx';
import { ShortsLibraryView } from './components/ShortsLibraryView.tsx';
import { SiteMusicPlayer } from './components/SiteMusicPlayer.tsx';
import { SystemReadinessView } from './components/SystemReadinessView.tsx';
import { ZernioButton } from './components/ZernioButton.tsx';
import { ZernioConnectModal } from './components/ZernioConnectModal.tsx';
import { ACTIONS_UPDATED_EVENT, recordClientAction } from './lib/actionLog.ts';
import { initYouTubeAuth, signInYouTube } from './lib/youtubeAuth.ts';
import type { ActionActivityEntry, DashboardSnapshot, ZernioConnectionSettings } from './types.ts';

type ActiveTab = 'monitor' | 'manual' | 'clips' | 'doctor' | 'setup';

const FALLBACK_ZERNIO_SETTINGS: ZernioConnectionSettings = {
  connected: false,
  hasApiKey: false,
  autoUploadEnabled: false,
  uploadMode: 'publish_now',
  accounts: [],
  selectedAccountIds: [],
  hasTikTokAccount: false,
  tiktokOptions: {
    draft: false,
    privacyLevel: 'PUBLIC_TO_EVERYONE',
    allowComment: true,
    allowDuet: true,
    allowStitch: true,
    videoCoverTimestampMs: 1000,
  },
};

const EMPTY_SNAPSHOT: DashboardSnapshot = {
  streams: [],
  clips: [],
  readiness: {
    aiProvider: 'auto',
    activeAiProvider: 'gemini',
    claudeConfigured: false,
    claudeKeyPool: {
      keys: [],
      totalCount: 0,
      activeKeyMasked: null,
    },
    geminiConfigured: true,
    geminiKeyPool: {
      keys: [],
      maxUserKeys: 10,
      activeKeyId: null,
      availableCount: 0,
      totalCount: 0,
    },
    geminiModels: {
      activeModels: ['gemini-4-hydrogen'],
      discoveredModels: ['gemini-4-hydrogen'],
      quarantinedModels: [],
    },
    ffmpegAvailable: true,
    ffprobeAvailable: true,
    ytDlpAvailable: false,
    youtubeCookieConfigured: false,
    queueRunning: false,
    activeProcessingClipId: null,
    youtubeAutoUpload: {
      connected: false,
      tokenExpired: false,
      autoUploadEnabled: false,
      smartTimingEnabled: true,
      directStudioMode: false,
      slots: [],
      privacyStatus: 'public',
      categoryId: '20',
      madeForKids: false,
      channel: null,
    },
    zernio: { ...FALLBACK_ZERNIO_SETTINGS },
    thirdPartyExport: {
      webhookUrl: '',
      webhookConfigured: false,
      preferredPlatform: 'custom_webhook',
      autoSendOnComplete: false,
    },
    autoDoctorAlertCount: 0,
  },
};

export default function App() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>('manual');
  const [headerYtBusy, setHeaderYtBusy] = useState(false);
  const [headerAuthError, setHeaderAuthError] = useState<string | null>(null);
  const [zernioModalOpen, setZernioModalOpen] = useState(false);
  const [actionsDrawerOpen, setActionsDrawerOpen] = useState(false);
  const [actionLogs, setActionLogs] = useState<ActionActivityEntry[]>([]);
  const [clearingActions, setClearingActions] = useState(false);

  useEffect(() => {
    document.title = 'Rafew X GTA VI Clip AI — Live Stream Auto-Clipper';
  }, []);

  const fetchSnapshot = useCallback(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch('/api/snapshot', { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`);
      }
      const data = (await res.json()) as DashboardSnapshot;
      setSnapshot(data);
      setFetchError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to reach backend.';
      setFetchError(msg);
      void recordClientAction({
        category: 'stream_pipeline',
        actionName: 'Workspace Snapshot Fetch',
        sourceRef: '/api/snapshot',
        status: 'error',
        summary: `Background snapshot refresh delayed or failed (${msg}); workspace remains active with defaults.`,
      });
    } finally {
      clearTimeout(timeoutId);
      setLoading(false);
    }
  }, []);

  const fetchActions = useCallback(async () => {
    try {
      const res = await fetch('/api/actions');
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data?.actions)) {
        setActionLogs(data.actions as ActionActivityEntry[]);
      }
    } catch {
      // Ignore background log polling errors
    }
  }, []);

  const handleClearActions = useCallback(async () => {
    setClearingActions(true);
    try {
      const res = await fetch('/api/actions', { method: 'DELETE' });
      if (res.ok) {
        setActionLogs([]);
      }
    } finally {
      setClearingActions(false);
    }
  }, []);

  useEffect(() => {
    void fetchSnapshot();
    void fetchActions();
  }, [fetchSnapshot, fetchActions]);

  useEffect(() => {
    const onActionsUpdated = () => {
      void fetchActions();
    };
    window.addEventListener(ACTIONS_UPDATED_EVENT, onActionsUpdated);
    return () => window.removeEventListener(ACTIONS_UPDATED_EVENT, onActionsUpdated);
  }, [fetchActions]);

  useEffect(() => {
    return initYouTubeAuth();
  }, []);

  const openSetupTab = useCallback(() => {
    setActiveTab('setup');
  }, []);

  const openZernioConnectModal = useCallback(() => {
    setZernioModalOpen(true);
  }, []);

  const handleHeaderGoogleSignIn = async () => {
    setHeaderYtBusy(true);
    setHeaderAuthError(null);
    try {
      const { accessToken } = await signInYouTube();
      const res = await fetch('/api/youtube/connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to connect Google YouTube account.');
      }
      await fetchSnapshot();
    } catch (err) {
      setHeaderAuthError(err instanceof Error ? err.message : 'Unable to sign in with Google.');
    } finally {
      setHeaderYtBusy(false);
    }
  };

  const hasActiveWork =
    snapshot.streams.some(
      (s) =>
        s.status === 'monitoring' ||
        s.status === 'initializing' ||
        s.status === 'stopping'
    ) ||
    snapshot.clips.some(
      (c) =>
        c.status === 'queued' ||
        c.status === 'processing' ||
        c.youtubeUploadStatus === 'queued_upload' ||
        c.youtubeUploadStatus === 'uploading' ||
        c.zernioPublishStatus === 'pending' ||
        c.zernioPublishStatus === 'uploading'
    ) ||
    snapshot.readiness.queueRunning;

  const hasRunningActions = actionLogs.some(
    (a) => a.status === 'running' || a.status === 'queued'
  );
  const errorActionsCount = actionLogs.filter((a) => a.status === 'error').length;

  useEffect(() => {
    const intervalMs = actionsDrawerOpen || hasRunningActions || hasActiveWork ? 1500 : 5000;
    const timer = setInterval(() => {
      void fetchSnapshot();
      void fetchActions();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [actionsDrawerOpen, hasRunningActions, hasActiveWork, fetchSnapshot, fetchActions]);

  const activeStreamsCount = snapshot.streams.filter(
    (s) => s.status === 'monitoring' || s.status === 'initializing'
  ).length;
  const queuedCount = snapshot.clips.filter((c) => c.status === 'queued').length;
  const processingCount = snapshot.clips.filter((c) => c.status === 'processing').length;
  const completedCount = snapshot.clips.filter((c) => c.status === 'completed').length;
  const failedCount = snapshot.clips.filter((c) => c.status === 'failed').length;

  const pageTitle =
    activeTab === 'monitor'
      ? 'Live Monitor'
      : activeTab === 'manual'
      ? 'Manual Clip Info'
      : activeTab === 'clips'
      ? 'Shorts Gallery'
      : activeTab === 'doctor'
      ? 'AI Auto-Doctor'
      : 'System Setup';

  return (
    <div className="flex min-h-screen bg-[#090B10] text-slate-100">
      {/* Desktop Left Sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-800/80 bg-[#0D1017] lg:flex">
        <div className="flex h-16 items-center border-b border-slate-800/80 px-6">
          <span className="font-display text-base font-bold tracking-tight text-slate-50 whitespace-nowrap truncate">
            Rafew X GTA VI Clip AI
          </span>
        </div>

        <nav className="flex-1 space-y-1 p-4" aria-label="Primary">
          <button
            type="button"
            onClick={() => setActiveTab('monitor')}
            className={`flex min-h-[44px] w-full items-center justify-between rounded-xl px-3.5 text-sm font-medium transition-colors whitespace-nowrap ${
              activeTab === 'monitor'
                ? 'bg-slate-800/90 text-slate-50'
                : 'text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <Radio className="h-4 w-4" />
              <span>Live Monitor</span>
            </span>
            <span className="font-mono text-xs text-slate-400 tabular-nums">
              {activeStreamsCount}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('manual')}
            className={`flex min-h-[44px] w-full items-center justify-between rounded-xl px-3.5 text-sm font-medium transition-colors whitespace-nowrap ${
              activeTab === 'manual'
                ? 'bg-slate-800/90 text-slate-50'
                : 'text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <FileText className="h-4 w-4" />
              <span>Manual Info</span>
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('clips')}
            className={`flex min-h-[44px] w-full items-center justify-between rounded-xl px-3.5 text-sm font-medium transition-colors whitespace-nowrap ${
              activeTab === 'clips'
                ? 'bg-slate-800/90 text-slate-50'
                : 'text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <Clapperboard className="h-4 w-4" />
              <span>Shorts Gallery</span>
            </span>
            <span className="font-mono text-xs text-slate-400 tabular-nums">
              {snapshot.clips.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('doctor')}
            className={`flex min-h-[44px] w-full items-center justify-between rounded-xl px-3.5 text-sm font-medium transition-colors whitespace-nowrap ${
              activeTab === 'doctor'
                ? 'bg-slate-800/90 text-slate-50'
                : 'text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <Stethoscope className="h-4 w-4" />
              <span>AI Auto-Doctor</span>
            </span>
            {snapshot.readiness.autoDoctorAlertCount > 0 && (
              <span className="font-mono text-xs text-amber-400 tabular-nums">
                {snapshot.readiness.autoDoctorAlertCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('setup')}
            className={`flex min-h-[44px] w-full items-center justify-between rounded-xl px-3.5 text-sm font-medium transition-colors whitespace-nowrap ${
              activeTab === 'setup'
                ? 'bg-slate-800/90 text-slate-50'
                : 'text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <Settings2 className="h-4 w-4" />
              <span>System Setup</span>
            </span>
          </button>
        </nav>

        {/* Queue & Pipeline Summary Ledger */}
        <div className="space-y-2.5 border-t border-slate-800/80 p-5 text-xs">
          <div className="flex items-center justify-between text-slate-400">
            <span>Pipeline State</span>
            <span
              className={`font-medium ${
                hasActiveWork ? 'text-emerald-400' : 'text-slate-400'
              }`}
            >
              {hasActiveWork ? 'Active' : 'Stopped'}
            </span>
          </div>
          <div className="flex items-center justify-between text-slate-400">
            <span>Queued</span>
            <span className="font-mono text-slate-200 tabular-nums">{queuedCount}</span>
          </div>
          <div className="flex items-center justify-between text-slate-400">
            <span>Processing</span>
            <span className="font-mono text-orange-400 tabular-nums">{processingCount}</span>
          </div>
          <div className="flex items-center justify-between text-slate-400">
            <span>Completed</span>
            <span className="font-mono text-emerald-400 tabular-nums">{completedCount}</span>
          </div>
          <div className="flex items-center justify-between text-slate-400">
            <span>Failed</span>
            <span className="font-mono text-red-400 tabular-nums">{failedCount}</span>
          </div>
        </div>
      </aside>

      {/* Main Responsive Workspace */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Compact Top Header */}
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-2 sm:gap-4 border-b border-slate-800/80 bg-[#090B10]/90 px-3 sm:px-6 backdrop-blur-md lg:h-16">
          <div className="min-w-0 flex-1">
            <span className="font-display text-sm font-bold tracking-tight text-slate-50 truncate block lg:hidden">
              Rafew X GTA VI Clip AI
            </span>
            <div className="hidden lg:flex items-center gap-2 text-sm whitespace-nowrap">
              <span className="text-slate-500">Workspace</span>
              <span className="text-slate-600" aria-hidden="true">
                /
              </span>
              <span className="font-medium text-slate-100">{pageTitle}</span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span
              className={`hidden sm:inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap mr-1 ${
                hasActiveWork ? 'text-emerald-400' : 'text-slate-400'
              }`}
            >
              {hasActiveWork && (
                <span
                  className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"
                  aria-hidden="true"
                />
              )}
              <span>{hasActiveWork ? 'Pipeline Running' : 'Stopped / Idle'}</span>
            </span>

            {snapshot.readiness.youtubeAutoUpload.connected ? (
              <button
                type="button"
                onClick={openSetupTab}
                title={`Google YouTube connected: ${snapshot.readiness.youtubeAutoUpload.channel?.title || 'Authorized'}`}
                className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl border border-emerald-800/70 bg-emerald-950/35 px-2.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-900/45 whitespace-nowrap"
              >
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden md:inline max-w-[110px] truncate">
                  {snapshot.readiness.youtubeAutoUpload.channel?.title || 'Google'}
                </span>
                <span className="md:hidden">Google</span>
              </button>
            ) : (
              <GoogleSignInButton
                compact
                label="Google Login"
                loading={headerYtBusy}
                onClick={() => void handleHeaderGoogleSignIn()}
              />
            )}

            <button
              type="button"
              onClick={() => {
                setActionsDrawerOpen(true);
                void fetchActions();
              }}
              title="Open live All Actions activity & error log"
              className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-xl border px-2.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                errorActionsCount > 0
                  ? 'border-red-800/80 bg-red-950/35 text-red-200 hover:bg-red-900/40'
                  : hasRunningActions
                  ? 'border-amber-700/70 bg-amber-950/35 text-amber-200 hover:bg-amber-900/40'
                  : 'border-slate-700/90 bg-slate-900 text-slate-200 hover:bg-slate-800'
              }`}
            >
              {hasRunningActions ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400 shrink-0" />
              ) : (
                <Activity
                  className={`h-3.5 w-3.5 shrink-0 ${
                    errorActionsCount > 0 ? 'text-red-400' : 'text-orange-400'
                  }`}
                />
              )}
              <span className="hidden sm:inline">All Actions</span>
              <span className="font-mono text-[11px] tabular-nums opacity-85">
                {errorActionsCount > 0 ? `${errorActionsCount}!` : actionLogs.length}
              </span>
            </button>

            <ZernioButton
              compact
              zernio={snapshot.readiness.zernio}
              label="Zernio Login"
              onClick={openZernioConnectModal}
            />
          </div>
        </header>

        <SiteMusicPlayer />

        <main className="flex-1 px-4 py-5 pb-24 sm:px-6 lg:px-8 lg:py-8 lg:pb-10">
          <div className="mx-auto max-w-6xl space-y-6">
            {fetchError && (
              <div
                role="alert"
                className="rounded-2xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200"
              >
                Backend connection issue: {fetchError}
              </div>
            )}

            {headerAuthError && (
              <div
                role="alert"
                className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-xs text-red-200"
              >
                <span>{headerAuthError}</span>
                <button
                  type="button"
                  onClick={() => setHeaderAuthError(null)}
                  className="rounded-lg border border-slate-700 px-2.5 py-1 text-slate-300 hover:bg-slate-800"
                >
                  Dismiss
                </button>
              </div>
            )}

            {activeTab === 'monitor' && (
              <LiveMonitorsView
                streams={snapshot.streams}
                clips={snapshot.clips}
                readiness={snapshot.readiness}
                loading={loading}
                onRefresh={() => void fetchSnapshot()}
                onNavigateClips={() => setActiveTab('clips')}
                onOpenZernioConnect={openZernioConnectModal}
              />
            )}

            {activeTab === 'manual' && (
              <ManualClipStudioCard
                zernio={snapshot.readiness.zernio}
                onOpenZernioConnect={openZernioConnectModal}
                onRefreshSnapshot={() => void fetchSnapshot()}
              />
            )}

            {activeTab === 'clips' && (
              <ShortsLibraryView
                clips={snapshot.clips}
                youtubeSettings={snapshot.readiness.youtubeAutoUpload}
                zernioSettings={snapshot.readiness.zernio}
                thirdPartyExportSettings={snapshot.readiness.thirdPartyExport}
                onRefresh={() => void fetchSnapshot()}
                onGoToMonitor={() => setActiveTab('monitor')}
                onOpenZernioConnect={openZernioConnectModal}
              />
            )}

            {activeTab === 'doctor' && (
              <AutoDoctorView
                readiness={snapshot.readiness}
                onRefreshSnapshot={() => void fetchSnapshot()}
              />
            )}

            {activeTab === 'setup' && (
              <SystemReadinessView
                readiness={snapshot.readiness}
                onRefresh={() => void fetchSnapshot()}
                onOpenZernioConnect={openZernioConnectModal}
              />
            )}

            <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/70 pt-5 text-xs text-slate-500">
              <span>Clips ai · AI Video Clipping &amp; Optional Social Publishing</span>
            </footer>
          </div>
        </main>
      </div>

      {/* Android Thumb-Zone Bottom Navigation Bar (Mobile <lg, 64px height) */}
      <nav
        aria-label="Mobile Navigation"
        className="fixed bottom-0 left-0 right-0 z-40 grid h-16 grid-cols-5 border-t border-slate-800/90 bg-[#0D1017]/95 backdrop-blur-md lg:hidden"
      >
        <button
          type="button"
          onClick={() => setActiveTab('monitor')}
          className={`flex min-h-[44px] flex-col items-center justify-center gap-1 transition-colors ${
            activeTab === 'monitor' ? 'text-orange-400' : 'text-slate-400'
          }`}
        >
          <Radio className="h-5 w-5" />
          <span className="text-[10px] font-medium tracking-tight">Monitor</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('manual')}
          className={`flex min-h-[44px] flex-col items-center justify-center gap-1 transition-colors ${
            activeTab === 'manual' ? 'text-orange-400' : 'text-slate-400'
          }`}
        >
          <FileText className="h-5 w-5" />
          <span className="text-[10px] font-medium tracking-tight">Manual</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('clips')}
          className={`flex min-h-[44px] flex-col items-center justify-center gap-1 transition-colors ${
            activeTab === 'clips' ? 'text-orange-400' : 'text-slate-400'
          }`}
        >
          <Clapperboard className="h-5 w-5" />
          <span className="text-[10px] font-medium tracking-tight tabular-nums">
            Clips ({snapshot.clips.length})
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('doctor')}
          className={`flex min-h-[44px] flex-col items-center justify-center gap-1 transition-colors ${
            activeTab === 'doctor' ? 'text-orange-400' : 'text-slate-400'
          }`}
        >
          <Stethoscope className="h-5 w-5" />
          <span className="text-[10px] font-medium tracking-tight">Doctor</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('setup')}
          className={`flex min-h-[44px] flex-col items-center justify-center gap-1 transition-colors ${
            activeTab === 'setup' ? 'text-orange-400' : 'text-slate-400'
          }`}
        >
          <Settings2 className="h-5 w-5" />
          <span className="text-[10px] font-medium tracking-tight">Setup</span>
        </button>
      </nav>

      <ZernioConnectModal
        open={zernioModalOpen}
        settings={snapshot.readiness.zernio || FALLBACK_ZERNIO_SETTINGS}
        onClose={() => setZernioModalOpen(false)}
        onUpdated={() => void fetchSnapshot()}
      />

      <AllActionsDrawer
        open={actionsDrawerOpen}
        actions={actionLogs}
        clearing={clearingActions}
        onClose={() => setActionsDrawerOpen(false)}
        onClear={() => void handleClearActions()}
      />
    </div>
  );
}
