import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ContentLanguageChoice, MomentCategory } from '../src/types.ts';
import { getActiveAiProvider } from './aiRouter.ts';
import { isClaudeConfigured, regenerateClipMetadataWithClaude } from './claude.ts';
import {
  isGeminiConfigured,
  regenerateClipMetadataWithGemini,
  type DetectedMoment,
} from './gemini.ts';
import {
  areTitlesSimilar,
  containsDummyOrNumberedTags,
  formatRequirementSummary,
  isGenericOrRepetitiveTitle,
  isLikelyUrl,
  resolveLockedLanguageChoice,
  sanitizeHashtags,
  sanitizeSeoTags,
  sanitizeTitleText,
  stripDummyPhrasesFromText,
  stripUrlsFromText,
  validateAndCleanClipMetadata,
  type ParsedRequirementContext,
} from './requirementEngine.ts';

const execFileAsync = promisify(execFile);

const TEMP_FRAMES_DIR = path.resolve(process.cwd(), 'data', 'temp_frames');

async function extractSampleKeyframes(
  videoPath: string | undefined,
  startSeconds: number,
  endSeconds: number
): Promise<Buffer[]> {
  if (!videoPath || !fs.existsSync(videoPath)) {
    return [];
  }

  try {
    if (!fs.existsSync(TEMP_FRAMES_DIR)) {
      fs.mkdirSync(TEMP_FRAMES_DIR, { recursive: true });
    }
  } catch {
    return [];
  }

  const duration = Math.max(4, endSeconds - startSeconds);
  const offsets = [0.2, 0.52, 0.82].map((ratio) =>
    Math.max(0.2, startSeconds + duration * ratio)
  );
  const buffers: Buffer[] = [];

  for (let i = 0; i < offsets.length; i += 1) {
    const outPath = path.join(
      TEMP_FRAMES_DIR,
      `guard_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}.jpg`
    );
    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-ss',
          offsets[i].toFixed(2),
          '-i',
          videoPath,
          '-frames:v',
          '1',
          '-vf',
          'scale=640:-2',
          '-q:v',
          '5',
          outPath,
        ],
        { timeout: 8000 }
      );
      if (fs.existsSync(outPath)) {
        const buf = fs.readFileSync(outPath);
        if (buf.length > 0) {
          buffers.push(buf);
        }
      }
    } catch {
      // Non-fatal frame probe
    } finally {
      if (fs.existsSync(outPath)) {
        try {
          fs.unlinkSync(outPath);
        } catch {
          // Ignore cleanup
        }
      }
    }
  }

  return buffers;
}

function buildCuriosityUniqueFallbackTitle(params: {
  moment: DetectedMoment;
  languageChoice: ContentLanguageChoice;
  ctx: ParsedRequirementContext;
  videoTitleHint?: string;
  forbiddenTitles: string[];
  batchIndex: number;
}): string {
  const { moment, languageChoice, ctx, videoTitleHint, forbiddenTitles, batchIndex } = params;

  const cleanCaptions = stripDummyPhrasesFromText(
    (moment.captions || []).map((c) => c.text).join(' ')
  ).trim();
  const cleanSummary = stripDummyPhrasesFromText(
    moment.moment_summary || moment.viral_reason || ''
  )
    .replace(/^(?:high-activity|auto-detected|peak)\s+/i, '')
    .replace(/\s+detected via.*$/i, '')
    .replace(/[.!?]+$/, '')
    .trim();

  const cleanVideoTitle = stripUrlsFromText(videoTitleHint || '')
    .replace(/#[^\s]+/g, '')
    .replace(/\|.*$/, '')
    .trim();

  const trimWordSafe = (str: string, maxLen: number) => {
    const t = str.trim();
    if (t.length <= maxLen) return t;
    const cut = t.slice(0, maxLen);
    const sp = cut.lastIndexOf(' ');
    return (sp > Math.floor(maxLen * 0.5) ? cut.slice(0, sp) : cut).trim();
  };

  const topicSubject =
    trimWordSafe(cleanVideoTitle, 32) ||
    ctx.spec.lockedCategories[0] ||
    trimWordSafe(stripUrlsFromText(ctx.spec.topicIdea), 28) ||
    (ctx.isGtaContext ? 'GTA 6' : 'Gameplay');

  // Prefer spoken/action snippet from captions or summary if concrete and non-generic
  const rawAction =
    cleanCaptions.length >= 12 && !isGenericOrRepetitiveTitle(cleanCaptions)
      ? cleanCaptions
      : cleanSummary && !isGenericOrRepetitiveTitle(cleanSummary)
      ? cleanSummary
      : '';

  const shortAction = rawAction
    ? trimWordSafe(rawAction.split(/[.!?|—–]+/)[0].trim(), 48)
    : '';

  const startMin = Math.floor(Math.max(0, moment.start_seconds) / 60);
  const startSec = Math.floor(Math.max(0, moment.start_seconds) % 60);
  const timeTag = startMin > 0 ? `${startMin}m${String(startSec).padStart(2, '0')}s` : `${startSec}s`;

  const candidatesByLang: Record<ContentLanguageChoice, string[]> = {
    bengali: [
      shortAction ? `${shortAction} — এটা কী হলো ভাই!` : `${topicSubject} এ হঠাৎ কী ঘটে গেল দেখো!`,
      shortAction ? `শেষ মুহূর্তের টুইস্ট: ${shortAction}` : `${topicSubject} এর সবচেয়ে অবিশ্বাস্য টুইস্ট!`,
      shortAction ? `কেউ ভাবেনি এমন হবে — ${shortAction}` : `ভাই এই ${topicSubject} সিনটা দেখে মাথা নষ্ট!`,
      shortAction ? `একটুর জন্য বেঁচে গেল: ${shortAction}` : `${topicSubject} এ এমন কাণ্ড আগে দেখোনি!`,
      shortAction ? `হঠাৎ উল্টে গেল গেম: ${shortAction}` : `হঠাৎ উল্টে গেল পুরো গেম (${topicSubject})!`,
      shortAction ? `রিঅ্যাকশন দেখো: ${shortAction}` : `শেষ সেকেন্ডের রিঅ্যাকশন মিস করবা না (${topicSubject})!`,
    ],
    banglish: [
      shortAction ? `${shortAction} — Bhai Ki Twist!` : `${topicSubject} E Hothat Ki Hoye Gelo Dekho!`,
      shortAction ? `Keu Vabeni Emon Hobe: ${shortAction}` : `Bhai Ei ${topicSubject} Scene Ta Dekhe Shocked!`,
      shortAction ? `Last Moment E Ulte Gelo: ${shortAction}` : `${topicSubject} Er Shobcheye Crazy Turn!`,
      shortAction ? `Ektu'r Jonno Bachlo — ${shortAction}` : `Ei ${topicSubject} Moment Miss Korle Afsoos!`,
      shortAction ? `Pure Chaos Live: ${shortAction}` : `${topicSubject} Live E Hothat Chaos Shuru!`,
      shortAction ? `Reaction Dekho: ${shortAction}` : `Reaction Dekho Bhai — ${topicSubject} Twist!`,
    ],
    english: [
      shortAction ? `${shortAction} — Nobody Expected That!` : `The Twist In ${topicSubject} Nobody Expected`,
      shortAction ? `Wait Until The End: ${shortAction}` : `Everything Changed In ${topicSubject} Right Here`,
      shortAction ? `Pure Chaos: ${shortAction}` : `How Did That Just Happen In ${topicSubject}?`,
      shortAction ? `Split-Second Save — ${shortAction}` : `This ${topicSubject} Reaction Broke Everything`,
      shortAction ? `Zero Chance Of Surviving: ${shortAction}` : `Unbelievable Turn Caught Live In ${topicSubject}`,
      shortAction ? `Watch The Turn: ${shortAction}` : `Watch The Exact Moment ${topicSubject} Went Sideways`,
    ],
  };

  const pool = candidatesByLang[languageChoice] || candidatesByLang.banglish;
  const startOffset = batchIndex % pool.length;

  for (let i = 0; i < pool.length; i += 1) {
    const rawCandidate = pool[(startOffset + i) % pool.length];
    const cleanCandidate = sanitizeTitleText(rawCandidate, {
      fallbackSummary: rawAction || topicSubject,
      formatMode: ctx.spec.formatMode,
      languageChoice,
      isGtaContext: ctx.isGtaContext,
      topicHint: topicSubject,
    });
    if (
      cleanCandidate &&
      !isGenericOrRepetitiveTitle(cleanCandidate) &&
      !forbiddenTitles.some((used) => areTitlesSimilar(cleanCandidate, used))
    ) {
      return cleanCandidate;
    }
  }

  // Last-resort scene-stamped unique title if every pool template somehow collided
  const disambiguator =
    languageChoice === 'bengali'
      ? `${topicSubject} — ${timeTag} এর অদ্ভুত টুইস্ট`
      : languageChoice === 'banglish'
      ? `${topicSubject} — ${timeTag} Er Obak Scene`
      : `${topicSubject} — Wild Turn At ${timeTag}`;

  return sanitizeTitleText(disambiguator, {
    formatMode: ctx.spec.formatMode,
    languageChoice,
    isGtaContext: ctx.isGtaContext,
    topicHint: topicSubject,
  });
}

function buildSceneMatchedCaption(params: {
  momentSummary: string;
  rawDescription: string;
  languageChoice: ContentLanguageChoice;
  hashtags: string[];
}): string {
  let cleanDesc = stripDummyPhrasesFromText(params.rawDescription || '');
  if (!cleanDesc || cleanDesc.length < 14 || isLikelyUrl(cleanDesc)) {
    if (params.languageChoice === 'bengali') {
      cleanDesc = `${params.momentSummary} — পুরো ভিডিওটা শেষ পর্যন্ত দেখো!`;
    } else if (params.languageChoice === 'banglish') {
      cleanDesc = `${params.momentSummary} — bhai last porjonto na dekhle miss korba!`;
    } else {
      cleanDesc = `${params.momentSummary} — wait for the ending on this one!`;
    }
  }
  if (!/#bd\b/i.test(cleanDesc)) {
    cleanDesc = `${cleanDesc}\n\n${params.hashtags.join(' ')}`;
  }
  return cleanDesc.slice(0, 2000);
}

export interface BatchGuardResult {
  moments: DetectedMoment[];
  regeneratedCount: number;
}

/**
 * Batch Uniqueness Guard & Fallback Sanitizer:
 * Checks all generated titles and hashtags across a batch (and against existing stream titles).
 * If any title is duplicated, too similar, generic/cliché (e.g. "GTA 6 Clutch Moment"),
 * or contains dummy/numbered tags ("Hashtag Zero", "Hashtag One", "Hashtag Two", "#0", "#1", "#2"),
 * automatically regenerates that clip's title, caption, and hashtags with scene alignment.
 */
export async function ensureUniqueBatchClipMetadata(params: {
  moments: DetectedMoment[];
  existingTitles?: string[];
  ctx: ParsedRequirementContext;
  formatMode: 'short' | 'long';
  videoTitleHint?: string;
  chunkPath?: string;
  onLog?: (level: 'info' | 'warn' | 'success', message: string) => void;
}): Promise<BatchGuardResult> {
  const { moments, ctx, formatMode, videoTitleHint, chunkPath, onLog } = params;
  if (!moments || moments.length === 0) {
    return { moments: [], regeneratedCount: 0 };
  }

  const usedTitles: string[] = (params.existingTitles || [])
    .map((t) => stripDummyPhrasesFromText(t))
    .filter(Boolean);

  const guardedMoments: DetectedMoment[] = [];
  let regeneratedCount = 0;

  for (let idx = 0; idx < moments.length; idx += 1) {
    const rawMoment = moments[idx];
    const langChoice = resolveLockedLanguageChoice(
      rawMoment.language_choice,
      ctx.spec.languagePreference
    );

    const hasDummyInRaw =
      containsDummyOrNumberedTags(rawMoment.title) ||
      containsDummyOrNumberedTags(rawMoment.description) ||
      (rawMoment.hashtags || []).some((h) => containsDummyOrNumberedTags(h)) ||
      isLikelyUrl(rawMoment.title);
    const isRawGeneric = isGenericOrRepetitiveTitle(rawMoment.title);

    // Run baseline sanitizer first
    let cleaned = validateAndCleanClipMetadata({
      moment: {
        category: (rawMoment.category || 'highlight') as MomentCategory,
        moment_summary: rawMoment.moment_summary,
        viral_reason: rawMoment.viral_reason,
        title: rawMoment.title,
        description: rawMoment.description,
        hashtags: rawMoment.hashtags,
        tags: rawMoment.tags,
        language_choice: langChoice,
      },
      ctx,
      clipNumber: idx + 1,
    });

    const isDupTitle = usedTitles.some((prev) => areTitlesSimilar(cleaned.title, prev));
    const isGeneric = isGenericOrRepetitiveTitle(cleaned.title);
    const weakHashtags =
      cleaned.hashtags.length < 4 ||
      cleaned.hashtags.some((h) => containsDummyOrNumberedTags(h));

    if (hasDummyInRaw || isRawGeneric || isDupTitle || isGeneric || weakHashtags) {
      regeneratedCount += 1;
      const reasons: string[] = [];
      if (isDupTitle) reasons.push('duplicate/similar title');
      if (isRawGeneric || isGeneric) reasons.push('generic/cliché title');
      if (hasDummyInRaw || weakHashtags) reasons.push('dummy/numbered tags');

      onLog?.(
        'info',
        `Batch Uniqueness Guard triggered regeneration for clip #${idx + 1} (${reasons.join(', ')}): "${rawMoment.title || cleaned.title}"`
      );

      const captionsText = (rawMoment.captions || [])
        .map((c) => c.text)
        .filter(Boolean)
        .join(' ')
        .slice(0, 400);

      // Extract keyframes when available so AI can visually see the exact clip scene
      const frames = await extractSampleKeyframes(
        chunkPath,
        rawMoment.start_seconds,
        rawMoment.end_seconds
      );

      let aiRegen: {
        moment_summary: string;
        title: string;
        description: string;
        hashtags: string[];
        tags: string[];
      } | null = null;

      const activeProvider = getActiveAiProvider();
      const requirementSummary = formatRequirementSummary(ctx);

      if (activeProvider === 'claude' && isClaudeConfigured() && frames.length === 0) {
        aiRegen = await regenerateClipMetadataWithClaude({
          momentSummary: cleaned.momentSummary,
          viralReason: rawMoment.viral_reason,
          captionsText,
          videoTitleHint,
          category: rawMoment.category || 'highlight',
          formatMode,
          languageChoice: langChoice,
          requirementSummary,
          forbiddenTitles: usedTitles,
        });
      }

      if (!aiRegen && isGeminiConfigured()) {
        aiRegen = await regenerateClipMetadataWithGemini({
          momentSummary: cleaned.momentSummary,
          viralReason: rawMoment.viral_reason,
          captionsText,
          videoTitleHint,
          category: rawMoment.category || 'highlight',
          formatMode,
          languageChoice: langChoice,
          requirementSummary,
          forbiddenTitles: usedTitles,
          frameJpegBuffers: frames,
        });
      }

      if (!aiRegen && isClaudeConfigured()) {
        aiRegen = await regenerateClipMetadataWithClaude({
          momentSummary: cleaned.momentSummary,
          viralReason: rawMoment.viral_reason,
          captionsText,
          videoTitleHint,
          category: rawMoment.category || 'highlight',
          formatMode,
          languageChoice: langChoice,
          requirementSummary,
          forbiddenTitles: usedTitles,
        });
      }

      if (aiRegen) {
        cleaned = validateAndCleanClipMetadata({
          moment: {
            category: (rawMoment.category || 'highlight') as MomentCategory,
            moment_summary: aiRegen.moment_summary,
            viral_reason: rawMoment.viral_reason || aiRegen.moment_summary,
            title: aiRegen.title,
            description: aiRegen.description,
            hashtags: aiRegen.hashtags,
            tags: aiRegen.tags,
            language_choice: langChoice,
          },
          ctx,
          clipNumber: idx + 1,
        });
      }

      // Final guarantee: if AI wasn't available, raw title had to be replaced without AI,
      // or AI still produced a similar/generic title, synthesize a curiosity-driven unique title
      const needCuriosityRewrite =
        (!aiRegen && (hasDummyInRaw || isRawGeneric || isDupTitle || isGeneric)) ||
        isGenericOrRepetitiveTitle(cleaned.title) ||
        usedTitles.some((prev) => areTitlesSimilar(cleaned.title, prev));

      if (needCuriosityRewrite) {
        const uniqueTitle = buildCuriosityUniqueFallbackTitle({
          moment: {
            ...rawMoment,
            moment_summary: cleaned.momentSummary,
          },
          languageChoice: langChoice,
          ctx,
          videoTitleHint,
          forbiddenTitles: usedTitles,
          batchIndex: idx,
        });

        const freshTags = sanitizeHashtags(cleaned.hashtags, {
          isGtaContext: ctx.isGtaContext,
          formatMode,
          lockedCategories: ctx.spec.lockedCategories,
          topicKeywords: ctx.topicKeywords,
          momentCategory: rawMoment.category,
          sceneText: `${cleaned.momentSummary} ${uniqueTitle} ${captionsText}`,
          minRelevant: 3,
          maxRelevant: 5,
        });

        cleaned = {
          ...cleaned,
          title: uniqueTitle,
          hashtags: freshTags,
          description: buildSceneMatchedCaption({
            momentSummary: cleaned.momentSummary,
            rawDescription: aiRegen?.description || cleaned.description,
            languageChoice: langChoice,
            hashtags: freshTags,
          }),
          tags: sanitizeSeoTags(cleaned.tags, {
            isGtaContext: ctx.isGtaContext,
            formatMode,
            lockedCategories: ctx.spec.lockedCategories,
            topicKeywords: ctx.topicKeywords,
          }),
        };
      }
    }

    usedTitles.push(cleaned.title);
    guardedMoments.push({
      ...rawMoment,
      language_choice: cleaned.languageChoice,
      moment_summary: cleaned.momentSummary,
      viral_reason: cleaned.viralReason,
      title: cleaned.title,
      description: cleaned.description,
      hashtags: cleaned.hashtags,
      tags: cleaned.tags,
    });
  }

  return {
    moments: guardedMoments,
    regeneratedCount,
  };
}
