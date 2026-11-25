import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Film, Globe, MonitorPlay, Play, ShieldCheck, Smartphone, Upload, UploadCloud } from 'lucide-react';
import type {
  ClipFormatMode,
  IdeaLanguagePreference,
  SystemReadiness,
  VideoAspectMode,
  WatermarkPosition,
} from '../types.ts';
import { getYouTubeAccessToken, signInYouTube } from '../lib/youtubeAuth.ts';
import { ConfirmModal } from './ConfirmModal.tsx';
import { GoogleSignInButton } from './GoogleSignInButton.tsx';
import { ZernioButton } from './ZernioButton.tsx';

interface StreamIntakeCardProps {
  readiness: SystemReadiness;
  onStarted: () => void;
  onOpenZernioConnect?: () => void;
}

const WATERMARK_OPTIONS: Array<{ id: WatermarkPosition; label: string }> = [
  { id: 'auto', label: 'Auto Smart-Spot' },
  { id: 'top-left', label: 'Top-Left' },
  { id: 'top-right', label: 'Top-Right' },
  { id: 'bottom-left', label: 'Bottom-Left' },
  { id: 'bottom-right', label: 'Bottom-Right' },
];

export function StreamIntakeCard({
  readiness,
  onStarted,
  onOpenZernioConnect,
}: StreamIntakeCardProps) {
  const [mode, setMode] = useState<'url' | 'upload'>('url');
  const [formatMode, setFormatMode] = useState<ClipFormatMode>('short');
  const [aspectMode, setAspectMode] = useState<VideoAspectMode>('portrait');
  const [brandingEnabled, setBrandingEnabled] = useState(true);
  const [watermarkPosition, setWatermarkPosition] = useState<WatermarkPosition>('auto');
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [additionalInstructions, setAdditionalInstructions] = useState('');
  const [languagePreference, setLanguagePreference] = useState<IdeaLanguagePreference>('auto');
  const [clipCount, setClipCount] = useState<number | ''>('');
  const [file, setFile] = useState<File | null>(null);
  const [segmentSeconds, setSegmentSeconds] = useState(120);
  const [authorizedConfirmed, setAuthorizedConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    percent: number;
    uploadedBytes: number;
    totalBytes: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ytBusy, setYtBusy] = useState(false);
  const [zernioBusy, setZernioBusy] = useState(false);
  const [confirmEnableAuto, setConfirmEnableAuto] = useState(false);

  const yt = readiness.youtubeAutoUpload;
  const zernio = readiness.zernio;
  const hasAnySocialAuth = yt.connected || Boolean(zernio?.connected);

  const handleQuickAuthorizeYouTube = async () => {
    setYtBusy(true);
    setError(null);
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
        throw new Error(data.error || 'Failed to authorize YouTube.');
      }
      onStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in to YouTube.');
    } finally {
      setYtBusy(false);
    }
  };

  const handleToggleAutoUpload = async (enable: boolean) => {
    setYtBusy(true);
    setError(null);
    try {
      const token = getYouTubeAccessToken();
      const res = await fetch('/api/youtube/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ autoUploadEnabled: enable }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update auto-upload setting.');
      }
      setConfirmEnableAuto(false);
      onStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to toggle auto-upload.');
    } finally {
      setYtBusy(false);
    }
  };

  const handleToggleZernioAutoUpload = async (enable: boolean) => {
    setZernioBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/zernio/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoUploadEnabled: enable }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update Zernio auto-upload.');
      }
      onStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to toggle Zernio auto-upload.');
    } finally {
      setZernioBusy(false);
    }
  };

  const handleModeChange = (nextMode: 'url' | 'upload') => {
    setMode(nextMode);
    if (formatMode === 'long') {
      setSegmentSeconds(300);
    } else {
      setSegmentSeconds(nextMode === 'upload' ? 45 : 120);
    }
    setError(null);
  };

  const handleFormatModeChange = (nextFormat: ClipFormatMode) => {
    setFormatMode(nextFormat);
    if (nextFormat === 'long') {
      setSegmentSeconds(300);
    } else {
      setAspectMode('portrait');
      setSegmentSeconds(mode === 'upload' ? 45 : 120);
    }
    setError(null);
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] ?? null;
    setFile(selected);
    if (selected && !label.trim()) {
      setLabel(selected.name.replace(/\.[^.]+$/, ''));
    }
    setError(null);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!hasAnySocialAuth) {
      setError('Connect either Google or Zernio first to unlock monitoring, clipping & auto-upload.');
      return;
    }

    if (!readiness.geminiConfigured) {
      setError('No usable Gemini API key found. Add Gemini API keys in System Setup or set GEMINI_API_KEY in Settings > Secrets.');
      return;
    }
    if (!readiness.ffmpegAvailable) {
      setError('FFmpeg is not available on the backend server.');
      return;
    }
    if (!authorizedConfirmed) {
      setError('Confirm that you own or have permission to clip this stream or footage.');
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'url') {
        if (!url.trim()) {
          throw new Error('Enter an authorized live stream URL.');
        }

        const res = await fetch('/api/streams/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: url.trim(),
            label: label.trim(),
            segmentSeconds,
            formatMode,
            aspectMode: formatMode === 'long' ? aspectMode : 'portrait',
            brandingEnabled,
            watermarkPosition,
            additionalInstructions: additionalInstructions.trim(),
            languagePreference,
            ...(clipCount !== '' ? { clipCount: Number(clipCount) } : {}),
            authorizedConfirmed: true,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Failed to start stream monitoring.');
        }
        setUrl('');
        setLabel('');
      } else {
        if (!file) {
          throw new Error('Select an authorized video recording (.mp4, .mov, .webm, .mkv).');
        }
        if (file.size > 500 * 1024 * 1024) {
          throw new Error('Video file exceeds the 500 MB limit.');
        }

        const initRes = await fetch('/api/streams/upload/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: file.name,
            fileSize: file.size,
            authorizedConfirmed: true,
          }),
        });
        const initData = await initRes.json();
        if (!initRes.ok) {
          throw new Error(initData.error || 'Failed to initialize upload.');
        }

        const uploadId = initData.uploadId as string;
        const CHUNK_SIZE = 4 * 1024 * 1024;
        let offset = 0;

        setUploadProgress({
          percent: 0,
          uploadedBytes: 0,
          totalBytes: file.size,
        });

        while (offset < file.size) {
          const end = Math.min(offset + CHUNK_SIZE, file.size);
          const slice = file.slice(offset, end);

          let chunkSent = false;
          let lastErr: unknown = null;

          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              const chunkRes = await fetch(`/api/streams/upload/chunk/${uploadId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: slice,
              });
              const chunkData = await chunkRes.json();
              if (!chunkRes.ok) {
                throw new Error(chunkData.error || 'Chunk upload failed.');
              }
              chunkSent = true;
              break;
            } catch (err) {
              lastErr = err;
              if (attempt < 2) {
                await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
              }
            }
          }

          if (!chunkSent) {
            throw lastErr instanceof Error
              ? lastErr
              : new Error('Upload connection interrupted while sending video chunks.');
          }

          offset = end;
          setUploadProgress({
            percent: Math.round((offset / file.size) * 100),
            uploadedBytes: offset,
            totalBytes: file.size,
          });
        }

        const completeRes = await fetch(`/api/streams/upload/complete/${uploadId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: label.trim() || file.name,
            segmentSeconds,
            formatMode,
            aspectMode: formatMode === 'long' ? aspectMode : 'portrait',
            brandingEnabled,
            watermarkPosition,
            additionalInstructions: additionalInstructions.trim(),
            languagePreference,
            ...(clipCount !== '' ? { clipCount: Number(clipCount) } : {}),
          }),
        });
        const completeData = await completeRes.json();
        if (!completeRes.ok) {
          throw new Error(completeData.error || 'Failed to start processing job.');
        }

        setFile(null);
        setLabel('');
        setUploadProgress(null);
      }

      onStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start monitoring.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-800/90 bg-[#11151F] p-5 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-50">
            Start Live Stream Monitoring
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Paste an authorized live stream URL or upload your own gameplay recording to detect
            highlights and render 9:16 Shorts with captions.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-1 rounded-xl border border-slate-800 bg-[#090B10] p-1 shrink-0">
          <button
            type="button"
            onClick={() => handleModeChange('url')}
            className={`flex min-h-[40px] items-center justify-center gap-2 rounded-lg px-3.5 text-xs font-medium transition-colors whitespace-nowrap ${
              mode === 'url'
                ? 'bg-slate-800 text-slate-50'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Globe className="h-3.5 w-3.5" />
            <span>Stream URL</span>
          </button>
          <button
            type="button"
            onClick={() => handleModeChange('upload')}
            className={`flex min-h-[40px] items-center justify-center gap-2 rounded-lg px-3.5 text-xs font-medium transition-colors whitespace-nowrap ${
              mode === 'upload'
                ? 'bg-slate-800 text-slate-50'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Upload className="h-3.5 w-3.5" />
            <span>Upload Video</span>
          </button>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="mt-5 space-y-4">
        {!hasAnySocialAuth && (
          <div className="rounded-xl border border-amber-800/60 bg-amber-950/30 p-3.5 text-xs text-amber-100 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="font-semibold text-amber-200">
                Connect Google or Zernio to Unlock Monitoring &amp; Clipping
              </div>
              <p className="mt-0.5 text-amber-200/80">
                Connecting either Google OR Zernio immediately unlocks Live Stream Monitoring, Video Upload, 9:16 splitting, and Auto-Upload.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <GoogleSignInButton
                compact
                label="Sign in with Google"
                loading={ytBusy}
                onClick={() => void handleQuickAuthorizeYouTube()}
              />
              <ZernioButton
                compact
                zernio={zernio}
                label="Connect Zernio"
                onClick={() => onOpenZernioConnect?.()}
              />
            </div>
          </div>
        )}
        {/* AI Output Mode Selector: Short Video vs Long-Form Video */}
        <div className="rounded-xl border border-slate-800 bg-[#090B10] p-3.5 space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                AI Video Output Mode
              </div>
              <p className="mt-0.5 text-xs text-slate-400">
                Choose whether AI clips Shorts or edits 2–5+ min Long-Form YouTube Videos with
                auto-thumbnail.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-slate-800 bg-[#11151F] p-1 shrink-0">
              <button
                type="button"
                onClick={() => handleFormatModeChange('short')}
                className={`flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg px-3.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                  formatMode === 'short'
                    ? 'bg-orange-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Smartphone className="h-3.5 w-3.5" />
                <span>Short Video (9:16)</span>
              </button>
              <button
                type="button"
                onClick={() => handleFormatModeChange('long')}
                className={`flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg px-3.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                  formatMode === 'long'
                    ? 'bg-orange-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <MonitorPlay className="h-3.5 w-3.5" />
                <span>Long-Form Video (2–5m+)</span>
              </button>
            </div>
          </div>

          <div className="space-y-2.5 border-t border-slate-800/80 pt-3">
            <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
              <label className="inline-flex cursor-pointer items-center gap-2.5 text-xs text-slate-200">
                <input
                  type="checkbox"
                  checked={brandingEnabled}
                  onChange={(e) => setBrandingEnabled(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-orange-500 focus:ring-orange-500 shrink-0"
                />
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <span className="inline-flex items-center gap-1 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                    ▶ YT
                  </span>
                  <span>
                    Burn YouTube Logo + <strong>GTA6HUB</strong> watermark on all videos
                  </span>
                </span>
              </label>

              {formatMode === 'long' && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-medium text-slate-400">Aspect:</span>
                  <button
                    type="button"
                    onClick={() => setAspectMode('portrait')}
                    className={`min-h-[32px] rounded-lg border px-2.5 text-[11px] font-semibold transition-colors ${
                      aspectMode === 'portrait'
                        ? 'border-orange-500/70 bg-orange-950/50 text-orange-200'
                        : 'border-slate-800 bg-[#11151F] text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    9:16 Portrait
                  </button>
                  <button
                    type="button"
                    onClick={() => setAspectMode('landscape')}
                    className={`min-h-[32px] rounded-lg border px-2.5 text-[11px] font-semibold transition-colors ${
                      aspectMode === 'landscape'
                        ? 'border-orange-500/70 bg-orange-950/50 text-orange-200'
                        : 'border-slate-800 bg-[#11151F] text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    16:9 Landscape
                  </button>
                </div>
              )}
            </div>

            {brandingEnabled && (
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                <span className="mr-1 text-[11px] font-medium text-slate-400">
                  Watermark Spot:
                </span>
                {WATERMARK_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setWatermarkPosition(opt.id)}
                    className={`min-h-[30px] rounded-lg border px-2.5 text-[11px] font-medium transition-colors whitespace-nowrap ${
                      watermarkPosition === opt.id
                        ? 'border-emerald-500/70 bg-emerald-950/50 text-emerald-200'
                        : 'border-slate-800 bg-[#11151F] text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Additional Custom Focus & Content Instructions */}
        <div className="rounded-xl border border-slate-800 bg-[#090B10] p-3.5 space-y-2.5">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <label htmlFor="additional-instructions" className="text-xs font-semibold uppercase tracking-wider text-slate-300">
              Additional Instructions / Clip &amp; Content Focus
            </label>
            <div className="flex flex-wrap items-center gap-1">
              {[
                { label: 'Funny & Rage', text: 'Focus heavily on funny fails, comical chat reactions, and gamer rage moments.' },
                { label: 'Peak Action', text: 'Prioritize high-speed police chases, gunfights, intense shootouts, and epic clutches.' },
                { label: 'Secrets & Easter Eggs', text: 'Look out for hidden details, map secrets, easter eggs, and deep lore commentary.' },
                { label: 'Clear', text: '' },
              ].map((chip) => (
                <button
                  key={chip.label}
                  type="button"
                  onClick={() => setAdditionalInstructions(chip.text)}
                  className={`min-h-[28px] rounded-lg border px-2 text-[10px] font-medium transition-colors ${
                    chip.label === 'Clear'
                      ? 'border-red-950 bg-red-950/30 text-red-300 hover:bg-red-900/40'
                      : 'border-slate-800 bg-[#11151F] text-slate-300 hover:border-slate-700 hover:text-white'
                  }`}
                >
                  {chip.label}
                </button>
              ))}
            </div>
          </div>
          <textarea
            id="additional-instructions"
            rows={2}
            value={additionalInstructions}
            onChange={(e) => setAdditionalInstructions(e.target.value)}
            placeholder="Mandatory Claude Director instructions — e.g. '00:12-00:45 exact car crash clip, write funny Bangla title with #BD' or 'Focus on police chases'..."
            className="w-full rounded-xl border border-slate-800 bg-[#11151F] px-3.5 py-2.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
          />
        </div>

        {mode === 'url' ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <label htmlFor="live-stream-url" className="block text-xs font-medium text-slate-300">
                Authorized Live Stream URL
              </label>
              <input
                id="live-stream-url"
                type="url"
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://.../live.m3u8 or authorized stream URL"
                className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-800 bg-[#090B10] px-3.5 py-2.5 font-mono text-sm text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="stream-title-label" className="block text-xs font-medium text-slate-300">
                Session Label (Optional)
              </label>
              <input
                id="stream-title-label"
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="GTA VI Freeroam Session"
                className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-800 bg-[#090B10] px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
              />
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <label htmlFor="authorized-file-input" className="block text-xs font-medium text-slate-300">
                Authorized Gameplay Video (MP4, MOV, WebM, MKV — up to 500 MB)
              </label>
              <label
                htmlFor="authorized-file-input"
                className="mt-1.5 flex min-h-[56px] cursor-pointer items-center justify-between gap-3 rounded-xl border border-dashed border-slate-700 bg-[#090B10] px-4 py-3 transition-colors hover:border-slate-500"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Film className="h-5 w-5 text-orange-400 shrink-0" />
                  <span className="truncate text-sm text-slate-200">
                    {file ? file.name : 'Tap to choose video file from device'}
                  </span>
                </div>
                <span className="font-mono text-xs text-slate-400 tabular-nums shrink-0">
                  {file ? `${(file.size / (1024 * 1024)).toFixed(1)} MB` : 'Browse'}
                </span>
                <input
                  id="authorized-file-input"
                  type="file"
                  accept="video/*"
                  onChange={handleFileChange}
                  className="sr-only"
                />
              </label>
            </div>

            <div>
              <label htmlFor="upload-session-label" className="block text-xs font-medium text-slate-300">
                Session Label (Optional)
              </label>
              <input
                id="upload-session-label"
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="GTA VI Stunt Run"
                className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-800 bg-[#090B10] px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
              />
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-4 lg:items-center">
          <div>
            <label htmlFor="segment-interval" className="block text-xs font-medium text-slate-300">
              AI Scan Interval
            </label>
            <select
              id="segment-interval"
              value={segmentSeconds}
              onChange={(e) => setSegmentSeconds(Number(e.target.value))}
              className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-800 bg-[#090B10] px-3 py-2 text-sm text-slate-100 focus:border-orange-500 focus:outline-none"
            >
              {formatMode === 'long' ? (
                <>
                  <option value={180}>Every 3 minutes (2–3 min video)</option>
                  <option value={300}>Every 5 minutes (Default long-form)</option>
                  <option value={360}>Every 6 minutes (Long highlight)</option>
                  <option value={480}>Every 8 minutes</option>
                  <option value={600}>Every 10 minutes (Full chapter)</option>
                </>
              ) : (
                <>
                  <option value={20}>Every 20 seconds (Fast scan)</option>
                  <option value={45}>Every 45 seconds</option>
                  <option value={60}>Every 60 seconds</option>
                  <option value={120}>Every 2 minutes (Default live)</option>
                  <option value={180}>Every 3 minutes</option>
                </>
              )}
            </select>
          </div>

          <div>
            <label htmlFor="stream-lang-lock" className="block text-xs font-medium text-slate-300">
              Caption Language Lock
            </label>
            <select
              id="stream-lang-lock"
              value={languagePreference}
              onChange={(e) => setLanguagePreference(e.target.value as IdeaLanguagePreference)}
              className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-800 bg-[#090B10] px-3 py-2 text-sm text-slate-100 focus:border-orange-500 focus:outline-none"
            >
              <option value="auto">Auto (Bangla / Banglish / EN)</option>
              <option value="bengali">Bangla (বাংলা Only)</option>
              <option value="banglish">Banglish Only</option>
              <option value="english">English Only</option>
            </select>
          </div>

          <div>
            <label htmlFor="stream-clip-count" className="block text-xs font-medium text-slate-300">
              Clip Count Limit
            </label>
            <select
              id="stream-clip-count"
              value={clipCount}
              onChange={(e) => setClipCount(e.target.value ? Number(e.target.value) : '')}
              className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-800 bg-[#090B10] px-3 py-2 text-sm text-slate-100 focus:border-orange-500 focus:outline-none"
            >
              <option value="">Auto (All Highlights)</option>
              <option value="1">1 Clip Only</option>
              <option value="2">Up to 2 Clips</option>
              <option value="3">Up to 3 Clips</option>
              <option value="5">Up to 5 Clips</option>
              <option value="10">Up to 10 Clips</option>
            </select>
          </div>

          <label className="flex min-h-[48px] cursor-pointer items-start gap-3 rounded-xl border border-slate-800 bg-[#090B10] p-3">
            <input
              type="checkbox"
              checked={authorizedConfirmed}
              onChange={(e) => setAuthorizedConfirmed(e.target.checked)}
              className="mt-0.5 h-5 w-5 rounded border-slate-700 bg-slate-900 text-orange-500 focus:ring-orange-500 shrink-0"
            />
            <span className="text-xs leading-relaxed text-slate-300">
              <span className="inline-flex items-center gap-1 font-semibold text-slate-100">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                Authorized Footage Only:
              </span>{' '}
              I confirm I own or have explicit permission to record, clip, and publish this
              stream to YouTube in compliance with copyright rules.
            </span>
          </label>
        </div>

        {/* YouTube & Zernio Connected Accounts Auto-Publish Bar */}
        <div className="space-y-2.5 rounded-xl border border-slate-800 bg-[#090B10] p-3.5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2.5 min-w-0">
              <UploadCloud
                className={`mt-0.5 h-4 w-4 shrink-0 ${
                  (yt.connected && yt.autoUploadEnabled) ||
                  (zernio?.connected && zernio.autoUploadEnabled)
                    ? 'text-emerald-400'
                    : 'text-slate-400'
                }`}
              />
              <div className="min-w-0 text-xs">
                <div className="font-semibold text-slate-200">
                  {yt.connected && yt.autoUploadEnabled && zernio?.connected && zernio.autoUploadEnabled
                    ? `YouTube + Zernio Auto-Upload ON (${zernio.selectedAccountIds.length} Zernio target${zernio.selectedAccountIds.length === 1 ? '' : 's'})`
                    : zernio?.connected && zernio.autoUploadEnabled
                    ? `Zernio Auto-Upload ON · ${zernio.selectedAccountIds.length} selected account${zernio.selectedAccountIds.length === 1 ? '' : 's'}${zernio.hasTikTokAccount ? ' (TikTok Ready)' : ''}`
                    : yt.connected && yt.autoUploadEnabled
                    ? `YouTube Auto-Upload ON · ${yt.channel?.title || 'Connected'} (${yt.privacyStatus})`
                    : zernio?.connected
                    ? `Zernio Active · ${zernio.accounts.length} Connected Account${zernio.accounts.length === 1 ? '' : 's'} (Auto-Upload OFF)`
                    : yt.connected
                    ? `YouTube Ready · ${yt.channel?.title || 'Connected'} (Auto-Upload OFF)`
                    : yt.tokenExpired
                    ? 'YouTube Session Expired — Connect Google or Zernio'
                    : 'Connect Google or Zernio to enable auto-publishing'}
                </div>
                <p className="mt-0.5 text-slate-400">
                  {zernio?.connected
                    ? zernio.accounts.length > 0
                      ? `Zernio Channels: ${zernio.accounts
                          .map(
                            (a) =>
                              `${a.platform}${a.username ? ` @${a.username.replace(/^@/, '')}` : ''}`
                          )
                          .join(', ')}.${
                          !yt.connected ? ' Google/YouTube is optional while Zernio is connected.' : ''
                        }`
                      : 'Zernio Connected · Open Zernio to sync your social accounts.'
                    : yt.connected
                    ? 'YouTube Direct API is active (Zernio optional). All Shorts include Claude copy + #BD tags.'
                    : 'All Shorts enforce 15s+ duration with Claude titles, descriptions, hashtags & #BD tags.'}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {!yt.connected ? (
                <GoogleSignInButton
                  compact
                  label={yt.tokenExpired ? 'Re-authorize Google' : 'Google Login'}
                  loading={ytBusy}
                  onClick={() => void handleQuickAuthorizeYouTube()}
                />
              ) : (
                <button
                  type="button"
                  disabled={ytBusy}
                  onClick={() => {
                    if (yt.autoUploadEnabled) {
                      void handleToggleAutoUpload(false);
                    } else {
                      setConfirmEnableAuto(true);
                    }
                  }}
                  className={`min-h-[40px] rounded-xl px-3.5 text-xs font-semibold transition-colors whitespace-nowrap disabled:opacity-50 ${
                    yt.autoUploadEnabled
                      ? 'border border-emerald-800/70 bg-emerald-950/40 text-emerald-300 hover:bg-emerald-900/50'
                      : 'border border-slate-700 bg-slate-800 text-slate-100 hover:bg-slate-700'
                  }`}
                >
                  {yt.autoUploadEnabled ? 'YouTube Auto: ON' : 'Enable YouTube Auto'}
                </button>
              )}

              {zernio?.connected && zernio.selectedAccountIds.length > 0 && (
                <button
                  type="button"
                  disabled={zernioBusy}
                  onClick={() => void handleToggleZernioAutoUpload(!zernio.autoUploadEnabled)}
                  className={`min-h-[40px] rounded-xl px-3.5 text-xs font-semibold transition-colors whitespace-nowrap disabled:opacity-50 ${
                    zernio.autoUploadEnabled
                      ? 'border border-indigo-600/80 bg-indigo-950/50 text-indigo-200 hover:bg-indigo-900/60'
                      : 'border border-slate-700 bg-slate-800 text-slate-100 hover:bg-slate-700'
                  }`}
                >
                  {zernio.autoUploadEnabled ? 'Zernio Auto: ON' : 'Enable Zernio Auto'}
                </button>
              )}

              <ZernioButton
                compact
                zernio={zernio}
                label="Sign in with Zernio"
                onClick={() => onOpenZernioConnect?.()}
              />
            </div>
          </div>
        </div>

        {uploadProgress && (
          <div className="rounded-xl border border-slate-800 bg-[#090B10] p-3.5">
            <div className="flex items-center justify-between text-xs text-slate-300 tabular-nums">
              <span>Uploading video to processing server...</span>
              <span className="font-mono">
                {uploadProgress.percent}% ({(uploadProgress.uploadedBytes / (1024 * 1024)).toFixed(1)} /{' '}
                {(uploadProgress.totalBytes / (1024 * 1024)).toFixed(1)} MB)
              </span>
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full bg-orange-500 transition-all duration-150"
                style={{ width: `${uploadProgress.percent}%` }}
              />
            </div>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="rounded-xl border border-red-900/70 bg-red-950/40 px-4 py-3 text-sm text-red-200"
          >
            {error}
          </div>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-slate-400">
            {zernio?.connected && zernio.autoUploadEnabled && yt.connected && yt.autoUploadEnabled
              ? `Dual Auto-Upload ON · Clips auto-publish to ${yt.channel?.title || 'YouTube'} and ${zernio.selectedAccountIds.length} Zernio account(s).`
              : zernio?.connected && zernio.autoUploadEnabled
              ? `Zernio Auto-Upload ON (${zernio.uploadMode === 'draft' ? 'Draft' : 'Publish Now'}) · Finished clips auto-publish to ${zernio.selectedAccountIds.length} Zernio account(s).`
              : yt.connected && yt.autoUploadEnabled
              ? formatMode === 'long'
                ? `Auto-Upload Mode (${yt.privacyStatus}) · 2–5m+ Long-Form Videos + Custom Thumbnails auto-publish to ${yt.channel?.title || 'YouTube'}.`
                : `Auto-Upload Mode (${yt.privacyStatus}) · 15s+ Shorts auto-publish to ${yt.channel?.title || 'YouTube'}.`
              : formatMode === 'long'
              ? 'Long-Form Mode (2–5m+ + Custom Thumbnail + GTA6HUB Logo) · Save MP4 or enable YouTube/Zernio Auto-Upload.'
              : '15s+ Shorts Mode (+ GTA6HUB Logo) · Save MP4 to phone or enable Auto-Upload on Google or Zernio.'}
          </p>

          <button
            type="submit"
            disabled={!hasAnySocialAuth || submitting}
            className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-orange-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-orange-500 active:scale-[0.99] disabled:opacity-50 sm:w-auto whitespace-nowrap shrink-0"
          >
            <Play className="h-4 w-4 fill-current" />
            <span>
              {submitting
                ? mode === 'upload'
                  ? `Uploading (${uploadProgress?.percent ?? 0}%)`
                  : 'Starting Monitor...'
                : mode === 'upload'
                ? 'Upload & Start Clipping'
                : 'Start Monitoring'}
            </span>
          </button>
        </div>
      </form>

      <ConfirmModal
        open={confirmEnableAuto}
        title="Enable automatic YouTube Shorts upload?"
        description={`Every finished 15+ second Short will automatically upload to "${
          yt.channel?.title || 'your YouTube channel'
        }" as "${yt.privacyStatus}" with its AI-generated title, description, hashtags, and SEO tags.`}
        confirmLabel="Confirm & Enable Auto-Upload"
        busy={ytBusy}
        onConfirm={() => void handleToggleAutoUpload(true)}
        onCancel={() => setConfirmEnableAuto(false)}
      />
    </section>
  );
}
