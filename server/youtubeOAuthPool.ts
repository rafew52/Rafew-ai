import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { google, type youtube_v3 } from 'googleapis';
import type {
  YouTubeChannelInfo,
  YouTubeOAuthPoolSummary,
  YouTubeOAuthSlotPublic,
  YouTubeOAuthSlotStatus,
} from '../src/types.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const POOL_FILE = path.join(DATA_DIR, 'youtube_oauth_pool.json');
const STATE_SECRET_FILE = path.join(DATA_DIR, '.oauth_state_secret');

export const YOUTUBE_FULL_SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];

const DAILY_QUOTA_LIMIT = 10_000;

interface StoredOAuthCredentialSlot {
  id: string;
  label: string;
  authType: 'oauth2_credentials' | 'firebase_token';
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  accessToken?: string;
  refreshToken?: string;
  expiryDateMs?: number;
  status: YouTubeOAuthSlotStatus;
  quotaUnitsUsedToday: number;
  dailyQuotaLimit: number;
  quotaDatePt: string;
  quotaExhaustedAt?: string;
  lastUsedAt?: string;
  lastError?: string;
  channel: YouTubeChannelInfo | null;
  createdAt: string;
}

interface SignedOAuthStatePayload {
  slotId: string;
  redirectUri: string;
  nonce: string;
  exp: number;
}

export class AllYouTubeQuotaExhaustedError extends Error {
  constructor(
    message = 'All YouTube OAuth quota slots exhausted—queued items preserved for next available slot'
  ) {
    super(message);
    this.name = 'AllYouTubeQuotaExhaustedError';
  }
}

let slots: StoredOAuthCredentialSlot[] = [];
const usedStateNonces = new Map<string, number>();
let cachedStateSecret: string | null = null;
let poolInitialized = false;

function getOAuthStateSecret(): string {
  if (cachedStateSecret) return cachedStateSecret;
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  try {
    if (fs.existsSync(STATE_SECRET_FILE)) {
      const existing = fs.readFileSync(STATE_SECRET_FILE, 'utf-8').trim();
      if (existing.length >= 32) {
        cachedStateSecret = existing;
        return existing;
      }
    }
  } catch {
    // regenerate below
  }
  const fresh = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(STATE_SECRET_FILE, fresh, 'utf-8');
  } catch {
    // fallback in memory if write fails
  }
  cachedStateSecret = fresh;
  return fresh;
}

function signOAuthState(payload: SignedOAuthStatePayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', getOAuthStateSecret())
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

function verifyOAuthState(stateToken: string): SignedOAuthStatePayload | null {
  const parts = stateToken.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  if (!encoded || !sig) return null;

  const expectedSig = crypto
    .createHmac('sha256', getOAuthStateSecret())
    .update(encoded)
    .digest('base64url');

  const sigBuf = Buffer.from(sig, 'utf-8');
  const expectedBuf = Buffer.from(expectedSig, 'utf-8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf-8')
    ) as SignedOAuthStatePayload;
    if (
      !parsed ||
      typeof parsed.slotId !== 'string' ||
      typeof parsed.redirectUri !== 'string' ||
      typeof parsed.nonce !== 'string' ||
      typeof parsed.exp !== 'number'
    ) {
      return null;
    }
    if (Date.now() > parsed.exp) {
      return null;
    }
    if (usedStateNonces.has(parsed.nonce)) {
      return null;
    }
    // Prune old nonces and mark current nonce used
    const now = Date.now();
    for (const [n, exp] of usedStateNonces.entries()) {
      if (exp < now) usedStateNonces.delete(n);
    }
    usedStateNonces.set(parsed.nonce, parsed.exp);
    return parsed;
  } catch {
    return null;
  }
}

function getPacificDateKey(date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function getDefaultYouTubeOAuthRedirectUri(fallbackOrigin?: string): string {
  const appUrl = process.env.APP_URL?.trim().replace(/\/+$/, '');
  const base = appUrl || (fallbackOrigin ? fallbackOrigin.replace(/\/+$/, '') : 'http://localhost:3000');
  return `${base}/api/youtube/oauth/callback`;
}

function maskClientId(clientId?: string): string | undefined {
  if (!clientId) return undefined;
  const trimmed = clientId.trim();
  if (trimmed.length <= 16) return `${trimmed.slice(0, 4)}***`;
  return `${trimmed.slice(0, 10)}...${trimmed.slice(-18)}`;
}

function savePool() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  // Persist both OAuth2 credential slots and metadata (avoid storing transient firebase accessToken on disk)
  const sanitized = slots.map((s) =>
    s.authType === 'firebase_token'
      ? { ...s, accessToken: undefined, refreshToken: undefined }
      : s
  );
  fs.writeFileSync(POOL_FILE, JSON.stringify({ slots: sanitized }, null, 2), 'utf-8');
}

function rollQuotaDayIfNeeded() {
  const todayPt = getPacificDateKey();
  let changed = false;
  for (const s of slots) {
    if (s.quotaDatePt !== todayPt) {
      s.quotaDatePt = todayPt;
      s.quotaUnitsUsedToday = 0;
      if (s.status === 'quota_exhausted') {
        s.status =
          s.authType === 'oauth2_credentials'
            ? s.accessToken || s.refreshToken
              ? 'active_ready'
              : 'needs_reauth'
            : s.accessToken
            ? 'active_ready'
            : 'needs_reauth';
        s.quotaExhaustedAt = undefined;
        s.lastError = undefined;
      }
      changed = true;
    }
  }
  if (changed) {
    savePool();
  }
}

export function initYouTubeOAuthPool() {
  if (poolInitialized) return;
  poolInitialized = true;
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(POOL_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(POOL_FILE, 'utf-8')) as {
        slots?: StoredOAuthCredentialSlot[];
      };
      if (Array.isArray(parsed.slots)) {
        const todayPt = getPacificDateKey();
        slots = parsed.slots
          .filter((s) => s && typeof s.id === 'string')
          .map((s) => {
            const next: StoredOAuthCredentialSlot = {
              ...s,
              quotaDatePt: s.quotaDatePt || todayPt,
              quotaUnitsUsedToday: Number.isFinite(s.quotaUnitsUsedToday)
                ? s.quotaUnitsUsedToday
                : 0,
              dailyQuotaLimit: Number.isFinite(s.dailyQuotaLimit)
                ? s.dailyQuotaLimit
                : DAILY_QUOTA_LIMIT,
              channel: s.channel ?? null,
            };
            if (next.authType === 'firebase_token' && !next.accessToken) {
              next.status = 'needs_reauth';
            }
            return next;
          });
      }
    }
  } catch {
    slots = [];
  }
  rollQuotaDayIfNeeded();
}

function ensureInitialized() {
  if (!poolInitialized) {
    initYouTubeOAuthPool();
  } else {
    rollQuotaDayIfNeeded();
  }
}

function toPublicSlot(s: StoredOAuthCredentialSlot): YouTubeOAuthSlotPublic {
  return {
    id: s.id,
    label: s.label,
    authType: s.authType,
    clientIdMasked: maskClientId(s.clientId),
    redirectUri: s.redirectUri,
    hasRefreshToken: Boolean(s.refreshToken),
    hasAccessToken: Boolean(s.accessToken),
    status: s.status,
    quotaUnitsUsedToday: s.quotaUnitsUsedToday,
    dailyQuotaLimit: s.dailyQuotaLimit,
    quotaDatePt: s.quotaDatePt,
    quotaExhaustedAt: s.quotaExhaustedAt,
    lastUsedAt: s.lastUsedAt,
    lastError: s.lastError,
    channel: s.channel,
  };
}

export function getYouTubeOAuthPoolSummary(fallbackOrigin?: string): YouTubeOAuthPoolSummary {
  ensureInitialized();
  const visible = slots.filter(
    (s) => s.authType === 'oauth2_credentials' || Boolean(s.accessToken || s.channel)
  );
  const ready = visible.filter((s) => s.status === 'active_ready');
  const exhausted = visible.filter((s) => s.status === 'quota_exhausted');
  const estimatedRemainingQuota = ready.reduce(
    (sum, s) => sum + Math.max(0, s.dailyQuotaLimit - s.quotaUnitsUsedToday),
    0
  );

  return {
    slots: visible.map(toPublicSlot),
    readyCount: ready.length,
    exhaustedCount: exhausted.length,
    totalCount: visible.length,
    estimatedRemainingQuota,
    defaultRedirectUri: getDefaultYouTubeOAuthRedirectUri(fallbackOrigin),
  };
}

export function hasAnyUsableYouTubeOAuthSlot(): boolean {
  ensureInitialized();
  return slots.some(
    (s) => s.status === 'active_ready' && Boolean(s.accessToken || s.refreshToken)
  );
}

export function upsertFirebaseSlotInPool(
  slotNumber: number,
  accessToken: string,
  channel: YouTubeChannelInfo | null
) {
  ensureInitialized();
  const id = `firebase_slot_${slotNumber}`;
  const existing = slots.find((s) => s.id === id);
  const todayPt = getPacificDateKey();

  if (existing) {
    existing.accessToken = accessToken;
    existing.channel = channel;
    existing.status = 'active_ready';
    existing.quotaExhaustedAt = undefined;
    existing.lastError = undefined;
    if (existing.quotaDatePt !== todayPt) {
      existing.quotaDatePt = todayPt;
      existing.quotaUnitsUsedToday = 0;
    }
  } else {
    slots.push({
      id,
      label: `Quick OAuth Slot #${slotNumber}`,
      authType: 'firebase_token',
      accessToken,
      status: 'active_ready',
      quotaUnitsUsedToday: 0,
      dailyQuotaLimit: DAILY_QUOTA_LIMIT,
      quotaDatePt: todayPt,
      channel,
      createdAt: new Date().toISOString(),
    });
  }
  savePool();
}

export function markFirebaseSlotExpiredInPool(slotNumber?: number) {
  ensureInitialized();
  for (const s of slots) {
    if (s.authType !== 'firebase_token') continue;
    if (slotNumber !== undefined && s.id !== `firebase_slot_${slotNumber}`) continue;
    s.accessToken = undefined;
    s.status = 'needs_reauth';
    s.lastError = 'OAuth session token expired. Reconnect via Google Sign-In.';
  }
  savePool();
}

export function removeFirebaseSlotFromPool(slotNumber?: number) {
  ensureInitialized();
  if (slotNumber !== undefined) {
    slots = slots.filter((s) => s.id !== `firebase_slot_${slotNumber}`);
  } else {
    slots = slots.filter((s) => s.authType !== 'firebase_token');
  }
  savePool();
}

export function addOAuthPoolCredential(params: {
  label?: string;
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
}): YouTubeOAuthSlotPublic {
  ensureInitialized();
  const clientId = params.clientId.trim();
  const clientSecret = params.clientSecret.trim();
  if (!clientId || !clientId.includes('.apps.googleusercontent.com')) {
    throw new Error('Enter a valid Google OAuth2 Client ID (ending in .apps.googleusercontent.com).');
  }
  if (!clientSecret || clientSecret.length < 8) {
    throw new Error('Enter a valid Google OAuth2 Client Secret.');
  }

  const duplicate = slots.find(
    (s) => s.authType === 'oauth2_credentials' && s.clientId === clientId
  );
  if (duplicate) {
    duplicate.label = params.label?.trim() || duplicate.label;
    duplicate.clientSecret = clientSecret;
    duplicate.redirectUri =
      params.redirectUri?.trim() ||
      duplicate.redirectUri ||
      getDefaultYouTubeOAuthRedirectUri();
    savePool();
    return toPublicSlot(duplicate);
  }

  const count = slots.filter((s) => s.authType === 'oauth2_credentials').length;
  const slot: StoredOAuthCredentialSlot = {
    id: `yt_proj_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    label: params.label?.trim() || `Google Cloud Project #${count + 1}`,
    authType: 'oauth2_credentials',
    clientId,
    clientSecret,
    redirectUri: params.redirectUri?.trim() || getDefaultYouTubeOAuthRedirectUri(),
    status: 'needs_reauth',
    quotaUnitsUsedToday: 0,
    dailyQuotaLimit: DAILY_QUOTA_LIMIT,
    quotaDatePt: getPacificDateKey(),
    channel: null,
    createdAt: new Date().toISOString(),
  };
  slots.push(slot);
  savePool();
  return toPublicSlot(slot);
}

export function deleteOAuthPoolCredential(id: string): boolean {
  ensureInitialized();
  const prevLen = slots.length;
  slots = slots.filter((s) => s.id !== id);
  if (slots.length !== prevLen) {
    savePool();
    return true;
  }
  return false;
}

export function resetOAuthSlotQuota(id: string): YouTubeOAuthSlotPublic | null {
  ensureInitialized();
  const slot = slots.find((s) => s.id === id);
  if (!slot) return null;
  slot.quotaUnitsUsedToday = 0;
  slot.quotaExhaustedAt = undefined;
  slot.lastError = undefined;
  slot.status =
    slot.accessToken || slot.refreshToken ? 'active_ready' : 'needs_reauth';
  savePool();
  return toPublicSlot(slot);
}

export function buildOAuthConsentUrl(slotId: string, fallbackOrigin?: string): string {
  ensureInitialized();
  const slot = slots.find((s) => s.id === slotId);
  if (!slot || slot.authType !== 'oauth2_credentials') {
    throw new Error('OAuth2 credential slot not found.');
  }
  if (!slot.clientId || !slot.clientSecret) {
    throw new Error('Client ID and Client Secret are missing for this slot.');
  }

  const redirectUri = slot.redirectUri || getDefaultYouTubeOAuthRedirectUri(fallbackOrigin);
  const oauth2Client = new google.auth.OAuth2(slot.clientId, slot.clientSecret, redirectUri);

  const stateToken = signOAuthState({
    slotId: slot.id,
    redirectUri,
    nonce: crypto.randomBytes(12).toString('hex'),
    exp: Date.now() + 20 * 60_000,
  });

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent select_account',
    include_granted_scopes: true,
    scope: YOUTUBE_FULL_SCOPES,
    state: stateToken,
  });
}

export async function handleOAuthCallback(params: {
  code?: string;
  state?: string;
  error?: string;
}): Promise<{ slotId: string; label: string; channel: YouTubeChannelInfo }> {
  ensureInitialized();
  if (params.error) {
    throw new Error(`Google OAuth consent declined or errored: ${params.error}`);
  }
  if (!params.code || !params.state) {
    throw new Error('Missing authorization code or state parameter in OAuth callback.');
  }

  const pending = verifyOAuthState(params.state);
  if (!pending) {
    throw new Error('OAuth state token is invalid, already used, or expired. Click Authorize again from Setup.');
  }

  const slot = slots.find((s) => s.id === pending.slotId);
  if (!slot || !slot.clientId || !slot.clientSecret) {
    throw new Error('Target OAuth2 credential slot no longer exists.');
  }

  const oauth2Client = new google.auth.OAuth2(
    slot.clientId,
    slot.clientSecret,
    pending.redirectUri
  );

  try {
    const { tokens } = await oauth2Client.getToken(params.code);
    if (!tokens.access_token) {
      throw new Error('Google OAuth token exchange did not return an access_token.');
    }

    oauth2Client.setCredentials(tokens);
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    const chRes = await youtube.channels.list({
      part: ['snippet'],
      mine: true,
    });
    const first = chRes.data.items?.[0];
    if (!first?.id) {
      throw new Error('No YouTube channel found on the authorized Google account.');
    }

    const channel: YouTubeChannelInfo = {
      id: first.id,
      title: first.snippet?.title || 'YouTube Channel',
      customUrl: first.snippet?.customUrl || undefined,
      thumbnailUrl: first.snippet?.thumbnails?.default?.url || undefined,
    };

    slot.accessToken = tokens.access_token;
    if (tokens.refresh_token) {
      slot.refreshToken = tokens.refresh_token;
    }
    slot.expiryDateMs = tokens.expiry_date || Date.now() + 3500 * 1000;
    slot.redirectUri = pending.redirectUri;
    slot.channel = channel;
    slot.status = 'active_ready';
    slot.quotaExhaustedAt = undefined;
    slot.lastError = undefined;
    slot.quotaUnitsUsedToday = Math.min(slot.dailyQuotaLimit, slot.quotaUnitsUsedToday + 1);
    savePool();

    return {
      slotId: slot.id,
      label: slot.label,
      channel,
    };
  } catch (err) {
    const details = classifyGoogleError(err);
    slot.status = details.isInvalidClient ? 'invalid_credentials' : 'needs_reauth';
    slot.lastError = details.message;
    savePool();
    throw new Error(details.message);
  }
}

async function createAuthorizedClientForSlot(
  slot: StoredOAuthCredentialSlot
): Promise<youtube_v3.Youtube> {
  if (slot.authType === 'firebase_token') {
    if (!slot.accessToken) {
      throw new Error(`Slot "${slot.label}" does not have an active OAuth access token.`);
    }
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: slot.accessToken });
    return google.youtube({ version: 'v3', auth });
  }

  if (!slot.clientId || !slot.clientSecret) {
    slot.status = 'invalid_credentials';
    slot.lastError = 'Missing OAuth2 Client ID or Client Secret.';
    savePool();
    throw new Error(slot.lastError);
  }

  const oauth2Client = new google.auth.OAuth2(
    slot.clientId,
    slot.clientSecret,
    slot.redirectUri || getDefaultYouTubeOAuthRedirectUri()
  );

  const needsRefresh =
    !slot.accessToken ||
    (typeof slot.expiryDateMs === 'number' && slot.expiryDateMs <= Date.now() + 60_000);

  if (needsRefresh && slot.refreshToken) {
    oauth2Client.setCredentials({ refresh_token: slot.refreshToken });
    const refreshed = await oauth2Client.refreshAccessToken();
    const creds = refreshed.credentials;
    if (creds.access_token) {
      slot.accessToken = creds.access_token;
      if (creds.refresh_token) slot.refreshToken = creds.refresh_token;
      slot.expiryDateMs = creds.expiry_date || Date.now() + 3500 * 1000;
      oauth2Client.setCredentials(creds);
      savePool();
    }
  } else if (slot.accessToken) {
    oauth2Client.setCredentials({
      access_token: slot.accessToken,
      ...(slot.refreshToken ? { refresh_token: slot.refreshToken } : {}),
      ...(slot.expiryDateMs ? { expiry_date: slot.expiryDateMs } : {}),
    });
  } else {
    throw new Error(`Slot "${slot.label}" needs OAuth authorization before use.`);
  }

  return google.youtube({ version: 'v3', auth: oauth2Client });
}

export async function testOAuthPoolSlot(id: string): Promise<{
  ok: boolean;
  slot: YouTubeOAuthSlotPublic;
  message: string;
}> {
  ensureInitialized();
  const slot = slots.find((s) => s.id === id);
  if (!slot) {
    throw new Error('YouTube OAuth slot not found.');
  }

  try {
    const youtube = await createAuthorizedClientForSlot(slot);
    const chRes = await youtube.channels.list({
      part: ['snippet'],
      mine: true,
    });
    slot.quotaUnitsUsedToday = Math.min(slot.dailyQuotaLimit, slot.quotaUnitsUsedToday + 1);
    const first = chRes.data.items?.[0];
    if (first?.id) {
      slot.channel = {
        id: first.id,
        title: first.snippet?.title || slot.channel?.title || 'YouTube Channel',
        customUrl: first.snippet?.customUrl || undefined,
        thumbnailUrl: first.snippet?.thumbnails?.default?.url || undefined,
      };
    }
    slot.status = 'active_ready';
    slot.quotaExhaustedAt = undefined;
    slot.lastError = undefined;
    slot.lastUsedAt = new Date().toISOString();
    savePool();
    return {
      ok: true,
      slot: toPublicSlot(slot),
      message: `Connected cleanly to "${slot.channel?.title || 'YouTube Channel'}" (${slot.quotaUnitsUsedToday}/${slot.dailyQuotaLimit} quota units used today).`,
    };
  } catch (err) {
    const info = classifyGoogleError(err);
    slot.status = info.isQuota
      ? 'quota_exhausted'
      : info.isInvalidClient
      ? 'invalid_credentials'
      : 'needs_reauth';
    if (info.isQuota) {
      slot.quotaExhaustedAt = new Date().toISOString();
    }
    slot.lastError = info.message;
    savePool();
    return {
      ok: false,
      slot: toPublicSlot(slot),
      message: info.message,
    };
  }
}

export function classifyGoogleError(err: unknown): {
  status?: number;
  reason: string;
  message: string;
  isQuota: boolean;
  isAuthError: boolean;
  isInvalidClient: boolean;
  isInsufficientScopes: boolean;
} {
  const anyErr = (err && typeof err === 'object' ? err : {}) as {
    status?: number;
    code?: number;
    message?: string;
    response?: {
      status?: number;
      data?: {
        error?:
          | string
          | {
              message?: string;
              errors?: Array<{ reason?: string; message?: string }>;
            };
        error_description?: string;
      };
    };
  };

  const httpStatus = anyErr.response?.status || anyErr.status || (typeof anyErr.code === 'number' ? anyErr.code : undefined);
  const rawErrData = anyErr.response?.data?.error;
  const oauthErrorCode = typeof rawErrData === 'string' ? rawErrData : '';
  const apiErrorObj = typeof rawErrData === 'object' && rawErrData !== null ? rawErrData : undefined;
  const reason = apiErrorObj?.errors?.[0]?.reason || oauthErrorCode || '';
  const message =
    apiErrorObj?.message ||
    apiErrorObj?.errors?.[0]?.message ||
    anyErr.response?.data?.error_description ||
    anyErr.message ||
    String(err);

  const lower = `${reason} ${message}`.toLowerCase();

  const isQuota =
    reason === 'quotaExceeded' ||
    reason === 'dailyLimitExceeded' ||
    reason === 'uploadLimitExceeded' ||
    reason === 'rateLimitExceeded' ||
    lower.includes('quota exceeded') ||
    lower.includes('daily limit') ||
    lower.includes('ratelimitexceeded') ||
    (httpStatus === 403 && lower.includes('quota'));

  const isInsufficientScopes =
    lower.includes('insufficient') ||
    reason === 'insufficientPermissions' ||
    lower.includes('scope');

  const isInvalidClient =
    oauthErrorCode === 'invalid_client' ||
    oauthErrorCode === 'unauthorized_client' ||
    lower.includes('invalid_client') ||
    lower.includes('deleted_client');

  const isAuthError =
    httpStatus === 401 ||
    oauthErrorCode === 'invalid_grant' ||
    reason === 'authError' ||
    isInvalidClient ||
    (httpStatus === 403 && isInsufficientScopes);

  return {
    status: httpStatus,
    reason,
    message,
    isQuota,
    isAuthError,
    isInvalidClient,
    isInsufficientScopes,
  };
}

export async function executeWithYouTubeOAuthPool<T>(params: {
  operationName: string;
  estimatedQuotaUnits: number;
  preferredSlotId?: string;
  bearerTokenFallback?: string;
  apiKeyFallback?: string;
  onLog?: (level: 'info' | 'warn' | 'success', msg: string) => void;
  fn: (
    youtube: youtube_v3.Youtube,
    slotMeta: { id: string; label: string; authType: string }
  ) => Promise<T>;
}): Promise<{ result: T; slotIdUsed: string; slotLabel: string }> {
  ensureInitialized();

  // Order ready OAuth slots: preferredSlotId first, then OAuth2 credential slots with refresh tokens, sorted by lowest quota used today
  const readySlots = slots
    .filter(
      (s) => s.status === 'active_ready' && Boolean(s.accessToken || s.refreshToken)
    )
    .sort((a, b) => {
      if (params.preferredSlotId) {
        if (a.id === params.preferredSlotId) return -1;
        if (b.id === params.preferredSlotId) return 1;
      }
      if (a.authType !== b.authType) {
        return a.authType === 'oauth2_credentials' ? -1 : 1;
      }
      return a.quotaUnitsUsedToday - b.quotaUnitsUsedToday;
    });

  let quotaFailures = 0;
  let lastError: unknown = null;

  for (const slot of readySlots) {
    try {
      const youtube = await createAuthorizedClientForSlot(slot);
      slot.quotaUnitsUsedToday = Math.min(
        slot.dailyQuotaLimit,
        slot.quotaUnitsUsedToday + Math.max(0, params.estimatedQuotaUnits)
      );
      slot.lastUsedAt = new Date().toISOString();
      savePool();

      const result = await params.fn(youtube, {
        id: slot.id,
        label: slot.label,
        authType: slot.authType,
      });

      return { result, slotIdUsed: slot.id, slotLabel: slot.label };
    } catch (err) {
      lastError = err;
      const info = classifyGoogleError(err);

      // Refresh-and-retry once for OAuth2 credential slots returning 401 before giving up on that slot
      if (
        slot.authType === 'oauth2_credentials' &&
        slot.refreshToken &&
        info.status === 401 &&
        !info.isInvalidClient
      ) {
        try {
          slot.expiryDateMs = 0;
          const refreshedYt = await createAuthorizedClientForSlot(slot);
          const retryResult = await params.fn(refreshedYt, {
            id: slot.id,
            label: slot.label,
            authType: slot.authType,
          });
          slot.lastUsedAt = new Date().toISOString();
          savePool();
          return { result: retryResult, slotIdUsed: slot.id, slotLabel: slot.label };
        } catch (retryErr) {
          lastError = retryErr;
        }
      }

      const finalInfo = classifyGoogleError(lastError);

      if (finalInfo.isQuota) {
        quotaFailures += 1;
        slot.status = 'quota_exhausted';
        slot.quotaExhaustedAt = new Date().toISOString();
        slot.lastError = `${params.operationName}: ${finalInfo.message}`;
        savePool();
        params.onLog?.(
          'warn',
          `YouTube slot "${slot.label}" reached daily quota during ${params.operationName}. Failing over to next healthy slot...`
        );
        continue;
      }

      if (finalInfo.isAuthError) {
        slot.status = finalInfo.isInvalidClient ? 'invalid_credentials' : 'needs_reauth';
        if (finalInfo.isInvalidClient) {
          slot.accessToken = undefined;
        }
        slot.lastError = `${params.operationName}: ${finalInfo.message}`;
        savePool();
        params.onLog?.(
          'warn',
          `YouTube slot "${slot.label}" auth/scope failed (${finalInfo.message}). Rotating to next healthy slot...`
        );
        continue;
      }

      // Non-quota, non-auth error (e.g., 400 publishAt rejection or invalid parameter): bubble straight up
      throw err;
    }
  }

  // Optional one-off bearer token supplied directly in request header (if not already tried via pool)
  if (params.bearerTokenFallback) {
    const alreadyInPool = readySlots.some((s) => s.accessToken === params.bearerTokenFallback);
    if (!alreadyInPool) {
      const auth = new google.auth.OAuth2();
      auth.setCredentials({ access_token: params.bearerTokenFallback });
      const yt = google.youtube({ version: 'v3', auth });
      const result = await params.fn(yt, {
        id: 'request_bearer',
        label: 'Session OAuth Bearer',
        authType: 'firebase_token',
      });
      return { result, slotIdUsed: 'request_bearer', slotLabel: 'Session OAuth Bearer' };
    }
  }

  // Optional server-side API key fallback for read-only calls (search.list / videos.list)
  if (params.apiKeyFallback && quotaFailures === 0) {
    const yt = google.youtube({ version: 'v3', auth: params.apiKeyFallback });
    const result = await params.fn(yt, {
      id: 'api_key',
      label: 'YouTube Public API Key',
      authType: 'api_key',
    });
    return { result, slotIdUsed: 'api_key', slotLabel: 'YouTube Public API Key' };
  }

  const allExhausted =
    slots.some((s) => s.status === 'quota_exhausted') &&
    !slots.some((s) => s.status === 'active_ready');

  if (quotaFailures > 0 || allExhausted) {
    throw new AllYouTubeQuotaExhaustedError(
      'All YouTube OAuth quota slots exhausted—queued items preserved for next available slot'
    );
  }

  if (lastError) {
    throw new Error(classifyGoogleError(lastError).message);
  }

  throw new Error(
    'No authorized YouTube OAuth slot is ready. Connect a Google Cloud OAuth2 project or sign in with Google in System Setup.'
  );
}
