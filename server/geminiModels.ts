import {
  createGeminiClientForKey,
  formatSafeGeminiError,
  getCandidateRawKeys,
} from './geminiKeys.ts';
import type { GeminiModelRegistryStatus, QuarantinedModelInfo } from '../src/types.ts';

const DEFAULT_FALLBACK_MODELS = ['gemini-4-hydrogen', 'gemini-3.8-flash'] as const;
const QUARANTINE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DISCOVERY_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes unless forced

interface QuarantineEntry {
  modelId: string;
  reason: string;
  quarantinedAtMs: number;
  expiresAtMs: number;
}

let discoveredModels: string[] = [...DEFAULT_FALLBACK_MODELS];
const quarantinedMap = new Map<string, QuarantineEntry>();
let lastDiscoveryAtMs = 0;
let lastDiscoveryError: string | undefined;
let discoveryInFlight: Promise<string[]> | null = null;

export function normalizeModelId(rawName: string): string {
  return rawName.trim().replace(/^models\//i, '');
}

function refreshQuarantine(nowMs = Date.now()) {
  for (const [id, entry] of quarantinedMap.entries()) {
    if (entry.expiresAtMs <= nowMs) {
      quarantinedMap.delete(id);
    }
  }
}

export function quarantineModel(
  modelId: string,
  reason: string,
  ttlMs = QUARANTINE_TTL_MS
) {
  const cleanId = normalizeModelId(modelId);
  if (!cleanId) return;
  const nowMs = Date.now();
  quarantinedMap.set(cleanId, {
    modelId: cleanId,
    reason: reason.slice(0, 220),
    quarantinedAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
  });
}

export function isModelQuarantined(modelId: string): boolean {
  refreshQuarantine();
  return quarantinedMap.has(normalizeModelId(modelId));
}

function scoreDiscoveredModel(modelId: string): number | null {
  const lower = modelId.toLowerCase();
  if (!lower.startsWith('gemini')) return null;

  // Exclude prohibited/deprecated 1.x, 2.0, bare gemini-pro, and specialized non-video-analysis models
  if (
    /^gemini-1\./.test(lower) ||
    /^gemini-2\.0/.test(lower) ||
    lower === 'gemini-pro' ||
    /(embed|imagen|veo|lyria|tts|aqa|bisociate|robotics|computer-use|deep-research|decision|transcribe|native-audio|live|gemma|-image\b)/.test(
      lower
    )
  ) {
    return null;
  }

  let score = 0;

  // Strongly prefer fast standard flash / flash-lite models
  if (lower.includes('flash-lite')) {
    score += 1200;
  } else if (lower.includes('flash')) {
    score += 1150;
  } else if (lower.includes('pro')) {
    score += 450;
  } else {
    // Experimental codename aliases (e.g. hydrogen/neon/carbon) sit behind standard flash models
    score += 150;
  }

  // Version preference (e.g. 3.5 > 3.1 > 2.5)
  const verMatch = lower.match(/gemini-(\d+(?:\.\d+)?)/);
  if (verMatch) {
    const ver = Number(verMatch[1]);
    if (Number.isFinite(ver)) {
      score += Math.round(ver * 50);
    }
  }

  // Prefer GA/stable over experimental or dated previews
  if (lower.includes('-exp')) score -= 200;
  if (lower.includes('-preview')) score -= 35;
  if (lower.endsWith('-latest')) score -= 15;

  return score;
}

export async function discoverGeminiModels(
  forceRefresh = false,
  onLog?: (level: 'info' | 'warn' | 'success', msg: string) => void
): Promise<string[]> {
  const nowMs = Date.now();
  refreshQuarantine(nowMs);

  if (
    !forceRefresh &&
    lastDiscoveryAtMs > 0 &&
    nowMs - lastDiscoveryAtMs < DISCOVERY_COOLDOWN_MS &&
    discoveredModels.length > 0
  ) {
    return getActiveCandidateModels();
  }

  if (discoveryInFlight) {
    return discoveryInFlight;
  }

  discoveryInFlight = (async () => {
    const keys = getCandidateRawKeys();
    if (keys.length === 0) {
      lastDiscoveryError = 'No Gemini API keys available for model discovery.';
      return getActiveCandidateModels();
    }

    let lastErr: unknown;
    for (const candidate of keys.slice(0, 3)) {
      try {
        const ai = createGeminiClientForKey(candidate.apiKey);
        const pager = await ai.models.list({ config: { pageSize: 100 } });
        const scored: Array<{ id: string; score: number }> = [];
        const seen = new Set<string>();

        for await (const model of pager) {
          const rawName = model?.name || '';
          const id = normalizeModelId(rawName);
          if (!id || seen.has(id)) continue;
          seen.add(id);

          const actions = Array.isArray(model.supportedActions)
            ? model.supportedActions.map((a) => a.toLowerCase())
            : [];
          if (actions.length > 0 && !actions.includes('generatecontent')) {
            continue;
          }

          const score = scoreDiscoveredModel(id);
          if (score !== null) {
            scored.push({ id, score });
          }
        }

        if (scored.length > 0) {
          scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
          discoveredModels = scored.slice(0, 8).map((s) => s.id);
          lastDiscoveryAtMs = Date.now();
          lastDiscoveryError = undefined;

          const active = getActiveCandidateModels();
          onLog?.(
            'info',
            `Auto-discovered ${scored.length} Gemini content models. Active fast rotation: ${active
              .slice(0, 3)
              .join(', ')}.`
          );
          return active;
        }
      } catch (err) {
        lastErr = err;
      }
    }

    if (lastErr) {
      lastDiscoveryError = formatSafeGeminiError(lastErr);
      onLog?.('warn', `Gemini model discovery fallback active: ${lastDiscoveryError}`);
    }
    return getActiveCandidateModels();
  })().finally(() => {
    discoveryInFlight = null;
  });

  return discoveryInFlight;
}

export function getActiveCandidateModels(): string[] {
  refreshQuarantine();
  const basePool = Array.from(new Set([...discoveredModels, ...DEFAULT_FALLBACK_MODELS]));
  const healthy = basePool.filter((id) => !quarantinedMap.has(id));
  if (healthy.length > 0) {
    return healthy;
  }
  // Safety valve: if every known model somehow got quarantined, unquarantine defaults
  for (const def of DEFAULT_FALLBACK_MODELS) {
    quarantinedMap.delete(def);
  }
  return [...DEFAULT_FALLBACK_MODELS];
}

export function getModelRegistryStatus(): GeminiModelRegistryStatus {
  const nowMs = Date.now();
  refreshQuarantine(nowMs);
  const quarantinedModels: QuarantinedModelInfo[] = Array.from(quarantinedMap.values()).map(
    (entry) => ({
      modelId: entry.modelId,
      reason: entry.reason,
      quarantinedAt: new Date(entry.quarantinedAtMs).toISOString(),
      expiresAt: new Date(entry.expiresAtMs).toISOString(),
      remainingSeconds: Math.max(1, Math.ceil((entry.expiresAtMs - nowMs) / 1000)),
    })
  );

  return {
    activeModels: getActiveCandidateModels(),
    discoveredModels: [...discoveredModels],
    quarantinedModels,
    ...(lastDiscoveryAtMs > 0
      ? { lastDiscoveryAt: new Date(lastDiscoveryAtMs).toISOString() }
      : {}),
    ...(lastDiscoveryError ? { lastDiscoveryError } : {}),
  };
}
