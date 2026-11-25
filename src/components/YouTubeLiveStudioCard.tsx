import { useEffect, useState } from 'react';
import {
  Radio,
  Play,
  Square,
  Users,
  Heart,
  MessageSquare,
  Bot,
  Sparkles,
  AlertCircle,
  CheckCircle2,
  FileText,
  ShieldCheck,
  Activity,
  RefreshCw,
} from 'lucide-react';

interface LiveChatMessage {
  id: string;
  author: string;
  message: string;
  timestamp: string;
  isAiGenerated?: boolean;
}

interface AutoDoctorLogEvent {
  id: string;
  timestamp: string;
  type: 'info' | 'warn' | 'error' | 'healed';
  message: string;
}

interface YouTubeLiveStudioSessionData {
  id: string;
  sourceUrl: string;
  resolvedSourceUrl?: string;
  sourceType: 'video' | 'live';
  aspectMode: 'landscape' | 'portrait';
  status: 'idle' | 'broadcasting' | 'stopped' | 'error';
  startedAt: string;
  streamTitle: string;
  description: string;
  tags: string[];
  thumbnailUrl: string;
  broadcastId?: string;
  streamId?: string;
  activeLiveChatId?: string;
  viewersCount: number;
  likesCount: number;
  chatMessages: LiveChatMessage[];
  aiAutoChatEnabled: boolean;
  lastAiChatAt?: string;
  healthStatus: 'healthy' | 'recovering' | 'backup_active' | 'self_healed' | 'error';
  ffmpegBitrate?: string;
  ffmpegFps?: string;
  ffmpegTime?: string;
  restartCount: number;
  autoDoctorLogs: AutoDoctorLogEvent[];
  errorMessage?: string;
}

interface YouTubeLiveStudioCardProps {
  onRefresh: () => void;
}

export function YouTubeLiveStudioCard({ onRefresh }: YouTubeLiveStudioCardProps) {
  const [session, setSession] = useState<YouTubeLiveStudioSessionData | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceType, setSourceType] = useState<'auto' | 'video' | 'live'>('auto');
  const [aspectMode, setAspectMode] = useState<'landscape' | 'portrait'>('landscape');
  const [streamTitle, setStreamTitle] = useState('');
  const [description, setDescription] = useState('');
  const [customThumbnailUrl, setCustomThumbnailUrl] = useState('');
  const [aiAutoChatEnabled, setAiAutoChatEnabled] = useState(true);
  const [generatingMetadata, setGeneratingMetadata] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSessionStatus = async () => {
    try {
      const res = await fetch('/api/youtube/live-studio');
      if (res.ok) {
        const data = await res.json();
        setSession(data.session || null);
      }
    } catch (err) {
      console.warn('Failed to fetch live studio status:', err);
    }
  };

  useEffect(() => {
    void fetchSessionStatus();
    const id = setInterval(fetchSessionStatus, 3000);
    return () => clearInterval(id);
  }, []);

  const handleGenerateMetadata = async () => {
    if (!sourceUrl.trim()) {
      setError('Enter a source video or live stream URL first to generate AI title and description.');
      return;
    }
    setGeneratingMetadata(true);
    setError(null);
    try {
      const res = await fetch('/api/youtube/live-studio/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceUrl: sourceUrl.trim(),
          sourceType: sourceType === 'auto' ? undefined : sourceType,
          aspectMode,
          aiAutoChatEnabled: false,
        }),
      });
      const data = await res.json();
      if (res.ok && data.session) {
        setStreamTitle(data.session.streamTitle);
        setDescription(data.session.description);
        await fetch('/api/youtube/live-studio/stop', { method: 'POST' });
        setSession(null);
      }
    } catch (err) {
      setError('Failed to generate AI metadata.');
    } finally {
      setGeneratingMetadata(false);
    }
  };

  const handleStartBroadcast = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sourceUrl.trim()) {
      setError('Please enter a source video URL or live stream URL.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/youtube/live-studio/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceUrl: sourceUrl.trim(),
          sourceType: sourceType === 'auto' ? undefined : sourceType,
          aspectMode,
          streamTitle: streamTitle.trim() || undefined,
          description: description.trim() || undefined,
          customThumbnailUrl: customThumbnailUrl.trim() || undefined,
          aiAutoChatEnabled,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to start Live Studio broadcast.');
      }
      setSession(data.session);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start broadcast.');
    } finally {
      setBusy(false);
    }
  };

  const handleStopBroadcast = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/youtube/live-studio/stop', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setSession(data.session || null);
        onRefresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop broadcast.');
    } finally {
      setBusy(false);
    }
  };

  const handleSendAiMessageNow = async () => {
    if (!session) return;
    setBusy(true);
    try {
      const res = await fetch('/api/youtube/live-studio/send-chat', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setSession(data.session);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send AI chat message.');
    } finally {
      setBusy(false);
    }
  };

  const handleToggleAiChat = async (enabled: boolean) => {
    setAiAutoChatEnabled(enabled);
    try {
      await fetch('/api/youtube/live-studio/toggle-ai-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aiAutoChatEnabled: enabled }),
      });
      if (session) {
        setSession({ ...session, aiAutoChatEnabled: enabled });
      }
    } catch (err) {
      console.warn('Failed to toggle AI auto chat:', err);
    }
  };

  const isBroadcasting = session?.status === 'broadcasting';

  return (
    <div className="rounded-2xl border border-slate-800/90 bg-[#11151F] p-5 sm:p-6 space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Radio className="h-5 w-5 text-red-500 animate-pulse" />
            <h2 className="text-lg font-semibold text-slate-50">
              Link-to-YouTube Live Studio &amp; Zero-Drop Broadcast
            </h2>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            Multi-tier failover extractors, Fast Watchdog recovery (1–3s), and AI Auto-Doctor self-healing ensure zero unexpected stream drops (&ldquo;auto-off&rdquo;).
          </p>
        </div>

        <div className="shrink-0 flex items-center gap-2">
          {isBroadcasting ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-red-950/80 border border-red-800/80 px-3 py-1 text-xs font-bold text-red-300">
              <span className="h-2 w-2 rounded-full bg-red-500 animate-ping" />
              <span>BROADCASTING LIVE</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800/80 border border-slate-700 px-3 py-1 text-xs font-medium text-slate-300">
              <span>Studio Idle</span>
            </span>
          )}
        </div>
      </div>

      {!isBroadcasting ? (
        <form onSubmit={handleStartBroadcast} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <label htmlFor="studio-source-url" className="block text-xs font-medium text-slate-300">
                Source Video or Live Stream URL
              </label>
              <input
                id="studio-source-url"
                type="url"
                required
                disabled={busy}
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=... or live stream URL"
                className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-800 bg-[#090B10] px-3.5 py-2.5 text-sm text-slate-100 focus:border-red-500 focus:outline-none disabled:opacity-50"
              />
            </div>

            <div>
              <label htmlFor="studio-source-type" className="block text-xs font-medium text-slate-300">
                Smart Start Mode
              </label>
              <select
                id="studio-source-type"
                value={sourceType}
                disabled={busy}
                onChange={(e) => setSourceType(e.target.value as 'auto' | 'video' | 'live')}
                className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-800 bg-[#090B10] px-3.5 py-2.5 text-sm text-slate-100 focus:border-red-500 focus:outline-none disabled:opacity-50"
              >
                <option value="auto">Auto-Detect Link Type</option>
                <option value="video">Recorded Video (Start 00:00)</option>
                <option value="live">Live Stream (Live Edge)</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="studio-aspect-mode" className="block text-xs font-medium text-slate-300">
                Output Aspect Ratio
              </label>
              <select
                id="studio-aspect-mode"
                value={aspectMode}
                disabled={busy}
                onChange={(e) => setAspectMode(e.target.value as 'landscape' | 'portrait')}
                className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-800 bg-[#090B10] px-3.5 py-2.5 text-sm text-slate-100 focus:border-red-500 focus:outline-none disabled:opacity-50"
              >
                <option value="landscape">16:9 Landscape (Standard YouTube Live)</option>
                <option value="portrait">9:16 Portrait (Shorts / Vertical Live)</option>
              </select>
            </div>

            <div>
              <div className="flex items-center justify-between">
                <label htmlFor="studio-custom-thumb" className="block text-xs font-medium text-slate-300">
                  Thumbnail URL (Optional)
                </label>
                <span className="text-[11px] text-slate-400">Automatic AI Thumbnail Fallback if empty</span>
              </div>
              <input
                id="studio-custom-thumb"
                type="url"
                disabled={busy}
                value={customThumbnailUrl}
                onChange={(e) => setCustomThumbnailUrl(e.target.value)}
                placeholder="https://... (Leave empty for AI High-CTR Thumbnail)"
                className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-800 bg-[#090B10] px-3.5 py-2.5 text-sm text-slate-100 focus:border-red-500 focus:outline-none disabled:opacity-50"
              />
            </div>
          </div>

          <div className="space-y-3 rounded-xl border border-slate-800/80 bg-[#090B10] p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-orange-400" />
                <span className="text-xs font-semibold text-slate-200">AI-Generated Title &amp; Description</span>
              </div>
              <button
                type="button"
                disabled={generatingMetadata || busy}
                onClick={handleGenerateMetadata}
                className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg border border-orange-800/80 bg-orange-950/50 px-3 text-xs font-semibold text-orange-200 hover:bg-orange-900/60 disabled:opacity-50"
              >
                <Sparkles className="h-3.5 w-3.5 text-orange-400" />
                <span>{generatingMetadata ? 'Generating...' : 'Generate AI Metadata'}</span>
              </button>
            </div>

            <div>
              <label htmlFor="studio-title-input" className="block text-[11px] text-slate-400">Live Title</label>
              <input
                id="studio-title-input"
                type="text"
                disabled={busy}
                value={streamTitle}
                onChange={(e) => setStreamTitle(e.target.value)}
                placeholder="e.g. GTA6HUB Epic Live Gameplay & Moments"
                className="mt-1 min-h-[40px] w-full rounded-lg border border-slate-800 bg-[#090B10] px-3 py-2 text-xs text-slate-100 focus:border-red-500 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="studio-desc-input" className="block text-[11px] text-slate-400">Live Description &amp; Tags</label>
              <textarea
                id="studio-desc-input"
                rows={2}
                disabled={busy}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Description with likes, subscription calls to action, and hashtags..."
                className="mt-1 w-full rounded-lg border border-slate-800 bg-[#090B10] p-3 text-xs text-slate-100 focus:border-red-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-1">
            <div className="flex items-center gap-3">
              <div>
                <div className="text-xs font-semibold text-slate-200">20-Minute AI Auto-Chat</div>
                <div className="text-[11px] text-slate-400">
                  Gemini posts fresh engagement messages every 20 mins.
                </div>
              </div>
              <label className="relative inline-flex cursor-pointer items-center">
                <input
                  type="checkbox"
                  checked={aiAutoChatEnabled}
                  onChange={(e) => {
                    setAiAutoChatEnabled(e.target.checked);
                    void handleToggleAiChat(e.target.checked);
                  }}
                  className="peer sr-only"
                />
                <div className="peer h-6 w-11 rounded-full bg-slate-800 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-slate-600 after:bg-white after:transition-all after:content-[''] peer-checked:bg-red-600 peer-checked:after:translate-x-full peer-checked:after:border-white peer-focus:outline-none" />
              </label>
            </div>

            <button
              type="submit"
              disabled={busy}
              className="inline-flex min-h-[46px] items-center gap-2 rounded-xl bg-red-600 px-6 text-sm font-semibold text-white transition-colors hover:bg-red-500 disabled:opacity-50 shadow-lg shadow-red-950/40"
            >
              <Play className="h-4 w-4 fill-current" />
              <span>Start Zero-Drop Broadcast</span>
            </button>
          </div>
        </form>
      ) : (
        <div className="space-y-6">
          {/* Active Broadcast Header & Stop Control */}
          <div className="flex flex-col gap-4 rounded-xl border border-red-900/60 bg-red-950/20 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3.5 min-w-0">
              {session.thumbnailUrl && (
                <img
                  src={session.thumbnailUrl}
                  alt={session.streamTitle}
                  className={`aspect-video shrink-0 object-cover rounded-lg border border-slate-800 ${
                    session.aspectMode === 'portrait' ? 'h-24 w-14' : 'h-16 w-28'
                  }`}
                />
              )}
              <div className="min-w-0">
                <div className="font-mono text-xs font-semibold text-red-400">
                  ZERO-DROP BROADCAST • {session.aspectMode.toUpperCase()} ({session.sourceType.toUpperCase()})
                </div>
                <h3 className="mt-1 truncate text-base font-semibold text-slate-50">
                  {session.streamTitle}
                </h3>
                <p className="mt-0.5 truncate font-mono text-xs text-slate-400">
                  {session.sourceUrl}
                </p>
              </div>
            </div>

            <button
              type="button"
              disabled={busy}
              onClick={handleStopBroadcast}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-red-800 bg-red-900/60 px-5 text-xs font-semibold text-white transition-colors hover:bg-red-800 disabled:opacity-50 shrink-0"
            >
              <Square className="h-4 w-4 fill-current" />
              <span>Stop Broadcast</span>
            </button>
          </div>

          {/* Live Metrics Grid */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-slate-800 bg-[#090B10] p-4">
              <div className="flex items-center gap-1.5 text-xs text-slate-400">
                <Users className="h-4 w-4 text-orange-400" />
                <span>Live Viewers</span>
              </div>
              <div className="mt-2 font-mono text-2xl font-bold text-slate-50 tabular-nums">
                {session.viewersCount.toLocaleString()}
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-[#090B10] p-4">
              <div className="flex items-center gap-1.5 text-xs text-slate-400">
                <Heart className="h-4 w-4 text-red-400" />
                <span>Likes</span>
              </div>
              <div className="mt-2 font-mono text-2xl font-bold text-slate-50 tabular-nums">
                {session.likesCount.toLocaleString()}
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-[#090B10] p-4">
              <div className="flex items-center gap-1.5 text-xs text-slate-400">
                <Activity className="h-4 w-4 text-emerald-400" />
                <span>FFmpeg FPS / Bitrate</span>
              </div>
              <div className="mt-2 font-mono text-xs font-bold text-slate-100 tabular-nums">
                {session.ffmpegFps ? `${session.ffmpegFps} fps` : '30 fps'} · {session.ffmpegBitrate || '3000k'}
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-[#090B10] p-4">
              <div className="flex items-center gap-1.5 text-xs text-slate-400">
                <ShieldCheck className="h-4 w-4 text-orange-400" />
                <span>Auto-Doctor Health</span>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="font-mono text-sm font-semibold uppercase text-emerald-400">
                  {session.healthStatus} ({session.restartCount} restarts)
                </span>
              </div>
            </div>
          </div>

          {/* AI Auto-Doctor Diagnostics & Event Logs */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-orange-400" />
              <h4 className="text-sm font-semibold text-slate-100">
                AI Auto-Doctor Supervisor &amp; Failover Event Log
              </h4>
            </div>
            <div className="rounded-xl border border-slate-800 bg-[#090B10] p-3.5 font-mono text-xs">
              {session.autoDoctorLogs.length === 0 ? (
                <div className="text-slate-500">All systems nominal. Fast Watchdog actively monitoring stream health...</div>
              ) : (
                <div className="max-h-36 space-y-1.5 overflow-y-auto pr-1">
                  {session.autoDoctorLogs.map((log) => {
                    const color =
                      log.type === 'error'
                        ? 'text-red-400'
                        : log.type === 'healed'
                        ? 'text-emerald-400'
                        : log.type === 'warn'
                        ? 'text-amber-300'
                        : 'text-slate-300';
                    return (
                      <div key={log.id} className="flex gap-2.5 leading-relaxed">
                        <span className="text-slate-500 shrink-0 tabular-nums">{log.timestamp}</span>
                        <span className={`${color} font-sans text-xs break-words`}>{log.message}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Live Comments & Chat Feed with AI 20-min Engine */}
          <div className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-slate-300" />
                <h4 className="text-sm font-semibold text-slate-100">
                  Live Comments &amp; Chat Feed (AI Auto-Chat Every 20 Mins)
                </h4>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-2 text-xs text-slate-300">
                  <span>AI Auto-Chat:</span>
                  <button
                    type="button"
                    onClick={() => handleToggleAiChat(!session.aiAutoChatEnabled)}
                    className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors ${
                      session.aiAutoChatEnabled
                        ? 'bg-emerald-950 border border-emerald-800 text-emerald-300'
                        : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    {session.aiAutoChatEnabled ? 'ENABLED' : 'DISABLED'}
                  </button>
                </div>

                <button
                  type="button"
                  disabled={busy}
                  onClick={handleSendAiMessageNow}
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl border border-orange-800/80 bg-orange-950/50 px-3 text-xs font-semibold text-orange-200 transition-colors hover:bg-orange-900/60 disabled:opacity-50"
                >
                  <Sparkles className="h-3.5 w-3.5 text-orange-400" />
                  <span>Send AI Message Now</span>
                </button>
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-[#090B10] p-4 font-mono text-xs">
              <div className="max-h-56 space-y-2.5 overflow-y-auto pr-2">
                {session.chatMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex flex-col gap-1 rounded-lg p-2.5 border ${
                      msg.isAiGenerated
                        ? 'border-orange-900/50 bg-orange-950/20 text-orange-200'
                        : 'border-slate-800 bg-slate-900/60 text-slate-300'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold flex items-center gap-1.5 text-slate-200">
                        {msg.isAiGenerated && <Bot className="h-3.5 w-3.5 text-orange-400 shrink-0" />}
                        {msg.author}
                      </span>
                      <span className="text-[10px] text-slate-500 tabular-nums">{msg.timestamp}</span>
                    </div>
                    <p className="text-xs break-words leading-relaxed text-slate-100">{msg.message}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200 flex items-center gap-2"
        >
          <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
