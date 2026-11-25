import { useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  FlaskConical,
  KeyRound,
  Plus,
  RefreshCw,
  Trash2,
  XCircle,
} from 'lucide-react';
import type { GeminiApiKeyInfo, GeminiKeyPoolSummary } from '../types.ts';

interface GeminiKeyManagerCardProps {
  keyPool: GeminiKeyPoolSummary;
  onUpdated: () => void;
}

function getKeyStatusBadge(item: GeminiApiKeyInfo) {
  if (item.status === 'active' || item.inUse) {
    return {
      label: item.inFlightCount > 1 ? `Active · In Use (${item.inFlightCount})` : 'Active · In Use',
      className: 'border-emerald-700/70 bg-emerald-950/50 text-emerald-300',
      dotClass: 'bg-emerald-400 animate-pulse',
    };
  }
  if (item.status === 'rate_limited') {
    return {
      label:
        item.cooldownRemainingSeconds > 0
          ? `Busy / Rate-Limited (${item.cooldownRemainingSeconds}s)`
          : 'Busy / Rate-Limited',
      className: 'border-amber-700/70 bg-amber-950/50 text-amber-300',
      dotClass: 'bg-amber-400',
    };
  }
  if (item.status === 'invalid') {
    return {
      label: 'Invalid',
      className: 'border-red-800/80 bg-red-950/50 text-red-300',
      dotClass: 'bg-red-400',
    };
  }
  return {
    label: 'Ready',
    className: 'border-slate-700 bg-slate-900/70 text-slate-200',
    dotClass: 'bg-emerald-400',
  };
}

export function GeminiKeyManagerCard({ keyPool, onUpdated }: GeminiKeyManagerCardProps) {
  const [keysInput, setKeysInput] = useState('');
  const [labelInput, setLabelInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [revealedKeys, setRevealedKeys] = useState<Record<string, string>>({});
  const [revealingId, setRevealingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const userKeysCount = keyPool.keys.filter((k) => k.source === 'user').length;
  const remainingSlots = Math.max(0, keyPool.maxUserKeys - userKeysCount);
  const activeKey = keyPool.keys.find((k) => k.id === keyPool.activeKeyId || k.inUse);

  const handleAddKeys = async (e: FormEvent) => {
    e.preventDefault();
    setFeedback(null);

    if (!keysInput.trim()) {
      setFeedback({
        type: 'error',
        message: 'Paste at least one Gemini API key (single key, or multiple per line/comma).',
      });
      return;
    }

    setAdding(true);
    try {
      const res = await fetch('/api/gemini/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keys: keysInput,
          label: labelInput.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to add Gemini API key(s).');
      }

      const parts = [`Added ${data.addedCount} Gemini API key${data.addedCount === 1 ? '' : 's'}.`];
      if (data.skippedDuplicates > 0) {
        parts.push(`${data.skippedDuplicates} duplicate skipped.`);
      }
      if (data.invalidTokens > 0) {
        parts.push(`${data.invalidTokens} invalid format skipped.`);
      }
      if (data.cappedCount > 0) {
        parts.push(`${data.cappedCount} skipped (max ${keyPool.maxUserKeys} limit).`);
      }

      setKeysInput('');
      setLabelInput('');
      setFeedback({ type: 'success', message: parts.join(' ') });
      onUpdated();
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Unable to add API key(s).',
      });
    } finally {
      setAdding(false);
    }
  };

  const handleToggleReveal = async (item: GeminiApiKeyInfo) => {
    if (item.source === 'env') return;
    if (revealedKeys[item.id]) {
      setRevealedKeys((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      return;
    }

    setRevealingId(item.id);
    setFeedback(null);
    try {
      const res = await fetch(`/api/gemini/keys/${encodeURIComponent(item.id)}/reveal`);
      const data = await res.json();
      if (!res.ok || !data.key) {
        throw new Error(data.error || 'Unable to reveal API key.');
      }
      setRevealedKeys((prev) => ({ ...prev, [item.id]: data.key }));
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to reveal key.',
      });
    } finally {
      setRevealingId(null);
    }
  };

  const handleTestKey = async (item: GeminiApiKeyInfo) => {
    setTestingId(item.id);
    setFeedback(null);
    try {
      const res = await fetch(`/api/gemini/keys/${encodeURIComponent(item.id)}/test`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to test API key.');
      }
      const result = data.result as { ok: boolean; message: string; label: string };
      setFeedback({
        type: result.ok ? 'success' : 'error',
        message: `${result.label}: ${result.message}`,
      });
      onUpdated();
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to test API key.',
      });
    } finally {
      setTestingId(null);
    }
  };

  const handleTestAll = async () => {
    setTestingAll(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/gemini/keys/test-all', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to test Gemini API keys.');
      }
      const results = (data.results ?? []) as Array<{ ok: boolean }>;
      const passed = results.filter((r) => r.ok).length;
      setFeedback({
        type: passed > 0 ? 'success' : 'error',
        message: `Key health check complete: ${passed}/${results.length} key(s) ready for rotation.`,
      });
      onUpdated();
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to test all API keys.',
      });
    } finally {
      setTestingAll(false);
    }
  };

  const handleDeleteKey = async (item: GeminiApiKeyInfo) => {
    if (item.source === 'env') return;
    setDeletingId(item.id);
    setFeedback(null);
    try {
      const res = await fetch(`/api/gemini/keys/${encodeURIComponent(item.id)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to remove API key.');
      }
      setRevealedKeys((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      setFeedback({ type: 'success', message: `Removed "${item.label}" from rotation.` });
      onUpdated();
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Unable to delete API key.',
      });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="rounded-2xl border border-slate-800/90 bg-[#11151F] p-5 sm:p-6 space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-orange-400" />
            <h2 className="text-lg font-semibold text-slate-50">
              Gemini Multi-API Key Manager &amp; Auto-Rotation
            </h2>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            Add up to {keyPool.maxUserKeys} Gemini API keys. Requests automatically load-balance
            across ready keys and instantly fail over on 429/503 limits with cooldown recovery and
            fast model fallback.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0 text-xs">
          <span className="rounded-lg border border-slate-700/80 bg-[#0D1017] px-2.5 py-1.5 font-mono text-slate-200 tabular-nums">
            {userKeysCount}/{keyPool.maxUserKeys} Custom
          </span>
          <span className="rounded-lg border border-emerald-800/70 bg-emerald-950/35 px-2.5 py-1.5 font-mono text-emerald-300 tabular-nums">
            {keyPool.availableCount}/{keyPool.totalCount} Ready
          </span>
        </div>
      </div>

      {activeKey && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-800/60 bg-emerald-950/25 px-3.5 py-2.5 text-xs text-emerald-200">
          <span className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>
              Currently in use: <strong>{activeKey.label}</strong>{' '}
              <span className="font-mono text-emerald-300/90">({activeKey.maskedKey})</span>
            </span>
          </span>
          <span className="font-mono text-emerald-300">Auto-Rotation Active</span>
        </div>
      )}

      {/* Add Single or Multiple Keys Form */}
      <form onSubmit={handleAddKeys} className="space-y-3 rounded-xl border border-slate-800 bg-[#0D1017] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor="gemini-bulk-keys" className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            Add Single or Multiple Gemini API Keys
          </label>
          <span className="text-[11px] text-slate-400">
            {remainingSlots > 0
              ? `${remainingSlots} slot${remainingSlots === 1 ? '' : 's'} remaining`
              : 'Max 10 custom keys reached'}
          </span>
        </div>

        <textarea
          id="gemini-bulk-keys"
          rows={3}
          value={keysInput}
          onChange={(e) => setKeysInput(e.target.value)}
          placeholder="Paste 1 key or multiple Gemini API keys (one per line or comma-separated)..."
          disabled={adding || remainingSlots === 0}
          className="w-full rounded-xl border border-slate-700/80 bg-[#090B10] px-3.5 py-2.5 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none disabled:opacity-50"
        />

        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
          <input
            type="text"
            value={labelInput}
            onChange={(e) => setLabelInput(e.target.value)}
            placeholder="Optional label prefix (e.g. Studio Key)"
            disabled={adding || remainingSlots === 0}
            className="min-h-[44px] flex-1 rounded-xl border border-slate-700/80 bg-[#090B10] px-3.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none disabled:opacity-50"
          />

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={adding || remainingSlots === 0 || !keysInput.trim()}
              className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl bg-orange-600 px-4 text-xs font-semibold text-white transition-colors hover:bg-orange-500 disabled:opacity-50 whitespace-nowrap"
            >
              <Plus className="h-4 w-4" />
              <span>{adding ? 'Adding...' : 'Add Key(s)'}</span>
            </button>

            {keyPool.keys.length > 0 && (
              <button
                type="button"
                onClick={handleTestAll}
                disabled={testingAll || testingId !== null}
                className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900 px-3.5 text-xs font-semibold text-slate-200 transition-colors hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${testingAll ? 'animate-spin' : ''}`} />
                <span>{testingAll ? 'Testing All...' : 'Test All'}</span>
              </button>
            )}
          </div>
        </div>
      </form>

      {feedback && (
        <div
          role="status"
          className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-xs ${
            feedback.type === 'success'
              ? 'border-emerald-800/70 bg-emerald-950/35 text-emerald-200'
              : 'border-red-800/70 bg-red-950/35 text-red-200'
          }`}
        >
          {feedback.type === 'success' ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
          )}
          <span className="break-words">{feedback.message}</span>
        </div>
      )}

      {/* Key Pool List */}
      <div className="space-y-2.5">
        {keyPool.keys.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-800 bg-[#0D1017]/60 px-4 py-6 text-center text-xs text-slate-400">
            No Gemini API keys configured yet. Paste one or more keys above to enable AI moment
            detection and automatic rotation.
          </div>
        ) : (
          <div className="divide-y divide-slate-800/80 overflow-hidden rounded-xl border border-slate-800 bg-[#0D1017]">
            {keyPool.keys.map((item) => {
              const badge = getKeyStatusBadge(item);
              const revealed = revealedKeys[item.id];
              const isBusy =
                testingAll || testingId === item.id || deletingId === item.id || revealingId === item.id;

              return (
                <div
                  key={item.id}
                  className="flex flex-col gap-3 p-3.5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-slate-100 truncate">
                        {item.label}
                      </span>
                      {item.source === 'env' && (
                        <span className="rounded border border-slate-700 bg-slate-800/70 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-300">
                          Env Secret
                        </span>
                      )}
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-0.5 text-[11px] font-semibold ${badge.className}`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${badge.dotClass}`} />
                        <span>{badge.label}</span>
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
                      <code className="font-mono text-slate-200 break-all">
                        {revealed || item.maskedKey}
                      </code>
                      <span className="tabular-nums">
                        {item.totalRequests} req{item.totalRequests === 1 ? '' : 's'}
                      </span>
                      {item.totalErrors > 0 && (
                        <span className="text-amber-400 tabular-nums">
                          {item.totalErrors} err{item.totalErrors === 1 ? '' : 's'}
                        </span>
                      )}
                    </div>

                    {item.lastError && (
                      <div className="flex items-start gap-1.5 text-[11px] text-red-300/90 break-words">
                        <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
                        <span>{item.lastError}</span>
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {item.source === 'user' && (
                      <button
                        type="button"
                        onClick={() => void handleToggleReveal(item)}
                        disabled={isBusy}
                        title={revealed ? 'Hide API key' : 'Show API key'}
                        aria-label={revealed ? `Hide ${item.label}` : `Show ${item.label}`}
                        className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-700/80 bg-[#090B10] text-slate-300 transition-colors hover:bg-slate-800 hover:text-slate-100 disabled:opacity-50"
                      >
                        {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => void handleTestKey(item)}
                      disabled={isBusy}
                      className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-slate-700/80 bg-[#090B10] px-3 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                    >
                      <FlaskConical
                        className={`h-3.5 w-3.5 ${testingId === item.id ? 'animate-pulse text-orange-400' : ''}`}
                      />
                      <span>{testingId === item.id ? 'Testing...' : 'Test'}</span>
                    </button>

                    {item.source === 'user' && (
                      <button
                        type="button"
                        onClick={() => void handleDeleteKey(item)}
                        disabled={isBusy}
                        title="Delete API key"
                        aria-label={`Delete ${item.label}`}
                        className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-800 bg-[#090B10] text-slate-400 transition-colors hover:border-red-900/70 hover:bg-red-950/40 hover:text-red-300 disabled:opacity-50"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <p className="text-[11px] leading-relaxed text-slate-500">
        Rotation Strategy: Least-recently-used &amp; concurrency-balanced across healthy keys.
        On <code className="font-mono text-slate-400">429</code> or{' '}
        <code className="font-mono text-slate-400">503</code>, keys enter a 30–60s cooldown and
        traffic switches immediately with exponential backoff. Any{' '}
        <code className="font-mono text-slate-400">404</code> model is auto-quarantined and
        replaced via dynamic <code className="font-mono text-slate-400">models.list()</code>{' '}
        discovery.
      </p>
    </div>
  );
}
