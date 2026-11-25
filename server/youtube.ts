import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import type {
  ClipItem,
  YouTubeAutoUploadSettings,
  YouTubeApiSlot,
  YouTubeChannelInfo,
  YouTubePrivacyStatus,
  YouTubeTimingAnalysis,
} from '../src/types.ts';
import { analyzeOptimalUploadTiming } from './youtubeTiming.ts';
import {
  sanitizeHashtags,
  sanitizeSeoTags,
  sanitizeTitleText,
} from './requirementEngine.ts';
import {
  classifyGoogleError,
  executeWithYouTubeOAuthPool,
  getYouTubeOAuthPoolSummary,
  hasAnyUsableYouTubeOAuthSlot,
  initYouTubeOAuthPool,
  markFirebaseSlotExpiredInPool,
  removeFirebaseSlotFromPool,
  upsertFirebaseSlotInPool,
} from './youtubeOAuthPool.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const YT_SETTINGS_FILE = path.join(DATA_DIR, 'youtube_settings.json');

interface PersistedYouTubePreferences {
  autoUploadEnabled: boolean;
  smartTimingEnabled: boolean;
  directStudioMode: boolean;
  customProjectId: string;
  privacyStatus: YouTubePrivacyStatus;
  categoryId: string;
  madeForKids: boolean;
  channel: YouTubeChannelInfo | null;
  slots: Array<{
    slotId: number;
    tokenExpired: boolean;
    quotaExhausted: boolean;
    channel: YouTubeChannelInfo | null;
  }>;
}

const DEFAULT_SLOTS = [1, 2, 3].map((slotId) => ({
  slotId,
  tokenExpired: false,
  quotaExhausted: false,
  channel: null as YouTubeChannelInfo | null,
}));

const DEFAULT_PREFS: PersistedYouTubePreferences = {
  autoUploadEnabled: false,
  smartTimingEnabled: true,
  directStudioMode: false,
  customProjectId: '',
  privacyStatus: 'public',
  categoryId: '20', // Gaming
  madeForKids: false,
  channel: null,
  slots: DEFAULT_SLOTS,
};

let prefs: PersistedYouTubePreferences = { ...DEFAULT_PREFS };

// In-memory tokens for each slot (slotId 1, 2, 3)
const slotTokens = new Map<number, string>();

export function initYouTubeSettings() {
  initYouTubeOAuthPool();
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(YT_SETTINGS_FILE)) {
      const parsed = JSON.parse(
        fs.readFileSync(YT_SETTINGS_FILE, 'utf-8')
      ) as Partial<PersistedYouTubePreferences>;
      
      const loadedSlots = Array.isArray(parsed.slots) ? parsed.slots : DEFAULT_SLOTS;
      const normalizedSlots = [1, 2, 3].map((slotId) => {
        const found = loadedSlots.find((s) => s.slotId === slotId);
        return found
          ? {
              slotId,
              tokenExpired: Boolean(found.tokenExpired),
              quotaExhausted: Boolean(found.quotaExhausted),
              channel: found.channel ?? null,
            }
          : { slotId, tokenExpired: false, quotaExhausted: false, channel: null };
      });

      prefs = {
        autoUploadEnabled: Boolean(parsed.autoUploadEnabled),
        smartTimingEnabled: parsed.smartTimingEnabled !== false,
        directStudioMode: Boolean(parsed.directStudioMode),
        customProjectId: typeof parsed.customProjectId === 'string' ? parsed.customProjectId.trim() : '',
        privacyStatus:
          parsed.privacyStatus === 'public' ||
          parsed.privacyStatus === 'private' ||
          parsed.privacyStatus === 'unlisted'
            ? parsed.privacyStatus
            : 'public',
        categoryId:
          typeof parsed.categoryId === 'string' && parsed.categoryId.trim()
            ? parsed.categoryId.trim()
            : '20',
        madeForKids: Boolean(parsed.madeForKids),
        channel: parsed.channel ?? normalizedSlots.find((s) => s.channel)?.channel ?? null,
        slots: normalizedSlots,
      };
    }
  } catch {
    prefs = { ...DEFAULT_PREFS };
  }
}

function savePrefs() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(YT_SETTINGS_FILE, JSON.stringify(prefs, null, 2), 'utf-8');
}

function createYouTubeClient(accessToken: string) {
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return google.youtube({ version: 'v3', auth: oauth2Client });
}

export function getYouTubeSettings(): YouTubeAutoUploadSettings {
  const oauthPool = getYouTubeOAuthPoolSummary();
  const slotsView: YouTubeApiSlot[] = prefs.slots.map((s) => ({
    slotId: s.slotId,
    connected: Boolean(slotTokens.has(s.slotId) && !s.tokenExpired),
    tokenExpired: s.tokenExpired,
    quotaExhausted: s.quotaExhausted,
    channel: s.channel,
  }));

  const anyConnected =
    slotsView.some((s) => s.connected && !s.quotaExhausted) ||
    hasAnyUsableYouTubeOAuthSlot();
  const primarySlot = prefs.slots.find((s) => slotTokens.has(s.slotId)) || prefs.slots[0];
  const poolChannel = oauthPool.slots.find((s) => s.channel)?.channel ?? null;

  return {
    connected: anyConnected,
    tokenExpired:
      !hasAnyUsableYouTubeOAuthSlot() && slotsView.every((s) => s.tokenExpired),
    autoUploadEnabled: prefs.autoUploadEnabled,
    smartTimingEnabled: prefs.smartTimingEnabled,
    directStudioMode: prefs.directStudioMode,
    slots: slotsView,
    oauthPool,
    privacyStatus: prefs.privacyStatus,
    categoryId: prefs.categoryId,
    madeForKids: prefs.madeForKids,
    channel: primarySlot?.channel ?? poolChannel ?? prefs.channel,
  };
}

export function hasActiveYouTubeToken(): boolean {
  return (
    hasAnyUsableYouTubeOAuthSlot() ||
    prefs.slots.some((s) => slotTokens.has(s.slotId) && !s.tokenExpired && !s.quotaExhausted)
  );
}

export function getActiveYouTubeToken(): string | null {
  for (const s of prefs.slots) {
    const token = slotTokens.get(s.slotId);
    if (token && !s.tokenExpired && !s.quotaExhausted) {
      return token;
    }
  }
  // Fallback to any connected token
  for (const s of prefs.slots) {
    const token = slotTokens.get(s.slotId);
    if (token) return token;
  }
  return null;
}

export async function connectYouTubeWithToken(
  accessToken: string,
  slotId = 1,
  patch?: Partial<
    Pick<
      PersistedYouTubePreferences,
      'autoUploadEnabled' | 'smartTimingEnabled' | 'directStudioMode' | 'privacyStatus' | 'categoryId' | 'madeForKids'
    >
  >
): Promise<YouTubeAutoUploadSettings> {
  const targetSlotId = Math.max(1, Math.min(3, slotId || 1));
  const youtube = createYouTubeClient(accessToken);

  try {
    const channelRes = await youtube.channels.list({
      part: ['snippet'],
      mine: true,
    });

    const first = channelRes.data.items?.[0];
    if (!first?.id) {
      throw new Error(
        `No YouTube channel is linked to Google Account (Slot ${targetSlotId}). Create a channel in YouTube Studio first, then authorize again.`
      );
    }

    const channel: YouTubeChannelInfo = {
      id: first.id,
      title: first.snippet?.title || `YouTube Channel #${targetSlotId}`,
      customUrl: first.snippet?.customUrl || undefined,
      thumbnailUrl: first.snippet?.thumbnails?.default?.url || undefined,
    };

    slotTokens.set(targetSlotId, accessToken);
    upsertFirebaseSlotInPool(targetSlotId, accessToken, channel);
    
    const slotRecord = prefs.slots.find((s) => s.slotId === targetSlotId);
    if (slotRecord) {
      slotRecord.tokenExpired = false;
      slotRecord.quotaExhausted = false;
      slotRecord.channel = channel;
    } else {
      prefs.slots.push({
        slotId: targetSlotId,
        tokenExpired: false,
        quotaExhausted: false,
        channel,
      });
    }

    if (targetSlotId === 1) {
      prefs.channel = channel;
    }

    if (patch) {
      applySettingsPatch(patch);
    } else {
      savePrefs();
    }

    return getYouTubeSettings();
  } catch (err) {
    const msg = extractGoogleApiError(err);
    throw new Error(msg);
  }
}

function applySettingsPatch(
  patch: Partial<
    Pick<
      PersistedYouTubePreferences,
      'autoUploadEnabled' | 'smartTimingEnabled' | 'directStudioMode' | 'customProjectId' | 'privacyStatus' | 'categoryId' | 'madeForKids'
    >
  >
) {
  if (typeof patch.autoUploadEnabled === 'boolean') {
    prefs.autoUploadEnabled = patch.autoUploadEnabled;
  }
  if (typeof patch.smartTimingEnabled === 'boolean') {
    prefs.smartTimingEnabled = patch.smartTimingEnabled;
  }
  if (typeof patch.directStudioMode === 'boolean') {
    prefs.directStudioMode = patch.directStudioMode;
  }
  if (typeof patch.customProjectId === 'string') {
    prefs.customProjectId = patch.customProjectId.trim();
  }
  if (
    patch.privacyStatus === 'private' ||
    patch.privacyStatus === 'unlisted' ||
    patch.privacyStatus === 'public'
  ) {
    prefs.privacyStatus = patch.privacyStatus;
  }
  if (typeof patch.categoryId === 'string' && patch.categoryId.trim()) {
    prefs.categoryId = patch.categoryId.trim();
  }
  if (typeof patch.madeForKids === 'boolean') {
    prefs.madeForKids = patch.madeForKids;
  }
  savePrefs();
}

export function updateYouTubeSettings(
  patch: Partial<
    Pick<
      PersistedYouTubePreferences,
      'autoUploadEnabled' | 'smartTimingEnabled' | 'directStudioMode' | 'customProjectId' | 'privacyStatus' | 'categoryId' | 'madeForKids'
    >
  >,
  accessTokenFromHeader?: string,
  slotId = 1
): YouTubeAutoUploadSettings {
  if (accessTokenFromHeader) {
    slotTokens.set(slotId, accessTokenFromHeader);
    const slotRecord = prefs.slots.find((s) => s.slotId === slotId);
    if (slotRecord) {
      slotRecord.tokenExpired = false;
      slotRecord.quotaExhausted = false;
      upsertFirebaseSlotInPool(slotId, accessTokenFromHeader, slotRecord.channel);
    } else {
      upsertFirebaseSlotInPool(slotId, accessTokenFromHeader, prefs.channel);
    }
  }
  applySettingsPatch(patch);
  return getYouTubeSettings();
}

export function disconnectYouTube(slotId?: number): YouTubeAutoUploadSettings {
  if (typeof slotId === 'number' && slotId >= 1 && slotId <= 3) {
    slotTokens.delete(slotId);
    removeFirebaseSlotFromPool(slotId);
    const slotRecord = prefs.slots.find((s) => s.slotId === slotId);
    if (slotRecord) {
      slotRecord.channel = null;
      slotRecord.tokenExpired = false;
      slotRecord.quotaExhausted = false;
    }
  } else {
    slotTokens.clear();
    removeFirebaseSlotFromPool();
    for (const s of prefs.slots) {
      s.channel = null;
      s.tokenExpired = false;
      s.quotaExhausted = false;
    }
    prefs.autoUploadEnabled = false;
    prefs.directStudioMode = false;
    prefs.channel = null;
  }
  savePrefs();
  return getYouTubeSettings();
}

export function markYouTubeTokenExpired(slotId?: number) {
  markFirebaseSlotExpiredInPool(slotId);
  if (typeof slotId === 'number') {
    slotTokens.delete(slotId);
    const s = prefs.slots.find((x) => x.slotId === slotId);
    if (s) s.tokenExpired = true;
  } else {
    slotTokens.clear();
    for (const s of prefs.slots) {
      s.tokenExpired = true;
    }
  }
}

function buildVideoTitle(clip: ClipItem): string {
  const isGta = /gta|grand theft auto/i.test(`${clip.streamLabel} ${clip.title}`);
  const clean = sanitizeTitleText(clip.title, {
    fallbackSummary: clip.momentSummary || clip.viralReason,
    formatMode: clip.formatMode,
    languageChoice: clip.languageChoice,
    isGtaContext: isGta,
  });
  if (clip.formatMode === 'long') {
    return clean.replace(/#Shorts/gi, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  }
  return clean.slice(0, 80);
}

function buildVideoDescription(clip: ClipItem): string {
  const isGta = /gta|grand theft auto/i.test(`${clip.streamLabel} ${clip.title} ${clip.description}`);
  const hashtagsList = sanitizeHashtags(clip.hashtags, {
    isGtaContext: isGta,
    formatMode: clip.formatMode,
    momentCategory: clip.category,
  });
  if (clip.formatMode === 'short' && !hashtagsList.some((h) => h.toLowerCase() === '#shorts') && hashtagsList.length < 6) {
    hashtagsList.push('#Shorts');
  }
  const baseDesc = clip.description?.trim() || clip.momentSummary?.trim() || clip.viralReason?.trim() || clip.title;
  const parts = /#bd\b/i.test(baseDesc)
    ? [baseDesc]
    : [baseDesc, '', hashtagsList.join(' ')];
  return parts.join('\n').slice(0, 4900);
}

function buildVideoTags(clip: ClipItem): string[] {
  const isGta = /gta|grand theft auto/i.test(`${clip.streamLabel} ${clip.title} ${clip.description}`);
  const cleaned = sanitizeSeoTags(clip.tags, {
    isGtaContext: isGta,
    formatMode: clip.formatMode,
  });
  const extras = clip.formatMode === 'short' ? ['Shorts', 'YouTubeShorts'] : ['Gameplay', 'Highlights'];
  const combined = Array.from(new Set([...cleaned, ...extras].filter(Boolean)));

  const accepted: string[] = [];
  let charBudget = 0;
  for (const tag of combined) {
    const clean = tag.replace(/[<>]/g, '').slice(0, 60);
    if (!clean) continue;
    const cost = clean.includes(' ') ? clean.length + 3 : clean.length + 1;
    if (charBudget + cost > 460) break;
    accepted.push(clean);
    charBudget += cost;
  }
  return accepted;
}

function extractGoogleApiError(err: unknown): string {
  if (err && typeof err === 'object') {
    const anyErr = err as {
      code?: number;
      status?: number;
      message?: string;
      response?: { status?: number; data?: { error?: { message?: string; errors?: Array<{ reason?: string; message?: string }> } } };
    };
    const apiMsg =
      anyErr.response?.data?.error?.message ||
      anyErr.response?.data?.error?.errors?.[0]?.message ||
      anyErr.message;
    const reason = anyErr.response?.data?.error?.errors?.[0]?.reason;
    const status = anyErr.response?.status || anyErr.status || anyErr.code;

    if (status === 401 || reason === 'authError') {
      return 'YouTube OAuth authorization expired (401). Sign in with Google again.';
    }
    if (
      reason === 'uploadLimitExceeded' ||
      reason === 'quotaExceeded' ||
      (apiMsg && apiMsg.toLowerCase().includes('quota exceeded'))
    ) {
      return 'YouTube Data API daily upload quota exceeded on this API Slot. Automatic failover rotated to next available slot, or switch to Direct YouTube Studio Upload Mode.';
    }
    if (
      (apiMsg && apiMsg.toLowerCase().includes('insufficient')) ||
      reason === 'insufficientPermissions' ||
      status === 403
    ) {
      if (apiMsg && apiMsg.toLowerCase().includes('scope')) {
        return 'YouTube OAuth authentication has insufficient scopes. Please click "Reconnect / Re-Authorize YouTube" in Setup to grant full YouTube Live & Chat permissions.';
      }
      return `Google denied YouTube permission (${apiMsg || reason || '403'}). Reconnect your YouTube account with full scopes in Setup.`;
    }
    if (apiMsg) {
      return apiMsg;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

export async function uploadClipToYouTube(params: {
  clip: ClipItem;
  filePath: string;
  thumbnailPath?: string | null;
  accessToken?: string;
  privacyStatus?: YouTubePrivacyStatus;
  categoryId?: string;
  madeForKids?: boolean;
  existingScheduleTimestamps?: number[];
  onLog?: (level: 'info' | 'warn' | 'success', msg: string) => void;
}): Promise<{
  videoId: string;
  url: string;
  privacyStatus: YouTubePrivacyStatus;
  uploadedAt: string;
  slotIdUsed: number;
  thumbnailSet: boolean;
  thumbnailWarning?: string;
  scheduledPublishAt?: string;
  timingAnalysis: YouTubeTimingAnalysis;
}> {
  const { clip, filePath, thumbnailPath } = params;
  if (!fs.existsSync(filePath)) {
    throw new Error('Rendered MP4 file is missing on disk.');
  }

  const privacyStatus = params.privacyStatus ?? prefs.privacyStatus;
  const categoryId = params.categoryId ?? prefs.categoryId;
  const madeForKids = params.madeForKids ?? prefs.madeForKids;

  if (!params.accessToken && !hasAnyUsableYouTubeOAuthSlot()) {
    throw new Error(
      'No authorized YouTube OAuth slot is ready. Connect a Google Cloud OAuth2 credential or Sign in with Google in System Setup.'
    );
  }

  // Step 1: Run pre-upload Trend Timing Intelligence via pooled YouTube executor
  let timingAnalysis = await analyzeOptimalUploadTiming({
    bearerTokenFallback: params.accessToken,
    clip,
    existingScheduleTimestamps: params.existingScheduleTimestamps || [],
    requestedPrivacy: privacyStatus,
    smartTimingEnabled: prefs.smartTimingEnabled,
    onLog: params.onLog,
  });

  if (timingAnalysis.decision === 'scheduled' && timingAnalysis.scheduledPublishAt) {
    params.onLog?.(
      'success',
      `Trend Timing: Peak window ${timingAnalysis.peakAudienceLabel} (${timingAnalysis.analyzedVideoCount} real videos checked). Scheduling upload for ${timingAnalysis.scheduledPublishAt} (${timingAnalysis.queueSpacingMinutes}m spacing).`
    );
  } else {
    params.onLog?.(
      'info',
      `Trend Timing (${timingAnalysis.decision}): ${timingAnalysis.reasoning}`
    );
  }

  const useScheduledPublishAt = Boolean(
    timingAnalysis.decision === 'scheduled' &&
      timingAnalysis.scheduledPublishAt &&
      privacyStatus === 'public'
  );

  // Step 2: Upload MP4 + Custom Thumbnail through the Multi-Project OAuth Pool with zero-drop failover
  const { result: uploadData, slotIdUsed, slotLabel } = await executeWithYouTubeOAuthPool({
    operationName: `videos.insert (${clip.title.slice(0, 40)})`,
    estimatedQuotaUnits: 1650,
    bearerTokenFallback: params.accessToken,
    onLog: params.onLog,
    fn: async (youtube) => {
      const performInsert = async (scheduledAt?: string) => {
        const effectiveBodyPrivacy: YouTubePrivacyStatus = scheduledAt ? 'private' : privacyStatus;
        return youtube.videos.insert({
          part: ['snippet', 'status'],
          notifySubscribers: !scheduledAt && effectiveBodyPrivacy === 'public',
          requestBody: {
            snippet: {
              title: buildVideoTitle(clip),
              description: buildVideoDescription(clip),
              tags: buildVideoTags(clip),
              categoryId,
            },
            status: {
              privacyStatus: effectiveBodyPrivacy,
              ...(scheduledAt ? { publishAt: scheduledAt } : {}),
              selfDeclaredMadeForKids: madeForKids,
            },
          },
          media: {
            mimeType: 'video/mp4',
            body: fs.createReadStream(filePath),
          },
        });
      };

      let response;
      let activeScheduledAt = useScheduledPublishAt ? timingAnalysis.scheduledPublishAt : undefined;

      try {
        response = await performInsert(activeScheduledAt);
      } catch (insertErr) {
        const errInfo = classifyGoogleError(insertErr);
        const isPublishAtRejection =
          Boolean(activeScheduledAt) &&
          (errInfo.message.toLowerCase().includes('publishat') ||
            errInfo.message.toLowerCase().includes('publish_at') ||
            errInfo.message.toLowerCase().includes('scheduled'));

        if (isPublishAtRejection) {
          params.onLog?.(
            'warn',
            `YouTube rejected publishAt scheduling (${errInfo.message}). Falling back cleanly to immediate upload.`
          );
          timingAnalysis = {
            ...timingAnalysis,
            decision: 'fallback_immediate',
            scheduledPublishAt: undefined,
            fallbackReason: errInfo.message,
          };
          activeScheduledAt = undefined;
          response = await performInsert(undefined);
        } else {
          throw insertErr;
        }
      }

      const videoId = response.data.id;
      if (!videoId) {
        throw new Error('YouTube Data API did not return a video ID after upload.');
      }

      let thumbnailSet = false;
      let thumbnailWarning: string | undefined;

      if (thumbnailPath && fs.existsSync(thumbnailPath)) {
        try {
          await youtube.thumbnails.set({
            videoId,
            media: {
              mimeType: 'image/jpeg',
              body: fs.createReadStream(thumbnailPath),
            },
          });
          thumbnailSet = true;
        } catch (thumbErr) {
          const thumbInfo = classifyGoogleError(thumbErr);
          if (thumbInfo.isQuota) {
            params.onLog?.(
              'warn',
              `thumbnails.set hit quota on current slot after video upload; video published (${videoId}), thumbnail skipped (${thumbInfo.message}).`
            );
          }
          thumbnailWarning = thumbInfo.message;
        }
      }

      const actualPrivacy = response.data.status?.privacyStatus;
      const effectivePrivacy: YouTubePrivacyStatus =
        actualPrivacy === 'public' ||
        actualPrivacy === 'unlisted' ||
        actualPrivacy === 'private'
          ? actualPrivacy
          : activeScheduledAt
          ? 'private'
          : privacyStatus;

      return {
        videoId,
        effectivePrivacy,
        thumbnailSet,
        thumbnailWarning,
        activeScheduledAt,
      };
    },
  });

  params.onLog?.(
    'success',
    `YouTube upload executed using OAuth Pool slot "${slotLabel}".`
  );

  const numericSlotMatch = slotIdUsed.match(/(\d+)$/);
  const slotNum = numericSlotMatch ? Number(numericSlotMatch[1]) : 1;

  const url =
    clip.formatMode === 'long'
      ? `https://www.youtube.com/watch?v=${uploadData.videoId}`
      : `https://www.youtube.com/shorts/${uploadData.videoId}`;

  return {
    videoId: uploadData.videoId,
    url,
    privacyStatus: uploadData.effectivePrivacy,
    uploadedAt: new Date().toISOString(),
    slotIdUsed: slotNum,
    thumbnailSet: uploadData.thumbnailSet,
    thumbnailWarning: uploadData.thumbnailWarning,
    scheduledPublishAt: uploadData.activeScheduledAt,
    timingAnalysis,
  };
}

