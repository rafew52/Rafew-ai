import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';
import {
  clearAllActionLogs,
  getAllActionLogs,
  recordActionLog,
} from './server/actionLog.ts';
import { isGeminiConfigured } from './server/gemini.ts';
import { getActiveAiProvider, getAiSettings, updateAiSettings } from './server/aiRouter.ts';
import {
  addUserClaudeKey,
  deleteUserClaudeKey,
  getClaudeKeyPoolSummary,
} from './server/claudeKeys.ts';
import {
  addGeminiKeys,
  deleteGeminiKey,
  getGeminiKeyPoolSummary,
  revealUserGeminiKey,
  testAllGeminiKeys,
  testGeminiKey,
} from './server/geminiKeys.ts';
import {
  discoverGeminiModels,
  getActiveCandidateModels,
  getModelRegistryStatus,
} from './server/geminiModels.ts';
import {
  clearDoctorEvents,
  getLatestAutoDoctorSnapshot,
  recordDoctorEvent,
  runAutoDoctorDiagnosis,
  setAutoDiagnoseEnabled,
} from './server/autoDoctor.ts';
import {
  deleteClipById,
  getAllClips,
  getAllStreams,
  getClipFilePath,
  getSystemReadiness,
  initPipelineStorage,
  queueClipYouTubeUpload,
  queueClipZernioPublish,
  regenerateClipThumbnail,
  removeStreamJob,
  resumePendingYouTubeUploads,
  resumePendingZernioPublishes,
  retryClipJob,
  sendClipToThirdPartyExport,
  startStreamJob,
  stopStreamJob,
  updateClipMetadata,
} from './server/pipeline.ts';
import {
  getThirdPartyExportSettings,
  testThirdPartyWebhook,
  updateThirdPartyExportSettings,
} from './server/thirdPartyExport.ts';
import {
  connectZernioWithApiKey,
  disconnectZernio,
  getZernioSettings,
  hasActiveZernioAuth,
  initiateZernioDeviceAuth,
  pollZernioDeviceAuth,
  refreshZernioAccounts,
  updateZernioSettings,
} from './server/zernio.ts';
import {
  connectYouTubeWithToken,
  disconnectYouTube,
  getYouTubeSettings,
  hasActiveYouTubeToken,
  updateYouTubeSettings,
} from './server/youtube.ts';
import {
  addOAuthPoolCredential,
  buildOAuthConsentUrl,
  deleteOAuthPoolCredential,
  getYouTubeOAuthPoolSummary,
  handleOAuthCallback,
  resetOAuthSlotQuota,
  testOAuthPoolSlot,
} from './server/youtubeOAuthPool.ts';
import {
  getActiveStudioSession,
  startYouTubeLiveStudio,
  stopYouTubeLiveStudio,
  triggerManualAiChatMessage,
} from './server/youtubeLiveStudio.ts';
import {
  buildIdeaStreamInstructions,
  findBestVideosForIdea,
} from './server/ideaFinder.ts';
import { isClaudeConfigured } from './server/claude.ts';
import {
  auditManualClipsBatch,
  detectAndAutoFillManualClips,
  generateManualClipMetadataBatch,
  publishManualClipToZernio,
} from './server/manualClips.ts';
import {
  ensureSiteMusicAudioFile,
  SITE_MUSIC_SOURCE_URL,
  SITE_MUSIC_TITLE,
  SITE_MUSIC_VIDEO_ID,
} from './server/siteMusic.ts';

const PORT = 3000;
const UPLOADS_DIR = path.resolve(process.cwd(), 'data', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const upload = multer({
  dest: UPLOADS_DIR,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500 MB
  },
});

initPipelineStorage();

function escapeHtmlAttr(raw: string): string {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderServerFallbackHtml(params: {
  title: string;
  message: string;
  autoRefreshSeconds?: number;
}): string {
  const refreshTag =
    params.autoRefreshSeconds && params.autoRefreshSeconds > 0
      ? `<meta http-equiv="refresh" content="${params.autoRefreshSeconds}" />`
      : '';
  return `<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${refreshTag}
    <title>${escapeHtmlAttr(params.title)}</title>
  </head>
  <body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#090B10;color:#f1f5f9;font-family:system-ui,-apple-system,sans-serif;padding:24px;">
    <div style="max-width:520px;width:100%;background:#11151F;border:1px solid #1e293b;border-radius:16px;padding:24px;">
      <h1 style="margin:0;font-size:18px;font-weight:700;color:#f8fafc;">${escapeHtmlAttr(params.title)}</h1>
      <p style="margin:10px 0 0;font-size:13px;line-height:1.55;color:#cbd5e1;">${escapeHtmlAttr(params.message)}</p>
      <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap;">
        <button type="button" onclick="window.location.reload()" style="min-height:42px;padding:0 16px;border:0;border-radius:10px;background:#ea580c;color:#fff;font-size:13px;font-weight:600;cursor:pointer;">Reload Preview</button>
      </div>
    </div>
  </body>
</html>`;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  let viteMiddlewareReady = process.env.NODE_ENV === 'production';
  let viteInitError: string | null = null;

  app.get(['/api/health', '/healthz'], (_req, res) => {
    res.status(200).json({
      ok: true,
      status: viteInitError ? 'degraded' : viteMiddlewareReady ? 'ready' : 'warming',
      viteReady: viteMiddlewareReady,
      viteError: viteInitError || undefined,
      port: PORT,
      timestamp: new Date().toISOString(),
    });
  });

  // Live processing dashboard snapshot
  app.get('/api/snapshot', async (_req, res) => {
    try {
      const readiness = await getSystemReadiness();
      res.json({
        streams: getAllStreams(),
        clips: getAllClips(),
        readiness,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load workspace snapshot.';
      res.status(500).json({ error: message });
    }
  });

  // Start authorized URL stream monitor
  app.post('/api/streams/start', (req, res) => {
    try {
      const {
        url,
        label,
        segmentSeconds = 120,
        formatMode = 'short',
        aspectMode = 'portrait',
        brandingEnabled = true,
        watermarkPosition = 'auto',
        additionalInstructions,
        clipCount,
        languagePreference,
        categories,
        authorizedConfirmed = false,
      } = req.body ?? {};

      if (!authorizedConfirmed) {
        return res.status(400).json({
          error:
            'Please confirm that you own or are authorized to clip this stream footage.',
        });
      }

      if (!url || typeof url !== 'string' || !url.trim()) {
        return res.status(400).json({ error: 'Authorized stream URL is required.' });
      }

      const trimmedUrl = url.trim();
      if (!/^(https?|rtmps?|rtsps?):\/\//i.test(trimmedUrl)) {
        return res.status(400).json({
          error:
            'Enter a valid stream URL starting with http://, https://, rtmp://, or rtsp://.',
        });
      }

      if (!isGeminiConfigured()) {
        return res.status(400).json({
          error:
            'No usable Gemini API key is configured. Add Gemini API key(s) in System Setup or set GEMINI_API_KEY in Settings > Secrets.',
        });
      }

      const parsedClipCount =
        typeof clipCount === 'number' && Number.isFinite(clipCount) && clipCount >= 1
          ? Math.min(20, Math.floor(clipCount))
          : undefined;
      const cleanCategories = Array.isArray(categories)
        ? categories.filter((c): c is string => typeof c === 'string' && Boolean(c.trim())).slice(0, 8)
        : [];
      const resolvedLang =
        languagePreference === 'bengali' ||
        languagePreference === 'banglish' ||
        languagePreference === 'english' ||
        languagePreference === 'any'
          ? languagePreference
          : 'auto';

      const job = startStreamJob({
        label: typeof label === 'string' && label.trim() ? label.trim() : trimmedUrl,
        sourceUrl: trimmedUrl,
        sourceType: 'url',
        formatMode: formatMode === 'long' ? 'long' : 'short',
        aspectMode: aspectMode === 'landscape' ? 'landscape' : 'portrait',
        brandingEnabled: brandingEnabled !== false,
        watermarkPosition,
        additionalInstructions:
          typeof additionalInstructions === 'string' ? additionalInstructions : undefined,
        clipCount: parsedClipCount,
        requirementSpec: {
          topicIdea: typeof label === 'string' && label.trim() ? label.trim() : trimmedUrl,
          lockedCategories: cleanCategories,
          languagePreference: resolvedLang,
          ...(parsedClipCount ? { clipCount: parsedClipCount } : {}),
          formatMode: formatMode === 'long' ? 'long' : 'short',
          aspectMode: formatMode === 'long' && aspectMode === 'landscape' ? 'landscape' : 'portrait',
          requiredTags: ['#BD'],
        },
        authorizedConfirmed: true,
        segmentSeconds: Number(segmentSeconds) || (formatMode === 'long' ? 300 : 120),
      });

      res.json({ status: 'started', stream: job });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start stream monitor.';
      res.status(500).json({ error: message });
    }
  });

  // Chunked upload session store (avoids 32 MB single-request proxy limit on mobile/web)
  const pendingUploads = new Map<
    string,
    { filePath: string; originalName: string; totalSize: number; receivedBytes: number }
  >();

  app.post('/api/streams/upload/init', (req, res) => {
    try {
      if (!isGeminiConfigured()) {
        return res.status(400).json({
          error:
            'No usable Gemini API key is configured. Add Gemini API key(s) in System Setup or set GEMINI_API_KEY in Settings > Secrets.',
        });
      }

      const { fileName, fileSize, authorizedConfirmed } = req.body ?? {};
      if (!authorizedConfirmed) {
        return res.status(400).json({
          error:
            'Please confirm that you own or are authorized to process this video footage.',
        });
      }

      if (!fileName || typeof fileName !== 'string') {
        return res.status(400).json({ error: 'Video file name is required.' });
      }

      const sizeNum = Number(fileSize) || 0;
      if (sizeNum <= 0 || sizeNum > 500 * 1024 * 1024) {
        return res.status(400).json({
          error: 'Video file must be between 1 byte and 500 MB.',
        });
      }

      const uploadId = `upl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const ext = path.extname(fileName).toLowerCase() || '.mp4';
      const safeExt = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.mp4';
      const filePath = path.join(UPLOADS_DIR, `${uploadId}${safeExt}`);

      fs.writeFileSync(filePath, Buffer.alloc(0));
      pendingUploads.set(uploadId, {
        filePath,
        originalName: fileName,
        totalSize: sizeNum,
        receivedBytes: 0,
      });

      res.json({ uploadId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to initialize upload.';
      res.status(500).json({ error: message });
    }
  });

  app.post(
    '/api/streams/upload/chunk/:uploadId',
    express.raw({ type: 'application/octet-stream', limit: '10mb' }),
    (req, res) => {
      try {
        const session = pendingUploads.get(req.params.uploadId);
        if (!session) {
          return res.status(404).json({ error: 'Upload session not found or expired.' });
        }

        const chunkBuffer = req.body as Buffer;
        if (!Buffer.isBuffer(chunkBuffer) || chunkBuffer.length === 0) {
          return res.status(400).json({ error: 'Empty chunk payload.' });
        }

        fs.appendFileSync(session.filePath, chunkBuffer);
        session.receivedBytes += chunkBuffer.length;

        res.json({
          receivedBytes: session.receivedBytes,
          totalSize: session.totalSize,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to write upload chunk.';
        res.status(500).json({ error: message });
      }
    }
  );

  app.post('/api/streams/upload/complete/:uploadId', (req, res) => {
    try {
      const uploadId = req.params.uploadId;
      const session = pendingUploads.get(uploadId);
      if (!session) {
        return res.status(404).json({ error: 'Upload session not found.' });
      }
      pendingUploads.delete(uploadId);

      if (!fs.existsSync(session.filePath) || session.receivedBytes === 0) {
        return res.status(400).json({ error: 'Uploaded video file is empty.' });
      }

      const {
        label,
        segmentSeconds = 45,
        formatMode = 'short',
        aspectMode = 'portrait',
        brandingEnabled = true,
        watermarkPosition = 'auto',
        additionalInstructions,
        clipCount,
        languagePreference,
        categories,
      } = req.body ?? {};

      const parsedClipCount =
        typeof clipCount === 'number' && Number.isFinite(clipCount) && clipCount >= 1
          ? Math.min(20, Math.floor(clipCount))
          : undefined;
      const cleanCategories = Array.isArray(categories)
        ? categories.filter((c): c is string => typeof c === 'string' && Boolean(c.trim())).slice(0, 8)
        : [];
      const resolvedLang =
        languagePreference === 'bengali' ||
        languagePreference === 'banglish' ||
        languagePreference === 'english' ||
        languagePreference === 'any'
          ? languagePreference
          : 'auto';

      const job = startStreamJob({
        label:
          typeof label === 'string' && label.trim()
            ? label.trim()
            : session.originalName,
        sourceUrl: session.originalName,
        sourceType: 'upload',
        formatMode: formatMode === 'long' ? 'long' : 'short',
        aspectMode: aspectMode === 'landscape' ? 'landscape' : 'portrait',
        brandingEnabled: brandingEnabled !== false,
        watermarkPosition,
        additionalInstructions:
          typeof additionalInstructions === 'string' ? additionalInstructions : undefined,
        clipCount: parsedClipCount,
        requirementSpec: {
          topicIdea: typeof label === 'string' && label.trim() ? label.trim() : session.originalName,
          lockedCategories: cleanCategories,
          languagePreference: resolvedLang,
          ...(parsedClipCount ? { clipCount: parsedClipCount } : {}),
          formatMode: formatMode === 'long' ? 'long' : 'short',
          aspectMode: formatMode === 'long' && aspectMode === 'landscape' ? 'landscape' : 'portrait',
          requiredTags: ['#BD'],
        },
        authorizedConfirmed: true,
        segmentSeconds: Number(segmentSeconds) || (formatMode === 'long' ? 300 : 45),
        localFilePath: session.filePath,
      });

      res.json({ status: 'started', stream: job });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to start uploaded video job.';
      res.status(500).json({ error: message });
    }
  });

  // Single-request upload fallback for smaller files
  app.post('/api/streams/upload', upload.single('video'), (req, res) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: 'Video file is required.' });
      }

      if (req.body?.authorizedConfirmed !== 'true') {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        return res.status(400).json({
          error: 'Please confirm that you are authorized to process this footage.',
        });
      }

      if (!isGeminiConfigured()) {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        return res.status(400).json({
          error:
            'No usable Gemini API key is configured. Add Gemini API key(s) in System Setup or set GEMINI_API_KEY in Settings > Secrets.',
        });
      }

      const ext = path.extname(file.originalname || '').toLowerCase() || '.mp4';
      const namedPath = `${file.path}${ext}`;
      fs.renameSync(file.path, namedPath);

      const label =
        typeof req.body?.label === 'string' && req.body.label.trim()
          ? req.body.label.trim()
          : file.originalname || 'Authorized Recording';
      const formatMode = req.body?.formatMode === 'long' ? 'long' : 'short';
      const aspectMode = req.body?.aspectMode === 'landscape' ? 'landscape' : 'portrait';
      const brandingEnabled = req.body?.brandingEnabled !== 'false';
      const watermarkPosition = req.body?.watermarkPosition ?? 'auto';
      const additionalInstructions =
        typeof req.body?.additionalInstructions === 'string'
          ? req.body.additionalInstructions
          : undefined;
      const segmentSeconds = Number(req.body?.segmentSeconds) || (formatMode === 'long' ? 300 : 45);

      const job = startStreamJob({
        label,
        sourceUrl: file.originalname || 'Uploaded File',
        sourceType: 'upload',
        formatMode,
        aspectMode,
        brandingEnabled,
        watermarkPosition,
        additionalInstructions,
        authorizedConfirmed: true,
        segmentSeconds,
        localFilePath: namedPath,
      });

      res.json({ status: 'started', stream: job });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to process uploaded video.';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/streams/:id/stop', (req, res) => {
    const ok = stopStreamJob(req.params.id);
    if (!ok) {
      return res.status(404).json({ error: 'Stream monitor not found.' });
    }
    res.json({ status: 'stopping' });
  });

  app.delete('/api/streams/:id', (req, res) => {
    const ok = removeStreamJob(req.params.id);
    if (!ok) {
      return res.status(404).json({ error: 'Stream monitor not found.' });
    }
    res.json({ status: 'deleted' });
  });

  // Serve MP4 clips, thumbnails, and SRT subtitle files (with ?download=1 for Android Save)
  app.get('/api/media/clips/:streamId/:filename', (req, res) => {
    const filePath = getClipFilePath(req.params.streamId, req.params.filename);
    if (!filePath) {
      return res.status(404).json({ error: 'Media file not found.' });
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType =
      ext === '.mp4'
        ? 'video/mp4'
        : ext === '.srt'
        ? 'application/x-subrip; charset=utf-8'
        : ext === '.jpg' || ext === '.jpeg'
        ? 'image/jpeg'
        : 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');

    if (req.query.download === '1') {
      const requested =
        typeof req.query.name === 'string' && req.query.name.trim()
          ? req.query.name.trim().replace(/[^a-zA-Z0-9._-]/g, '_')
          : path.basename(filePath);
      const downloadName = requested.toLowerCase().endsWith(ext)
        ? requested
        : `${requested}${ext}`;
      const stat = fs.statSync(filePath);
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
      res.sendFile(filePath);
      return;
    }

    res.sendFile(filePath);
  });

  app.patch('/api/clips/:id', (req, res) => {
    const updated = updateClipMetadata(req.params.id, req.body ?? {});
    if (!updated) {
      return res.status(404).json({ error: 'Clip not found.' });
    }
    res.json({ clip: updated });
  });

  app.post('/api/clips/:id/retry', (req, res) => {
    const retried = retryClipJob(req.params.id);
    if (!retried) {
      return res.status(404).json({ error: 'Clip not found.' });
    }
    res.json({ clip: retried });
  });

  app.post('/api/clips/:id/regenerate-thumbnail', async (req, res) => {
    try {
      const updated = await regenerateClipThumbnail(req.params.id);
      if (!updated) {
        return res.status(404).json({ error: 'Clip not found.' });
      }
      res.json({ clip: updated });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to regenerate clip thumbnail.';
      res.status(400).json({ error: message });
    }
  });

  app.delete('/api/clips/:id', (req, res) => {
    const ok = deleteClipById(req.params.id);
    if (!ok) {
      return res.status(404).json({ error: 'Clip not found.' });
    }
    res.json({ status: 'deleted' });
  });

  // Gemini Multi-API Key Manager & Automatic Rotation endpoints
  app.get('/api/gemini/keys', (_req, res) => {
    res.json({ geminiKeyPool: getGeminiKeyPoolSummary() });
  });

  app.post('/api/gemini/keys', (req, res) => {
    try {
      const { keys, label } = req.body ?? {};
      if (typeof keys !== 'string' || !keys.trim()) {
        return res.status(400).json({
          error: 'Paste at least one Gemini API key (single or multiple separated by line/comma).',
        });
      }

      const result = addGeminiKeys(keys, typeof label === 'string' ? label : undefined);
      if (result.addedCount === 0) {
        if (result.cappedCount > 0) {
          return res.status(400).json({
            error: `Maximum limit of ${result.summary.maxUserKeys} custom API keys reached. Delete an unused key first.`,
            ...result,
          });
        }
        if (result.invalidTokens > 0) {
          return res.status(400).json({
            error: 'No valid Gemini API keys found. Each key must be at least 16 characters with no spaces.',
            ...result,
          });
        }
        return res.status(400).json({
          error: 'Those API key(s) are already in your key pool.',
          ...result,
        });
      }

      void discoverGeminiModels();
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add Gemini API key(s).';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/gemini/keys/test-all', async (_req, res) => {
    try {
      const models = await discoverGeminiModels();
      const results = await testAllGeminiKeys(models);
      res.json({
        results,
        geminiKeyPool: getGeminiKeyPoolSummary(),
        geminiModels: getModelRegistryStatus(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to test Gemini API keys.';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/gemini/keys/:id/test', async (req, res) => {
    try {
      const models = getActiveCandidateModels();
      const result = await testGeminiKey(req.params.id, models);
      res.json({
        result,
        geminiKeyPool: getGeminiKeyPoolSummary(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to test Gemini API key.';
      res.status(404).json({ error: message });
    }
  });

  app.get('/api/gemini/keys/:id/reveal', (req, res) => {
    const result = revealUserGeminiKey(req.params.id);
    if (!result.found) {
      return res.status(404).json({ error: 'Gemini API key not found.' });
    }
    if (result.forbidden) {
      return res.status(403).json({
        error: 'Environment secret keys cannot be revealed in the UI.',
      });
    }
    res.json({ id: req.params.id, key: result.key });
  });

  app.delete('/api/gemini/keys/:id', (req, res) => {
    const result = deleteGeminiKey(req.params.id);
    if (!result.deleted) {
      return res.status(404).json({ error: 'Custom Gemini API key not found.' });
    }
    res.json({ geminiKeyPool: result.summary });
  });

  // Dynamic Gemini Model Discovery endpoints
  app.get('/api/gemini/models', (_req, res) => {
    res.json({ geminiModels: getModelRegistryStatus() });
  });

  app.post('/api/gemini/models/discover', async (_req, res) => {
    try {
      await discoverGeminiModels(true);
      res.json({ geminiModels: getModelRegistryStatus() });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Model discovery failed.';
      res.status(500).json({ error: message });
    }
  });

  // AI Provider Selector (Claude / Gemini / Auto) & Anthropic Claude Key Pool endpoints
  app.get('/api/ai/provider', (_req, res) => {
    res.json({
      provider: getAiSettings().provider,
      activeAiProvider: getActiveAiProvider(),
      claudeKeyPool: getClaudeKeyPoolSummary(),
    });
  });

  app.post('/api/ai/provider', (req, res) => {
    const { provider } = req.body ?? {};
    if (provider !== 'claude' && provider !== 'gemini' && provider !== 'auto') {
      return res.status(400).json({ error: 'Invalid AI provider choice.' });
    }
    const updated = updateAiSettings({ provider });
    res.json({
      provider: updated.provider,
      activeAiProvider: getActiveAiProvider(),
      claudeKeyPool: getClaudeKeyPoolSummary(),
    });
  });

  app.get('/api/claude/keys', (_req, res) => {
    res.json({ claudeKeyPool: getClaudeKeyPoolSummary() });
  });

  app.post('/api/claude/keys', (req, res) => {
    try {
      const { apiKey, label } = req.body ?? {};
      if (typeof apiKey !== 'string' || !apiKey.trim()) {
        return res.status(400).json({ error: 'Anthropic Claude API key is required.' });
      }
      addUserClaudeKey(apiKey, typeof label === 'string' ? label : undefined);
      res.json({
        claudeKeyPool: getClaudeKeyPoolSummary(),
        activeAiProvider: getActiveAiProvider(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add Claude API key.';
      res.status(400).json({ error: message });
    }
  });

  app.delete('/api/claude/keys/:id', (req, res) => {
    const deleted = deleteUserClaudeKey(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Claude API key not found.' });
    }
    res.json({
      claudeKeyPool: getClaudeKeyPoolSummary(),
      activeAiProvider: getActiveAiProvider(),
    });
  });

  // Built-in AI Auto-Doctor supervisor endpoints
  app.get('/api/doctor/report', async (_req, res) => {
    try {
      const readiness = await getSystemReadiness();
      const report = getLatestAutoDoctorSnapshot({
        streams: getAllStreams(),
        clips: getAllClips(),
        readiness,
      });
      res.json({ report });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load Auto-Doctor report.';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/doctor/diagnose', async (_req, res) => {
    try {
      const readiness = await getSystemReadiness();
      const report = await runAutoDoctorDiagnosis({
        streams: getAllStreams(),
        clips: getAllClips(),
        readiness,
      });
      res.json({ report });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI Auto-Doctor diagnosis failed.';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/doctor/settings', async (req, res) => {
    const { autoDiagnoseEnabled } = req.body ?? {};
    if (typeof autoDiagnoseEnabled === 'boolean') {
      setAutoDiagnoseEnabled(autoDiagnoseEnabled);
    }
    const readiness = await getSystemReadiness();
    const report = getLatestAutoDoctorSnapshot({
      streams: getAllStreams(),
      clips: getAllClips(),
      readiness,
    });
    res.json({ report });
  });

  app.post('/api/doctor/clear', async (_req, res) => {
    clearDoctorEvents();
    const readiness = await getSystemReadiness();
    const report = getLatestAutoDoctorSnapshot({
      streams: getAllStreams(),
      clips: getAllClips(),
      readiness,
    });
    res.json({ report });
  });

  // Official YouTube Data API v3 authorization & automatic Shorts upload endpoints
  const extractBearerToken = (req: express.Request): string | undefined => {
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
      const token = auth.slice(7).trim();
      return token || undefined;
    }
    return undefined;
  };

  app.get('/api/youtube/status', (_req, res) => {
    res.json({ youtubeAutoUpload: getYouTubeSettings() });
  });

  app.post('/api/youtube/connect', async (req, res) => {
    try {
      const token = extractBearerToken(req);
      if (!token) {
        return res.status(401).json({
          error: 'Google OAuth Bearer token is required in Authorization header.',
        });
      }
      const slotId = Number(req.query.slotId || req.body?.slotId) || 1;
      const { autoUploadEnabled, smartTimingEnabled, privacyStatus, categoryId, madeForKids } =
        req.body ?? {};
      const youtubeAutoUpload = await connectYouTubeWithToken(token, slotId, {
        ...(typeof autoUploadEnabled === 'boolean' ? { autoUploadEnabled } : {}),
        ...(typeof smartTimingEnabled === 'boolean' ? { smartTimingEnabled } : {}),
        ...(privacyStatus ? { privacyStatus } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(typeof madeForKids === 'boolean' ? { madeForKids } : {}),
      });
      resumePendingYouTubeUploads();
      res.json({ youtubeAutoUpload });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to verify YouTube channel.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/youtube/settings', async (req, res) => {
    try {
      const token = extractBearerToken(req);
      const slotId = Number(req.body?.slotId) || 1;
      const { autoUploadEnabled, smartTimingEnabled, privacyStatus, categoryId, madeForKids } =
        req.body ?? {};
      if (autoUploadEnabled === true && !token && !hasActiveYouTubeToken()) {
        return res.status(401).json({
          error: 'Sign in with Google or connect an OAuth2 project slot first to authorize YouTube Data API uploads.',
        });
      }
      const youtubeAutoUpload = token
        ? await connectYouTubeWithToken(token, slotId, {
            autoUploadEnabled,
            smartTimingEnabled,
            privacyStatus,
            categoryId,
            madeForKids,
          })
        : updateYouTubeSettings({
            autoUploadEnabled,
            smartTimingEnabled,
            privacyStatus,
            categoryId,
            madeForKids,
          });
      if (youtubeAutoUpload.autoUploadEnabled && youtubeAutoUpload.connected) {
        resumePendingYouTubeUploads();
      }
      res.json({ youtubeAutoUpload });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to update YouTube settings.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/youtube/disconnect', (req, res) => {
    const slotId = req.body?.slotId !== undefined ? Number(req.body.slotId) : undefined;
    const youtubeAutoUpload = disconnectYouTube(slotId);
    res.json({ youtubeAutoUpload });
  });

  // Multi-Project YouTube OAuth2 Credential Pool & Server OAuth Callback endpoints
  const resolveRequestOrigin = (req: express.Request): string => {
    const protoHeader = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
    const proto = protoHeader.split(',')[0].trim();
    const host = (req.headers['x-forwarded-host'] as string) || req.get('host') || `localhost:${PORT}`;
    return `${proto}://${host.split(',')[0].trim()}`;
  };

  app.get('/api/youtube/oauth-pool', (req, res) => {
    const origin = resolveRequestOrigin(req);
    res.json({ oauthPool: getYouTubeOAuthPoolSummary(origin) });
  });

  app.post('/api/youtube/oauth-pool/slots', (req, res) => {
    try {
      const { label, clientId, clientSecret, redirectUri } = req.body ?? {};
      const origin = resolveRequestOrigin(req);
      const slot = addOAuthPoolCredential({
        label: typeof label === 'string' ? label : undefined,
        clientId: typeof clientId === 'string' ? clientId : '',
        clientSecret: typeof clientSecret === 'string' ? clientSecret : '',
        redirectUri:
          typeof redirectUri === 'string' && redirectUri.trim()
            ? redirectUri.trim()
            : `${origin}/api/youtube/oauth/callback`,
      });
      res.json({
        slot,
        oauthPool: getYouTubeOAuthPoolSummary(origin),
        youtubeAutoUpload: getYouTubeSettings(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add YouTube OAuth2 credential.';
      res.status(400).json({ error: message });
    }
  });

  app.delete('/api/youtube/oauth-pool/slots/:id', (req, res) => {
    const deleted = deleteOAuthPoolCredential(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'YouTube OAuth slot not found.' });
    }
    const origin = resolveRequestOrigin(req);
    res.json({
      deleted: true,
      oauthPool: getYouTubeOAuthPoolSummary(origin),
      youtubeAutoUpload: getYouTubeSettings(),
    });
  });

  app.post('/api/youtube/oauth-pool/slots/:id/auth-url', (req, res) => {
    try {
      const origin = resolveRequestOrigin(req);
      const url = buildOAuthConsentUrl(req.params.id, origin);
      res.json({ url });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to build Google OAuth authorization URL.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/youtube/oauth-pool/slots/:id/test', async (req, res) => {
    try {
      const origin = resolveRequestOrigin(req);
      const result = await testOAuthPoolSlot(req.params.id);
      if (result.ok) {
        resumePendingYouTubeUploads();
      }
      res.json({
        result,
        oauthPool: getYouTubeOAuthPoolSummary(origin),
        youtubeAutoUpload: getYouTubeSettings(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to test YouTube OAuth slot.';
      res.status(404).json({ error: message });
    }
  });

  app.post('/api/youtube/oauth-pool/slots/:id/reset-quota', (req, res) => {
    const origin = resolveRequestOrigin(req);
    const slot = resetOAuthSlotQuota(req.params.id);
    if (!slot) {
      return res.status(404).json({ error: 'YouTube OAuth slot not found.' });
    }
    resumePendingYouTubeUploads();
    res.json({
      slot,
      oauthPool: getYouTubeOAuthPoolSummary(origin),
      youtubeAutoUpload: getYouTubeSettings(),
    });
  });

  app.get(['/api/youtube/oauth/callback', '/api/youtube/oauth/callback/'], async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const error = typeof req.query.error === 'string' ? req.query.error : undefined;

    // Handle direct visits (e.g., user tapped/opened the Redirect URI in browser, or Google returned params in #hash)
    if (!code && !state && !error) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>YouTube OAuth Redirect URI</title></head>
<body style="background:#0B0E14;color:#e2e8f0;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center;">
  <div style="max-width:440px;">
    <h2 style="margin:0 0 10px;color:#fb923c;font-size:18px;">OAuth Redirect Callback Endpoint</h2>
    <p id="msg" style="margin:0 0 18px;color:#cbd5e1;font-size:14px;line-height:1.5;">
      This callback URL receives Google&rsquo;s OAuth response automatically after you click
      <strong>Authorize</strong> inside <strong>Setup &rarr; Multi-Project OAuth2 Pool</strong>. Do not open this URL directly.
    </p>
    <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
      <a href="/" style="padding:10px 18px;border-radius:10px;background:#ea580c;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;">Open App Setup</a>
      <button id="closeBtn" onclick="window.close()" style="display:none;padding:10px 16px;border-radius:10px;border:1px solid #334155;background:#1e293b;color:#f8fafc;cursor:pointer;font-size:13px;">Close Window</button>
    </div>
  </div>
  <script>
    (function () {
      try {
        if (window.location.hash && window.location.hash.length > 1) {
          var hp = new URLSearchParams(window.location.hash.slice(1));
          if (hp.get('code') || hp.get('error')) {
            window.location.replace(window.location.pathname + '?' + hp.toString());
            return;
          }
        }
        if (window.opener) {
          document.getElementById('closeBtn').style.display = 'inline-block';
        }
      } catch (e) {}
    })();
  </script>
</body>
</html>`);
    }

    try {
      const result = await handleOAuthCallback({ code, state, error });
      resumePendingYouTubeUploads();
      const payload = JSON.stringify({
        type: 'YT_OAUTH_SUCCESS',
        slotId: result.slotId,
        label: result.label,
        channelTitle: result.channel.title,
      })
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
      const safeTitle = result.channel.title
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>YouTube OAuth Connected</title></head>
<body style="background:#0B0E14;color:#e2e8f0;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center;">
  <div style="max-width:420px;">
    <h2 style="margin:0 0 8px;color:#34d399;">YouTube OAuth Connected</h2>
    <p style="margin:0 0 18px;color:#cbd5e1;font-size:14px;line-height:1.5;">
      Authorized <strong>${safeTitle}</strong>. Your refresh token is saved and queued uploads have resumed.
    </p>
    <a href="/" style="display:inline-block;padding:10px 18px;border-radius:10px;background:#059669;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;">Return to App</a>
  </div>
  <script>
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(${payload}, '*');
        setTimeout(function () { window.close(); }, 350);
      }
    } catch (e) {}
  </script>
</body>
</html>`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Google OAuth authorization failed.';
      const payload = JSON.stringify({
        type: 'YT_OAUTH_ERROR',
        error: message,
      })
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
      const escapedMsg = message
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>YouTube OAuth Error</title></head>
<body style="background:#0B0E14;color:#f87171;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center;">
  <div style="max-width:440px;">
    <h2 style="margin:0 0 8px;">YouTube Authorization Error</h2>
    <p style="margin:0 0 18px;color:#cbd5e1;font-size:14px;line-height:1.5;">${escapedMsg}</p>
    <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
      <a href="/" style="padding:10px 18px;border-radius:10px;background:#ea580c;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;">Return to App Setup</a>
      <button onclick="window.close()" style="padding:10px 16px;border-radius:10px;border:1px solid #334155;background:#1e293b;color:#f8fafc;cursor:pointer;font-size:13px;">Close Window</button>
    </div>
  </div>
  <script>
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(${payload}, '*');
      }
    } catch (e) {}
  </script>
</body>
</html>`);
    }
  });

  // Zernio Authentication, Connected Accounts Sync & Multi-Platform Auto-Upload endpoints
  app.get('/api/zernio/status', (_req, res) => {
    res.json({ zernio: getZernioSettings() });
  });

  app.post('/api/zernio/auth/initiate', async (_req, res) => {
    try {
      const challenge = await initiateZernioDeviceAuth();
      res.json(challenge);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to initiate Zernio sign-in.';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/zernio/auth/poll', async (_req, res) => {
    try {
      const result = await pollZernioDeviceAuth();
      res.json(result);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to poll Zernio authorization.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/zernio/connect-key', async (req, res) => {
    try {
      const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey : '';
      const zernio = await connectZernioWithApiKey(apiKey);
      if (zernio.autoUploadEnabled && zernio.connected && zernio.selectedAccountIds.length > 0) {
        resumePendingZernioPublishes();
      }
      res.json({ zernio });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to connect Zernio API key.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/zernio/accounts/refresh', async (_req, res) => {
    try {
      const zernio = await refreshZernioAccounts();
      res.json({ zernio });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to refresh Zernio connected accounts.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/zernio/settings', (req, res) => {
    try {
      const { autoUploadEnabled, uploadMode, selectedAccountIds, tiktokOptions } =
        req.body ?? {};
      const zernio = updateZernioSettings({
        ...(typeof autoUploadEnabled === 'boolean' ? { autoUploadEnabled } : {}),
        ...(uploadMode ? { uploadMode } : {}),
        ...(Array.isArray(selectedAccountIds) ? { selectedAccountIds } : {}),
        ...(tiktokOptions && typeof tiktokOptions === 'object' ? { tiktokOptions } : {}),
      });
      if (zernio.autoUploadEnabled && zernio.connected && zernio.selectedAccountIds.length > 0) {
        resumePendingZernioPublishes();
      }
      res.json({ zernio });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to update Zernio settings.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/zernio/disconnect', (_req, res) => {
    const zernio = disconnectZernio();
    res.json({ zernio });
  });

  app.post('/api/clips/:id/zernio-publish', (req, res) => {
    try {
      if (!hasActiveZernioAuth()) {
        return res.status(401).json({
          error: 'Zernio is not connected. Click Sign in with Zernio first.',
        });
      }
      const accountIds = Array.isArray(req.body?.accountIds)
        ? req.body.accountIds.filter((id: unknown): id is string => typeof id === 'string')
        : undefined;
      const uploadMode =
        req.body?.uploadMode === 'draft' || req.body?.uploadMode === 'publish_now'
          ? req.body.uploadMode
          : undefined;
      const clip = queueClipZernioPublish(req.params.id, accountIds, uploadMode);
      if (!clip) {
        return res.status(404).json({ error: 'Clip not found.' });
      }
      res.json({ clip });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to queue clip for Zernio upload.';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/third-party-export/settings', (_req, res) => {
    res.json({ settings: getThirdPartyExportSettings() });
  });

  app.post('/api/third-party-export/settings', (req, res) => {
    try {
      const { webhookUrl, preferredPlatform, webhookLabel, autoSendOnComplete } = req.body ?? {};
      const settings = updateThirdPartyExportSettings({
        webhookUrl: typeof webhookUrl === 'string' ? webhookUrl : undefined,
        preferredPlatform,
        webhookLabel: typeof webhookLabel === 'string' ? webhookLabel : undefined,
        autoSendOnComplete:
          typeof autoSendOnComplete === 'boolean' ? autoSendOnComplete : undefined,
      });
      res.json({ settings });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Invalid third-party export settings.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/third-party-export/test', async (_req, res) => {
    try {
      const result = await testThirdPartyWebhook();
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Webhook test failed.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/clips/:id/third-party-export', async (req, res) => {
    try {
      const origin = resolveRequestOrigin(req);
      const clip = await sendClipToThirdPartyExport(req.params.id, origin);
      if (!clip) {
        return res.status(404).json({ error: 'Clip not found.' });
      }
      res.json({ clip });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to send clip to third-party workflow.';
      res.status(400).json({ error: message });
    }
  });



  // YouTube Live Studio & 20-min AI Chat Broadcast endpoints
  app.get('/api/youtube/live-studio', (_req, res) => {
    res.json({ session: getActiveStudioSession() });
  });

  app.post('/api/youtube/live-studio/start', async (req, res) => {
    try {
      const { sourceUrl, sourceType, streamTitle, aiAutoChatEnabled } = req.body ?? {};
      if (!sourceUrl || typeof sourceUrl !== 'string' || !sourceUrl.trim()) {
        return res.status(400).json({ error: 'Source video URL or live stream URL is required.' });
      }
      const session = await startYouTubeLiveStudio({
        sourceUrl: sourceUrl.trim(),
        sourceType,
        streamTitle,
        aiAutoChatEnabled,
      });
      res.json({ session });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start Live Studio broadcast.';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/youtube/live-studio/stop', (_req, res) => {
    stopYouTubeLiveStudio();
    res.json({ session: null });
  });

  app.post('/api/youtube/live-studio/send-chat', async (_req, res) => {
    try {
      await triggerManualAiChatMessage();
      res.json({ session: getActiveStudioSession() });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send AI chat message.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/youtube/live-studio/toggle-ai-chat', (req, res) => {
    const session = getActiveStudioSession();
    if (session) {
      session.aiAutoChatEnabled = Boolean(req.body?.aiAutoChatEnabled);
    }
    res.json({ session });
  });

  app.post('/api/clips/:id/youtube-upload', async (req, res) => {
    try {
      const headerToken = extractBearerToken(req);
      if (headerToken && !hasActiveYouTubeToken()) {
        await connectYouTubeWithToken(headerToken);
      } else if (headerToken) {
        updateYouTubeSettings({}, headerToken);
      }
      if (!hasActiveYouTubeToken()) {
        return res.status(401).json({
          error:
            'YouTube authorization is missing or all slots need re-auth. Connect an OAuth2 slot or sign in with Google in Setup.',
        });
      }
      const clip = queueClipYouTubeUpload(req.params.id);
      if (!clip) {
        return res.status(404).json({ error: 'Clip not found.' });
      }
      res.json({ clip });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to queue clip for YouTube upload.';
      res.status(400).json({ error: message });
    }
  });

  // AI Idea-to-Video Finder & Auto-Clipper routes
  app.post('/api/idea-finder/search', async (req, res) => {
    try {
      const { idea, categories, languagePreference } = req.body ?? {};
      if (typeof idea !== 'string' || !idea.trim()) {
        return res.status(400).json({ error: 'Please enter a video idea or topic.' });
      }

      const cleanCategories = Array.isArray(categories)
        ? categories
            .filter((c): c is string => typeof c === 'string')
            .map((c) => c.trim().slice(0, 40))
            .filter(Boolean)
            .slice(0, 8)
        : [];

      const lang =
        languagePreference === 'bengali' ||
        languagePreference === 'banglish' ||
        languagePreference === 'english' ||
        languagePreference === 'any'
          ? languagePreference
          : 'auto';

      const bearerToken = extractBearerToken(req);
      const result = await findBestVideosForIdea({
        idea: idea.trim().slice(0, 400),
        categories: cleanCategories,
        languagePreference: lang,
        bearerToken,
      });

      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to search YouTube for idea.';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/idea-finder/start', async (req, res) => {
    try {
      const {
        idea,
        categories,
        languagePreference,
        clipCount,
        customInstructions,
        formatMode = 'short',
        aspectMode = 'portrait',
        segmentSeconds = 120,
        brandingEnabled = true,
        authorizedConfirmed = false,
        selectedCandidate,
      } = req.body ?? {};

      if (!authorizedConfirmed) {
        return res.status(400).json({
          error:
            'Please confirm that you own or are authorized to clip and publish this footage.',
        });
      }

      if (!isGeminiConfigured()) {
        return res.status(400).json({
          error:
            'No usable Gemini API key is configured. Add Gemini API key(s) in System Setup or set GEMINI_API_KEY in Settings > Secrets.',
        });
      }

      if (typeof idea !== 'string' || !idea.trim()) {
        return res.status(400).json({ error: 'Video idea is required.' });
      }

      const cleanCategories = Array.isArray(categories)
        ? categories
            .filter((c): c is string => typeof c === 'string')
            .map((c) => c.trim().slice(0, 40))
            .filter(Boolean)
            .slice(0, 8)
        : [];

      const lang =
        languagePreference === 'bengali' ||
        languagePreference === 'banglish' ||
        languagePreference === 'english' ||
        languagePreference === 'any'
          ? languagePreference
          : 'auto';

      const parsedClipCount =
        typeof clipCount === 'number' && Number.isFinite(clipCount) && clipCount >= 1
          ? Math.min(20, Math.floor(clipCount))
          : undefined;

      let chosen = selectedCandidate &&
        typeof selectedCandidate === 'object' &&
        typeof selectedCandidate.url === 'string'
        ? selectedCandidate
        : null;

      let searchResult = null;

      if (chosen) {
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(chosen.url);
        } catch {
          return res.status(400).json({ error: 'Selected YouTube URL is invalid.' });
        }
        const host = parsedUrl.hostname.toLowerCase();
        if (
          parsedUrl.protocol !== 'https:' ||
          (host !== 'www.youtube.com' && host !== 'youtube.com' && host !== 'youtu.be')
        ) {
          return res.status(400).json({
            error: 'Selected video URL must be a valid https://youtube.com or https://youtu.be URL.',
          });
        }
      } else {
        const bearerToken = extractBearerToken(req);
        searchResult = await findBestVideosForIdea({
          idea: idea.trim().slice(0, 400),
          categories: cleanCategories,
          languagePreference: lang,
          bearerToken,
        });

        if (searchResult.apiStatus !== 'ok' || !searchResult.winner) {
          return res.status(400).json({
            error:
              searchResult.errorMessage ||
              'Could not find a suitable YouTube video matching your locked requirements.',
            searchResult,
          });
        }
        chosen = searchResult.winner;
      }

      const mergedInstructions = buildIdeaStreamInstructions({
        idea: idea.trim().slice(0, 400),
        categories: cleanCategories,
        languagePreference: lang,
        clipCount: parsedClipCount,
        customInstructions:
          typeof customInstructions === 'string' ? customInstructions.trim().slice(0, 800) : undefined,
        matchedQuery:
          typeof chosen.matchedQuery === 'string' ? chosen.matchedQuery : undefined,
      });

      const targetFormat = formatMode === 'long' ? 'long' : 'short';
      const targetAspect =
        targetFormat === 'long' && aspectMode === 'landscape' ? 'landscape' : 'portrait';

      const job = startStreamJob({
        label:
          typeof chosen.title === 'string' && chosen.title.trim()
            ? chosen.title.trim().slice(0, 120)
            : idea.trim().slice(0, 80),
        sourceUrl: chosen.url,
        sourceType: 'url',
        formatMode: targetFormat,
        aspectMode: targetAspect,
        brandingEnabled: brandingEnabled !== false,
        watermarkPosition: 'auto',
        additionalInstructions: mergedInstructions,
        clipCount: parsedClipCount,
        requirementSpec: {
          topicIdea: idea.trim().slice(0, 400),
          lockedCategories: cleanCategories,
          languagePreference: lang,
          ...(parsedClipCount ? { clipCount: parsedClipCount } : {}),
          formatMode: targetFormat,
          aspectMode: targetAspect,
          requiredTags: ['#BD'],
        },
        authorizedConfirmed: true,
        segmentSeconds: Number(segmentSeconds) || (targetFormat === 'long' ? 300 : 120),
      });

      res.json({
        status: 'started',
        stream: job,
        winner: chosen,
        searchResult,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to start Idea-to-Video clipping job.';
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/site-music/info', (_req, res) => {
    res.json({
      title: SITE_MUSIC_TITLE,
      sourceUrl: SITE_MUSIC_SOURCE_URL,
      videoId: SITE_MUSIC_VIDEO_ID,
      streamUrl: '/api/site-music/stream',
    });
  });

  app.get('/api/site-music/stream', async (req, res) => {
    try {
      const filePath = await ensureSiteMusicAudioFile();
      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const rangeHeader = req.headers.range;

      res.setHeader('Content-Type', 'audio/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=3600');

      if (rangeHeader) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
        if (!match) {
          res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
          return;
        }
        const start = match[1] ? parseInt(match[1], 10) : 0;
        const end = match[2] ? Math.min(fileSize - 1, parseInt(match[2], 10)) : fileSize - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= fileSize) {
          res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
          return;
        }
        const chunkSize = end - start + 1;
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Content-Length', String(chunkSize));
        fs.createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.status(200);
        res.setHeader('Content-Length', String(fileSize));
        fs.createReadStream(filePath).pipe(res);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to load website background music stream.';
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/actions', (_req, res) => {
    res.json({ actions: getAllActionLogs() });
  });

  app.post('/api/actions', (req, res) => {
    try {
      const { category, actionName, sourceRef, status, summary, details } = req.body ?? {};
      if (!actionName || !summary) {
        return res.status(400).json({ error: 'actionName and summary are required.' });
      }
      const entry = recordActionLog({
        category: typeof category === 'string' ? (category as any) : 'source_url',
        actionName: String(actionName),
        sourceRef: typeof sourceRef === 'string' ? sourceRef : undefined,
        status:
          status === 'queued' || status === 'running' || status === 'success' || status === 'error'
            ? status
            : 'success',
        summary: String(summary),
        details: typeof details === 'string' ? details : undefined,
      });
      res.json({ entry });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to log action.' });
    }
  });

  app.delete('/api/actions', (_req, res) => {
    clearAllActionLogs();
    res.json({ cleared: true });
  });

  app.get('/api/manual-clips/status', (_req, res) => {
    res.json({
      linkOnlyMode: true,
      claudeConfigured: isClaudeConfigured(),
      geminiConfigured: isGeminiConfigured(),
    });
  });

  app.post('/api/manual-clips/ai-detect', async (req, res) => {
    try {
      const { pastedText, sourceVideoUrl, languagePreference, nicheHint } = req.body ?? {};
      if (!pastedText || typeof pastedText !== 'string') {
        return res.status(400).json({ error: 'Pasted breakdown text is required.' });
      }
      const clips = await detectAndAutoFillManualClips({
        pastedText,
        sourceVideoUrl: typeof sourceVideoUrl === 'string' ? sourceVideoUrl : undefined,
        languagePreference,
        nicheHint: typeof nicheHint === 'string' ? nicheHint : undefined,
      });
      res.json({
        clips,
        claudeConfigured: isClaudeConfigured(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI detect and auto-fill failed.';
      res.status(400).json({ error: message });
    }
  });

  // Manual Clip Info -> Metadata Generation & Link-Only Zernio Publish endpoints
  app.post('/api/manual-clips/generate', async (req, res) => {
    try {
      const { clips, languagePreference, nicheHint, sourceVideoUrl, existingTitles } = req.body ?? {};
      if (!Array.isArray(clips) || clips.length === 0) {
        return res.status(400).json({ error: 'Add at least one clip with notes first.' });
      }
      const generated = await generateManualClipMetadataBatch({
        clips,
        languagePreference,
        nicheHint: typeof nicheHint === 'string' ? nicheHint : undefined,
        sourceVideoUrl: typeof sourceVideoUrl === 'string' ? sourceVideoUrl : undefined,
        existingTitles: Array.isArray(existingTitles) ? existingTitles : undefined,
      });
      res.json({
        clips: generated,
        claudeConfigured: isClaudeConfigured(),
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to generate clip metadata.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/manual-clips/sensor-audit', async (req, res) => {
    try {
      const {
        clips,
        sourceVideoUrl,
        nicheHint,
        languagePreference,
        enableVisualAudit = true,
      } = req.body ?? {};
      if (!Array.isArray(clips) || clips.length === 0) {
        return res.status(400).json({ error: 'Provide at least one clip to inspect with Sensor Guard.' });
      }
      const results = await auditManualClipsBatch({
        clips,
        sourceVideoUrl: typeof sourceVideoUrl === 'string' ? sourceVideoUrl : undefined,
        nicheHint: typeof nicheHint === 'string' ? nicheHint : undefined,
        languagePreference:
          typeof languagePreference === 'string' ? languagePreference : undefined,
        enableVisualAudit: enableVisualAudit !== false,
      });
      res.json({ results });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Sensor audit failed.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/manual-clips/publish-zernio', async (req, res) => {
    try {
      const {
        clipNumber = 1,
        title,
        description,
        hashtags,
        notes,
        sourceVideoUrl,
        startTime,
        endTime,
        nicheHint,
        languageChoice,
        accountIds,
        uploadMode,
      } = req.body ?? {};

      const result = await publishManualClipToZernio({
        clipNumber: Number(clipNumber) || 1,
        title: typeof title === 'string' ? title : '',
        description: typeof description === 'string' ? description : '',
        hashtags: Array.isArray(hashtags) ? hashtags : [],
        notes: typeof notes === 'string' ? notes : undefined,
        sourceVideoUrl: typeof sourceVideoUrl === 'string' ? sourceVideoUrl : undefined,
        startTime: typeof startTime === 'string' ? startTime : undefined,
        endTime: typeof endTime === 'string' ? endTime : undefined,
        nicheHint: typeof nicheHint === 'string' ? nicheHint : undefined,
        languageChoice: typeof languageChoice === 'string' ? languageChoice : undefined,
        accountIds: Array.isArray(accountIds)
          ? accountIds.filter((id: unknown): id is string => typeof id === 'string')
          : undefined,
        uploadMode:
          uploadMode === 'draft' || uploadMode === 'publish_now' ? uploadMode : undefined,
      });

      res.json(result);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to upload clip via Zernio.';
      const status = /not connected/i.test(message) ? 401 : 400;
      res.status(status).json({ error: message });
    }
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  const isHtmlNavigation = (req: express.Request): boolean => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (req.path.startsWith('/api/')) return false;
    const ext = path.extname(req.path);
    if (ext && ext !== '.html') return false;
    const accept = String(req.headers.accept || '');
    return !accept || accept.includes('text/html') || accept.includes('*/*');
  };

  if (process.env.NODE_ENV !== 'production') {
    let viteMiddleware: express.RequestHandler | null = null;
    const viteReady = createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    })
      .then((vite) => {
        viteMiddleware = vite.middlewares;
        viteMiddlewareReady = true;
        viteInitError = null;
        return vite;
      })
      .catch((err) => {
        viteInitError = err instanceof Error ? err.message : String(err);
        console.error('[server] Vite middleware startup error:', err);
        return null;
      });

    app.use(async (req, res, next) => {
      try {
        if (!viteMiddleware && !viteInitError) {
          await Promise.race([
            viteReady,
            new Promise<void>((resolve) => setTimeout(resolve, 3500)),
          ]);
        }

        if (viteInitError) {
          if (isHtmlNavigation(req)) {
            return res.status(500).type('html').send(
              renderServerFallbackHtml({
                title: 'Preview Dev Server Error',
                message: `Vite initialization failed: ${viteInitError}`,
              })
            );
          }
          return res.status(500).json({ error: `Vite initialization failed: ${viteInitError}` });
        }

        if (!viteMiddleware) {
          if (isHtmlNavigation(req)) {
            return res.status(200).type('html').send(
              renderServerFallbackHtml({
                title: 'Starting Clips ai Preview…',
                message: 'Preparing client assets. This preview refreshes automatically in a moment.',
                autoRefreshSeconds: 2,
              })
            );
          }
          return res.status(503).json({ error: 'Preview bundler is warming up. Please retry.' });
        }

        return viteMiddleware(req, res, next);
      } catch (err) {
        return next(err);
      }
    });

    app.use((req, res) => {
      if (isHtmlNavigation(req)) {
        const rootIndexPath = path.resolve(process.cwd(), 'index.html');
        if (fs.existsSync(rootIndexPath)) {
          return res.sendFile(rootIndexPath);
        }
        return res.status(404).type('html').send(
          renderServerFallbackHtml({
            title: 'Preview Entry Missing',
            message: 'Root index.html was not found on disk.',
          })
        );
      }
      return res.status(404).json({ error: `Asset or route not found: ${req.path}` });
    });
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    const distIndexPath = path.join(distDir, 'index.html');

    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir, { index: false }));
    }

    app.use((req, res) => {
      if (isHtmlNavigation(req)) {
        if (fs.existsSync(distIndexPath)) {
          return res.sendFile(distIndexPath);
        }
        const rootIndexPath = path.resolve(process.cwd(), 'index.html');
        if (fs.existsSync(rootIndexPath)) {
          return res.sendFile(rootIndexPath);
        }
        return res.status(503).type('html').send(
          renderServerFallbackHtml({
            title: 'Production Build Missing',
            message: 'Built frontend assets (dist/index.html) were not found. Run npm run build and reload.',
          })
        );
      }
      return res.status(404).json({ error: `Asset or route not found: ${req.path}` });
    });
  }

  app.use(
    (
      err: unknown,
      req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      const message = err instanceof Error ? err.message : 'Unexpected server error.';
      if (res.headersSent) return;
      if (req.path.startsWith('/api/') || !isHtmlNavigation(req)) {
        res.status(500).json({ error: message });
        return;
      }
      res.status(500).type('html').send(
        renderServerFallbackHtml({
          title: 'Preview Server Error',
          message,
        })
      );
    }
  );

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Rafew X GTA VI Clip AI server running at http://0.0.0.0:${PORT}`);
  });
  httpServer.requestTimeout = 0;
  httpServer.keepAliveTimeout = 65000;
}

process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled promise rejection:', reason);
  recordDoctorEvent(
    'critical',
    'Server Runtime',
    `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`
  );
});

process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception:', err);
  recordDoctorEvent('critical', 'Server Runtime', `Uncaught exception: ${err.message}`);
});

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
