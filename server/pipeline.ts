import fs from 'fs';
import path from 'path';
import { execFile, spawn, type ChildProcess } from 'child_process';
import type { Readable } from 'stream';
import { promisify } from 'util';
import { chooseFormat, Client, Ytdl } from '@distube/ytdl-core';
import {
  normalizeYouTubeCookieHeader,
  resolveInstalledYtDlpPath,
  resolveYouTubeStreams,
} from './youtubeExtractor.ts';
import type {
  CaptionCue,
  ClipFormatMode,
  ClipItem,
  ContentLanguageChoice,
  MomentCategory,
  RequirementSpec,
  ResolvedWatermarkSpot,
  StreamJob,
  StreamLogEntry,
  StreamSourceType,
  SystemReadiness,
  ThumbnailSourceLink,
  VideoAspectMode,
  WatermarkPosition,
} from '../src/types.ts';
import { getActiveAiProvider, getAiSettings, initAiSettings } from './aiRouter.ts';
import {
  checkStrictMomentMatch,
  isLikelyUrl,
  parseRequirementSpec,
  sanitizeHashtags,
  sanitizeSeoTags,
  sanitizeTitleText,
  stripDummyPhrasesFromText,
  stripUrlsFromText,
  validateAndCleanClipMetadata,
  type ParsedRequirementContext,
} from './requirementEngine.ts';
import { ensureUniqueBatchClipMetadata } from './metadataGuard.ts';
import {
  isClaudeConfigured,
  parseAllTimestampRanges,
  refineMomentsWithClaude,
} from './claude.ts';
import { getClaudeKeyPoolSummary, initClaudeKeyStorage } from './claudeKeys.ts';
import {
  analyzeVideoChunk,
  designSearchGroundedThumbnail,
  detectBestWatermarkCornerWithGemini,
  detectFacecamRegionWithGemini,
  isGeminiConfigured,
  type ChunkAnalysisResult,
  type DetectedMoment,
  type ThumbnailAccentTheme,
  type ThumbnailTextPlacement,
} from './gemini.ts';
import { getGeminiKeyPoolSummary, initGeminiKeys } from './geminiKeys.ts';
import { discoverGeminiModels, getModelRegistryStatus } from './geminiModels.ts';
import {
  getAutoDoctorAlertCount,
  recordDoctorEvent,
  registerAutoDoctorContextProvider,
} from './autoDoctor.ts';
import {
  buildAssFilterExpression,
  extractFfmpegStderrTail,
  validateAssSubtitleFile,
  writeUtf8AssAndSrtSubtitles,
} from './subtitles.ts';
import { startActionLog, updateActionLog } from './actionLog.ts';
import {
  getYouTubeSettings,
  hasActiveYouTubeToken,
  initYouTubeSettings,
  uploadClipToYouTube,
} from './youtube.ts';
import { AllYouTubeQuotaExhaustedError } from './youtubeOAuthPool.ts';
import {
  getZernioSettings,
  hasActiveZernioAuth,
  hasSelectedZernioTargets,
  initZernioSettings,
  uploadClipToZernio,
} from './zernio.ts';
import {
  dispatchClipToThirdPartyWebhook,
  getThirdPartyExportSettings,
  initThirdPartyExport,
} from './thirdPartyExport.ts';

const MIN_SHORT_SECONDS = 15;
const MAX_SHORT_SECONDS = 60;
const MIN_LONG_SECONDS = 120;
const MAX_LONG_SECONDS = 600;

const execFileAsync = promisify(execFile);

const DATA_DIR = path.resolve(process.cwd(), 'data');
const STREAMS_DIR = path.join(DATA_DIR, 'streams');
const BRAND_BADGE_PATH = path.join(DATA_DIR, 'gta6hub_badge_v2.png');
const CLIPS_INDEX_FILE = path.join(DATA_DIR, 'queue_index.json');
const STREAMS_INDEX_FILE = path.join(DATA_DIR, 'streams_index.json');
const CHUNK_REFS_FILE = path.join(DATA_DIR, 'chunk_refs.json');

interface RuntimeWorker {
  job: StreamJob;
  stopRequested: boolean;
  lastHeartbeatMs?: number;
  recordProcess?: ChildProcess;
  inputStream?: Readable;
  audioStream?: Readable;
}

interface InternalClipRecord extends ClipItem {
  chunkPath?: string;
  zernioTargetAccountIds?: string[];
  zernioUploadModeOverride?: import('../src/types.ts').ZernioUploadMode;
}

const workers = new Map<string, RuntimeWorker>();
let clipQueue: InternalClipRecord[] = [];
const activeAnalyzedChunks = new Set<string>();
let queueWorkerRunning = false;
let activeProcessingClipId: string | null = null;
let youtubeUploadWorkerRunning = false;
let zernioPublishWorkerRunning = false;

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STREAMS_DIR)) fs.mkdirSync(STREAMS_DIR, { recursive: true });
}

function saveClipsIndex() {
  ensureDirs();
  fs.writeFileSync(CLIPS_INDEX_FILE, JSON.stringify(clipQueue, null, 2), 'utf-8');
}

function saveStreamsIndex() {
  ensureDirs();
  const list = Array.from(workers.values()).map((w) => w.job);
  fs.writeFileSync(STREAMS_INDEX_FILE, JSON.stringify(list, null, 2), 'utf-8');
}

function saveChunkRefs() {
  ensureDirs();
  fs.writeFileSync(
    CHUNK_REFS_FILE,
    JSON.stringify(Array.from(activeAnalyzedChunks), null, 2),
    'utf-8'
  );
}

let watchdogIntervalStarted = false;

function startBackgroundWatchdog() {
  if (watchdogIntervalStarted) return;
  watchdogIntervalStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const [id, worker] of workers.entries()) {
      if (worker.job.status === 'monitoring' && worker.lastHeartbeatMs) {
        const idleSec = Math.floor((now - worker.lastHeartbeatMs) / 1000);
        if (idleSec >= 75) {
          recordDoctorEvent(
            'warn',
            'Watchdog',
            `Stream "${worker.job.label}" heartbeat quiet for ${idleSec}s (stage: ${worker.job.currentStage}).`,
            { streamId: id }
          );
        }
      }
    }
  }, 15_000);
}

export function initPipelineStorage() {
  ensureDirs();
  initGeminiKeys();
  initClaudeKeyStorage();
  initAiSettings();
  initYouTubeSettings();
  initZernioSettings();
  initThirdPartyExport();
  registerAutoDoctorContextProvider(async () => ({
    streams: getAllStreams(),
    clips: getAllClips(),
    readiness: await getSystemReadiness(),
  }));
  void discoverGeminiModels();
  startBackgroundWatchdog();

  try {
    if (fs.existsSync(CLIPS_INDEX_FILE)) {
      const loaded = JSON.parse(
        fs.readFileSync(CLIPS_INDEX_FILE, 'utf-8')
      ) as InternalClipRecord[];
      clipQueue = loaded.map((item) => {
        const next: InternalClipRecord = {
          ...item,
          formatMode: item.formatMode === 'long' ? 'long' : 'short',
          aspectMode: item.aspectMode === 'landscape' ? 'landscape' : 'portrait',
          brandingEnabled: item.brandingEnabled ?? true,
          watermarkPosition: item.watermarkPosition ?? 'auto',
        };
        if (next.status === 'processing') {
          next.status = 'queued';
        }
        if (next.youtubeUploadStatus === 'uploading') {
          next.youtubeUploadStatus = 'queued_upload';
        }
        if (next.zernioPublishStatus === 'uploading') {
          next.zernioPublishStatus = 'pending';
        }
        return next;
      });
      saveClipsIndex();
    }
  } catch {
    clipQueue = [];
  }

  try {
    if (fs.existsSync(STREAMS_INDEX_FILE)) {
      const savedStreams = JSON.parse(
        fs.readFileSync(STREAMS_INDEX_FILE, 'utf-8')
      ) as StreamJob[];
      for (const raw of savedStreams) {
        const s: StreamJob = {
          ...raw,
          formatMode: raw.formatMode === 'long' ? 'long' : 'short',
          aspectMode: raw.aspectMode === 'landscape' ? 'landscape' : 'portrait',
          brandingEnabled: raw.brandingEnabled ?? true,
          watermarkPosition: raw.watermarkPosition ?? 'auto',
        };
        if (
          s.status === 'monitoring' ||
          s.status === 'initializing' ||
          s.status === 'stopping'
        ) {
          s.status = 'stopped';
          s.endedAt = s.endedAt || new Date().toISOString();
          s.currentStage = 'Stopped (server restarted)';
        }
        workers.set(s.id, { job: s, stopRequested: true });
      }
      saveStreamsIndex();
    }
  } catch {
    // Ignore corrupt index
  }

  // Resume any queued clips left over before restart
  if (clipQueue.some((c) => c.status === 'queued')) {
    void ensureQueueWorkerRunning();
  }
  if (clipQueue.some((c) => c.status === 'completed' && c.zernioPublishStatus === 'pending')) {
    void ensureZernioPublishWorkerRunning();
  }
}

async function checkBinary(cmd: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(cmd, args, { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

export async function getSystemReadiness(): Promise<SystemReadiness> {
  const [ffmpegAvailable, ffprobeAvailable, ytDlpPathAvailable] = await Promise.all([
    checkBinary('ffmpeg', ['-version']),
    checkBinary('ffprobe', ['-version']),
    checkBinary('yt-dlp', ['--version']),
  ]);
  const ytDlpAvailable = ytDlpPathAvailable || Boolean(resolveInstalledYtDlpPath());

  return {
    aiProvider: getAiSettings().provider,
    activeAiProvider: getActiveAiProvider(),
    claudeConfigured: isClaudeConfigured(),
    claudeKeyPool: getClaudeKeyPoolSummary(),
    geminiConfigured: isGeminiConfigured(),
    geminiKeyPool: getGeminiKeyPoolSummary(),
    geminiModels: getModelRegistryStatus(),
    ffmpegAvailable,
    ffprobeAvailable,
    ytDlpAvailable,
    youtubeCookieConfigured: Boolean(process.env.YOUTUBE_COOKIE?.trim()),
    queueRunning: queueWorkerRunning,
    activeProcessingClipId,
    youtubeAutoUpload: getYouTubeSettings(),
    zernio: getZernioSettings(),
    thirdPartyExport: getThirdPartyExportSettings(),
    autoDoctorAlertCount: getAutoDoctorAlertCount(),
  };
}

function addStreamLog(
  streamId: string,
  level: StreamLogEntry['level'],
  message: string
) {
  const worker = workers.get(streamId);
  if (!worker) return;
  worker.lastHeartbeatMs = Date.now();
  const timestamp = new Date().toTimeString().slice(0, 8);
  const entry: StreamLogEntry = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp,
    level,
    message,
  };
  worker.job.logs.unshift(entry);
  if (worker.job.logs.length > 80) {
    worker.job.logs.length = 80;
  }
  if (level === 'error' || level === 'warn') {
    const codeMatch = message.match(/\bHTTP\s+(\d{3})\b/i);
    recordDoctorEvent(
      level === 'error' ? 'error' : 'warn',
      'Stream Pipeline',
      message,
      {
        streamId,
        ...(codeMatch ? { httpCode: Number(codeMatch[1]) } : {}),
      }
    );
  }
  saveStreamsIndex();
}

function updateJob(streamId: string, patch: Partial<StreamJob>) {
  const worker = workers.get(streamId);
  if (!worker) return;
  Object.assign(worker.job, patch);
  saveStreamsIndex();
}

async function getVideoDurationSeconds(filePath: string, fallback: number): Promise<number> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    const parsed = parseFloat(stdout.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  } catch {
    // Fallback
  }
  return fallback;
}

export function isYouTubeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname.includes('youtube.com') || u.hostname.includes('youtu.be');
  } catch {
    return false;
  }
}

interface PreparedIngestion {
  ffmpegInputArg: string;
  inputStream?: Readable;
  audioStream?: Readable;
  transcodeVideo: boolean;
  hasAudioTrack: boolean;
}

function sanitizeFfmpegErrorLine(line: string): string {
  const cleaned = line.replace(/https?:\/\/[^\s|]+/g, (url) => {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname}`;
    } catch {
      return url.slice(0, 60);
    }
  });
  return cleaned.trim();
}

function isFfmpegBannerLine(line: string): boolean {
  return /^(ffmpeg version|built with|configuration:|lib(av|sw|postproc)|Input #|Metadata:|Duration:|Stream #|Output #|Press \[q\])/i.test(
    line.trim()
  );
}

export function normalizeYouTubeCookie(raw?: string): string | undefined {
  return normalizeYouTubeCookieHeader(raw);
}

async function prepareStreamIngestion(
  streamId: string,
  inputUrl: string
): Promise<PreparedIngestion> {
  if (!isYouTubeUrl(inputUrl)) {
    return {
      ffmpegInputArg: inputUrl,
      transcodeVideo: false,
      hasAudioTrack: true,
    };
  }

  addStreamLog(streamId, 'info', 'Connecting to YouTube stream via authenticated session...');

  // Fast pre-fetch via YouTube oEmbed so channel name, live title & thumbnail show immediately
  try {
    const oembedRes = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(inputUrl)}&format=json`,
      { signal: AbortSignal.timeout(3500) }
    );
    if (oembedRes.ok) {
      const oembed = (await oembedRes.json()) as {
        title?: string;
        author_name?: string;
        thumbnail_url?: string;
      };
      updateJob(streamId, {
        ...(oembed.author_name ? { channelName: oembed.author_name } : {}),
        ...(oembed.title ? { liveTitle: oembed.title } : {}),
        ...(oembed.thumbnail_url ? { streamThumbnailUrl: oembed.thumbnail_url } : {}),
      });
    }
  } catch {
    // Non-fatal; extractor below provides full details
  }

  try {
    const cookie = normalizeYouTubeCookie(process.env.YOUTUBE_COOKIE);
    let ytdl: Ytdl | null = null;
    let info: Awaited<ReturnType<Ytdl['getInfo']>> | null = null;

    // Try VisionOS first (needs no player script, immune to player JS breakage), then safe fallback clients
    for (const cfg of [
      { ...(cookie ? { cookie } : {}), clients: [Client.VisionOS] },
      { ...(cookie ? { cookie } : {}), clients: [Client.VisionOS, Client.WebEmbedded, Client.Tv] },
    ]) {
      try {
        const candidate = new Ytdl(cfg);
        const fetched = await candidate.getInfo(inputUrl);
        if (Array.isArray(fetched.formats) && fetched.formats.length > 0) {
          ytdl = candidate;
          info = fetched;
          break;
        }
      } catch {
        // Fall through to yt-dlp resolution below
      }
    }

    if (!ytdl || !info) {
      const ytStreams = await resolveYouTubeStreams(inputUrl);
      updateJob(streamId, {
        ...(ytStreams.channelName ? { channelName: ytStreams.channelName } : {}),
        ...(ytStreams.title ? { liveTitle: ytStreams.title } : {}),
        ...(ytStreams.thumbnailUrl ? { streamThumbnailUrl: ytStreams.thumbnailUrl } : {}),
        ...(typeof ytStreams.isLive === 'boolean' ? { isLiveBroadcast: ytStreams.isLive } : {}),
      });
      addStreamLog(
        streamId,
        'success',
        `Connected to stream "${ytStreams.title || 'YouTube Stream'}" via multi-client yt-dlp extractor.`
      );
      return {
        ffmpegInputArg: ytStreams.videoUrl,
        transcodeVideo: false,
        hasAudioTrack: ytStreams.hasAudioInVideoUrl,
      };
    }

    const vd = info.videoDetails;
    const playerMicro = (
      info.playerResponse as {
        microformat?: {
          playerMicroformatRenderer?: {
            liveBroadcastDetails?: { startTimestamp?: string; isLiveNow?: boolean };
            ownerChannelName?: string;
          };
        };
      } | undefined
    )?.microformat?.playerMicroformatRenderer;

    const rawStartTs = playerMicro?.liveBroadcastDetails?.startTimestamp;
    let liveStartedAt: string | undefined;
    if (rawStartTs && !Number.isNaN(Date.parse(rawStartTs))) {
      liveStartedAt = new Date(rawStartTs).toISOString();
    } else if (vd.isLive && vd.lengthSeconds > 0) {
      liveStartedAt = new Date(Date.now() - vd.lengthSeconds * 1000).toISOString();
    } else if (vd.isLive) {
      liveStartedAt = new Date().toISOString();
    }

    const bestThumb =
      vd.thumbnails?.[vd.thumbnails.length - 1]?.url ||
      (vd.id ? `https://i.ytimg.com/vi/${vd.id}/hqdefault.jpg` : undefined);
    const bestAvatar =
      vd.author?.thumbnails?.[vd.author.thumbnails.length - 1]?.url;

    updateJob(streamId, {
      channelName: vd.author?.name || playerMicro?.ownerChannelName || undefined,
      channelAvatarUrl: bestAvatar,
      liveTitle: vd.title || undefined,
      streamThumbnailUrl: bestThumb,
      isLiveBroadcast: Boolean(vd.isLive || playerMicro?.liveBroadcastDetails?.isLiveNow),
      ...(liveStartedAt ? { liveStartedAt } : {}),
    });

    // Prefer combined format only if >= 720p (<= 1080p); otherwise use dual-stream HD video + dedicated audio
    const combinedFormats = info.formats.filter(
      (f) => f.hasVideo && f.hasAudio && (f.height || 0) <= 1080
    );
    const highCombined = combinedFormats
      .filter((f) => (f.height || 0) >= 720)
      .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.fps || 0) - (a.fps || 0))[0];

    if (highCombined) {
      const mediaStream = ytdl.download(info, { format: highCombined });
      const isWebm = (highCombined.mimeType || '').toLowerCase().includes('webm');
      addStreamLog(
        streamId,
        'success',
        `Connected to stream "${info.videoDetails.title}" (${highCombined.qualityLabel || 'HD'} video + audio).`
      );
      return {
        ffmpegInputArg: 'pipe:0',
        inputStream: mediaStream,
        transcodeVideo: isWebm,
        hasAudioTrack: true,
      };
    }

    // Select best video format up to 1080p (prefer H.264/MP4 so FFmpeg copies video with zero CPU stall)
    const videoCandidates = info.formats.filter((f) => f.hasVideo && (f.height || 0) <= 1080);
    const mp4H264Candidates = videoCandidates.filter(
      (f) =>
        f.container === 'mp4' &&
        ((f.videoCodec || '').toLowerCase().includes('avc') ||
          (f.mimeType || '').toLowerCase().includes('avc'))
    );
    const sortVideo = (a: (typeof info.formats)[number], b: (typeof info.formats)[number]) =>
      (b.height || 0) - (a.height || 0) ||
      (b.fps || 0) - (a.fps || 0) ||
      (b.bitrate || 0) - (a.bitrate || 0);

    let videoFormat =
      mp4H264Candidates.sort(sortVideo)[0] ||
      videoCandidates.sort(sortVideo)[0];

    if (!videoFormat) {
      videoFormat = chooseFormat(info.formats, {
        quality: 'highestvideo',
        filter: { hasVideo: true },
      });
    }

    // Always capture the highest-quality matching audio stream when video lacks embedded audio
    let audioFormat: (typeof info.formats)[number] | undefined;
    if (!videoFormat.hasAudio) {
      const audioOnlyCandidates = info.formats.filter((f) => f.hasAudio && !f.hasVideo);
      const mp4AudioCandidates = audioOnlyCandidates.filter(
        (f) => f.container === 'mp4' || (f.audioCodec || '').toLowerCase().includes('mp4a')
      );
      const sortAudio = (a: (typeof info.formats)[number], b: (typeof info.formats)[number]) =>
        (b.audioBitrate || 0) - (a.audioBitrate || 0) || (b.bitrate || 0) - (a.bitrate || 0);

      audioFormat =
        mp4AudioCandidates.sort(sortAudio)[0] ||
        audioOnlyCandidates.sort(sortAudio)[0];

      if (!audioFormat) {
        try {
          audioFormat = chooseFormat(info.formats, {
            quality: 'highestaudio',
            filter: { hasAudio: true },
          });
        } catch {
          // Check combined formats as final fallback before giving up on audio
          const anyCombined = combinedFormats.sort(sortVideo)[0];
          if (anyCombined) {
            videoFormat = anyCombined;
          }
        }
      }
    }

    const mediaStream = ytdl.download(info, { format: videoFormat });
    const dedicatedAudioStream =
      !videoFormat.hasAudio && audioFormat
        ? ytdl.download(info, { format: audioFormat })
        : undefined;

    const hasAudioTrack = Boolean(videoFormat.hasAudio || dedicatedAudioStream);
    const isMp4H264 =
      videoFormat.container === 'mp4' &&
      ((videoFormat.videoCodec || '').toLowerCase().includes('avc') ||
        (videoFormat.mimeType || '').toLowerCase().includes('avc'));
    const transcodeVideo = !isMp4H264;

    addStreamLog(
      streamId,
      hasAudioTrack ? 'success' : 'warn',
      hasAudioTrack
        ? `Connected to stream "${info.videoDetails.title}" (${videoFormat.qualityLabel || 'HD'} video + ${
            audioFormat?.audioCodec || videoFormat.audioCodec || 'AAC'
          } audio).`
        : `Connected to stream "${info.videoDetails.title}" (${videoFormat.qualityLabel || 'HD'}), but YouTube returned no audio stream.`
    );

    return {
      ffmpegInputArg: 'pipe:0',
      inputStream: mediaStream,
      audioStream: dedicatedAudioStream,
      transcodeVideo,
      hasAudioTrack,
    };
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const lower = rawMsg.toLowerCase();
    if (
      rawMsg.includes('SAPISID') ||
      rawMsg.includes('AUTH_FAILED') ||
      lower.includes('signed out')
    ) {
      throw new Error(
        'Your YOUTUBE_COOKIE secret is signed out, expired, or missing SAPISID / __Secure-3PAPISID. Export a fresh signed-in YouTube cookie (Cookie header, Netscape cookies.txt, or JSON) and update YOUTUBE_COOKIE in Settings > Secrets.'
      );
    }
    if (
      rawMsg.includes('BOT_CHECK') ||
      lower.includes('not a bot') ||
      lower.includes('sign in')
    ) {
      throw new Error(
        'YouTube triggered a bot check on this cloud server IP. Set or refresh YOUTUBE_COOKIE in Settings > Secrets, use a direct HLS (.m3u8) / RTMP stream URL, or upload your video recording.'
      );
    }
    throw new Error(
      `Unable to ingest YouTube URL (${rawMsg}). Try a direct HLS (.m3u8) / RTMP / MP4 URL or upload an authorized recording.`
    );
  }
}

function formatSrtTimestamp(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(
    secs
  ).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function formatAssTimestamp(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const cs = Math.floor((safe - Math.floor(safe)) * 100);
  return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(
    cs
  ).padStart(2, '0')}`;
}

function containsBengali(text?: string): boolean {
  return Boolean(text && /[\u0980-\u09FF]/.test(text));
}

function writeSubtitleFiles(
  captions: CaptionCue[],
  durationSeconds: number,
  srtPath: string,
  assPath: string,
  playResX = 1080,
  playResY = 1920,
  facecamSplitActive = false,
  fallbackText?: string
): boolean {
  return writeUtf8AssAndSrtSubtitles({
    captions,
    durationSeconds,
    fallbackText,
    srtPath,
    assPath,
    playResX,
    playResY,
    splitScreenActive: facecamSplitActive,
  });
}

function escapeFfmpegFilterPath(filePath: string): string {
  return filePath
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

async function ensureBrandingBadgePng(): Promise<string | null> {
  ensureDirs();
  if (fs.existsSync(BRAND_BADGE_PATH) && fs.statSync(BRAND_BADGE_PATH).size > 800) {
    return BRAND_BADGE_PATH;
  }

  const badgeAssPath = path.join(DATA_DIR, 'gta6hub_badge_v2.ass');
  const ass = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 410',
    'PlayResY: 84',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Dark glassmorphic pill with crisp frosted white rim & drop shadow
    'Style: PillShadow,Liberation Sans,10,&H90000000,&H00000000,&H90000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1',
    'Style: Pill,Liberation Sans,10,&H440A0D16,&H00000000,&H55FFFFFF,&H00000000,0,0,0,0,100,100,0,0,1,2.2,0,7,0,0,0,1',
    // Signature crisp YouTube red rounded icon + pure white play triangle
    'Style: RedBox,Liberation Sans,10,&H000000FF,&H00000000,&H000000FF,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1',
    'Style: PlayTri,Liberation Sans,10,&H00FFFFFF,&H00000000,&H00FFFFFF,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1',
    // Bold crisp GTA6HUB wordmark with strong dark edge for high contrast on bright or dark video
    'Style: BrandText,Liberation Sans,36,&H00FFFFFF,&H00000000,&H00000000,&HA0000000,-1,0,0,0,100,100,2,0,1,2.6,1.8,4,0,0,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:00.00,0:00:05.00,PillShadow,,0,0,0,,{\\pos(8,10)\\p1}m 18 0 l 376 0 b 388 0 396 8 396 20 l 396 52 b 396 64 388 72 376 72 l 18 72 b 6 72 0 64 0 52 l 0 20 b 0 8 6 0 18 0{\\p0}',
    'Dialogue: 1,0:00:00.00,0:00:05.00,Pill,,0,0,0,,{\\pos(6,6)\\p1}m 18 0 l 376 0 b 388 0 396 8 396 20 l 396 52 b 396 64 388 72 376 72 l 18 72 b 6 72 0 64 0 52 l 0 20 b 0 8 6 0 18 0{\\p0}',
    'Dialogue: 2,0:00:00.00,0:00:05.00,RedBox,,0,0,0,,{\\pos(20,18)\\p1}m 11 0 l 67 0 b 74 0 78 4 78 11 l 78 37 b 78 44 74 48 67 48 l 11 48 b 4 48 0 44 0 37 l 0 11 b 0 4 4 0 11 0{\\p0}',
    'Dialogue: 3,0:00:00.00,0:00:05.00,PlayTri,,0,0,0,,{\\pos(51,31)\\p1}m 0 0 l 22 11 l 0 22{\\p0}',
    'Dialogue: 4,0:00:00.00,0:00:05.00,BrandText,,0,0,0,,{\\pos(114,42)}GTA6HUB',
  ].join('\n');

  try {
    fs.writeFileSync(badgeAssPath, ass, 'utf-8');
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=black@0.0:s=410x84,format=rgba',
        '-vf',
        `ass='${escapeFfmpegFilterPath(badgeAssPath)}'`,
        '-frames:v',
        '1',
        BRAND_BADGE_PATH,
      ],
      { timeout: 15000 }
    );
    return fs.existsSync(BRAND_BADGE_PATH) ? BRAND_BADGE_PATH : null;
  } catch {
    return null;
  }
}

function getOverlayCoordsForSpot(
  spot: ResolvedWatermarkSpot,
  isLandscape: boolean
): string {
  if (isLandscape) {
    switch (spot) {
      case 'top-left':
        return '38:34';
      case 'top-right':
        return 'W-w-38:34';
      case 'bottom-left':
        return '38:H-h-34';
      case 'bottom-right':
        return 'W-w-38:H-h-34';
    }
  }
  // 9:16 portrait leaves clearance for top camera bar and bottom captions/YouTube Shorts UI
  switch (spot) {
    case 'top-left':
      return '32:58';
    case 'top-right':
      return 'W-w-32:58';
    case 'bottom-left':
      return '32:H-h-145';
    case 'bottom-right':
      return 'W-w-32:H-h-145';
  }
}

async function scoreCornerDensityFromVideo(
  videoPath: string,
  sampleSeekSeconds: number[],
  aspectMode: VideoAspectMode
): Promise<{ spot: ResolvedWatermarkSpot; scores: Record<ResolvedWatermarkSpot, number> }> {
  const isLandscape = aspectMode === 'landscape';
  const w = isLandscape ? 160 : 90;
  const h = isLandscape ? 90 : 160;
  const frameSize = w * h;

  const totals: Record<ResolvedWatermarkSpot, number> = {
    'top-left': 0,
    'top-right': 0,
    'bottom-left': 0,
    'bottom-right': 0,
  };

  let sampledFrames = 0;

  for (const seekS of sampleSeekSeconds) {
    try {
      const { stdout } = await execFileAsync(
        'ffmpeg',
        [
          '-ss',
          seekS.toFixed(2),
          '-i',
          videoPath,
          '-vframes',
          '1',
          '-vf',
          isLandscape
            ? `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,format=gray`
            : `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},format=gray`,
          '-f',
          'rawvideo',
          '-pix_fmt',
          'gray',
          'pipe:1',
        ],
        { encoding: 'buffer', timeout: 8000, maxBuffer: 512 * 1024 }
      );

      if (!Buffer.isBuffer(stdout) || stdout.length < frameSize) continue;

      const boxW = Math.floor(w * 0.34);
      const boxH = Math.floor(h * 0.22);
      const topY = isLandscape ? 2 : Math.floor(h * 0.04);
      const botY = isLandscape ? h - boxH - 2 : Math.floor(h * 0.72);

      const regions: Array<{ spot: ResolvedWatermarkSpot; x0: number; y0: number }> = [
        { spot: 'top-left', x0: 2, y0: topY },
        { spot: 'top-right', x0: w - boxW - 2, y0: topY },
        { spot: 'bottom-left', x0: 2, y0: botY },
        { spot: 'bottom-right', x0: w - boxW - 2, y0: botY },
      ];

      for (const r of regions) {
        let edgeSum = 0;
        let count = 0;
        for (let y = r.y0; y < r.y0 + boxH - 1; y += 1) {
          for (let x = r.x0; x < r.x0 + boxW - 1; x += 1) {
            const idx = y * w + x;
            const gx = Math.abs(stdout[idx + 1] - stdout[idx]);
            const gy = Math.abs(stdout[idx + w] - stdout[idx]);
            edgeSum += gx + gy;
            count += 1;
          }
        }
        totals[r.spot] += count > 0 ? edgeSum / count : 100;
      }
      sampledFrames += 1;
    } catch {
      // Skip unreadable seek sample
    }
  }

  if (sampledFrames === 0) {
    return { spot: 'top-right', scores: totals };
  }

  // Slight tie-breaker bias favoring top corners over bottom gaming HUD/minimap/subtitle areas
  const weighted: Record<ResolvedWatermarkSpot, number> = {
    'top-left': totals['top-left'] / sampledFrames,
    'top-right': totals['top-right'] / sampledFrames + 0.5,
    'bottom-left': totals['bottom-left'] / sampledFrames + 2.5,
    'bottom-right': totals['bottom-right'] / sampledFrames + 1.8,
  };

  let bestSpot: ResolvedWatermarkSpot = 'top-right';
  let lowestEnergy = Infinity;
  for (const spot of ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const) {
    if (weighted[spot] < lowestEnergy) {
      lowestEnergy = weighted[spot];
      bestSpot = spot;
    }
  }

  return { spot: bestSpot, scores: weighted };
}

async function resolveSmartWatermarkSpot(params: {
  chunkPath: string;
  startSeconds: number;
  endSeconds: number;
  aspectMode: VideoAspectMode;
  requestedPosition: WatermarkPosition;
  hasSubtitles: boolean;
}): Promise<{ spot: ResolvedWatermarkSpot; reason: string }> {
  if (params.requestedPosition !== 'auto') {
    return {
      spot: params.requestedPosition,
      reason: `Manual position override (${params.requestedPosition})`,
    };
  }

  const duration = Math.max(4, params.endSeconds - params.startSeconds);
  const sampleSeeks = [0.15, 0.4, 0.65, 0.86].map(
    (ratio) => params.startSeconds + duration * ratio
  );

  const contactSheetPath = path.join(
    DATA_DIR,
    `smartspot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.jpg`
  );

  // Build 2x2 contact sheet across the clip for Gemini Vision + run deterministic FFmpeg edge density
  const [densityResult, sheetBuffer] = await Promise.all([
    scoreCornerDensityFromVideo(params.chunkPath, sampleSeeks, params.aspectMode),
    (async (): Promise<Buffer | null> => {
      try {
        const isLandscape = params.aspectMode === 'landscape';
        const tileW = isLandscape ? 320 : 180;
        const tileH = isLandscape ? 180 : 320;
        const scaleExpr = isLandscape
          ? `scale=${tileW}:${tileH}:force_original_aspect_ratio=decrease,pad=${tileW}:${tileH}:(ow-iw)/2:(oh-ih)/2`
          : `scale=${tileW}:${tileH}:force_original_aspect_ratio=increase,crop=${tileW}:${tileH}`;

        await execFileAsync(
          'ffmpeg',
          [
            '-y',
            '-ss',
            sampleSeeks[0].toFixed(2),
            '-i',
            params.chunkPath,
            '-ss',
            sampleSeeks[1].toFixed(2),
            '-i',
            params.chunkPath,
            '-ss',
            sampleSeeks[2].toFixed(2),
            '-i',
            params.chunkPath,
            '-ss',
            sampleSeeks[3].toFixed(2),
            '-i',
            params.chunkPath,
            '-filter_complex',
            `[0:v]${scaleExpr}[a];[1:v]${scaleExpr}[b];[2:v]${scaleExpr}[c];[3:v]${scaleExpr}[d];` +
              `[a][b][c][d]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[grid]`,
            '-map',
            '[grid]',
            '-frames:v',
            '1',
            '-q:v',
            '4',
            contactSheetPath,
          ],
          { timeout: 12_000 }
        );

        if (fs.existsSync(contactSheetPath)) {
          return fs.readFileSync(contactSheetPath);
        }
      } catch {
        // Fallback smoothly to FFmpeg density scores
      } finally {
        if (fs.existsSync(contactSheetPath)) {
          try {
            fs.unlinkSync(contactSheetPath);
          } catch {
            // Ignore cleanup failure
          }
        }
      }
      return null;
    })(),
  ]);

  if (sheetBuffer && sheetBuffer.length > 0) {
    const visionDecision = await detectBestWatermarkCornerWithGemini({
      contactSheetJpeg: sheetBuffer,
      aspectMode: params.aspectMode,
      hasSubtitles: params.hasSubtitles,
    });
    if (visionDecision) {
      return {
        spot: visionDecision.corner,
        reason: `AI Vision Smart-Spot: ${visionDecision.reason}`,
      };
    }
  }

  return {
    spot: densityResult.spot,
    reason: `FFmpeg edge-density Smart-Spot picked cleanest zone (${densityResult.spot})`,
  };
}

function getAssColorsForTheme(theme: ThumbnailAccentTheme): {
  line1Color: string; // &HBBGGRR
  line2Color: string;
  accentHex: string;
} {
  switch (theme) {
    case 'red_yellow':
      return { line1Color: '&H0000EAFF', line2Color: '&H002E2EFF', accentHex: '#FF2E2E' };
    case 'cyan_white':
      return { line1Color: '&H00FFF000', line2Color: '&H00FFFFFF', accentHex: '#00E5FF' };
    case 'orange_white':
      return { line1Color: '&H000095FF', line2Color: '&H00FFFFFF', accentHex: '#FF8A00' };
    case 'yellow_white':
    default:
      return { line1Color: '&H0000D8FF', line2Color: '&H00FFFFFF', accentHex: '#FFD800' };
  }
}

function splitHookIntoLines(hookText: string): [string, string | null] {
  const words = hookText.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return [words[0] || 'NO WAY!', null];
  if (words.length === 2) return [words[0], words[1]];
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
}

function getAssAlignmentForPlacement(
  placement: ThumbnailTextPlacement,
  width: number,
  height: number
): { alignment: number; marginV: number; marginH: number } {
  const isPortrait = height > width;
  const topV = isPortrait ? 185 : 54;
  const botV = isPortrait ? 195 : 46;
  const sideH = isPortrait ? 56 : 52;

  switch (placement) {
    case 'top-left':
      return { alignment: 7, marginV: topV, marginH: sideH };
    case 'top-center':
      return { alignment: 8, marginV: topV, marginH: sideH };
    case 'top-right':
      return { alignment: 9, marginV: topV, marginH: sideH };
    case 'bottom-right':
      return { alignment: 3, marginV: botV, marginH: sideH };
    case 'bottom-center':
      return { alignment: 2, marginV: botV, marginH: sideH };
    case 'bottom-left':
    default:
      return { alignment: 1, marginV: botV, marginH: sideH };
  }
}

async function generateThumbnailImage(params: {
  sourceVideoPath: string;
  sourceSeekSeconds: number;
  thumbOutput: string;
  durationSeconds: number;
  formatMode: ClipFormatMode;
  aspectMode: VideoAspectMode;
  brandingEnabled: boolean;
  badgePath: string | null;
  thumbnailHook?: string;
  category: string;
  viralReason: string;
  title: string;
  onLog?: (level: 'info' | 'warn' | 'success', msg: string) => void;
}): Promise<{
  thumbnailHookText: string;
  searchInsights: string;
  sources: ThumbnailSourceLink[];
  accentTheme: ThumbnailAccentTheme;
  timestampUsed: number;
}> {
  const isLandscape = params.aspectMode === 'landscape';
  const outW = isLandscape ? 1280 : 1080;
  const outH = isLandscape ? 720 : 1920;

  const clampedSeek = Math.max(
    0.4,
    Math.min(
      Math.max(0.5, params.durationSeconds - 0.5),
      Number.isFinite(params.sourceSeekSeconds) && params.sourceSeekSeconds > 0
        ? params.sourceSeekSeconds
        : params.durationSeconds * 0.28
    )
  );

  const candidateFramePath = `${params.thumbOutput}.raw_${Date.now()}.jpg`;
  const thumbAssPath = `${params.thumbOutput}.ass`;
  let frameBuffer: Buffer | undefined;

  // Step 1: Extract crisp peak frame scaled to target aspect ratio
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-ss',
        clampedSeek.toFixed(2),
        '-i',
        params.sourceVideoPath,
        '-vf',
        isLandscape
          ? `scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH}`
          : `scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH}`,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        candidateFramePath,
      ],
      { timeout: 15_000 }
    );
    if (fs.existsSync(candidateFramePath)) {
      frameBuffer = fs.readFileSync(candidateFramePath);
    }
  } catch {
    // Non-fatal; fallback below still generates thumbnail
  }

  // Step 2: Google Search-grounded viral thumbnail design (hook text, placement, contrast palette)
  const design = await designSearchGroundedThumbnail({
    title: params.title,
    category: params.category,
    viralReason: params.viralReason,
    formatMode: params.formatMode,
    aspectMode: params.aspectMode,
    existingHook: params.thumbnailHook,
    frameJpegBuffer: frameBuffer,
    onLog: params.onLog,
  });

  // Step 3: Render high-CTR graded composite thumbnail via FFmpeg
  const colors = getAssColorsForTheme(design.accentTheme);
  const [line1, line2] = splitHookIntoLines(design.thumbnailHookText);
  const pos = getAssAlignmentForPlacement(design.textPlacement, outW, outH);
  const isTopPlacement = design.textPlacement.startsWith('top-');
  const mainFontSize = isLandscape ? (line2 ? 98 : 112) : line2 ? 104 : 118;

  const esc = (s: string) => s.replace(/\{/g, '(').replace(/\}/g, ')');
  const textPayload = line2
    ? `{\\c${colors.line1Color}}${esc(line1)}\\N{\\c${colors.line2Color}}${esc(line2)}`
    : `{\\c${colors.line1Color}}${esc(line1)}`;

  // Put micro-badge & GTA6HUB badge in opposite vertical corners so text & badge never collide
  const badgeAlign = isTopPlacement ? 3 : 9;
  const microBadgeAlign = isTopPlacement ? 1 : 7;

  const scrimY = isTopPlacement ? 0 : Math.floor(outH * 0.62);
  const scrimH = Math.ceil(outH * 0.38);

  const hookFontName = containsBengali(design.thumbnailHookText)
    ? 'Noto Sans Bengali'
    : 'Liberation Sans';
  const microBadgeFontName = containsBengali(design.microBadge)
    ? 'Noto Sans Bengali'
    : 'Liberation Sans';

  const ass = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${outW}`,
    `PlayResY: ${outH}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Scrim,Liberation Sans,10,&H72000000,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1',
    `Style: HookText,${hookFontName},${mainFontSize},${colors.line1Color},&H00FFFFFF,&H00000000,&HD8000000,-1,0,0,0,104,100,2,0,1,9,5,${pos.alignment},${pos.marginH},${pos.marginH},${pos.marginV},1`,
    `Style: MicroBadge,${microBadgeFontName},${isLandscape ? 32 : 36},&H00FFFFFF,&H00000000,&H00000000,&HC00000FF,-1,0,0,0,100,100,2,0,3,8,2,${microBadgeAlign},${pos.marginH},${pos.marginH},${isLandscape ? 34 : 52},1`,
    `Style: CornerTag,Liberation Sans,${isLandscape ? 26 : 30},&H00E5E7EB,&H00000000,&H00000000,&H99000000,-1,0,0,0,100,100,1,0,1,4,2,${badgeAlign},${pos.marginH},${pos.marginH},${isLandscape ? 32 : 52},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    `Dialogue: 0,0:00:00.00,0:00:05.00,Scrim,,0,0,0,,{\\pos(0,${scrimY})\\p1}m 0 0 l ${outW} 0 l ${outW} ${scrimH} l 0 ${scrimH}{\\p0}`,
    `Dialogue: 1,0:00:00.00,0:00:05.00,MicroBadge,,0,0,0,, ${esc(design.microBadge)} `,
    `Dialogue: 2,0:00:00.00,0:00:05.00,HookText,,0,0,0,,${textPayload}`,
    !params.brandingEnabled
      ? `Dialogue: 2,0:00:00.00,0:00:05.00,CornerTag,,0,0,0,,${
          params.formatMode === 'long' ? 'HD 60FPS' : '#SHORTS'
        }`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    fs.writeFileSync(thumbAssPath, ass, 'utf-8');
    const baseInput = fs.existsSync(candidateFramePath)
      ? candidateFramePath
      : params.sourceVideoPath;
    const args: string[] = ['-y'];
    if (baseInput === params.sourceVideoPath) {
      args.push('-ss', clampedSeek.toFixed(2));
    }
    args.push('-i', baseInput);

    const hasBadge = Boolean(params.brandingEnabled && params.badgePath && fs.existsSync(params.badgePath));
    if (hasBadge && params.badgePath) {
      args.push('-i', params.badgePath);
    }

    const gradeChain =
      `[0:v]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},` +
      `eq=contrast=1.18:saturation=1.34:brightness=0.03,` +
      `unsharp=5:5:0.85:5:5:0.0,` +
      `vignette=PI/4,` +
      `drawbox=x=0:y=0:w=iw:h=ih:color=${colors.accentHex}@0.88:t=8,` +
      `ass='${escapeFfmpegFilterPath(thumbAssPath)}'[base]`;

    const badgeOverlayY = isTopPlacement ? `H-h-${isLandscape ? 32 : 52}` : `${isLandscape ? 32 : 52}`;
    const badgeOverlayX = `W-w-${isLandscape ? 36 : 36}`;
    const filter = hasBadge
      ? `${gradeChain};[1:v]scale=${isLandscape ? 300 : 320}:-1[badge];[base][badge]overlay=${badgeOverlayX}:${badgeOverlayY}[outv]`
      : `${gradeChain.replace('[base]', '[outv]')}`;

    args.push(
      '-filter_complex',
      filter,
      '-map',
      '[outv]',
      '-frames:v',
      '1',
      '-q:v',
      '2',
      params.thumbOutput
    );
    await execFileAsync('ffmpeg', args, { timeout: 20_000 });
  } catch {
    // Reliable fallback: graded frame without ASS overlay
    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-ss',
          clampedSeek.toFixed(2),
          '-i',
          params.sourceVideoPath,
          '-vf',
          `scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},eq=contrast=1.15:saturation=1.28,vignette=PI/4`,
          '-frames:v',
          '1',
          '-q:v',
          '2',
          params.thumbOutput,
        ],
        { timeout: 15_000 }
      );
    } catch {
      // Optional thumbnail
    }
  } finally {
    for (const tmp of [candidateFramePath, thumbAssPath]) {
      if (fs.existsSync(tmp)) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // Ignore cleanup
        }
      }
    }
  }

  return {
    thumbnailHookText: design.thumbnailHookText,
    searchInsights: design.searchInsights,
    sources: design.sources,
    accentTheme: design.accentTheme,
    timestampUsed: Number(clampedSeek.toFixed(1)),
  };
}

async function createLightweightAnalysisProxy(
  sourceChunkPath: string,
  proxyPath: string
): Promise<boolean> {
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-i',
        sourceChunkPath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-vf',
        "fps=2,scale='if(gt(iw,ih),-2,360)':'if(gt(iw,ih),360,-2)'",
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '32',
        '-maxrate',
        '140k',
        '-bufsize',
        '280k',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '32k',
        '-ac',
        '1',
        '-ar',
        '22050',
        '-movflags',
        '+faststart',
        proxyPath,
      ],
      { timeout: 120_000 }
    );
    return fs.existsSync(proxyPath) && fs.statSync(proxyPath).size > 0;
  } catch {
    if (fs.existsSync(proxyPath)) {
      try {
        fs.unlinkSync(proxyPath);
      } catch {
        // Ignore cleanup error
      }
    }
    return false;
  }
}

async function detectFallbackMomentsWithFfmpeg(
  videoPath: string,
  durationSeconds: number,
  formatMode: ClipFormatMode,
  reqCtx: ParsedRequirementContext,
  options?: {
    videoTitleHint?: string;
    recentTitles?: string[];
    onLog?: (level: 'info' | 'warn' | 'success', message: string) => void;
  }
): Promise<ChunkAnalysisResult> {
  const safeTotal = Math.max(MIN_SHORT_SECONDS, Math.floor(durationSeconds));
  const peakTimestamps: number[] = [];

  try {
    const result = await execFileAsync(
      'ffmpeg',
      [
        '-i',
        videoPath,
        '-vf',
        "select='gt(scene,0.28)',showinfo",
        '-af',
        'silencedetect=n=-30dB:d=0.8',
        '-f',
        'null',
        '-',
      ],
      { timeout: 25_000, maxBuffer: 4 * 1024 * 1024 }
    ).catch((err: { stderr?: string }) => ({ stderr: err?.stderr || '' }));

    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    const sceneMatches = stderr.matchAll(/pts_time:(\d+(?:\.\d+)?)/g);
    for (const m of sceneMatches) {
      const t = Math.round(Number(m[1]));
      if (Number.isFinite(t) && t >= 4 && t <= safeTotal - 10) {
        peakTimestamps.push(t);
      }
    }
    const burstMatches = stderr.matchAll(/silence_end:\s*(\d+(?:\.\d+)?)/g);
    for (const m of burstMatches) {
      const t = Math.round(Number(m[1]));
      if (Number.isFinite(t) && t >= 4 && t <= safeTotal - 10) {
        peakTimestamps.push(t);
      }
    }
  } catch {
    // Non-fatal; midpoint fallback below still succeeds
  }

  const isLong = formatMode === 'long';
  const targetLen = isLong
    ? Math.min(safeTotal, Math.max(MIN_LONG_SECONDS, Math.min(240, safeTotal)))
    : Math.min(safeTotal, 42);

  let anchor = Math.max(0, Math.floor((safeTotal - targetLen) / 2));
  if (peakTimestamps.length > 0) {
    peakTimestamps.sort((a, b) => a - b);
    const midPeak = peakTimestamps[Math.floor(peakTimestamps.length / 2)];
    anchor = Math.max(0, Math.min(safeTotal - targetLen, midPeak - Math.floor(targetLen * 0.25)));
  }

  const startS = anchor;
  const endS = Math.min(safeTotal, startS + targetLen);
  const cleanVideoTitle = stripUrlsFromText(options?.videoTitleHint || '');
  const cleanIdea = stripUrlsFromText(reqCtx.spec.topicIdea || '');
  const topicLabel =
    cleanVideoTitle.slice(0, 42).trim() ||
    reqCtx.spec.lockedCategories[0] ||
    cleanIdea.slice(0, 36).trim() ||
    (reqCtx.isGtaContext ? 'GTA 6' : 'Gameplay');

  const hashtags = sanitizeHashtags([], {
    isGtaContext: reqCtx.isGtaContext,
    formatMode,
    lockedCategories: reqCtx.spec.lockedCategories,
    topicKeywords: reqCtx.topicKeywords,
    momentCategory: 'highlight',
    sceneText: `${topicLabel} ${cleanVideoTitle}`,
  });
  const tags = sanitizeSeoTags([], {
    isGtaContext: reqCtx.isGtaContext,
    formatMode,
    lockedCategories: reqCtx.spec.lockedCategories,
    topicKeywords: reqCtx.topicKeywords,
  });
  const summary =
    peakTimestamps.length > 0
      ? `${topicLabel}: sudden intensity spike caught between ${startS}s and ${endS}s.`
      : `${topicLabel}: standout sequence captured between ${startS}s and ${endS}s.`;

  const draftMoment: DetectedMoment = {
    category: 'highlight',
    start_seconds: startS,
    end_seconds: endS,
    moment_summary: summary,
    viral_reason: summary,
    // Intentionally concise initial cue; metadataGuard upgrades via visual keyframes or curiosity-driven unique phrasing
    title: '',
    description: '',
    thumbnail_hook: 'UNEXPECTED TURN!',
    hashtags,
    tags,
    captions: [],
  };

  const guarded = await ensureUniqueBatchClipMetadata({
    moments: [draftMoment],
    existingTitles: options?.recentTitles,
    ctx: reqCtx,
    formatMode,
    videoTitleHint: cleanVideoTitle || topicLabel,
    chunkPath: videoPath,
    onLog: options?.onLog,
  });

  return { moments: guarded.moments };
}

async function probeVideoDimensions(
  videoPath: string
): Promise<{ width: number; height: number } | null> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height',
        '-of',
        'json',
        videoPath,
      ],
      { timeout: 6000 }
    );
    const parsed = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }> };
    const s = parsed.streams?.[0];
    if (s?.width && s?.height) {
      return { width: s.width, height: s.height };
    }
    return null;
  } catch {
    return null;
  }
}

async function detectPortraitFacecamSplitFilter(params: {
  chunkPath: string;
  startSeconds: number;
  endSeconds: number;
  onLog?: (level: 'info' | 'warn' | 'success', msg: string) => void;
}): Promise<string | null> {
  const dims = await probeVideoDimensions(params.chunkPath);
  if (!dims || dims.width <= dims.height) {
    return null;
  }

  const seekSec =
    params.startSeconds + Math.max(1, (params.endSeconds - params.startSeconds) * 0.35);
  const framePath = path.join(
    DATA_DIR,
    `facecam_probe_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.jpg`
  );

  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-ss',
        seekSec.toFixed(2),
        '-i',
        params.chunkPath,
        '-frames:v',
        '1',
        '-vf',
        'scale=960:-2',
        '-q:v',
        '4',
        framePath,
      ],
      { timeout: 10_000 }
    );
    if (!fs.existsSync(framePath)) return null;
    const frameBuf = fs.readFileSync(framePath);
    const facecam = await detectFacecamRegionWithGemini(frameBuf);
    if (!facecam?.hasFacecam) {
      return null;
    }

    const cw = Math.max(64, Math.floor((dims.width * facecam.wPct) / 2) * 2);
    const ch = Math.max(64, Math.floor((dims.height * facecam.hPct) / 2) * 2);
    const cx = Math.max(0, Math.min(dims.width - cw, Math.floor((dims.width * facecam.xPct) / 2) * 2));
    const cy = Math.max(0, Math.min(dims.height - ch, Math.floor((dims.height * facecam.yPct) / 2) * 2));

    params.onLog?.(
      'success',
      `9:16 Split-Screen active: Top 1080x960 full uncropped gameplay + Bottom 1080x960 facecam (${facecam.reason}).`
    );

    return (
      `[0:v]split=2[gp_in][fc_in];` +
      `[gp_in]scale=1080:960:force_original_aspect_ratio=decrease,pad=1080:960:(ow-iw)/2:(oh-ih)/2:black,eq=contrast=1.04:saturation=1.08,setsar=1,format=yuv420p[gameplay_top];` +
      `[fc_in]crop=${cw}:${ch}:${cx}:${cy},scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,drawbox=x=0:y=0:w=iw:h=4:color=white@0.28:t=fill,setsar=1,format=yuv420p[facecam_bot];` +
      `[gameplay_top][facecam_bot]vstack=inputs=2,setsar=1,format=yuv420p[base]`
    );
  } catch {
    return null;
  } finally {
    if (fs.existsSync(framePath)) {
      try {
        fs.unlinkSync(framePath);
      } catch {
        // Ignore cleanup
      }
    }
  }
}

async function renderClipWithBrandingAndCaptions(params: {
  chunkPath: string;
  clipOutput: string;
  thumbOutput: string;
  assPath: string;
  srtPath: string;
  captions: CaptionCue[];
  startSeconds: number;
  endSeconds: number;
  formatMode: ClipFormatMode;
  aspectMode: VideoAspectMode;
  brandingEnabled: boolean;
  watermarkPosition: WatermarkPosition;
  thumbnailHook?: string;
  thumbnailTimestamp?: number;
  category: string;
  viralReason: string;
  title: string;
  onLog?: (level: 'info' | 'warn' | 'success', msg: string) => void;
}): Promise<{
  detectedWatermarkSpot?: ResolvedWatermarkSpot;
  thumbnailMeta: {
    thumbnailHookText: string;
    searchInsights: string;
    sources: ThumbnailSourceLink[];
    accentTheme: ThumbnailAccentTheme;
    timestampUsed: number;
  };
}> {
  const duration = Math.max(3, params.endSeconds - params.startSeconds);
  const isLandscape = params.formatMode === 'long' && params.aspectMode === 'landscape';
  const playResX = isLandscape ? 1920 : 1080;
  const playResY = isLandscape ? 1080 : 1920;

  const facecamSplitFilter = !isLandscape
    ? await detectPortraitFacecamSplitFilter({
        chunkPath: params.chunkPath,
        startSeconds: params.startSeconds,
        endSeconds: params.endSeconds,
        onLog: params.onLog,
      })
    : null;

  const hasSubs = writeSubtitleFiles(
    params.captions,
    duration,
    params.srtPath,
    params.assPath,
    playResX,
    playResY,
    Boolean(facecamSplitFilter),
    params.viralReason || params.title
  );

  const badgePath = params.brandingEnabled ? await ensureBrandingBadgePng() : null;
  let detectedSpot: ResolvedWatermarkSpot | undefined;

  if (badgePath && params.brandingEnabled) {
    const resolved = await resolveSmartWatermarkSpot({
      chunkPath: params.chunkPath,
      startSeconds: params.startSeconds,
      endSeconds: params.endSeconds,
      aspectMode: isLandscape ? 'landscape' : 'portrait',
      requestedPosition: params.watermarkPosition,
      hasSubtitles: hasSubs,
    });
    detectedSpot = resolved.spot;
    params.onLog?.(
      'info',
      `GTA6HUB watermark placed at ${resolved.spot.toUpperCase()} (${resolved.reason}).`
    );
  }

  const baseFilter = isLandscape
    ? '[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=#05070B,eq=contrast=1.04:saturation=1.08[base]'
    : facecamSplitFilter ||
      '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(iw-1080)/2:(ih-1920)/2,eq=contrast=1.04:saturation=1.08,setsar=1[base]';

  const overlayCoords = getOverlayCoordsForSpot(detectedSpot ?? 'top-right', isLandscape);
  const badgeOverlay =
    badgePath && params.brandingEnabled
      ? `;[1:v]scale=${isLandscape ? 320 : 300}:-1[badge];[base][badge]overlay=${overlayCoords}[branded]`
      : '';

  const brandedLabel = badgePath && params.brandingEnabled ? '[branded]' : '[base]';

  const assValid = hasSubs && validateAssSubtitleFile(params.assPath).valid;

  const filterWithSubs = assValid
    ? `${baseFilter}${badgeOverlay};${brandedLabel}${buildAssFilterExpression(params.assPath)}[outv]`
    : `${baseFilter}${badgeOverlay};${brandedLabel}null[outv]`;

  const filterWithoutSubs = `${baseFilter}${badgeOverlay};${brandedLabel}null[outv]`;

  const tmpClipOutput = `${params.clipOutput}.tmp.mp4`;
  const timeoutMs = params.formatMode === 'long' ? 900_000 : 360_000;

  const runFfmpeg = async (filterComplex: string) => {
    try {
      const inputArgs = [
        '-y',
        '-ss',
        String(params.startSeconds),
        '-to',
        String(params.endSeconds),
        '-i',
        params.chunkPath,
      ];
      if (badgePath && params.brandingEnabled) {
        inputArgs.push('-i', badgePath);
      }

      await execFileAsync(
        'ffmpeg',
        [
          ...inputArgs,
          '-filter_complex',
          filterComplex,
          '-map',
          '[outv]',
          '-map',
          '0:a?',
          '-c:v',
          'libx264',
          '-preset',
          'superfast',
          '-crf',
          '22',
          '-r',
          '30',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-ac',
          '2',
          '-ar',
          '44100',
          '-movflags',
          '+faststart',
          '-f',
          'mp4',
          tmpClipOutput,
        ],
        { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }
      );
      fs.renameSync(tmpClipOutput, params.clipOutput);
    } catch (err) {
      if (fs.existsSync(tmpClipOutput)) {
        try {
          fs.unlinkSync(tmpClipOutput);
        } catch {
          // Ignore temp cleanup failure
        }
      }
      throw err;
    }
  };

  const pipeActId = startActionLog({
    category: 'ffmpeg_render',
    actionName: 'Stream Clip Render',
    sourceRef: params.title.slice(0, 48),
    summary: `Rendering ${isLandscape ? '16:9' : '9:16'} stream clip${assValid ? ' with ASS captions' : ''}...`,
  });

  try {
    await runFfmpeg(filterWithSubs);
    updateActionLog(pipeActId, {
      status: 'success',
      summary: `Rendered ${isLandscape ? '16:9' : '9:16'} stream clip cleanly.`,
    });
  } catch (err) {
    const tail = extractFfmpegStderrTail(err);
    if (assValid) {
      try {
        await runFfmpeg(filterWithoutSubs);
        updateActionLog(pipeActId, {
          status: 'success',
          summary: 'Rendered stream clip without ASS burn-in after subtitle filter fallback.',
          details: tail,
        });
      } catch (err2) {
        const tail2 = extractFfmpegStderrTail(err2);
        updateActionLog(pipeActId, {
          status: 'error',
          summary: 'Stream clip FFmpeg render failed.',
          details: `${tail}\n\n[Fallback Failed]\n${tail2}`,
        });
        throw new Error(`Stream FFmpeg render failed:\n${tail2}`);
      }
    } else {
      updateActionLog(pipeActId, {
        status: 'error',
        summary: 'Stream clip FFmpeg render failed.',
        details: tail,
      });
      throw new Error(`Stream FFmpeg render failed:\n${tail}`);
    }
  }

  const clipSeek =
    typeof params.thumbnailTimestamp === 'number' && Number.isFinite(params.thumbnailTimestamp)
      ? Math.max(0.4, Math.min(duration - 0.4, params.thumbnailTimestamp))
      : duration * 0.28;

  const thumbnailMeta = await generateThumbnailImage({
    sourceVideoPath: params.chunkPath,
    sourceSeekSeconds: params.startSeconds + clipSeek,
    thumbOutput: params.thumbOutput,
    durationSeconds: duration,
    formatMode: params.formatMode,
    aspectMode: isLandscape ? 'landscape' : 'portrait',
    brandingEnabled: params.brandingEnabled,
    badgePath,
    thumbnailHook: params.thumbnailHook,
    category: params.category,
    viralReason: params.viralReason,
    title: params.title,
    onLog: params.onLog,
  });

  return {
    detectedWatermarkSpot: detectedSpot,
    thumbnailMeta: {
      ...thumbnailMeta,
      timestampUsed: Number(clipSeek.toFixed(1)),
    },
  };
}

function cleanupUnreferencedChunk(chunkPath?: string) {
  if (!chunkPath) return;
  if (activeAnalyzedChunks.has(chunkPath)) return;
  const stillNeeded = clipQueue.some(
    (c) =>
      c.chunkPath === chunkPath &&
      (c.status === 'queued' || c.status === 'processing')
  );
  if (!stillNeeded && fs.existsSync(chunkPath)) {
    try {
      fs.unlinkSync(chunkPath);
    } catch {
      // Ignore
    }
  }
}

async function ensureQueueWorkerRunning() {
  if (queueWorkerRunning) return;
  queueWorkerRunning = true;

  try {
    while (true) {
      const nextJob = clipQueue.find((c) => c.status === 'queued');
      if (!nextJob) break;

      activeProcessingClipId = nextJob.id;
      nextJob.status = 'processing';
      nextJob.attempts += 1;
      nextJob.errorMessage = undefined;
      saveClipsIndex();

      const streamExists = workers.has(nextJob.streamId);
      const isLongJob = nextJob.formatMode === 'long';
      const aspectMode: VideoAspectMode = nextJob.aspectMode === 'landscape' ? 'landscape' : 'portrait';
      const brandingEnabled = nextJob.brandingEnabled ?? true;
      const watermarkPosition: WatermarkPosition = nextJob.watermarkPosition ?? 'auto';

      if (streamExists) {
        addStreamLog(
          nextJob.streamId,
          'info',
          `Rendering ${isLongJob ? 'Long-Form YouTube Video' : '9:16 Short'} "${nextJob.title}" (${aspectMode}, GTA6HUB watermark ${
            brandingEnabled ? watermarkPosition : 'OFF'
          }, attempt ${nextJob.attempts}/${nextJob.maxAttempts})...`
        );
      }

      try {
        if (!nextJob.chunkPath || !fs.existsSync(nextJob.chunkPath)) {
          throw new Error('Source video segment is no longer available on disk.');
        }

        const clipDir = path.join(STREAMS_DIR, nextJob.streamId, 'clips');
        fs.mkdirSync(clipDir, { recursive: true });

        const clipFilename = `${nextJob.id}.mp4`;
        const thumbFilename = `${nextJob.id}.jpg`;
        const srtFilename = `${nextJob.id}.srt`;
        const assFilename = `${nextJob.id}.ass`;

        const clipOutput = path.join(clipDir, clipFilename);
        const thumbOutput = path.join(clipDir, thumbFilename);
        const srtOutput = path.join(clipDir, srtFilename);
        const assOutput = path.join(clipDir, assFilename);

        const renderOutcome = await renderClipWithBrandingAndCaptions({
          chunkPath: nextJob.chunkPath,
          clipOutput,
          thumbOutput,
          assPath: assOutput,
          srtPath: srtOutput,
          captions: nextJob.captions,
          startSeconds: nextJob.startSeconds,
          endSeconds: nextJob.endSeconds,
          formatMode: nextJob.formatMode,
          aspectMode,
          brandingEnabled,
          watermarkPosition,
          thumbnailHook: nextJob.thumbnailHook,
          thumbnailTimestamp: nextJob.thumbnailTimestamp,
          category: nextJob.category,
          viralReason: nextJob.viralReason,
          title: nextJob.title,
          onLog: streamExists ? (lvl, msg) => addStreamLog(nextJob.streamId, lvl, msg) : undefined,
        });

        const clipSize = fs.existsSync(clipOutput) ? fs.statSync(clipOutput).size : 0;
        const hasThumb = fs.existsSync(thumbOutput);
        const hasSrt = fs.existsSync(srtOutput);
        const updatedAt = new Date().toISOString();

        nextJob.status = 'completed';
        nextJob.detectedWatermarkSpot = renderOutcome.detectedWatermarkSpot;
        nextJob.thumbnailHook = renderOutcome.thumbnailMeta.thumbnailHookText;
        nextJob.thumbnailTimestamp = renderOutcome.thumbnailMeta.timestampUsed;
        nextJob.thumbnailSearchInsights = renderOutcome.thumbnailMeta.searchInsights;
        nextJob.thumbnailSearchSources = renderOutcome.thumbnailMeta.sources;
        nextJob.thumbnailAccent = renderOutcome.thumbnailMeta.accentTheme;
        nextJob.thumbnailUpdatedAt = updatedAt;

        nextJob.videoUrl = `/api/media/clips/${nextJob.streamId}/${clipFilename}`;
        nextJob.thumbnailUrl = hasThumb
          ? `/api/media/clips/${nextJob.streamId}/${thumbFilename}?v=${Date.now()}`
          : undefined;
        nextJob.srtUrl = hasSrt
          ? `/api/media/clips/${nextJob.streamId}/${srtFilename}`
          : undefined;
        nextJob.fileSizeBytes = clipSize;
        nextJob.completedAt = updatedAt;

        const ytSettings = getYouTubeSettings();
        if (
          ytSettings.autoUploadEnabled &&
          ytSettings.connected &&
          (!nextJob.youtubeUploadStatus || nextJob.youtubeUploadStatus === 'not_uploaded')
        ) {
          nextJob.youtubeUploadStatus = 'queued_upload';
          nextJob.youtubeUploadError = undefined;
        } else if (!nextJob.youtubeUploadStatus) {
          nextJob.youtubeUploadStatus = 'not_uploaded';
        }

        const zernioSettings = getZernioSettings();
        const eligibleZernioAccounts = zernioSettings.accounts.filter(
          (acc) =>
            acc.isActive &&
            acc.selectedForUpload &&
            (nextJob.aspectMode !== 'landscape' || acc.platform.toLowerCase() !== 'tiktok')
        );
        if (
          zernioSettings.autoUploadEnabled &&
          zernioSettings.connected &&
          eligibleZernioAccounts.length > 0 &&
          (!nextJob.zernioPublishStatus || nextJob.zernioPublishStatus === 'not_published')
        ) {
          nextJob.zernioPublishStatus = 'pending';
          nextJob.zernioPublishError = undefined;
        } else if (!nextJob.zernioPublishStatus) {
          nextJob.zernioPublishStatus = 'not_published';
        }

        saveClipsIndex();

        if (streamExists) {
          addStreamLog(
            nextJob.streamId,
            'success',
            `Completed ${isLongJob ? 'Long-Form Video' : 'Short'} "${nextJob.title}" (${(clipSize / (1024 * 1024)).toFixed(1)} MB${
              nextJob.youtubeUploadStatus === 'queued_upload'
                ? ' · queued for YouTube auto-upload'
                : ''
            }${
              nextJob.zernioPublishStatus === 'pending'
                ? ` · pending Zernio auto-upload (${eligibleZernioAccounts.length} account${eligibleZernioAccounts.length > 1 ? 's' : ''})`
                : ''
            }).`
          );
        }

        if (nextJob.youtubeUploadStatus === 'queued_upload') {
          void ensureYouTubeUploadWorkerRunning();
        }
        if (nextJob.zernioPublishStatus === 'pending') {
          void ensureZernioPublishWorkerRunning();
        }

        const tpSettings = getThirdPartyExportSettings();
        if (
          tpSettings.autoSendOnComplete &&
          tpSettings.webhookConfigured &&
          nextJob.aspectMode !== 'landscape'
        ) {
          void sendClipToThirdPartyExport(nextJob.id).catch(() => {
            // error recorded on clip record
          });
        }

        cleanupUnreferencedChunk(nextJob.chunkPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          nextJob.attempts < nextJob.maxAttempts &&
          nextJob.chunkPath &&
          fs.existsSync(nextJob.chunkPath)
        ) {
          nextJob.status = 'queued';
          nextJob.errorMessage = `Temporary error, retrying: ${msg}`;
          saveClipsIndex();
          if (streamExists) {
            addStreamLog(
              nextJob.streamId,
              'warn',
              `Clip render failed transiently (${msg}). Re-queued for retry.`
            );
          }
          await new Promise((r) => setTimeout(r, 1500));
        } else {
          nextJob.status = 'failed';
          nextJob.errorMessage = msg;
          saveClipsIndex();
          if (streamExists) {
            addStreamLog(
              nextJob.streamId,
              'error',
              `Clip render failed for "${nextJob.title}": ${msg}`
            );
          }
        }
      } finally {
        activeProcessingClipId = null;
      }
    }
  } finally {
    queueWorkerRunning = false;
    activeProcessingClipId = null;
  }
}

function isDuplicateMoment(
  streamId: string,
  chunkIndex: number,
  startSeconds: number,
  endSeconds: number
): boolean {
  return clipQueue.some((existing) => {
    if (existing.streamId !== streamId) return false;
    if (existing.chunkIndex !== chunkIndex) return false;

    const overlapStart = Math.max(existing.startSeconds, startSeconds);
    const overlapEnd = Math.min(existing.endSeconds, endSeconds);
    const overlap = Math.max(0, overlapEnd - overlapStart);
    const minDuration = Math.max(
      1,
      Math.min(existing.endSeconds - existing.startSeconds, endSeconds - startSeconds)
    );
    return overlap / minDuration >= 0.5;
  });
}

function normalizeCategory(raw: string): MomentCategory {
  if (
    raw === 'funny' ||
    raw === 'epic_gameplay' ||
    raw === 'highlight' ||
    raw === 'reaction' ||
    raw === 'viral'
  ) {
    return raw;
  }
  return 'highlight';
}

async function runStreamWorker(params: {
  streamId: string;
  sourceInput: string;
  sourceType: StreamSourceType;
  segmentSeconds: number;
}) {
  const { streamId, sourceInput, sourceType, segmentSeconds } = params;
  const worker = workers.get(streamId);
  if (!worker) return;

  const streamRoot = path.join(STREAMS_DIR, streamId);
  const chunkDir = path.join(streamRoot, 'chunks');
  const clipDir = path.join(streamRoot, 'clips');
  fs.mkdirSync(chunkDir, { recursive: true });
  fs.mkdirSync(clipDir, { recursive: true });

  try {
    const hasFfmpeg = await checkBinary('ffmpeg', ['-version']);
    if (!hasFfmpeg) {
      throw new Error('FFmpeg binary is missing on the server.');
    }
    if (!isGeminiConfigured()) {
      throw new Error(
        'No usable Gemini API key found. Add Gemini API keys in System Setup or set GEMINI_API_KEY in Settings > Secrets.'
      );
    }

    let ingestion: PreparedIngestion = {
      ffmpegInputArg: sourceInput,
      transcodeVideo:
        sourceType === 'upload' && !sourceInput.toLowerCase().endsWith('.mp4'),
      hasAudioTrack: true,
    };

    if (sourceType === 'url') {
      updateJob(streamId, { currentStage: 'Connecting to authorized stream feed' });
      ingestion = await prepareStreamIngestion(streamId, sourceInput);
      worker.inputStream = ingestion.inputStream;
      worker.audioStream = ingestion.audioStream;
    }

    if (worker.stopRequested) {
      ingestion.inputStream?.destroy();
      ingestion.audioStream?.destroy();
      updateJob(streamId, {
        status: 'stopped',
        endedAt: new Date().toISOString(),
        currentStage: 'Monitoring stopped',
      });
      return;
    }

    const segmentPattern = path.join(chunkDir, 'chunk_%04d.mp4');
    const hasDualStreams = Boolean(ingestion.inputStream && ingestion.audioStream);

    const inputArgs = hasDualStreams
      ? [
          '-fflags',
          '+genpts+discardcorrupt',
          '-thread_queue_size',
          '1024',
          '-i',
          'pipe:0',
          '-thread_queue_size',
          '1024',
          '-i',
          'pipe:3',
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
        ]
      : ingestion.inputStream
      ? [
          '-fflags',
          '+genpts+discardcorrupt',
          '-thread_queue_size',
          '1024',
          '-i',
          'pipe:0',
          '-map',
          '0:v:0',
          '-map',
          '0:a?',
        ]
      : ['-i', ingestion.ffmpegInputArg, '-map', '0:v:0', '-map', '0:a?'];

    const codecArgs = ingestion.transcodeVideo
      ? [
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-crf',
          '23',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-ac',
          '2',
          '-ar',
          '44100',
        ]
      : ingestion.inputStream
      ? ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '44100']
      : ['-c', 'copy'];

    const ffmpegArgs = [
      '-y',
      ...inputArgs,
      ...codecArgs,
      '-max_muxing_queue_size',
      '1024',
      '-avoid_negative_ts',
      'make_zero',
      '-f',
      'segment',
      '-segment_time',
      String(segmentSeconds),
      '-reset_timestamps',
      '1',
      segmentPattern,
    ];

    updateJob(streamId, {
      status: 'monitoring',
      currentStage:
        sourceType === 'upload'
          ? 'Segmenting uploaded video'
          : 'Monitoring live stream feed',
    });
    addStreamLog(
      streamId,
      'info',
      `FFmpeg stream ingestion started (${segmentSeconds}s segment intervals).`
    );

    let recordExited = false;
    let recordExitCode: number | null = null;
    let streamReadError: string | null = null;
    const stderrTail: string[] = [];

    const recordProc = spawn('ffmpeg', ffmpegArgs, {
      stdio: [
        ingestion.inputStream ? 'pipe' : 'ignore',
        'ignore',
        'pipe',
        hasDualStreams ? 'pipe' : 'ignore',
      ],
    });
    worker.recordProcess = recordProc;

    const cleanupPipes = () => {
      if (ingestion.inputStream && recordProc.stdin) {
        try {
          ingestion.inputStream.unpipe(recordProc.stdin);
        } catch {
          // Ignore
        }
      }
      const audioPipe = recordProc.stdio[3] as NodeJS.WritableStream | null | undefined;
      if (ingestion.audioStream && audioPipe) {
        try {
          ingestion.audioStream.unpipe(audioPipe);
        } catch {
          // Ignore
        }
      }
      ingestion.inputStream?.destroy();
      ingestion.audioStream?.destroy();
    };

    if (ingestion.inputStream && recordProc.stdin) {
      ingestion.inputStream.on('error', (err) => {
        streamReadError = err.message;
        addStreamLog(streamId, 'error', `Video stream feed error: ${err.message}`);
        if (recordProc.exitCode === null) {
          recordProc.stdin?.end();
        }
      });
      recordProc.stdin.on('error', () => {
        // Ignore EPIPE when FFmpeg exits early
      });
      ingestion.inputStream.pipe(recordProc.stdin);
    }

    const audioPipeTarget = recordProc.stdio[3] as NodeJS.WritableStream | null | undefined;
    if (ingestion.audioStream && audioPipeTarget) {
      ingestion.audioStream.on('error', (err) => {
        addStreamLog(streamId, 'warn', `Audio stream feed error: ${err.message}`);
        if (recordProc.exitCode === null) {
          audioPipeTarget.end();
        }
      });
      audioPipeTarget.on('error', () => {
        // Ignore EPIPE when FFmpeg exits early
      });
      ingestion.audioStream.pipe(audioPipeTarget);
    }

    recordProc.stderr?.on('data', (buf: Buffer) => {
      const lines = buf.toString('utf-8').split('\n').filter(Boolean);
      for (const l of lines) {
        if (isFfmpegBannerLine(l)) continue;
        const clean = sanitizeFfmpegErrorLine(l);
        if (!clean) continue;
        stderrTail.push(clean);
        if (stderrTail.length > 15) stderrTail.shift();
      }
    });

    recordProc.on('close', (code) => {
      recordExited = true;
      recordExitCode = code;
      cleanupPipes();
    });

    recordProc.on('error', (err) => {
      recordExited = true;
      cleanupPipes();
      addStreamLog(streamId, 'error', `FFmpeg spawn error: ${err.message}`);
    });

    let chunkIdx = 0;

    while (!worker.stopRequested) {
      const currentChunk = path.join(
        chunkDir,
        `chunk_${String(chunkIdx).padStart(4, '0')}.mp4`
      );
      const nextChunk = path.join(
        chunkDir,
        `chunk_${String(chunkIdx + 1).padStart(4, '0')}.mp4`
      );

      const hasCurrent = fs.existsSync(currentChunk);
      const hasNext = fs.existsSync(nextChunk);

      if (hasCurrent && (hasNext || recordExited)) {
        if (recordExited) {
          await new Promise((r) => setTimeout(r, 400));
        }

        const chunkStat = fs.statSync(currentChunk);
        if (chunkStat.size < 4096) {
          addStreamLog(
            streamId,
            'warn',
            `Skipping tiny/empty segment #${chunkIdx} (${chunkStat.size} bytes).`
          );
          fs.unlinkSync(currentChunk);
          chunkIdx += 1;
          continue;
        }

        activeAnalyzedChunks.add(currentChunk);
        saveChunkRefs();

        updateJob(streamId, {
          currentStage: `AI scanning segment #${chunkIdx}`,
        });
        addStreamLog(streamId, 'info', `Analyzing segment #${chunkIdx}...`);

        try {
          const actualDuration = await getVideoDurationSeconds(
            currentChunk,
            segmentSeconds
          );
          const formatMode = worker.job.formatMode === 'long' ? 'long' : 'short';
          const aspectMode = worker.job.aspectMode === 'landscape' ? 'landscape' : 'portrait';
          const brandingEnabled = worker.job.brandingEnabled ?? true;

          if (actualDuration < MIN_SHORT_SECONDS) {
            addStreamLog(
              streamId,
              'info',
              `Segment #${chunkIdx} is ${actualDuration.toFixed(
                1
              )}s (< ${MIN_SHORT_SECONDS}s minimum); skipping AI clip scan.`
            );
          } else {
            const proxyPath = path.join(chunkDir, `proxy_${chunkIdx}_${Date.now()}.mp4`);
            let analysisPath = currentChunk;
            let proxyCreated = false;

            updateJob(streamId, {
              currentStage: `Compressing 360p/2fps AI proxy for segment #${chunkIdx}`,
            });

            const origMb = (fs.statSync(currentChunk).size / (1024 * 1024)).toFixed(1);
            proxyCreated = await createLightweightAnalysisProxy(currentChunk, proxyPath);
            if (proxyCreated) {
              analysisPath = proxyPath;
              const proxyMb = (fs.statSync(proxyPath).size / (1024 * 1024)).toFixed(2);
              addStreamLog(
                streamId,
                'info',
                `Created lightweight 360p/2fps AI proxy (${proxyMb} MB vs ${origMb} MB original). Full-res buffer preserved for final clipping.`
              );
            } else {
              addStreamLog(
                streamId,
                'warn',
                `Could not build 360p proxy for segment #${chunkIdx}; analyzing original segment (${origMb} MB).`
              );
            }

            updateJob(streamId, {
              currentStage: `AI scanning segment #${chunkIdx}`,
            });
            worker.lastHeartbeatMs = Date.now();

            let aiData: ChunkAnalysisResult | null = null;
            let lastAnalysisErr: unknown = null;
            const recentLanguages: ContentLanguageChoice[] = clipQueue
              .map((c) => c.languageChoice)
              .filter((l): l is ContentLanguageChoice => Boolean(l))
              .slice(0, 8);
            const streamExistingTitles = clipQueue
              .filter((c) => c.streamId === streamId)
              .map((c) => c.title)
              .filter(Boolean);
            const recentGlobalTitles = clipQueue
              .map((c) => c.title)
              .filter(Boolean)
              .slice(0, 12);
            const recentTitles = Array.from(
              new Set([...streamExistingTitles, ...recentGlobalTitles])
            ).slice(0, 18);
            const videoTitleHint = stripUrlsFromText(
              worker.job.liveTitle ||
                (isLikelyUrl(worker.job.label) ? '' : worker.job.label)
            );
            const rawReqTopic = worker.job.requirementSpec?.topicIdea;
            const cleanReqTopic =
              rawReqTopic && !isLikelyUrl(rawReqTopic)
                ? rawReqTopic
                : videoTitleHint;

            const chunkOffsetSeconds = chunkIdx * segmentSeconds;

            const reqCtx = parseRequirementSpec({
              topicIdea: cleanReqTopic,
              categories: worker.job.requirementSpec?.lockedCategories,
              languagePreference: worker.job.requirementSpec?.languagePreference,
              clipCount: worker.job.requirementSpec?.clipCount ?? worker.job.clipCount,
              formatMode,
              aspectMode,
              additionalInstructions: worker.job.additionalInstructions,
              label: isLikelyUrl(worker.job.label) ? videoTitleHint : worker.job.label,
            });

            for (let watchdogAttempt = 1; watchdogAttempt <= 2; watchdogAttempt += 1) {
              const watchdogController = new AbortController();
              const stallTimer = setTimeout(() => {
                watchdogController.abort(
                  new Error(`Watchdog aborted stalled segment #${chunkIdx} after 45s`)
                );
              }, 45_000);

              try {
                aiData = await analyzeVideoChunk(
                  analysisPath,
                  actualDuration,
                  (lvl, msg) => addStreamLog(streamId, lvl, msg),
                  formatMode,
                  () => worker.stopRequested,
                  watchdogController.signal,
                  {
                    additionalInstructions: worker.job.additionalInstructions,
                    requirementSpec: reqCtx.spec,
                    recentLanguages,
                    recentTitles,
                    videoTitleHint,
                    chunkOffsetSeconds,
                  }
                );
                break;
              } catch (err) {
                lastAnalysisErr = err;
                if (worker.stopRequested) {
                  throw err;
                }
                if (watchdogController.signal.aborted && watchdogAttempt === 1) {
                  addStreamLog(
                    streamId,
                    'warn',
                    `Watchdog detected stalled segment #${chunkIdx} (>45s). Retrying immediately with fresh API key & model...`
                  );
                  continue;
                }
                break;
              } finally {
                clearTimeout(stallTimer);
              }
            }

            try {
              if (!aiData) {
                const reason =
                  lastAnalysisErr instanceof Error
                    ? lastAnalysisErr.message
                    : String(lastAnalysisErr || 'Remote AI temporarily unreachable');
                addStreamLog(
                  streamId,
                  'warn',
                  `Remote Gemini video analysis unavailable (${reason}). Activating FFmpeg peak detector + keyframe scene analyzer for segment #${chunkIdx}...`
                );
                aiData = await detectFallbackMomentsWithFfmpeg(
                  analysisPath,
                  actualDuration,
                  formatMode,
                  reqCtx,
                  {
                    videoTitleHint,
                    recentTitles,
                    onLog: (lvl, msg) => addStreamLog(streamId, lvl, msg),
                  }
                );
              }

              // Route through Claude Creative Director when selected/configured
              const activeProvider = getActiveAiProvider();
              if (
                aiData.moments.length > 0 &&
                activeProvider === 'claude' &&
                isClaudeConfigured()
              ) {
                try {
                  updateJob(streamId, {
                    currentStage: `Claude Creative Director refining segment #${chunkIdx}`,
                  });
                  const refinedMoments = await refineMomentsWithClaude({
                    moments: aiData.moments,
                    formatMode,
                    aspectMode,
                    chunkDurationSeconds: actualDuration,
                    chunkOffsetSeconds,
                    additionalInstructions: worker.job.additionalInstructions,
                    requirementSpec: reqCtx.spec,
                    recentLanguages,
                    recentTitles,
                    videoTitleHint,
                  });
                  aiData = { moments: refinedMoments };
                  addStreamLog(
                    streamId,
                    'info',
                    `Claude Creative Director refined ${refinedMoments.length} scene-aligned clip(s) with unique titles & #BD hashtag checks.`
                  );
                } catch (claudeErr) {
                  addStreamLog(
                    streamId,
                    'warn',
                    `Claude refinement notice (${
                      claudeErr instanceof Error ? claudeErr.message : String(claudeErr)
                    }). Keeping Gemini scene-aligned metadata cleanly.`
                  );
                }
              }

              // Batch Uniqueness Guard & Fallback Sanitizer before queueing
              if (aiData && aiData.moments.length > 0) {
                const guardedBatch = await ensureUniqueBatchClipMetadata({
                  moments: aiData.moments,
                  existingTitles: recentTitles,
                  ctx: reqCtx,
                  formatMode,
                  videoTitleHint,
                  chunkPath: analysisPath,
                  onLog: (lvl, msg) => addStreamLog(streamId, lvl, msg),
                });
                aiData = { moments: guardedBatch.moments };
                if (guardedBatch.regeneratedCount > 0) {
                  addStreamLog(
                    streamId,
                    'info',
                    `Batch Uniqueness Guard refreshed ${guardedBatch.regeneratedCount} clip title/hashtag set(s) for 100% scene-unique metadata.`
                  );
                }
              }
            } finally {
              if (proxyCreated && fs.existsSync(proxyPath)) {
                try {
                  fs.unlinkSync(proxyPath);
                } catch {
                  // Best-effort proxy cleanup
                }
              }
            }

            if (aiData.moments.length === 0) {
              addStreamLog(
                streamId,
                'info',
                `No standout moments matching locked requirements found in segment #${chunkIdx}. Continuing...`
              );
            } else {
              let queuedCount = 0;
              const safeDuration = Math.floor(actualDuration);
              const explicitRanges = parseAllTimestampRanges(worker.job.additionalInstructions)
                .map((r) => {
                  if (
                    r.endSeconds > chunkOffsetSeconds &&
                    r.startSeconds < chunkOffsetSeconds + safeDuration
                  ) {
                    return {
                      start: Math.max(0, Math.round(r.startSeconds - chunkOffsetSeconds)),
                      end: Math.min(safeDuration, Math.round(r.endSeconds - chunkOffsetSeconds)),
                    };
                  }
                  if (chunkOffsetSeconds === 0 && r.endSeconds <= safeDuration) {
                    return { start: r.startSeconds, end: r.endSeconds };
                  }
                  return null;
                })
                .filter((r): r is { start: number; end: number } => Boolean(r && r.end > r.start));

              const targetMinSeconds =
                formatMode === 'long'
                  ? safeDuration >= MIN_LONG_SECONDS
                    ? MIN_LONG_SECONDS
                    : Math.max(MIN_SHORT_SECONDS, Math.floor(safeDuration * 0.7))
                  : MIN_SHORT_SECONDS;
              const targetMaxSeconds =
                formatMode === 'long' ? MAX_LONG_SECONDS : MAX_SHORT_SECONDS;
              const clipCap = reqCtx.spec.clipCount;

              for (let mIdx = 0; mIdx < aiData.moments.length; mIdx += 1) {
                if (clipCap && worker.job.momentsDetected >= clipCap) {
                  addStreamLog(
                    streamId,
                    'info',
                    `Reached requested Clip Count limit (${clipCap}). Stopping additional extraction.`
                  );
                  worker.stopRequested = true;
                  break;
                }

                const moment = aiData.moments[mIdx];
                const strictMomentCheck = checkStrictMomentMatch(moment, reqCtx);
                if (!strictMomentCheck.passed) {
                  addStreamLog(
                    streamId,
                    'warn',
                    `Discarded moment in segment #${chunkIdx}: ${strictMomentCheck.reason || 'Failed strict requirement alignment.'}`
                  );
                  continue;
                }

                const explicitOverride = explicitRanges[mIdx];
                let startS: number;
                let endS: number;

                if (explicitOverride) {
                  startS = explicitOverride.start;
                  endS = explicitOverride.end;
                } else {
                  const rawStart = Number.isFinite(Number(moment.start_seconds))
                    ? Math.round(Number(moment.start_seconds))
                    : 0;
                  const rawEnd = Number.isFinite(Number(moment.end_seconds))
                    ? Math.round(Number(moment.end_seconds))
                    : rawStart + targetMinSeconds;

                  startS = Math.max(0, Math.min(rawStart, Math.max(0, safeDuration - targetMinSeconds)));
                  endS = Math.min(safeDuration, Math.max(rawEnd, startS + targetMinSeconds));
                  if (endS - startS < targetMinSeconds) {
                    startS = Math.max(0, endS - targetMinSeconds);
                  }
                  if (endS - startS > targetMaxSeconds) {
                    endS = startS + targetMaxSeconds;
                  }
                }

                const nextClipNumber = worker.job.momentsDetected + 1;
                const cleanedMeta = validateAndCleanClipMetadata({
                  moment: {
                    category: normalizeCategory(moment.category),
                    moment_summary: moment.moment_summary,
                    viral_reason: moment.viral_reason,
                    title: moment.title,
                    description: moment.description,
                    hashtags: moment.hashtags,
                    tags: moment.tags,
                    language_choice: moment.language_choice,
                  },
                  ctx: reqCtx,
                  clipNumber: nextClipNumber,
                });

                if (isDuplicateMoment(streamId, chunkIdx, startS, endS)) {
                  addStreamLog(
                    streamId,
                    'warn',
                    `Skipped overlapping moment "${cleanedMeta.title}" in segment #${chunkIdx}.`
                  );
                  continue;
                }

                const clipId = `clip_${streamId}_${chunkIdx}_${Date.now()}_${Math.random()
                  .toString(36)
                  .slice(2, 5)}`;

                const captions: CaptionCue[] = Array.isArray(moment.captions)
                  ? moment.captions.map((c) => ({
                      startOffsetSeconds: Number(c.start_offset_seconds) || 0,
                      endOffsetSeconds: Number(c.end_offset_seconds) || 2,
                      text: String(c.text || '').trim(),
                    }))
                  : [];

                const watermarkPosition: WatermarkPosition = worker.job.watermarkPosition ?? 'auto';
                const clipDur = Math.max(3, Math.round(endS - startS));
                const rawThumbTs = Number(moment.thumbnail_timestamp);
                const thumbTs =
                  Number.isFinite(rawThumbTs) && rawThumbTs >= 0.4 && rawThumbTs <= clipDur - 0.4
                    ? Number(rawThumbTs.toFixed(1))
                    : Number((clipDur * 0.28).toFixed(1));

                const newJob: InternalClipRecord = {
                  id: clipId,
                  streamId,
                  streamLabel: worker.job.label,
                  clipNumber: cleanedMeta.clipNumber,
                  formatMode,
                  aspectMode,
                  brandingEnabled,
                  watermarkPosition,
                  chunkIndex: chunkIdx,
                  category: normalizeCategory(moment.category),
                  status: 'queued',
                  attempts: 0,
                  maxAttempts: 3,
                  momentSummary: cleanedMeta.momentSummary,
                  title: cleanedMeta.title,
                  description: cleanedMeta.description,
                  languageChoice: cleanedMeta.languageChoice,
                  thumbnailHook: moment.thumbnail_hook?.trim() || undefined,
                  thumbnailTimestamp: thumbTs,
                  hashtags: cleanedMeta.hashtags,
                  tags: cleanedMeta.tags,
                  viralReason: cleanedMeta.viralReason,
                  captions,
                  startSeconds: Math.round(startS),
                  endSeconds: Math.round(endS),
                  durationSeconds: clipDur,
                  createdAt: new Date().toISOString(),
                  chunkPath: currentChunk,
                  youtubeUploadStatus: 'not_uploaded',
                };

                clipQueue.unshift(newJob);
                queuedCount += 1;
                updateJob(streamId, {
                  momentsDetected: worker.job.momentsDetected + 1,
                });
              }

              if (queuedCount > 0) {
                saveClipsIndex();
                addStreamLog(
                  streamId,
                  'success',
                  `Queued ${queuedCount} ${formatMode === 'long' ? 'Long-Form' : '9:16 Short'} clip${queuedCount > 1 ? 's' : ''} from segment #${chunkIdx} with strict scene-aligned metadata & #BD tags.`
                );
                void ensureQueueWorkerRunning();
              }
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          addStreamLog(streamId, 'error', `Segment #${chunkIdx} analysis error: ${msg}`);
        } finally {
          activeAnalyzedChunks.delete(currentChunk);
          saveChunkRefs();
          cleanupUnreferencedChunk(currentChunk);
          updateJob(streamId, {
            chunksProcessed: worker.job.chunksProcessed + 1,
          });
          chunkIdx += 1;
        }
      } else if (recordExited) {
        if (chunkIdx === 0 && (streamReadError || (recordExitCode && recordExitCode !== 0))) {
          const reason =
            streamReadError ||
            stderrTail.slice(-2).join(' | ') ||
            `Exit code ${recordExitCode}`;
          throw new Error(`Stream ingestion failed: ${reason}`);
        }
        addStreamLog(
          streamId,
          'success',
          sourceType === 'upload'
            ? 'All segments of authorized video processed. Monitoring ended.'
            : 'Live stream ended. Monitoring stopped.'
        );
        updateJob(streamId, {
          status: 'ended',
          endedAt: new Date().toISOString(),
          currentStage: 'Stream ended',
        });
        break;
      } else {
        updateJob(streamId, {
          currentStage: `Recording live segment #${chunkIdx}`,
        });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    if (worker.stopRequested) {
      worker.inputStream?.destroy();
      worker.audioStream?.destroy();
      if (recordProc.exitCode === null) {
        recordProc.kill('SIGTERM');
      }
      updateJob(streamId, {
        status: 'stopped',
        endedAt: new Date().toISOString(),
        currentStage: 'Stopped by operator',
      });
      addStreamLog(streamId, 'warn', 'Live monitoring stopped by operator.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    addStreamLog(streamId, 'error', message);
    updateJob(streamId, {
      status: 'error',
      endedAt: new Date().toISOString(),
      currentStage: 'Stopped (Error)',
      errorMessage: message,
    });
  } finally {
    if (sourceType === 'upload' && fs.existsSync(sourceInput)) {
      try {
        fs.unlinkSync(sourceInput);
      } catch {
        // Ignore cleanup failure
      }
    }
  }
}

export function startStreamJob(params: {
  label: string;
  sourceUrl: string;
  sourceType: StreamSourceType;
  formatMode?: ClipFormatMode;
  aspectMode?: VideoAspectMode;
  brandingEnabled?: boolean;
  watermarkPosition?: WatermarkPosition;
  additionalInstructions?: string;
  clipCount?: number;
  requirementSpec?: RequirementSpec;
  authorizedConfirmed: boolean;
  segmentSeconds: number;
  localFilePath?: string;
}): StreamJob {
  const id = `str_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const formatMode: ClipFormatMode = params.formatMode === 'long' ? 'long' : 'short';
  const aspectMode: VideoAspectMode =
    formatMode === 'long' && params.aspectMode === 'landscape' ? 'landscape' : 'portrait';
  const brandingEnabled = params.brandingEnabled ?? true;
  const watermarkPosition: WatermarkPosition =
    params.watermarkPosition === 'top-left' ||
    params.watermarkPosition === 'top-right' ||
    params.watermarkPosition === 'bottom-left' ||
    params.watermarkPosition === 'bottom-right'
      ? params.watermarkPosition
      : 'auto';
  const clampedSegment = Math.max(
    20,
    Math.min(600, params.segmentSeconds || (formatMode === 'long' ? 300 : 120))
  );
  const cleanInstructions =
    typeof params.additionalInstructions === 'string' && params.additionalInstructions.trim()
      ? params.additionalInstructions.trim()
      : undefined;

  const cleanLabelTopic = isLikelyUrl(params.label) ? '' : stripUrlsFromText(params.label);
  const cleanSpecTopic = isLikelyUrl(params.requirementSpec?.topicIdea)
    ? ''
    : stripUrlsFromText(params.requirementSpec?.topicIdea);

  const resolvedReqCtx = parseRequirementSpec({
    topicIdea: cleanSpecTopic || cleanLabelTopic,
    categories: params.requirementSpec?.lockedCategories,
    languagePreference: params.requirementSpec?.languagePreference,
    clipCount: params.clipCount ?? params.requirementSpec?.clipCount,
    formatMode,
    aspectMode,
    additionalInstructions: cleanInstructions,
    label: cleanLabelTopic,
  });

  const job: StreamJob = {
    id,
    label:
      params.label.trim() ||
      (params.sourceType === 'upload' ? 'Authorized Recording' : params.sourceUrl),
    sourceUrl: params.sourceUrl,
    sourceType: params.sourceType,
    formatMode,
    aspectMode,
    brandingEnabled,
    watermarkPosition,
    ...(cleanInstructions ? { additionalInstructions: cleanInstructions } : {}),
    ...(resolvedReqCtx.spec.clipCount ? { clipCount: resolvedReqCtx.spec.clipCount } : {}),
    requirementSpec: resolvedReqCtx.spec,
    authorizedConfirmed: params.authorizedConfirmed,
    status: 'initializing',
    segmentSeconds: clampedSegment,
    chunksProcessed: 0,
    momentsDetected: 0,
    currentStage: 'Initializing stream monitor',
    startedAt: new Date().toISOString(),
    logs: [],
  };

  workers.set(id, { job, stopRequested: false });
  addStreamLog(
    id,
    'info',
    `Stream monitor initialized (${
      formatMode === 'long' ? `Long-Form Videos · ${aspectMode}` : 'TikTok & Shorts · 9:16'
    } · Watermark ${brandingEnabled ? watermarkPosition : 'OFF'}${
      resolvedReqCtx.spec.clipCount ? ` · Max ${resolvedReqCtx.spec.clipCount} clip(s)` : ''
    }${cleanInstructions ? ' · Strict Requirement Spec locked' : ''}).`
  );
  saveStreamsIndex();

  const sourceInput =
    params.sourceType === 'upload' && params.localFilePath
      ? params.localFilePath
      : params.sourceUrl;

  void runStreamWorker({
    streamId: id,
    sourceInput,
    sourceType: params.sourceType,
    segmentSeconds: clampedSegment,
  });

  return job;
}

export function stopStreamJob(streamId: string): boolean {
  const worker = workers.get(streamId);
  if (!worker) return false;
  worker.stopRequested = true;
  worker.inputStream?.destroy();
  worker.audioStream?.destroy();
  if (worker.recordProcess && worker.recordProcess.exitCode === null) {
    worker.recordProcess.kill('SIGTERM');
  }
  updateJob(streamId, {
    status: 'stopping',
    currentStage: 'Stopping stream monitor...',
  });
  addStreamLog(streamId, 'warn', 'Stop requested by user.');
  return true;
}

export function removeStreamJob(streamId: string): boolean {
  const worker = workers.get(streamId);
  if (!worker) return false;
  if (worker.job.status === 'monitoring' || worker.job.status === 'initializing') {
    stopStreamJob(streamId);
  }
  workers.delete(streamId);
  saveStreamsIndex();

  const chunksPath = path.join(STREAMS_DIR, path.basename(streamId), 'chunks');
  const hasPendingClipsForStream = clipQueue.some(
    (c) =>
      c.streamId === streamId &&
      (c.status === 'queued' || c.status === 'processing')
  );
  if (!hasPendingClipsForStream && fs.existsSync(chunksPath)) {
    try {
      fs.rmSync(chunksPath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
  return true;
}

export function retryClipJob(clipId: string): ClipItem | null {
  const clip = clipQueue.find((c) => c.id === clipId);
  if (!clip) return null;
  if (clip.status !== 'failed') return clip;
  clip.status = 'queued';
  clip.attempts = 0;
  clip.errorMessage = undefined;
  saveClipsIndex();
  void ensureQueueWorkerRunning();
  return stripInternalFields(clip);
}

export function updateClipMetadata(
  clipId: string,
  updates: {
    momentSummary?: string;
    title?: string;
    description?: string;
    hashtags?: string[];
    tags?: string[];
  }
): ClipItem | null {
  const clip = clipQueue.find((c) => c.id === clipId);
  if (!clip) return null;
  const isGta = /gta/i.test(`${clip.streamLabel} ${clip.title}`);
  if (typeof updates.momentSummary === 'string') {
    clip.momentSummary = stripDummyPhrasesFromText(updates.momentSummary).trim().slice(0, 140);
  }
  if (typeof updates.title === 'string') {
    clip.title = sanitizeTitleText(updates.title, {
      fallbackSummary: clip.momentSummary,
      formatMode: clip.formatMode,
      languageChoice: clip.languageChoice,
      isGtaContext: isGta,
    });
  }
  if (typeof updates.description === 'string') {
    clip.description = stripDummyPhrasesFromText(updates.description);
  }
  if (Array.isArray(updates.hashtags)) {
    clip.hashtags = sanitizeHashtags(updates.hashtags, {
      isGtaContext: isGta,
      formatMode: clip.formatMode,
      momentCategory: clip.category,
      sceneText: `${clip.momentSummary || ''} ${clip.title}`,
    });
  }
  if (Array.isArray(updates.tags)) {
    clip.tags = sanitizeSeoTags(updates.tags, {
      isGtaContext: isGta,
      formatMode: clip.formatMode,
    });
  }
  saveClipsIndex();
  return stripInternalFields(clip);
}

export async function regenerateClipThumbnail(clipId: string): Promise<ClipItem | null> {
  const clip = clipQueue.find((c) => c.id === clipId);
  if (!clip) return null;
  if (clip.status !== 'completed') {
    throw new Error('Wait until the clip finishes rendering before regenerating its thumbnail.');
  }

  const cleanFile = (url?: string) => (url ? path.basename(url.split('?')[0]) : '');
  const clipDir = path.join(STREAMS_DIR, clip.streamId, 'clips');
  fs.mkdirSync(clipDir, { recursive: true });

  const mp4File = cleanFile(clip.videoUrl) || `${clip.id}.mp4`;
  const renderedPath = getClipFilePath(clip.streamId, mp4File);
  const useChunk = Boolean(clip.chunkPath && fs.existsSync(clip.chunkPath));

  if (!useChunk && !renderedPath) {
    throw new Error('Source media for thumbnail generation is no longer available on disk.');
  }

  const sourcePath = useChunk ? clip.chunkPath! : renderedPath!;
  const duration = Math.max(3, clip.durationSeconds);

  // Pick a fresh expressive peak timestamp slightly varied from the previous timestamp
  const prevTs = typeof clip.thumbnailTimestamp === 'number' ? clip.thumbnailTimestamp : duration * 0.28;
  const candidateOffsets = [0.22, 0.48, 0.72, 0.35, 0.6].map((r) =>
    Number(Math.max(0.5, Math.min(duration - 0.5, duration * r)).toFixed(1))
  );
  const nextRelSeek =
    candidateOffsets.find((t) => Math.abs(t - prevTs) >= Math.min(2, duration * 0.15)) ??
    candidateOffsets[0];

  const sourceSeekSeconds = useChunk ? clip.startSeconds + nextRelSeek : nextRelSeek;
  const thumbFilename = `${clip.id}.jpg`;
  const thumbOutput = path.join(clipDir, thumbFilename);
  const badgePath = (clip.brandingEnabled ?? true) ? await ensureBrandingBadgePng() : null;
  const isLandscape = clip.formatMode === 'long' && clip.aspectMode === 'landscape';

  const meta = await generateThumbnailImage({
    sourceVideoPath: sourcePath,
    sourceSeekSeconds,
    thumbOutput,
    durationSeconds: duration,
    formatMode: clip.formatMode,
    aspectMode: isLandscape ? 'landscape' : 'portrait',
    brandingEnabled: clip.brandingEnabled ?? true,
    badgePath,
    thumbnailHook: clip.thumbnailHook,
    category: clip.category,
    viralReason: clip.viralReason,
    title: clip.title,
    onLog: workers.has(clip.streamId)
      ? (lvl, msg) => addStreamLog(clip.streamId, lvl, msg)
      : undefined,
  });

  const nowIso = new Date().toISOString();
  clip.thumbnailHook = meta.thumbnailHookText;
  clip.thumbnailTimestamp = nextRelSeek;
  clip.thumbnailSearchInsights = meta.searchInsights;
  clip.thumbnailSearchSources = meta.sources;
  clip.thumbnailAccent = meta.accentTheme;
  clip.thumbnailUpdatedAt = nowIso;
  clip.thumbnailUrl = `/api/media/clips/${clip.streamId}/${thumbFilename}?v=${Date.now()}`;
  saveClipsIndex();

  return stripInternalFields(clip);
}

export function deleteClipById(clipId: string): boolean {
  const idx = clipQueue.findIndex((c) => c.id === clipId);
  if (idx === -1) return false;
  const [removed] = clipQueue.splice(idx, 1);

  const cleanName = (u: string) => path.basename(u.split('?')[0]);

  if (removed.videoUrl) {
    const mp4Path = getClipFilePath(removed.streamId, cleanName(removed.videoUrl));
    if (mp4Path && fs.existsSync(mp4Path)) fs.unlinkSync(mp4Path);
  }
  if (removed.thumbnailUrl) {
    const thumbPath = getClipFilePath(removed.streamId, cleanName(removed.thumbnailUrl));
    if (thumbPath && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
  }
  if (removed.srtUrl) {
    const srtPath = getClipFilePath(removed.streamId, cleanName(removed.srtUrl));
    if (srtPath && fs.existsSync(srtPath)) fs.unlinkSync(srtPath);
  }

  saveClipsIndex();
  cleanupUnreferencedChunk(removed.chunkPath);
  return true;
}

function stripInternalFields(item: InternalClipRecord): ClipItem {
  const { chunkPath: _ignored, ...publicItem } = item;
  return publicItem;
}

export function getAllStreams(): StreamJob[] {
  return Array.from(workers.values())
    .map((w) => w.job)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function getAllClips(): ClipItem[] {
  return clipQueue.map(stripInternalFields);
}

export function getClipFilePath(streamId: string, filename: string): string | null {
  const safeStream = path.basename(streamId);
  const safeFile = path.basename(filename.split('?')[0]);
  const fullPath = path.join(STREAMS_DIR, safeStream, 'clips', safeFile);
  if (fs.existsSync(fullPath)) {
    return fullPath;
  }
  return null;
}

export async function ensureYouTubeUploadWorkerRunning() {
  if (youtubeUploadWorkerRunning) return;
  youtubeUploadWorkerRunning = true;

  try {
    while (true) {
      if (!hasActiveYouTubeToken()) break;

      const nextClip = clipQueue.find(
        (c) => c.status === 'completed' && c.youtubeUploadStatus === 'queued_upload'
      );
      if (!nextClip) break;

      nextClip.youtubeUploadStatus = 'uploading';
      nextClip.youtubeUploadError = undefined;
      saveClipsIndex();

      const streamExists = workers.has(nextClip.streamId);
      const isLongVideo = nextClip.formatMode === 'long';
      if (streamExists) {
        addStreamLog(
          nextClip.streamId,
          'info',
          `Auto-uploading ${isLongVideo ? 'Long-Form Video' : 'Short'} + Custom Thumbnail "${nextClip.title}" to YouTube via OAuth Pool...`
        );
      }

      try {
        const fileName = nextClip.videoUrl
          ? path.basename(nextClip.videoUrl.split('?')[0])
          : `${nextClip.id}.mp4`;
        const filePath = getClipFilePath(nextClip.streamId, fileName);
        if (!filePath) {
          throw new Error('Rendered MP4 file was not found on disk for upload.');
        }

        const thumbPath = nextClip.thumbnailUrl
          ? getClipFilePath(nextClip.streamId, path.basename(nextClip.thumbnailUrl.split('?')[0]))
          : null;

        const existingScheduleTimestamps: number[] = [];
        for (const c of clipQueue) {
          if (c.id === nextClip.id) continue;
          const tsStr = c.youtubeScheduledPublishAt || c.youtubeUploadedAt;
          if (tsStr) {
            const parsedTs = Date.parse(tsStr);
            if (!Number.isNaN(parsedTs)) existingScheduleTimestamps.push(parsedTs);
          }
        }

        const result = await uploadClipToYouTube({
          clip: stripInternalFields(nextClip),
          filePath,
          thumbnailPath: thumbPath,
          existingScheduleTimestamps,
          onLog: streamExists
            ? (lvl, msg) => addStreamLog(nextClip.streamId, lvl, msg)
            : undefined,
        });

        nextClip.youtubeUploadStatus = 'uploaded';
        nextClip.youtubeVideoId = result.videoId;
        nextClip.youtubeUrl = result.url;
        nextClip.youtubePrivacyStatus = result.privacyStatus;
        nextClip.youtubeThumbnailSet = result.thumbnailSet;
        nextClip.youtubeUploadedAt = result.uploadedAt;
        nextClip.youtubeScheduledPublishAt = result.scheduledPublishAt;
        nextClip.youtubeTimingAnalysis = result.timingAnalysis;
        nextClip.youtubeUploadError = undefined;
        saveClipsIndex();

        if (streamExists) {
          const thumbNote = result.thumbnailSet
            ? ' + custom thumbnail'
            : result.thumbnailWarning
            ? ` (thumbnail note: ${result.thumbnailWarning})`
            : '';
          const scheduleNote = result.scheduledPublishAt
            ? ` · Scheduled release: ${result.scheduledPublishAt}`
            : '';
          addStreamLog(
            nextClip.streamId,
            'success',
            `Uploaded ${isLongVideo ? 'Long-Form Video' : 'Short'} "${nextClip.title}"${thumbNote} to YouTube (${result.privacyStatus}${scheduleNote}): ${result.url}`
          );
        }
      } catch (err) {
        if (err instanceof AllYouTubeQuotaExhaustedError) {
          nextClip.youtubeUploadStatus = 'queued_upload';
          nextClip.youtubeUploadError =
            'All YouTube OAuth quota slots exhausted—queued items preserved for next available slot';
          saveClipsIndex();
          recordDoctorEvent(
            'warn',
            'YouTube Quota Pool',
            `All YouTube OAuth quota slots exhausted. Paused upload for "${nextClip.title}" safely in queue without losing rendered files.`
          );
          if (streamExists) {
            addStreamLog(
              nextClip.streamId,
              'warn',
              `Upload queue paused: All YouTube OAuth quota slots exhausted. "${nextClip.title}" remains queued safely until another project slot is connected or daily PT quota resets.`
            );
          }
          break;
        }

        const msg = err instanceof Error ? err.message : String(err);
        nextClip.youtubeUploadStatus = 'upload_failed';
        nextClip.youtubeUploadError = msg;
        saveClipsIndex();

        if (streamExists) {
          addStreamLog(
            nextClip.streamId,
            'error',
            `YouTube upload failed for "${nextClip.title}": ${msg}`
          );
        }
      }
    }
  } finally {
    youtubeUploadWorkerRunning = false;
  }
}

export function queueClipYouTubeUpload(clipId: string): ClipItem | null {
  const clip = clipQueue.find((c) => c.id === clipId);
  if (!clip) return null;
  if (clip.status !== 'completed') {
    throw new Error('Wait until the 9:16 Short finishes rendering before uploading.');
  }
  if (clip.youtubeUploadStatus === 'uploaded') {
    return stripInternalFields(clip);
  }
  clip.youtubeUploadStatus = 'queued_upload';
  clip.youtubeUploadError = undefined;
  saveClipsIndex();
  void ensureYouTubeUploadWorkerRunning();
  return stripInternalFields(clip);
}

export function resumePendingYouTubeUploads() {
  if (!hasActiveYouTubeToken()) return;
  const settings = getYouTubeSettings();
  let changed = false;

  for (const clip of clipQueue) {
    if (clip.status !== 'completed') continue;
    if (
      clip.youtubeUploadStatus === 'queued_upload' &&
      clip.youtubeUploadError
    ) {
      clip.youtubeUploadError = undefined;
      changed = true;
    } else if (
      clip.youtubeUploadStatus === 'upload_failed' &&
      (clip.youtubeUploadError?.includes('401') ||
        clip.youtubeUploadError?.toLowerCase().includes('quota'))
    ) {
      clip.youtubeUploadStatus = 'queued_upload';
      clip.youtubeUploadError = undefined;
      changed = true;
    } else if (
      settings.autoUploadEnabled &&
      (!clip.youtubeUploadStatus || clip.youtubeUploadStatus === 'not_uploaded') &&
      clip.durationSeconds >= MIN_SHORT_SECONDS
    ) {
      // Only auto-enqueue newly completed or >=15s clips created in current sessions when explicitly resumed
    }
  }

  if (changed) {
    saveClipsIndex();
  }
  void ensureYouTubeUploadWorkerRunning();
}

async function ensureZernioPublishWorkerRunning() {
  if (zernioPublishWorkerRunning) return;
  zernioPublishWorkerRunning = true;

  try {
    while (true) {
      if (!hasActiveZernioAuth()) break;

      const nextClip = clipQueue.find(
        (c) => c.status === 'completed' && c.zernioPublishStatus === 'pending'
      );
      if (!nextClip) break;

      nextClip.zernioPublishStatus = 'uploading';
      nextClip.zernioPublishError = undefined;
      saveClipsIndex();

      const streamExists = workers.has(nextClip.streamId);
      if (streamExists) {
        addStreamLog(
          nextClip.streamId,
          'info',
          `Uploading rendered clip "${nextClip.title}" via Zernio to connected accounts...`
        );
      }

      try {
        const fileName = nextClip.videoUrl
          ? path.basename(nextClip.videoUrl.split('?')[0])
          : `${nextClip.id}.mp4`;
        const filePath = getClipFilePath(nextClip.streamId, fileName);
        if (!filePath) {
          throw new Error('Rendered MP4 file was not found on disk for Zernio upload.');
        }

        const result = await uploadClipToZernio({
          clip: stripInternalFields(nextClip),
          clipFilePath: filePath,
          accountIdsOverride: nextClip.zernioTargetAccountIds,
          uploadModeOverride: nextClip.zernioUploadModeOverride,
          onLog: streamExists
            ? (lvl, msg) => addStreamLog(nextClip.streamId, lvl, msg)
            : undefined,
        });

        nextClip.zernioPublishStatus = result.status;
        nextClip.zernioPostId = result.postId;
        nextClip.zernioPlatformResults = result.platformResults;
        nextClip.zernioPublishedAt = new Date().toISOString();
        nextClip.zernioPublishError =
          result.status === 'partial_failed'
            ? result.platformResults
                .filter((r) => Boolean(r.error))
                .map((r) => `${r.platform}: ${r.error}`)
                .join('; ')
            : undefined;
        nextClip.zernioTargetAccountIds = undefined;
        nextClip.zernioUploadModeOverride = undefined;
        saveClipsIndex();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        nextClip.zernioPublishStatus = 'failed';
        nextClip.zernioPublishError = msg;
        saveClipsIndex();

        if (streamExists) {
          addStreamLog(
            nextClip.streamId,
            'error',
            `Zernio upload failed for "${nextClip.title}": ${msg}`
          );
        }
      }
    }
  } finally {
    zernioPublishWorkerRunning = false;
  }
}

export function queueClipZernioPublish(
  clipId: string,
  accountIds?: string[],
  uploadMode?: import('../src/types.ts').ZernioUploadMode
): ClipItem | null {
  const clip = clipQueue.find((c) => c.id === clipId);
  if (!clip) return null;
  if (clip.status !== 'completed') {
    throw new Error('Wait until the clip finishes rendering before uploading via Zernio.');
  }
  if (!hasActiveZernioAuth()) {
    throw new Error('Zernio is not connected. Click Sign in with Zernio first.');
  }
  const hasExplicitIds = Array.isArray(accountIds) && accountIds.length > 0;
  if (!hasExplicitIds && !hasSelectedZernioTargets()) {
    throw new Error(
      'Select at least one connected Zernio account in Zernio Setup before uploading.'
    );
  }

  clip.zernioPublishStatus = 'pending';
  clip.zernioPublishError = undefined;
  clip.zernioTargetAccountIds = hasExplicitIds ? accountIds : undefined;
  clip.zernioUploadModeOverride = uploadMode;
  saveClipsIndex();
  void ensureZernioPublishWorkerRunning();
  return stripInternalFields(clip);
}

export function resumePendingZernioPublishes() {
  if (!hasActiveZernioAuth() || !hasSelectedZernioTargets()) return;
  let changed = false;
  for (const clip of clipQueue) {
    if (clip.status !== 'completed') continue;
    if (clip.zernioPublishStatus === 'failed') {
      clip.zernioPublishStatus = 'pending';
      clip.zernioPublishError = undefined;
      changed = true;
    }
  }
  if (changed) saveClipsIndex();
  void ensureZernioPublishWorkerRunning();
}

export async function sendClipToThirdPartyExport(
  clipId: string,
  baseOrigin?: string
): Promise<ClipItem | null> {
  const clip = clipQueue.find((c) => c.id === clipId);
  if (!clip) return null;
  if (clip.status !== 'completed') {
    throw new Error('Wait until the clip finishes rendering before sending to a third-party workflow.');
  }

  clip.thirdPartyExportStatus = 'sending';
  clip.thirdPartyExportError = undefined;
  saveClipsIndex();

  try {
    const result = await dispatchClipToThirdPartyWebhook(clip, baseOrigin);
    clip.thirdPartyExportStatus = 'sent';
    clip.thirdPartyExportedAt = result.exportedAt;
    clip.thirdPartyExportError = undefined;
    saveClipsIndex();
    return stripInternalFields(clip);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to send clip to webhook.';
    clip.thirdPartyExportStatus = 'failed';
    clip.thirdPartyExportError = msg;
    saveClipsIndex();
    throw new Error(msg);
  }
}
