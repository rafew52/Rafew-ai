import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type {
  ClipItem,
  ZernioAccount,
  ZernioConnectionSettings,
  ZernioPlatformPostResult,
  ZernioPublishStatus,
  ZernioTikTokOptions,
  ZernioTikTokPrivacyLevel,
  ZernioUploadMode,
} from '../src/types.ts';
import { inspectRenderedClipVideo } from './clipSensor.ts';
import { sanitizeHashtags } from './requirementEngine.ts';

const ZERNIO_API_BASE = 'https://zernio.com/api';
const DATA_DIR = path.resolve(process.cwd(), 'data');
const STREAMS_DIR = path.join(DATA_DIR, 'streams');
const MANUAL_CLIPS_DIR = path.join(DATA_DIR, 'manual_clips');
const ZERNIO_SETTINGS_FILE = path.join(DATA_DIR, 'zernio_settings.json');

interface PersistedZernioStore {
  apiKey: string;
  connected: boolean;
  autoUploadEnabled: boolean;
  uploadMode: ZernioUploadMode;
  accounts: Omit<ZernioAccount, 'selectedForUpload'>[];
  selectedAccountIds: string[];
  tiktokOptions: ZernioTikTokOptions;
  connectedAt?: string;
  lastSyncedAt?: string;
  lastError?: string;
}

interface PendingDeviceAuth {
  deviceCode: string;
  userCode: string;
  browserUrl: string;
  expiresAtMs: number;
  intervalSeconds: number;
  lastPollAtMs: number;
}

const DEFAULT_TIKTOK_OPTIONS: ZernioTikTokOptions = {
  draft: false,
  privacyLevel: 'PUBLIC_TO_EVERYONE',
  allowComment: true,
  allowDuet: true,
  allowStitch: true,
  videoCoverTimestampMs: 1000,
};

const DEFAULT_STORE: PersistedZernioStore = {
  apiKey: '',
  connected: false,
  autoUploadEnabled: false,
  uploadMode: 'publish_now',
  accounts: [],
  selectedAccountIds: [],
  tiktokOptions: { ...DEFAULT_TIKTOK_OPTIONS },
};

let store: PersistedZernioStore = { ...DEFAULT_STORE };
let pendingDeviceAuth: PendingDeviceAuth | null = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function saveStore() {
  ensureDir();
  fs.writeFileSync(ZERNIO_SETTINGS_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

function resolveActiveApiKey(): string {
  const fromEnv = process.env.ZERNIO_API_KEY?.trim() || '';
  if (fromEnv) return fromEnv;
  return store.apiKey.trim();
}

function maskSecret(val: string): string | undefined {
  const trimmed = val.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}***`;
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

function normalizePrivacyLevel(raw: unknown): ZernioTikTokPrivacyLevel {
  if (
    raw === 'PUBLIC_TO_EVERYONE' ||
    raw === 'MUTUAL_FOLLOW_FRIENDS' ||
    raw === 'FOLLOWER_OF_CREATOR' ||
    raw === 'SELF_ONLY'
  ) {
    return raw;
  }
  return 'PUBLIC_TO_EVERYONE';
}

function normalizeTikTokOptions(raw?: Partial<ZernioTikTokOptions>): ZernioTikTokOptions {
  return {
    draft: typeof raw?.draft === 'boolean' ? raw.draft : store.tiktokOptions.draft,
    privacyLevel: raw?.privacyLevel
      ? normalizePrivacyLevel(raw.privacyLevel)
      : store.tiktokOptions.privacyLevel,
    allowComment:
      typeof raw?.allowComment === 'boolean'
        ? raw.allowComment
        : store.tiktokOptions.allowComment,
    allowDuet:
      typeof raw?.allowDuet === 'boolean' ? raw.allowDuet : store.tiktokOptions.allowDuet,
    allowStitch:
      typeof raw?.allowStitch === 'boolean'
        ? raw.allowStitch
        : store.tiktokOptions.allowStitch,
    videoCoverTimestampMs:
      typeof raw?.videoCoverTimestampMs === 'number' && Number.isFinite(raw.videoCoverTimestampMs)
        ? Math.max(0, Math.round(raw.videoCoverTimestampMs))
        : store.tiktokOptions.videoCoverTimestampMs,
  };
}

function normalizeAccountRecord(raw: Record<string, unknown>): Omit<ZernioAccount, 'selectedForUpload'> | null {
  const id =
    (typeof raw._id === 'string' && raw._id.trim()) ||
    (typeof raw.id === 'string' && raw.id.trim()) ||
    '';
  const platform =
    typeof raw.platform === 'string' && raw.platform.trim()
      ? raw.platform.trim().toLowerCase()
      : '';
  if (!id || !platform) return null;

  let profileId: string | undefined;
  if (typeof raw.profileId === 'string') {
    profileId = raw.profileId;
  } else if (raw.profileId && typeof raw.profileId === 'object') {
    const profObj = raw.profileId as Record<string, unknown>;
    if (typeof profObj._id === 'string') profileId = profObj._id;
    else if (typeof profObj.id === 'string') profileId = profObj.id;
  }

  const username =
    typeof raw.username === 'string' && raw.username.trim()
      ? raw.username.trim()
      : undefined;
  const displayName =
    (typeof raw.displayName === 'string' && raw.displayName.trim()) ||
    (typeof raw.name === 'string' && raw.name.trim()) ||
    username;
  const profilePicture =
    (typeof raw.profilePicture === 'string' && raw.profilePicture.trim()) ||
    (typeof raw.avatarUrl === 'string' && raw.avatarUrl.trim()) ||
    (typeof raw.picture === 'string' && raw.picture.trim()) ||
    undefined;

  const ttType =
    raw.tiktokAccountType === 'business' ||
    raw.tiktokAccountType === 'personal' ||
    raw.tiktokAccountType === 'unknown'
      ? raw.tiktokAccountType
      : undefined;

  return {
    id,
    platform,
    username,
    displayName,
    profilePicture,
    profileId,
    isActive: raw.isActive !== false,
    ...(ttType ? { tiktokAccountType: ttType } : {}),
  };
}

export function initZernioSettings() {
  ensureDir();
  try {
    if (fs.existsSync(ZERNIO_SETTINGS_FILE)) {
      const parsed = JSON.parse(
        fs.readFileSync(ZERNIO_SETTINGS_FILE, 'utf-8')
      ) as Partial<PersistedZernioStore>;
      store = {
        apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '',
        connected: Boolean(parsed.connected),
        autoUploadEnabled: Boolean(parsed.autoUploadEnabled),
        uploadMode: parsed.uploadMode === 'draft' ? 'draft' : 'publish_now',
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
        selectedAccountIds: Array.isArray(parsed.selectedAccountIds)
          ? parsed.selectedAccountIds.filter((id): id is string => typeof id === 'string')
          : [],
        tiktokOptions: {
          ...DEFAULT_TIKTOK_OPTIONS,
          ...(parsed.tiktokOptions || {}),
          privacyLevel: normalizePrivacyLevel(parsed.tiktokOptions?.privacyLevel),
        },
        connectedAt: parsed.connectedAt,
        lastSyncedAt: parsed.lastSyncedAt,
        lastError: parsed.lastError,
      };
    }
  } catch {
    store = { ...DEFAULT_STORE };
  }

  const apiKey = resolveActiveApiKey();
  if (apiKey) {
    process.env.ZERNIO_API_KEY = apiKey;
    store.apiKey = apiKey;
    store.connected = true;
    void refreshZernioAccounts().catch(() => {
      // ignore offline startup sync errors; status will retain lastError cleanly
    });
  }
}

export function getZernioSettings(): ZernioConnectionSettings {
  const apiKey = resolveActiveApiKey();
  const hasApiKey = Boolean(apiKey);
  const selectedSet = new Set(store.selectedAccountIds);

  const accounts: ZernioAccount[] = store.accounts.map((acc) => ({
    ...acc,
    selectedForUpload: selectedSet.has(acc.id),
  }));

  const hasTikTokAccount = accounts.some(
    (acc) => acc.platform.toLowerCase() === 'tiktok'
  );

  return {
    connected: Boolean(store.connected && hasApiKey),
    hasApiKey,
    apiKeyMasked: maskSecret(apiKey),
    autoUploadEnabled: Boolean(store.autoUploadEnabled && hasApiKey),
    uploadMode: store.uploadMode,
    accounts,
    selectedAccountIds: accounts
      .filter((acc) => acc.selectedForUpload)
      .map((acc) => acc.id),
    hasTikTokAccount,
    tiktokOptions: { ...store.tiktokOptions },
    connectedAt: store.connectedAt,
    lastSyncedAt: store.lastSyncedAt,
    lastError: store.lastError,
  };
}

export function hasActiveZernioAuth(): boolean {
  return Boolean(store.connected && resolveActiveApiKey());
}

export function hasSelectedZernioTargets(): boolean {
  return (
    hasActiveZernioAuth() &&
    store.accounts.some(
      (a) => a.isActive && store.selectedAccountIds.includes(a.id)
    )
  );
}

async function fetchZernioAccountsWithKey(
  apiKey: string
): Promise<Omit<ZernioAccount, 'selectedForUpload'>[]> {
  const res = await fetch(`${ZERNIO_API_BASE}/v1/accounts`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });

  const rawText = await res.text().catch(() => '');
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed)) {
      body = { accounts: parsed };
    } else if (parsed && typeof parsed === 'object') {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = null;
  }

  if (!res.ok) {
    const errMsg =
      (typeof body?.error === 'string' && body.error) ||
      (typeof body?.message === 'string' && body.message) ||
      `Zernio returned HTTP ${res.status}`;
    throw new Error(`Zernio authentication/account sync failed: ${errMsg}`);
  }

  const rawList = Array.isArray(body?.accounts)
    ? body.accounts
    : Array.isArray(body?.data)
    ? body.data
    : [];

  const normalized: Omit<ZernioAccount, 'selectedForUpload'>[] = [];
  for (const item of rawList) {
    if (item && typeof item === 'object') {
      const acc = normalizeAccountRecord(item as Record<string, unknown>);
      if (acc) normalized.push(acc);
    }
  }

  return normalized;
}

function mergeAccountsIntoStore(
  accounts: Omit<ZernioAccount, 'selectedForUpload'>[],
  preserveExistingSelection: boolean
) {
  const previousIds = new Set(store.accounts.map((a) => a.id));
  const previousSelected = new Set(store.selectedAccountIds);

  if (!preserveExistingSelection || store.accounts.length === 0) {
    store.selectedAccountIds = accounts
      .filter((a) => a.isActive)
      .map((a) => a.id);
  } else {
    const nextSelected: string[] = [];
    for (const acc of accounts) {
      if (previousSelected.has(acc.id)) {
        nextSelected.push(acc.id);
      } else if (!previousIds.has(acc.id) && acc.isActive) {
        // Newly added Zernio account automatically included
        nextSelected.push(acc.id);
      }
    }
    store.selectedAccountIds = nextSelected;
  }

  store.accounts = accounts;
  store.lastSyncedAt = new Date().toISOString();
  store.lastError = undefined;
}

export async function refreshZernioAccounts(): Promise<ZernioConnectionSettings> {
  const apiKey = resolveActiveApiKey();
  if (!apiKey) {
    throw new Error('Zernio is not connected. Click Sign in with Zernio first.');
  }
  try {
    const accounts = await fetchZernioAccountsWithKey(apiKey);
    store.connected = true;
    mergeAccountsIntoStore(accounts, true);
    saveStore();
    return getZernioSettings();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to refresh Zernio accounts.';
    store.lastError = msg;
    saveStore();
    throw new Error(msg);
  }
}

export async function initiateZernioDeviceAuth(): Promise<{
  userCode: string;
  browserUrl: string;
  expiresAt: string;
  intervalSeconds: number;
}> {
  const res = await fetch(`${ZERNIO_API_BASE}/auth/cli/initiate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ deviceName: 'Clips ai' }),
    signal: AbortSignal.timeout(15_000),
  });

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg =
      (typeof data.error === 'string' && data.error) ||
      (typeof data.message === 'string' && data.message) ||
      `Zernio auth initiation failed (HTTP ${res.status}).`;
    throw new Error(msg);
  }

  const deviceCode = typeof data.deviceCode === 'string' ? data.deviceCode.trim() : '';
  const userCode = typeof data.userCode === 'string' ? data.userCode.trim() : '';
  const browserUrl = typeof data.browserUrl === 'string' ? data.browserUrl.trim() : '';
  const intervalSeconds = Math.max(
    5,
    typeof data.interval === 'number' && Number.isFinite(data.interval) ? data.interval : 5
  );
  const expiresAt =
    typeof data.expiresAt === 'string' && data.expiresAt
      ? data.expiresAt
      : new Date(Date.now() + 10 * 60_000).toISOString();

  if (!deviceCode || !browserUrl) {
    throw new Error('Zernio returned an incomplete authorization challenge.');
  }

  let validatedBrowserUrl: string;
  try {
    const parsed = new URL(browserUrl);
    if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('zernio.com')) {
      throw new Error('Unexpected Zernio authorization host.');
    }
    validatedBrowserUrl = parsed.toString();
  } catch {
    throw new Error('Zernio returned an invalid authorization URL.');
  }

  pendingDeviceAuth = {
    deviceCode,
    userCode,
    browserUrl: validatedBrowserUrl,
    expiresAtMs: new Date(expiresAt).getTime() || Date.now() + 10 * 60_000,
    intervalSeconds,
    lastPollAtMs: 0,
  };

  return {
    userCode,
    browserUrl: validatedBrowserUrl,
    expiresAt,
    intervalSeconds,
  };
}

export async function pollZernioDeviceAuth(): Promise<{
  status: 'pending' | 'authorized' | 'expired' | 'idle';
  retryAfterSeconds?: number;
  zernio?: ZernioConnectionSettings;
  message?: string;
}> {
  if (!pendingDeviceAuth) {
    if (hasActiveZernioAuth()) {
      return { status: 'authorized', zernio: getZernioSettings() };
    }
    return { status: 'idle', message: 'No pending Zernio authorization session.' };
  }

  if (Date.now() >= pendingDeviceAuth.expiresAtMs) {
    pendingDeviceAuth = null;
    return {
      status: 'expired',
      message: 'Zernio authorization code expired. Click Sign in with Zernio again.',
    };
  }

  const minWaitMs = Math.max(4000, pendingDeviceAuth.intervalSeconds * 1000 - 500);
  const elapsedMs = Date.now() - pendingDeviceAuth.lastPollAtMs;
  if (pendingDeviceAuth.lastPollAtMs > 0 && elapsedMs < minWaitMs) {
    return {
      status: 'pending',
      retryAfterSeconds: Math.ceil((minWaitMs - elapsedMs) / 1000),
    };
  }

  pendingDeviceAuth.lastPollAtMs = Date.now();
  const res = await fetch(`${ZERNIO_API_BASE}/auth/cli/poll`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${pendingDeviceAuth.deviceCode}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const remoteStatus =
    typeof data.status === 'string' ? data.status.toLowerCase().trim() : '';

  if (remoteStatus === 'authorized' && typeof data.apiKey === 'string' && data.apiKey.trim()) {
    const newApiKey = data.apiKey.trim();
    // Clear deviceCode immediately so the one-time API key response is never polled again
    pendingDeviceAuth = null;

    process.env.ZERNIO_API_KEY = newApiKey;
    store.apiKey = newApiKey;
    store.connected = true;
    store.connectedAt = new Date().toISOString();
    store.lastError = undefined;

    try {
      const accounts = await fetchZernioAccountsWithKey(newApiKey);
      mergeAccountsIntoStore(accounts, false);
    } catch (syncErr) {
      store.lastError =
        syncErr instanceof Error ? syncErr.message : 'Connected, but account sync failed.';
    }

    saveStore();
    return {
      status: 'authorized',
      zernio: getZernioSettings(),
    };
  }

  if (remoteStatus === 'expired' || remoteStatus === 'denied' || res.status === 410) {
    pendingDeviceAuth = null;
    return {
      status: 'expired',
      message: 'Zernio authorization expired or was denied.',
    };
  }

  if (!res.ok && res.status !== 202 && res.status !== 400 && res.status !== 428) {
    const errMsg =
      (typeof data.error === 'string' && data.error) ||
      (typeof data.message === 'string' && data.message) ||
      `Zernio poll failed (HTTP ${res.status}).`;
    throw new Error(errMsg);
  }

  return {
    status: 'pending',
    retryAfterSeconds: pendingDeviceAuth.intervalSeconds,
  };
}

export async function connectZernioWithApiKey(
  rawApiKey: string
): Promise<ZernioConnectionSettings> {
  const apiKey = rawApiKey.trim();
  if (!apiKey || apiKey.length < 12) {
    throw new Error('Paste a valid Zernio API key.');
  }

  const accounts = await fetchZernioAccountsWithKey(apiKey);
  pendingDeviceAuth = null;

  process.env.ZERNIO_API_KEY = apiKey;
  store.apiKey = apiKey;
  store.connected = true;
  store.connectedAt = new Date().toISOString();
  mergeAccountsIntoStore(accounts, false);
  saveStore();
  return getZernioSettings();
}

export function updateZernioSettings(patch: {
  autoUploadEnabled?: boolean;
  uploadMode?: ZernioUploadMode;
  selectedAccountIds?: string[];
  tiktokOptions?: Partial<ZernioTikTokOptions>;
}): ZernioConnectionSettings {
  if (patch.uploadMode === 'publish_now' || patch.uploadMode === 'draft') {
    store.uploadMode = patch.uploadMode;
  }

  if (Array.isArray(patch.selectedAccountIds)) {
    const validIds = new Set(store.accounts.map((a) => a.id));
    store.selectedAccountIds = Array.from(
      new Set(patch.selectedAccountIds.filter((id) => validIds.has(id)))
    );
  }

  if (patch.tiktokOptions) {
    store.tiktokOptions = normalizeTikTokOptions(patch.tiktokOptions);
  }

  if (typeof patch.autoUploadEnabled === 'boolean') {
    if (patch.autoUploadEnabled) {
      if (!hasActiveZernioAuth()) {
        throw new Error('Sign in with Zernio first before enabling Auto-Upload.');
      }
      if (store.selectedAccountIds.length === 0) {
        throw new Error('Select at least one connected Zernio account before enabling Auto-Upload.');
      }
    }
    store.autoUploadEnabled = patch.autoUploadEnabled;
  }

  store.lastError = undefined;
  saveStore();
  return getZernioSettings();
}

export function disconnectZernio(): ZernioConnectionSettings {
  pendingDeviceAuth = null;
  delete process.env.ZERNIO_API_KEY;
  store.apiKey = '';
  store.connected = false;
  store.autoUploadEnabled = false;
  store.accounts = [];
  store.selectedAccountIds = [];
  store.connectedAt = undefined;
  store.lastSyncedAt = undefined;
  store.lastError = undefined;
  saveStore();
  return getZernioSettings();
}

function buildCaptionWithBD(clip: ClipItem): {
  hashtags: string[];
  caption: string;
} {
  const isGta = /gta|grand theft auto/i.test(`${clip.streamLabel} ${clip.title} ${clip.description}`);
  const uniqueTags = sanitizeHashtags(Array.isArray(clip.hashtags) ? clip.hashtags : [], {
    isGtaContext: isGta,
    formatMode: clip.formatMode,
    momentCategory: clip.category,
  });
  const cleanTitle = clip.title.trim().slice(0, 80);
  const cleanDesc = clip.description.trim();
  const hasTagsInDesc = /#bd\b/i.test(cleanDesc);
  const full = hasTagsInDesc
    ? [cleanTitle, cleanDesc].filter(Boolean).join('\n\n')
    : [cleanTitle, cleanDesc, uniqueTags.join(' ')].filter(Boolean).join('\n\n');

  return {
    hashtags: uniqueTags,
    caption: full.slice(0, 2200),
  };
}

function buildShortTweetCopy(clip: ClipItem, hashtags: string[]): string {
  const bdIndex = hashtags.find((t) => t.toLowerCase() === '#bd') || '#BD';
  const extraTags = hashtags
    .filter((t) => t.toLowerCase() !== '#bd')
    .slice(0, 2)
    .join(' ');
  const tail = [bdIndex, extraTags].filter(Boolean).join(' ');
  const maxBody = Math.max(40, 275 - tail.length - 2);
  const body = clip.title.trim().slice(0, maxBody);
  return `${body}\n\n${tail}`.slice(0, 280);
}

async function presignAndUploadMp4(
  apiKey: string,
  resolvedFilePath: string,
  clipId: string
): Promise<string> {
  const fileBuffer = await fs.promises.readFile(resolvedFilePath);
  if (fileBuffer.byteLength === 0) {
    throw new Error('Rendered MP4 file is empty (0 bytes).');
  }

  const safeName = `${path.basename(resolvedFilePath).replace(/[^a-zA-Z0-9._-]/g, '_') || `${clipId}.mp4`}`;
  const presignRes = await fetch(`${ZERNIO_API_BASE}/v1/media/presign`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      filename: safeName,
      contentType: 'video/mp4',
      size: fileBuffer.byteLength,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const presignData = (await presignRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (!presignRes.ok) {
    const errMsg =
      (typeof presignData.error === 'string' && presignData.error) ||
      (typeof presignData.message === 'string' && presignData.message) ||
      `Zernio media presign failed (HTTP ${presignRes.status})`;
    throw new Error(errMsg);
  }

  const uploadUrl =
    typeof presignData.uploadUrl === 'string' ? presignData.uploadUrl.trim() : '';
  const publicUrl =
    typeof presignData.publicUrl === 'string' ? presignData.publicUrl.trim() : '';

  if (!uploadUrl.startsWith('https://') || !publicUrl.startsWith('https://')) {
    throw new Error('Zernio returned an invalid presigned media upload URL.');
  }

  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(fileBuffer.byteLength),
    },
    body: fileBuffer,
    signal: AbortSignal.timeout(180_000),
  });

  if (!putRes.ok) {
    const putErr = await putRes.text().catch(() => '');
    throw new Error(
      `Failed uploading MP4 to Zernio storage (HTTP ${putRes.status})${
        putErr ? `: ${putErr.slice(0, 160)}` : ''
      }`
    );
  }

  return publicUrl;
}

export async function uploadClipToZernio(params: {
  clip: ClipItem;
  clipFilePath: string;
  accountIdsOverride?: string[];
  uploadModeOverride?: ZernioUploadMode;
  skipVisualSensor?: boolean;
  onLog?: (level: 'info' | 'success' | 'warn' | 'error', message: string) => void;
}): Promise<{
  status: ZernioPublishStatus;
  postId: string;
  platformResults: ZernioPlatformPostResult[];
}> {
  const apiKey = resolveActiveApiKey();
  if (!apiKey || !store.connected) {
    throw new Error('Zernio is not connected. Click Sign in with Zernio first.');
  }

  const resolvedFile = path.resolve(params.clipFilePath);
  const inStreams = resolvedFile.startsWith(STREAMS_DIR + path.sep);
  const inManual = resolvedFile.startsWith(MANUAL_CLIPS_DIR + path.sep);
  if ((!inStreams && !inManual) || !fs.existsSync(resolvedFile)) {
    throw new Error('Rendered MP4 file was not found in clip storage.');
  }

  if (!params.skipVisualSensor) {
    const visualReport = await inspectRenderedClipVideo(resolvedFile, {
      enableVisionAudit: true,
    });
    if (!visualReport.passed) {
      const reason =
        visualReport.issues[0] ||
        'Visual Sensor blocked upload: detected black screen, color bars, test pattern, or corrupted video.';
      params.onLog?.('error', `Visual Sensor Blocked Zernio Upload: ${reason}`);
      throw new Error(`Visual Sensor Blocked Upload: ${reason}`);
    }
  }

  // Sync fresh accounts if empty
  if (store.accounts.length === 0) {
    await refreshZernioAccounts();
  }

  const wantedIds =
    Array.isArray(params.accountIdsOverride) && params.accountIdsOverride.length > 0
      ? new Set(params.accountIdsOverride)
      : new Set(store.selectedAccountIds);

  let targetAccounts = store.accounts.filter((a) => a.isActive && wantedIds.has(a.id));
  if (targetAccounts.length === 0 && !params.accountIdsOverride) {
    targetAccounts = store.accounts.filter((a) => a.isActive);
  }

  if (params.clip.aspectMode === 'landscape') {
    const nonTikTok = targetAccounts.filter((a) => a.platform.toLowerCase() !== 'tiktok');
    if (targetAccounts.length > 0 && nonTikTok.length === 0) {
      throw new Error(
        'Selected Zernio target is TikTok, which requires 9:16 vertical clips. Render a 9:16 Short or select another platform.'
      );
    }
    targetAccounts = nonTikTok;
  }

  if (targetAccounts.length === 0) {
    throw new Error(
      'No active Zernio accounts selected for upload. Connect social accounts in Zernio or select targets in Zernio Setup.'
    );
  }

  const mode: ZernioUploadMode = params.uploadModeOverride || store.uploadMode || 'publish_now';
  const { hashtags, caption } = buildCaptionWithBD(params.clip);
  const platformNames = targetAccounts
    .map((a) => `${a.platform}${a.username ? ` (${a.username})` : ''}`)
    .join(', ');

  params.onLog?.(
    'info',
    `Uploading "${params.clip.title}" to Zernio media storage for: ${platformNames}...`
  );

  try {
    const publicMediaUrl = await presignAndUploadMp4(apiKey, resolvedFile, params.clip.id);

    const hasTikTokTarget = targetAccounts.some(
      (a) => a.platform.toLowerCase() === 'tiktok'
    );

    const platformsPayload = targetAccounts.map((acc) => {
      const p = acc.platform.toLowerCase();
      const base: Record<string, unknown> = {
        platform: p,
        accountId: acc.id,
      };

      if (p === 'youtube') {
        base.platformSpecificData = {
          title: params.clip.title.trim().slice(0, 100) || 'GTA VI Highlight Short',
          visibility: 'public',
        };
      } else if (p === 'twitter') {
        base.customContent = buildShortTweetCopy(params.clip, hashtags);
      }

      return base;
    });

    const postBody: Record<string, unknown> = {
      title: params.clip.title.trim().slice(0, 120),
      content: caption,
      mediaItems: [
        {
          type: 'video',
          url: publicMediaUrl,
        },
      ],
      platforms: platformsPayload,
      ...(mode === 'draft' ? { isDraft: true } : { publishNow: true }),
    };

    if (hasTikTokTarget) {
      const tt = store.tiktokOptions;
      postBody.tiktokSettings = {
        draft: Boolean(tt.draft),
        privacyLevel: tt.privacyLevel || 'PUBLIC_TO_EVERYONE',
        allowComment: Boolean(tt.allowComment),
        allowDuet: Boolean(tt.allowDuet),
        allowStitch: Boolean(tt.allowStitch),
        contentPreviewConfirmed: true,
        expressConsentGiven: true,
        mediaType: 'video',
        videoCoverTimestampMs: Math.max(0, Number(tt.videoCoverTimestampMs) || 1000),
      };
    }

    const postRes = await fetch(`${ZERNIO_API_BASE}/v1/posts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify(postBody),
      signal: AbortSignal.timeout(90_000),
    });

    const rawText = await postRes.text().catch(() => '');
    let resJson: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(rawText);
      if (parsed && typeof parsed === 'object') {
        resJson = parsed as Record<string, unknown>;
      }
    } catch {
      resJson = null;
    }

    if (!postRes.ok && postRes.status !== 207) {
      const errMsg =
        (typeof resJson?.error === 'string' && resJson.error) ||
        (typeof resJson?.message === 'string' && resJson.message) ||
        rawText.slice(0, 240) ||
        `Zernio returned HTTP ${postRes.status}`;
      throw new Error(`Zernio post creation failed: ${errMsg}`);
    }

    const postObj =
      resJson?.post && typeof resJson.post === 'object'
        ? (resJson.post as Record<string, unknown>)
        : resJson || {};

    const postId =
      (typeof postObj._id === 'string' && postObj._id) ||
      (typeof postObj.id === 'string' && postObj.id) ||
      (typeof resJson?.id === 'string' && resJson.id) ||
      `zernio_${Date.now()}`;

    const rawPlatforms = Array.isArray(postObj.platforms)
      ? postObj.platforms
      : Array.isArray(resJson?.platforms)
      ? resJson.platforms
      : [];

    const accountMap = new Map(targetAccounts.map((a) => [a.id, a]));
    const platformResults: ZernioPlatformPostResult[] = [];

    for (const item of rawPlatforms) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const accId = typeof rec.accountId === 'string' ? rec.accountId : '';
      const matched = accountMap.get(accId);
      const platform =
        typeof rec.platform === 'string' ? rec.platform : matched?.platform || 'social';
      const status =
        typeof rec.status === 'string'
          ? rec.status
          : mode === 'draft'
          ? 'draft'
          : 'published';
      const urlRaw =
        typeof rec.platformPostUrl === 'string'
          ? rec.platformPostUrl
          : typeof rec.url === 'string'
          ? rec.url
          : undefined;
      const errRaw =
        typeof rec.error === 'string'
          ? rec.error
          : typeof rec.errorMessage === 'string'
          ? rec.errorMessage
          : undefined;

      platformResults.push({
        platform,
        accountId: accId,
        accountName: matched?.displayName || matched?.username,
        status,
        ...(urlRaw ? { platformPostUrl: urlRaw } : {}),
        ...(errRaw ? { error: errRaw } : {}),
      });
    }

    if (platformResults.length === 0) {
      for (const acc of targetAccounts) {
        platformResults.push({
          platform: acc.platform,
          accountId: acc.id,
          accountName: acc.displayName || acc.username,
          status: mode === 'draft' ? 'draft' : 'published',
        });
      }
    }

    const failedTargets = platformResults.filter((r) =>
      r.status.toLowerCase().includes('fail') || Boolean(r.error)
    );
    const succeededTargets = platformResults.filter(
      (r) => !r.status.toLowerCase().includes('fail') && !r.error
    );

    if (failedTargets.length > 0 && succeededTargets.length === 0) {
      const firstErr = failedTargets.map((f) => `${f.platform}: ${f.error || f.status}`).join('; ');
      throw new Error(`Zernio upload failed across all selected platforms — ${firstErr}`);
    }

    const finalStatus: ZernioPublishStatus =
      mode === 'draft'
        ? 'draft_sent'
        : failedTargets.length > 0
        ? 'partial_failed'
        : 'published';

    store.lastError = undefined;
    saveStore();

    params.onLog?.(
      finalStatus === 'partial_failed' ? 'warn' : 'success',
      finalStatus === 'draft_sent'
        ? `Saved clip "${params.clip.title}" as Zernio Draft (${platformNames}).`
        : finalStatus === 'partial_failed'
        ? `Uploaded "${params.clip.title}" via Zernio with partial warnings (${succeededTargets.length}/${platformResults.length} succeeded).`
        : `Published "${params.clip.title}" via Zernio to ${platformNames}!`
    );

    return {
      status: finalStatus,
      postId,
      platformResults,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Zernio upload failed.';
    store.lastError = msg;
    saveStore();
    throw new Error(msg);
  }
}
