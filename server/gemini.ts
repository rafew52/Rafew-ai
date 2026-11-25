import fs from 'fs';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type { ContentLanguageChoice, RequirementSpec } from '../src/types.ts';
import { parseAllTimestampRanges } from './claude.ts';
import { formatRequirementSummary, parseRequirementSpec } from './requirementEngine.ts';
import {
  acquireGeminiKey,
  computeCooldownMs,
  createGeminiClientForKey,
  formatHttpErrorLabel,
  formatSafeGeminiError,
  getNextCooldownWaitMs,
  getUsableKeyCount,
  hasUsableGeminiKey,
  isInvalidKeyError,
  isModelNotFoundError,
  isOverloadError,
  isRateLimitError,
  isTransientNetworkError,
  markKeyInvalid,
  markKeyRateLimited,
  markKeySuccess,
  releaseGeminiKey,
} from './geminiKeys.ts';
import {
  discoverGeminiModels,
  getActiveCandidateModels,
  quarantineModel,
} from './geminiModels.ts';

export interface DetectedCaptionCue {
  start_offset_seconds: number;
  end_offset_seconds: number;
  text: string;
}

export interface DetectedMoment {
  category: 'funny' | 'epic_gameplay' | 'highlight' | 'reaction' | 'viral';
  start_seconds: number;
  end_seconds: number;
  language_choice?: ContentLanguageChoice;
  moment_summary?: string;
  viral_reason: string;
  title: string;
  description: string;
  thumbnail_hook?: string;
  thumbnail_timestamp?: number;
  hashtags: string[];
  tags: string[];
  captions: DetectedCaptionCue[];
}

export type ThumbnailTextPlacement =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export type ThumbnailAccentTheme =
  | 'yellow_white'
  | 'red_yellow'
  | 'cyan_white'
  | 'orange_white';

export interface SearchGroundedThumbnailDesign {
  thumbnailHookText: string;
  textPlacement: ThumbnailTextPlacement;
  accentTheme: ThumbnailAccentTheme;
  microBadge: string;
  searchInsights: string;
  sources: Array<{ title: string; uri: string }>;
}

export interface ChunkAnalysisResult {
  moments: DetectedMoment[];
}

export function isGeminiConfigured(): boolean {
  return hasUsableGeminiKey();
}

const INLINE_PAYLOAD_LIMIT_BYTES = 15 * 1024 * 1024; // 15 MB
const SEGMENT_ANALYSIS_TIMEOUT_MS = 60_000; // 60 seconds

type AnalysisMediaSource =
  | { kind: 'inline'; data: string; mimeType: string }
  | { kind: 'file'; fileUri: string; mimeType: string };

async function generateMomentAnalysis(params: {
  ai: GoogleGenAI;
  model: string;
  media: AnalysisMediaSource;
  chunkDurationSeconds: number;
  formatMode: 'short' | 'long';
  additionalInstructions?: string;
  requirementSpec?: RequirementSpec;
  recentLanguages?: ContentLanguageChoice[];
  recentTitles?: string[];
  videoTitleHint?: string;
  chunkOffsetSeconds?: number;
  watchdogSignal?: AbortSignal;
}): Promise<ChunkAnalysisResult> {
  const {
    ai,
    model,
    media,
    chunkDurationSeconds,
    formatMode,
    additionalInstructions,
    requirementSpec,
    recentLanguages,
    recentTitles,
    videoTitleHint,
    chunkOffsetSeconds = 0,
    watchdogSignal,
  } = params;
  const safeTotal = Math.max(15, Math.floor(chunkDurationSeconds));

  const reqCtx = parseRequirementSpec({
    topicIdea: requirementSpec?.topicIdea,
    categories: requirementSpec?.lockedCategories,
    languagePreference: requirementSpec?.languagePreference,
    clipCount: requirementSpec?.clipCount,
    formatMode,
    aspectMode: requirementSpec?.aspectMode,
    additionalInstructions,
  });

  const isLong = formatMode === 'long';
  const minClipSeconds = isLong
    ? safeTotal >= 120
      ? 120
      : Math.max(15, Math.floor(safeTotal * 0.75))
    : 15;
  const maxClipSeconds = isLong
    ? Math.min(600, Math.max(minClipSeconds, safeTotal))
    : Math.min(60, Math.max(15, safeTotal));

  const maxMomentsHint = reqCtx.spec.clipCount
    ? Math.min(isLong ? 2 : 3, reqCtx.spec.clipCount)
    : isLong
    ? 2
    : 3;

  const parsedRanges = parseAllTimestampRanges(additionalInstructions);
  const chunkLocalRanges = parsedRanges
    .map((r) => {
      // Check if range matches stream-global timestamps overlapping this chunk, or local timestamps
      if (r.endSeconds > chunkOffsetSeconds && r.startSeconds < chunkOffsetSeconds + safeTotal) {
        return {
          start: Math.max(0, Math.round(r.startSeconds - chunkOffsetSeconds)),
          end: Math.min(safeTotal, Math.round(r.endSeconds - chunkOffsetSeconds)),
          raw: r.rawText,
        };
      }
      if (chunkOffsetSeconds === 0 && r.endSeconds <= safeTotal) {
        return { start: r.startSeconds, end: r.endSeconds, raw: r.rawText };
      }
      return null;
    })
    .filter((r): r is { start: number; end: number; raw: string } => Boolean(r && r.end > r.start));

  const customBlock = additionalInstructions?.trim()
    ? [
        `MANDATORY HIGHEST-PRIORITY USER INSTRUCTIONS (NEVER IGNORE):`,
        `"${additionalInstructions.trim()}"`,
        chunkLocalRanges.length > 0
          ? `EXACT TIMESTAMP RANGES REQUESTED FOR THIS SEGMENT: ${chunkLocalRanges
              .map((r) => `${r.start}s-${r.end}s (from ${r.raw})`)
              .join(', ')}. Extract these exact ranges faithfully even if shorter/longer than defaults.`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  const requirementLockBlock = [
    `LOCKED REQUIREMENT SPEC (${formatRequirementSummary(reqCtx)}):`,
    `- Analyze ONLY what actually happens visually and aurally inside this video segment.`,
    `- Stay strictly inside the requested topic/niche (${reqCtx.spec.lockedCategories.join(', ') || reqCtx.spec.topicIdea || 'video content'}). NEVER hallucinate or mention unrelated games (e.g., never mention GTA if the clip is another game or topic).`,
  ].join('\n');

  const recentLangNote =
    recentLanguages && recentLanguages.length > 0
      ? recentLanguages.slice(0, 6).join(', ')
      : 'none yet';

  const recentTitlesNote =
    recentTitles && recentTitles.length > 0
      ? recentTitles
          .slice(0, 12)
          .map((t, i) => `  ${i + 1}. "${t}"`)
          .join('\n')
      : '  (none yet)';

  const lockedLang = reqCtx.spec.languagePreference;
  const langDirective =
    lockedLang === 'bengali'
      ? `- STRICT LANGUAGE LOCK: Set "language_choice" to "bengali" and write natural, engaging Bangla (বাংলা Unicode script) title & caption sounding like a real Bangladeshi creator — never awkward machine translation.`
      : lockedLang === 'banglish'
      ? `- STRICT LANGUAGE LOCK: Set "language_choice" to "banglish" and write natural, energetic Bangladeshi creator Banglish (Bengali+English mix) title & caption.`
      : lockedLang === 'english'
      ? `- STRICT LANGUAGE LOCK: Set "language_choice" to "english" and write punchy natural English creator title & caption.`
      : `- Pick "language_choice" dynamically from: "bengali" (natural বাংলা script), "banglish" (natural Bangladeshi gamer Bangla+English mix), or "english" (punchy creator English) to match the clip dialogue & vibe. Recent languages: [${recentLangNote}].`;

  const strictMetadataRules = [
    `STRICT CLIP METADATA, UNIQUE TITLE & HASHTAG RULES (TIKTOK & YOUTUBE SHORTS):`,
    videoTitleHint ? `SOURCE VIDEO TITLE CONTEXT: "${videoTitleHint}"` : '',
    langDirective,
    `- PER-CLIP UNIQUE SCENE-MATCHED TITLES: Inspect EACH clip's own action, joke, reaction, crash, chase, stunt, dialogue, or plot twist separately. Every clip MUST have a completely DIFFERENT, curiosity-driven title that reflects what actually happens in THAT clip—never reuse the same title structure across clips in this batch.`,
    `ALREADY USED TITLES IN THIS STREAM (NEVER REPEAT OR USE SIMILAR TEMPLATES):\n${recentTitlesNote}`,
    `- CONTEXT ALIGNMENT: "moment_summary", "title", and "description" MUST describe the EXACT visual/audio moment inside that clip. Never invent generic placeholders, broken words, or weird literal translations.`,
    `- BANNED CLICHES & DUMMY TAGS: STRICTLY FORBIDDEN phrases anywhere in title/caption/hashtags/tags: "GTA 6 Clutch Moment", "Clutch Action Moment", "Hashtag Zero", "Hashtag One", "Hashtag Two", "hashtag zero", "#0", "#1", "#2", "Clip 1", "Part 1", or raw URLs.`,
    `- TITLE RULE: Catchy, accurate, click-worthy title matching the clip, STRICTLY max 80 characters.`,
    `- HASHTAGS RULE: ALWAYS include #BD, plus 3 to 5 clean, relevant hashtags directly matching this clip's specific scene & niche (e.g., ${reqCtx.isGtaContext ? '#GTA6 #BanglaGaming #OpenWorld #FunnyMoments' : '#GamingBD #BanglaGaming #FunnyMoments #Highlights'}).`,
  ]
    .filter(Boolean)
    .join('\n');

  const channelBrandNote = reqCtx.isGtaContext
    ? 'for gaming channel "GTA6HUB" (#BD)'
    : 'for TikTok & YouTube (#BD)';

  const prompt = isLong
    ? [
        `Watch and listen to this video segment carefully (total duration: ~${safeTotal} seconds, stream offset: ${chunkOffsetSeconds}s).`,
        `This job is set to LONG-FORM VIDEO MODE ${channelBrandNote}.`,
        requirementLockBlock,
        customBlock,
        strictMetadataRules,
        `Identify 1 to ${maxMomentsHint} continuous, high-retention Long-Form segments (aim for 2 to 5+ minutes long: between ${minClipSeconds} and ${maxClipSeconds} seconds each, unless user requested exact timestamp ranges) capturing full story/gameplay arcs, chaotic chases, or funny commentary.`,
        `Categories: "epic_gameplay", "funny", "highlight", "reaction", or "viral".`,
        `For each detected segment:`,
        `- Provide exact integer start_seconds and end_seconds within [0, ${safeTotal}].`,
        `- Provide "moment_summary": 1 crisp line describing what actually happens in this specific clip.`,
        `- Set "language_choice" ("bengali" | "banglish" | "english").`,
        `- Write a catchy, scene-accurate title matching language_choice (STRICTLY <= 80 characters, NO #Shorts, NO numbering templates).`,
        `- Write an engaging creator-style Bangla/Banglish/English caption/description summarizing the exact scene, including #BD and clean topic hashtags.`,
        `- Provide a short 2 to 4 word "thumbnail_hook" matching the actual moment.`,
        `- Provide "thumbnail_timestamp" in seconds offset from clip start 0 for the peak frame.`,
        `- Provide hashtags: ["#BD", ...3 to 5 clean topic-relevant hashtags starting with #] (NO #Shorts, NO #0/#1/#2).`,
        `- Provide 6-12 relevant SEO tags (without #, no dummy numbers).`,
        `- Generate continuous timed Bangla/Banglish captions/subtitles (start_offset_seconds, end_offset_seconds relative to clip start 0) spanning the ENTIRE clip up to (end_seconds - start_seconds) so captions never cut out early.`,
        `If the segment has no worthwhile moments matching the user's requirements (and no exact timestamp override), return [].`,
      ]
        .filter(Boolean)
        .join('\n')
    : [
        `Watch and listen to this video segment carefully (total duration: ~${safeTotal} seconds, stream offset: ${chunkOffsetSeconds}s).`,
        requirementLockBlock,
        customBlock,
        strictMetadataRules,
        `Identify up to ${maxMomentsHint} separate, non-overlapping standout moments suitable for TikTok & YouTube Shorts ${channelBrandNote} (each between ${minClipSeconds} and ${maxClipSeconds} seconds long unless exact user timestamp ranges specify otherwise).`,
        `Categories: "funny", "epic_gameplay", "highlight", "reaction", "viral".`,
        `For each detected moment:`,
        `- Provide exact integer start_seconds and end_seconds within [0, ${safeTotal}] with complete setup and payoff.`,
        `- Provide "moment_summary": 1 crisp line describing what actually happens in this specific clip.`,
        `- Set "language_choice" ("bengali" | "banglish" | "english").`,
        `- Write a catchy, scene-accurate title matching language_choice (STRICTLY <= 80 characters, NO numbering templates like #1/Clip 1).`,
        `- Write an engaging creator-style Bangla/Banglish/English caption ("description") matching the exact moment + hashtags including #BD.`,
        `- Provide a short 2 to 4 word "thumbnail_hook".`,
        `- Provide "thumbnail_timestamp" in seconds offset from clip start 0 marking the peak frame.`,
        `- Provide hashtags: ["#BD", ...3 to 5 clean relevant hashtags directly matching this clip's topic/niche] (NEVER #0, #1, #2, hashtag zero, etc.).`,
        `- Provide 6-10 relevant SEO tags (without #, no dummy numbers).`,
        `- Generate continuous timed Bangla/Banglish captions/subtitles as short 2-6 word cues (start_offset_seconds and end_offset_seconds relative to clip start 0) spanning the FULL clip right up to (end_seconds - start_seconds) without stopping early.`,
        `If the segment is shorter than 15 seconds (and no exact user timestamp override) or has no moments matching the locked topic/niche, return an empty moments array [].`,
      ]
        .filter(Boolean)
        .join('\n');

  const mediaPart =
    media.kind === 'inline'
      ? {
          inlineData: {
            mimeType: media.mimeType,
            data: media.data,
          },
        }
      : {
          fileData: {
            fileUri: media.fileUri,
            mimeType: media.mimeType,
          },
        };

  const supportsThinkingLevel =
    model.startsWith('gemini-3') || model.startsWith('gemini-4');

  const requestController = new AbortController();
  const timeoutTimer = setTimeout(() => requestController.abort(new Error('Request timed out after 60s')), SEGMENT_ANALYSIS_TIMEOUT_MS);
  const onWatchdogAbort = () => requestController.abort(watchdogSignal?.reason || new Error('Watchdog aborted stalled segment request'));
  if (watchdogSignal) {
    if (watchdogSignal.aborted) {
      clearTimeout(timeoutTimer);
      throw new Error('Watchdog aborted stalled segment request');
    }
    watchdogSignal.addEventListener('abort', onWatchdogAbort, { once: true });
  }

  let response;
  try {
    response = await ai.models.generateContent({
      model,
      contents: [mediaPart, prompt],
      config: {
        abortSignal: requestController.signal,
        ...(supportsThinkingLevel && !model.includes('flash-lite')
          ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
          : {}),
        responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          moments: {
            type: Type.ARRAY,
            description: 'List of detected highlight/viral moments in this segment.',
            items: {
              type: Type.OBJECT,
              properties: {
                category: {
                  type: Type.STRING,
                  description:
                    'One of: funny, epic_gameplay, highlight, reaction, viral',
                },
                start_seconds: {
                  type: Type.INTEGER,
                  description: 'Clip start time in seconds within the segment.',
                },
                end_seconds: {
                  type: Type.INTEGER,
                  description: 'Clip end time in seconds within the segment.',
                },
                language_choice: {
                  type: Type.STRING,
                  description: 'Language choice: bengali, banglish, or english',
                },
                moment_summary: {
                  type: Type.STRING,
                  description:
                    '1 short crisp line describing exactly what happens visually/aurally inside this specific clip.',
                },
                viral_reason: {
                  type: Type.STRING,
                  description: 'One-sentence reason why this moment stands out.',
                },
                title: {
                  type: Type.STRING,
                  description: isLong
                    ? 'Catchy scene-accurate Long-Form title, max 80 chars, no #Shorts.'
                    : 'Catchy scene-accurate Shorts/TikTok title, max 80 chars.',
                },
                description: {
                  type: Type.STRING,
                  description: 'Engaging Bangla/Banglish/English creator caption matching the clip scene + hashtags including #BD.',
                },
                thumbnail_hook: {
                  type: Type.STRING,
                  description: 'Short 2-4 word uppercase hook text for video thumbnail.',
                },
                thumbnail_timestamp: {
                  type: Type.NUMBER,
                  description:
                    'Exact offset seconds inside the clip (from clip start 0) marking the most expressive reaction or peak-action thumbnail frame.',
                },
                hashtags: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: '4 to 6 clean topic-relevant hashtags starting with #, always including #BD. Never #0, #1, #2.',
                },
                tags: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: 'Relevant search tags without #.',
                },
                captions: {
                  type: Type.ARRAY,
                  description: 'Timed caption cues relative to clip start (0s).',
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      start_offset_seconds: {
                        type: Type.NUMBER,
                        description: 'Cue start seconds from clip start.',
                      },
                      end_offset_seconds: {
                        type: Type.NUMBER,
                        description: 'Cue end seconds from clip start.',
                      },
                      text: {
                        type: Type.STRING,
                        description: 'Short readable caption text.',
                      },
                    },
                    required: ['start_offset_seconds', 'end_offset_seconds', 'text'],
                  },
                },
              },
              required: [
                'category',
                'start_seconds',
                'end_seconds',
                'language_choice',
                'moment_summary',
                'viral_reason',
                'title',
                'description',
                'thumbnail_hook',
                'thumbnail_timestamp',
                'hashtags',
                'tags',
                'captions',
              ],
            },
          },
        },
        required: ['moments'],
      },
    },
  });
  } finally {
    clearTimeout(timeoutTimer);
    if (watchdogSignal) {
      watchdogSignal.removeEventListener('abort', onWatchdogAbort);
    }
  }

  const rawText = (response.text ?? '').trim();
  if (!rawText) {
    throw new Error('Gemini returned an empty response for the video segment.');
  }

  const parsed = JSON.parse(rawText) as ChunkAnalysisResult;
  return {
    moments: Array.isArray(parsed.moments) ? parsed.moments : [],
  };
}

interface UploadedKeyFile {
  ai: GoogleGenAI;
  uploadedName: string;
  fileUri: string;
  mimeType: string;
}

async function uploadSegmentForKey(
  ai: GoogleGenAI,
  chunkPath: string,
  keyDisplay: string,
  onLog: (level: 'info' | 'success' | 'warn' | 'error', message: string) => void
): Promise<UploadedKeyFile> {
  const maxUploadAttempts = 2;
  for (let uAttempt = 1; uAttempt <= maxUploadAttempts; uAttempt += 1) {
    try {
      onLog('info', `Uploading >15MB segment via Gemini Files API using ${keyDisplay}...`);
      const uploadedFile = await ai.files.upload({
        file: chunkPath,
        config: { mimeType: 'video/mp4' },
      });

      if (!uploadedFile.name) {
        throw new Error('Gemini Files API did not return a valid file resource name.');
      }

      let fileState = uploadedFile;
      let pollCount = 0;
      const maxPolls = 60;

      while (fileState.state !== 'ACTIVE') {
        if (fileState.state === 'FAILED') {
          throw new Error(
            `Gemini video processing failed: ${fileState.error?.message || 'Unknown error'}`
          );
        }
        if (pollCount >= maxPolls) {
          throw new Error('Timed out waiting for Gemini Files API ACTIVE state.');
        }
        await new Promise((resolve) => setTimeout(resolve, 2500));
        fileState = await ai.files.get({ name: uploadedFile.name });
        pollCount += 1;
      }

      if (!fileState.uri) {
        throw new Error('Gemini Files API did not return a playable file URI.');
      }

      return {
        ai,
        uploadedName: uploadedFile.name,
        fileUri: fileState.uri,
        mimeType: fileState.mimeType || 'video/mp4',
      };
    } catch (err) {
      if (uAttempt < maxUploadAttempts && isTransientNetworkError(err)) {
        onLog(
          'warn',
          `Temporary upload issue on ${keyDisplay} (${formatHttpErrorLabel(err)}). Retrying in 2s...`
        );
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Failed to upload video segment to Gemini Files API.');
}

async function sleepWithAbort(ms: number, shouldAbort?: () => boolean): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (shouldAbort?.()) return false;
    await new Promise((r) => setTimeout(r, Math.min(500, Math.max(50, deadline - Date.now()))));
  }
  return !shouldAbort?.();
}

export async function analyzeVideoChunk(
  chunkPath: string,
  chunkDurationSeconds: number,
  onLog: (level: 'info' | 'success' | 'warn' | 'error', message: string) => void,
  formatMode: 'short' | 'long' = 'short',
  shouldAbort?: () => boolean,
  watchdogSignal?: AbortSignal,
  options?: {
    additionalInstructions?: string;
    requirementSpec?: RequirementSpec;
    recentLanguages?: ContentLanguageChoice[];
    recentTitles?: string[];
    videoTitleHint?: string;
    chunkOffsetSeconds?: number;
  }
): Promise<ChunkAnalysisResult> {
  if (!hasUsableGeminiKey()) {
    throw new Error(
      'No usable Gemini API keys available. Add a valid key in System Setup or Settings > Secrets.'
    );
  }

  const fileSizeBytes = fs.existsSync(chunkPath) ? fs.statSync(chunkPath).size : 0;
  const useFilesApi = fileSizeBytes > INLINE_PAYLOAD_LIMIT_BYTES;
  const sizeMb = (fileSizeBytes / (1024 * 1024)).toFixed(2);
  let inlineBase64: string | null = null;

  if (!useFilesApi) {
    inlineBase64 = fs.readFileSync(chunkPath).toString('base64');
    onLog(
      'info',
      `Analysis payload is ${sizeMb} MB (≤ 15 MB) — sending inline video with 60s timeout.`
    );
  } else {
    onLog(
      'info',
      `Analysis payload is ${sizeMb} MB (> 15 MB) — using Gemini Files API upload & ACTIVE polling.`
    );
  }

  const uploadedByKey = new Map<string, UploadedKeyFile>();
  const triedKeyIds = new Set<string>();
  const totalUsableKeys = Math.max(1, getUsableKeyCount());
  const maxKeyRotations = Math.max(3, totalUsableKeys * 2);

  let lastError: unknown;
  let preferredModelOffset = 0;
  let refreshedModelsThisChunk = false;

  try {
    for (let turn = 0; turn < maxKeyRotations; turn += 1) {
      if (shouldAbort?.() || watchdogSignal?.aborted) {
        throw new Error(
          watchdogSignal?.aborted
            ? 'Segment analysis aborted by stall watchdog.'
            : 'Analysis cancelled by stream stop.'
        );
      }

      let selected = acquireGeminiKey(triedKeyIds);

      if (!selected) {
        const waitUntriedMs = getNextCooldownWaitMs(triedKeyIds);
        if (waitUntriedMs === null && triedKeyIds.size > 0) {
          triedKeyIds.clear();
          selected = acquireGeminiKey(triedKeyIds);
        }

        if (!selected) {
          const waitAnyMs = getNextCooldownWaitMs();
          if (waitAnyMs !== null && waitAnyMs <= 35_000) {
            const waitSec = Math.max(1, Math.ceil(waitAnyMs / 1000));
            onLog(
              'warn',
              `All Gemini keys are temporarily cooling down. Waiting ${waitSec}s for next healthy key...`
            );
            const ok = await sleepWithAbort(
              waitAnyMs + 250,
              () => Boolean(shouldAbort?.() || watchdogSignal?.aborted)
            );
            if (!ok) {
              throw new Error('Analysis cancelled while waiting for key cooldown.');
            }
            triedKeyIds.clear();
            selected = acquireGeminiKey(triedKeyIds);
          }
        }
      }

      if (!selected) {
        break;
      }

      const keyDisplay = `${selected.label} (${selected.maskedKey})`;
      const ai = createGeminiClientForKey(selected.apiKey);
      let switchReason: 'next_key' | 'done' = 'next_key';

      try {
        let mediaSource: AnalysisMediaSource;
        if (useFilesApi) {
          let uploaded = uploadedByKey.get(selected.id);
          if (!uploaded) {
            uploaded = await uploadSegmentForKey(ai, chunkPath, keyDisplay, onLog);
            uploadedByKey.set(selected.id, uploaded);
          }
          mediaSource = {
            kind: 'file',
            fileUri: uploaded.fileUri,
            mimeType: uploaded.mimeType,
          };
        } else {
          mediaSource = {
            kind: 'inline',
            data: inlineBase64 || '',
            mimeType: 'video/mp4',
          };
        }

        const triedModelsOnKey = new Set<string>();
        let hadModelLoadIssue = false;

        for (let modelStep = 0; modelStep < 6; modelStep += 1) {
          if (shouldAbort?.() || watchdogSignal?.aborted) {
            throw new Error(
              watchdogSignal?.aborted
                ? 'Segment analysis aborted by stall watchdog.'
                : 'Analysis cancelled by stream stop.'
            );
          }

          const candidates = getActiveCandidateModels();
          const remaining = candidates.filter((m) => !triedModelsOnKey.has(m));
          if (remaining.length === 0) {
            break;
          }

          const model = remaining[preferredModelOffset % remaining.length];
          triedModelsOnKey.add(model);

          if (modelStep === 0) {
            onLog('info', `Scanning segment with ${keyDisplay} (model: ${model})...`);
          }

          try {
            const result = await generateMomentAnalysis({
              ai,
              model,
              media: mediaSource,
              chunkDurationSeconds,
              formatMode,
              additionalInstructions: options?.additionalInstructions,
              requirementSpec: options?.requirementSpec,
              recentLanguages: options?.recentLanguages,
              recentTitles: options?.recentTitles,
              videoTitleHint: options?.videoTitleHint,
              chunkOffsetSeconds: options?.chunkOffsetSeconds,
              watchdogSignal,
            });
            markKeySuccess(selected.id);
            switchReason = 'done';
            return result;
          } catch (err) {
            lastError = err;
            if (watchdogSignal?.aborted) {
              throw err;
            }
            const httpLabel = formatHttpErrorLabel(err);

            if (isInvalidKeyError(err)) {
              const safeMsg = formatSafeGeminiError(err);
              markKeyInvalid(selected.id, safeMsg);
              triedKeyIds.add(selected.id);
              onLog(
                'warn',
                `${keyDisplay} rejected [${httpLabel}] (${safeMsg}). Rotating to next healthy API key...`
              );
              break;
            }

            if (isModelNotFoundError(err)) {
              const safeMsg = formatSafeGeminiError(err);
              quarantineModel(model, safeMsg);
              onLog(
                'warn',
                `Model ${model} returned [${httpLabel}] — quarantined for 30m. Auto-discovering & switching to next valid model...`
              );
              if (!refreshedModelsThisChunk) {
                refreshedModelsThisChunk = true;
                await discoverGeminiModels(true, (lvl, msg) => onLog(lvl, msg));
              }
              continue;
            }

            if (isRateLimitError(err) || isOverloadError(err)) {
              const cooldownMs = computeCooldownMs(err);
              const cooldownSec = Math.ceil(cooldownMs / 1000);
              const errKind = isRateLimitError(err) ? 'rate limit/quota' : 'high demand';
              markKeyRateLimited(selected.id, formatSafeGeminiError(err), cooldownMs);
              triedKeyIds.add(selected.id);

              if (isOverloadError(err)) {
                hadModelLoadIssue = true;
              }

              const hasOtherHealthy =
                getUsableKeyCount() > 1 && getNextCooldownWaitMs(triedKeyIds) === null;
              if (hasOtherHealthy) {
                const backoffMs = Math.min(3000, 600 * Math.pow(2, Math.min(turn, 3)));
                if (isOverloadError(err)) {
                  preferredModelOffset += 1;
                }
                onLog(
                  'warn',
                  `${keyDisplay} hit ${httpLabel} (${errKind}) on ${model} (${cooldownSec}s cooldown). Switching API key in ${(
                    backoffMs / 1000
                  ).toFixed(1)}s...`
                );
                await sleepWithAbort(
                  backoffMs,
                  () => Boolean(shouldAbort?.() || watchdogSignal?.aborted)
                );
                break;
              }

              const nextCandidates = getActiveCandidateModels().filter(
                (m) => !triedModelsOnKey.has(m)
              );
              if (nextCandidates.length > 0) {
                const nextModel = nextCandidates[0];
                const backoffMs = Math.min(4000, 1200 * (modelStep + 1));
                onLog(
                  'warn',
                  `${keyDisplay} hit ${httpLabel} (${errKind}) on ${model}. Retrying with fallback model ${nextModel} in ${(
                    backoffMs / 1000
                  ).toFixed(1)}s...`
                );
                await sleepWithAbort(
                  backoffMs,
                  () => Boolean(shouldAbort?.() || watchdogSignal?.aborted)
                );
                continue;
              }
              break;
            }

            if (isTransientNetworkError(err)) {
              const backoffMs = 1500;
              onLog(
                'warn',
                `Retry triggered on ${keyDisplay} (${model}) due to ${httpLabel}. Retrying in 1.5s...`
              );
              await sleepWithAbort(
                backoffMs,
                () => Boolean(shouldAbort?.() || watchdogSignal?.aborted)
              );
              triedKeyIds.add(selected.id);
              break;
            }

            throw new Error(formatSafeGeminiError(err));
          }
        }

        if (hadModelLoadIssue) {
          preferredModelOffset += 1;
        }
      } catch (err) {
        lastError = err;
        if (watchdogSignal?.aborted) {
          throw err;
        }
        const httpLabel = formatHttpErrorLabel(err);
        if (switchReason === 'done') {
          throw err;
        }
        if (isInvalidKeyError(err)) {
          const safeMsg = formatSafeGeminiError(err);
          markKeyInvalid(selected.id, safeMsg);
          triedKeyIds.add(selected.id);
          onLog(
            'warn',
            `${keyDisplay} failed authentication [${httpLabel}] (${safeMsg}). Switching to next API key...`
          );
        } else if (isRateLimitError(err) || isOverloadError(err)) {
          const cooldownMs = computeCooldownMs(err);
          markKeyRateLimited(selected.id, formatSafeGeminiError(err), cooldownMs);
          triedKeyIds.add(selected.id);
          onLog(
            'warn',
            `${keyDisplay} throttled [${httpLabel}] (${Math.ceil(
              cooldownMs / 1000
            )}s cooldown). Switching API key...`
          );
        } else if (isTransientNetworkError(err)) {
          triedKeyIds.add(selected.id);
          onLog(
            'warn',
            `Upload/network failure [${httpLabel}] on ${keyDisplay}. Rotating to next API key...`
          );
        } else {
          throw new Error(formatSafeGeminiError(err));
        }
      } finally {
        releaseGeminiKey(selected.id);
      }
    }

    throw new Error(
      lastError
        ? formatSafeGeminiError(lastError)
        : 'All Gemini API keys are currently rate-limited or cooling down. Monitoring continues and will retry on the next segment.'
    );
  } finally {
    await Promise.all(
      Array.from(uploadedByKey.values()).map(async (item) => {
        try {
          await item.ai.files.delete({ name: item.uploadedName });
        } catch {
          // Best-effort cleanup
        }
      })
    );
  }
}

function extractJsonObjectFromText<T>(rawText: string): T | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Strip markdown fences or leading prose around JSON
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch?.[1]) {
      try {
        return JSON.parse(fenceMatch[1].trim()) as T;
      } catch {
        // Continue to brace scan
      }
    }
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function buildFallbackThumbnailHook(raw?: string, title?: string): string {
  const cleaned = (raw || title || 'INSANE MOMENT!')
    .replace(/#Shorts/gi, '')
    .replace(/#BD/gi, '')
    .replace(/[^\p{L}\p{M}\p{N} !?.\-&']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const hasBengali = /[\u0980-\u09FF]/.test(cleaned);
  const formatted = hasBengali ? cleaned : cleaned.toUpperCase();
  const words = formatted.split(' ').filter(Boolean).slice(0, 4);
  return (words.join(' ') || 'NO WAY!').slice(0, 32);
}

export async function designSearchGroundedThumbnail(params: {
  title: string;
  category: string;
  viralReason: string;
  formatMode: 'short' | 'long';
  aspectMode: 'portrait' | 'landscape';
  existingHook?: string;
  frameJpegBuffer?: Buffer;
  onLog?: (level: 'info' | 'warn' | 'success', msg: string) => void;
}): Promise<SearchGroundedThumbnailDesign> {
  const fallbackHook = buildFallbackThumbnailHook(params.existingHook, params.title);
  const defaultResult: SearchGroundedThumbnailDesign = {
    thumbnailHookText: fallbackHook,
    textPlacement: 'bottom-left',
    accentTheme: 'yellow_white',
    microBadge: params.formatMode === 'long' ? 'FULL CLIP' : 'VIRAL CLIP',
    searchInsights:
      'High-CTR gaming pattern: bold 2-4 word high-contrast hook text, vivid contrast boost, and face-safe vignette framing.',
    sources: [],
  };

  if (!hasUsableGeminiKey()) {
    return defaultResult;
  }

  const models = getActiveCandidateModels();
  const prompt = [
    `You are a YouTube CTR Strategist & Viral Thumbnail Designer.`,
    `Use Google Search to research current top-performing, high-CTR viral YouTube thumbnail styles for this specific topic/game/niche right now.`,
    ``,
    `Clip Title: "${params.title}"`,
    `Category: "${params.category}"`,
    `Moment Summary: "${params.viralReason}"`,
    `Format: ${params.formatMode === 'long' ? 'Long-Form YouTube Video' : 'YouTube Short'} (${params.aspectMode === 'landscape' ? '16:9 1280x720' : '9:16 1080x1920'})`,
    params.existingHook ? `Initial Hook Idea: "${params.existingHook}"` : '',
    params.frameJpegBuffer
      ? `Inspect the attached video frame carefully so your text placement avoids covering faces, characters, or central focal action.`
      : '',
    ``,
    `Respond ONLY with a single raw JSON object (no markdown commentary) with these exact keys:`,
    `{`,
    `  "thumbnailHookText": "2 TO 4 WORDS ALL CAPS HIGH-CTR HOOK (e.g. NO WAY!, 5-STAR CHAOS!, HE PANICKED!)",`,
    `  "textPlacement": "one of: top-left | top-center | top-right | bottom-left | bottom-center | bottom-right (pick the safest empty area that does NOT cover faces or focal subjects)",`,
    `  "accentTheme": "one of: yellow_white | red_yellow | cyan_white | orange_white",`,
    `  "microBadge": "1-2 word ALL CAPS badge like INSANE or LIVE or CLUTCH",`,
    `  "searchInsights": "1 concise sentence summarizing the viral YouTube thumbnail CTR trend found via Google Search for this topic"`,
    `}`,
  ]
    .filter(Boolean)
    .join('\n');

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
  if (params.frameJpegBuffer && params.frameJpegBuffer.length > 0) {
    parts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: params.frameJpegBuffer.toString('base64'),
      },
    });
  }
  parts.push({ text: prompt });

  const triedKeys = new Set<string>();
  const keyCount = Math.min(3, Math.max(1, getUsableKeyCount()));

  for (let k = 0; k < keyCount; k += 1) {
    const acquired = acquireGeminiKey(triedKeys);
    if (!acquired) break;
    triedKeys.add(acquired.id);
    const ai = createGeminiClientForKey(acquired.apiKey);

    try {
      for (const model of models.slice(0, 3)) {
        // First try with Google Search grounding enabled, then fallback without tool if model rejects search tool
        for (const useSearch of [true, false]) {
          try {
            const response = await ai.models.generateContent({
              model,
              contents: [{ role: 'user', parts }],
              config: {
                abortSignal: AbortSignal.timeout(18_000),
                ...(useSearch ? { tools: [{ googleSearch: {} }] } : {}),
              },
            });

            const parsed = extractJsonObjectFromText<{
              thumbnailHookText?: string;
              textPlacement?: string;
              accentTheme?: string;
              microBadge?: string;
              searchInsights?: string;
            }>(response.text ?? '');

            if (!parsed) {
              continue;
            }

            const validPlacements = new Set<ThumbnailTextPlacement>([
              'top-left',
              'top-center',
              'top-right',
              'bottom-left',
              'bottom-center',
              'bottom-right',
            ]);
            const validThemes = new Set<ThumbnailAccentTheme>([
              'yellow_white',
              'red_yellow',
              'cyan_white',
              'orange_white',
            ]);

            const rawChunks =
              response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
            const sources: Array<{ title: string; uri: string }> = [];
            for (const ch of rawChunks) {
              if (ch?.web?.uri) {
                sources.push({
                  title: ch.web.title || 'YouTube Trend Source',
                  uri: ch.web.uri,
                });
              }
              if (sources.length >= 4) break;
            }

            markKeySuccess(acquired.id);
            const placement = validPlacements.has(parsed.textPlacement as ThumbnailTextPlacement)
              ? (parsed.textPlacement as ThumbnailTextPlacement)
              : 'bottom-left';
            const theme = validThemes.has(parsed.accentTheme as ThumbnailAccentTheme)
              ? (parsed.accentTheme as ThumbnailAccentTheme)
              : 'yellow_white';

            const hookText = buildFallbackThumbnailHook(parsed.thumbnailHookText, fallbackHook);
            const microBadge =
              (parsed.microBadge || 'VIRAL')
                .replace(/[^\p{L}\p{M}\p{N} !?\-]/gu, '')
                .trim()
                .toUpperCase()
                .slice(0, 14) || 'VIRAL';

            if (useSearch) {
              params.onLog?.(
                'info',
                `Google Search-grounded thumbnail styled (${theme}, ${placement}): "${hookText}"${
                  sources.length > 0 ? ` · ${sources.length} trend sources` : ''
                }`
              );
            }

            return {
              thumbnailHookText: hookText,
              textPlacement: placement,
              accentTheme: theme,
              microBadge,
              searchInsights:
                (parsed.searchInsights || defaultResult.searchInsights).trim().slice(0, 260),
              sources,
            };
          } catch (err) {
            if (isInvalidKeyError(err)) {
              markKeyInvalid(acquired.id, formatSafeGeminiError(err));
              break;
            }
            if (isModelNotFoundError(err)) {
              quarantineModel(model, formatSafeGeminiError(err));
              break;
            }
            if (isRateLimitError(err) || isOverloadError(err)) {
              markKeyRateLimited(acquired.id, formatSafeGeminiError(err), computeCooldownMs(err));
              break;
            }
            // If Google Search tool caused 400 on this model, loop tries useSearch=false automatically
          }
        }
      }
    } finally {
      releaseGeminiKey(acquired.id);
    }
  }

  return defaultResult;
}

export async function detectBestWatermarkCornerWithGemini(params: {
  contactSheetJpeg: Buffer;
  aspectMode: 'portrait' | 'landscape';
  hasSubtitles: boolean;
}): Promise<{
  corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  reason: string;
} | null> {
  if (!hasUsableGeminiKey() || !params.contactSheetJpeg.length) {
    return null;
  }

  const acquired = acquireGeminiKey();
  if (!acquired) return null;

  const models = getActiveCandidateModels();
  const model = models[0] || 'gemini-4-hydrogen';

  try {
    const ai = createGeminiClientForKey(acquired.apiKey);
    const prompt = [
      `This 2x2 contact sheet shows 4 sample frames from a ${
        params.aspectMode === 'landscape' ? '16:9 horizontal' : '9:16 vertical'
      } gaming/stream video clip.`,
      `Pick the SINGLE cleanest corner ("top-left", "top-right", "bottom-left", or "bottom-right") to place a persistent "YouTube + GTA6HUB" channel watermark badge across the whole clip.`,
      `Rules:`,
      `- NEVER cover human faces, stream webcams, game minimaps/radar, killfeeds, health/weapon HUD, or central action.`,
      params.hasSubtitles
        ? `- Avoid bottom zones if centered subtitles or bottom UI could collide.`
        : '',
      `- Choose the corner that looks calmest / emptiest (e.g. sky, ceiling, dark margin, or quiet background) across most of the 4 frames.`,
      `Return JSON with {"corner": "...", "reason": "..."}.`,
    ]
      .filter(Boolean)
      .join('\n');

    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: params.contactSheetJpeg.toString('base64'),
          },
        },
        prompt,
      ],
      config: {
        abortSignal: AbortSignal.timeout(12_000),
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            corner: {
              type: Type.STRING,
              description: 'One of: top-left, top-right, bottom-left, bottom-right',
            },
            reason: {
              type: Type.STRING,
              description: 'Short explanation of why this corner avoids HUD/faces/action.',
            },
          },
          required: ['corner', 'reason'],
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '').trim()) as {
      corner?: string;
      reason?: string;
    };
    markKeySuccess(acquired.id);

    if (
      parsed.corner === 'top-left' ||
      parsed.corner === 'top-right' ||
      parsed.corner === 'bottom-left' ||
      parsed.corner === 'bottom-right'
    ) {
      return {
        corner: parsed.corner,
        reason: (parsed.reason || 'Cleanest frame corner detected by Gemini Vision').slice(0, 140),
      };
    }
    return null;
  } catch (err) {
    if (isInvalidKeyError(err)) {
      markKeyInvalid(acquired.id, formatSafeGeminiError(err));
    } else if (isModelNotFoundError(err)) {
      quarantineModel(model, formatSafeGeminiError(err));
    } else if (isRateLimitError(err) || isOverloadError(err)) {
      markKeyRateLimited(acquired.id, formatSafeGeminiError(err), computeCooldownMs(err));
    }
    return null;
  } finally {
    releaseGeminiKey(acquired.id);
  }
}

export async function generateGeminiTextResponse(
  prompt: string,
  systemInstruction?: string
): Promise<string> {
  if (!hasUsableGeminiKey()) {
    throw new Error('No usable Gemini API key is configured.');
  }
  const triedKeys = new Set<string>();
  const models = getActiveCandidateModels();
  let lastError: unknown;

  for (let i = 0; i < Math.min(3, Math.max(1, getUsableKeyCount())); i += 1) {
    const acquired = acquireGeminiKey(triedKeys);
    if (!acquired) break;
    triedKeys.add(acquired.id);
    const ai = createGeminiClientForKey(acquired.apiKey);
    try {
      for (const model of models.slice(0, 3)) {
        try {
          const response = await ai.models.generateContent({
            model,
            contents: prompt,
            config: {
              abortSignal: AbortSignal.timeout(20_000),
              ...(systemInstruction ? { systemInstruction } : {}),
            },
          });
          markKeySuccess(acquired.id);
          const text = (response.text ?? '').trim();
          if (text) return text;
        } catch (err) {
          lastError = err;
          if (isInvalidKeyError(err)) {
            markKeyInvalid(acquired.id, formatSafeGeminiError(err));
            break;
          }
          if (isModelNotFoundError(err)) {
            quarantineModel(model, formatSafeGeminiError(err));
            continue;
          }
          if (isRateLimitError(err) || isOverloadError(err)) {
            markKeyRateLimited(acquired.id, formatSafeGeminiError(err), computeCooldownMs(err));
            break;
          }
          throw err;
        }
      }
    } finally {
      releaseGeminiKey(acquired.id);
    }
  }

  throw new Error(
    lastError ? formatSafeGeminiError(lastError) : 'Gemini text generation failed across available keys.'
  );
}

export interface DetectedFacecamRegion {
  hasFacecam: boolean;
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
  reason: string;
}

export async function detectFacecamRegionWithGemini(
  frameJpeg: Buffer
): Promise<DetectedFacecamRegion | null> {
  if (!hasUsableGeminiKey() || !frameJpeg.length) {
    return null;
  }

  const acquired = acquireGeminiKey();
  if (!acquired) return null;

  const models = getActiveCandidateModels();
  const model = models[0] || 'gemini-4-hydrogen';

  try {
    const ai = createGeminiClientForKey(acquired.apiKey);
    const prompt = [
      'Inspect this horizontal 16:9 gaming or reaction video frame.',
      'Determine whether there is an explicit picture-in-picture streamer facecam / webcam box overlaid on top of gameplay (or side-by-side presenter camera).',
      'Rules:',
      '- Only return hasFacecam=true if a clearly framed human face/webcam box is visible and cleanly separable from main gameplay.',
      '- Provide TIGHT normalized bounding box fractions (0.0 to 1.0) covering ONLY the streamer webcam/facecam rectangle itself (do NOT include surrounding gameplay, overlays outside the camera border, or game HUD): xPct (left), yPct (top), wPct (width), hPct (height).',
      '- If this is pure gameplay with no webcam, or fullscreen talking-head with no separate game window, return hasFacecam=false.',
      'Return JSON matching {"hasFacecam": boolean, "xPct": number, "yPct": number, "wPct": number, "hPct": number, "reason": string}.',
    ].join('\n');

    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: frameJpeg.toString('base64'),
          },
        },
        prompt,
      ],
      config: {
        abortSignal: AbortSignal.timeout(12_000),
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            hasFacecam: { type: Type.BOOLEAN },
            xPct: { type: Type.NUMBER },
            yPct: { type: Type.NUMBER },
            wPct: { type: Type.NUMBER },
            hPct: { type: Type.NUMBER },
            reason: { type: Type.STRING },
          },
          required: ['hasFacecam', 'xPct', 'yPct', 'wPct', 'hPct', 'reason'],
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '').trim()) as Partial<DetectedFacecamRegion>;
    markKeySuccess(acquired.id);

    if (!parsed.hasFacecam) {
      return {
        hasFacecam: false,
        xPct: 0,
        yPct: 0,
        wPct: 0,
        hPct: 0,
        reason: String(parsed.reason || 'No picture-in-picture facecam detected'),
      };
    }

    const clamp = (v: number, min: number, max: number) =>
      Math.max(min, Math.min(max, Number.isFinite(v) ? v : min));

    const wPct = clamp(Number(parsed.wPct), 0.08, 0.55);
    const hPct = clamp(Number(parsed.hPct), 0.08, 0.55);
    const xPct = clamp(Number(parsed.xPct), 0, 1 - wPct);
    const yPct = clamp(Number(parsed.yPct), 0, 1 - hPct);

    return {
      hasFacecam: true,
      xPct,
      yPct,
      wPct,
      hPct,
      reason: String(parsed.reason || 'Streamer facecam box detected').slice(0, 140),
    };
  } catch (err) {
    if (isInvalidKeyError(err)) {
      markKeyInvalid(acquired.id, formatSafeGeminiError(err));
    } else if (isModelNotFoundError(err)) {
      quarantineModel(model, formatSafeGeminiError(err));
    } else if (isRateLimitError(err) || isOverloadError(err)) {
      markKeyRateLimited(acquired.id, formatSafeGeminiError(err), computeCooldownMs(err));
    }
    return null;
  } finally {
    releaseGeminiKey(acquired.id);
  }
}

export async function regenerateClipMetadataWithGemini(params: {
  momentSummary: string;
  viralReason?: string;
  captionsText?: string;
  videoTitleHint?: string;
  category: string;
  formatMode: 'short' | 'long';
  languageChoice: ContentLanguageChoice;
  requirementSummary: string;
  forbiddenTitles: string[];
  frameJpegBuffers?: Buffer[];
}): Promise<{
  moment_summary: string;
  title: string;
  description: string;
  hashtags: string[];
  tags: string[];
} | null> {
  if (!hasUsableGeminiKey()) {
    return null;
  }

  const models = getActiveCandidateModels();
  const triedKeys = new Set<string>();
  const keyCount = Math.min(3, Math.max(1, getUsableKeyCount()));

  const langGuide =
    params.languageChoice === 'bengali'
      ? 'Natural Bangladeshi creator Bangla (বাংলা Unicode script) — punchy, conversational, never robotic translation.'
      : params.languageChoice === 'banglish'
      ? 'Natural Bangladeshi creator Banglish (Bengali+English mix) — energetic, authentic, curiosity-driven.'
      : 'Punchy, curiosity-driven natural creator English.';

  const prompt = [
    `Generate fresh, 100% unique, scene-accurate metadata for ONE ${
      params.formatMode === 'long' ? 'Long-Form YouTube' : 'TikTok & YouTube Shorts'
    } clip.`,
    `Requirement Boundary: ${params.requirementSummary}`,
    params.videoTitleHint ? `Source Video Title: "${params.videoTitleHint}"` : '',
    `Clip Category: ${params.category}`,
    `Clip Moment Summary: "${params.momentSummary}"`,
    params.viralReason ? `Action / Hook Context: "${params.viralReason}"` : '',
    params.captionsText ? `Spoken Dialogue / Captions in Clip: "${params.captionsText}"` : '',
    params.frameJpegBuffers && params.frameJpegBuffers.length > 0
      ? `Inspect the attached keyframe images from inside this exact clip to describe the real visual action, setting, crash, reaction, or twist.`
      : '',
    `Language Style: ${langGuide}`,
    params.forbiddenTitles.length > 0
      ? `FORBIDDEN TITLES ALREADY USED IN THIS BATCH/STREAM (DO NOT REPEAT OR PARAPHRASE THESE):\n${params.forbiddenTitles
          .slice(0, 20)
          .map((t, i) => `  ${i + 1}. "${t}"`)
          .join('\n')}`
      : '',
    `STRICT RULES:`,
    `- Generate a completely unique, curiosity-driven title (max 80 chars) describing THIS exact clip's specific action, reaction, joke, stunt, or twist.`,
    `- NEVER use repetitive templates like "GTA 6 Clutch Moment", "Clutch Action Moment", "Full Action Highlight", "Hashtag Zero", "Hashtag One", "Hashtag Two", "#0", "#1", "#2", "Clip 1", or raw URLs.`,
    `- Write a short engaging caption tailored to this exact moment, ending cleanly with #BD and 3 to 5 clean relevant hashtags.`,
  ]
    .filter(Boolean)
    .join('\n');

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
  for (const buf of (params.frameJpegBuffers || []).slice(0, 3)) {
    if (buf && buf.length > 0) {
      parts.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data: buf.toString('base64'),
        },
      });
    }
  }
  parts.push({ text: prompt });

  for (let k = 0; k < keyCount; k += 1) {
    const acquired = acquireGeminiKey(triedKeys);
    if (!acquired) break;
    triedKeys.add(acquired.id);
    const ai = createGeminiClientForKey(acquired.apiKey);

    try {
      for (const model of models.slice(0, 3)) {
        try {
          const response = await ai.models.generateContent({
            model,
            contents: [{ role: 'user', parts }],
            config: {
              abortSignal: AbortSignal.timeout(20_000),
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  moment_summary: {
                    type: Type.STRING,
                    description: '1 crisp line describing what happens visually/aurally in this clip.',
                  },
                  title: {
                    type: Type.STRING,
                    description: 'Unique curiosity-driven title <= 80 chars matching this exact scene.',
                  },
                  description: {
                    type: Type.STRING,
                    description: 'Short engaging caption tailored to this exact clip + hashtags including #BD.',
                  },
                  hashtags: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: '4 to 6 clean relevant hashtags starting with #, always including #BD. Never #0/#1/#2.',
                  },
                  tags: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: 'Clean SEO keywords without #.',
                  },
                },
                required: ['moment_summary', 'title', 'description', 'hashtags', 'tags'],
              },
            },
          });

          const parsed = extractJsonObjectFromText<{
            moment_summary?: string;
            title?: string;
            description?: string;
            hashtags?: string[];
            tags?: string[];
          }>(response.text ?? '');

          if (parsed && parsed.title) {
            markKeySuccess(acquired.id);
            return {
              moment_summary: parsed.moment_summary || params.momentSummary,
              title: parsed.title,
              description: parsed.description || parsed.moment_summary || params.momentSummary,
              hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
              tags: Array.isArray(parsed.tags) ? parsed.tags : [],
            };
          }
        } catch (err) {
          if (isInvalidKeyError(err)) {
            markKeyInvalid(acquired.id, formatSafeGeminiError(err));
            break;
          }
          if (isModelNotFoundError(err)) {
            quarantineModel(model, formatSafeGeminiError(err));
            continue;
          }
          if (isRateLimitError(err) || isOverloadError(err)) {
            markKeyRateLimited(acquired.id, formatSafeGeminiError(err), computeCooldownMs(err));
            break;
          }
        }
      }
    } finally {
      releaseGeminiKey(acquired.id);
    }
  }

  return null;
}



