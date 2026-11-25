import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { ThinkingLevel, Type } from '@google/genai';
import type {
  ClipSensorIssue,
  ClipSensorResult,
  ClipVisualInspection,
  ContentLanguageChoice,
  SensorStatusLevel,
} from '../src/types.ts';
import {
  acquireGeminiKey,
  computeCooldownMs,
  createGeminiClientForKey,
  formatSafeGeminiError,
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
import {
  areTitlesSimilar,
  sanitizeHashtags,
  sanitizeTitleText,
  stripDummyPhrasesFromText,
  stripUrlsFromText,
} from './requirementEngine.ts';

const execFileAsync = promisify(execFile);

const FLASH_PREFERRED_MODELS = [
  'gemini-4-hydrogen',
  'gemini-3.8-flash',
  'gemini-3.1-flash-lite',
];

function getSensorFlashModels(): string[] {
  const registry = getActiveCandidateModels();
  const flashFirst = registry.filter((m) => /flash|hydrogen|lite/i.test(m));
  return Array.from(new Set([...FLASH_PREFERRED_MODELS, ...flashFirst, ...registry]));
}

function parseTimestampSec(raw?: string): number {
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

const BANNED_METADATA_REGEX =
  /\b(?:gta\s*6?\s*clutch\s*(?:action\s*)?moment|clutch\s+(?:action\s+)?moment|hashtag\s+(?:zero|one|two|three)|gaming\s+highlights\s*-\s*#?bd)\b/i;
const NUMBERED_DUMMY_TAG_REGEX = /(?:^|\s)#(?:0|1|2|3|4|5|zero|one|two|three)\b/i;
const NUMBERED_CLIP_LABEL_REGEX = /^(?:clip|part|খণ্ড|পর্ব)\s*#?\s*\d+$/i;
const BROKEN_GLYPH_REGEX = /[▯□\uFFFD]/;

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  tags?: Record<string, string>;
}

interface FfprobeOutput {
  format?: {
    duration?: string;
    size?: string;
    tags?: Record<string, string>;
  };
  streams?: FfprobeStream[];
}

function analyzeRawRgbForTestPatterns(
  rgbBuffer: Buffer,
  width: number,
  height: number
): {
  isSolidBlank: boolean;
  isColorBars: boolean;
  isCheckerboard: boolean;
  reason?: string;
} {
  const totalPixels = width * height;
  if (rgbBuffer.length < totalPixels * 3) {
    return { isSolidBlank: false, isColorBars: false, isCheckerboard: false };
  }

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumSq = 0;
  let purePrimaryCount = 0;
  let grayNeutralCount = 0;

  for (let i = 0; i < totalPixels; i += 1) {
    const idx = i * 3;
    const r = rgbBuffer[idx];
    const g = rgbBuffer[idx + 1];
    const b = rgbBuffer[idx + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    sumR += r;
    sumG += g;
    sumB += b;
    sumSq += lum * lum;

    const rExtreme = r < 25 || r > 225;
    const gExtreme = g < 25 || g > 225;
    const bExtreme = b < 25 || b > 225;
    if (rExtreme && gExtreme && bExtreme) {
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      if (maxC - minC > 160) {
        purePrimaryCount += 1;
      } else {
        grayNeutralCount += 1;
      }
    }
  }

  const meanLum = (0.299 * sumR + 0.587 * sumG + 0.114 * sumB) / totalPixels;
  const varianceLum = Math.max(0, sumSq / totalPixels - meanLum * meanLum);
  const stdDevLum = Math.sqrt(varianceLum);

  // 1. Solid blank/black/single-color frame
  if (stdDevLum < 3.5) {
    return {
      isSolidBlank: true,
      isColorBars: false,
      isCheckerboard: false,
      reason: `Solid blank/flat frame detected (luminance stdDev=${stdDevLum.toFixed(1)}, mean=${meanLum.toFixed(1)}).`,
    };
  }

  // 2. Vertical SMPTE / testsrc / testsrc2 color bars:
  // Columns in upper half have tiny vertical pixel-to-pixel change (vertFlatRatio > 0.82)
  // while distinct horizontal color stripe boundaries jump cleanly and saturated bands dominate
  const topRows = Math.floor(height * 0.55);
  let vertFlatCount = 0;
  let vertPairs = 0;
  let horizJumpCount = 0;
  let satTopCount = 0;
  for (let y = 2; y < topRows - 1; y += 1) {
    for (let x = 2; x < width - 2; x += 1) {
      const i1 = (y * width + x) * 3;
      const iDown = ((y + 1) * width + x) * 3;
      const iRight = (y * width + x + 1) * 3;
      const dv =
        (Math.abs(rgbBuffer[i1] - rgbBuffer[iDown]) +
          Math.abs(rgbBuffer[i1 + 1] - rgbBuffer[iDown + 1]) +
          Math.abs(rgbBuffer[i1 + 2] - rgbBuffer[iDown + 2])) /
        3;
      const dh =
        (Math.abs(rgbBuffer[i1] - rgbBuffer[iRight]) +
          Math.abs(rgbBuffer[i1 + 1] - rgbBuffer[iRight + 1]) +
          Math.abs(rgbBuffer[i1 + 2] - rgbBuffer[iRight + 2])) /
        3;
      if (dv < 2.2) vertFlatCount += 1;
      if (dh > 18) horizJumpCount += 1;
      const maxC = Math.max(rgbBuffer[i1], rgbBuffer[i1 + 1], rgbBuffer[i1 + 2]);
      const minC = Math.min(rgbBuffer[i1], rgbBuffer[i1 + 1], rgbBuffer[i1 + 2]);
      if (maxC - minC > 95) satTopCount += 1;
      vertPairs += 1;
    }
  }
  const vertFlatRatio = vertPairs > 0 ? vertFlatCount / vertPairs : 0;
  const horizJumpRatio = vertPairs > 0 ? horizJumpCount / vertPairs : 0;
  const satTopRatio = vertPairs > 0 ? satTopCount / vertPairs : 0;

  if (vertFlatRatio > 0.82 && horizJumpRatio > 0.08 && satTopRatio > 0.45 && stdDevLum > 15) {
    return {
      isSolidBlank: false,
      isColorBars: true,
      isCheckerboard: false,
      reason: `SMPTE/testsrc color bars signature detected (vertical flatness=${Math.round(vertFlatRatio * 100)}%, saturated stripes=${Math.round(satTopRatio * 100)}%).`,
    };
  }

  // 3. Checkerboard pattern: high alternating contrast across neighbors with very few unique quantized colors
  const uniqueColors = new Set<number>();
  let highFreqAlternations = 0;
  let totalSteps = 0;
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const idx = (y * width + x) * 3;
      const q = ((rgbBuffer[idx] >> 5) << 6) | ((rgbBuffer[idx + 1] >> 5) << 3) | (rgbBuffer[idx + 2] >> 5);
      uniqueColors.add(q);
      const right = (y * width + x + 1) * 3;
      const diffH =
        Math.abs(rgbBuffer[idx] - rgbBuffer[right]) +
        Math.abs(rgbBuffer[idx + 1] - rgbBuffer[right + 1]) +
        Math.abs(rgbBuffer[idx + 2] - rgbBuffer[right + 2]);
      if (diffH > 180) highFreqAlternations += 1;
      totalSteps += 1;
    }
  }
  const altRatio = totalSteps > 0 ? highFreqAlternations / totalSteps : 0;
  if (uniqueColors.size <= 6 && altRatio > 0.25 && grayNeutralCount + purePrimaryCount > totalPixels * 0.7) {
    return {
      isSolidBlank: false,
      isColorBars: false,
      isCheckerboard: true,
      reason: `Synthetic checkerboard/grid test pattern detected (${uniqueColors.size} quantized colors, ${Math.round(altRatio * 100)}% alternating transitions).`,
    };
  }

  return { isSolidBlank: false, isColorBars: false, isCheckerboard: false };
}

async function runGeminiFlashVisionInspection(
  contactSheetJpeg: Buffer
): Promise<{
  aiAudited: boolean;
  modelUsed?: string;
  isTestPatternOrColorBars: boolean;
  isBlackOrBlankScreen: boolean;
  hasBrokenGlyphBoxes: boolean;
  hasDummyOverlayText: boolean;
  visualSummary: string;
  rejectionReason?: string;
} | null> {
  const models = getSensorFlashModels();
  const base64Image = contactSheetJpeg.toString('base64');

  const prompt = `You are a strict Visual Quality Sensor for Clips ai before publishing video clips to TikTok/YouTube Shorts.
Inspect this 2x2 grid of 4 frames sampled across the rendered video clip.

Check carefully for ANY of the following defects:
1. "isTestPatternOrColorBars": SMPTE color bars, FFmpeg testsrc/testsrc2 rainbow test charts, synthetic color stripes, checkerboards, or static test cards.
2. "isBlackOrBlankScreen": Solid black, empty white/solid color frames, or blank screens across 3+ panels.
3. "hasBrokenGlyphBoxes": Visible missing-font tofu/box glyph characters such as ▯▯▯▯ or □□□□ anywhere in burned-in titles/subtitles.
4. "hasDummyOverlayText": Fake placeholder overlays such as "Clips ai Highlight - #BD" or "Gaming Highlights" stamped onto a test chart or blank background.

Return JSON strictly matching the schema.`;

  for (const model of models.slice(0, 3)) {
    const acquired = acquireGeminiKey();
    if (!acquired) break;
    try {
      const ai = createGeminiClientForKey(acquired.apiKey);
      const response = await ai.models.generateContent({
        model,
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: 'image/jpeg',
                data: base64Image,
              },
            },
            { text: prompt },
          ],
        },
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              isTestPatternOrColorBars: { type: Type.BOOLEAN },
              isBlackOrBlankScreen: { type: Type.BOOLEAN },
              hasBrokenGlyphBoxes: { type: Type.BOOLEAN },
              hasDummyOverlayText: { type: Type.BOOLEAN },
              visualSummary: { type: Type.STRING },
              rejectionReason: { type: Type.STRING },
            },
            required: [
              'isTestPatternOrColorBars',
              'isBlackOrBlankScreen',
              'hasBrokenGlyphBoxes',
              'hasDummyOverlayText',
              'visualSummary',
            ],
          },
        },
      });
      markKeySuccess(acquired.id);
      const parsed = JSON.parse((response.text ?? '{}').trim()) as {
        isTestPatternOrColorBars?: boolean;
        isBlackOrBlankScreen?: boolean;
        hasBrokenGlyphBoxes?: boolean;
        hasDummyOverlayText?: boolean;
        visualSummary?: string;
        rejectionReason?: string;
      };
      return {
        aiAudited: true,
        modelUsed: model,
        isTestPatternOrColorBars: Boolean(parsed.isTestPatternOrColorBars),
        isBlackOrBlankScreen: Boolean(parsed.isBlackOrBlankScreen),
        hasBrokenGlyphBoxes: Boolean(parsed.hasBrokenGlyphBoxes),
        hasDummyOverlayText: Boolean(parsed.hasDummyOverlayText),
        visualSummary: String(parsed.visualSummary || '').slice(0, 180),
        rejectionReason: parsed.rejectionReason ? String(parsed.rejectionReason).slice(0, 220) : undefined,
      };
    } catch (err) {
      if (isInvalidKeyError(err)) {
        markKeyInvalid(acquired.id, formatSafeGeminiError(err));
      } else if (isRateLimitError(err) || isOverloadError(err)) {
        markKeyRateLimited(acquired.id, formatSafeGeminiError(err), computeCooldownMs(err));
      } else if (isModelNotFoundError(err)) {
        quarantineModel(model, formatSafeGeminiError(err));
      }
    } finally {
      releaseGeminiKey(acquired.id);
    }
  }
  return null;
}

export async function inspectRenderedClipVideo(
  filePath: string,
  options?: { enableVisionAudit?: boolean }
): Promise<ClipVisualInspection & { aiVisionUsed?: boolean; modelUsed?: string }> {
  const issues: string[] = [];

  if (!filePath || !fs.existsSync(filePath)) {
    return {
      passed: false,
      hasVideoStream: false,
      hasAudioStream: false,
      issues: ['Video file does not exist on disk.'],
    };
  }

  const stat = fs.statSync(filePath);
  if (stat.size < 4096) {
    return {
      passed: false,
      hasVideoStream: false,
      hasAudioStream: false,
      fileSizeBytes: stat.size,
      issues: [`Video file is too small or corrupted (${stat.size} bytes).`],
    };
  }

  let probe: FfprobeOutput = {};
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { timeout: 12_000 }
    );
    probe = JSON.parse(stdout) as FfprobeOutput;
  } catch (err) {
    return {
      passed: false,
      hasVideoStream: false,
      hasAudioStream: false,
      fileSizeBytes: stat.size,
      issues: [
        `FFprobe failed to read media container: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  const hasVideoStream = Boolean(videoStream && (videoStream.width || 0) > 0 && (videoStream.height || 0) > 0);
  const hasAudioStream = Boolean(audioStream);

  const durationSeconds = Number(probe.format?.duration || videoStream?.duration || 0) || 0;
  const width = videoStream?.width;
  const height = videoStream?.height;

  if (!hasVideoStream) {
    issues.push('No valid video stream found in file.');
  }
  if (durationSeconds > 0 && durationSeconds < 0.8) {
    issues.push(`Video duration is too short (${durationSeconds.toFixed(2)}s).`);
  }
  if (!hasAudioStream) {
    issues.push('No audio stream detected in rendered video.');
  }

  // Check metadata tags for lavfi / testsrc / smpte generator fingerprints
  const allTags = JSON.stringify({
    format: probe.format?.tags || {},
    video: videoStream?.tags || {},
  }).toLowerCase();
  if (/\b(?:testsrc|testsrc2|smptebars|rgbtestsrc|pal75bars|haldclutsrc|mandelbrot)\b/.test(allTags)) {
    issues.push('Container metadata indicates a synthetic FFmpeg test pattern.');
  }

  let blackFrameRatio = 0;
  let hasFrozenFrames = false;
  let isTestPatternSuspected = false;

  if (hasVideoStream) {
    const inspectDuration = Math.min(35, Math.max(3, durationSeconds || 15));
    try {
      const { stderr } = await execFileAsync(
        'ffmpeg',
        [
          '-v',
          'info',
          '-t',
          String(inspectDuration),
          '-i',
          filePath,
          '-vf',
          'blackdetect=d=1.0:pix_th=0.10,freezedetect=n=0.002:d=3.0',
          '-f',
          'null',
          '-',
        ],
        { timeout: 18_000, maxBuffer: 1024 * 1024 }
      );

      let totalBlack = 0;
      const blackMatches = stderr.matchAll(/black_duration:\s*([0-9.]+)/g);
      for (const m of blackMatches) {
        totalBlack += parseFloat(m[1]) || 0;
      }
      blackFrameRatio = Math.min(1, totalBlack / inspectDuration);
      if (blackFrameRatio >= 0.65) {
        issues.push(
          `Black/blank frames detected across ${Math.round(blackFrameRatio * 100)}% of video duration.`
        );
      }

      let totalFreeze = 0;
      const freezeMatches = stderr.matchAll(/lavfi\.freezedetect\.freeze_duration:\s*([0-9.]+)/g);
      for (const m of freezeMatches) {
        totalFreeze += parseFloat(m[1]) || 0;
      }
      if (totalFreeze / inspectDuration >= 0.9) {
        hasFrozenFrames = true;
        issues.push('Video frames appear completely frozen/static across the clip.');
      }
    } catch {
      // Non-fatal if single-pass filter times out; pixel & vision sensors follow
    }

    // Pixel pattern check at 20% and 65% of clip
    const seekPoints = [
      Math.max(0.2, (durationSeconds || 10) * 0.2),
      Math.max(0.5, (durationSeconds || 10) * 0.65),
    ];
    const sampleW = 64;
    const sampleH = 112;
    let patternHits = 0;
    let lastPatternReason = '';

    for (const seekS of seekPoints) {
      try {
        const { stdout: rgbBuf } = await execFileAsync(
          'ffmpeg',
          [
            '-ss',
            seekS.toFixed(2),
            '-i',
            filePath,
            '-vframes',
            '1',
            '-vf',
            `scale=${sampleW}:${sampleH}:flags=bilinear,format=rgb24`,
            '-f',
            'rawvideo',
            '-pix_fmt',
            'rgb24',
            'pipe:1',
          ],
          { encoding: 'buffer', timeout: 8000, maxBuffer: 256 * 1024 }
        );

        if (Buffer.isBuffer(rgbBuf)) {
          const check = analyzeRawRgbForTestPatterns(rgbBuf, sampleW, sampleH);
          if (check.isSolidBlank || check.isColorBars || check.isCheckerboard) {
            patternHits += 1;
            if (check.reason) lastPatternReason = check.reason;
          }
        }
      } catch {
        // Ignore single frame seek error
      }
    }

    if (patternHits >= 1 && lastPatternReason) {
      isTestPatternSuspected = true;
      issues.push(lastPatternReason);
    }
  }

  // Gemini Flash Vision Contact-Sheet Inspection (runs during pre-publish or explicit visual audit)
  let aiVisionUsed = false;
  let modelUsed: string | undefined;
  let visualSummary: string | undefined;

  if (options?.enableVisionAudit !== false && hasVideoStream) {
    const tmpSheet = path.join(
      path.dirname(filePath),
      `sensor_grid_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.jpg`
    );
    try {
      const safeDur = Math.max(2, durationSeconds || 10);
      const seeks = [0.15, 0.4, 0.65, 0.85].map((r) => Math.max(0.1, safeDur * r));
      const isLandscape = (width || 0) > (height || 0);
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
          seeks[0].toFixed(2),
          '-i',
          filePath,
          '-ss',
          seeks[1].toFixed(2),
          '-i',
          filePath,
          '-ss',
          seeks[2].toFixed(2),
          '-i',
          filePath,
          '-ss',
          seeks[3].toFixed(2),
          '-i',
          filePath,
          '-filter_complex',
          `[0:v]${scaleExpr}[a];[1:v]${scaleExpr}[b];[2:v]${scaleExpr}[c];[3:v]${scaleExpr}[d];[a][b][c][d]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[grid]`,
          '-map',
          '[grid]',
          '-frames:v',
          '1',
          '-q:v',
          '4',
          tmpSheet,
        ],
        { timeout: 12_000 }
      );

      if (fs.existsSync(tmpSheet) && fs.statSync(tmpSheet).size > 500) {
        const sheetBuf = fs.readFileSync(tmpSheet);
        const vision = await runGeminiFlashVisionInspection(sheetBuf);
        if (vision) {
          aiVisionUsed = true;
          modelUsed = vision.modelUsed;
          visualSummary = vision.visualSummary;

          if (vision.isTestPatternOrColorBars) {
            isTestPatternSuspected = true;
            issues.push(
              vision.rejectionReason ||
                'Gemini Flash Vision Sensor detected color bars, SMPTE chart, checkerboard, or testsrc pattern.'
            );
          }
          if (vision.isBlackOrBlankScreen) {
            blackFrameRatio = Math.max(blackFrameRatio, 0.85);
            issues.push(
              vision.rejectionReason ||
                'Gemini Flash Vision Sensor detected mostly black or blank frames.'
            );
          }
          if (vision.hasBrokenGlyphBoxes) {
            issues.push(
              vision.rejectionReason ||
                'Gemini Flash Vision Sensor detected broken missing-glyph boxes (▯▯▯▯) on video overlay.'
            );
          }
          if (vision.hasDummyOverlayText) {
            isTestPatternSuspected = true;
            issues.push(
              vision.rejectionReason ||
                'Gemini Flash Vision Sensor detected dummy placeholder overlay text ("Clips ai Highlight - #BD" / "Gaming Highlights").'
            );
          }
        }
      }
    } catch {
      // Non-fatal if contact-sheet vision fails; deterministic FFmpeg/pixel checks still enforce protection
    } finally {
      if (fs.existsSync(tmpSheet)) {
        try {
          fs.unlinkSync(tmpSheet);
        } catch {
          // Ignore cleanup failure
        }
      }
    }
  }

  const blockingIssuePresent =
    !hasVideoStream ||
    blackFrameRatio >= 0.65 ||
    isTestPatternSuspected ||
    issues.some((m) =>
      /box|glyph|test pattern|color bars|black\/blank|corrupted|too short|no valid video/i.test(m)
    );

  return {
    passed: !blockingIssuePresent && issues.length === 0,
    hasVideoStream,
    hasAudioStream,
    width,
    height,
    durationSeconds,
    fileSizeBytes: stat.size,
    blackFrameRatio,
    isTestPatternSuspected,
    hasFrozenFrames,
    visualSummary,
    issues: Array.from(new Set(issues)),
    aiVisionUsed,
    modelUsed,
  };
}

export interface SensorClipAuditInput {
  id: string;
  clipNumber: number;
  notes: string;
  startTime?: string;
  endTime?: string;
  title: string;
  description: string;
  hashtags: string[];
  resolvedVideoPath?: string;
  sourceVideoUrl?: string;
}

export function inspectBatchTimelines(
  clips: SensorClipAuditInput[],
  workspaceSourceVideoUrl?: string
): Map<string, ClipSensorIssue[]> {
  const issuesById = new Map<string, ClipSensorIssue[]>();
  const pushIssue = (id: string, issue: ClipSensorIssue) => {
    const arr = issuesById.get(id) || [];
    arr.push(issue);
    issuesById.set(id, arr);
  };

  const parsed = clips.map((c) => {
    const startRaw = String(c.startTime || '').trim();
    const endRaw = String(c.endTime || '').trim();
    const startSec = parseTimestampSec(startRaw);
    const endSec = parseTimestampSec(endRaw);
    const effectiveUrl = String(c.sourceVideoUrl || workspaceSourceVideoUrl || '').trim();
    return {
      ...c,
      startRaw,
      endRaw,
      startSec,
      endSec,
      effectiveUrl,
    };
  });

  for (const c of parsed) {
    if (!c.effectiveUrl) {
      pushIssue(c.id, {
        layer: 'timeline',
        severity: 'block',
        code: 'MISSING_SOURCE_URL',
        message: 'Source Video URL / Link is required for link-only clipping and Zernio publishing.',
      });
    } else {
      try {
        const parsedUrl = new URL(c.effectiveUrl);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          pushIssue(c.id, {
            layer: 'timeline',
            severity: 'block',
            code: 'INVALID_SOURCE_URL',
            message: 'Source Video URL must start with https:// or http://.',
          });
        }
      } catch {
        pushIssue(c.id, {
          layer: 'timeline',
          severity: 'block',
          code: 'INVALID_SOURCE_URL',
          message: 'Source Video URL format is invalid. Paste a valid https:// video link.',
        });
      }
    }

    if (!c.startRaw || !c.endRaw) {
      pushIssue(c.id, {
        layer: 'timeline',
        severity: 'block',
        code: 'MISSING_TIME_RANGE',
        message: 'Start Time and End Time are required to clip from the Source Video URL.',
      });
    } else {
      if (c.endSec <= c.startSec) {
        pushIssue(c.id, {
          layer: 'timeline',
          severity: 'block',
          code: 'INVALID_TIME_RANGE',
          message: `End Time (${c.endRaw}) must be strictly greater than Start Time (${c.startRaw}).`,
        });
      } else {
        const dur = c.endSec - c.startSec;
        if (dur < 2) {
          pushIssue(c.id, {
            layer: 'timeline',
            severity: 'warning',
            code: 'CLIP_TOO_SHORT',
            message: `Clip duration is very short (${dur.toFixed(1)}s). Recommend at least 5s.`,
          });
        } else if (dur > 300) {
          pushIssue(c.id, {
            layer: 'timeline',
            severity: 'warning',
            code: 'CLIP_TOO_LONG',
            message: `Clip duration (${Math.round(dur)}s) exceeds 5 minutes for vertical Shorts/TikTok.`,
          });
        }
      }
    }
  }

  // Cross-clip timeline duplicate & heavy overlap detection
  for (let i = 0; i < parsed.length; i += 1) {
    const a = parsed[i];
    if (!a.startRaw || !a.endRaw || a.endSec <= a.startSec) continue;

    for (let j = i + 1; j < parsed.length; j += 1) {
      const b = parsed[j];
      if (!b.startRaw || !b.endRaw || b.endSec <= b.startSec) continue;

      if (Math.abs(a.startSec - b.startSec) < 0.5 && Math.abs(a.endSec - b.endSec) < 0.5) {
        pushIssue(a.id, {
          layer: 'timeline',
          severity: 'block',
          code: 'DUPLICATE_TIMELINE',
          message: `Same timeline [${a.startRaw} - ${a.endRaw}] shared with Clip #${b.clipNumber}.`,
        });
        pushIssue(b.id, {
          layer: 'timeline',
          severity: 'block',
          code: 'DUPLICATE_TIMELINE',
          message: `Same timeline [${b.startRaw} - ${b.endRaw}] shared with Clip #${a.clipNumber}.`,
        });
      } else {
        const overlapStart = Math.max(a.startSec, b.startSec);
        const overlapEnd = Math.min(a.endSec, b.endSec);
        const overlap = Math.max(0, overlapEnd - overlapStart);
        const minDur = Math.min(a.endSec - a.startSec, b.endSec - b.startSec);
        if (minDur > 0 && overlap / minDur > 0.75) {
          pushIssue(a.id, {
            layer: 'timeline',
            severity: 'warning',
            code: 'OVERLAPPING_TIMELINE',
            message: `Timeline overlaps >75% with Clip #${b.clipNumber}.`,
          });
          pushIssue(b.id, {
            layer: 'timeline',
            severity: 'warning',
            code: 'OVERLAPPING_TIMELINE',
            message: `Timeline overlaps >75% with Clip #${a.clipNumber}.`,
          });
        }
      }
    }
  }

  return issuesById;
}

interface GeminiMetadataAuditItem {
  clipId: string;
  status: 'passed' | 'warning' | 'blocked';
  issues: string[];
  fixedTitle?: string;
  fixedDescription?: string;
  fixedHashtags?: string[];
}

async function runGeminiFlashMetadataAudit(params: {
  clips: SensorClipAuditInput[];
  nicheHint?: string;
  languagePreference?: string;
}): Promise<{ aiAudited: boolean; modelUsed?: string; resultsById: Map<string, GeminiMetadataAuditItem> }> {
  const resultsById = new Map<string, GeminiMetadataAuditItem>();
  if (params.clips.length === 0) {
    return { aiAudited: false, resultsById };
  }

  const payloadSummary = params.clips.map((c) => ({
    clipId: c.id,
    clipNumber: c.clipNumber,
    timeRange: `${c.startTime || '?'} - ${c.endTime || '?'}`,
    sceneNotes: c.notes.slice(0, 320),
    title: c.title,
    description: c.description.slice(0, 420),
    hashtags: c.hashtags,
  }));

  const prompt = `You are the Gemini Flash Metadata & Quality Sensor for Clips ai.
Audit EVERY clip below BEFORE publishing to TikTok / YouTube Shorts:
${params.nicheHint ? `Channel Niche Hint: "${params.nicheHint}"\n` : ''}${
    params.languagePreference ? `Requested Language: "${params.languagePreference}"\n` : ''
  }
Check each clip strictly for:
1. Duplicate or repetitive title patterns across clips (e.g., repeated "GTA 6 Clutch Moment", repeated opener).
2. Dummy/numbered words or tags ("zero", "one", "two", "#0", "#1", "#2", "Hashtag Zero", "Clip 1", "Part 1").
3. Scene/Notes alignment (title & caption must match THIS clip's own sceneNotes accurately).
4. Title length strictly <= 80 chars, natural Bangladeshi creator Bangla or Banglish (no broken translation).
5. Hashtags MUST include #BD plus 3-5 clean, relevant hashtags.

If ANY issue is found (or if title/hashtags can be improved), provide clean corrected values in fixedTitle, fixedDescription, and fixedHashtags. If the clip is already clean and unique, set status="passed" and issues=[].

CLIPS TO AUDIT:
${JSON.stringify(payloadSummary, null, 2)}`;

  const models = getSensorFlashModels();
  for (const model of models.slice(0, 3)) {
    const acquired = acquireGeminiKey();
    if (!acquired) break;
    try {
      const ai = createGeminiClientForKey(acquired.apiKey);
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              audits: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    clipId: { type: Type.STRING },
                    status: { type: Type.STRING },
                    issues: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                    },
                    fixedTitle: { type: Type.STRING },
                    fixedDescription: { type: Type.STRING },
                    fixedHashtags: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                    },
                  },
                  required: ['clipId', 'status', 'issues'],
                },
              },
            },
            required: ['audits'],
          },
        },
      });
      markKeySuccess(acquired.id);
      const parsed = JSON.parse((response.text ?? '{}').trim()) as {
        audits?: GeminiMetadataAuditItem[];
      };
      if (Array.isArray(parsed.audits)) {
        for (const item of parsed.audits) {
          if (item?.clipId) {
            resultsById.set(item.clipId, item);
          }
        }
        return { aiAudited: true, modelUsed: model, resultsById };
      }
    } catch (err) {
      if (isInvalidKeyError(err)) {
        markKeyInvalid(acquired.id, formatSafeGeminiError(err));
      } else if (isRateLimitError(err) || isOverloadError(err)) {
        markKeyRateLimited(acquired.id, formatSafeGeminiError(err), computeCooldownMs(err));
      } else if (isModelNotFoundError(err)) {
        quarantineModel(model, formatSafeGeminiError(err));
      }
    } finally {
      releaseGeminiKey(acquired.id);
    }
  }

  return { aiAudited: false, resultsById };
}

export async function runClipSensorAudit(params: {
  clips: SensorClipAuditInput[];
  sourceVideoUrl?: string;
  nicheHint?: string;
  languagePreference?: ContentLanguageChoice | string;
  enableVisualAudit?: boolean;
}): Promise<ClipSensorResult[]> {
  const timelineIssuesById = inspectBatchTimelines(params.clips, params.sourceVideoUrl);

  // Deterministic Metadata Hygiene & Uniqueness Pass
  const deterministicMetaById = new Map<string, ClipSensorIssue[]>();
  const pushMeta = (id: string, issue: ClipSensorIssue) => {
    const arr = deterministicMetaById.get(id) || [];
    arr.push(issue);
    deterministicMetaById.set(id, arr);
  };

  for (let i = 0; i < params.clips.length; i += 1) {
    const c = params.clips[i];
    const title = String(c.title || '').trim();
    const desc = String(c.description || '').trim();
    const tagsJoined = (c.hashtags || []).join(' ');
    const combined = `${title}\n${desc}\n${tagsJoined}`;

    if (!title) {
      pushMeta(c.id, {
        layer: 'metadata',
        severity: 'block',
        code: 'EMPTY_TITLE',
        message: 'Title is missing. Generate or enter a unique title before publishing.',
      });
    } else if (title.length > 80) {
      pushMeta(c.id, {
        layer: 'metadata',
        severity: 'warning',
        code: 'TITLE_TOO_LONG',
        message: `Title exceeds 80 characters (${title.length}/80).`,
      });
    }

    if (BROKEN_GLYPH_REGEX.test(combined)) {
      pushMeta(c.id, {
        layer: 'metadata',
        severity: 'block',
        code: 'BROKEN_GLYPHS',
        message: 'Broken/unrendered box characters (▯/□) detected in metadata.',
      });
    }

    if (
      BANNED_METADATA_REGEX.test(combined) ||
      NUMBERED_DUMMY_TAG_REGEX.test(tagsJoined) ||
      NUMBERED_DUMMY_TAG_REGEX.test(desc) ||
      NUMBERED_CLIP_LABEL_REGEX.test(title)
    ) {
      pushMeta(c.id, {
        layer: 'metadata',
        severity: 'block',
        code: 'DUMMY_OR_NUMBERED_TAGS',
        message: 'Dummy placeholder phrase or numbered hashtag (#0/#1/#2/Clutch Moment) detected.',
      });
    }

    if (/https?:\/\//i.test(title) || /https?:\/\//i.test(desc)) {
      pushMeta(c.id, {
        layer: 'metadata',
        severity: 'warning',
        code: 'RAW_URL_IN_METADATA',
        message: 'Raw URL found inside Title or Description.',
      });
    }

    const hasBd =
      (c.hashtags || []).some((h) => h.trim().toLowerCase() === '#bd') || /#bd\b/i.test(desc);
    if (!hasBd) {
      pushMeta(c.id, {
        layer: 'metadata',
        severity: 'warning',
        code: 'MISSING_BD_TAG',
        message: 'Mandatory #BD hashtag is missing.',
      });
    }

    // Cross-clip duplicate title check
    if (title) {
      for (let j = i + 1; j < params.clips.length; j += 1) {
        const other = params.clips[j];
        const otherTitle = String(other.title || '').trim();
        if (otherTitle && areTitlesSimilar(title, otherTitle)) {
          pushMeta(c.id, {
            layer: 'metadata',
            severity: 'block',
            code: 'DUPLICATE_TITLE',
            message: `Title duplicates or closely matches Clip #${other.clipNumber}.`,
          });
          pushMeta(other.id, {
            layer: 'metadata',
            severity: 'block',
            code: 'DUPLICATE_TITLE',
            message: `Title duplicates or closely matches Clip #${c.clipNumber}.`,
          });
        }
      }
    }
  }

  // Parallel: Gemini Flash Metadata Audit + Visual Inspection of any attached rendered video files
  const [aiAudit, visualResults] = await Promise.all([
    runGeminiFlashMetadataAudit({
      clips: params.clips,
      nicheHint: params.nicheHint,
      languagePreference: params.languagePreference,
    }),
    Promise.all(
      params.clips.map(async (c) => {
        if (!c.resolvedVideoPath) return null;
        return inspectRenderedClipVideo(c.resolvedVideoPath, {
          enableVisionAudit: params.enableVisualAudit !== false,
        });
      })
    ),
  ]);

  const auditedAt = new Date().toISOString();

  return params.clips.map((c, idx) => {
    const issues: ClipSensorIssue[] = [];
    const tIssues = timelineIssuesById.get(c.id) || [];
    const dMetaIssues = deterministicMetaById.get(c.id) || [];
    issues.push(...tIssues, ...dMetaIssues);

    const visual = visualResults[idx];
    let visualChecked = false;
    if (visual) {
      visualChecked = true;
      for (const msg of visual.issues) {
        const isBlock =
          !visual.hasVideoStream ||
          (visual.blackFrameRatio ?? 0) >= 0.65 ||
          Boolean(visual.isTestPatternSuspected) ||
          /box|glyph|test pattern|color bars|black\/blank|corrupted|too short|no valid video/i.test(
            msg
          );
        issues.push({
          layer: 'visual',
          severity: isBlock ? 'block' : 'warning',
          code: isBlock ? 'VISUAL_SENSOR_BLOCK' : 'VISUAL_SENSOR_WARNING',
          message: msg,
        });
      }
    }

    const aiItem = aiAudit.resultsById.get(c.id);
    if (aiItem && Array.isArray(aiItem.issues) && aiItem.issues.length > 0) {
      for (const msg of aiItem.issues) {
        const cleanMsg = String(msg || '').trim();
        if (!cleanMsg) continue;
        // Avoid duplicating an already-caught exact issue
        if (issues.some((existing) => existing.message.toLowerCase() === cleanMsg.toLowerCase())) {
          continue;
        }
        const isBlock =
          aiItem.status === 'blocked' &&
          /duplicate|repetitive|dummy|numbered|mismatch|unrelated|hallucinat/i.test(cleanMsg);
        issues.push({
          layer: 'metadata',
          severity: isBlock ? 'block' : 'warning',
          code: 'GEMINI_FLASH_AUDIT',
          message: cleanMsg,
        });
      }
    }

    let autoFixedFields: ClipSensorResult['autoFixedFields'];
    const hasMetaIssues = issues.some((x) => x.layer === 'metadata');
    if (hasMetaIssues) {
      const candidateTitle = aiItem?.fixedTitle?.trim() || c.title;
      const sanitizedTitle = sanitizeTitleText(candidateTitle, {
        fallbackSummary: c.notes,
        formatMode: 'short',
        topicHint: params.nicheHint,
      });

      const sanitizedTags = sanitizeHashtags(
        aiItem?.fixedHashtags && aiItem.fixedHashtags.length > 0
          ? aiItem.fixedHashtags
          : c.hashtags,
        {
          isGtaContext: /gta|grand theft auto/i.test(`${c.notes} ${params.nicheHint || ''}`),
          formatMode: 'short',
          sceneText: `${c.notes} ${params.nicheHint || ''}`,
          minRelevant: 3,
          maxRelevant: 5,
        }
      );

      let cleanedDesc = stripDummyPhrasesFromText(
        stripUrlsFromText(aiItem?.fixedDescription?.trim() || c.description || c.notes)
      ).trim();
      if (!/#bd\b/i.test(cleanedDesc)) {
        cleanedDesc = `${cleanedDesc}\n\n${sanitizedTags.join(' ')}`;
      }

      autoFixedFields = {
        title: sanitizedTitle,
        description: cleanedDesc,
        hashtags: sanitizedTags,
      };
    }

    const hasBlock = issues.some((x) => x.severity === 'block');
    const hasWarn = issues.some((x) => x.severity === 'warning');
    const status: SensorStatusLevel = hasBlock ? 'blocked' : hasWarn ? 'warning' : 'passed';

    return {
      clipId: c.id,
      clipNumber: c.clipNumber,
      status,
      issues,
      visualChecked,
      ...(visual ? { visualReport: visual } : {}),
      aiAudited: aiAudit.aiAudited,
      modelUsed: visual?.modelUsed || aiAudit.modelUsed,
      ...(autoFixedFields ? { autoFixedFields } : {}),
      auditedAt,
    };
  });
}
