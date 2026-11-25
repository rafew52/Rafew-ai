export type StreamSourceType = 'url' | 'upload';

export type ClipFormatMode = 'short' | 'long';

export type VideoAspectMode = 'portrait' | 'landscape';

export type WatermarkPosition =
  | 'auto'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

export type ResolvedWatermarkSpot =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

export type ContentLanguageChoice = 'bengali' | 'banglish' | 'english';

export type AiProviderChoice = 'claude' | 'gemini' | 'auto';

export type UploadTimingDecision = 'publish_now' | 'scheduled' | 'fallback_immediate';

export interface YouTubeTimingAnalysis {
  decision: UploadTimingDecision;
  analyzedAt: string;
  queries: string[];
  analyzedVideoCount: number;
  peakAudienceHourUtc: number | null;
  peakAudienceLabel: string;
  topSampledVelocity: number;
  avgNicheEngagementPct: number;
  scheduledPublishAt?: string;
  queueSpacingMinutes: number;
  reasoning: string;
  apiStatus: 'ok' | 'quota_exceeded' | 'unavailable' | 'disabled';
  fallbackReason?: string;
}

export interface ThumbnailSourceLink {
  title: string;
  uri: string;
}

export type StreamStatus =
  | 'initializing'
  | 'monitoring'
  | 'stopping'
  | 'stopped'
  | 'ended'
  | 'error';

export type ClipJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export type MomentCategory =
  | 'funny'
  | 'epic_gameplay'
  | 'highlight'
  | 'reaction'
  | 'viral';

export interface CaptionCue {
  startOffsetSeconds: number;
  endOffsetSeconds: number;
  text: string;
}

export interface StreamLogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

export interface RequirementSpec {
  topicIdea: string;
  lockedCategories: string[];
  languagePreference: IdeaLanguagePreference;
  clipCount?: number;
  formatMode: ClipFormatMode;
  aspectMode: VideoAspectMode;
  requiredTags: string[];
}

export interface StreamJob {
  id: string;
  label: string;
  sourceUrl: string;
  sourceType: StreamSourceType;
  formatMode: ClipFormatMode;
  aspectMode: VideoAspectMode;
  brandingEnabled: boolean;
  watermarkPosition?: WatermarkPosition;
  additionalInstructions?: string;
  clipCount?: number;
  requirementSpec?: RequirementSpec;
  authorizedConfirmed: boolean;
  status: StreamStatus;
  segmentSeconds: number;
  chunksProcessed: number;
  momentsDetected: number;
  currentStage: string;
  errorMessage?: string;
  channelName?: string;
  channelAvatarUrl?: string;
  liveTitle?: string;
  streamThumbnailUrl?: string;
  isLiveBroadcast?: boolean;
  liveStartedAt?: string;
  startedAt: string;
  endedAt?: string;
  logs: StreamLogEntry[];
}

export type YouTubeUploadStatus =
  | 'not_uploaded'
  | 'queued_upload'
  | 'uploading'
  | 'uploaded'
  | 'upload_failed';

export type YouTubePrivacyStatus = 'private' | 'unlisted' | 'public';

export interface YouTubeChannelInfo {
  id: string;
  title: string;
  customUrl?: string;
  thumbnailUrl?: string;
}

export interface YouTubeApiSlot {
  slotId: number;
  connected: boolean;
  tokenExpired: boolean;
  quotaExhausted: boolean;
  channel: YouTubeChannelInfo | null;
}

export type YouTubeOAuthSlotStatus =
  | 'active_ready'
  | 'quota_exhausted'
  | 'needs_reauth'
  | 'invalid_credentials';

export interface YouTubeOAuthSlotPublic {
  id: string;
  label: string;
  authType: 'oauth2_credentials' | 'firebase_token';
  clientIdMasked?: string;
  redirectUri?: string;
  hasRefreshToken: boolean;
  hasAccessToken: boolean;
  status: YouTubeOAuthSlotStatus;
  quotaUnitsUsedToday: number;
  dailyQuotaLimit: number;
  quotaDatePt: string;
  quotaExhaustedAt?: string;
  lastUsedAt?: string;
  lastError?: string;
  channel: YouTubeChannelInfo | null;
}

export interface YouTubeOAuthPoolSummary {
  slots: YouTubeOAuthSlotPublic[];
  readyCount: number;
  exhaustedCount: number;
  totalCount: number;
  estimatedRemainingQuota: number;
  defaultRedirectUri: string;
}

export interface YouTubeAutoUploadSettings {
  connected: boolean;
  tokenExpired: boolean;
  autoUploadEnabled: boolean;
  smartTimingEnabled: boolean;
  directStudioMode: boolean;
  slots: YouTubeApiSlot[];
  oauthPool?: YouTubeOAuthPoolSummary;
  privacyStatus: YouTubePrivacyStatus;
  categoryId: string;
  madeForKids: boolean;
  channel: YouTubeChannelInfo | null;
}

export type ZernioUploadMode = 'publish_now' | 'draft';

export type ZernioPublishStatus =
  | 'not_published'
  | 'pending'
  | 'uploading'
  | 'published'
  | 'draft_sent'
  | 'partial_failed'
  | 'failed';

export type ZernioTikTokPrivacyLevel =
  | 'PUBLIC_TO_EVERYONE'
  | 'MUTUAL_FOLLOW_FRIENDS'
  | 'FOLLOWER_OF_CREATOR'
  | 'SELF_ONLY';

export interface ZernioTikTokOptions {
  draft: boolean;
  privacyLevel: ZernioTikTokPrivacyLevel;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  videoCoverTimestampMs: number;
}

export interface ZernioAccount {
  id: string;
  platform: string;
  username?: string;
  displayName?: string;
  profilePicture?: string;
  profileId?: string;
  isActive: boolean;
  tiktokAccountType?: 'business' | 'personal' | 'unknown';
  selectedForUpload: boolean;
}

export interface ZernioPlatformPostResult {
  platform: string;
  accountId: string;
  accountName?: string;
  status: string;
  platformPostUrl?: string;
  error?: string;
}

export interface ZernioConnectionSettings {
  connected: boolean;
  hasApiKey: boolean;
  apiKeyMasked?: string;
  autoUploadEnabled: boolean;
  uploadMode: ZernioUploadMode;
  accounts: ZernioAccount[];
  selectedAccountIds: string[];
  hasTikTokAccount: boolean;
  tiktokOptions: ZernioTikTokOptions;
  connectedAt?: string;
  lastSyncedAt?: string;
  lastError?: string;
}

export type ThirdPartyExportPlatform =
  | 'custom_webhook'
  | 'buffer'
  | 'metricool'
  | 'zapier_make';

export type ThirdPartyExportStatus = 'not_sent' | 'sending' | 'sent' | 'failed';

export interface ThirdPartyExportSettings {
  webhookUrl: string;
  webhookConfigured: boolean;
  preferredPlatform: ThirdPartyExportPlatform;
  webhookLabel?: string;
  autoSendOnComplete: boolean;
  lastTestedAt?: string;
  lastTestStatus?: string;
  lastError?: string;
}

export interface ClipItem {
  id: string;
  streamId: string;
  streamLabel: string;
  clipNumber?: number;
  formatMode: ClipFormatMode;
  aspectMode?: VideoAspectMode;
  brandingEnabled?: boolean;
  watermarkPosition?: WatermarkPosition;
  detectedWatermarkSpot?: ResolvedWatermarkSpot;
  chunkIndex: number;
  category: MomentCategory;
  status: ClipJobStatus;
  attempts: number;
  maxAttempts: number;
  momentSummary?: string;
  title: string;
  description: string;
  hashtags: string[];
  tags: string[];
  viralReason: string;
  languageChoice?: ContentLanguageChoice;
  thumbnailHook?: string;
  thumbnailTimestamp?: number;
  thumbnailSearchInsights?: string;
  thumbnailSearchSources?: ThumbnailSourceLink[];
  thumbnailAccent?: string;
  thumbnailUpdatedAt?: string;
  captions: CaptionCue[];
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  videoUrl?: string;
  srtUrl?: string;
  thumbnailUrl?: string;
  fileSizeBytes?: number;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
  youtubeUploadStatus?: YouTubeUploadStatus;
  youtubeVideoId?: string;
  youtubeUrl?: string;
  youtubePrivacyStatus?: YouTubePrivacyStatus;
  youtubeThumbnailSet?: boolean;
  youtubeUploadError?: string;
  youtubeUploadedAt?: string;
  youtubeScheduledPublishAt?: string;
  youtubeTimingAnalysis?: YouTubeTimingAnalysis;
  zernioPublishStatus?: ZernioPublishStatus;
  zernioPostId?: string;
  zernioPlatformResults?: ZernioPlatformPostResult[];
  zernioPublishError?: string;
  zernioPublishedAt?: string;
  thirdPartyExportStatus?: ThirdPartyExportStatus;
  thirdPartyExportedAt?: string;
  thirdPartyExportError?: string;
}

export type GeminiKeyStatus = 'ready' | 'active' | 'rate_limited' | 'invalid';

export interface GeminiApiKeyInfo {
  id: string;
  label: string;
  maskedKey: string;
  source: 'user' | 'env';
  status: GeminiKeyStatus;
  inUse: boolean;
  inFlightCount: number;
  cooldownUntil?: string;
  cooldownRemainingSeconds: number;
  lastUsedAt?: string;
  lastTestedAt?: string;
  lastError?: string;
  totalRequests: number;
  totalErrors: number;
}

export interface GeminiKeyPoolSummary {
  keys: GeminiApiKeyInfo[];
  maxUserKeys: number;
  activeKeyId: string | null;
  availableCount: number;
  totalCount: number;
}

export interface QuarantinedModelInfo {
  modelId: string;
  reason: string;
  quarantinedAt: string;
  expiresAt: string;
  remainingSeconds: number;
}

export interface GeminiModelRegistryStatus {
  activeModels: string[];
  discoveredModels: string[];
  quarantinedModels: QuarantinedModelInfo[];
  lastDiscoveryAt?: string;
  lastDiscoveryError?: string;
}

export type AutoDoctorSeverity = 'info' | 'warn' | 'error' | 'critical';

export interface AutoDoctorEvent {
  id: string;
  timestamp: string;
  severity: AutoDoctorSeverity;
  category: string;
  message: string;
  streamId?: string;
  httpCode?: number;
}

export interface AutoDoctorFinding {
  title: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  area: string;
  rootCause: string;
  recommendation: string;
  readyToCopyFixPrompt: string;
  codePatchPreview: string;
}

export interface AutoDoctorReport {
  healthScore: number;
  overallHealth: 'healthy' | 'degraded' | 'critical';
  summary: string;
  generatedAt: string;
  aiPowered: boolean;
  modelUsed?: string;
  autoDiagnoseEnabled: boolean;
  diagnosing: boolean;
  rootCauses: AutoDoctorFinding[];
  missingImprovements: string[];
  recentEvents: AutoDoctorEvent[];
}

export interface ClaudeApiKeyInfo {
  id: string;
  label: string;
  maskedKey: string;
  source: 'user' | 'env';
  status: 'ready' | 'active' | 'rate_limited' | 'invalid';
  inUse: boolean;
  cooldownUntil?: string;
  totalRequests: number;
  totalErrors: number;
}

export interface ClaudeKeyPoolSummary {
  keys: ClaudeApiKeyInfo[];
  totalCount: number;
  activeKeyMasked: string | null;
}

export interface SystemReadiness {
  aiProvider: AiProviderChoice;
  activeAiProvider: 'claude' | 'gemini';
  claudeConfigured: boolean;
  claudeKeyPool: ClaudeKeyPoolSummary;
  geminiConfigured: boolean;
  geminiKeyPool: GeminiKeyPoolSummary;
  geminiModels: GeminiModelRegistryStatus;
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  ytDlpAvailable: boolean;
  youtubeCookieConfigured: boolean;
  queueRunning: boolean;
  activeProcessingClipId: string | null;
  youtubeAutoUpload: YouTubeAutoUploadSettings;
  zernio?: ZernioConnectionSettings;
  thirdPartyExport?: ThirdPartyExportSettings;
  autoDoctorAlertCount: number;
}

export interface DashboardSnapshot {
  streams: StreamJob[];
  clips: ClipItem[];
  readiness: SystemReadiness;
}

export type IdeaCategoryOption =
  | 'GTA'
  | 'Free Fire'
  | 'Comedy'
  | 'Funny'
  | 'Viral'
  | 'Adventure'
  | 'Other';

export type IdeaLanguagePreference =
  | 'auto'
  | 'bengali'
  | 'banglish'
  | 'english'
  | 'any';

export interface IdeaCandidateVideo {
  videoId: string;
  url: string;
  title: string;
  channelTitle: string;
  channelId?: string;
  thumbnailUrl?: string;
  publishedAt: string;
  durationSeconds: number;
  durationLabel: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  hoursOld: number;
  viewVelocityPerHour: number;
  engagementPct: number;
  alignmentScore: number;
  totalScore: number;
  matchedQuery: string;
  claudeReasoning?: string;
}

export interface IdeaSearchResult {
  idea: string;
  categories: string[];
  languagePreference: IdeaLanguagePreference;
  expandedQueries: string[];
  apiStatus: 'ok' | 'no_youtube_auth' | 'quota_exceeded' | 'zero_matches' | 'error';
  errorMessage?: string;
  rejectedCount?: number;
  requirementSummary?: string;
  candidates: IdeaCandidateVideo[];
  winner?: IdeaCandidateVideo;
  winnerReasoning?: string;
  searchedAt: string;
}

export type ManualClipUploadStatus = 'idle' | 'ready' | 'uploading' | 'uploaded' | 'error';

export interface ManualClipGenerateInputItem {
  id: string;
  clipNumber: number;
  notes: string;
  startTime?: string;
  endTime?: string;
  sourceVideoUrl?: string;
}

export interface ClaudeClipEditPlan {
  framingMode: 'split_screen' | 'vertical_crop';
  cropBias: 'center' | 'top' | 'bottom';
  contrast: number;
  saturation: number;
  editingSummary: string;
  pacingNotes?: string;
  claudeUsed: boolean;
  diagnosticMessage?: string;
}

export interface ManualClipGeneratedItem {
  id: string;
  clipNumber: number;
  notes?: string;
  startTime?: string;
  endTime?: string;
  sourceVideoUrl?: string;
  momentSummary: string;
  title: string;
  description: string;
  hashtags: string[];
  tags: string[];
  languageChoice: ContentLanguageChoice;
  claudeUsed?: boolean;
  claudeDiagnostic?: string;
}

export type SensorStatusLevel = 'passed' | 'warning' | 'blocked';

export interface ClipSensorIssue {
  layer: 'visual' | 'timeline' | 'metadata';
  severity: 'warning' | 'block';
  code: string;
  message: string;
}

export interface ClipVisualInspection {
  passed: boolean;
  hasVideoStream: boolean;
  hasAudioStream: boolean;
  width?: number;
  height?: number;
  durationSeconds?: number;
  fileSizeBytes?: number;
  blackFrameRatio?: number;
  isTestPatternSuspected?: boolean;
  hasFrozenFrames?: boolean;
  visualSummary?: string;
  issues: string[];
}

export interface ClipSensorResult {
  clipId: string;
  clipNumber: number;
  status: SensorStatusLevel;
  issues: ClipSensorIssue[];
  visualChecked: boolean;
  visualReport?: ClipVisualInspection;
  aiAudited: boolean;
  modelUsed?: string;
  autoFixedFields?: {
    title?: string;
    description?: string;
    hashtags?: string[];
  };
  auditedAt: string;
}

export type ActionLogStatus = 'queued' | 'running' | 'success' | 'error';

export type ActionLogCategory =
  | 'source_url'
  | 'ai_detect'
  | 'youtube_extract'
  | 'claude_edit'
  | 'gemini_sensor'
  | 'ffmpeg_render'
  | 'site_music'
  | 'zernio_upload'
  | 'stream_pipeline';

export interface ActionActivityEntry {
  id: string;
  timestamp: string;
  category: ActionLogCategory;
  actionName: string;
  sourceRef?: string;
  status: ActionLogStatus;
  summary: string;
  details?: string;
}


