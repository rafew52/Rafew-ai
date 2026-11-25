import { type youtube_v3 } from 'googleapis';
import type {
  IdeaCandidateVideo,
  IdeaLanguagePreference,
  IdeaSearchResult,
} from '../src/types.ts';
import { getActiveAiProvider } from './aiRouter.ts';
import {
  callClaudeWithRetry,
  generateClaudeJson,
  isClaudeConfigured,
} from './claude.ts';
import { generateGeminiTextResponse, isGeminiConfigured } from './gemini.ts';
import {
  checkStrictCandidateMatch,
  formatRequirementSummary,
  parseRequirementSpec,
  type ParsedRequirementContext,
} from './requirementEngine.ts';
import {
  AllYouTubeQuotaExhaustedError,
  executeWithYouTubeOAuthPool,
  hasAnyUsableYouTubeOAuthSlot,
} from './youtubeOAuthPool.ts';
import { hasActiveZernioAuth } from './zernio.ts';

function parseIso8601DurationSeconds(iso?: string | null): number {
  if (!iso || typeof iso !== 'string') return 0;
  const match = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) return 0;
  const h = Number(match[1] || 0);
  const m = Number(match[2] || 0);
  const s = Number(match[3] || 0);
  return h * 3600 + m * 60 + s;
}

function formatDurationLabel(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function getApiKeyFallback(): string {
  return (
    process.env.YOUTUBE_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    ''
  );
}

function extractYouTubeErrorDetails(err: unknown): {
  message: string;
  isQuota: boolean;
  isAuth: boolean;
} {
  if (err && typeof err === 'object') {
    const anyErr = err as {
      status?: number;
      code?: number;
      message?: string;
      response?: {
        status?: number;
        data?: {
          error?: {
            code?: number;
            message?: string;
            errors?: Array<{ reason?: string; message?: string }>;
          };
        };
      };
    };
    const status = anyErr.response?.status || anyErr.status || anyErr.code;
    const reason = anyErr.response?.data?.error?.errors?.[0]?.reason || '';
    const msg =
      anyErr.response?.data?.error?.message ||
      anyErr.response?.data?.error?.errors?.[0]?.message ||
      anyErr.message ||
      String(err);
    const lower = `${reason} ${msg}`.toLowerCase();
    const isQuota =
      reason === 'quotaExceeded' ||
      reason === 'dailyLimitExceeded' ||
      lower.includes('quota');
    const isAuth =
      status === 401 ||
      (status === 403 &&
        (lower.includes('insufficient') ||
          lower.includes('scope') ||
          lower.includes('api key') ||
          lower.includes('unauthenticated')));
    return { message: msg, isQuota, isAuth };
  }
  const msg = String(err);
  const lower = msg.toLowerCase();
  return {
    message: msg,
    isQuota: lower.includes('quota'),
    isAuth: lower.includes('unauthenticated') || lower.includes('insufficient'),
  };
}

function buildDeterministicSearchQueries(params: {
  idea: string;
  categories: string[];
  languagePreference: IdeaLanguagePreference;
}): {
  queries: string[];
  relevanceLanguage?: string;
  regionCode?: string;
} {
  const cleanIdea = params.idea.trim();
  const lockedNiches = params.categories
    .filter((c) => c && c.toLowerCase() !== 'other')
    .slice(0, 2);
  const catPrefix = lockedNiches.join(' ');
  const ideaLower = cleanIdea.toLowerCase();

  // Only append niche words not already present in idea to keep query tight and faithful
  const missingCatTokens = lockedNiches.filter((c) => !ideaLower.includes(c.toLowerCase())).join(' ');
  const anchoredBase = [missingCatTokens, cleanIdea].filter(Boolean).join(' ').trim();

  const langSuffix =
    params.languagePreference === 'bengali'
      ? 'Bangla'
      : params.languagePreference === 'banglish'
      ? 'Bangla'
      : params.languagePreference === 'english'
      ? 'English'
      : '';

  const needsLangSuffix =
    langSuffix && !new RegExp(`\\b${langSuffix}\\b`, 'i').test(anchoredBase);

  const q1 = [anchoredBase, needsLangSuffix ? langSuffix : '']
    .filter(Boolean)
    .join(' ')
    .trim()
    .slice(0, 95);
  const q2 = [anchoredBase, 'gameplay', needsLangSuffix ? langSuffix : '']
    .filter(Boolean)
    .join(' ')
    .trim()
    .slice(0, 95);
  const q3 =
    params.languagePreference === 'bengali' || params.languagePreference === 'banglish'
      ? [anchoredBase, 'BD', 'highlights'].filter(Boolean).join(' ').trim().slice(0, 95)
      : [anchoredBase, 'full video'].filter(Boolean).join(' ').trim().slice(0, 95);

  const queries = Array.from(new Set([q1, q2, q3].filter(Boolean))).slice(0, 3);
  const isBangla =
    params.languagePreference === 'bengali' ||
    params.languagePreference === 'banglish' ||
    /bangla|bengali|\bbd\b|[\u0980-\u09FF]/i.test(`${cleanIdea} ${catPrefix}`);

  return {
    queries,
    relevanceLanguage:
      params.languagePreference === 'bengali' || params.languagePreference === 'banglish'
        ? 'bn'
        : params.languagePreference === 'english'
        ? 'en'
        : undefined,
    regionCode: isBangla ? 'BD' : undefined,
  };
}

async function expandIdeaWithAi(params: {
  idea: string;
  categories: string[];
  languagePreference: IdeaLanguagePreference;
}): Promise<{
  queries: string[];
  relevanceLanguage?: string;
  regionCode?: string;
}> {
  const fallback = buildDeterministicSearchQueries(params);
  const provider = getActiveAiProvider();

  const systemPrompt =
    'You are a strict Requirement-Locked YouTube Search Strategist. Generate queries strictly anchored to the exact user topic, locked niches, and language. NEVER drift into unrequested games, unrelated themes, or different topics. Return valid JSON only.';
  const prompt = `User Video Idea (HARD BOUNDARY): "${params.idea}"
Locked Categories/Niches (MUST RESPECT): ${JSON.stringify(params.categories)}
Language Lock: ${params.languagePreference}

Generate 3 distinct, tightly-anchored YouTube search queries matching ONLY this exact topic, niche(s), and language (avoid "#shorts" so we find clip-rich videos >=45s).
Do NOT introduce other games or unrelated themes not present in the idea or categories.
Indicate optional relevanceLanguage ("bn" or "en" or null) and regionCode ("BD" if Bangla/Banglish/BD fits, otherwise null).

Return JSON:
{
  "queries": ["query 1", "query 2", "query 3"],
  "relevanceLanguage": "bn" | "en" | null,
  "regionCode": "BD" | null
}`;

  try {
    let parsed: {
      queries?: unknown;
      relevanceLanguage?: string | null;
      regionCode?: string | null;
    } | null = null;

    if (provider === 'claude' && isClaudeConfigured()) {
      parsed = await generateClaudeJson(prompt, systemPrompt);
    } else if (isGeminiConfigured()) {
      const txt = await generateGeminiTextResponse(
        `${prompt}\nReturn JSON only without markdown fences.`,
        systemPrompt
      );
      const cleaned = txt.replace(/```json/gi, '').replace(/```/g, '').trim();
      const first = cleaned.indexOf('{');
      const last = cleaned.lastIndexOf('}');
      if (first !== -1 && last > first) {
        parsed = JSON.parse(cleaned.slice(first, last + 1));
      }
    }

    if (parsed && Array.isArray(parsed.queries)) {
      const aiQueries = parsed.queries
        .map((q) => (typeof q === 'string' ? q.trim() : ''))
        .filter((q) => q.length >= 2)
        .slice(0, 3);
      if (aiQueries.length > 0) {
        // Keep deterministic q1 first if AI queries drift away from the user's primary words
        return {
          queries: Array.from(new Set([fallback.queries[0], ...aiQueries])).slice(0, 3),
          relevanceLanguage:
            parsed.relevanceLanguage === 'bn' || parsed.relevanceLanguage === 'en'
              ? parsed.relevanceLanguage
              : fallback.relevanceLanguage,
          regionCode:
            typeof parsed.regionCode === 'string' && /^[A-Z]{2}$/.test(parsed.regionCode.trim())
              ? parsed.regionCode.trim()
              : fallback.regionCode,
        };
      }
    }
  } catch {
    // Clean deterministic fallback below
  }

  return fallback;
}

function computeTopicAlignmentScore(params: {
  title: string;
  description: string;
  tags: string[];
  channelTitle: string;
  defaultAudioLanguage?: string;
  idea: string;
  categories: string[];
  languagePreference: IdeaLanguagePreference;
}): number {
  const haystack = `${params.title} ${params.description.slice(0, 350)} ${params.tags.join(' ')} ${params.channelTitle}`.toLowerCase();
  const rawTokens = `${params.idea} ${params.categories.filter((c) => c !== 'Other').join(' ')}`
    .toLowerCase()
    .split(/[\s,.;:!?/\\|()[\]{}"']+/)
    .filter((t) => t.length >= 2);

  const uniqueTokens = Array.from(new Set(rawTokens)).slice(0, 14);
  let tokenHits = 0;
  for (const tok of uniqueTokens) {
    if (haystack.includes(tok)) {
      tokenHits += 1;
    }
  }
  const tokenRatio = uniqueTokens.length > 0 ? tokenHits / uniqueTokens.length : 0.5;
  let score = tokenRatio * 26;

  // Language alignment bonus (max +9, total max 35)
  const hasBengaliScript = /[\u0980-\u09FF]/.test(params.title + params.description);
  const hasBanglaCue = /bangla|bengali|bd|bangladesh/i.test(haystack) || params.defaultAudioLanguage?.startsWith('bn');
  if (params.languagePreference === 'bengali') {
    score += hasBengaliScript ? 9 : hasBanglaCue ? 6 : 0;
  } else if (params.languagePreference === 'banglish') {
    score += hasBanglaCue || hasBengaliScript ? 9 : 2;
  } else if (params.languagePreference === 'english') {
    score += !hasBengaliScript && (params.defaultAudioLanguage?.startsWith('en') || /[a-z]{4,}/i.test(params.title)) ? 8 : 3;
  } else {
    score += hasBanglaCue || hasBengaliScript ? 8 : 6;
  }

  return Math.min(35, Number(score.toFixed(1)));
}

function computeDurationSuitabilityScore(durationSeconds: number): number {
  if (durationSeconds >= 180 && durationSeconds <= 2400) return 25;
  if (durationSeconds >= 90 && durationSeconds <= 4200) return 19;
  if (durationSeconds >= 45 && durationSeconds <= 7200) return 12;
  return 7;
}

async function generateWinnerReasoningWithAi(params: {
  idea: string;
  categories: string[];
  languagePreference: IdeaLanguagePreference;
  winner: IdeaCandidateVideo;
}): Promise<string> {
  const engPart =
    params.winner.likeCount > 0
      ? `, ${params.winner.likeCount.toLocaleString()} likes (${params.winner.engagementPct.toFixed(2)}% engagement)`
      : '';
  const deterministic = `Selected #1 (score ${params.winner.totalScore}/100) with ${params.winner.viewCount.toLocaleString()} real views${engPart}, ${Math.round(
    params.winner.viewVelocityPerHour
  ).toLocaleString()} views/hr velocity, and a ${params.winner.durationLabel} runtime ideal for extracting multiple 9:16 facecam clips.`;

  const prompt = `Explain in 2 crisp sentences why this YouTube video won #1 for clipping using ONLY the verified real metrics provided (do not invent any numbers):
User Idea: "${params.idea}"
Categories: ${params.categories.join(', ') || 'General'}
Language Preference: ${params.languagePreference}
Winning Video: ${JSON.stringify({
    title: params.winner.title,
    channelTitle: params.winner.channelTitle,
    durationLabel: params.winner.durationLabel,
    viewCount: params.winner.viewCount,
    likeCount: params.winner.likeCount,
    viewVelocityPerHour: Math.round(params.winner.viewVelocityPerHour),
    engagementPct: params.winner.engagementPct,
    totalScore: params.winner.totalScore,
  })}
Return plain text only.`;

  try {
    const provider = getActiveAiProvider();
    if (provider === 'claude' && isClaudeConfigured()) {
      const txt = await callClaudeWithRetry(
        prompt,
        'You are Claude, Lead Content Strategist. Cite only the verified numbers provided.',
        240
      );
      if (txt.trim()) return txt.trim().slice(0, 380);
    }
    if (isGeminiConfigured()) {
      const txt = await generateGeminiTextResponse(
        prompt,
        'You are a factual YouTube Content Strategist. Cite only the verified numbers provided.'
      );
      if (txt.trim()) return txt.trim().slice(0, 380);
    }
  } catch {
    // Fall back deterministically
  }

  return deterministic;
}

function parseCompactCount(raw?: string | null): number {
  if (!raw || typeof raw !== 'string') return 0;
  const cleaned = raw.replace(/,/g, '').trim();
  const match = cleaned.match(/(\d+(?:\.\d+)?)\s*([KMB])?/i);
  if (!match) return 0;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return 0;
  const suffix = (match[2] || '').toUpperCase();
  if (suffix === 'K') return Math.round(base * 1_000);
  if (suffix === 'M') return Math.round(base * 1_000_000);
  if (suffix === 'B') return Math.round(base * 1_000_000_000);
  return Math.round(base);
}

function parseClockDurationSeconds(raw?: string | null): number {
  if (!raw || typeof raw !== 'string') return 0;
  const clean = raw.trim();
  if (!/^\d+(?::\d{1,2}){1,2}$/.test(clean)) return 0;
  const parts = clean.split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function parseRelativeTimeToHours(raw?: string | null): number {
  if (!raw || typeof raw !== 'string') return 24;
  const lower = raw.toLowerCase();
  const match = lower.match(/(\d+)\s*(s|sec|second|seconds|m|min|minute|minutes|h|hr|hour|hours|d|day|days|w|wk|week|weeks|mo|month|months|y|yr|year|years)/);
  if (!match) return 24;
  const val = Math.max(1, Number(match[1]) || 1);
  const unit = match[2];
  if (unit.startsWith('s') || unit.startsWith('m') && !unit.startsWith('mo')) {
    return 1;
  }
  if (unit.startsWith('h')) return val;
  if (unit.startsWith('d')) return val * 24;
  if (unit.startsWith('w')) return val * 24 * 7;
  if (unit.startsWith('mo')) return val * 24 * 30;
  if (unit.startsWith('y')) return val * 24 * 365;
  return 24;
}

function extractTextFromRuns(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const obj = node as { simpleText?: string; runs?: Array<{ text?: string }> };
  if (typeof obj.simpleText === 'string') return obj.simpleText;
  if (Array.isArray(obj.runs)) {
    return obj.runs.map((r) => (typeof r?.text === 'string' ? r.text : '')).join('');
  }
  return '';
}

function collectPublicVideoRenderers(
  node: unknown,
  out: Record<string, unknown>[],
  depth = 0
) {
  if (!node || typeof node !== 'object' || depth > 14) return;
  if (Array.isArray(node)) {
    for (const item of node) {
      collectPublicVideoRenderers(item, out, depth + 1);
    }
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.videoRenderer && typeof obj.videoRenderer === 'object') {
    out.push(obj.videoRenderer as Record<string, unknown>);
    return;
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      collectPublicVideoRenderers(value, out, depth + 1);
    }
  }
}

interface PublicCandidateRow {
  videoId: string;
  title: string;
  description: string;
  channelTitle: string;
  channelId?: string;
  thumbnailUrl?: string;
  publishedAt: string;
  durationSeconds: number;
  viewCount: number;
  hoursOld: number;
  matchedQuery: string;
}

async function fetchPublicYouTubeQuery(
  query: string,
  regionCode?: string
): Promise<PublicCandidateRow[]> {
  // sp=EgIQAQ%3D%3D filters search results to real Videos (excludes channels/playlists)
  const glParam = regionCode ? `&gl=${encodeURIComponent(regionCode)}` : '';
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(
    query
  )}&sp=EgIQAQ%253D%253D${glParam}`;

  const res = await fetch(searchUrl, {
    method: 'GET',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9,bn;q=0.8',
    },
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) {
    throw new Error(`Public YouTube search returned HTTP ${res.status}`);
  }

  const html = await res.text();
  const marker = 'var ytInitialData = ';
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) {
    throw new Error('Could not parse public YouTube search results payload.');
  }

  const jsonStart = markerIdx + marker.length;
  const jsonEnd = html.indexOf(';</script>', jsonStart);
  if (jsonEnd === -1) {
    throw new Error('Incomplete public YouTube search payload.');
  }

  const initialData = JSON.parse(html.slice(jsonStart, jsonEnd)) as unknown;
  const renderers: Record<string, unknown>[] = [];
  collectPublicVideoRenderers(initialData, renderers);

  const results: PublicCandidateRow[] = [];
  const seenIds = new Set<string>();
  const nowMs = Date.now();

  for (const vr of renderers) {
    const videoId = typeof vr.videoId === 'string' ? vr.videoId.trim() : '';
    if (!videoId || seenIds.has(videoId)) continue;

    // Skip YouTube Shorts (/shorts/...) links so we favor multi-minute clip-rich videos
    const navEndpoint = vr.navigationEndpoint as Record<string, unknown> | undefined;
    if (navEndpoint?.reelWatchEndpoint) continue;

    // Skip upcoming scheduled premieres
    if (vr.upcomingEventData) continue;

    let lengthStr = extractTextFromRuns(vr.lengthText);
    if (!lengthStr && Array.isArray(vr.thumbnailOverlays)) {
      for (const overlay of vr.thumbnailOverlays) {
        if (overlay && typeof overlay === 'object') {
          const ts = (overlay as Record<string, unknown>)
            .thumbnailOverlayTimeStatusRenderer as Record<string, unknown> | undefined;
          if (ts?.text) {
            const candidateLen = extractTextFromRuns(ts.text);
            if (/^\d+(?::\d{1,2}){1,2}$/.test(candidateLen.trim())) {
              lengthStr = candidateLen;
              break;
            }
          }
        }
      }
    }

    const durationSeconds = parseClockDurationSeconds(lengthStr);
    // Allow live streams (durationSeconds === 0 when LIVE badge present) or >= 45s videos
    const badges = Array.isArray(vr.badges) ? vr.badges : [];
    const isLive = badges.some((b) => {
      if (!b || typeof b !== 'object') return false;
      const meta = (b as Record<string, unknown>).metadataBadgeRenderer as
        | { style?: string; label?: string }
        | undefined;
      return (
        meta?.style === 'BADGE_STYLE_TYPE_LIVE_NOW' ||
        meta?.label?.toUpperCase() === 'LIVE'
      );
    });

    if (!isLive && durationSeconds < 45) continue;

    seenIds.add(videoId);

    const title = extractTextFromRuns(vr.title).trim() || `YouTube Video ${videoId}`;
    const ownerRuns = (vr.ownerText as { runs?: Array<Record<string, unknown>> } | undefined)?.runs;
    const channelTitle =
      (ownerRuns?.[0]?.text as string | undefined)?.trim() || 'YouTube Channel';
    const channelId = (
      ownerRuns?.[0]?.navigationEndpoint as
        | { browseEndpoint?: { browseId?: string } }
        | undefined
    )?.browseEndpoint?.browseId;

    const viewText = extractTextFromRuns(vr.viewCountText);
    const viewCount = parseCompactCount(viewText);
    const publishedText = extractTextFromRuns(vr.publishedTimeText);
    const hoursOld = isLive ? 2 : parseRelativeTimeToHours(publishedText);
    const publishedAt = new Date(nowMs - hoursOld * 3_600_000).toISOString();

    let description = '';
    if (Array.isArray(vr.detailedMetadataSnippets) && vr.detailedMetadataSnippets.length > 0) {
      const firstSnippet = vr.detailedMetadataSnippets[0] as Record<string, unknown>;
      description = extractTextFromRuns(firstSnippet.snippetText);
    }
    if (!description && vr.descriptionSnippet) {
      description = extractTextFromRuns(vr.descriptionSnippet);
    }

    const thumbs = (vr.thumbnail as { thumbnails?: Array<{ url?: string }> } | undefined)
      ?.thumbnails;
    const thumbRaw = thumbs && thumbs.length > 0 ? thumbs[thumbs.length - 1]?.url : undefined;
    const thumbnailUrl = thumbRaw?.startsWith('//') ? `https:${thumbRaw}` : thumbRaw;

    results.push({
      videoId,
      title,
      description,
      channelTitle,
      channelId,
      thumbnailUrl: thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      publishedAt,
      durationSeconds: isLive ? 1800 : durationSeconds,
      viewCount,
      hoursOld,
      matchedQuery: query,
    });
  }

  return results;
}

async function searchYouTubePublicFallback(params: {
  cleanIdea: string;
  cleanCategories: string[];
  languagePreference: IdeaLanguagePreference;
  reqCtx: ParsedRequirementContext;
  expansion: { queries: string[]; relevanceLanguage?: string; regionCode?: string };
  searchedAt: string;
}): Promise<IdeaSearchResult> {
  const requirementSummary = formatRequirementSummary(params.reqCtx);
  const byId = new Map<string, PublicCandidateRow>();
  let lastFetchError: string | null = null;

  for (const q of params.expansion.queries) {
    try {
      const rows = await fetchPublicYouTubeQuery(q, params.expansion.regionCode);
      for (const row of rows) {
        if (!byId.has(row.videoId)) {
          byId.set(row.videoId, row);
        }
      }
      if (byId.size >= 24) break;
    } catch (err) {
      lastFetchError = err instanceof Error ? err.message : String(err);
    }
  }

  const allRows = Array.from(byId.values());
  if (allRows.length === 0) {
    return {
      idea: params.cleanIdea,
      categories: params.cleanCategories,
      languagePreference: params.languagePreference,
      expandedQueries: params.expansion.queries,
      apiStatus: lastFetchError ? 'error' : 'zero_matches',
      requirementSummary,
      rejectedCount: 0,
      errorMessage: lastFetchError
        ? `Public YouTube discovery failed: ${lastFetchError}`
        : `YouTube search returned 0 >=45s videos for queries: ${params.expansion.queries.join(' | ')}. Try broader keywords.`,
      candidates: [],
      searchedAt: params.searchedAt,
    };
  }

  // Hard Requirement Filter Gate BEFORE scoring: discard any candidate failing topic/niche/language lock
  const passingRows: PublicCandidateRow[] = [];
  let rejectedCount = 0;
  let lastRejectReason = '';
  for (const row of allRows) {
    const check = checkStrictCandidateMatch(
      {
        title: row.title,
        description: row.description,
        tags: [],
        channelTitle: row.channelTitle,
        matchedQuery: row.matchedQuery,
      },
      params.reqCtx
    );
    if (check.passed) {
      passingRows.push(row);
    } else {
      rejectedCount += 1;
      if (check.reason) lastRejectReason = check.reason;
    }
  }

  if (passingRows.length === 0) {
    return {
      idea: params.cleanIdea,
      categories: params.cleanCategories,
      languagePreference: params.languagePreference,
      expandedQueries: params.expansion.queries,
      apiStatus: 'zero_matches',
      rejectedCount,
      requirementSummary,
      errorMessage: `Discarded all ${rejectedCount} YouTube results because none passed strict requirement alignment (${requirementSummary}). ${lastRejectReason ? `Reason: ${lastRejectReason}` : ''}`,
      candidates: [],
      searchedAt: params.searchedAt,
    };
  }

  const rawCandidates = passingRows.map((row) => {
    const viewVelocityPerHour = row.viewCount / Math.max(1, row.hoursOld);
    const alignmentScore = computeTopicAlignmentScore({
      title: row.title,
      description: row.description,
      tags: [],
      channelTitle: row.channelTitle,
      idea: params.cleanIdea,
      categories: params.cleanCategories,
      languagePreference: params.languagePreference,
    });
    const durationSuitabilityScore = computeDurationSuitabilityScore(row.durationSeconds);
    return {
      ...row,
      durationLabel: formatDurationLabel(row.durationSeconds),
      likeCount: 0,
      commentCount: 0,
      hoursOld: Number(row.hoursOld.toFixed(1)),
      viewVelocityPerHour: Number(viewVelocityPerHour.toFixed(1)),
      engagementPct: 0,
      alignmentScore,
      durationSuitabilityScore,
    };
  });

  const maxLogVelocity = Math.max(
    1,
    ...rawCandidates.map((c) => Math.log10(1 + Math.max(0, c.viewVelocityPerHour)))
  );

  const scoredCandidates: IdeaCandidateVideo[] = rawCandidates
    .map((c) => {
      // Scale across velocity (35), duration suitability (25), and topic alignment (40) -> 0..100
      const velocityScore =
        (Math.log10(1 + Math.max(0, c.viewVelocityPerHour)) / maxLogVelocity) * 35;
      const scaledAlignment = (c.alignmentScore / 35) * 40;
      const totalScore = Number(
        (velocityScore + c.durationSuitabilityScore + scaledAlignment).toFixed(1)
      );
      return {
        videoId: c.videoId,
        url: `https://www.youtube.com/watch?v=${c.videoId}`,
        title: c.title,
        channelTitle: c.channelTitle,
        channelId: c.channelId,
        thumbnailUrl: c.thumbnailUrl,
        publishedAt: c.publishedAt,
        durationSeconds: c.durationSeconds,
        durationLabel: c.durationLabel,
        viewCount: c.viewCount,
        likeCount: c.likeCount,
        commentCount: c.commentCount,
        hoursOld: c.hoursOld,
        viewVelocityPerHour: c.viewVelocityPerHour,
        engagementPct: c.engagementPct,
        alignmentScore: c.alignmentScore,
        totalScore,
        matchedQuery: c.matchedQuery,
      };
    })
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, 5);

  const winner = scoredCandidates[0];
  const winnerReasoning = await generateWinnerReasoningWithAi({
    idea: params.cleanIdea,
    categories: params.cleanCategories,
    languagePreference: params.languagePreference,
    winner,
  });
  winner.claudeReasoning = winnerReasoning;

  return {
    idea: params.cleanIdea,
    categories: params.cleanCategories,
    languagePreference: params.languagePreference,
    expandedQueries: params.expansion.queries,
    apiStatus: 'ok',
    rejectedCount,
    requirementSummary,
    candidates: scoredCandidates,
    winner,
    winnerReasoning,
    searchedAt: params.searchedAt,
  };
}

export async function findBestVideosForIdea(params: {
  idea: string;
  categories: string[];
  languagePreference: IdeaLanguagePreference;
  bearerToken?: string;
}): Promise<IdeaSearchResult> {
  const searchedAt = new Date().toISOString();
  const cleanIdea = params.idea.trim();
  const cleanCategories = params.categories
    .map((c) => c.trim())
    .filter(Boolean);

  if (!cleanIdea) {
    return {
      idea: '',
      categories: cleanCategories,
      languagePreference: params.languagePreference,
      expandedQueries: [],
      apiStatus: 'error',
      errorMessage: 'Please enter a video idea or topic before searching YouTube.',
      candidates: [],
      searchedAt,
    };
  }

  const reqCtx = parseRequirementSpec({
    topicIdea: cleanIdea,
    categories: cleanCategories,
    languagePreference: params.languagePreference,
  });
  const requirementSummary = formatRequirementSummary(reqCtx);

  const apiKeyFallback = getApiKeyFallback();
  const hasGoogleAuth = Boolean(
    params.bearerToken?.trim() || hasAnyUsableYouTubeOAuthSlot()
  );
  const hasZernioAuth = hasActiveZernioAuth();

  if (!hasGoogleAuth && !apiKeyFallback && !hasZernioAuth) {
    return {
      idea: cleanIdea,
      categories: cleanCategories,
      languagePreference: params.languagePreference,
      expandedQueries: [],
      apiStatus: 'no_youtube_auth',
      requirementSummary,
      errorMessage:
        'Connect either Google or Zernio (click "Sign in with Google" or "Connect Zernio") to unlock AI Idea Discovery and auto-uploading.',
      candidates: [],
      searchedAt,
    };
  }

  const expansion = await expandIdeaWithAi({
    idea: cleanIdea,
    categories: cleanCategories,
    languagePreference: params.languagePreference,
  });

  // When only Zernio is connected (without Google OAuth or YOUTUBE_API_KEY), run public YouTube discovery directly
  if (!hasGoogleAuth && !apiKeyFallback) {
    return searchYouTubePublicFallback({
      cleanIdea,
      cleanCategories,
      languagePreference: params.languagePreference,
      reqCtx,
      expansion,
      searchedAt,
    });
  }

  try {
    const { result: fetchedPayload } = await executeWithYouTubeOAuthPool({
      operationName: 'ideaFinder.search',
      estimatedQuotaUnits: expansion.queries.length * 100 + 1,
      bearerTokenFallback: params.bearerToken,
      apiKeyFallback: apiKeyFallback || undefined,
      fn: async (youtube: youtube_v3.Youtube) => {
        const queryByVideoId = new Map<string, string>();

        for (const q of expansion.queries) {
          const searchRes = await youtube.search.list({
            part: ['snippet'],
            q,
            type: ['video'],
            maxResults: 12,
            order: 'relevance',
            ...(expansion.relevanceLanguage
              ? { relevanceLanguage: expansion.relevanceLanguage }
              : {}),
            ...(expansion.regionCode ? { regionCode: expansion.regionCode } : {}),
          });

          for (const item of searchRes.data.items || []) {
            const vid = item.id?.videoId;
            if (vid && !queryByVideoId.has(vid)) {
              queryByVideoId.set(vid, q);
            }
          }
          // Stop early once >= 20 unique candidates are found to conserve quota
          if (queryByVideoId.size >= 20) break;
        }

        const videoIds = Array.from(queryByVideoId.keys()).slice(0, 28);
        if (videoIds.length === 0) {
          return { queryByVideoId, items: [] as youtube_v3.Schema$Video[] };
        }

        // Batch all IDs into one videos.list call (1 quota unit)
        const detailsRes = await youtube.videos.list({
          part: ['snippet', 'statistics', 'contentDetails'],
          id: videoIds,
        });

        return {
          queryByVideoId,
          items: detailsRes.data.items || [],
        };
      },
    });

    const { queryByVideoId, items } = fetchedPayload;
    if (queryByVideoId.size === 0) {
      return {
        idea: cleanIdea,
        categories: cleanCategories,
        languagePreference: params.languagePreference,
        expandedQueries: expansion.queries,
        apiStatus: 'zero_matches',
        requirementSummary,
        errorMessage: `YouTube search returned 0 videos for queries: ${expansion.queries.join(' | ')}. Try broader keywords or another category.`,
        candidates: [],
        searchedAt,
      };
    }

    const nowMs = Date.now();
    const rawCandidates: Array<
      Omit<IdeaCandidateVideo, 'totalScore'> & {
        durationSuitabilityScore: number;
        engagementScore: number;
      }
    > = [];
    let rejectedCount = 0;
    let lastRejectReason = '';

    for (const item of items) {
      if (!item.id || !item.snippet) continue;
      if (item.snippet.liveBroadcastContent === 'upcoming') continue;

      const durationSeconds = parseIso8601DurationSeconds(item.contentDetails?.duration);
      if (durationSeconds < 45) continue;

      const strictCheck = checkStrictCandidateMatch(
        {
          title: item.snippet.title || '',
          description: item.snippet.description || '',
          tags: item.snippet.tags || [],
          channelTitle: item.snippet.channelTitle || '',
          defaultAudioLanguage: item.snippet.defaultAudioLanguage || undefined,
          matchedQuery: queryByVideoId.get(item.id) || cleanIdea,
        },
        reqCtx
      );

      if (!strictCheck.passed) {
        rejectedCount += 1;
        if (strictCheck.reason) lastRejectReason = strictCheck.reason;
        continue;
      }

      const publishedAt = item.snippet.publishedAt || searchedAt;
      const pubMs = Date.parse(publishedAt);
      const hoursOld = Number.isNaN(pubMs) ? 24 : Math.max(1, (nowMs - pubMs) / 3_600_000);
      const viewCount = Number(item.statistics?.viewCount || 0);
      const likeCount = Number(item.statistics?.likeCount || 0);
      const commentCount = Number(item.statistics?.commentCount || 0);
      const viewVelocityPerHour = viewCount / hoursOld;
      const engagementPct = viewCount > 0 ? ((likeCount + commentCount) / viewCount) * 100 : 0;

      const alignmentScore = computeTopicAlignmentScore({
        title: item.snippet.title || '',
        description: item.snippet.description || '',
        tags: item.snippet.tags || [],
        channelTitle: item.snippet.channelTitle || '',
        defaultAudioLanguage: item.snippet.defaultAudioLanguage || undefined,
        idea: cleanIdea,
        categories: cleanCategories,
        languagePreference: params.languagePreference,
      });

      const durationSuitabilityScore = computeDurationSuitabilityScore(durationSeconds);
      const weightedEng = viewCount > 0 ? ((likeCount + commentCount * 2) / viewCount) * 100 : 0;
      const engagementScore = Math.min(15, weightedEng * 2.5);

      const thumb =
        item.snippet.thumbnails?.high?.url ||
        item.snippet.thumbnails?.medium?.url ||
        item.snippet.thumbnails?.default?.url ||
        undefined;

      rawCandidates.push({
        videoId: item.id,
        url: `https://www.youtube.com/watch?v=${item.id}`,
        title: item.snippet.title || `YouTube Video ${item.id}`,
        channelTitle: item.snippet.channelTitle || 'YouTube Channel',
        channelId: item.snippet.channelId || undefined,
        thumbnailUrl: thumb,
        publishedAt,
        durationSeconds,
        durationLabel: formatDurationLabel(durationSeconds),
        viewCount,
        likeCount,
        commentCount,
        hoursOld: Number(hoursOld.toFixed(1)),
        viewVelocityPerHour: Number(viewVelocityPerHour.toFixed(1)),
        engagementPct: Number(engagementPct.toFixed(2)),
        alignmentScore,
        matchedQuery: queryByVideoId.get(item.id) || expansion.queries[0] || cleanIdea,
        durationSuitabilityScore,
        engagementScore,
      });
    }

    if (rawCandidates.length === 0) {
      return {
        idea: cleanIdea,
        categories: cleanCategories,
        languagePreference: params.languagePreference,
        expandedQueries: expansion.queries,
        apiStatus: 'zero_matches',
        rejectedCount,
        requirementSummary,
        errorMessage:
          rejectedCount > 0
            ? `Discarded all ${rejectedCount} >=45s results because none passed strict requirement filtering (${requirementSummary}). ${lastRejectReason}`
            : 'YouTube returned videos, but none met the >=45s playable duration threshold for multi-clip extraction. Try adjusting keywords or duration scope.',
        candidates: [],
        searchedAt,
      };
    }

    const maxLogVelocity = Math.max(
      1,
      ...rawCandidates.map((c) => Math.log10(1 + Math.max(0, c.viewVelocityPerHour)))
    );

    const scoredCandidates: IdeaCandidateVideo[] = rawCandidates
      .map((c) => {
        const velocityScore =
          (Math.log10(1 + Math.max(0, c.viewVelocityPerHour)) / maxLogVelocity) * 25;
        const totalScore = Number(
          (
            velocityScore +
            c.engagementScore +
            c.durationSuitabilityScore +
            c.alignmentScore
          ).toFixed(1)
        );
        return {
          videoId: c.videoId,
          url: c.url,
          title: c.title,
          channelTitle: c.channelTitle,
          channelId: c.channelId,
          thumbnailUrl: c.thumbnailUrl,
          publishedAt: c.publishedAt,
          durationSeconds: c.durationSeconds,
          durationLabel: c.durationLabel,
          viewCount: c.viewCount,
          likeCount: c.likeCount,
          commentCount: c.commentCount,
          hoursOld: c.hoursOld,
          viewVelocityPerHour: c.viewVelocityPerHour,
          engagementPct: c.engagementPct,
          alignmentScore: c.alignmentScore,
          totalScore,
          matchedQuery: c.matchedQuery,
        };
      })
      .sort((a, b) => b.totalScore - a.totalScore)
      .slice(0, 5);

    const winner = scoredCandidates[0];
    const winnerReasoning = await generateWinnerReasoningWithAi({
      idea: cleanIdea,
      categories: cleanCategories,
      languagePreference: params.languagePreference,
      winner,
    });
    winner.claudeReasoning = winnerReasoning;

    return {
      idea: cleanIdea,
      categories: cleanCategories,
      languagePreference: params.languagePreference,
      expandedQueries: expansion.queries,
      apiStatus: 'ok',
      rejectedCount,
      requirementSummary,
      candidates: scoredCandidates,
      winner,
      winnerReasoning,
      searchedAt,
    };
  } catch (err) {
    // Gracefully fall back to public YouTube discovery when Google OAuth fails/hits quota and Zernio or public fallback is available
    try {
      const publicFallback = await searchYouTubePublicFallback({
        cleanIdea,
        cleanCategories,
        languagePreference: params.languagePreference,
        reqCtx,
        expansion,
        searchedAt,
      });
      if (publicFallback.apiStatus === 'ok' && publicFallback.candidates.length > 0) {
        return publicFallback;
      }
      if (publicFallback.apiStatus === 'zero_matches' && (publicFallback.rejectedCount || 0) > 0) {
        return publicFallback;
      }
    } catch {
      // Fall through to structured error response below
    }

    if (err instanceof AllYouTubeQuotaExhaustedError) {
      return {
        idea: cleanIdea,
        categories: cleanCategories,
        languagePreference: params.languagePreference,
        expandedQueries: expansion.queries,
        apiStatus: 'quota_exceeded',
        requirementSummary,
        errorMessage: err.message,
        candidates: [],
        searchedAt,
      };
    }
    const details = extractYouTubeErrorDetails(err);
    return {
      idea: cleanIdea,
      categories: cleanCategories,
      languagePreference: params.languagePreference,
      expandedQueries: expansion.queries,
      apiStatus: details.isQuota
        ? 'quota_exceeded'
        : details.isAuth && !hasZernioAuth
        ? 'no_youtube_auth'
        : 'error',
      requirementSummary,
      errorMessage: details.isQuota
        ? `YouTube Data API quota exceeded (${details.message}). Try another connected YouTube API Slot or wait for daily quota reset.`
        : details.isAuth && !hasZernioAuth
        ? `Authentication required (${details.message}). Connect Google or Zernio to search YouTube.`
        : `YouTube search failed: ${details.message}`,
      candidates: [],
      searchedAt,
    };
  }
}

export function buildIdeaStreamInstructions(params: {
  idea: string;
  categories: string[];
  languagePreference: IdeaLanguagePreference;
  clipCount?: number;
  customInstructions?: string;
  matchedQuery?: string;
}): string {
  const langRule =
    params.languagePreference === 'bengali'
      ? 'STRICT LANGUAGE LOCK: Write natural, engaging Bengali (বাংলা Unicode) titles and captions sounding like a real Bangladeshi creator — never awkward machine translation.'
      : params.languagePreference === 'banglish'
      ? 'STRICT LANGUAGE LOCK: Write natural, engaging Banglish (Bengali+English mix) titles and captions sounding like a real Bangladeshi gaming creator.'
      : params.languagePreference === 'english'
      ? 'STRICT LANGUAGE LOCK: Write punchy, natural English creator titles and captions with #BD context.'
      : params.languagePreference === 'auto'
      ? 'LANGUAGE RULE: Dynamically match natural Bangla (বাংলা), Banglish, or English to the video clip dialogue and energy.'
      : 'LANGUAGE RULE: Match the spoken audio language naturally while always including #BD.';

  const parts = [
    `LOCKED TOPIC / IDEA: "${params.idea.trim()}"`,
    params.categories.length > 0 ? `LOCKED NICHES/CATEGORIES: ${params.categories.join(', ')}` : '',
    params.clipCount ? `REQUESTED CLIP COUNT LIMIT: ${params.clipCount}` : '',
    params.matchedQuery ? `DISCOVERED VIA SEARCH QUERY: "${params.matchedQuery}"` : '',
    langRule,
    'STRICT METADATA RULES: Analyze ONLY the actual visual/audio moment inside each clip. Include #BD + 3 to 5 clean relevant hashtags. NEVER output numbered dummy tags (#0, #1, #2, hashtag zero) or generic placeholders.',
    params.customInstructions?.trim()
      ? `USER CUSTOM INSTRUCTIONS (HIGHEST PRIORITY): ${params.customInstructions.trim()}`
      : '',
  ].filter(Boolean);

  return parts.join('\n');
}
