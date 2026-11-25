import dns from 'dns/promises';
import fs from 'fs';
import net from 'net';
import path from 'path';
import type {
  ClipItem,
  ThirdPartyExportPlatform,
  ThirdPartyExportSettings,
} from '../src/types.ts';
import { sanitizeHashtags } from './requirementEngine.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const EXPORT_SETTINGS_FILE = path.join(DATA_DIR, 'third_party_export.json');

interface PersistedThirdPartyExport {
  webhookUrl: string;
  preferredPlatform: ThirdPartyExportPlatform;
  webhookLabel?: string;
  autoSendOnComplete: boolean;
  lastTestedAt?: string;
  lastTestStatus?: string;
  lastError?: string;
}

const DEFAULT_PERSISTED: PersistedThirdPartyExport = {
  webhookUrl: '',
  preferredPlatform: 'custom_webhook',
  webhookLabel: '',
  autoSendOnComplete: false,
};

let store: PersistedThirdPartyExport = { ...DEFAULT_PERSISTED };

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function saveStore() {
  ensureDir();
  fs.writeFileSync(EXPORT_SETTINGS_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

function isPrivateIpAddress(ip: string): boolean {
  const normalized = ip.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized === '::1' || normalized === '::' || normalized === '0.0.0.0') {
    return true;
  }

  // IPv4-mapped IPv6 e.g. ::ffff:127.0.0.1
  if (normalized.startsWith('::ffff:')) {
    const v4 = normalized.slice('::ffff:'.length);
    if (net.isIPv4(v4)) {
      return isPrivateIpAddress(v4);
    }
  }

  if (net.isIPv4(normalized)) {
    const parts = normalized.split('.').map((n) => Number(n));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  if (net.isIPv6(normalized)) {
    if (
      normalized.startsWith('fe80:') ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('ff')
    ) {
      return true;
    }
    return false;
  }

  return true;
}

export function validateWebhookUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Webhook URL is required.');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Enter a valid HTTPS webhook URL (e.g. https://hook.us1.make.com/...).');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Third-party webhook URL must use HTTPS.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Webhook URL must not contain embedded username or password credentials.');
  }

  const host = parsed.hostname.toLowerCase();
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.localdomain')
  ) {
    throw new Error('Localhost and internal network webhook hosts are not permitted.');
  }

  if (net.isIP(host) && isPrivateIpAddress(host)) {
    throw new Error('Private or loopback IP addresses cannot be used as webhook destinations.');
  }

  return parsed;
}

async function assertPublicDestination(parsed: URL): Promise<void> {
  const host = parsed.hostname;
  if (net.isIP(host)) {
    if (isPrivateIpAddress(host)) {
      throw new Error('Blocked private or loopback webhook destination.');
    }
    return;
  }

  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`Could not resolve webhook hostname "${host}".`);
  }
  if (!resolved.length) {
    throw new Error(`Webhook hostname "${host}" returned no DNS records.`);
  }
  for (const record of resolved) {
    if (isPrivateIpAddress(record.address)) {
      throw new Error(`Webhook destination "${host}" resolves to a private or restricted IP.`);
    }
  }
}

function sanitizeDisplayWebhookUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/(token|secret|key|auth|pass|sig)/i.test(key)) {
        parsed.searchParams.set(key, '***');
      }
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

export function initThirdPartyExport() {
  ensureDir();
  try {
    if (fs.existsSync(EXPORT_SETTINGS_FILE)) {
      const parsed = JSON.parse(
        fs.readFileSync(EXPORT_SETTINGS_FILE, 'utf-8')
      ) as Partial<PersistedThirdPartyExport>;
      const validPlatform =
        parsed.preferredPlatform === 'buffer' ||
        parsed.preferredPlatform === 'metricool' ||
        parsed.preferredPlatform === 'zapier_make' ||
        parsed.preferredPlatform === 'custom_webhook'
          ? parsed.preferredPlatform
          : 'custom_webhook';
      store = {
        ...DEFAULT_PERSISTED,
        ...parsed,
        preferredPlatform: validPlatform,
        webhookUrl: typeof parsed.webhookUrl === 'string' ? parsed.webhookUrl : '',
      };
    }
  } catch {
    store = { ...DEFAULT_PERSISTED };
  }
}

export function getThirdPartyExportSettings(): ThirdPartyExportSettings {
  const configured = Boolean(store.webhookUrl && store.webhookUrl.startsWith('https://'));
  return {
    webhookUrl: configured ? sanitizeDisplayWebhookUrl(store.webhookUrl) : '',
    webhookConfigured: configured,
    preferredPlatform: store.preferredPlatform,
    webhookLabel: store.webhookLabel || undefined,
    autoSendOnComplete: Boolean(store.autoSendOnComplete),
    lastTestedAt: store.lastTestedAt,
    lastTestStatus: store.lastTestStatus,
    lastError: store.lastError,
  };
}

export function updateThirdPartyExportSettings(patch: {
  webhookUrl?: string;
  preferredPlatform?: ThirdPartyExportPlatform;
  webhookLabel?: string;
  autoSendOnComplete?: boolean;
}): ThirdPartyExportSettings {
  if (typeof patch.webhookUrl === 'string') {
    const trimmed = patch.webhookUrl.trim();
    if (!trimmed) {
      store.webhookUrl = '';
      store.autoSendOnComplete = false;
      store.lastError = undefined;
      store.lastTestStatus = undefined;
    } else if (trimmed !== sanitizeDisplayWebhookUrl(store.webhookUrl)) {
      const validated = validateWebhookUrl(trimmed);
      store.webhookUrl = validated.toString();
      store.lastError = undefined;
    }
  }

  if (
    patch.preferredPlatform === 'custom_webhook' ||
    patch.preferredPlatform === 'buffer' ||
    patch.preferredPlatform === 'metricool' ||
    patch.preferredPlatform === 'zapier_make'
  ) {
    store.preferredPlatform = patch.preferredPlatform;
  }

  if (typeof patch.webhookLabel === 'string') {
    store.webhookLabel = patch.webhookLabel.trim().slice(0, 80);
  }

  if (typeof patch.autoSendOnComplete === 'boolean') {
    if (patch.autoSendOnComplete && !store.webhookUrl) {
      throw new Error('Configure a valid HTTPS webhook URL before enabling auto-send.');
    }
    store.autoSendOnComplete = patch.autoSendOnComplete;
  }

  saveStore();
  return getThirdPartyExportSettings();
}

export function ensureHashtagsWithBD(hashtags: string[]): string[] {
  return sanitizeHashtags(hashtags, { minRelevant: 3, maxRelevant: 5 });
}

export function buildThirdPartyClipPayload(clip: ClipItem, baseOrigin?: string) {
  const hashtags = ensureHashtagsWithBD(clip.hashtags || []);
  const captionParts = [clip.title.trim(), clip.description.trim(), hashtags.join(' ')].filter(Boolean);
  const fullCaption = captionParts.join('\n\n');
  const origin = baseOrigin ? baseOrigin.replace(/\/+$/, '') : '';
  const resolveAssetUrl = (rel?: string) => (rel ? (origin ? `${origin}${rel}` : rel) : null);

  return {
    event: 'clips_ai.clip_ready',
    app: 'Clips ai',
    preferredPlatform: store.preferredPlatform,
    exportedAt: new Date().toISOString(),
    clip: {
      id: clip.id,
      streamId: clip.streamId,
      streamLabel: clip.streamLabel,
      formatMode: clip.formatMode,
      aspectMode: clip.aspectMode || 'portrait',
      languageChoice: clip.languageChoice || 'banglish',
      category: clip.category,
      durationSeconds: clip.durationSeconds,
      title: clip.title,
      description: clip.description,
      hashtags,
      tags: clip.tags || [],
      captionWithHashtags: fullCaption,
      videoUrl: resolveAssetUrl(clip.videoUrl),
      thumbnailUrl: resolveAssetUrl(clip.thumbnailUrl),
      srtUrl: resolveAssetUrl(clip.srtUrl),
      fileSizeBytes: clip.fileSizeBytes ?? null,
      createdAt: clip.createdAt,
      completedAt: clip.completedAt ?? null,
    },
  };
}

async function postJsonToWebhook(urlStr: string, payload: unknown): Promise<{ status: number; bodyPreview: string }> {
  const parsed = validateWebhookUrl(urlStr);
  await assertPublicDestination(parsed);

  const response = await fetch(parsed.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Clips-AI-Webhook/1.0',
    },
    body: JSON.stringify(payload),
    redirect: 'error',
    signal: AbortSignal.timeout(12_000),
  });

  const text = await response.text().catch(() => '');
  const preview = text.trim().slice(0, 240);
  if (!response.ok) {
    throw new Error(
      `Webhook returned HTTP ${response.status}${preview ? `: ${preview}` : ''}`
    );
  }
  return { status: response.status, bodyPreview: preview };
}

export async function testThirdPartyWebhook(): Promise<{
  ok: boolean;
  status: number;
  message: string;
  settings: ThirdPartyExportSettings;
}> {
  if (!store.webhookUrl) {
    throw new Error('Save an HTTPS third-party webhook URL first before testing.');
  }

  const testPayload = {
    event: 'clips_ai.webhook_test',
    app: 'Clips ai',
    preferredPlatform: store.preferredPlatform,
    sampleHashtags: ['#BD', '#Shorts', '#Gaming'],
    testedAt: new Date().toISOString(),
  };

  try {
    const res = await postJsonToWebhook(store.webhookUrl, testPayload);
    store.lastTestedAt = new Date().toISOString();
    store.lastTestStatus = `HTTP ${res.status} OK`;
    store.lastError = undefined;
    saveStore();
    return {
      ok: true,
      status: res.status,
      message: `Webhook reachable (HTTP ${res.status}).`,
      settings: getThirdPartyExportSettings(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Webhook test failed.';
    store.lastTestedAt = new Date().toISOString();
    store.lastTestStatus = 'Failed';
    store.lastError = msg;
    saveStore();
    throw new Error(msg);
  }
}

export async function dispatchClipToThirdPartyWebhook(
  clip: ClipItem,
  baseOrigin?: string
): Promise<{ status: number; exportedAt: string; bodyPreview: string }> {
  if (!store.webhookUrl) {
    throw new Error('No third-party webhook URL is configured. Save one in Third-Party Export setup first.');
  }
  const payload = buildThirdPartyClipPayload(clip, baseOrigin);
  const res = await postJsonToWebhook(store.webhookUrl, payload);
  return {
    status: res.status,
    exportedAt: payload.exportedAt,
    bodyPreview: res.bodyPreview,
  };
}
