import { ThinkingLevel, Type } from '@google/genai';
import type {
  AutoDoctorEvent,
  AutoDoctorFinding,
  AutoDoctorReport,
  AutoDoctorSeverity,
  ClipItem,
  StreamJob,
  SystemReadiness,
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
import {
  discoverGeminiModels,
  getActiveCandidateModels,
  quarantineModel,
} from './geminiModels.ts';

const MAX_EVENTS = 80;
const AUTO_DIAGNOSE_COOLDOWN_MS = 45_000;

const events: AutoDoctorEvent[] = [];
let autoDiagnoseEnabled = true;
let diagnosing = false;
let lastAiDiagnosisAtMs = 0;
let lastReport: AutoDoctorReport | null = null;
let contextProvider:
  | (() => Promise<{
      streams: StreamJob[];
      clips: ClipItem[];
      readiness: SystemReadiness;
    }>)
  | null = null;

export function registerAutoDoctorContextProvider(
  provider: () => Promise<{
    streams: StreamJob[];
    clips: ClipItem[];
    readiness: SystemReadiness;
  }>
) {
  contextProvider = provider;
}

export function getAutoDoctorAlertCount(): number {
  const recentWindowMs = Date.now() - 30 * 60_000;
  return events.filter(
    (e) =>
      (e.severity === 'error' || e.severity === 'critical') &&
      Date.parse(e.timestamp) >= recentWindowMs
  ).length;
}

export function recordDoctorEvent(
  severity: AutoDoctorSeverity,
  category: string,
  message: string,
  extra?: { streamId?: string; httpCode?: number }
) {
  const cleanMsg = message.trim();
  if (!cleanMsg) return;

  // Avoid spamming identical consecutive events within 10s
  const latest = events[0];
  if (
    latest &&
    latest.category === category &&
    latest.message === cleanMsg &&
    Date.now() - Date.parse(latest.timestamp) < 10_000
  ) {
    return;
  }

  events.unshift({
    id: `doc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    severity,
    category,
    message: cleanMsg,
    ...(extra?.streamId ? { streamId: extra.streamId } : {}),
    ...(extra?.httpCode ? { httpCode: extra.httpCode } : {}),
  });

  if (events.length > MAX_EVENTS) {
    events.length = MAX_EVENTS;
  }

  if (
    autoDiagnoseEnabled &&
    (severity === 'error' || severity === 'critical') &&
    !diagnosing &&
    Date.now() - lastAiDiagnosisAtMs >= AUTO_DIAGNOSE_COOLDOWN_MS &&
    contextProvider
  ) {
    void triggerBackgroundAutoDiagnosis();
  }
}

async function triggerBackgroundAutoDiagnosis() {
  if (!contextProvider || diagnosing) return;
  try {
    const ctx = await contextProvider();
    await runAutoDoctorDiagnosis(ctx, true);
  } catch {
    // Non-fatal background supervisor cycle
  }
}

export function setAutoDiagnoseEnabled(enabled: boolean) {
  autoDiagnoseEnabled = enabled;
  if (lastReport) {
    lastReport = { ...lastReport, autoDiagnoseEnabled };
  }
}

export function clearDoctorEvents() {
  events.length = 0;
  lastReport = null;
}

function buildDeterministicReport(ctx: {
  streams: StreamJob[];
  clips: ClipItem[];
  readiness: SystemReadiness;
}): AutoDoctorReport {
  const { streams, clips, readiness } = ctx;
  const findings: AutoDoctorFinding[] = [];
  const improvements: string[] = [];
  let score = 100;

  if (!readiness.geminiConfigured) {
    score -= 45;
    findings.push({
      title: 'No Usable Gemini API Keys Available',
      severity: 'critical',
      area: 'Gemini Key Pool',
      rootCause:
        'Neither process.env.GEMINI_API_KEY / API_KEY nor any valid custom key in System Setup is currently usable.',
      recommendation:
        'Add one or more Gemini API keys in the System Setup tab or set GEMINI_API_KEY in Settings > Secrets.',
      readyToCopyFixPrompt:
        'Ensure server/geminiKeys.ts loads GEMINI_API_KEY and API_KEY automatically and verify the Setup tab Gemini Multi-API Key Manager allows adding and testing valid keys.',
      codePatchPreview:
        `// server/geminiKeys.ts\nconst rawEnv = process.env.GEMINI_API_KEY?.trim() || process.env.API_KEY?.trim() || '';`,
    });
  } else if (readiness.geminiKeyPool.availableCount === 0 && readiness.geminiKeyPool.totalCount > 0) {
    score -= 20;
    findings.push({
      title: 'All Configured Gemini Keys Currently Rate-Limited / Cooling Down',
      severity: 'high',
      area: 'Gemini Key Pool',
      rootCause:
        'Every key in the pool hit HTTP 429 or 503 recently and is waiting for its 30–60s cooldown window to expire.',
      recommendation:
        'Add 2–3 additional Gemini API keys in System Setup for higher parallel throughput; the watchdog will automatically fall back to FFmpeg scene/audio detection when keys are cooling.',
      readyToCopyFixPrompt:
        'Increase segment cooldown resilience and confirm FFmpeg audio-peak/scene-change fallback runs cleanly whenever all Gemini API keys are cooling down.',
      codePatchPreview:
        `// server/pipeline.ts\nconst fallbackMoments = await detectFallbackMomentsWithFfmpeg(analysisPath, actualDuration, formatMode);`,
    });
  }

  if (readiness.geminiKeyPool.totalCount <= 1) {
    improvements.push(
      'Add at least 2–3 Gemini API keys in System Setup so round-robin rotation eliminates 429 rate limits during 24/7 live streams.'
    );
  }

  if (!readiness.ffmpegAvailable) {
    score -= 40;
    findings.push({
      title: 'FFmpeg Binary Missing on Host',
      severity: 'critical',
      area: 'Media Engine',
      rootCause: 'The system ffmpeg command could not be executed.',
      recommendation: 'Install FFmpeg on the container/host environment so proxy transcoding and clip rendering work.',
      readyToCopyFixPrompt:
        'Verify FFmpeg installation in the runtime container and ensure /api/snapshot reports ffmpegAvailable: true.',
      codePatchPreview: `apt-get update && apt-get install -y ffmpeg`,
    });
  }

  if (!readiness.ytDlpAvailable) {
    improvements.push(
      'Optional: Install yt-dlp on the server host as an extra backup stream extractor alongside @distube/ytdl-core.'
    );
  }

  if (readiness.geminiModels.quarantinedModels.length > 0) {
    score -= 10;
    const quarantinedNames = readiness.geminiModels.quarantinedModels
      .map((m) => m.modelId)
      .join(', ');
    findings.push({
      title: `Deprecated/404 Model(s) Auto-Quarantined (${quarantinedNames})`,
      severity: 'medium',
      area: 'Model Discovery',
      rootCause: `Model(s) [${quarantinedNames}] returned HTTP 404 or deprecated errors and were automatically quarantined for 30 minutes.`,
      recommendation: `Traffic automatically shifted to discovered models: ${readiness.geminiModels.activeModels.join(', ')}.`,
      readyToCopyFixPrompt:
        `Remove deprecated model IDs (${quarantinedNames}) from static defaults and rely on discoverGeminiModels() active list (${readiness.geminiModels.activeModels.slice(0, 2).join(', ')}).`,
      codePatchPreview:
        `// server/geminiModels.ts\nconst active = getActiveCandidateModels(); // ${readiness.geminiModels.activeModels.join(', ')}`,
    });
  }

  if (readiness.youtubeAutoUpload.tokenExpired) {
    score -= 15;
    findings.push({
      title: 'YouTube OAuth Access Token Expired',
      severity: 'high',
      area: 'YouTube Auto-Upload',
      rootCause: 'Google OAuth access token expired (short-lived 1-hour token) so automatic uploads are paused.',
      recommendation: 'Re-authenticate your YouTube channel in System Setup via Sign in with Google.',
      readyToCopyFixPrompt:
        'Prompt the user cleanly to refresh Google OAuth in System Setup when youtubeAutoUpload.tokenExpired is true and resume queued uploads automatically upon reconnect.',
      codePatchPreview:
        `// server.ts\nresumePendingYouTubeUploads();`,
    });
  }

  const failedClips = clips.filter((c) => c.status === 'failed');
  if (failedClips.length > 0) {
    score -= Math.min(20, failedClips.length * 5);
    const sample = failedClips[0];
    findings.push({
      title: `${failedClips.length} Clip Render Job(s) Failed`,
      severity: 'high',
      area: 'FFmpeg Render Queue',
      rootCause: sample.errorMessage || 'FFmpeg clip rendering or subtitle burn-in failed.',
      recommendation:
        'Inspect the failed clip error in Shorts Gallery and use Retry, or verify the source stream chunk still exists.',
      readyToCopyFixPrompt:
        `Fix FFmpeg clip rendering failure "${sample.errorMessage || 'unknown error'}" in server/pipeline.ts renderClipWithBrandingAndCaptions() and verify subtitle path escaping.`,
      codePatchPreview:
        `// server/pipeline.ts\nawait renderClipWithBrandingAndCaptions({ ... });`,
    });
  }

  const failedUploads = clips.filter((c) => c.youtubeUploadStatus === 'upload_failed');
  if (failedUploads.length > 0) {
    score -= Math.min(15, failedUploads.length * 5);
    const sample = failedUploads[0];
    findings.push({
      title: `${failedUploads.length} YouTube Upload(s) Failed`,
      severity: 'medium',
      area: 'YouTube Data API',
      rootCause: sample.youtubeUploadError || 'YouTube upload rejected or quota exceeded.',
      recommendation:
        'Connect additional YouTube API slots in System Setup for automatic quota failover, or retry the upload from Shorts Gallery.',
      readyToCopyFixPrompt:
        `Handle YouTube Data API upload error "${sample.youtubeUploadError || 'quota/auth'}" in server/youtube.ts with multi-slot failover.`,
      codePatchPreview:
        `// server/youtube.ts\n// Add backup YouTube OAuth slot in Setup tab for automatic quota rotation.`,
    });
  }

  const recentErrors = events.filter((e) => e.severity === 'error' || e.severity === 'critical');
  if (recentErrors.length > 0 && findings.length === 0) {
    score -= Math.min(25, recentErrors.length * 5);
    const latest = recentErrors[0];
    findings.push({
      title: `Recent Pipeline Alert (${latest.category})`,
      severity: latest.severity === 'critical' ? 'critical' : 'medium',
      area: latest.category,
      rootCause: latest.message,
      recommendation:
        'Monitor auto-recovery logs; the self-healing watchdog continues processing upcoming segments automatically.',
      readyToCopyFixPrompt:
        `Investigate and harden "${latest.category}" error in server/pipeline.ts: ${latest.message}`,
      codePatchPreview: `// Event logged at ${latest.timestamp}\n// [${latest.category}] ${latest.message}`,
    });
  }

  const activeStreams = streams.filter((s) => s.status === 'monitoring');
  if (
    activeStreams.length > 0 &&
    !readiness.youtubeAutoUpload.autoUploadEnabled &&
    !readiness.zernio?.autoUploadEnabled
  ) {
    improvements.push(
      'Auto-Upload is currently OFF. Enable Auto-Upload on YouTube or Zernio in System Setup to publish finished clips automatically.'
    );
  }
  if (!readiness.youtubeCookieConfigured) {
    improvements.push(
      'Set YOUTUBE_COOKIE in Settings > Secrets if you monitor age-restricted or member-only YouTube live streams.'
    );
  }

  const clampedScore = Math.max(0, Math.min(100, score));
  const overallHealth: AutoDoctorReport['overallHealth'] =
    clampedScore >= 80 ? 'healthy' : clampedScore >= 50 ? 'degraded' : 'critical';

  const summary =
    findings.length === 0
      ? `All core systems are healthy (${readiness.geminiKeyPool.availableCount} Gemini keys ready, active models: ${readiness.geminiModels.activeModels.slice(0, 2).join(', ')}). Watchdog and self-healing rotation are standing by.`
      : `Detected ${findings.length} operational item(s) across the pipeline (Health Score: ${clampedScore}/100). Self-healing rotation and watchdog fallbacks remain active.`;

  return {
    healthScore: clampedScore,
    overallHealth,
    summary,
    generatedAt: new Date().toISOString(),
    aiPowered: false,
    autoDiagnoseEnabled,
    diagnosing,
    rootCauses: findings,
    missingImprovements: improvements,
    recentEvents: [...events],
  };
}

export function getLatestAutoDoctorSnapshot(ctx: {
  streams: StreamJob[];
  clips: ClipItem[];
  readiness: SystemReadiness;
}): AutoDoctorReport {
  if (lastReport) {
    return {
      ...lastReport,
      autoDiagnoseEnabled,
      diagnosing,
      recentEvents: [...events],
    };
  }
  return buildDeterministicReport(ctx);
}

export async function runAutoDoctorDiagnosis(
  ctx: {
    streams: StreamJob[];
    clips: ClipItem[];
    readiness: SystemReadiness;
  },
  isBackground = false
): Promise<AutoDoctorReport> {
  const baseline = buildDeterministicReport(ctx);
  if (diagnosing) {
    return getLatestAutoDoctorSnapshot(ctx);
  }

  const selectedKey = acquireGeminiKey();
  if (!selectedKey) {
    lastReport = baseline;
    return baseline;
  }

  diagnosing = true;
  if (!isBackground) {
    lastAiDiagnosisAtMs = Date.now();
  }

  try {
    const ai = createGeminiClientForKey(selectedKey.apiKey);
    const recentStreamLogs = ctx.streams.slice(0, 3).map((s) => ({
      id: s.id,
      label: s.label,
      status: s.status,
      formatMode: s.formatMode,
      chunksProcessed: s.chunksProcessed,
      momentsDetected: s.momentsDetected,
      currentStage: s.currentStage,
      errorMessage: s.errorMessage,
      recentLogs: s.logs.slice(-12),
    }));

    const diagnosticPayload = {
      healthBaselineScore: baseline.healthScore,
      readiness: {
        geminiConfigured: ctx.readiness.geminiConfigured,
        keyPool: ctx.readiness.geminiKeyPool.keys.map((k) => ({
          label: k.label,
          status: k.status,
          totalRequests: k.totalRequests,
          totalErrors: k.totalErrors,
          lastError: k.lastError,
        })),
        models: ctx.readiness.geminiModels,
        ffmpegAvailable: ctx.readiness.ffmpegAvailable,
        ffprobeAvailable: ctx.readiness.ffprobeAvailable,
        ytDlpAvailable: ctx.readiness.ytDlpAvailable,
        youtubeConnected: ctx.readiness.youtubeAutoUpload.connected,
        youtubeAutoUploadEnabled: ctx.readiness.youtubeAutoUpload.autoUploadEnabled,
        youtubeTokenExpired: ctx.readiness.youtubeAutoUpload.tokenExpired,
        zernioConnected: Boolean(ctx.readiness.zernio?.connected),
        zernioAutoUploadEnabled: Boolean(ctx.readiness.zernio?.autoUploadEnabled),
        zernioAccountCount: ctx.readiness.zernio?.accounts?.length ?? 0,
      },
      recentStreams: recentStreamLogs,
      failedClips: ctx.clips
        .filter((c) => c.status === 'failed' || c.youtubeUploadStatus === 'upload_failed')
        .slice(0, 5)
        .map((c) => ({
          id: c.id,
          title: c.title,
          status: c.status,
          errorMessage: c.errorMessage,
          youtubeUploadStatus: c.youtubeUploadStatus,
          youtubeUploadError: c.youtubeUploadError,
        })),
      recentEvents: events.slice(0, 25),
    };

    const prompt = [
      `You are the built-in "AI Auto-Doctor" supervisor for a Node.js + Express + FFmpeg + React live stream AI clipper ("Rafew X GTA VI Clip AI").`,
      `Analyze the live system telemetry below (stream logs, Gemini key rotation pool, discovered/quarantined models, failed clips, and runtime events).`,
      `Produce a concise, highly technical root-cause diagnosis:`,
      `- Identify real bottlenecks, configuration gaps, API quota/404/503 issues, or FFmpeg/YouTube errors.`,
      `- If everything looks healthy, report zero critical failures and give practical performance/reliability improvements.`,
      `- For each rootCause finding, provide a "readyToCopyFixPrompt" (a concise 1-click prompt a developer can paste to fix the exact issue) and a short "codePatchPreview" snippet showing the recommended config/code fix.`,
      `\nTelemetry JSON:\n${JSON.stringify(diagnosticPayload, null, 2)}`,
    ].join('\n');

    const candidates = getActiveCandidateModels();
    let parsed: {
      overallHealth?: 'healthy' | 'degraded' | 'critical';
      summary?: string;
      rootCauses?: AutoDoctorFinding[];
      missingImprovements?: string[];
    } | null = null;
    let modelUsed: string | undefined;

    for (const model of candidates.slice(0, 4)) {
      try {
        const supportsThinkingLevel =
          model.startsWith('gemini-3') || model.startsWith('gemini-4');

        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            abortSignal: AbortSignal.timeout(25_000),
            ...(supportsThinkingLevel && !model.includes('flash-lite')
              ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
              : {}),
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                overallHealth: {
                  type: Type.STRING,
                  description: 'One of: healthy, degraded, critical',
                },
                summary: {
                  type: Type.STRING,
                  description: 'Concise 1-2 sentence diagnosis summary.',
                },
                rootCauses: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      title: { type: Type.STRING },
                      severity: {
                        type: Type.STRING,
                        description: 'One of: low, medium, high, critical',
                      },
                      area: { type: Type.STRING },
                      rootCause: { type: Type.STRING },
                      recommendation: { type: Type.STRING },
                      readyToCopyFixPrompt: { type: Type.STRING },
                      codePatchPreview: { type: Type.STRING },
                    },
                    required: [
                      'title',
                      'severity',
                      'area',
                      'rootCause',
                      'recommendation',
                      'readyToCopyFixPrompt',
                      'codePatchPreview',
                    ],
                  },
                },
                missingImprovements: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
              },
              required: ['overallHealth', 'summary', 'rootCauses', 'missingImprovements'],
            },
          },
        });

        const txt = (response.text ?? '').trim();
        if (txt) {
          parsed = JSON.parse(txt);
          modelUsed = model;
          markKeySuccess(selectedKey.id);
          lastAiDiagnosisAtMs = Date.now();
          break;
        }
      } catch (err) {
        const msg = formatSafeGeminiError(err);
        if (isInvalidKeyError(err)) {
          markKeyInvalid(selectedKey.id, msg);
          break;
        }
        if (isModelNotFoundError(err)) {
          quarantineModel(model, msg);
          void discoverGeminiModels(true);
          continue;
        }
        if (isRateLimitError(err) || isOverloadError(err)) {
          markKeyRateLimited(selectedKey.id, msg, computeCooldownMs(err));
          continue;
        }
      }
    }

    if (parsed && parsed.summary) {
      const normalizedHealth =
        parsed.overallHealth === 'critical' ||
        parsed.overallHealth === 'degraded' ||
        parsed.overallHealth === 'healthy'
          ? parsed.overallHealth
          : baseline.overallHealth;

      lastReport = {
        healthScore: baseline.healthScore,
        overallHealth: normalizedHealth,
        summary: parsed.summary,
        generatedAt: new Date().toISOString(),
        aiPowered: true,
        modelUsed,
        autoDiagnoseEnabled,
        diagnosing: false,
        rootCauses: Array.isArray(parsed.rootCauses) && parsed.rootCauses.length > 0
          ? parsed.rootCauses
          : baseline.rootCauses,
        missingImprovements:
          Array.isArray(parsed.missingImprovements) && parsed.missingImprovements.length > 0
            ? parsed.missingImprovements
            : baseline.missingImprovements,
        recentEvents: [...events],
      };
      return lastReport;
    }

    lastReport = baseline;
    return baseline;
  } finally {
    diagnosing = false;
    releaseGeminiKey(selectedKey.id);
  }
}
