import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import type {
  ClaudeClipEditPlan,
  ClipItem,
  ClipSensorResult,
  ContentLanguageChoice,
  IdeaLanguagePreference,
  ManualClipGeneratedItem,
  ManualClipGenerateInputItem,
  MomentCategory,
  ZernioPlatformPostResult,
  ZernioPublishStatus,
  ZernioUploadMode,
} from '../src/types.ts';
import {
  generateClaudeJson,
  isClaudeConfigured,
  planClipEditingWithClaude,
} from './claude.ts';
import { inspectRenderedClipVideo, runClipSensorAudit, type SensorClipAuditInput } from './clipSensor.ts';
import {
  generateGeminiTextResponse,
  isGeminiConfigured,
  type DetectedMoment,
} from './gemini.ts';
import { ensureUniqueBatchClipMetadata } from './metadataGuard.ts';
import { isYouTubeUrl } from './pipeline.ts';
import {
  areTitlesSimilar,
  parseRequirementSpec,
  resolveLockedLanguageChoice,
  sanitizeHashtags,
  sanitizeSeoTags,
  sanitizeTitleText,
  stripDummyPhrasesFromText,
  stripUrlsFromText,
} from './requirementEngine.ts';
import {
  appendActionLogDetails,
  startActionLog,
  updateActionLog,
} from './actionLog.ts';
import {
  buildAssFilterExpression,
  extractFfmpegStderrTail,
  generateFullDurationCaptionsForSegment,
  validateAssSubtitleFile,
  writeUtf8AssAndSrtSubtitles,
} from './subtitles.ts';
import { buildPortraitSplitScreenLayout } from './videoLayout.ts';
import {
  extractYouTubeSegment,
  extractYouTubeVideoId,
  findPrimaryVideoUrlInText,
} from './youtubeExtractor.ts';
import { hasActiveZernioAuth, uploadClipToZernio } from './zernio.ts';

const execFileAsync = promisify(execFile);

export const MANUAL_CLIPS_DIR = path.resolve(process.cwd(), 'data', 'manual_clips');

function ensureManualClipsDir() {
  if (!fs.existsSync(MANUAL_CLIPS_DIR)) {
    fs.mkdirSync(MANUAL_CLIPS_DIR, { recursive: true });
  }
}

export function parseTimestampToSeconds(raw?: string): number {
  const trimmed = String(raw || '')
    .trim()
    .replace(/s(?:ec(?:onds?)?)?$/i, '')
    .trim();
  if (!trimmed) return 0;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(0, parseFloat(trimmed));
  }
  const parts = trimmed.split(':').map((p) => parseFloat(p));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) {
    return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
  }
  if (parts.length === 2) {
    return Math.max(0, parts[0] * 60 + parts[1]);
  }
  return 0;
}

export function formatSecondsToTimestamp(totalSecs: number, forceHours = false): string {
  const safe = Math.max(0, Math.floor(totalSecs));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  if (h > 0 || forceHours) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function normalizeTimeRange(
  startRaw?: string,
  endRaw?: string,
  fallbackStartSec = 0,
  defaultDurationSec = 30
): { startTime: string; endTime: string; startSec: number; endSec: number } {
  let startSec = parseTimestampToSeconds(startRaw);
  let endSec = parseTimestampToSeconds(endRaw);

  const rawHadHours =
    Boolean(startRaw && (startRaw.match(/:/g) || []).length >= 2) ||
    Boolean(endRaw && (endRaw.match(/:/g) || []).length >= 2);

  if (startSec <= 0 && (!startRaw || !startRaw.trim())) {
    startSec = Math.max(0, fallbackStartSec);
  }

  if (endSec <= 0 || endSec <= startSec) {
    endSec = startSec + Math.max(10, defaultDurationSec);
  }

  return {
    startSec,
    endSec,
    startTime: formatSecondsToTimestamp(startSec, rawHadHours),
    endTime: formatSecondsToTimestamp(endSec, rawHadHours),
  };
}

async function probeMediaStreams(filePath: string): Promise<{
  hasVideo: boolean;
  hasAudio: boolean;
  durationSeconds: number;
}> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { timeout: 12_000 }
  );
  const parsed = JSON.parse(stdout || '{}') as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>;
  };
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  const durationSeconds =
    Number(parsed.format?.duration || videoStream?.duration || audioStream?.duration || 0) || 0;
  return {
    hasVideo: Boolean(videoStream && (videoStream.width || 0) > 0 && (videoStream.height || 0) > 0),
    hasAudio: Boolean(audioStream),
    durationSeconds,
  };
}

async function extractRawSourceSegment(params: {
  sourceUrl: string;
  startSec: number;
  duration: number;
  rawCutPath: string;
}): Promise<void> {
  const { sourceUrl, startSec, duration, rawCutPath } = params;

  if (isYouTubeUrl(sourceUrl)) {
    await extractYouTubeSegment({
      sourceUrl,
      startSec,
      duration,
      rawCutPath,
    });
    return;
  }

  // Non-YouTube direct media / HLS URL extraction
  let nonYtErr = '';
  for (const useInputSeek of [true, false]) {
    try {
      const seekArgs = useInputSeek
        ? ['-ss', String(startSec), '-t', String(duration), '-i', sourceUrl]
        : ['-i', sourceUrl, '-ss', String(startSec), '-t', String(duration)];
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          ...seekArgs,
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-crf',
          '20',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          rawCutPath,
        ],
        { timeout: 65_000 }
      );
      if (fs.existsSync(rawCutPath) && fs.statSync(rawCutPath).size > 4096) {
        return;
      }
    } catch (err) {
      nonYtErr = err instanceof Error ? err.message : String(err);
      if (fs.existsSync(rawCutPath)) {
        try {
          fs.unlinkSync(rawCutPath);
        } catch {}
      }
    }
  }

  if (nonYtErr) {
    throw new Error(
      `Failed to extract real video segment from Source Video URL (${nonYtErr.slice(0, 180)}). Never falling back to test patterns.`
    );
  }

  throw new Error(
    'Real video extraction produced an empty file. Check the Source Video URL and Start/End timestamps.'
  );
}

function buildManualRenderFfmpegArgs(params: {
  rawCutPath: string;
  outPath: string;
  videoGraph: string;
  hasAudio: boolean;
  effectiveDur: number;
  safeMode?: boolean;
}): string[] {
  const preset = params.safeMode ? 'veryfast' : 'fast';
  const crf = params.safeMode ? '23' : '22';
  const extraVideoFlags = params.safeMode ? ['-r', '30', '-threads', '2'] : [];

  if (params.hasAudio) {
    return [
      '-y',
      '-i',
      params.rawCutPath,
      '-filter_complex',
      params.videoGraph,
      '-map',
      '[vout]',
      '-map',
      '0:a:0',
      '-t',
      params.effectiveDur.toFixed(2),
      ...extraVideoFlags,
      '-c:v',
      'libx264',
      '-preset',
      preset,
      '-crf',
      crf,
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      params.outPath,
    ];
  }

  return [
    '-y',
    '-i',
    params.rawCutPath,
    '-f',
    'lavfi',
    '-i',
    'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-filter_complex',
    params.videoGraph,
    '-map',
    '[vout]',
    '-map',
    '1:a:0',
    '-t',
    params.effectiveDur.toFixed(2),
    '-shortest',
    ...extraVideoFlags,
    '-c:v',
    'libx264',
    '-preset',
    preset,
    '-crf',
    crf,
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    '44100',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    params.outPath,
  ];
}

export async function renderLinkClipWithClaude(params: {
  clipNumber?: number;
  sourceVideoUrl?: string;
  startTime?: string;
  endTime?: string;
  notes?: string;
  title?: string;
  description?: string;
  nicheHint?: string;
  languageChoice?: string;
}): Promise<{
  filePath: string;
  editPlan: ClaudeClipEditPlan;
}> {
  ensureManualClipsDir();

  const srcUrl = String(params.sourceVideoUrl || '').trim();
  if (!srcUrl) {
    throw new Error(
      'Source Video URL / Link is required. Paste a YouTube or direct media link to clip and publish.'
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(srcUrl);
  } catch {
    throw new Error(
      'Invalid Source Video URL format. Paste a full https:// YouTube or direct media URL.'
    );
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('Source Video URL must start with https:// or http://.');
  }

  const startSec = parseTimestampToSeconds(params.startTime);
  const endSec = parseTimestampToSeconds(params.endTime);
  if (!params.startTime?.trim() || !params.endTime?.trim() || endSec <= startSec) {
    throw new Error(
      'Valid Start Time and End Time (with End Time > Start Time) are required to clip from Source Video URL.'
    );
  }
  const duration = Math.min(300, Math.max(1, endSec - startSec));
  const vidId = extractYouTubeVideoId(srcUrl);
  const clipTag = params.clipNumber ? `Clip #${params.clipNumber}` : 'Clip';
  const sourceRef = vidId ? `${clipTag} (${vidId})` : clipTag;

  // 1) Claude Clip Editing Plan
  const claudeActionId = startActionLog({
    category: 'claude_edit',
    actionName: 'Claude Editing Plan',
    sourceRef,
    summary: `Planning 9:16 framing & pacing for ${params.startTime}–${params.endTime}...`,
  });
  const editPlan = await planClipEditingWithClaude({
    sourceVideoUrl: srcUrl,
    startTime: params.startTime.trim(),
    endTime: params.endTime.trim(),
    startSeconds: startSec,
    endSeconds: endSec,
    notes: params.notes,
    title: params.title,
    nicheHint: params.nicheHint,
  });
  updateActionLog(claudeActionId, {
    status: 'success',
    summary: `Editing plan ready (${editPlan.framingMode}, bias=${editPlan.cropBias}).`,
    details: editPlan.editingSummary,
  });

  const uniqSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const rawCutPath = path.join(MANUAL_CLIPS_DIR, `raw_seg_${uniqSuffix}.mp4`);
  const assPath = path.join(MANUAL_CLIPS_DIR, `subs_${uniqSuffix}.ass`);
  const outPath = path.join(MANUAL_CLIPS_DIR, `rendered_${uniqSuffix}.mp4`);

  try {
    // 2) Source Video / YouTube Segment Extraction
    const extractActionId = startActionLog({
      category: 'youtube_extract',
      actionName: 'Extract Source Segment',
      sourceRef,
      summary: `Extracting ${duration.toFixed(1)}s segment (${params.startTime}–${params.endTime})...`,
    });
    try {
      await extractRawSourceSegment({
        sourceUrl: srcUrl,
        startSec,
        duration,
        rawCutPath,
      });
    } catch (extErr) {
      const extMsg = extErr instanceof Error ? extErr.message : String(extErr);
      updateActionLog(extractActionId, {
        status: 'error',
        summary: `Source extraction failed for ${sourceRef}.`,
        details: extMsg,
      });
      throw extErr;
    }

    const segProbe = await probeMediaStreams(rawCutPath);
    if (!segProbe.hasVideo) {
      const errMsg = 'Extracted segment from Source Video URL contains no valid video frames.';
      updateActionLog(extractActionId, {
        status: 'error',
        summary: errMsg,
      });
      throw new Error(errMsg);
    }
    updateActionLog(extractActionId, {
      status: 'success',
      summary: `Extracted ${segProbe.durationSeconds.toFixed(1)}s real segment (video=${segProbe.hasVideo}, audio=${segProbe.hasAudio}).`,
    });

    const effectiveDur =
      segProbe.durationSeconds > 1 ? Math.min(duration, segProbe.durationSeconds) : duration;

    // 3) Parallel: 9:16 Split-Screen / Prominent Gameplay Layout + Full-Duration Bangla/Banglish Subtitles
    const [layoutPlan, fullCaptions] = await Promise.all([
      buildPortraitSplitScreenLayout({
        videoPath: rawCutPath,
        seekSeconds: Math.max(0.3, effectiveDur * 0.35),
        cropBias: editPlan.cropBias,
        contrast: editPlan.contrast,
        saturation: editPlan.saturation,
        tempDir: MANUAL_CLIPS_DIR,
        sourceRef,
      }),
      generateFullDurationCaptionsForSegment({
        videoPath: rawCutPath,
        durationSeconds: effectiveDur,
        notes: params.notes,
        title: params.title,
        description: params.description,
        languageChoice: params.languageChoice,
      }),
    ]);

    const wroteSubs = writeUtf8AssAndSrtSubtitles({
      captions: fullCaptions,
      durationSeconds: effectiveDur,
      fallbackText: params.notes || params.title,
      assPath,
      playResX: 1080,
      playResY: 1920,
      splitScreenActive: layoutPlan.isSplitScreen,
    });
    const assValidation = wroteSubs
      ? validateAssSubtitleFile(assPath)
      : {
          valid: false,
          reason: 'No valid subtitle cues generated.',
          dialogueCount: 0,
          hasBengali: false,
          bengaliFontReady: false,
        };

    const renderActionId = startActionLog({
      category: 'ffmpeg_render',
      actionName: 'FFmpeg 9:16 Render & Subtitles',
      sourceRef,
      summary: `Rendering 1080x1920 (${layoutPlan.framingMode})${assValidation.valid ? ` with ${assValidation.dialogueCount} ASS captions` : ' (no valid ASS captions)'}...`,
      details: [
        `Layout: ${layoutPlan.summary}`,
        `ASS Valid: ${assValidation.valid} (dialogues=${assValidation.dialogueCount}, bengali=${assValidation.hasBengali}, notoBengaliReady=${assValidation.bengaliFontReady})`,
        assValidation.reason ? `ASS Note: ${assValidation.reason}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    });

    const videoGraphWithSubs = assValidation.valid
      ? `${layoutPlan.filterGraph};[base]${buildAssFilterExpression(assPath)}[vout]`
      : `${layoutPlan.filterGraph};[base]null[vout]`;
    const videoGraphClean = `${layoutPlan.filterGraph};[base]null[vout]`;

    let subsBurned = assValidation.valid;
    let usedSafeMode = false;

    const runPass = async (graph: string, safeMode: boolean) => {
      if (fs.existsSync(outPath)) {
        try {
          fs.unlinkSync(outPath);
        } catch {}
      }
      const args = buildManualRenderFfmpegArgs({
        rawCutPath,
        outPath,
        videoGraph: graph,
        hasAudio: segProbe.hasAudio,
        effectiveDur,
        safeMode,
      });
      await execFileAsync('ffmpeg', args, {
        timeout: safeMode ? 140_000 : 120_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 4096) {
        throw new Error('Rendered 9:16 video clip produced an empty output file.');
      }
    };

    try {
      // Pass 1: Standard 9:16 + validated .ass subtitles
      await runPass(videoGraphWithSubs, false);
    } catch (err1) {
      const stderr1 = extractFfmpegStderrTail(err1);
      appendActionLogDetails(
        renderActionId,
        `\n[Pass 1 Failed - Retrying safe 30fps/veryfast mode]\n${stderr1}`
      );
      try {
        // Pass 2: Safe framerate (30fps) & veryfast/2-thread retry with .ass subtitles
        usedSafeMode = true;
        await runPass(videoGraphWithSubs, true);
      } catch (err2) {
        const stderr2 = extractFfmpegStderrTail(err2);
        appendActionLogDetails(
          renderActionId,
          `\n[Pass 2 (Safe 30fps + ASS) Failed]\n${stderr2}`
        );

        if (assValidation.valid) {
          // Pass 3: Safe 30fps 9:16 video render without ASS burn-in so subtitle filter errors never abort real video output
          try {
            subsBurned = false;
            await runPass(videoGraphClean, true);
            appendActionLogDetails(
              renderActionId,
              '\n[Pass 3 Succeeded] Rendered clean 9:16 video without ASS burn-in after libass error.'
            );
          } catch (err3) {
            const stderr3 = extractFfmpegStderrTail(err3);
            updateActionLog(renderActionId, {
              status: 'error',
              summary: 'FFmpeg 9:16 clip rendering failed across all passes.',
              details: `${stderr2}\n\n[Pass 3 Clean Video Fallback Failed]\n${stderr3}`,
            });
            throw new Error(`FFmpeg 9:16 render failed:\n${stderr3}`);
          }
        } else {
          updateActionLog(renderActionId, {
            status: 'error',
            summary: 'FFmpeg 9:16 clip rendering failed.',
            details: stderr2,
          });
          throw new Error(`FFmpeg 9:16 render failed:\n${stderr2}`);
        }
      }
    }

    const outSizeKb = Math.round(fs.statSync(outPath).size / 1024);
    updateActionLog(renderActionId, {
      status: 'success',
      summary: `Rendered 1080x1920 (${outSizeKb} KB${usedSafeMode ? ', 30fps safe retry' : ''})${subsBurned ? ' with UTF-8 ASS captions' : ' (subtitles skipped after filter fallback)'}.`,
    });

    return {
      filePath: outPath,
      editPlan: {
        ...editPlan,
        framingMode: layoutPlan.framingMode,
        editingSummary: `${layoutPlan.summary} ${
          subsBurned
            ? 'Full-duration UTF-8 captions burned cleanly.'
            : assValidation.valid
            ? 'Rendered clean 9:16 video without captions after subtitle filter fallback.'
            : ''
        }`.trim(),
      },
    };
  } catch (err) {
    if (fs.existsSync(outPath)) {
      try {
        fs.unlinkSync(outPath);
      } catch {}
    }
    throw err;
  } finally {
    for (const tmp of [rawCutPath, assPath]) {
      if (fs.existsSync(tmp)) {
        try {
          fs.unlinkSync(tmp);
        } catch {}
      }
    }
  }
}



interface RawAiManualItem {
  clip_number?: number;
  id?: string;
  category?: MomentCategory;
  language_choice?: ContentLanguageChoice;
  moment_summary?: string;
  title?: string;
  description?: string;
  hashtags?: string[];
  tags?: string[];
}

function parseJsonObjectFromAiText<T>(rawText: string): T | null {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1]) {
      try {
        return JSON.parse(fence[1].trim()) as T;
      } catch {
        // Fallback to brace scan
      }
    }
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function inferCategoryFromNotes(notes: string): MomentCategory {
  const lower = notes.toLowerCase();
  if (/(?:funny|laugh|hasir|meme|troll|ragdoll|fail|joke|comedy)/.test(lower)) {
    return 'funny';
  }
  if (/(?:react|shocked|scream|surprise|omg|reaction)/.test(lower)) {
    return 'reaction';
  }
  if (/(?:clutch|1v\d|headshot|sniper|wipe|chase|stunt|crash|kill|boss)/.test(lower)) {
    return 'epic_gameplay';
  }
  if (/(?:viral|crazy|insane|twist|unbelievable)/.test(lower)) {
    return 'viral';
  }
  return 'highlight';
}

function trimWordSafe(str: string, maxLen: number): string {
  const t = str.replace(/\s+/g, ' ').trim();
  if (t.length <= maxLen) return t;
  const cut = t.slice(0, maxLen);
  const sp = cut.lastIndexOf(' ');
  return (sp > Math.floor(maxLen * 0.45) ? cut.slice(0, sp) : cut).trim();
}

function buildNoteDrivenDraft(params: {
  item: ManualClipGenerateInputItem;
  index: number;
  languageChoice: ContentLanguageChoice;
  nicheHint: string;
  usedTitles: string[];
}): RawAiManualItem {
  const { item, index, languageChoice, nicheHint, usedTitles } = params;
  const cleanNotes = stripDummyPhrasesFromText(stripUrlsFromText(item.notes)).trim();
  const firstSentence = cleanNotes.split(/[.!?\n]+/)[0].trim();
  const concisePhrase = trimWordSafe(firstSentence, 52);
  const subject = nicheHint.trim() || concisePhrase.split(/\s+/).slice(0, 3).join(' ') || 'Gaming';
  const category = inferCategoryFromNotes(cleanNotes);

  const hookAnglesByLang: Record<ContentLanguageChoice, string[]> = {
    banglish: [
      `${trimWordSafe(firstSentence, 48)} — Bhai Ki Twist!`,
      `Keu Vabeni Emon Hobe: ${trimWordSafe(firstSentence, 54)}`,
      `Last Second E Ki Hoye Gelo — ${trimWordSafe(firstSentence, 46)}`,
      `Ei ${subject} Scene Dekhe Matha Noshto: ${trimWordSafe(firstSentence, 38)}`,
      `Ektu'r Jonno Bachlo — ${trimWordSafe(firstSentence, 52)}`,
      `Pure Chaos Live: ${trimWordSafe(firstSentence, 56)}`,
    ],
    bengali: [
      `${trimWordSafe(firstSentence, 48)} — এটা কী হলো ভাই!`,
      `কেউ ভাবেনি এমন হবে: ${trimWordSafe(firstSentence, 52)}`,
      `শেষ মুহূর্তের টুইস্ট — ${trimWordSafe(firstSentence, 48)}`,
      `ভাই ${subject} এ এমন কাণ্ড আগে দেখোনি: ${trimWordSafe(firstSentence, 38)}`,
      `একটুর জন্য বেঁচে গেল: ${trimWordSafe(firstSentence, 52)}`,
      `হঠাৎ পুরো খেলা উল্টে গেল — ${trimWordSafe(firstSentence, 46)}`,
    ],
    english: [
      `${trimWordSafe(firstSentence, 48)} — Nobody Expected That!`,
      `Wait Until The Twist: ${trimWordSafe(firstSentence, 52)}`,
      `How Did That Just Happen? ${trimWordSafe(firstSentence, 48)}`,
      `Pure Chaos In ${subject}: ${trimWordSafe(firstSentence, 44)}`,
      `Split-Second Turn — ${trimWordSafe(firstSentence, 52)}`,
      `Watch What Happened Right Here: ${trimWordSafe(firstSentence, 44)}`,
    ],
  };

  const pool = hookAnglesByLang[languageChoice] || hookAnglesByLang.banglish;
  const isGta = /gta|grand theft auto|vice city|leonida/i.test(`${cleanNotes} ${nicheHint}`);

  let pickedTitle = '';
  for (let i = 0; i < pool.length; i += 1) {
    const raw = pool[(index + i) % pool.length];
    const sanitized = sanitizeTitleText(raw, {
      fallbackSummary: concisePhrase || cleanNotes,
      formatMode: 'short',
      languageChoice,
      isGtaContext: isGta,
      topicHint: subject,
    });
    if (!usedTitles.some((prev) => areTitlesSimilar(sanitized, prev))) {
      pickedTitle = sanitized;
      break;
    }
  }

  if (!pickedTitle) {
    pickedTitle = sanitizeTitleText(pool[index % pool.length], {
      fallbackSummary: concisePhrase || cleanNotes,
      formatMode: 'short',
      languageChoice,
      isGtaContext: isGta,
      topicHint: subject,
    });
  }

  const sceneTags = sanitizeHashtags([], {
    isGtaContext: isGta,
    formatMode: 'short',
    lockedCategories: nicheHint ? [nicheHint] : [],
    momentCategory: category,
    sceneText: `${cleanNotes} ${nicheHint}`,
    minRelevant: 3,
    maxRelevant: 5,
  });

  const ctasByLang: Record<ContentLanguageChoice, string[]> = {
    banglish: [
      'Bhai last porjonto na dekhle pura twist miss korba!',
      'Ei scene dekhe tomar reaction ki chilo comment e bolo!',
      'Emon crazy moment dekhte thakle like & follow dite bhulo na!',
    ],
    bengali: [
      'পুরো ভিডিওটা শেষ পর্যন্ত দেখো, ভালো লাগলে লাইক ও ফলো দিও!',
      'এই সিনটা দেখে তোমার রিঅ্যাকশন কী ছিল কমেন্টে জানাও!',
      'এমন আরও মজার মুহূর্ত দেখতে পাশে থেকো!',
    ],
    english: [
      'Watch till the end for the full twist and drop your reaction below!',
      'Wait for that final moment — follow for more clips like this!',
      'Nobody saw that ending coming! What would you do here?',
    ],
  };
  const ctaPool = ctasByLang[languageChoice] || ctasByLang.banglish;
  const chosenCta = ctaPool[index % ctaPool.length];
  const description = `${cleanNotes} — ${chosenCta}\n\n${sceneTags.join(' ')}`;

  return {
    id: item.id,
    clip_number: item.clipNumber,
    category,
    language_choice: languageChoice,
    moment_summary: trimWordSafe(cleanNotes, 120),
    title: pickedTitle,
    description,
    hashtags: sceneTags,
    tags: sanitizeSeoTags([], {
      isGtaContext: isGta,
      formatMode: 'short',
      lockedCategories: nicheHint ? [nicheHint] : [],
    }),
  };
}

export async function generateManualClipMetadataBatch(params: {
  clips: ManualClipGenerateInputItem[];
  languagePreference?: IdeaLanguagePreference;
  nicheHint?: string;
  sourceVideoUrl?: string;
  existingTitles?: string[];
}): Promise<ManualClipGeneratedItem[]> {
  const validItems = (params.clips || [])
    .map((c, idx) => ({
      id: String(c.id || `manual_${idx + 1}`),
      clipNumber: Number.isFinite(Number(c.clipNumber)) ? Number(c.clipNumber) : idx + 1,
      notes: stripDummyPhrasesFromText(String(c.notes || '')).trim(),
      startTime: String(c.startTime || '').trim(),
      endTime: String(c.endTime || '').trim(),
      sourceVideoUrl: String(c.sourceVideoUrl || params.sourceVideoUrl || '').trim(),
    }))
    .filter((c) => c.notes.length > 0);

  if (validItems.length === 0) {
    throw new Error('Enter scene details or notes for at least one clip before generating.');
  }

  const languagePref: IdeaLanguagePreference =
    params.languagePreference === 'bengali' ||
    params.languagePreference === 'banglish' ||
    params.languagePreference === 'english' ||
    params.languagePreference === 'any' ||
    params.languagePreference === 'auto'
      ? params.languagePreference
      : 'banglish';

  const nicheHint = stripDummyPhrasesFromText(stripUrlsFromText(params.nicheHint || '')).trim();
  const sourceVideoUrl = String(params.sourceVideoUrl || validItems[0]?.sourceVideoUrl || '').trim();
  const combinedNotes = validItems.map((c) => c.notes).join(' ');

  const reqCtx = parseRequirementSpec({
    topicIdea: [nicheHint, combinedNotes.slice(0, 240)].filter(Boolean).join(' '),
    categories: nicheHint ? [nicheHint] : [],
    languagePreference: languagePref,
    clipCount: validItems.length,
    formatMode: 'short',
    aspectMode: 'portrait',
  });

  const targetLang = resolveLockedLanguageChoice(undefined, reqCtx.spec.languagePreference);
  const existingTitles = Array.isArray(params.existingTitles)
    ? params.existingTitles.map((t) => String(t || '').trim()).filter(Boolean)
    : [];

  const langRule =
    languagePref === 'bengali'
      ? 'STRICT LANGUAGE: Write titles & captions in natural Bangladeshi creator Bangla (বাংলা Unicode script) — engaging and conversational, never stiff translation.'
      : languagePref === 'banglish'
      ? 'STRICT LANGUAGE: Write titles & captions in natural Bangladeshi creator Banglish (Bangla words in English letters mixed with English gaming slang) — energetic, authentic, curiosity-driven.'
      : languagePref === 'english'
      ? 'STRICT LANGUAGE: Write punchy, natural creator English.'
      : 'Pick the most natural language per clip between Banglish or Bangla (বাংলা), matching the user notes.';

  const systemPrompt = `You are a strict TikTok and YouTube Shorts metadata writer for Bangladeshi gaming & creator channels.
You will receive a numbered list of clip notes entered manually by the creator (Clip 1, Clip 2, Clip 3...), with optional start/end times and source video context.
Analyze EACH clip's notes and time range individually and return metadata strictly matching what happens in THAT specific clip moment.

RULES:
1. Per-Clip Unique Scene-Matched Titles: Generate a distinct, curiosity-driven title (max 80 chars) for EVERY clip directly reflecting what happens in that specific clip's notes and time segment. NEVER reuse the same title structure or template across clips in the list!
2. Context Alignment: Write a short, engaging caption/description tailored specifically to that clip's notes/moment. Never hallucinate unrelated games or generic filler.
3. Hashtags: ALWAYS include #BD plus 3 to 5 clean, relevant topic/niche hashtags matching that clip's notes (e.g., #GTA6, #BanglaGaming, #FunnyMoments, #GamingBD).
4. Strictly Forbidden Words/Tags: NEVER generate numbered or dummy words or hashtags anywhere ("GTA 6 Clutch Moment", "Clutch Action Moment", "Hashtag Zero", "Hashtag One", "Hashtag Two", "zero", "one", "two", "#0", "#1", "#2", "Clip 1", "Part 1").
5. ${langRule}`;

  const clipListText = validItems
    .map((item) => {
      const timeSpan =
        item.startTime || item.endTime
          ? ` [Time Range: ${item.startTime || '0'} to ${item.endTime || 'End'}]`
          : '';
      return `Clip #${item.clipNumber}${timeSpan}:\nNotes: ${item.notes}`;
    })
    .join('\n\n');

  const userPrompt = `${nicheHint ? `Channel Topic / Niche Context: "${nicheHint}"\n` : ''}${
    sourceVideoUrl ? `Source Video URL: "${sourceVideoUrl}"\n` : ''
  }${
    existingTitles.length > 0
      ? `ALREADY USED TITLES TO AVOID REPEATING:\n${existingTitles
          .slice(0, 20)
          .map((t, i) => `  ${i + 1}. "${t}"`)
          .join('\n')}\n\n`
      : ''
  }CLIPS TO GENERATE METADATA FOR (${validItems.length} total — return one entry per clip in exact order):
${clipListText}

Respond ONLY with valid JSON matching this exact structure:
{
  "clips": [
    {
      "id": "exact clip id",
      "clip_number": 1,
      "category": "funny | epic_gameplay | highlight | reaction | viral",
      "language_choice": "bengali | banglish | english",
      "moment_summary": "1 concise line summarizing what happens in this clip",
      "title": "Unique, curiosity-driven title <= 80 chars matching THIS clip's notes",
      "description": "Engaging creator caption strictly matching THIS clip's notes + #BD and 3-5 relevant hashtags",
      "hashtags": ["#BD", "#RelevantTag1", "#RelevantTag2", "#RelevantTag3"],
      "tags": ["BD", "RelevantTag1", "RelevantTag2"]
    }
  ]
}`;

  let aiClips: RawAiManualItem[] = [];
  let claudeUsed = false;
  let claudeDiagnostic: string | undefined;

  if (isClaudeConfigured()) {
    try {
      const res = await generateClaudeJson<{ clips?: RawAiManualItem[] }>(userPrompt, systemPrompt);
      if (Array.isArray(res?.clips) && res.clips.length > 0) {
        aiClips = res.clips;
        claudeUsed = true;
      } else {
        claudeDiagnostic = 'Claude returned empty clip list; falling back safely.';
      }
    } catch (err) {
      claudeDiagnostic = `Claude generation fallback (${(err instanceof Error ? err.message : String(err)).slice(0, 120)}).`;
      aiClips = [];
    }
  } else {
    claudeDiagnostic =
      'Claude API key is not configured; using fallback metadata generator.';
  }

  if (aiClips.length === 0 && isGeminiConfigured()) {
    try {
      const rawText = await generateGeminiTextResponse(userPrompt, systemPrompt);
      const parsed = parseJsonObjectFromAiText<{ clips?: RawAiManualItem[] }>(rawText);
      if (Array.isArray(parsed?.clips)) aiClips = parsed.clips;
    } catch {
      aiClips = [];
    }
  }

  // Pair each requested item with AI result or deterministic note-grounded draft
  const draftTitlesSeen: string[] = [...existingTitles];
  const rawMoments: DetectedMoment[] = validItems.map((item, idx) => {
    const matchedAi =
      aiClips.find((c) => c.id === item.id) ||
      aiClips.find((c) => Number(c.clip_number) === item.clipNumber) ||
      aiClips[idx];

    const fallback = buildNoteDrivenDraft({
      item,
      index: idx,
      languageChoice: targetLang,
      nicheHint,
      usedTitles: draftTitlesSeen,
    });

    const chosen = matchedAi && matchedAi.title ? matchedAi : fallback;
    if (chosen.title) {
      draftTitlesSeen.push(String(chosen.title));
    }

    const langChoice = resolveLockedLanguageChoice(
      chosen.language_choice,
      reqCtx.spec.languagePreference
    );

    const summary = stripDummyPhrasesFromText(
      chosen.moment_summary || fallback.moment_summary || item.notes.slice(0, 120)
    )
      .trim()
      .slice(0, 140);

    return {
      category: (chosen.category || fallback.category || 'highlight') as MomentCategory,
      start_seconds: 0,
      end_seconds: 30,
      language_choice: langChoice,
      moment_summary: summary,
      viral_reason: item.notes.slice(0, 260),
      title: String(chosen.title || fallback.title || ''),
      description: String(chosen.description || fallback.description || ''),
      thumbnail_hook: 'WATCH THIS',
      thumbnail_timestamp: 5,
      hashtags: Array.isArray(chosen.hashtags) ? chosen.hashtags : fallback.hashtags || [],
      tags: Array.isArray(chosen.tags) ? chosen.tags : fallback.tags || [],
      captions: [
        {
          start_offset_seconds: 0,
          end_offset_seconds: 5,
          text: item.notes.slice(0, 220),
        },
      ],
    };
  });

  // Run Batch Uniqueness Guard & Dummy/Numbered Tag Sanitizer across all rows
  const guarded = await ensureUniqueBatchClipMetadata({
    moments: rawMoments,
    existingTitles,
    ctx: reqCtx,
    formatMode: 'short',
    videoTitleHint: nicheHint || validItems[0].notes.slice(0, 48),
  });

  return validItems.map((item, idx) => {
    const m = guarded.moments[idx] || rawMoments[idx];
    return {
      id: item.id,
      clipNumber: item.clipNumber,
      notes: item.notes,
      startTime: item.startTime,
      endTime: item.endTime,
      ...(item.sourceVideoUrl || sourceVideoUrl
        ? { sourceVideoUrl: item.sourceVideoUrl || sourceVideoUrl }
        : {}),
      momentSummary: m.moment_summary || item.notes.slice(0, 120),
      title: m.title,
      description: m.description,
      hashtags: m.hashtags,
      tags: m.tags,
      languageChoice: (m.language_choice || targetLang) as ContentLanguageChoice,
      claudeUsed,
      ...(claudeDiagnostic ? { claudeDiagnostic } : {}),
    };
  });
}

export async function auditManualClipsBatch(params: {
  clips: Array<{
    id: string;
    clipNumber: number;
    notes: string;
    startTime?: string;
    endTime?: string;
    title: string;
    description: string;
    hashtags: string[];
    sourceVideoUrl?: string;
  }>;
  sourceVideoUrl?: string;
  nicheHint?: string;
  languagePreference?: string;
  enableVisualAudit?: boolean;
}): Promise<ClipSensorResult[]> {
  const inputs: SensorClipAuditInput[] = (params.clips || []).map((c, idx) => ({
    id: String(c.id || `clip_${idx + 1}`),
    clipNumber: Number(c.clipNumber) || idx + 1,
    notes: String(c.notes || '').trim(),
    startTime: c.startTime ? String(c.startTime).trim() : undefined,
    endTime: c.endTime ? String(c.endTime).trim() : undefined,
    title: String(c.title || '').trim(),
    description: String(c.description || '').trim(),
    hashtags: Array.isArray(c.hashtags) ? c.hashtags : [],
    sourceVideoUrl: c.sourceVideoUrl || params.sourceVideoUrl,
  }));

  const vidId = extractYouTubeVideoId(params.sourceVideoUrl);
  const sensorActId = startActionLog({
    category: 'gemini_sensor',
    actionName: 'Gemini Flash Sensor Audit',
    sourceRef: vidId ? `${inputs.length} clips (${vidId})` : `${inputs.length} clips`,
    summary: `Inspecting timelines, metadata & visual readiness across ${inputs.length} clips...`,
  });

  try {
    const results = await runClipSensorAudit({
      clips: inputs,
      sourceVideoUrl: params.sourceVideoUrl,
      nicheHint: params.nicheHint,
      languagePreference: params.languagePreference,
      enableVisualAudit: params.enableVisualAudit,
    });
    const blockedCount = results.filter((r) => r.status === 'blocked').length;
    const warnCount = results.filter((r) => r.status === 'warning').length;
    updateActionLog(sensorActId, {
      status: blockedCount > 0 ? 'error' : 'success',
      summary:
        blockedCount > 0
          ? `Sensor blocked ${blockedCount} clip(s), ${warnCount} warning(s).`
          : `All ${results.length} clip(s) passed Sensor Guard (${warnCount} warning(s)).`,
      details: results
        .map(
          (r) =>
            `Clip #${r.clipNumber}: ${r.status.toUpperCase()}${
              r.issues.length > 0 ? ' — ' + r.issues.map((i) => i.message).join(' | ') : ''
            }`
        )
        .join('\n'),
    });
    return results;
  } catch (err) {
    updateActionLog(sensorActId, {
      status: 'error',
      summary: 'Sensor Guard audit failed.',
      details: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export async function publishManualClipToZernio(params: {
  clipNumber: number;
  title: string;
  description: string;
  hashtags: string[];
  notes?: string;
  sourceVideoUrl?: string;
  startTime?: string;
  endTime?: string;
  nicheHint?: string;
  languageChoice?: string;
  accountIds?: string[];
  uploadMode?: ZernioUploadMode;
}): Promise<{
  status: ZernioPublishStatus;
  postId: string;
  platformResults: ZernioPlatformPostResult[];
  claudeEditPlan: ClaudeClipEditPlan;
}> {
  if (!hasActiveZernioAuth()) {
    throw new Error('Zernio is not connected. Sign in with Zernio first.');
  }

  // Layer 1 & 2 Pre-Cut Link & Timeline Gate
  if (!params.sourceVideoUrl?.trim()) {
    throw new Error('Sensor Blocked (Source): Source Video URL / Link is required before publishing.');
  }
  if (!params.startTime?.trim() || !params.endTime?.trim()) {
    throw new Error('Sensor Blocked (Timeline): Start Time and End Time are required.');
  }
  const startS = parseTimestampToSeconds(params.startTime);
  const endS = parseTimestampToSeconds(params.endTime);
  if (endS <= startS) {
    throw new Error(
      `Sensor Blocked (Timeline): End Time (${params.endTime}) must be strictly greater than Start Time (${params.startTime}).`
    );
  }

  const rawTitle = String(params.title || '').trim();
  if (!rawTitle) {
    throw new Error('Sensor Blocked (Metadata): Title is required before uploading to Zernio.');
  }
  if (/[▯□\uFFFD]/.test(`${rawTitle} ${params.description || ''}`)) {
    throw new Error(
      'Sensor Blocked (Metadata): Broken box characters (▯/□) detected in Title or Description.'
    );
  }

  const cleanTitle = sanitizeTitleText(rawTitle, {
    fallbackSummary: params.notes || params.description.slice(0, 120),
    formatMode: 'short',
    isGtaContext: /gta|grand theft auto/i.test(`${rawTitle} ${params.description}`),
  });

  if (!cleanTitle) {
    throw new Error('Sensor Blocked (Metadata): Title is required before uploading to Zernio.');
  }

  const cleanHashtags = sanitizeHashtags(params.hashtags, {
    isGtaContext: /gta|grand theft auto/i.test(`${cleanTitle} ${params.description}`),
    formatMode: 'short',
    sceneText: `${cleanTitle} ${params.notes || ''} ${params.description}`,
    minRelevant: 3,
    maxRelevant: 5,
  });

  let cleanDesc = stripDummyPhrasesFromText(params.description || '').trim();
  if (!cleanDesc) {
    cleanDesc = `${cleanTitle}\n\n${cleanHashtags.join(' ')}`;
  } else if (!/#bd\b/i.test(cleanDesc)) {
    cleanDesc = `${cleanDesc}\n\n${cleanHashtags.join(' ')}`;
  }

  const vidId = extractYouTubeVideoId(params.sourceVideoUrl);
  const sourceRef = vidId
    ? `Clip #${params.clipNumber} (${vidId})`
    : `Clip #${params.clipNumber}`;

  // Cut real segment from Source Video URL using Claude 9:16 split-screen/vertical framing + full-duration Bangla/Banglish subtitles
  const {
    filePath: resolvedPath,
    editPlan,
  } = await renderLinkClipWithClaude({
    clipNumber: params.clipNumber,
    sourceVideoUrl: params.sourceVideoUrl,
    startTime: params.startTime,
    endTime: params.endTime,
    notes: params.notes,
    title: cleanTitle,
    description: cleanDesc,
    nicheHint: params.nicheHint,
    languageChoice: params.languageChoice,
  });

  try {
    // Visual & Frame Sensor Gate BEFORE sending to Zernio/TikTok
    const visualActId = startActionLog({
      category: 'gemini_sensor',
      actionName: 'Pre-Publish Visual Sensor',
      sourceRef,
      summary: 'Inspecting rendered 9:16 frames for black screens, audio & glyphs...',
    });
    const visualReport = await inspectRenderedClipVideo(resolvedPath, {
      enableVisionAudit: true,
    });
    if (!visualReport.passed) {
      const reason =
        visualReport.issues[0] ||
        'Rendered video failed Visual Sensor inspection (black screen, test pattern, or corrupted frames).';
      updateActionLog(visualActId, {
        status: 'error',
        summary: `Visual Sensor blocked upload: ${reason}`,
        details: JSON.stringify(visualReport, null, 2),
      });
      throw new Error(`Visual Sensor Blocked Upload: ${reason}`);
    }
    updateActionLog(visualActId, {
      status: 'success',
      summary: `Passed (${visualReport.width}x${visualReport.height}, ${visualReport.durationSeconds}s, AAC audio OK).`,
      details: visualReport.visualSummary,
    });

    const syntheticClip: ClipItem = {
      id: `manual_${params.clipNumber}_${Date.now()}`,
      streamId: 'manual_studio',
      streamLabel: 'Manual Clip Studio',
      clipNumber: params.clipNumber,
      formatMode: 'short',
      aspectMode: 'portrait',
      chunkIndex: 0,
      category: 'highlight',
      status: 'completed',
      attempts: 1,
      maxAttempts: 1,
      title: cleanTitle,
      description: cleanDesc,
      hashtags: cleanHashtags,
      tags: cleanHashtags.map((h) => h.replace(/^#/, '')),
      viralReason: cleanTitle,
      captions: [],
      startSeconds: startS,
      endSeconds: endS,
      durationSeconds: Math.max(5, endS - startS),
      createdAt: new Date().toISOString(),
    };

    const zernioActId = startActionLog({
      category: 'zernio_upload',
      actionName: 'Zernio Publish / Upload',
      sourceRef,
      summary: `Uploading "${cleanTitle}" via Zernio...`,
    });

    try {
      const publishRes = await uploadClipToZernio({
        clip: syntheticClip,
        clipFilePath: resolvedPath,
        skipVisualSensor: true,
        accountIdsOverride:
          Array.isArray(params.accountIds) && params.accountIds.length > 0
            ? params.accountIds
            : undefined,
        uploadModeOverride: params.uploadMode,
      });

      updateActionLog(zernioActId, {
        status: publishRes.status === 'failed' ? 'error' : 'success',
        summary:
          publishRes.status === 'failed'
            ? `Zernio upload failed (post=${publishRes.postId || 'none'}).`
            : `Uploaded to Zernio (${publishRes.status}, Post ID: ${publishRes.postId}).`,
        details: JSON.stringify(publishRes.platformResults || [], null, 2),
      });

      return {
        ...publishRes,
        claudeEditPlan: editPlan,
      };
    } catch (upErr) {
      updateActionLog(zernioActId, {
        status: 'error',
        summary: `Zernio upload failed for ${sourceRef}.`,
        details: upErr instanceof Error ? upErr.message : String(upErr),
      });
      throw upErr;
    }
  } finally {
    if (fs.existsSync(resolvedPath)) {
      try {
        fs.unlinkSync(resolvedPath);
      } catch {}
    }
  }
}

export function parseRawClipBreakdown(
  text: string,
  sourceVideoUrl?: string
): ManualClipGenerateInputItem[] {
  const cleanText = text.replace(/\r\n/g, '\n').trim();
  if (!cleanText) return [];

  const pastedUrl = findPrimaryVideoUrlInText(cleanText);
  const effectiveSourceUrl = pastedUrl || sourceVideoUrl;
  let remainingText = cleanText;

  // Strip standalone YouTube or video URL lines so they don't pollute clip notes
  remainingText = remainingText
    .replace(/(?:^|\n)\s*(?:source(?:\s*video)?(?:\s*url|\s*link)?\s*[:=]\s*)?https?:\/\/[^\s]+\s*(?=\n|$)/gi, '\n')
    .trim();

  // Check if text is JSON (e.g. exported breakdown)
  const jsonParsed = parseJsonObjectFromAiText<any>(remainingText);
  if (jsonParsed && (Array.isArray(jsonParsed.clips) || Array.isArray(jsonParsed))) {
    const list = Array.isArray(jsonParsed.clips) ? jsonParsed.clips : jsonParsed;
    let prevEnd = 0;
    return list.map((item: any, idx: number) => {
      const clipNumber = Number(item.clip_number || item.clipNumber) || idx + 1;
      const notes = String(
        item.notes ||
          item.moment_summary ||
          item.momentSummary ||
          item.sceneInfo ||
          item.scene_info ||
          item.title ||
          `Clip #${clipNumber} gaming highlight`
      ).trim();
      const rawStart = String(item.startTime || item.start_time || item.start || '');
      const rawEnd = String(item.endTime || item.end_time || item.end || '');
      const defaultStart = prevEnd > 0 ? prevEnd + 10 : 15;
      const range = normalizeTimeRange(rawStart, rawEnd, defaultStart, 30);
      prevEnd = range.endSec;
      return {
        id: `ai_det_${Date.now()}_${idx + 1}`,
        clipNumber,
        notes,
        startTime: range.startTime,
        endTime: range.endTime,
        sourceVideoUrl: effectiveSourceUrl,
      };
    });
  }

  // Segment text into clip blocks
  let blocks: string[] = [];

  // Delimiter 1: Explicit clip header (e.g., "Clip 1", "Clip #1", "Part 2", "Moment 3", "খণ্ড ১", "পর্ব ১")
  const clipHeaderRegex = /(?:^|\n+)(?=(?:(?:clip|moment|part|scene|video|খণ্ড|পর্ব|ভিডিও)\s*#?\s*\d+\b|#\d+\b))/i;
  const splitClipHeaders = remainingText.split(clipHeaderRegex).map((b) => b.trim()).filter(Boolean);
  if (splitClipHeaders.length >= 2) {
    blocks = splitClipHeaders;
  }

  // Delimiter 2: Numbered lists at line start (e.g., "1. ", "2) ", "3 - ")
  if (blocks.length < 2) {
    const numberedListRegex = /(?:^|\n+)(?=\d+[\.\)\-]\s+)/;
    const splitNumbered = remainingText.split(numberedListRegex).map((b) => b.trim()).filter(Boolean);
    if (splitNumbered.length >= 2) {
      blocks = splitNumbered;
    }
  }

  // Delimiter 3: Timestamp range headers at line start (e.g., "[00:15 - 00:45]" or "00:15 - 00:45")
  if (blocks.length < 2) {
    const timeRangeHeaderRegex = /(?:^|\n+)(?=(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*(?:[-–—~]|to|থেকে)\s*\[?\d{1,2}:\d{2}(?::\d{2})?\]?))/i;
    const splitTimeRange = remainingText.split(timeRangeHeaderRegex).map((b) => b.trim()).filter(Boolean);
    if (splitTimeRange.length >= 2) {
      blocks = splitTimeRange;
    }
  }

  // Delimiter 4: Bulleted list (- or * or •)
  if (blocks.length < 2) {
    const bulletRegex = /(?:^|\n+)(?=[-*•]\s+)/;
    const splitBullets = remainingText.split(bulletRegex).map((b) => b.trim()).filter(Boolean);
    if (splitBullets.length >= 2) {
      blocks = splitBullets;
    }
  }

  // Delimiter 5: Double newlines \n\n
  if (blocks.length < 2) {
    const splitParagraphs = remainingText.split(/\n\s*\n+/).map((b) => b.trim()).filter(Boolean);
    if (splitParagraphs.length >= 2) {
      blocks = splitParagraphs;
    }
  }

  if (blocks.length === 0) {
    blocks = [remainingText];
  }

  // Now parse each block strictly to its own item
  let lastEndSec = 0;
  const parsedClips: ManualClipGenerateInputItem[] = [];

  for (let idx = 0; idx < blocks.length; idx += 1) {
    const block = blocks[idx];
    const clipNumMatch = block.match(/(?:clip|moment|part|scene|video|খণ্ড|পর্ব|ভিডিও)?\s*#?\s*(\d+)/i);
    const clipNumber = clipNumMatch ? parseInt(clipNumMatch[1], 10) : idx + 1;

    let rawStart = '';
    let rawEnd = '';

    // 1. Check for complete inline range pattern first (e.g., "00:24 - 00:48", "01:07 থেকে 01:32", "02:15 to 02:40", "10 to 25")
    const rangeMatch = block.match(
      /(?:\[|\()?\s*([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?|[0-9]+s?)\s*(?:[-–—~]|to|থেকে|til|until)\s*([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?|[0-9]+s?)\s*(?:\]|\))?/i
    );
    if (rangeMatch) {
      rawStart = rangeMatch[1];
      rawEnd = rangeMatch[2];
    } else {
      // 2. Otherwise check for separate labels: "Start Time: 00:24", "End Time: 00:48", "শুরু: 00:24", "শেষ: 00:48"
      const labeledStartMatch = block.match(
        /(?:start(?:\s*time)?|shuru|শুরু)\s*[:=\-–—]?\s*([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?|[0-9]+s?)/i
      );
      if (labeledStartMatch) {
        rawStart = labeledStartMatch[1];
      }

      const labeledEndMatch = block.match(
        /(?:end(?:\s*time)?|shesh|শেষ)\s*[:=\-–—]?\s*([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?|[0-9]+s?)/i
      );
      if (labeledEndMatch) {
        rawEnd = labeledEndMatch[1];
      }
    }

    // If still no range, look for a single timestamp e.g. "at 00:24" or "@ 01:15"
    if (!rawStart && !rawEnd) {
      const singleMatch = block.match(/(?:at|@|time|timestamp|সময়)\s*[:=\-–—]?\s*([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?|[0-9]+s?)/i);
      if (singleMatch) {
        rawStart = singleMatch[1];
      }
    }

    // Default timeline allocation when missing or unspecified
    const fallbackStart = lastEndSec > 0 ? lastEndSec + 10 : (idx === 0 ? 15 : idx * 40 + 15);
    let timeRange = normalizeTimeRange(rawStart, rawEnd, fallbackStart, 30);

    // Guarantee distinct timelines: if startSec is identical to or overlaps previous clip, shift forward
    if (idx > 0 && timeRange.startSec <= lastEndSec) {
      const shiftedStart = lastEndSec + 10;
      const duration = Math.max(15, timeRange.endSec - timeRange.startSec);
      timeRange = {
        startSec: shiftedStart,
        endSec: shiftedStart + duration,
        startTime: formatSecondsToTimestamp(shiftedStart, timeRange.startTime.length > 5),
        endTime: formatSecondsToTimestamp(shiftedStart + duration, timeRange.endTime.length > 5),
      };
    }

    lastEndSec = timeRange.endSec;

    // Extract scene info / notes
    let notes = '';
    const labeledNotesMatch = block.match(/(?:scene(?:\s*info)?|notes?|context|moment(?:\s*info)?|দৃশ্য|সিন|নোট)\s*[:=]\s*([^\n]+(?:\n[^\n]+)*?)(?=\n\s*(?:title|headline|desc|description|hashtags?|tags?|clip|\d+[\.\)]|$))/i);
    if (labeledNotesMatch) {
      notes = labeledNotesMatch[1].trim();
    } else {
      // Process lines, stripping clip header prefix, numbered bullet, timestamp range, and labels
      const cleanedLines = block
        .split('\n')
        .map((line) => {
          let l = line.trim();
          if (!l) return '';
          // Strip clip header prefix e.g. "Clip 1:" or "Clip #1 -"
          l = l.replace(/^(?:clip|moment|part|scene|video|খণ্ড|পর্ব|ভিডিও)\s*#?\s*\d+[:\-–—\s]*/i, '');
          // Strip numbered bullet e.g. "1. " or "2) "
          l = l.replace(/^\d+[\.\)\-]\s*/, '');
          // Strip labeled start/end e.g. "Start Time: 00:24"
          if (/^(?:start(?:\s*time)?|end(?:\s*time)?|from|to|shuru|shesh|শুরু|শেষ)\s*[:=\-–—]/i.test(l)) {
            return '';
          }
          if (/^(?:title|headline|description|caption|hashtags?|tags?)\s*[:=]/i.test(l)) {
            return '';
          }
          // Strip timestamp range from line e.g. "00:24-00:48" or "01:07 থেকে 01:32"
          l = l.replace(/(?:\[|\()?\s*[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\s*(?:[-–—~]|to|থেকে|til|until)\s*[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\s*(?:\]|\))?/gi, '');
          // Strip leading punctuation left behind like ": " or "- "
          l = l.replace(/^[:\-–—\s]+/, '').trim();
          return l;
        })
        .filter(Boolean);

      notes = cleanedLines.join(' ').replace(/\s+/g, ' ').trim();
    }

    if (!notes) {
      notes = `Clip #${clipNumber} gaming highlight moment`;
    }

    parsedClips.push({
      id: `ai_det_${Date.now()}_${idx + 1}`,
      clipNumber,
      notes,
      startTime: timeRange.startTime,
      endTime: timeRange.endTime,
      sourceVideoUrl: effectiveSourceUrl,
    });
  }

  return parsedClips;
}

export async function detectAndAutoFillManualClips(params: {
  pastedText: string;
  sourceVideoUrl?: string;
  languagePreference?: IdeaLanguagePreference;
  nicheHint?: string;
}): Promise<ManualClipGeneratedItem[]> {
  const text = String(params.pastedText || '').trim();
  if (!text) {
    throw new Error('Please paste a raw clip breakdown, notes, or transcript to analyze.');
  }

  const parsedInputs = parseRawClipBreakdown(text, params.sourceVideoUrl);

  if (parsedInputs.length === 0) {
    throw new Error('Could not parse any clips from the provided text.');
  }

  const resolvedSourceUrl = parsedInputs[0]?.sourceVideoUrl || params.sourceVideoUrl;
  const vidId = extractYouTubeVideoId(resolvedSourceUrl);

  const aiActId = startActionLog({
    category: 'ai_detect',
    actionName: 'AI Detect & Auto-Fill',
    sourceRef: vidId ? `${parsedInputs.length} clips (${vidId})` : `${parsedInputs.length} clips`,
    summary: `Parsing ${parsedInputs.length} clip(s) and generating scene-matched titles & #BD tags...`,
  });

  try {
    const out = await generateManualClipMetadataBatch({
      clips: parsedInputs,
      languagePreference: params.languagePreference,
      nicheHint: params.nicheHint,
      sourceVideoUrl: resolvedSourceUrl,
    });
    updateActionLog(aiActId, {
      status: 'success',
      summary: `Generated ${out.length} clip(s) with distinct timelines & unique titles.`,
      details: out
        .map((c) => `Clip #${c.clipNumber} [${c.startTime}–${c.endTime}]: ${c.title}`)
        .join('\n'),
    });
    return out;
  } catch (err) {
    updateActionLog(aiActId, {
      status: 'error',
      summary: 'AI Detect & Auto-Fill failed.',
      details: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

