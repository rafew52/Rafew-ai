import type { youtube_v3 } from 'googleapis';
import type {
  ClipItem,
  YouTubePrivacyStatus,
  YouTubeTimingAnalysis,
} from '../src/types.ts';
import { getActiveAiProvider } from './aiRouter.ts';
import { callClaudeWithRetry, isClaudeConfigured } from './claude.ts';
import { generateGeminiTextResponse, isGeminiConfigured } from './gemini.ts';
import { executeWithYouTubeOAuthPool } from './youtubeOAuthPool.ts';

const MIN_QUEUE_SPACING_MINUTES = 40;
const MIN_SCHEDULE_LEAD_MINUTES = 20;
const SEARCH_CACHE_TTL_MS = 10 * 60_000;
const searchSampleCache = new Map<string, { fetchedAtMs: number; sampled: SampledYouTubeVideo[] }>();

interface SampledYouTubeVideo {
  id: string;
  title: string;
  publishedAt: string;
  publishHourUtc: number;
  hoursOld: number;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  velocityPerHour: number;
  engagementPct: number;
}

function formatUtcAndBdHour(utcHour: number): string {
  const hUtc = ((Math.floor(utcHour) % 24) + 24) % 24;
  const hBd = (hUtc + 6) % 24;
  const fmt = (h: number) => {
    const suffix = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:00 ${suffix}`;
  };
  return `${String(hUtc).padStart(2, '0')}:00 UTC (${fmt(hBd)} BD)`;
}

function buildSearchQueriesFromClip(clip: ClipItem): string[] {
  const queries: string[] = [];
  const rawTitle = (clip.title || '')
    .replace(/#Shorts/gi, '')
    .replace(/#BD/gi, '')
    .replace(/#GTA6HUB/gi, '')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const cleanTags = (clip.tags || [])
    .map((t) => t.replace(/^#/, '').trim())
    .filter((t) => t.length >= 2 && !/^shorts$/i.test(t) && !/^bd$/i.test(t));

  const topicTerms = rawTitle.split(' ').filter((w) => w.length >= 3).slice(0, 4).join(' ');
  const isBanglaContent =
    clip.languageChoice === 'bengali' ||
    clip.languageChoice === 'banglish' ||
    clip.hashtags.some((h) => h.toLowerCase() === '#bd');

  const q1Parts = [
    cleanTags[0] || 'GTA 6',
    topicTerms || cleanTags[1] || 'gameplay',
    clip.formatMode === 'short' ? 'shorts' : 'gameplay',
  ].filter(Boolean);
  queries.push(q1Parts.join(' ').slice(0, 80));

  const q2 = isBanglaContent
    ? `${cleanTags[0] || 'GTA'} Bangla gaming BD${clip.formatMode === 'short' ? ' shorts' : ''}`
    : `${cleanTags[0] || 'GTA 6'} ${clip.category.replace(/_/g, ' ')} viral`;
  if (q2.toLowerCase() !== queries[0].toLowerCase()) {
    queries.push(q2.slice(0, 80));
  }

  return Array.from(new Set(queries.filter(Boolean))).slice(0, 2);
}

function extractApiErrorReason(err: unknown): {
  message: string;
  isQuota: boolean;
} {
  if (err && typeof err === 'object') {
    const anyErr = err as {
      status?: number;
      code?: number;
      message?: string;
      response?: {
        status?: number;
        data?: { error?: { message?: string; errors?: Array<{ reason?: string; message?: string }> } };
      };
    };
    const msg =
      anyErr.response?.data?.error?.message ||
      anyErr.response?.data?.error?.errors?.[0]?.message ||
      anyErr.message ||
      String(err);
    const reason = anyErr.response?.data?.error?.errors?.[0]?.reason || '';
    const isQuota =
      reason === 'quotaExceeded' ||
      reason === 'dailyLimitExceeded' ||
      msg.toLowerCase().includes('quota');
    return { message: msg, isQuota };
  }
  const msg = String(err);
  return { message: msg, isQuota: msg.toLowerCase().includes('quota') };
}

function circularHourDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 24;
  return Math.min(diff, 24 - diff);
}

function nextSlotTimestampForPeakHour(
  nowMs: number,
  peakHourUtc: number,
  existingTimestamps: number[]
): { scheduledMs: number; spacingMinutes: number } {
  const minLeadMs = nowMs + MIN_SCHEDULE_LEAD_MINUTES * 60_000;
  const candidate = new Date(minLeadMs);
  candidate.setUTCMinutes(0, 0, 0);

  // Advance to the next occurrence of peakHourUtc that is >= minLeadMs
  for (let h = 0; h < 26; h += 1) {
    if (candidate.getUTCHours() === peakHourUtc && candidate.getTime() >= minLeadMs) {
      break;
    }
    candidate.setUTCHours(candidate.getUTCHours() + 1);
  }

  let slotMs = candidate.getTime();
  const minGapMs = MIN_QUEUE_SPACING_MINUTES * 60_000;

  // Enforce minimum spacing against already queued/scheduled/recent uploads
  const sortedExisting = [...existingTimestamps].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  for (let guard = 0; guard < 36; guard += 1) {
    const collision = sortedExisting.find((ts) => Math.abs(ts - slotMs) < minGapMs);
    if (!collision) break;
    slotMs = Math.max(slotMs + minGapMs, collision + minGapMs);
  }

  let nearestGapMin = MIN_QUEUE_SPACING_MINUTES;
  if (sortedExisting.length > 0) {
    const minDistMs = Math.min(...sortedExisting.map((t) => Math.abs(t - slotMs)));
    nearestGapMin = Math.round(minDistMs / 60_000);
  }

  return { scheduledMs: slotMs, spacingMinutes: nearestGapMin };
}

async function generateFactualTimingReasoning(facts: {
  queries: string[];
  analyzedVideoCount: number;
  peakAudienceLabel: string;
  topSampledVelocity: number;
  avgNicheEngagementPct: number;
  decision: YouTubeTimingAnalysis['decision'];
  scheduledPublishAt?: string;
  queueSpacingMinutes: number;
  fallbackReason?: string;
}): Promise<string> {
  const deterministic =
    facts.decision === 'scheduled' && facts.scheduledPublishAt
      ? `Analyzed ${facts.analyzedVideoCount} real YouTube videos across [${facts.queries.join(
          ', '
        )}]. Peak niche publish window is ${facts.peakAudienceLabel} (top velocity ${Math.round(
          facts.topSampledVelocity
        )} views/hr, avg engagement ${facts.avgNicheEngagementPct.toFixed(
          2
        )}%). Scheduled for ${facts.scheduledPublishAt} with ${facts.queueSpacingMinutes}m queue spacing.`
      : `Analyzed ${facts.analyzedVideoCount} real YouTube videos across [${facts.queries.join(
          ', '
        )}]. Current hour aligns with active niche window ${facts.peakAudienceLabel} (top velocity ${Math.round(
          facts.topSampledVelocity
        )} views/hr), so publishing immediately.`;

  const prompt = [
    `Write a single concise 2-sentence YouTube upload timing explanation strictly using ONLY the verified metrics below (do not invent any numbers):`,
    JSON.stringify(facts),
    `Return plain text only.`,
  ].join('\n');

  try {
    const provider = getActiveAiProvider();
    if (provider === 'claude' && isClaudeConfigured()) {
      const txt = await callClaudeWithRetry(
        prompt,
        'You are a factual YouTube growth analyst. Only cite provided numbers.',
        220
      );
      if (txt.trim()) return txt.trim().slice(0, 340);
    }
    if (isGeminiConfigured()) {
      const txt = await generateGeminiTextResponse(
        prompt,
        'You are a factual YouTube growth analyst. Only cite provided numbers.'
      );
      if (txt.trim()) return txt.trim().slice(0, 340);
    }
  } catch {
    // Fall back deterministically to factual summary
  }

  return deterministic;
}

export async function analyzeOptimalUploadTiming(params: {
  youtube?: youtube_v3.Youtube;
  bearerTokenFallback?: string;
  clip: ClipItem;
  existingScheduleTimestamps: number[];
  requestedPrivacy: YouTubePrivacyStatus;
  smartTimingEnabled: boolean;
  onLog?: (level: 'info' | 'warn' | 'success', msg: string) => void;
}): Promise<YouTubeTimingAnalysis> {
  const analyzedAt = new Date().toISOString();
  const queries = buildSearchQueriesFromClip(params.clip);

  if (!params.smartTimingEnabled) {
    return {
      decision: 'publish_now',
      analyzedAt,
      queries,
      analyzedVideoCount: 0,
      peakAudienceHourUtc: null,
      peakAudienceLabel: 'Immediate (Smart Timing Disabled)',
      topSampledVelocity: 0,
      avgNicheEngagementPct: 0,
      queueSpacingMinutes: 0,
      reasoning: 'Smart Trend Timing is disabled; uploading immediately with configured privacy status.',
      apiStatus: 'disabled',
    };
  }

  params.onLog?.(
    'info',
    `YouTube Trend Intelligence: searching niche keywords [${queries.join(' | ')}] via YouTube Data API v3...`
  );

  try {
    const nowMs = Date.now();
    const cacheKey = queries.join('|').toLowerCase();
    const cached = searchSampleCache.get(cacheKey);
    let sampled: SampledYouTubeVideo[];

    if (cached && nowMs - cached.fetchedAtMs < SEARCH_CACHE_TTL_MS && cached.sampled.length > 0) {
      sampled = cached.sampled;
      params.onLog?.(
        'info',
        `YouTube Trend Intelligence: reusing recent real niche sample (${sampled.length} videos) to conserve API quota.`
      );
    } else {
      const fetchRealVideos = async (yt: youtube_v3.Youtube): Promise<SampledYouTubeVideo[]> => {
        const sevenDaysAgoIso = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
        const collectedIds = new Set<string>();

        for (const q of queries) {
          const searchRes = await yt.search.list({
            part: ['snippet'],
            q,
            type: ['video'],
            order: 'viewCount',
            publishedAfter: sevenDaysAgoIso,
            maxResults: 12,
          });
          for (const item of searchRes.data.items || []) {
            if (item.id?.videoId) {
              collectedIds.add(item.id.videoId);
            }
          }
          if (collectedIds.size >= 16) break;
        }

        const videoIds = Array.from(collectedIds).slice(0, 20);
        if (videoIds.length === 0) {
          return [];
        }

        // Single batched videos.list call (1 quota unit for up to 50 IDs)
        const statsRes = await yt.videos.list({
          part: ['snippet', 'statistics'],
          id: videoIds,
        });

        const parsedList: SampledYouTubeVideo[] = [];
        for (const item of statsRes.data.items || []) {
          const publishedAt = item.snippet?.publishedAt;
          if (!item.id || !publishedAt) continue;
          const pubMs = Date.parse(publishedAt);
          if (Number.isNaN(pubMs)) continue;

          const hoursOld = Math.max(1, (Date.now() - pubMs) / 3_600_000);
          const viewCount = Number(item.statistics?.viewCount || 0);
          const likeCount = Number(item.statistics?.likeCount || 0);
          const commentCount = Number(item.statistics?.commentCount || 0);
          const velocityPerHour = viewCount / hoursOld;
          const engagementPct = viewCount > 0 ? ((likeCount + commentCount) / viewCount) * 100 : 0;

          parsedList.push({
            id: item.id,
            title: item.snippet?.title || '',
            publishedAt,
            publishHourUtc: new Date(pubMs).getUTCHours(),
            hoursOld,
            viewCount,
            likeCount,
            commentCount,
            velocityPerHour,
            engagementPct,
          });
        }
        return parsedList;
      };

      if (params.youtube) {
        sampled = await fetchRealVideos(params.youtube);
      } else {
        const exec = await executeWithYouTubeOAuthPool({
          operationName: 'youtubeTiming.search',
          estimatedQuotaUnits: queries.length * 100 + 1,
          bearerTokenFallback: params.bearerTokenFallback,
          apiKeyFallback:
            process.env.YOUTUBE_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || undefined,
          onLog: params.onLog,
          fn: async (yt) => fetchRealVideos(yt),
        });
        sampled = exec.result;
      }

      if (sampled.length > 0) {
        searchSampleCache.set(cacheKey, { fetchedAtMs: nowMs, sampled });
      }
    }

    if (sampled.length === 0) {
      return {
        decision: 'fallback_immediate',
        analyzedAt,
        queries,
        analyzedVideoCount: 0,
        peakAudienceHourUtc: null,
        peakAudienceLabel: 'No recent niche videos returned',
        topSampledVelocity: 0,
        avgNicheEngagementPct: 0,
        queueSpacingMinutes: 0,
        reasoning: `YouTube search for [${queries.join(', ')}] returned 0 recent videos; publishing immediately.`,
        apiStatus: 'ok',
        fallbackReason: 'Search returned 0 recent videos for topic keywords.',
      };
    }

    // Group real videos by UTC publish hour and score hourly velocity + engagement
    const hourBuckets = new Map<number, { totalVelocity: number; totalEng: number; count: number }>();
    for (const v of sampled) {
      const bucket = hourBuckets.get(v.publishHourUtc) || {
        totalVelocity: 0,
        totalEng: 0,
        count: 0,
      };
      bucket.totalVelocity += v.velocityPerHour;
      bucket.totalEng += v.engagementPct;
      bucket.count += 1;
      hourBuckets.set(v.publishHourUtc, bucket);
    }

    let peakAudienceHourUtc = sampled[0].publishHourUtc;
    let bestHourScore = -1;

    for (const [hourUtc, bucket] of hourBuckets.entries()) {
      const avgVel = bucket.totalVelocity / bucket.count;
      const avgEng = bucket.totalEng / bucket.count;
      const score = avgVel * (1 + avgEng / 100);
      if (score > bestHourScore) {
        bestHourScore = score;
        peakAudienceHourUtc = hourUtc;
      }
    }

    const peakAudienceLabel = formatUtcAndBdHour(peakAudienceHourUtc);
    const topSampledVelocity = Math.max(...sampled.map((v) => v.velocityPerHour));
    const avgNicheEngagementPct =
      sampled.reduce((sum, v) => sum + v.engagementPct, 0) / sampled.length;

    const currentUtcHour = new Date(nowMs).getUTCHours();
    const minQueueGapMs = MIN_QUEUE_SPACING_MINUTES * 60_000;
    const recentCollisionNow = params.existingScheduleTimestamps.some(
      (ts) => Math.abs(nowMs - ts) < minQueueGapMs
    );

    const isNowInPeakWindow = circularHourDistance(currentUtcHour, peakAudienceHourUtc) <= 1;

    // YouTube API publishAt scheduling only works when targeting public release (starts private -> publishes public)
    if (params.requestedPrivacy !== 'public') {
      const reasoning = await generateFactualTimingReasoning({
        queries,
        analyzedVideoCount: sampled.length,
        peakAudienceLabel,
        topSampledVelocity,
        avgNicheEngagementPct,
        decision: 'publish_now',
        queueSpacingMinutes: 0,
      });
      return {
        decision: 'publish_now',
        analyzedAt,
        queries,
        analyzedVideoCount: sampled.length,
        peakAudienceHourUtc,
        peakAudienceLabel,
        topSampledVelocity: Number(topSampledVelocity.toFixed(1)),
        avgNicheEngagementPct: Number(avgNicheEngagementPct.toFixed(2)),
        queueSpacingMinutes: 0,
        reasoning: `${reasoning} Uploaded directly because privacy is set to "${params.requestedPrivacy}".`,
        apiStatus: 'ok',
      };
    }

    if (isNowInPeakWindow && !recentCollisionNow) {
      const reasoning = await generateFactualTimingReasoning({
        queries,
        analyzedVideoCount: sampled.length,
        peakAudienceLabel,
        topSampledVelocity,
        avgNicheEngagementPct,
        decision: 'publish_now',
        queueSpacingMinutes: MIN_QUEUE_SPACING_MINUTES,
      });
      return {
        decision: 'publish_now',
        analyzedAt,
        queries,
        analyzedVideoCount: sampled.length,
        peakAudienceHourUtc,
        peakAudienceLabel,
        topSampledVelocity: Number(topSampledVelocity.toFixed(1)),
        avgNicheEngagementPct: Number(avgNicheEngagementPct.toFixed(2)),
        queueSpacingMinutes: MIN_QUEUE_SPACING_MINUTES,
        reasoning,
        apiStatus: 'ok',
      };
    }

    const { scheduledMs, spacingMinutes } = nextSlotTimestampForPeakHour(
      nowMs,
      peakAudienceHourUtc,
      params.existingScheduleTimestamps
    );
    const scheduledPublishAt = new Date(scheduledMs).toISOString();

    const reasoning = await generateFactualTimingReasoning({
      queries,
      analyzedVideoCount: sampled.length,
      peakAudienceLabel,
      topSampledVelocity,
      avgNicheEngagementPct,
      decision: 'scheduled',
      scheduledPublishAt,
      queueSpacingMinutes: spacingMinutes,
    });

    return {
      decision: 'scheduled',
      analyzedAt,
      queries,
      analyzedVideoCount: sampled.length,
      peakAudienceHourUtc,
      peakAudienceLabel,
      topSampledVelocity: Number(topSampledVelocity.toFixed(1)),
      avgNicheEngagementPct: Number(avgNicheEngagementPct.toFixed(2)),
      scheduledPublishAt,
      queueSpacingMinutes: spacingMinutes,
      reasoning,
      apiStatus: 'ok',
    };
  } catch (err) {
    const { message, isQuota } = extractApiErrorReason(err);
    params.onLog?.(
      'warn',
      `YouTube Search timing intelligence unavailable (${message}). Falling back to immediate upload.`
    );
    return {
      decision: 'fallback_immediate',
      analyzedAt,
      queries,
      analyzedVideoCount: 0,
      peakAudienceHourUtc: null,
      peakAudienceLabel: isQuota ? 'Search Quota Exhausted' : 'Search API Unavailable',
      topSampledVelocity: 0,
      avgNicheEngagementPct: 0,
      queueSpacingMinutes: 0,
      reasoning: `Real YouTube Search analysis could not run (${message}). Proceeded cleanly with immediate upload without simulated scheduling.`,
      apiStatus: isQuota ? 'quota_exceeded' : 'unavailable',
      fallbackReason: message,
    };
  }
}
