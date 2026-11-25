import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import type {
  GeminiApiKeyInfo,
  GeminiKeyPoolSummary,
  GeminiKeyStatus,
} from '../src/types.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const GEMINI_KEYS_FILE = path.join(DATA_DIR, 'gemini_keys.json');

export const MAX_USER_GEMINI_KEYS = 10;
export const COOLDOWN_429_MS = 45_000;
export const COOLDOWN_503_MS = 30_000;

interface PersistedGeminiKeyRecord {
  id: string;
  label: string;
  key: string;
  invalid: boolean;
  lastUsedAt?: string;
  lastTestedAt?: string;
  lastError?: string;
  totalRequests: number;
  totalErrors: number;
}

interface RuntimeKeyState {
  id: string;
  label: string;
  key: string;
  source: 'user' | 'env';
  invalid: boolean;
  inFlightCount: number;
  cooldownUntilMs: number;
  lastUsedAtMs: number;
  lastUsedAt?: string;
  lastTestedAt?: string;
  lastError?: string;
  totalRequests: number;
  totalErrors: number;
}

export interface AcquiredGeminiKey {
  id: string;
  label: string;
  maskedKey: string;
  apiKey: string;
  source: 'user' | 'env';
}

export interface KeyTestResult {
  id: string;
  label: string;
  maskedKey: string;
  ok: boolean;
  status: GeminiKeyStatus;
  modelUsed?: string;
  message: string;
}

const userKeys: RuntimeKeyState[] = [];
let envKeyState: RuntimeKeyState | null = null;
let activeKeyId: string | null = null;
let initialized = false;

export function maskApiKey(rawKey: string): string {
  const key = rawKey.trim();
  if (!key) return '••••';
  if (key.length <= 10) {
    return `${key.slice(0, 2)}••••${key.slice(-2)}`;
  }
  return `${key.slice(0, 6)}••••••${key.slice(-4)}`;
}

export function sanitizeGeminiMessage(raw: string): string {
  return raw.replace(/AIza[0-9A-Za-z_-]{12,}/g, (match) => maskApiKey(match));
}

export function extractHttpStatusCode(err: unknown): number | null {
  if (err && typeof err === 'object') {
    const rec = err as {
      status?: unknown;
      statusCode?: unknown;
      code?: unknown;
      response?: { status?: unknown };
    };
    const directCandidates = [rec.status, rec.statusCode, rec.code, rec.response?.status];
    for (const c of directCandidates) {
      const n = Number(c);
      if (Number.isInteger(n) && n >= 400 && n <= 599) {
        return n;
      }
    }
  }

  const raw = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(raw) as { error?: { code?: unknown } };
    const n = Number(parsed?.error?.code);
    if (Number.isInteger(n) && n >= 400 && n <= 599) {
      return n;
    }
  } catch {
    // Plain text message
  }

  const match = raw.match(/\b(400|401|403|404|408|413|429|500|502|503|504)\b/);
  if (match) {
    return Number(match[1]);
  }
  return null;
}

export function formatHttpErrorLabel(err: unknown): string {
  const code = extractHttpStatusCode(err);
  if (code !== null) {
    return `HTTP ${code}`;
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('abort')) {
    return 'HTTP 408 (Timeout)';
  }
  return 'Network/API Error';
}

export function formatSafeGeminiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const httpCode = extractHttpStatusCode(err);
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string; code?: number; status?: string };
    };
    if (parsed?.error?.message) {
      const code = parsed.error.code || httpCode;
      const prefix = code ? ` (HTTP ${code})` : '';
      return sanitizeGeminiMessage(`Gemini API${prefix}: ${parsed.error.message}`);
    }
  } catch {
    // Plain error string
  }
  const sanitized = sanitizeGeminiMessage(raw);
  if (httpCode && !sanitized.includes(String(httpCode))) {
    return `HTTP ${httpCode}: ${sanitized}`;
  }
  return sanitized;
}

export function isInvalidKeyError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes('file') && msg.includes('permission')) {
    return false;
  }
  return (
    msg.includes('api_key_invalid') ||
    msg.includes('api key not valid') ||
    msg.includes('invalid api key') ||
    msg.includes('api key expired') ||
    msg.includes('permission_denied') ||
    msg.includes('unauthenticated') ||
    (msg.includes('401') && msg.includes('key')) ||
    (msg.includes('403') && (msg.includes('api key') || msg.includes('denied') || msg.includes('unauthorized')))
  );
}

export function isRateLimitError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('resource_exhausted') ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests')
  );
}

export function isOverloadError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('503') ||
    msg.includes('502') ||
    msg.includes('unavailable') ||
    msg.includes('overloaded') ||
    msg.includes('high demand') ||
    msg.includes('service is currently unavailable')
  );
}

export function isModelNotFoundError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('404') ||
    msg.includes('not_found') ||
    msg.includes('no longer available') ||
    msg.includes('deprecated') ||
    msg.includes('model not found') ||
    msg.includes('is not found for api version') ||
    msg.includes('not supported for generatecontent')
  );
}

export function isTransientNetworkError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('abort') ||
    msg.includes('deadline') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('fetch failed')
  );
}

export function computeCooldownMs(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  const match = msg.match(/retry(?:\s+in|\s*delay["']?\s*[:=]\s*["']?)(\d+(?:\.\d+)?)\s*s/i);
  if (match) {
    const parsedMs = Math.ceil(Number(match[1]) * 1000);
    if (Number.isFinite(parsedMs) && parsedMs > 0) {
      return Math.min(60_000, Math.max(30_000, parsedMs));
    }
  }
  return isRateLimitError(err) ? COOLDOWN_429_MS : COOLDOWN_503_MS;
}

function syncEnvKeyState() {
  const rawEnv =
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.API_KEY?.trim() ||
    '';
  if (!rawEnv || rawEnv === 'MY_GEMINI_API_KEY') {
    envKeyState = null;
    return;
  }
  // Avoid duplicating if the user manually added the exact same key
  if (userKeys.some((u) => u.key === rawEnv)) {
    envKeyState = null;
    return;
  }
  if (envKeyState && envKeyState.key === rawEnv) {
    return;
  }
  envKeyState = {
    id: 'env_gemini_key',
    label: 'Default Environment Key',
    key: rawEnv,
    source: 'env',
    invalid: false,
    inFlightCount: 0,
    cooldownUntilMs: 0,
    lastUsedAtMs: 0,
    totalRequests: 0,
    totalErrors: 0,
  };
}

function ensureInitialized() {
  if (!initialized) {
    initGeminiKeys();
  } else {
    syncEnvKeyState();
  }
}

function saveUserKeys() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const serialized: PersistedGeminiKeyRecord[] = userKeys.map((k) => ({
    id: k.id,
    label: k.label,
    key: k.key,
    invalid: k.invalid,
    ...(k.lastUsedAt ? { lastUsedAt: k.lastUsedAt } : {}),
    ...(k.lastTestedAt ? { lastTestedAt: k.lastTestedAt } : {}),
    ...(k.lastError ? { lastError: k.lastError } : {}),
    totalRequests: k.totalRequests,
    totalErrors: k.totalErrors,
  }));
  fs.writeFileSync(GEMINI_KEYS_FILE, JSON.stringify(serialized, null, 2), 'utf-8');
}

export function initGeminiKeys() {
  initialized = true;
  userKeys.length = 0;

  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(GEMINI_KEYS_FILE)) {
      const parsed = JSON.parse(
        fs.readFileSync(GEMINI_KEYS_FILE, 'utf-8')
      ) as PersistedGeminiKeyRecord[];
      if (Array.isArray(parsed)) {
        for (const item of parsed.slice(0, MAX_USER_GEMINI_KEYS)) {
          if (!item || typeof item.key !== 'string' || !item.key.trim()) continue;
          const cleanKey = item.key.trim();
          if (userKeys.some((existing) => existing.key === cleanKey)) continue;
          userKeys.push({
            id:
              typeof item.id === 'string' && item.id.trim()
                ? item.id.trim()
                : `gkey_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            label:
              typeof item.label === 'string' && item.label.trim()
                ? item.label.trim()
                : `Key #${userKeys.length + 1}`,
            key: cleanKey,
            source: 'user',
            invalid: Boolean(item.invalid),
            inFlightCount: 0,
            cooldownUntilMs: 0,
            lastUsedAtMs: item.lastUsedAt ? Date.parse(item.lastUsedAt) || 0 : 0,
            ...(item.lastUsedAt ? { lastUsedAt: item.lastUsedAt } : {}),
            ...(item.lastTestedAt ? { lastTestedAt: item.lastTestedAt } : {}),
            ...(item.lastError ? { lastError: sanitizeGeminiMessage(item.lastError) } : {}),
            totalRequests: Number(item.totalRequests) || 0,
            totalErrors: Number(item.totalErrors) || 0,
          });
        }
      }
    }
  } catch {
    userKeys.length = 0;
  }

  syncEnvKeyState();
}

function getAllKeyStates(): RuntimeKeyState[] {
  ensureInitialized();
  const list = [...userKeys];
  if (envKeyState) {
    list.push(envKeyState);
  }
  return list;
}

function refreshExpiredCooldowns(states: RuntimeKeyState[], nowMs = Date.now()) {
  for (const s of states) {
    if (s.cooldownUntilMs > 0 && s.cooldownUntilMs <= nowMs) {
      s.cooldownUntilMs = 0;
      if (!s.invalid && s.lastError) {
        s.lastError = undefined;
      }
    }
  }
}

function findStateById(id: string): RuntimeKeyState | undefined {
  return getAllKeyStates().find((s) => s.id === id);
}

function toPublicInfo(s: RuntimeKeyState, nowMs: number): GeminiApiKeyInfo {
  const isCooling = s.cooldownUntilMs > nowMs;
  const cooldownRemainingSeconds = isCooling
    ? Math.max(1, Math.ceil((s.cooldownUntilMs - nowMs) / 1000))
    : 0;

  let status: GeminiKeyStatus = 'ready';
  if (s.invalid) {
    status = 'invalid';
  } else if (s.inFlightCount > 0) {
    status = 'active';
  } else if (isCooling) {
    status = 'rate_limited';
  }

  return {
    id: s.id,
    label: s.label,
    maskedKey: maskApiKey(s.key),
    source: s.source,
    status,
    inUse: s.inFlightCount > 0,
    inFlightCount: s.inFlightCount,
    ...(isCooling ? { cooldownUntil: new Date(s.cooldownUntilMs).toISOString() } : {}),
    cooldownRemainingSeconds,
    ...(s.lastUsedAt ? { lastUsedAt: s.lastUsedAt } : {}),
    ...(s.lastTestedAt ? { lastTestedAt: s.lastTestedAt } : {}),
    ...(s.lastError ? { lastError: sanitizeGeminiMessage(s.lastError) } : {}),
    totalRequests: s.totalRequests,
    totalErrors: s.totalErrors,
  };
}

export function getGeminiKeyPoolSummary(): GeminiKeyPoolSummary {
  const nowMs = Date.now();
  const states = getAllKeyStates();
  refreshExpiredCooldowns(states, nowMs);

  const publicKeys = states.map((s) => toPublicInfo(s, nowMs));
  const currentInFlight =
    publicKeys.find((k) => k.id === activeKeyId && k.inUse) ||
    publicKeys.find((k) => k.inUse) ||
    null;
  const availableCount = publicKeys.filter(
    (k) => k.status === 'ready' || k.status === 'active'
  ).length;

  return {
    keys: publicKeys,
    maxUserKeys: MAX_USER_GEMINI_KEYS,
    activeKeyId: currentInFlight ? currentInFlight.id : null,
    availableCount,
    totalCount: publicKeys.length,
  };
}

export function hasUsableGeminiKey(): boolean {
  const states = getAllKeyStates();
  return states.some((s) => !s.invalid);
}

export function getUsableKeyCount(): number {
  const states = getAllKeyStates();
  return states.filter((s) => !s.invalid).length;
}

export function parseBulkApiKeys(rawInput: string): string[] {
  return rawInput
    .split(/[\r\n,;]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function addGeminiKeys(rawInput: string, labelPrefix?: string): {
  addedCount: number;
  skippedDuplicates: number;
  invalidTokens: number;
  cappedCount: number;
  summary: GeminiKeyPoolSummary;
} {
  ensureInitialized();

  const tokens = parseBulkApiKeys(rawInput);
  let addedCount = 0;
  let skippedDuplicates = 0;
  let invalidTokens = 0;
  let cappedCount = 0;

  const cleanPrefix = typeof labelPrefix === 'string' ? labelPrefix.trim() : '';

  for (const token of tokens) {
    if (token.length < 16 || /\s/.test(token)) {
      invalidTokens += 1;
      continue;
    }
    if (userKeys.some((existing) => existing.key === token)) {
      skippedDuplicates += 1;
      continue;
    }
    if (userKeys.length >= MAX_USER_GEMINI_KEYS) {
      cappedCount += 1;
      continue;
    }

    const nextNum = userKeys.length + 1;
    const label = cleanPrefix
      ? tokens.length === 1
        ? cleanPrefix
        : `${cleanPrefix} #${nextNum}`
      : `Gemini Key #${nextNum}`;

    userKeys.push({
      id: `gkey_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      label,
      key: token,
      source: 'user',
      invalid: false,
      inFlightCount: 0,
      cooldownUntilMs: 0,
      lastUsedAtMs: 0,
      totalRequests: 0,
      totalErrors: 0,
    });
    addedCount += 1;
  }

  syncEnvKeyState();
  saveUserKeys();

  return {
    addedCount,
    skippedDuplicates,
    invalidTokens,
    cappedCount,
    summary: getGeminiKeyPoolSummary(),
  };
}

export function deleteGeminiKey(id: string): {
  deleted: boolean;
  summary: GeminiKeyPoolSummary;
} {
  ensureInitialized();
  const idx = userKeys.findIndex((k) => k.id === id);
  if (idx === -1) {
    return { deleted: false, summary: getGeminiKeyPoolSummary() };
  }
  userKeys.splice(idx, 1);
  if (activeKeyId === id) {
    activeKeyId = null;
  }
  syncEnvKeyState();
  saveUserKeys();
  return { deleted: true, summary: getGeminiKeyPoolSummary() };
}

export function revealUserGeminiKey(id: string): {
  found: boolean;
  forbidden?: boolean;
  key?: string;
} {
  ensureInitialized();
  if (envKeyState && envKeyState.id === id) {
    return { found: true, forbidden: true };
  }
  const target = userKeys.find((k) => k.id === id);
  if (!target) {
    return { found: false };
  }
  return { found: true, key: target.key };
}

export function acquireGeminiKey(excludeIds?: Set<string>): AcquiredGeminiKey | null {
  const nowMs = Date.now();
  const states = getAllKeyStates();
  refreshExpiredCooldowns(states, nowMs);

  const candidates = states.filter(
    (s) =>
      !s.invalid &&
      s.cooldownUntilMs <= nowMs &&
      (!excludeIds || !excludeIds.has(s.id))
  );

  if (candidates.length === 0) {
    return null;
  }

  // Load-balance by fewest active concurrent requests, then least-recently-used timestamp
  candidates.sort((a, b) => {
    if (a.inFlightCount !== b.inFlightCount) {
      return a.inFlightCount - b.inFlightCount;
    }
    return a.lastUsedAtMs - b.lastUsedAtMs;
  });

  const chosen = candidates[0];
  chosen.inFlightCount += 1;
  chosen.lastUsedAtMs = nowMs;
  chosen.lastUsedAt = new Date(nowMs).toISOString();
  chosen.totalRequests += 1;
  activeKeyId = chosen.id;

  if (chosen.source === 'user') {
    saveUserKeys();
  }

  return {
    id: chosen.id,
    label: chosen.label,
    maskedKey: maskApiKey(chosen.key),
    apiKey: chosen.key,
    source: chosen.source,
  };
}

export function releaseGeminiKey(id: string) {
  const state = findStateById(id);
  if (state) {
    state.inFlightCount = Math.max(0, state.inFlightCount - 1);
  }
  if (activeKeyId === id && (!state || state.inFlightCount === 0)) {
    const anotherActive = getAllKeyStates().find((s) => s.inFlightCount > 0);
    activeKeyId = anotherActive ? anotherActive.id : null;
  }
}

export function markKeySuccess(id: string) {
  const state = findStateById(id);
  if (!state) return;
  state.invalid = false;
  state.cooldownUntilMs = 0;
  state.lastError = undefined;
  if (state.source === 'user') {
    saveUserKeys();
  }
}

export function markKeyRateLimited(id: string, reason: string, cooldownMs = COOLDOWN_429_MS) {
  const state = findStateById(id);
  if (!state) return;
  state.cooldownUntilMs = Date.now() + cooldownMs;
  state.totalErrors += 1;
  state.lastError = sanitizeGeminiMessage(reason);
  if (state.source === 'user') {
    saveUserKeys();
  }
}

export function markKeyInvalid(id: string, reason: string) {
  const state = findStateById(id);
  if (!state) return;
  state.invalid = true;
  state.cooldownUntilMs = 0;
  state.totalErrors += 1;
  state.lastError = sanitizeGeminiMessage(reason);
  if (state.source === 'user') {
    saveUserKeys();
  }
}

export function getNextCooldownWaitMs(excludeIds?: Set<string>): number | null {
  const nowMs = Date.now();
  const states = getAllKeyStates();
  refreshExpiredCooldowns(states, nowMs);

  const cooling = states.filter(
    (s) =>
      !s.invalid &&
      s.cooldownUntilMs > nowMs &&
      (!excludeIds || !excludeIds.has(s.id))
  );

  if (cooling.length === 0) {
    return null;
  }

  let minWait = Infinity;
  for (const s of cooling) {
    const wait = s.cooldownUntilMs - nowMs;
    if (wait < minWait) {
      minWait = wait;
    }
  }
  return Number.isFinite(minWait) ? Math.max(0, minWait) : null;
}

export function createGeminiClientForKey(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function getCandidateRawKeys(): Array<{ id: string; apiKey: string; label: string }> {
  const nowMs = Date.now();
  const states = getAllKeyStates();
  refreshExpiredCooldowns(states, nowMs);
  return states
    .filter((s) => !s.invalid)
    .sort((a, b) => Number(a.cooldownUntilMs > nowMs) - Number(b.cooldownUntilMs > nowMs))
    .map((s) => ({ id: s.id, apiKey: s.key, label: s.label }));
}

const DEFAULT_TEST_MODELS = ['gemini-4-hydrogen', 'gemini-3.8-flash'] as const;

export async function testGeminiKey(
  id: string,
  candidateModels?: string[]
): Promise<KeyTestResult> {
  const state = findStateById(id);
  if (!state) {
    throw new Error('Gemini API key entry not found.');
  }

  const ai = createGeminiClientForKey(state.key);
  state.inFlightCount += 1;
  activeKeyId = state.id;

  const modelsToTry =
    candidateModels && candidateModels.length > 0
      ? candidateModels
      : [...DEFAULT_TEST_MODELS];

  try {
    let lastErr: unknown;
    for (const model of modelsToTry.slice(0, 4)) {
      try {
        await ai.models.generateContent({
          model,
          contents: 'Reply with OK',
          config: {
            abortSignal: AbortSignal.timeout(12_000),
          },
        });

        const nowIso = new Date().toISOString();
        state.invalid = false;
        state.cooldownUntilMs = 0;
        state.lastError = undefined;
        state.lastTestedAt = nowIso;
        state.lastUsedAt = nowIso;
        state.lastUsedAtMs = Date.now();
        state.totalRequests += 1;
        if (state.source === 'user') saveUserKeys();

        return {
          id: state.id,
          label: state.label,
          maskedKey: maskApiKey(state.key),
          ok: true,
          status: 'ready',
          modelUsed: model,
          message: `Verified working with ${model}.`,
        };
      } catch (err) {
        lastErr = err;
        if (isModelNotFoundError(err) || isOverloadError(err)) {
          continue;
        }
        break;
      }
    }

    const formatted = formatSafeGeminiError(lastErr);
    state.lastTestedAt = new Date().toISOString();

    if (isInvalidKeyError(lastErr)) {
      markKeyInvalid(state.id, formatted);
      return {
        id: state.id,
        label: state.label,
        maskedKey: maskApiKey(state.key),
        ok: false,
        status: 'invalid',
        message: formatted,
      };
    }

    if (isRateLimitError(lastErr) || isOverloadError(lastErr)) {
      const cooldownMs = computeCooldownMs(lastErr);
      markKeyRateLimited(state.id, formatted, cooldownMs);
      return {
        id: state.id,
        label: state.label,
        maskedKey: maskApiKey(state.key),
        ok: false,
        status: 'rate_limited',
        message: `${formatted} (cooldown ${Math.ceil(cooldownMs / 1000)}s)`,
      };
    }

    state.totalErrors += 1;
    state.lastError = formatted;
    if (state.source === 'user') saveUserKeys();

    return {
      id: state.id,
      label: state.label,
      maskedKey: maskApiKey(state.key),
      ok: false,
      status: state.invalid ? 'invalid' : 'ready',
      message: formatted,
    };
  } finally {
    state.inFlightCount = Math.max(0, state.inFlightCount - 1);
    if (activeKeyId === state.id && state.inFlightCount === 0) {
      const anotherActive = getAllKeyStates().find((s) => s.inFlightCount > 0);
      activeKeyId = anotherActive ? anotherActive.id : null;
    }
  }
}

export async function testAllGeminiKeys(
  candidateModels?: string[]
): Promise<KeyTestResult[]> {
  const states = getAllKeyStates();
  const results: KeyTestResult[] = [];
  for (const s of states) {
    results.push(await testGeminiKey(s.id, candidateModels));
  }
  return results;
}
