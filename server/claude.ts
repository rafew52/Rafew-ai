import Anthropic from '@anthropic-ai/sdk';
import type { ClaudeClipEditPlan, ContentLanguageChoice, RequirementSpec } from '../src/types.ts';
import { getActiveClaudeApiKey, rotateClaudeApiKey } from './claudeKeys.ts';
import type { DetectedMoment } from './gemini.ts';
import {
  formatRequirementSummary,
  parseRequirementSpec,
  resolveLockedLanguageChoice,
  sanitizeHashtags,
  sanitizeSeoTags,
  sanitizeTitleText,
  stripDummyPhrasesFromText,
} from './requirementEngine.ts';

const CLAUDE_MODEL_CANDIDATES = [
  process.env.CLAUDE_MODEL?.trim(),
  'claude-sonnet-4-20250514',
  'claude-3-7-sonnet-20250219',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
].filter((m): m is string => Boolean(m));

export interface ParsedTimestampRange {
  startSeconds: number;
  endSeconds: number;
  rawText: string;
}

export function isClaudeConfigured(): boolean {
  return Boolean(getActiveClaudeApiKey());
}

export function createClaudeClient(): Anthropic {
  const apiKey = getActiveClaudeApiKey();
  if (!apiKey) {
    throw new Error('Anthropic Claude API key is missing. Add your ANTHROPIC_API_KEY in System Setup.');
  }
  return new Anthropic({ apiKey });
}

export async function callClaudeWithRetry(
  prompt: string,
  systemPrompt?: string,
  maxTokens = 4096
): Promise<string> {
  let attempts = 0;
  const maxAttempts = 3;
  let modelIdx = 0;

  while (attempts < maxAttempts) {
    attempts++;
    const model = CLAUDE_MODEL_CANDIDATES[modelIdx % CLAUDE_MODEL_CANDIDATES.length];
    try {
      const anthropic = createClaudeClient();
      const response = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages: [{ role: 'user', content: prompt }],
      });

      const firstBlock = response.content[0];
      if (firstBlock && firstBlock.type === 'text') {
        return firstBlock.text;
      }
      throw new Error('Claude response did not contain text content.');
    } catch (err: any) {
      const status = err?.status || err?.statusCode;
      const msg = String(err?.message || '').toLowerCase();
      if (status === 404 || msg.includes('not_found') || msg.includes('model')) {
        modelIdx++;
        if (attempts >= maxAttempts) throw err;
        continue;
      }
      if (status === 429 || status === 529 || msg.includes('rate')) {
        console.warn(`Claude API rate limit/overload (${status}). Rotating Claude API key...`);
        rotateClaudeApiKey();
        if (attempts >= maxAttempts) throw err;
        continue;
      }
      if (attempts >= maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, 1200 * attempts));
    }
  }

  throw new Error('Claude API call failed after retries.');
}

export async function generateClaudeJson<T>(prompt: string, systemPrompt?: string): Promise<T> {
  const fullPrompt = `${prompt}\n\nIMPORTANT: Return valid JSON only with no markdown formatting or backticks around the json block.`;
  const rawText = await callClaudeWithRetry(fullPrompt, systemPrompt);
  const trimmed = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as T;
    }
    throw new Error('Claude returned invalid JSON output.');
  }
}

function timeStringToSeconds(str: string): number {
  const parts = str.trim().split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

export function parseAllTimestampRanges(instruction?: string): ParsedTimestampRange[] {
  if (!instruction) return [];
  const results: ParsedTimestampRange[] = [];
  const regex = /(\d{1,2}(?::\d{2}){1,2})\s*(?:-|–|—|to)\s*(\d{1,2}(?::\d{2}){1,2})/gi;
  for (const match of instruction.matchAll(regex)) {
    const startSeconds = timeStringToSeconds(match[1]);
    const endSeconds = timeStringToSeconds(match[2]);
    if (endSeconds > startSeconds) {
      results.push({
        startSeconds,
        endSeconds,
        rawText: match[0],
      });
    }
  }
  return results;
}

export async function generateClaudeClipAnalysis(params: {
  transcriptSnippet: string;
  additionalInstructions?: string;
  formatMode: 'short' | 'long';
  requirementSpec?: RequirementSpec;
}): Promise<{
  momentSummary: string;
  title: string;
  description: string;
  tags: string[];
  hashtags: string[];
  viralReason: string;
  thumbnailHook: string;
  thumbnailTimestamp: number;
  startSeconds: number;
  endSeconds: number;
  languageChoice: ContentLanguageChoice;
}> {
  const ranges = parseAllTimestampRanges(params.additionalInstructions);
  const forcedRange = ranges[0];
  const reqCtx = parseRequirementSpec({
    topicIdea: params.requirementSpec?.topicIdea,
    categories: params.requirementSpec?.lockedCategories,
    languagePreference: params.requirementSpec?.languagePreference,
    formatMode: params.formatMode,
    additionalInstructions: params.additionalInstructions,
  });

  const systemPrompt = `You are a strict video metadata & clipping assistant for TikTok and YouTube Shorts.
Analyze ONLY the actual visual/audio context of the clip snippet provided.
MANDATORY RULES:
1. Context Alignment: moment_summary, title, and caption/description MUST describe the actual scene in the clip. Never invent generic placeholders, broken words, or weird literal translations.
2. Language: Write natural, engaging Bangla (বাংলা Unicode), Banglish, or English (matching ${reqCtx.spec.languagePreference}) that sounds like a real gaming creator.
3. Hashtags: Always include #BD + 3 to 5 clean, relevant hashtags matching the clip's topic and niche. NEVER output numbered dummy tags (#0, #1, #2, Hashtag Zero, Hashtag One, Hashtag Two).
4. Title: Catchy, curiosity-driven, unique title matching the clip, max 80 characters. NEVER use generic templates ("GTA 6 Clutch Moment", "Clutch Action Moment") or numbering (#1, Clip 1, Part 1).`;

  const prompt = `Analyze this clip transcript/context and generate strict clip-aligned metadata:
Requirement Boundary: ${formatRequirementSummary(reqCtx)}
Transcript / Audio-Visual Context: "${params.transcriptSnippet}"
Format Mode: ${params.formatMode}
Custom User Instructions: "${params.additionalInstructions || 'None'}"
Forced Timestamp Range: ${JSON.stringify(forcedRange || null)}

Return JSON matching this exact structure:
{
  "language_choice": "bengali | banglish | english",
  "moment_summary": "1 short line describing what happens in this clip",
  "title": "Catchy scene-accurate title, max 80 chars",
  "description": "Engaging Bangla/Banglish/English caption matching the clip + hashtags including #BD",
  "tags": ["BD", "relevantTag1", "relevantTag2"],
  "hashtags": ["#BD", "#RelevantTag1", "#RelevantTag2", "#RelevantTag3"],
  "viralReason": "Why this moment stands out",
  "thumbnailHook": "SHORT 2-4 WORD HOOK",
  "thumbnailTimestamp": 10,
  "startSeconds": ${forcedRange ? forcedRange.startSeconds : 0},
  "endSeconds": ${forcedRange ? forcedRange.endSeconds : 45}
}`;

  const result = await generateClaudeJson<{
    language_choice?: string;
    moment_summary?: string;
    title: string;
    description: string;
    tags: string[];
    hashtags: string[];
    viralReason: string;
    thumbnailHook: string;
    thumbnailTimestamp: number;
    startSeconds: number;
    endSeconds: number;
  }>(prompt, systemPrompt);

  if (forcedRange) {
    result.startSeconds = forcedRange.startSeconds;
    result.endSeconds = forcedRange.endSeconds;
  }

  const languageChoice = resolveLockedLanguageChoice(
    result.language_choice,
    reqCtx.spec.languagePreference
  );
  const momentSummary = stripDummyPhrasesFromText(result.moment_summary || result.viralReason || '').slice(0, 140);
  const hashtags = sanitizeHashtags(result.hashtags, {
    isGtaContext: reqCtx.isGtaContext,
    formatMode: params.formatMode,
    lockedCategories: reqCtx.spec.lockedCategories,
    topicKeywords: reqCtx.topicKeywords,
    sceneText: `${momentSummary} ${result.title || ''} ${result.description || ''}`,
  });
  const title = sanitizeTitleText(result.title, {
    fallbackSummary: momentSummary || result.viralReason,
    formatMode: params.formatMode,
    languageChoice,
    isGtaContext: reqCtx.isGtaContext,
    topicHint: reqCtx.spec.topicIdea,
  });
  let description = stripDummyPhrasesFromText(result.description || momentSummary);
  if (!/#bd\b/i.test(description)) {
    description = `${description}\n\n${hashtags.join(' ')}`;
  }

  return {
    ...result,
    momentSummary,
    title,
    description,
    hashtags,
    tags: sanitizeSeoTags(result.tags, {
      isGtaContext: reqCtx.isGtaContext,
      formatMode: params.formatMode,
      lockedCategories: reqCtx.spec.lockedCategories,
      topicKeywords: reqCtx.topicKeywords,
    }),
    languageChoice,
  };
}

export async function refineMomentsWithClaude(params: {
  moments: DetectedMoment[];
  formatMode: 'short' | 'long';
  aspectMode: 'portrait' | 'landscape';
  chunkDurationSeconds: number;
  chunkOffsetSeconds: number;
  additionalInstructions?: string;
  requirementSpec?: RequirementSpec;
  recentLanguages?: ContentLanguageChoice[];
  recentTitles?: string[];
  videoTitleHint?: string;
}): Promise<DetectedMoment[]> {
  if (params.moments.length === 0) return [];

  const reqCtx = parseRequirementSpec({
    topicIdea: params.requirementSpec?.topicIdea,
    categories: params.requirementSpec?.lockedCategories,
    languagePreference: params.requirementSpec?.languagePreference,
    clipCount: params.requirementSpec?.clipCount,
    formatMode: params.formatMode,
    aspectMode: params.aspectMode,
    additionalInstructions: params.additionalInstructions,
  });

  const explicitRanges = parseAllTimestampRanges(params.additionalInstructions);
  const recentLangNote =
    params.recentLanguages && params.recentLanguages.length > 0
      ? params.recentLanguages.slice(0, 6).join(', ')
      : 'none yet';

  const recentTitlesNote =
    params.recentTitles && params.recentTitles.length > 0
      ? params.recentTitles
          .slice(0, 12)
          .map((t, i) => `  ${i + 1}. "${t}"`)
          .join('\n')
      : '  (none yet)';

  const langRule =
    reqCtx.spec.languagePreference === 'bengali'
      ? `STRICT LANGUAGE LOCK: Set "language_choice" to "bengali" and write natural, engaging Bangla (বাংলা Unicode) sounding like a real creator.`
      : reqCtx.spec.languagePreference === 'banglish'
      ? `STRICT LANGUAGE LOCK: Set "language_choice" to "banglish" and write natural, engaging Banglish sounding like a real Bangladeshi gaming creator.`
      : reqCtx.spec.languagePreference === 'english'
      ? `STRICT LANGUAGE LOCK: Set "language_choice" to "english" and write punchy creator English.`
      : `Pick "language_choice" ("bengali", "banglish", or "english") matching the clip context and varying naturally from recent clips [${recentLangNote}].`;

  const systemPrompt = `You are a strict video metadata & clipping assistant for TikTok and YouTube Shorts.
Inspect EACH extracted moment individually and generate 100% unique, scene-matched metadata for that exact clip.

RULES FOR TITLE, CAPTION & HASHTAGS:
1. Per-Clip Unique Scene-Matched Titles: Inspect each clip's specific action, joke, crash, NPC reaction, stunt, chase, dialogue, or twist individually. Every clip in this batch MUST have a distinct, curiosity-driven title—NEVER reuse the same title structure across multiple clips or repeat any title from ALREADY USED TITLES.
2. Context Alignment: "moment_summary", "title", and "description" MUST describe the actual moment in that clip. Never invent generic placeholders, broken words, or weird literal translations. Never inject unrelated games.
3. Banned Clichés & Dummy Tags: STRICTLY FORBIDDEN anywhere: "GTA 6 Clutch Moment", "Clutch Action Moment", "Hashtag Zero", "Hashtag One", "Hashtag Two", "hashtag zero", "#0", "#1", "#2", "#1", "Clip 1", "Part 1", or raw URLs.
4. Language: ${langRule}
5. Title Limit: Catchy, accurate title matching the clip, STRICTLY max 80 characters.
6. Hashtags: Always include #BD + 3 to 5 clean, relevant hashtags directly matching the clip's topic and niche.
7. Respect exact timestamps [0, ${Math.floor(params.chunkDurationSeconds)}] unless explicit timestamp ranges request changes.`;

  const prompt = `Format: ${params.formatMode === 'long' ? `Long-Form Video (${params.aspectMode})` : 'TikTok & YouTube Shorts (9:16)'}
Locked Requirement Boundary: ${formatRequirementSummary(reqCtx)}
${params.videoTitleHint ? `Source Video Title: "${params.videoTitleHint}"` : ''}
Segment Offset in Stream: ${params.chunkOffsetSeconds}s (Segment Length: ${Math.floor(params.chunkDurationSeconds)}s)
Custom User Instructions: "${params.additionalInstructions?.trim() || 'None'}"
Explicit Timestamp Ranges Parsed: ${JSON.stringify(explicitRanges)}

ALREADY USED TITLES IN THIS STREAM (DO NOT REPEAT OR PARAPHRASE):
${recentTitlesNote}

Detected Video Moments JSON (ONLY use facts from each moment):
${JSON.stringify(params.moments, null, 2)}

Return JSON with this exact root shape:
{
  "moments": [
    {
      "category": "funny | epic_gameplay | highlight | reaction | viral",
      "start_seconds": 0,
      "end_seconds": 30,
      "language_choice": "bengali | banglish | english",
      "moment_summary": "1 short line describing what happens in this exact clip",
      "viral_reason": "Concise insight into why viewers replay/share this scene",
      "title": "Unique curiosity-driven title matching THIS exact clip (STRICTLY <= 80 chars)",
      "description": "Short engaging Bangla/Banglish/English caption tailored to this exact clip + hashtags including #BD",
      "thumbnail_hook": "SHORT 2-4 WORD HOOK matching the moment",
      "thumbnail_timestamp": 12.5,
      "hashtags": ["#BD", "#RelevantTag1", "#RelevantTag2", "#RelevantTag3"],
      "tags": ["BD", "RelevantTag1", "RelevantTag2"],
      "captions": [
        { "start_offset_seconds": 0.5, "end_offset_seconds": 3.2, "text": "..." }
      ]
    }
  ]
}`;

  const refined = await generateClaudeJson<{ moments?: DetectedMoment[] }>(prompt, systemPrompt);
  if (!Array.isArray(refined.moments) || refined.moments.length === 0) {
    return params.moments;
  }

  return refined.moments.map((m, idx) => {
    const orig = params.moments[idx] || params.moments[0];
    const langChoice = resolveLockedLanguageChoice(
      m.language_choice || orig.language_choice,
      reqCtx.spec.languagePreference
    );
    const cleanSummary = stripDummyPhrasesFromText(
      m.moment_summary || orig.moment_summary || m.viral_reason || orig.viral_reason || ''
    )
      .trim()
      .slice(0, 140);
    const cleanHashtags = sanitizeHashtags(
      Array.isArray(m.hashtags) && m.hashtags.length > 0 ? m.hashtags : orig.hashtags,
      {
        isGtaContext: reqCtx.isGtaContext,
        formatMode: params.formatMode,
        lockedCategories: reqCtx.spec.lockedCategories,
        topicKeywords: reqCtx.topicKeywords,
        momentCategory: m.category || orig.category,
        sceneText: `${cleanSummary} ${m.title || orig.title || ''} ${m.description || orig.description || ''}`,
      }
    );
    const cleanTitle = sanitizeTitleText(m.title || orig.title, {
      fallbackSummary: cleanSummary,
      formatMode: params.formatMode,
      languageChoice: langChoice,
      isGtaContext: reqCtx.isGtaContext,
      topicHint: reqCtx.spec.topicIdea,
    });
    let cleanDescription = stripDummyPhrasesFromText(m.description || orig.description || cleanSummary);
    if (!/#bd\b/i.test(cleanDescription)) {
      cleanDescription = `${cleanDescription}\n\n${cleanHashtags.join(' ')}`;
    }

    return {
      ...orig,
      ...m,
      moment_summary: cleanSummary,
      title: cleanTitle,
      description: cleanDescription,
      start_seconds: Number.isFinite(Number(m.start_seconds))
        ? Number(m.start_seconds)
        : orig.start_seconds,
      end_seconds: Number.isFinite(Number(m.end_seconds))
        ? Number(m.end_seconds)
        : orig.end_seconds,
      language_choice: langChoice,
      hashtags: cleanHashtags,
      tags: sanitizeSeoTags(Array.isArray(m.tags) ? m.tags : orig.tags, {
        isGtaContext: reqCtx.isGtaContext,
        formatMode: params.formatMode,
        lockedCategories: reqCtx.spec.lockedCategories,
        topicKeywords: reqCtx.topicKeywords,
      }),
      captions:
        Array.isArray(m.captions) && m.captions.length > 0 ? m.captions : orig.captions || [],
    };
  });
}

export async function regenerateClipMetadataWithClaude(params: {
  momentSummary: string;
  viralReason?: string;
  captionsText?: string;
  videoTitleHint?: string;
  category: string;
  formatMode: 'short' | 'long';
  languageChoice: ContentLanguageChoice;
  requirementSummary: string;
  forbiddenTitles: string[];
}): Promise<{
  moment_summary: string;
  title: string;
  description: string;
  hashtags: string[];
  tags: string[];
} | null> {
  if (!isClaudeConfigured()) return null;

  const systemPrompt = `You are a strict TikTok & YouTube Shorts video metadata writer.
Generate a 100% UNIQUE, scene-matched title, engaging caption, and clean hashtags (#BD + 3-5 relevant tags).
NEVER reuse any title from FORBIDDEN TITLES.
NEVER output "GTA 6 Clutch Moment", "Clutch Action Moment", "Hashtag Zero", "Hashtag One", "Hashtag Two", "#0", "#1", "#2", "Clip 1", or raw URLs.`;

  const prompt = `Requirement Spec: ${params.requirementSummary}
Format: ${params.formatMode === 'long' ? 'Long-Form YouTube' : 'TikTok & YouTube Shorts'}
${params.videoTitleHint ? `Source Video Title: "${params.videoTitleHint}"` : ''}
Language Choice: ${params.languageChoice}
Category: ${params.category}
Clip Moment Summary: "${params.momentSummary}"
${params.viralReason ? `Action/Hook: "${params.viralReason}"` : ''}
${params.captionsText ? `Dialogue/Captions: "${params.captionsText}"` : ''}
FORBIDDEN TITLES (DO NOT REPEAT OR PARAPHRASE):
${params.forbiddenTitles.slice(0, 20).map((t, i) => `${i + 1}. "${t}"`).join('\n') || '(none)'}

Return JSON:
{
  "moment_summary": "1 crisp scene description line",
  "title": "Unique curiosity-driven title <= 80 chars matching this exact scene",
  "description": "Short natural ${params.languageChoice} creator caption matching the clip + hashtags including #BD",
  "hashtags": ["#BD", "#Tag1", "#Tag2", "#Tag3"],
  "tags": ["BD", "tag1", "tag2"]
}`;

  try {
    const res = await generateClaudeJson<{
      moment_summary?: string;
      title?: string;
      description?: string;
      hashtags?: string[];
      tags?: string[];
    }>(prompt, systemPrompt);
    if (!res?.title) return null;
    return {
      moment_summary: res.moment_summary || params.momentSummary,
      title: res.title,
      description: res.description || res.moment_summary || params.momentSummary,
      hashtags: Array.isArray(res.hashtags) ? res.hashtags : [],
      tags: Array.isArray(res.tags) ? res.tags : [],
    };
  } catch {
    return null;
  }
}

export async function generateClaudeLiveMetadata(
  sourceUrl: string,
  additionalInstructions?: string
): Promise<{ title: string; description: string; tags: string[] }> {
  const prompt = `Generate a catchy YouTube Live Title (max 80 chars), Description, and Tags for live source: "${sourceUrl}".
Custom Instructions (HIGHEST PRIORITY): "${additionalInstructions || 'High energy gaming stream for Bangladeshi & global viewers'}".
Choose naturally between English, Banglish, or Bengali (বাংলা) based on context/instructions, always include #BD, and strictly avoid numbering templates like '#1', 'Part 1', or dummy tags (#0, #1, #2, Hashtag Zero).
Return JSON format:
{
  "title": "...",
  "description": "...",
  "tags": ["...", "..."]
}`;
  return generateClaudeJson(
    prompt,
    'You are a professional YouTube Live Channel Manager (#BD).'
  );
}

export async function generateClaudeChatEngagement(
  streamTitle: string,
  recentChat: string
): Promise<string> {
  const prompt = `Stream Title: "${streamTitle}"
Recent Chat: "${recentChat || 'Stream started'}"
Write a fresh, natural live chat message matching the language/vibe of the title or chat (naturally mixing Bengali বাংলা, Banglish, or English when natural for #BD viewers). Encourage likes and subscribes with #BD. Max 2 sentences. Return plain text only.`;
  return callClaudeWithRetry(
    prompt,
    'You are an energetic gaming stream host (#BD).'
  );
}

function clampNumber(val: unknown, min: number, max: number, fallback: number): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export async function planClipEditingWithClaude(params: {
  sourceVideoUrl: string;
  startTime: string;
  endTime: string;
  startSeconds: number;
  endSeconds: number;
  notes?: string;
  title?: string;
  nicheHint?: string;
}): Promise<ClaudeClipEditPlan> {
  const defaultPlan = (diagnosticMessage?: string): ClaudeClipEditPlan => ({
    framingMode: 'split_screen',
    cropBias: 'center',
    contrast: 1.04,
    saturation: 1.06,
    editingSummary:
      '9:16 upper gameplay + clear facecam split-screen (or prominent vertical gameplay) with full-duration Bangla/Banglish subtitles & clean source audio.',
    pacingNotes: `Segment ${params.startTime}–${params.endTime} (${Math.max(1, Math.round(params.endSeconds - params.startSeconds))}s)`,
    claudeUsed: false,
    ...(diagnosticMessage ? { diagnosticMessage } : {}),
  });

  if (!isClaudeConfigured()) {
    return defaultPlan(
      'Claude API key is not configured in Settings; applied safe deterministic 9:16 split-screen/vertical profile.'
    );
  }

  const systemPrompt = `You are a professional short-form 9:16 video editor for TikTok and YouTube Shorts.
Determine the optimal 9:16 framing (split-screen gameplay+facecam when facecam is present, otherwise prominent vertical gameplay — NEVER small 16:9 letterbox with blur bars) and subtle color tuning preserving clean original source audio.
Respond ONLY with valid JSON.`;

  const duration = Math.max(1, Math.round(params.endSeconds - params.startSeconds));
  const prompt = `Plan 9:16 clip editing parameters for this source segment:
- Source Link: ${params.sourceVideoUrl}
- Segment Range: ${params.startTime} to ${params.endTime} (${duration}s)
- Title: "${params.title || ''}"
- Scene Notes: "${params.notes || 'Gaming / creator highlight'}"
${params.nicheHint ? `- Niche: "${params.nicheHint}"\n` : ''}
Choose:
- "framingMode": "split_screen" (upper gameplay + bottom facecam when webcam present, auto-falling back to full gameplay) or "vertical_crop" (full prominent 1080x1920 gameplay)
- "cropBias": "center" | "top" | "bottom"
- "contrast": number between 0.96 and 1.12 (1.03–1.06 recommended)
- "saturation": number between 0.96 and 1.20 (1.04–1.10 recommended)
- "editingSummary": short 1-sentence summary of the visual editing choice
- "pacingNotes": concise pacing tip

Return JSON:
{
  "framingMode": "split_screen",
  "cropBias": "center",
  "contrast": 1.04,
  "saturation": 1.06,
  "editingSummary": "...",
  "pacingNotes": "..."
}`;

  try {
    const raw = await generateClaudeJson<{
      framingMode?: string;
      cropBias?: string;
      contrast?: number;
      saturation?: number;
      editingSummary?: string;
      pacingNotes?: string;
    }>(prompt, systemPrompt);

    const framingMode =
      raw?.framingMode === 'vertical_crop' ? 'vertical_crop' : 'split_screen';
    const cropBias =
      raw?.cropBias === 'top' || raw?.cropBias === 'bottom' ? raw.cropBias : 'center';

    return {
      framingMode,
      cropBias,
      contrast: Number(clampNumber(raw?.contrast, 0.95, 1.15, 1.04).toFixed(2)),
      saturation: Number(clampNumber(raw?.saturation, 0.95, 1.25, 1.06).toFixed(2)),
      editingSummary:
        String(raw?.editingSummary || '').trim().slice(0, 180) ||
        `Claude 9:16 ${framingMode} (${cropBias}) preserving original source audio.`,
      pacingNotes: String(raw?.pacingNotes || '').trim().slice(0, 160) || undefined,
      claudeUsed: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return defaultPlan(`Claude editing planner fallback (${msg.slice(0, 140)}).`);
  }
}
