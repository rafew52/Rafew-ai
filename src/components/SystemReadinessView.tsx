import { CheckCircle2, AlertTriangle, ShieldCheck } from 'lucide-react';
import type {
  SystemReadiness,
  ThirdPartyExportSettings,
  ZernioConnectionSettings,
} from '../types.ts';
import { AiProviderAndClaudeCard } from './AiProviderAndClaudeCard.tsx';
import { GeminiKeyManagerCard } from './GeminiKeyManagerCard.tsx';
import { ThirdPartyExportCard } from './ThirdPartyExportCard.tsx';
import { YouTubeAutoUploadCard } from './YouTubeAutoUploadCard.tsx';
import { ZernioAutoUploadCard } from './ZernioAutoUploadCard.tsx';

interface SystemReadinessViewProps {
  readiness: SystemReadiness;
  onRefresh: () => void;
  onOpenZernioConnect: () => void;
}

const FALLBACK_ZERNIO: ZernioConnectionSettings = {
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

const FALLBACK_THIRD_PARTY: ThirdPartyExportSettings = {
  webhookUrl: '',
  webhookConfigured: false,
  preferredPlatform: 'custom_webhook',
  autoSendOnComplete: false,
};

export function SystemReadinessView({
  readiness,
  onRefresh,
  onOpenZernioConnect,
}: SystemReadinessViewProps) {
  const yt = readiness.youtubeAutoUpload;
  const zernio = readiness.zernio || FALLBACK_ZERNIO;
  const tp = readiness.thirdPartyExport || FALLBACK_THIRD_PARTY;

  const keyPool = readiness.geminiKeyPool;
  const activeModelList =
    readiness.geminiModels?.activeModels?.slice(0, 3).join(', ') || 'gemini-4-hydrogen';

  const checks = [
    {
      name: 'Claude Creative Director & Dynamic #BD Language Engine',
      envVar: `${readiness.claudeKeyPool.totalCount} Key(s) · ${readiness.aiProvider.toUpperCase()}`,
      ok: readiness.claudeConfigured || readiness.aiProvider === 'gemini',
      detail: readiness.claudeConfigured
        ? `Anthropic Claude is ready (${readiness.claudeKeyPool.totalCount} key(s)). Active Creative Director route: ${readiness.activeAiProvider.toUpperCase()} for unique #BD titles, Bengali/Banglish/English variety, strict custom instructions & live chat.`
        : readiness.aiProvider === 'gemini'
        ? 'AI routing is currently set to Gemini Only. Add an Anthropic Claude key above anytime to enable Claude Creative Director.'
        : 'No Anthropic Claude API key configured yet; currently falling back to Gemini until a Claude key is added above or via ANTHROPIC_API_KEY.',
    },
    {
      name: 'Gemini AI Video & Caption Engine (Self-Healing Pool)',
      envVar: `${keyPool.availableCount}/${keyPool.totalCount} Ready`,
      ok: readiness.geminiConfigured,
      detail: readiness.geminiConfigured
        ? `${keyPool.totalCount} Gemini API key(s) configured (${keyPool.availableCount} ready). Active auto-discovered models: ${activeModelList}. Auto-quarantines 404 models and falls back gracefully on 429/503.`
        : 'No usable Gemini API key configured. Add Gemini API key(s) above or set GEMINI_API_KEY in Settings > Secrets.',
    },
    {
      name: 'Official YouTube Data API v3 Auto-Uploader',
      envVar: yt.connected
        ? 'Google OAuth (youtube.upload)'
        : zernio.connected
        ? 'Optional (Zernio Active)'
        : 'Google OAuth (youtube.upload)',
      ok: yt.connected || zernio.connected,
      detail: yt.connected
        ? `Authorized for "${yt.channel?.title || 'YouTube Channel'}" (${
            yt.autoUploadEnabled ? `Auto-Upload ON · ${yt.privacyStatus}` : 'Connected · Manual trigger ready'
          }).`
        : zernio.connected
        ? 'Optional while Zernio is connected — all search, 9:16 clipping, and Zernio uploads run without requiring Google Sign-In.'
        : yt.tokenExpired
        ? 'Your YouTube authorization session expired. Sign in with Google above (or connect Zernio) to resume automatic uploads.'
        : 'Sign in with Google or Zernio to authorize automatic Shorts & Long-Form Video uploads.',
    },
    {
      name: 'Zernio Connected Accounts & Multi-Platform Uploader',
      envVar: zernio.connected
        ? `${zernio.accounts.length} Account(s)${zernio.hasTikTokAccount ? ' · TikTok Ready' : ''}`
        : yt.connected
        ? 'Optional (Google Active)'
        : 'Optional (Zernio)',
      ok: zernio.connected || yt.connected,
      detail: zernio.connected
        ? `Connected to Zernio with ${zernio.accounts.length} synced account(s)${
            zernio.hasTikTokAccount ? ' (including TikTok 9:16 + Duet/Stitch/Inbox features)' : ''
          }. ${
            zernio.autoUploadEnabled
              ? `Auto-Upload ON (${zernio.selectedAccountIds.length} selected targets).`
              : 'Manual upload ready in Shorts Gallery.'
          }`
        : yt.connected
        ? 'Optional while Google/YouTube is connected — click Sign in with Zernio anytime to add TikTok and multi-platform accounts.'
        : 'Click Sign in with Zernio (or Sign in with Google) to unlock discovery, connected channels, and Auto-Upload.',
    },
    {
      name: 'FFmpeg Renderer, GTA6HUB Watermark & ASS Subtitles',
      envVar: 'System Binary (ffmpeg)',
      ok: readiness.ffmpegAvailable,
      detail: readiness.ffmpegAvailable
        ? 'FFmpeg is installed on the backend with libass subtitle burn-in, custom 1280×720 thumbnail generation, and YouTube Logo + GTA6HUB watermark overlay.'
        : 'FFmpeg binary is missing on the server host. Install FFmpeg to enable stream segmentation and clip rendering.',
    },
    {
      name: 'FFprobe Media Inspector',
      envVar: 'System Binary (ffprobe)',
      ok: readiness.ffprobeAvailable,
      detail: readiness.ffprobeAvailable
        ? 'FFprobe is available for exact segment duration inspection and Short / Long-Form clip timing.'
        : 'FFprobe binary not detected; duration falls back to configured segment window.',
    },
    {
      name: 'Stream Manifest Extractor (ytdl-core + HLS/RTMP)',
      envVar: 'YOUTUBE_COOKIE (Optional)',
      ok: true,
      detail: readiness.youtubeCookieConfigured
        ? 'Authenticated YouTube session cookie is active in Settings > Secrets alongside direct HLS (.m3u8), RTMP, and MP4 ingestion.'
        : 'Direct HLS (.m3u8), RTMP, MP4, and anonymous YouTube streams are active. To add or update a YouTube cookie, set YOUTUBE_COOKIE in Settings > Secrets.',
    },
  ];

  return (
    <div className="max-w-3xl space-y-6">
      <AiProviderAndClaudeCard
        aiProvider={readiness.aiProvider}
        activeAiProvider={readiness.activeAiProvider}
        keyPool={readiness.claudeKeyPool}
        onUpdated={onRefresh}
      />

      <GeminiKeyManagerCard keyPool={keyPool} onUpdated={onRefresh} />

      <YouTubeAutoUploadCard settings={yt} onUpdated={onRefresh} />

      <ZernioAutoUploadCard
        settings={zernio}
        onUpdated={onRefresh}
        onOpenConnectModal={onOpenZernioConnect}
      />

      <ThirdPartyExportCard settings={tp} onUpdated={onRefresh} />

      <div className="rounded-2xl border border-slate-800/90 bg-[#11151F] p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-slate-50">
          Backend Pipeline &amp; Service Readiness
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          Live status of server credentials, video processing binaries, and persistent job storage.
        </p>

        <div className="mt-5 divide-y divide-slate-800/80 border-t border-slate-800/80">
          {checks.map((item) => (
            <div key={item.name} className="flex items-start gap-3.5 py-4">
              {item.ok ? (
                <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-400 shrink-0" />
              ) : (
                <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-400 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-100">{item.name}</span>
                  <span className="font-mono text-xs text-slate-400">{item.envVar}</span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">{item.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800/90 bg-[#11151F] p-5 sm:p-6">
        <div className="flex items-center gap-2.5">
          <ShieldCheck className="h-5 w-5 text-emerald-400" />
          <h3 className="text-base font-semibold text-slate-100">
            Automated Shorts &amp; Long-Form GTA6HUB Workflow
          </h3>
        </div>

        <ol className="mt-4 space-y-2.5 text-sm leading-relaxed text-slate-300 list-decimal pl-5">
          <li>
            Authorize your YouTube channel above with <strong>Sign in with Google</strong> or connect
            your social channels via <strong>Sign in with Zernio</strong>, select target accounts,
            and turn on <strong>Enable Auto-Upload</strong>.
          </li>
          <li>
            In <strong>Live Monitor</strong>, choose <strong>Short Video (9:16)</strong> or{' '}
            <strong>Long-Form Video (2–5+ min)</strong>, enter a stream URL or upload a recording,
            and confirm authorization.
          </li>
          <li>
            Every video is edited with burned-in captions, full original audio, and the{' '}
            <strong>YouTube Logo + GTA6HUB</strong> channel watermark. Completed clips auto-upload to
            your connected Google/YouTube and Zernio accounts (including TikTok 9:16 when connected).
          </li>
          <li>
            You can also inspect, edit metadata, download MP4s or thumbnails, or trigger one-click
            uploads anytime from the <strong>Shorts Gallery</strong> tab.
          </li>
        </ol>
      </div>
    </div>
  );
}
