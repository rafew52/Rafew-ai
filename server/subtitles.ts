import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { ThinkingLevel, Type } from '@google/genai';
import type { CaptionCue, ContentLanguageChoice } from '../src/types.ts';
import {
  acquireGeminiKey,
  computeCooldownMs,
  createGeminiClientForKey,
  formatSafeGeminiError,
  hasUsableGeminiKey,
  isInvalidKeyError,
  isModelNotFoundError,
  isOverloadError,
  isRateLimitError,
  markKeyInvalid,
  markKeyRateLimited,
  markKeySuccess,
  releaseGeminiKey,
} from './geminiKeys.ts';
import { getActiveCandidateModels, quarantineModel } from './geminiModels.ts';
import { stripDummyPhrasesFromText, stripUrlsFromText } from './requirementEngine.ts';

const execFileAsync = promisify(execFile);

const NOTO_FONTS_DIR = '/usr/share/fonts/truetype/noto';
const NOTO_BENGALI_BOLD = path.join(NOTO_FONTS_DIR, 'NotoSansBengali-Bold.ttf');
const NOTO_BENGALI_REG = path.join(NOTO_FONTS_DIR, 'NotoSansBengali-Regular.ttf');

let cachedBengaliFontSupport: boolean | null = null;

export function hasBengaliFontInstalled(): boolean {
  if (cachedBengaliFontSupport !== null) return cachedBengaliFontSupport;
  cachedBengaliFontSupport =
    fs.existsSync(NOTO_BENGALI_BOLD) || fs.existsSync(NOTO_BENGALI_REG);
  return cachedBengaliFontSupport;
}

export function containsBengaliScript(text?: string): boolean {
  return Boolean(text && /[\u0980-\u09FF]/.test(text));
}

export function sanitizeSubtitleLine(raw: string): string {
  const cleaned = stripDummyPhrasesFromText(stripUrlsFromText(String(raw || '')))
    .replace(/[▯□\uFFFD]/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned;
}

function splitTextIntoSubtitleChunks(text: string, maxWordsPerCue = 6): string[] {
  const clean = sanitizeSubtitleLine(text);
  if (!clean) return [];

  const clauses = clean
    .split(/(?<=[।!?.,;—–\-])\s+/)
    .map((c) => c.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  for (const clause of clauses) {
    const words = clause.split(/\s+/).filter(Boolean);
    if (words.length <= maxWordsPerCue) {
      chunks.push(words.join(' '));
      continue;
    }
    for (let i = 0; i < words.length; i += maxWordsPerCue) {
      const slice = words.slice(i, i + maxWordsPerCue).join(' ').trim();
      if (slice) chunks.push(slice);
    }
  }

  return chunks.filter((c) => c.length >= 2);
}

/**
 * Ensures captions cover 100% of [0 .. durationSeconds] without cutting out early,
 * removing empty/broken glyph text and closing gaps cleanly.
 */
export function normalizeFullDurationCaptions(params: {
  rawCues?: CaptionCue[];
  durationSeconds: number;
  fallbackText?: string;
}): CaptionCue[] {
  const duration = Math.max(1, Number(params.durationSeconds) || 10);
  const bengaliAvailable = hasBengaliFontInstalled();

  const sanitizedInput: CaptionCue[] = (params.rawCues || [])
    .map((c) => ({
      startOffsetSeconds: Math.max(0, Number(c.startOffsetSeconds) || 0),
      endOffsetSeconds: Math.max(0, Number(c.endOffsetSeconds) || 0),
      text: sanitizeSubtitleLine(c.text),
    }))
    .filter((c) => {
      if (!c.text) return false;
      if (!bengaliAvailable && containsBengaliScript(c.text)) {
        // Avoid ever rendering ▯▯▯▯ tofu boxes if host lacks a Bengali font
        return false;
      }
      return true;
    })
    .sort((a, b) => a.startOffsetSeconds - b.startOffsetSeconds);

  const fallbackChunks = splitTextIntoSubtitleChunks(params.fallbackText || '', 6).filter(
    (chunk) => bengaliAvailable || !containsBengaliScript(chunk)
  );

  // If no valid timed cues or cues only cover a tiny portion (< 45%) with sparse lines,
  // distribute cues/chunks cleanly across the ENTIRE [0 .. duration] timeline.
  const maxExistingEnd =
    sanitizedInput.length > 0
      ? Math.max(...sanitizedInput.map((c) => Math.min(duration, c.endOffsetSeconds)))
      : 0;

  if (sanitizedInput.length === 0) {
    const chunks = fallbackChunks.length > 0 ? fallbackChunks : ['Watch till the end!'];
    const segDur = duration / chunks.length;
    return chunks.map((text, idx) => ({
      startOffsetSeconds: Number((idx * segDur).toFixed(2)),
      endOffsetSeconds: Number(
        (idx === chunks.length - 1 ? duration : (idx + 1) * segDur).toFixed(2)
      ),
      text,
    }));
  }

  // Merge/normalize valid cues first
  const normalized: CaptionCue[] = [];
  for (const cue of sanitizedInput) {
    const start = Math.min(duration - 0.35, Math.max(0, cue.startOffsetSeconds));
    const end = Math.min(duration, Math.max(start + 0.5, cue.endOffsetSeconds));
    normalized.push({
      startOffsetSeconds: Number(start.toFixed(2)),
      endOffsetSeconds: Number(end.toFixed(2)),
      text: cue.text,
    });
  }

  // Snap first cue near 0 so viewer immediately sees captions
  if (normalized[0].startOffsetSeconds > 0.35) {
    normalized[0].startOffsetSeconds = 0;
  }

  // Close gaps > 0.35s between consecutive cues so captions never disappear mid-clip
  for (let i = 0; i < normalized.length - 1; i += 1) {
    const curr = normalized[i];
    const next = normalized[i + 1];
    if (next.startOffsetSeconds <= curr.startOffsetSeconds) {
      next.startOffsetSeconds = Number(
        Math.min(duration - 0.3, curr.startOffsetSeconds + 0.6).toFixed(2)
      );
    }
    if (curr.endOffsetSeconds > next.startOffsetSeconds) {
      curr.endOffsetSeconds = next.startOffsetSeconds;
    } else if (next.startOffsetSeconds - curr.endOffsetSeconds > 0.35) {
      curr.endOffsetSeconds = next.startOffsetSeconds;
    }
  }

  // If cues ended significantly early (< 65% of clip duration) and we have extra fallback chunks
  // or multiple cues to pace evenly, redistribute or append continuation cues to fill up to end!
  const last = normalized[normalized.length - 1];
  if (maxExistingEnd < duration * 0.65) {
    if (fallbackChunks.length > normalized.length) {
      // Combine existing opening text with remaining fallback chunks evenly across [0 .. duration]
      const combinedTexts: string[] = [];
      const seen = new Set<string>();
      for (const c of normalized) {
        const k = c.text.toLowerCase();
        if (!seen.has(k)) {
          seen.add(k);
          combinedTexts.push(c.text);
        }
      }
      for (const chunk of fallbackChunks) {
        const k = chunk.toLowerCase();
        if (!seen.has(k)) {
          seen.add(k);
          combinedTexts.push(chunk);
        }
      }
      const segDur = duration / combinedTexts.length;
      return combinedTexts.map((text, idx) => ({
        startOffsetSeconds: Number((idx * segDur).toFixed(2)),
        endOffsetSeconds: Number(
          (idx === combinedTexts.length - 1 ? duration : (idx + 1) * segDur).toFixed(2)
        ),
        text,
      }));
    }

    // Evenly space existing cues across the full clip duration so each stays crisp until the end
    const segDur = duration / normalized.length;
    return normalized.map((c, idx) => ({
      startOffsetSeconds: Number((idx * segDur).toFixed(2)),
      endOffsetSeconds: Number(
        (idx === normalized.length - 1 ? duration : (idx + 1) * segDur).toFixed(2)
      ),
      text: c.text,
    }));
  }

  // Otherwise extend final cue (or bridge remaining tail with unused fallback beats) right up to `duration`
  const tailGap = duration - last.endOffsetSeconds;
  if (tailGap > 4.0 && fallbackChunks.length > 0) {
    const unused = fallbackChunks.filter(
      (fc) => !normalized.some((n) => n.text.toLowerCase() === fc.toLowerCase())
    );
    const tailPieces = unused.length > 0 ? unused.slice(0, 3) : [last.text];
    const startTail = last.endOffsetSeconds;
    const tailStep = (duration - startTail) / tailPieces.length;
    for (let i = 0; i < tailPieces.length; i += 1) {
      normalized.push({
        startOffsetSeconds: Number((startTail + i * tailStep).toFixed(2)),
        endOffsetSeconds: Number(
          (i === tailPieces.length - 1 ? duration : startTail + (i + 1) * tailStep).toFixed(2)
        ),
        text: tailPieces[i],
      });
    }
  } else {
    last.endOffsetSeconds = Number(duration.toFixed(2));
  }

  return normalized;
}

export async function generateFullDurationCaptionsForSegment(params: {
  videoPath: string;
  durationSeconds: number;
  notes?: string;
  title?: string;
  description?: string;
  languageChoice?: ContentLanguageChoice | string;
}): Promise<CaptionCue[]> {
  const duration = Math.max(1, Number(params.durationSeconds) || 10);
  const fallbackNarrative = [
    sanitizeSubtitleLine(params.notes || ''),
    sanitizeSubtitleLine(params.title || ''),
  ]
    .filter(Boolean)
    .join(' — ');

  if (!hasUsableGeminiKey() || !fs.existsSync(params.videoPath)) {
    return normalizeFullDurationCaptions({
      durationSeconds: duration,
      fallbackText: fallbackNarrative,
    });
  }

  const tmpAudio = `${params.videoPath}.cap_audio_${Date.now()}.mp3`;
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-i',
        params.videoPath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '48k',
        tmpAudio,
      ],
      { timeout: 15_000 }
    );
  } catch {
    if (fs.existsSync(tmpAudio)) {
      try {
        fs.unlinkSync(tmpAudio);
      } catch {}
    }
  }

  if (!fs.existsSync(tmpAudio) || fs.statSync(tmpAudio).size < 1024) {
    if (fs.existsSync(tmpAudio)) {
      try {
        fs.unlinkSync(tmpAudio);
      } catch {}
    }
    return normalizeFullDurationCaptions({
      durationSeconds: duration,
      fallbackText: fallbackNarrative,
    });
  }

  try {
    const audioBytes = fs.readFileSync(tmpAudio);
    if (audioBytes.byteLength > 12 * 1024 * 1024) {
      return normalizeFullDurationCaptions({
        durationSeconds: duration,
        fallbackText: fallbackNarrative,
      });
    }

    const langRule =
      params.languageChoice === 'bengali'
        ? 'Write captions in natural Bangladeshi Bangla (বাংলা Unicode script) matching spoken commentary/scene.'
        : params.languageChoice === 'english'
        ? 'Write punchy natural English captions.'
        : 'Write energetic Bangladeshi Banglish (Bangla words in English letters + English gaming terms) or Bengali Unicode (বাংলা) matching the audio and notes.';

    const prompt = [
      `Listen carefully to this ${duration.toFixed(1)}-second video clip audio.`,
      params.title ? `Clip Title: "${params.title}"` : '',
      params.notes ? `Scene Context: "${params.notes}"` : '',
      langRule,
      `Generate continuous, engaging 2 to 6 word subtitle cues covering the FULL clip from 0.0s right up to ${duration.toFixed(1)}s (the final cue MUST end at ${duration.toFixed(1)}s — never cut out early).`,
      'Return strictly valid JSON matching the schema.',
    ]
      .filter(Boolean)
      .join('\n');

    const models = getActiveCandidateModels();
    const preferred = Array.from(
      new Set(['gemini-4-hydrogen', ...models.filter((m) => /flash|hydrogen|lite/i.test(m)), ...models])
    );

    for (const model of preferred.slice(0, 3)) {
      const acquired = acquireGeminiKey();
      if (!acquired) break;
      try {
        const ai = createGeminiClientForKey(acquired.apiKey);
        const res = await ai.models.generateContent({
          model,
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType: 'audio/mp3',
                  data: audioBytes.toString('base64'),
                },
              },
              { text: prompt },
            ],
          },
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            abortSignal: AbortSignal.timeout(18_000),
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                captions: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      start_offset_seconds: { type: Type.NUMBER },
                      end_offset_seconds: { type: Type.NUMBER },
                      text: { type: Type.STRING },
                    },
                    required: ['start_offset_seconds', 'end_offset_seconds', 'text'],
                  },
                },
              },
              required: ['captions'],
            },
          },
        });
        markKeySuccess(acquired.id);
        const parsed = JSON.parse((res.text ?? '{}').trim()) as {
          captions?: Array<{
            start_offset_seconds?: number;
            end_offset_seconds?: number;
            text?: string;
          }>;
        };
        if (Array.isArray(parsed.captions) && parsed.captions.length > 0) {
          const cues: CaptionCue[] = parsed.captions.map((c) => ({
            startOffsetSeconds: Number(c.start_offset_seconds) || 0,
            endOffsetSeconds: Number(c.end_offset_seconds) || 0,
            text: String(c.text || ''),
          }));
          return normalizeFullDurationCaptions({
            rawCues: cues,
            durationSeconds: duration,
            fallbackText: fallbackNarrative,
          });
        }
      } catch (err) {
        if (isInvalidKeyError(err)) {
          markKeyInvalid(acquired.id, formatSafeGeminiError(err));
        } else if (isModelNotFoundError(err)) {
          quarantineModel(model, formatSafeGeminiError(err));
        } else if (isRateLimitError(err) || isOverloadError(err)) {
          markKeyRateLimited(acquired.id, formatSafeGeminiError(err), computeCooldownMs(err));
        }
      } finally {
        releaseGeminiKey(acquired.id);
      }
    }
  } finally {
    if (fs.existsSync(tmpAudio)) {
      try {
        fs.unlinkSync(tmpAudio);
      } catch {}
    }
  }

  return normalizeFullDurationCaptions({
    durationSeconds: duration,
    fallbackText: fallbackNarrative,
  });
}

function formatSrtTs(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000) % 1000;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(
    2,
    '0'
  )},${String(ms).padStart(3, '0')}`;
}

function formatAssTs(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const cs = Math.floor((safe - Math.floor(safe)) * 100);
  return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(
    cs
  ).padStart(2, '0')}`;
}

export function escapeAssFilterPath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

export function buildAssFilterExpression(assPath: string): string {
  const escapedAss = escapeAssFilterPath(assPath);
  if (fs.existsSync(NOTO_FONTS_DIR)) {
    return `ass='${escapedAss}':fontsdir='${escapeAssFilterPath(NOTO_FONTS_DIR)}'`;
  }
  return `ass='${escapedAss}'`;
}

export interface AssValidationResult {
  valid: boolean;
  reason?: string;
  dialogueCount: number;
  hasBengali: boolean;
  bengaliFontReady: boolean;
}

/**
 * Validates that a generated .ass subtitle file is non-empty, valid UTF-8,
 * free of tofu box glyphs, has valid [Script Info]/[V4+ Styles]/[Events] sections
 * and Dialogue entries, and confirms Bengali font availability if Bangla glyphs exist.
 */
export function validateAssSubtitleFile(assPath: string): AssValidationResult {
  if (!assPath || !fs.existsSync(assPath)) {
    return {
      valid: false,
      reason: 'Subtitle .ass file does not exist.',
      dialogueCount: 0,
      hasBengali: false,
      bengaliFontReady: hasBengaliFontInstalled(),
    };
  }

  let content = '';
  try {
    const buf = fs.readFileSync(assPath);
    if (buf.length < 40) {
      return {
        valid: false,
        reason: 'Subtitle .ass file is unexpectedly small/empty.',
        dialogueCount: 0,
        hasBengali: false,
        bengaliFontReady: hasBengaliFontInstalled(),
      };
    }
    content = buf.toString('utf-8');
  } catch (err) {
    return {
      valid: false,
      reason: `Failed to read .ass file as UTF-8: ${err instanceof Error ? err.message : String(err)}`,
      dialogueCount: 0,
      hasBengali: false,
      bengaliFontReady: hasBengaliFontInstalled(),
    };
  }

  if (/[▯□\uFFFD]/.test(content)) {
    return {
      valid: false,
      reason: 'Subtitle .ass file contains invalid UTF-8 replacement or tofu box characters.',
      dialogueCount: 0,
      hasBengali: containsBengaliScript(content),
      bengaliFontReady: hasBengaliFontInstalled(),
    };
  }

  const hasScriptInfo = content.includes('[Script Info]');
  const hasStyles = content.includes('[V4+ Styles]') && content.includes('Style:');
  const hasEvents = content.includes('[Events]');
  if (!hasScriptInfo || !hasStyles || !hasEvents) {
    return {
      valid: false,
      reason: 'Subtitle .ass file is missing required [Script Info], [V4+ Styles], or [Events] sections.',
      dialogueCount: 0,
      hasBengali: containsBengaliScript(content),
      bengaliFontReady: hasBengaliFontInstalled(),
    };
  }

  const dialogueLines = content
    .split(/\r?\n/)
    .filter((l) => /^Dialogue:\s*\d+,[^,]+,[^,]+,/i.test(l.trim()));

  if (dialogueLines.length === 0) {
    return {
      valid: false,
      reason: 'Subtitle .ass file contains zero valid Dialogue lines.',
      dialogueCount: 0,
      hasBengali: containsBengaliScript(content),
      bengaliFontReady: hasBengaliFontInstalled(),
    };
  }

  const hasBengali = dialogueLines.some((l) => containsBengaliScript(l));
  const bengaliFontReady = hasBengaliFontInstalled();
  if (hasBengali && !bengaliFontReady) {
    return {
      valid: false,
      reason: 'Bangla Unicode text detected in subtitles but Bengali font (Noto Sans Bengali) is missing on host.',
      dialogueCount: dialogueLines.length,
      hasBengali: true,
      bengaliFontReady: false,
    };
  }

  return {
    valid: true,
    dialogueCount: dialogueLines.length,
    hasBengali,
    bengaliFontReady,
  };
}

/**
 * Extracts exact trailing FFmpeg stderr lines so failures reveal the true root cause
 * (filter errors, codec issues, fontconfig errors, timeout/memory signals) instead of truncated prefixes.
 */
export function extractFfmpegStderrTail(err: unknown, maxLines = 22): string {
  const anyErr = err as { stderr?: string | Buffer; stdout?: string | Buffer; signal?: string; killed?: boolean; message?: string };
  const rawStderr =
    typeof anyErr?.stderr === 'string'
      ? anyErr.stderr
      : Buffer.isBuffer(anyErr?.stderr)
      ? anyErr.stderr.toString('utf-8')
      : '';

  const lines = rawStderr
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    // Filter pure ffmpeg build banner noise when real error lines follow
    .filter(
      (l) =>
        !/^(ffmpeg version|built with|configuration:|lib(?:av\w+|sw\w+|postproc)\s+\d)/i.test(l.trim())
    );

  const signalNote = anyErr?.killed || anyErr?.signal ? `[killed=${Boolean(anyErr.killed)}, signal=${anyErr.signal || 'none'}] ` : '';

  if (lines.length > 0) {
    return `${signalNote}${lines.slice(-maxLines).join('\n')}`.slice(-2400);
  }

  const msg = err instanceof Error ? err.message : String(err || 'Unknown FFmpeg error');
  return `${signalNote}${msg}`.slice(-1800);
}

export function writeUtf8AssAndSrtSubtitles(params: {
  captions: CaptionCue[];
  durationSeconds: number;
  fallbackText?: string;
  srtPath?: string;
  assPath: string;
  playResX?: number;
  playResY?: number;
  splitScreenActive?: boolean;
}): boolean {
  const playResX = params.playResX ?? 1080;
  const playResY = params.playResY ?? 1920;

  const normalizedCues = normalizeFullDurationCaptions({
    rawCues: params.captions,
    durationSeconds: params.durationSeconds,
    fallbackText: params.fallbackText,
  });

  if (normalizedCues.length === 0) {
    return false;
  }

  if (params.srtPath) {
    const srtContent = normalizedCues
      .map(
        (cue, idx) =>
          `${idx + 1}\n${formatSrtTs(cue.startOffsetSeconds)} --> ${formatSrtTs(
            cue.endOffsetSeconds
          )}\n${cue.text}\n`
      )
      .join('\n');
    fs.writeFileSync(params.srtPath, srtContent, 'utf-8');
  }

  const isLandscape = playResX > playResY;
  const fontSize = isLandscape ? 52 : 58;
  // In 9:16 split-screen (1080x960 uncropped gameplay top + 1080x960 facecam bottom),
  // place subtitles at MarginV=975 so they sit cleanly along the center divider pad (y≈945) without covering gameplay or facecam.
  const marginV = isLandscape ? 85 : params.splitScreenActive ? 975 : 250;

  // Noto Sans Bengali handles full Bengali Unicode (0980-09FF) via HarfBuzz
  // and libass fontconfig automatically falls back to Noto Sans Bold for Banglish/Latin/digits.
  const fontName = hasBengaliFontInstalled() ? 'Noto Sans Bengali' : 'DejaVu Sans';

  const assHeader = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${playResX}`,
    `PlayResY: ${playResY}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: ShortsCaption,${fontName},${fontSize},&H00FFFFFF,&H0000A5FF,&H00000000,&HB0000000,-1,0,0,0,100,100,0,0,1,4,2,2,64,64,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

  const assEvents = normalizedCues
    .map((cue) => {
      const escapedText = cue.text
        .replace(/\\/g, '')
        .replace(/\{/g, '(')
        .replace(/\}/g, ')');
      return `Dialogue: 0,${formatAssTs(cue.startOffsetSeconds)},${formatAssTs(
        cue.endOffsetSeconds
      )},ShortsCaption,,0,0,0,,${escapedText}`;
    })
    .join('\n');

  fs.writeFileSync(params.assPath, `${assHeader}\n${assEvents}\n`, 'utf-8');
  return validateAssSubtitleFile(params.assPath).valid;
}
