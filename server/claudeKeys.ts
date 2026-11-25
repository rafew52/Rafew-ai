import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CLAUDE_KEYS_FILE = path.join(DATA_DIR, 'claude_keys.json');

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

interface PersistedClaudeStore {
  keys: Array<{ id: string; key: string; label: string; source: 'user' }>;
}

let userKeys: Array<{ id: string; key: string; label: string }> = [];
let activeKeyIndex = 0;

export function initClaudeKeyStorage() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(CLAUDE_KEYS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CLAUDE_KEYS_FILE, 'utf-8')) as PersistedClaudeStore;
      if (Array.isArray(parsed.keys)) {
        userKeys = parsed.keys.map((k) => ({
          id: k.id || `ck_${Math.random().toString(36).slice(2, 8)}`,
          key: k.key.trim(),
          label: k.label || 'Custom Claude Key',
        }));
      }
    }
  } catch (err) {
    console.warn('Failed to load persisted Claude keys:', err);
  }
}

function saveClaudeKeys() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const store: PersistedClaudeStore = {
      keys: userKeys.map((k) => ({ id: k.id, key: k.key, label: k.label, source: 'user' })),
    };
    fs.writeFileSync(CLAUDE_KEYS_FILE, JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    console.warn('Failed to save Claude keys:', err);
  }
}

export function getEnvClaudeKeys(): string[] {
  const list: string[] = [];
  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim().startsWith('sk-ant-')) {
    list.push(process.env.ANTHROPIC_API_KEY.trim());
  }
  return list;
}

export function getAllClaudeCandidateKeys(): Array<{ id: string; apiKey: string; label: string; source: 'env' | 'user' }> {
  const result: Array<{ id: string; apiKey: string; label: string; source: 'env' | 'user' }> = [];
  const envKeys = getEnvClaudeKeys();
  envKeys.forEach((k, idx) => {
    result.push({
      id: `env_claude_${idx + 1}`,
      apiKey: k,
      label: `Environment Key #${idx + 1}`,
      source: 'env',
    });
  });

  userKeys.forEach((uk) => {
    result.push({
      id: uk.id,
      apiKey: uk.key,
      label: uk.label,
      source: 'user',
    });
  });

  return result;
}

export function getActiveClaudeApiKey(): string | null {
  const candidates = getAllClaudeCandidateKeys();
  if (candidates.length === 0) return null;
  const idx = activeKeyIndex % candidates.length;
  return candidates[idx]?.apiKey || candidates[0]?.apiKey || null;
}

export function rotateClaudeApiKey(): string | null {
  const candidates = getAllClaudeCandidateKeys();
  if (candidates.length === 0) return null;
  activeKeyIndex = (activeKeyIndex + 1) % candidates.length;
  return candidates[activeKeyIndex].apiKey;
}

export function addUserClaudeKey(rawKey: string, label?: string) {
  const clean = rawKey.trim();
  if (!clean.startsWith('sk-ant-') || clean.length < 20) {
    throw new Error('Invalid Claude API key format. Must start with "sk-ant-".');
  }
  if (userKeys.some((k) => k.key === clean)) {
    throw new Error('This Claude API key is already added.');
  }
  const id = `ck_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  userKeys.push({
    id,
    key: clean,
    label: label?.trim() || `Claude Key #${userKeys.length + 1}`,
  });
  saveClaudeKeys();
}

export function deleteUserClaudeKey(id: string): boolean {
  const initialLen = userKeys.length;
  userKeys = userKeys.filter((k) => k.id !== id);
  if (userKeys.length !== initialLen) {
    saveClaudeKeys();
    return true;
  }
  return false;
}

export function getClaudeKeyPoolSummary() {
  const candidates = getAllClaudeCandidateKeys();
  const activeKey = getActiveClaudeApiKey();
  const keysInfo: ClaudeApiKeyInfo[] = candidates.map((c, idx) => ({
    id: c.id,
    label: c.label,
    maskedKey: `${c.apiKey.slice(0, 7)}...${c.apiKey.slice(-4)}`,
    source: c.source,
    status: 'ready',
    inUse: c.apiKey === activeKey,
    totalRequests: 0,
    totalErrors: 0,
  }));

  return {
    keys: keysInfo,
    totalCount: candidates.length,
    activeKeyMasked: activeKey ? `${activeKey.slice(0, 7)}...${activeKey.slice(-4)}` : null,
  };
}
