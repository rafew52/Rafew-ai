import { spawn, type ChildProcess } from 'child_process';
import { getActiveAiProvider } from './aiRouter.ts';
import {
  generateClaudeChatEngagement,
  generateClaudeLiveMetadata,
  isClaudeConfigured,
} from './claude.ts';
import { createGeminiClientForKey, getCandidateRawKeys } from './geminiKeys.ts';
import { getActiveCandidateModels } from './geminiModels.ts';
import { executeWithYouTubeOAuthPool } from './youtubeOAuthPool.ts';
import fs from 'fs';
import path from 'path';

export interface LiveChatMessage {
  id: string;
  author: string;
  message: string;
  timestamp: string;
  isAiGenerated?: boolean;
}

export interface AutoDoctorLogEvent {
  id: string;
  timestamp: string;
  type: 'info' | 'warn' | 'error' | 'healed';
  message: string;
}

export interface YouTubeLiveStudioSession {
  id: string;
  sourceUrl: string;
  resolvedSourceUrl?: string;
  sourceType: 'video' | 'live';
  aspectMode: 'landscape' | 'portrait';
  status: 'idle' | 'broadcasting' | 'stopped' | 'error';
  startedAt: string;
  streamTitle: string;
  description: string;
  tags: string[];
  thumbnailUrl: string;
  broadcastId?: string;
  streamId?: string;
  oauthSlotId?: string;
  activeLiveChatId?: string;
  viewersCount: number;
  likesCount: number;
  chatMessages: LiveChatMessage[];
  aiAutoChatEnabled: boolean;
  lastAiChatAt?: string;
  healthStatus: 'healthy' | 'recovering' | 'backup_active' | 'self_healed' | 'error';
  ffmpegBitrate?: string;
  ffmpegFps?: string;
  ffmpegTime?: string;
  restartCount: number;
  autoDoctorLogs: AutoDoctorLogEvent[];
  errorMessage?: string;
}

let activeStudioSession: YouTubeLiveStudioSession | null = null;
let ffmpegProcess: ChildProcess | null = null;
let watchdogInterval: NodeJS.Timeout | null = null;
let pollInterval: NodeJS.Timeout | null = null;
let aiChatInterval: NodeJS.Timeout | null = null;
let lastStderrActivityMs = Date.now();

const STATE_FILE = path.resolve(process.cwd(), 'data', 'livestudio_state.json');

function saveSessionState() {
  try {
    if (!fs.existsSync(path.dirname(STATE_FILE))) {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    }
    if (activeStudioSession && activeStudioSession.status === 'broadcasting') {
      fs.writeFileSync(STATE_FILE, JSON.stringify(activeStudioSession, null, 2), 'utf-8');
    } else if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
  } catch (err) {
    console.warn('Failed to persist live studio session state:', err);
  }
}

function logAutoDoctor(type: 'info' | 'warn' | 'error' | 'healed', message: string) {
  const entry: AutoDoctorLogEvent = {
    id: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toLocaleTimeString(),
    type,
    message,
  };
  console.log(`[AI Auto-Doctor] [${type.toUpperCase()}] ${message}`);
  if (activeStudioSession) {
    activeStudioSession.autoDoctorLogs.unshift(entry);
    if (activeStudioSession.autoDoctorLogs.length > 40) {
      activeStudioSession.autoDoctorLogs.pop();
    }
  }
}

function getUsableGeminiClient() {
  const candidates = getCandidateRawKeys();
  const candidate = candidates[0];
  if (!candidate?.apiKey) return null;
  return createGeminiClientForKey(candidate.apiKey);
}

function getActiveModelName(): string {
  const active = getActiveCandidateModels();
  return active[0] || 'gemini-4-hydrogen';
}

export async function generateLiveMetadata(
  sourceUrl: string,
  additionalInstructions?: string
): Promise<{ title: string; description: string; tags: string[] }> {
  const provider = getActiveAiProvider();

  if (provider === 'claude' && isClaudeConfigured()) {
    try {
      const claudeMeta = await generateClaudeLiveMetadata(sourceUrl, additionalInstructions);
      if (claudeMeta.title && claudeMeta.description) {
        return claudeMeta;
      }
    } catch (err) {
      logAutoDoctor('warn', `Claude live metadata fallback to Gemini: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const ai = getUsableGeminiClient();
  const model = getActiveModelName();
  if (!ai) {
    if (isClaudeConfigured()) {
      try {
        return await generateClaudeLiveMetadata(sourceUrl, additionalInstructions);
      } catch {}
    }
    throw new Error('No AI provider key configured (add Gemini or Claude API key in System Setup).');
  }

  const prompt = `You are a professional YouTube channel manager for GTA6HUB (#BD).
Analyze this source URL: "${sourceUrl}".
${additionalInstructions ? `Custom User Instructions: "${additionalInstructions}".` : ''}
Generate a unique, engaging, high-CTR YouTube Live Stream Title (max 70 chars, choose dynamically between Bengali বাংলা, Banglish, or English to fit the gaming/BD vibe, include #BD, NO template numbering like #1), a professional Description with subscribe CTA, and 5-8 tags.
Return JSON format ONLY:
{
  "title": "...",
  "description": "...",
  "tags": ["...", "..."]
}`;

  try {
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: { responseMimeType: 'application/json' },
    });
    const parsed = JSON.parse(response.text || '{}');
    if (parsed.title && parsed.description) {
      return {
        title: parsed.title,
        description: parsed.description,
        tags: Array.isArray(parsed.tags) ? parsed.tags : ['Live', 'BD', 'GTA6HUB'],
      };
    }
  } catch (err) {
    logAutoDoctor('warn', `Gemini metadata generation warning: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    title: 'GTA6HUB Live Action Stream #BD',
    description: 'Live broadcast on GTA6HUB (#BD). Subscribe and drop a like!',
    tags: ['Live', 'BD', 'GTA6HUB', 'Gaming'],
  };
}

export async function generateAiChatEngagementMessage(session: YouTubeLiveStudioSession): Promise<string> {
  const recentChat = session.chatMessages.slice(-5).map((c) => `${c.author}: ${c.message}`).join(' | ');
  const provider = getActiveAiProvider();

  if (provider === 'claude' && isClaudeConfigured()) {
    try {
      const text = await generateClaudeChatEngagement(session.streamTitle, recentChat);
      if (text.trim()) return text.trim();
    } catch (err) {
      logAutoDoctor('warn', `Claude auto-chat fallback to Gemini: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const ai = getUsableGeminiClient();
  const model = getActiveModelName();
  if (!ai) {
    if (isClaudeConfigured()) {
      return await generateClaudeChatEngagement(session.streamTitle, recentChat);
    }
    throw new Error('No usable AI key configured for Live Chat generation.');
  }

  const prompt = `You are an energetic, friendly Bangladeshi & global gaming stream host for GTA6HUB (#BD).
Current stream title: "${session.streamTitle}".
Recent chat activity: "${recentChat || 'New broadcast started'}".

Write a fresh, natural live chat message in Bengali (বাংলা), Banglish, or English (whichever matches the stream/chat vibe best) including #BD. Encourage viewers to hit the like button, subscribe, and chat!
Return ONLY the chat message text, max 2 sentences. No quotes, no markdown.`;

  try {
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
    });
    const text = response.text?.trim();
    if (text) return text;
  } catch (err) {
    logAutoDoctor('warn', `Gemini AI chat message generation warning: ${err instanceof Error ? err.message : String(err)}`);
  }

  throw new Error('Failed to generate live chat message from configured AI providers.');
}

export function getActiveStudioSession(): YouTubeLiveStudioSession | null {
  return activeStudioSession;
}

// 3-Tier Multi-Extractor Fallback Chain
async function resolveStreamUrlWithFallback(sourceUrl: string): Promise<string> {
  // Tier 1: yt-dlp (web/android/ios/tv_embedded + cookies) -> VisionOS fallback
  try {
    const { resolveYouTubeStreams } = await import('./youtubeExtractor.ts');
    const resolved = await resolveYouTubeStreams(sourceUrl);
    if (resolved.videoUrl) {
      logAutoDoctor('info', 'Successfully resolved stream URL via Tier 1 (multi-client extractor).');
      return resolved.videoUrl;
    }
  } catch (err1) {
    logAutoDoctor('warn', `Tier 1 extractor notice: ${err1 instanceof Error ? err1.message : String(err1)}`);
  }

  // Tier 2: Direct URL pass-through / HLS manifest
  if (sourceUrl.includes('.m3u8') || sourceUrl.includes('.ts') || sourceUrl.includes('rtmp://') || sourceUrl.includes('http')) {
    logAutoDoctor('info', 'Using Tier 2 direct media URL stream source.');
    return sourceUrl;
  }

  // Tier 3: Fallback backup slate or raw URL
  logAutoDoctor('warn', 'All extractors exhausted, falling back to raw source URL.');
  return sourceUrl;
}

function spawnFfmpegWorker(resolvedUrl: string, aspectMode: 'landscape' | 'portrait', targetRtmp: string, useBackupSlate = false): ChildProcess {
  const videoFilter = aspectMode === 'portrait'
    ? 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920'
    : 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2';

  let ffmpegArgs: string[];
  if (useBackupSlate) {
    // Anti-Drop Backup Slate (solid dark slate to prevent YouTube RTMP timeout during buffer drops without SMPTE color bars)
    logAutoDoctor('warn', 'Activating Anti-Drop RTMP Backup Slate (preventing YouTube auto-off broadcast drop)...');
    ffmpegArgs = [
      '-re',
      '-f', 'lavfi',
      '-i', aspectMode === 'portrait' ? 'color=c=#0B0E14:s=1080x1920:r=30' : 'color=c=#0B0E14:s=1920x1080:r=30',
      '-vf', videoFilter,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-b:v', '2500k',
      '-pix_fmt', 'yuv420p',
      '-g', '60',
      '-c:a', 'anullsrc',
      '-ar', '44100',
      '-f', 'flv',
      targetRtmp,
    ];
  } else {
    ffmpegArgs = [
      '-re',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '2',
      '-rw_timeout', '5000000',
      '-i', resolvedUrl,
      '-vf', videoFilter,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-b:v', '3000k',
      '-maxrate', '3000k',
      '-bufsize', '6000k',
      '-pix_fmt', 'yuv420p',
      '-g', '60',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-f', 'flv',
      targetRtmp,
    ];
  }

  const proc = spawn('ffmpeg', ffmpegArgs);
  lastStderrActivityMs = Date.now();

  proc.stderr?.on('data', (data: Buffer) => {
    const line = data.toString();
    lastStderrActivityMs = Date.now();
    const fpsMatch = line.match(/fps=\s*([0-9.]+)/);
    const bitrateMatch = line.match(/bitrate=\s*([0-9.kKbB/]+)/);
    const timeMatch = line.match(/time=([0-9:.]+)/);

    if (activeStudioSession) {
      if (fpsMatch) activeStudioSession.ffmpegFps = fpsMatch[1];
      if (bitrateMatch) activeStudioSession.ffmpegBitrate = bitrateMatch[1];
      if (timeMatch) activeStudioSession.ffmpegTime = timeMatch[1];
    }
  });

  proc.on('error', (err) => {
    logAutoDoctor('error', `FFmpeg process error: ${err.message}`);
    if (activeStudioSession) {
      activeStudioSession.healthStatus = 'error';
      activeStudioSession.errorMessage = err.message;
    }
  });

  proc.on('close', (code) => {
    if (code !== 0 && code !== null && activeStudioSession && activeStudioSession.status === 'broadcasting') {
      logAutoDoctor('warn', `FFmpeg worker exited with code ${code}. Fast Watchdog initiating instant recovery...`);
    }
  });

  return proc;
}

export async function startYouTubeLiveStudio(params: {
  sourceUrl: string;
  sourceType?: 'video' | 'live';
  aspectMode?: 'landscape' | 'portrait';
  streamTitle?: string;
  description?: string;
  tags?: string[];
  customThumbnailUrl?: string;
  aiAutoChatEnabled?: boolean;
}): Promise<YouTubeLiveStudioSession> {
  stopYouTubeLiveStudio();

  const isLive = params.sourceType === 'live' || params.sourceUrl.includes('live' ) || params.sourceUrl.includes('watch?v=');
  const sourceType = isLive && params.sourceType !== 'video' ? 'live' : 'video';
  const aspectMode = params.aspectMode === 'portrait' ? 'portrait' : 'landscape';

  logAutoDoctor('info', `Initializing YouTube Live Studio broadcast (${aspectMode}, ${sourceType})...`);

  // 1. Generate Metadata
  let title = params.streamTitle?.trim();
  let description = params.description?.trim();
  let tags = params.tags;

  if (!title || !description) {
    const generated = await generateLiveMetadata(params.sourceUrl);
    if (!title) title = generated.title;
    if (!description) description = generated.description;
    if (!tags || tags.length === 0) tags = generated.tags;
  }

  // 2. Create Real YouTube Live Broadcast & Stream via OAuth Pool (with automatic slot failover)
  const poolLogger = (lvl: 'info' | 'warn' | 'success', msg: string) =>
    logAutoDoctor(lvl === 'success' ? 'healed' : lvl, msg);

  const broadcastExec = await executeWithYouTubeOAuthPool({
    operationName: 'liveBroadcasts.insert',
    estimatedQuotaUnits: 50,
    onLog: poolLogger,
    fn: async (yt) =>
      yt.liveBroadcasts.insert({
        part: ['snippet', 'status', 'contentDetails'],
        requestBody: {
          snippet: {
            title: title || 'Live Stream Broadcast',
            description: description || 'Streamed live via Live Studio.',
            scheduledStartTime: new Date().toISOString(),
          },
          status: {
            privacyStatus: 'public',
            selfDeclaredMadeForKids: false,
          },
          contentDetails: {
            enableAutoStart: true,
            enableAutoStop: true,
          },
        },
      }),
  });

  const broadcastRes = broadcastExec.result;
  let pinnedSlotId = broadcastExec.slotIdUsed;
  const broadcastId = broadcastRes.data.id;
  if (!broadcastId) {
    throw new Error('Failed to create YouTube Live broadcast.');
  }

  const streamExec = await executeWithYouTubeOAuthPool({
    operationName: 'liveStreams.insert',
    estimatedQuotaUnits: 50,
    preferredSlotId: pinnedSlotId,
    onLog: poolLogger,
    fn: async (yt) =>
      yt.liveStreams.insert({
        part: ['snippet', 'cdn'],
        requestBody: {
          snippet: { title: `Stream for ${title}` },
          cdn: {
            format: '1080p',
            ingestionType: 'rtmp',
            resolution: '1080p',
            frameRate: '30fps',
          },
        },
      }),
  });

  const streamRes = streamExec.result;
  pinnedSlotId = streamExec.slotIdUsed;
  const streamId = streamRes.data.id;
  const ingestionInfo = streamRes.data.cdn?.ingestionInfo;
  const rtmpUrl = ingestionInfo?.ingestionAddress;
  const streamKey = ingestionInfo?.streamName;

  if (!streamId || !rtmpUrl || !streamKey) {
    throw new Error('Failed to retrieve RTMP ingestion address from YouTube live stream.');
  }

  const bindExec = await executeWithYouTubeOAuthPool({
    operationName: 'liveBroadcasts.bind',
    estimatedQuotaUnits: 50,
    preferredSlotId: pinnedSlotId,
    onLog: poolLogger,
    fn: async (yt) =>
      yt.liveBroadcasts.bind({
        part: ['id', 'contentDetails'],
        id: broadcastId,
        streamId: streamId,
      }),
  });
  pinnedSlotId = bindExec.slotIdUsed;

  const thumbnailUrl = params.customThumbnailUrl?.trim() || 'https://images.unsplash.com/photo-1538481199705-c710c4e965fc?q=80&w=1280&auto=format&fit=crop';

  const session: YouTubeLiveStudioSession = {
    id: `studio-${Date.now()}`,
    sourceUrl: params.sourceUrl,
    sourceType,
    aspectMode,
    status: 'broadcasting',
    startedAt: new Date().toISOString(),
    streamTitle: title || 'Live Stream Broadcast',
    description: description || '',
    tags: tags || [],
    thumbnailUrl,
    broadcastId,
    streamId,
    oauthSlotId: pinnedSlotId,
    viewersCount: 0,
    likesCount: 0,
    chatMessages: [],
    aiAutoChatEnabled: params.aiAutoChatEnabled ?? true,
    healthStatus: 'healthy',
    restartCount: 0,
    autoDoctorLogs: [],
  };

  activeStudioSession = session;
  saveSessionState();

  // 3. Resolve stream URL
  const resolvedUrl = await resolveStreamUrlWithFallback(params.sourceUrl);
  activeStudioSession.resolvedSourceUrl = resolvedUrl;

  // 4. Spawn FFmpeg Worker
  const targetRtmp = `${rtmpUrl}/${streamKey}`;
  ffmpegProcess = spawnFfmpegWorker(resolvedUrl, aspectMode, targetRtmp, false);

  // 5. Safe Broadcast Lifecycle Transition Sequencing
  let currentLifecycle = 'created';
  let currentStreamStatus = 'inactive';

  for (let attempt = 1; attempt <= 10; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const checkExec = await executeWithYouTubeOAuthPool({
        operationName: 'liveBroadcasts.lifecyclePoll',
        estimatedQuotaUnits: 2,
        preferredSlotId: activeStudioSession?.oauthSlotId || pinnedSlotId,
        onLog: poolLogger,
        fn: async (yt) => {
          const bcCheck = await yt.liveBroadcasts.list({ part: ['status'], id: [broadcastId] });
          const stCheck = await yt.liveStreams.list({ part: ['status'], id: [streamId] });
          return { bcCheck, stCheck };
        },
      });
      if (activeStudioSession) {
        activeStudioSession.oauthSlotId = checkExec.slotIdUsed;
      }

      currentLifecycle = checkExec.result.bcCheck.data.items?.[0]?.status?.lifeCycleStatus || 'created';
      currentStreamStatus = checkExec.result.stCheck.data.items?.[0]?.status?.streamStatus || 'inactive';

      if (currentLifecycle === 'live' || currentLifecycle === 'testing') {
        logAutoDoctor('healed', `Broadcast lifecycle reached state: ${currentLifecycle}`);
        break;
      }

      if (currentStreamStatus === 'active' || currentLifecycle === 'ready') {
        try {
          const transExec = await executeWithYouTubeOAuthPool({
            operationName: 'liveBroadcasts.transition',
            estimatedQuotaUnits: 50,
            preferredSlotId: activeStudioSession?.oauthSlotId || pinnedSlotId,
            onLog: poolLogger,
            fn: async (yt) =>
              yt.liveBroadcasts.transition({
                part: ['id', 'status'],
                broadcastStatus: 'live',
                id: broadcastId,
              }),
          });
          if (activeStudioSession) {
            activeStudioSession.oauthSlotId = transExec.slotIdUsed;
          }
          logAutoDoctor('healed', 'Successfully transitioned YouTube broadcast status to LIVE.');
        } catch (transErr: any) {
          const msg = transErr?.response?.data?.error?.message || transErr?.message || String(transErr);
          if (msg.toLowerCase().includes('invalid transition') || currentLifecycle === 'live') {
            break;
          }
          throw transErr;
        }
        break;
      }
    } catch (transErr: any) {
      const apiDetails = transErr?.response?.data?.error?.message || transErr?.message || String(transErr);
      if (attempt === 10) {
        logAutoDoctor('warn', `Broadcast transition notice: ${apiDetails}`);
      }
    }
  }

  // 6. Fast Watchdog Monitor (Every 2 seconds) + Anti-Drop Backup Slate + Self-Healing
  if (watchdogInterval) clearInterval(watchdogInterval);
  watchdogInterval = setInterval(async () => {
    if (!activeStudioSession || activeStudioSession.status !== 'broadcasting') return;

    const now = Date.now();
    const stallDurationMs = now - lastStderrActivityMs;

    // Check if ffmpeg process crashed or stalled (>8s without stderr output)
    if (!ffmpegProcess || ffmpegProcess.killed || stallDurationMs > 8000) {
      if (activeStudioSession.healthStatus !== 'recovering') {
        logAutoDoctor('warn', 'Fast Watchdog detected FFmpeg stall or process exit. Initiating auto-healing recovery...');
        activeStudioSession.healthStatus = 'recovering';
        activeStudioSession.restartCount++;

        // Kill stale process if any
        if (ffmpegProcess) {
          try { ffmpegProcess.kill('SIGKILL'); } catch {}
          ffmpegProcess = null;
        }

        // Tiered Recovery Action: Re-resolve stream URL and respawn
        try {
          const freshUrl = await resolveStreamUrlWithFallback(params.sourceUrl);
          activeStudioSession.resolvedSourceUrl = freshUrl;
          ffmpegProcess = spawnFfmpegWorker(freshUrl, aspectMode, targetRtmp, false);
          activeStudioSession.healthStatus = 'self_healed';
          logAutoDoctor('healed', `Self-Healing complete: FFmpeg restarted with fresh stream URL (Restart #${activeStudioSession.restartCount}).`);
        } catch (healErr) {
          logAutoDoctor('error', `Self-Healing fallback to backup slate: ${healErr instanceof Error ? healErr.message : String(healErr)}`);
          activeStudioSession.healthStatus = 'backup_active';
          // Spawn backup slate so YouTube RTMP never drops
          ffmpegProcess = spawnFfmpegWorker(resolvedUrl, aspectMode, targetRtmp, true);
        }
        lastStderrActivityMs = Date.now();
      }
    }
  }, 2000);

  // 7. Real Polling for Viewers, Likes, and Chat
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(async () => {
    if (!activeStudioSession || activeStudioSession.status !== 'broadcasting' || !broadcastId) return;
    try {
      const pollExec = await executeWithYouTubeOAuthPool({
        operationName: 'liveBroadcasts.pollStats',
        estimatedQuotaUnits: 1,
        preferredSlotId: activeStudioSession.oauthSlotId,
        onLog: (lvl, msg) => logAutoDoctor(lvl === 'success' ? 'healed' : lvl, msg),
        fn: async (yt) => {
          const vidRes = await yt.videos.list({
            part: ['liveStreamingDetails', 'statistics'],
            id: [broadcastId],
          });
          const item = vidRes.data.items?.[0];
          if (!item) return { item: null, messages: null, chatId: undefined };

          const chatId = item.liveStreamingDetails?.activeLiveChatId || undefined;
          let messages = null;
          if (chatId) {
            const chatRes = await yt.liveChatMessages.list({
              liveChatId: chatId,
              part: ['snippet', 'authorDetails'],
            });
            messages = chatRes.data.items || [];
          }
          return { item, messages, chatId };
        },
      });

      if (!activeStudioSession || activeStudioSession.status !== 'broadcasting') return;
      activeStudioSession.oauthSlotId = pollExec.slotIdUsed;

      const { item, messages, chatId } = pollExec.result;
      if (item) {
        if (item.liveStreamingDetails?.concurrentViewers) {
          activeStudioSession.viewersCount = Number(item.liveStreamingDetails.concurrentViewers);
        }
        if (item.statistics?.likeCount) {
          activeStudioSession.likesCount = Number(item.statistics.likeCount);
        }
        if (chatId) {
          activeStudioSession.activeLiveChatId = chatId;
          if (messages) {
            activeStudioSession.chatMessages = messages.map((m) => ({
              id: m.id || `msg-${Math.random()}`,
              author: m.authorDetails?.displayName || 'Viewer',
              message: m.snippet?.displayMessage || '',
              timestamp: new Date(m.snippet?.publishedAt || Date.now()).toLocaleTimeString(),
            }));
          }
        }
      }
    } catch (err) {
      console.warn('Error polling YouTube live stats:', err);
    }
  }, 10000);

  // 8. 20-minute AI Auto-Chat Poster
  if (aiChatInterval) clearInterval(aiChatInterval);
  aiChatInterval = setInterval(async () => {
    if (!activeStudioSession || activeStudioSession.status !== 'broadcasting' || !activeStudioSession.aiAutoChatEnabled) return;
    try {
      await triggerManualAiChatMessage();
    } catch (err) {
      logAutoDoctor('warn', `20-min AI auto-chat poster notice: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, 20 * 60 * 1000);

  saveSessionState();
  return activeStudioSession;
}

export function stopYouTubeLiveStudio(): void {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (aiChatInterval) {
    clearInterval(aiChatInterval);
    aiChatInterval = null;
  }
  if (ffmpegProcess) {
    try {
      ffmpegProcess.kill('SIGINT');
    } catch {}
    ffmpegProcess = null;
  }
  if (activeStudioSession) {
    activeStudioSession.status = 'stopped';
    if (activeStudioSession.broadcastId) {
      const targetBroadcastId = activeStudioSession.broadcastId;
      const preferredSlotId = activeStudioSession.oauthSlotId;
      void executeWithYouTubeOAuthPool({
        operationName: 'liveBroadcasts.complete',
        estimatedQuotaUnits: 50,
        preferredSlotId,
        fn: async (yt) =>
          yt.liveBroadcasts.transition({
            part: ['id', 'status'],
            broadcastStatus: 'complete',
            id: targetBroadcastId,
          }),
      }).catch(() => {});
    }
  }
  activeStudioSession = null;
  saveSessionState();
  logAutoDoctor('info', 'Live Studio broadcast stopped cleanly.');
}

export async function triggerManualAiChatMessage(): Promise<LiveChatMessage> {
  if (!activeStudioSession) {
    throw new Error('No active YouTube Live Studio broadcast session found.');
  }
  const aiText = await generateAiChatEngagementMessage(activeStudioSession);

  if (activeStudioSession.activeLiveChatId) {
    const liveChatId = activeStudioSession.activeLiveChatId;
    try {
      const chatExec = await executeWithYouTubeOAuthPool({
        operationName: 'liveChatMessages.insert',
        estimatedQuotaUnits: 50,
        preferredSlotId: activeStudioSession.oauthSlotId,
        onLog: (lvl, msg) => logAutoDoctor(lvl === 'success' ? 'healed' : lvl, msg),
        fn: async (yt) =>
          yt.liveChatMessages.insert({
            part: ['snippet'],
            requestBody: {
              snippet: {
                liveChatId,
                type: 'textMessageEvent',
                textMessageDetails: {
                  messageText: aiText,
                },
              },
            },
          }),
      });
      activeStudioSession.oauthSlotId = chatExec.slotIdUsed;
    } catch (err) {
      logAutoDoctor('warn', `Failed to insert AI chat to YouTube live chat: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const newMsg: LiveChatMessage = {
    id: `ai-msg-${Date.now()}`,
    author: '🤖 GTA6HUB AI Host',
    message: aiText,
    timestamp: new Date().toLocaleTimeString(),
    isAiGenerated: true,
  };
  activeStudioSession.chatMessages.push(newMsg);
  if (activeStudioSession.chatMessages.length > 50) {
    activeStudioSession.chatMessages.shift();
  }
  activeStudioSession.lastAiChatAt = new Date().toISOString();
  saveSessionState();
  return newMsg;
}
