import { useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  KeyRound,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { AiProviderChoice, ClaudeKeyPoolSummary } from '../types.ts';

interface AiProviderAndClaudeCardProps {
  aiProvider: AiProviderChoice;
  activeAiProvider: 'claude' | 'gemini';
  keyPool: ClaudeKeyPoolSummary;
  onUpdated: () => void;
}

const PROVIDER_OPTIONS: Array<{
  id: AiProviderChoice;
  title: string;
  subtitle: string;
}> = [
  {
    id: 'auto',
    title: 'Auto (Claude Primary)',
    subtitle: 'Uses Claude for Creative Director writing & chat, auto-falls back to Gemini.',
  },
  {
    id: 'claude',
    title: 'Claude Direct',
    subtitle: 'Prioritizes Anthropic Claude for #BD titles, instructions & live engagement.',
  },
  {
    id: 'gemini',
    title: 'Gemini Only',
    subtitle: 'Routes both raw video scanning and text writing through your Gemini pool.',
  },
];

export function AiProviderAndClaudeCard({
  aiProvider,
  activeAiProvider,
  keyPool,
  onUpdated,
}: AiProviderAndClaudeCardProps) {
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [labelInput, setLabelInput] = useState('');
  const [switchingProvider, setSwitchingProvider] = useState(false);
  const [addingKey, setAddingKey] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const handleSelectProvider = async (nextProvider: AiProviderChoice) => {
    if (nextProvider === aiProvider) return;
    setSwitchingProvider(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/ai/provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: nextProvider }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update AI provider selection.');
      }
      setFeedback({
        type: 'success',
        message: `AI Creative Director routing set to "${nextProvider.toUpperCase()}" (currently active: ${
          data.activeAiProvider === 'claude' ? 'Claude' : 'Gemini'
        }).`,
      });
      onUpdated();
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Unable to switch AI provider.',
      });
    } finally {
      setSwitchingProvider(false);
    }
  };

  const handleAddKey = async (e: FormEvent) => {
    e.preventDefault();
    setFeedback(null);

    if (!apiKeyInput.trim()) {
      setFeedback({
        type: 'error',
        message: 'Paste an Anthropic Claude API key (starts with sk-ant-...).',
      });
      return;
    }

    setAddingKey(true);
    try {
      const res = await fetch('/api/claude/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: apiKeyInput.trim(),
          label: labelInput.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to add Anthropic Claude API key.');
      }
      setApiKeyInput('');
      setLabelInput('');
      setFeedback({
        type: 'success',
        message: 'Anthropic Claude API key added to Creative Director pool.',
      });
      onUpdated();
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Unable to save Claude API key.',
      });
    } finally {
      setAddingKey(false);
    }
  };

  const handleDeleteKey = async (id: string, label: string) => {
    setDeletingId(id);
    setFeedback(null);
    try {
      const res = await fetch(`/api/claude/keys/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to remove Claude API key.');
      }
      setFeedback({
        type: 'success',
        message: `Removed "${label}" from Claude pool.`,
      });
      onUpdated();
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Unable to remove Claude API key.',
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
            <Sparkles className="h-5 w-5 text-orange-400" />
            <h2 className="text-lg font-semibold text-slate-50">
              AI Provider Routing &amp; Anthropic Claude Creative Director
            </h2>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            Gemini scans raw video audio/frames for timestamps, while Claude acts as Creative
            Director for unique #BD titles, Bengali/Banglish/English variety, strict custom
            instructions, timing explanations, and Live Studio chat.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0 text-xs">
          <span
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 font-mono font-semibold ${
              activeAiProvider === 'claude'
                ? 'border-emerald-800/70 bg-emerald-950/35 text-emerald-300'
                : 'border-orange-800/70 bg-orange-950/35 text-orange-300'
            }`}
          >
            <Cpu className="h-3.5 w-3.5" />
            <span>Active: {activeAiProvider === 'claude' ? 'Claude' : 'Gemini'}</span>
          </span>
          <span className="rounded-lg border border-slate-700/80 bg-[#0D1017] px-2.5 py-1.5 font-mono text-slate-200 tabular-nums">
            {keyPool.totalCount} Claude Key{keyPool.totalCount === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      {/* AI Provider Routing Mode Selector */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        {PROVIDER_OPTIONS.map((opt) => {
          const selected = aiProvider === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              disabled={switchingProvider}
              onClick={() => void handleSelectProvider(opt.id)}
              className={`flex flex-col items-start rounded-xl border p-3.5 text-left transition-colors disabled:opacity-60 ${
                selected
                  ? 'border-orange-500/80 bg-orange-950/30 text-slate-50'
                  : 'border-slate-800 bg-[#090B10] text-slate-300 hover:border-slate-700 hover:text-slate-100'
              }`}
            >
              <div className="flex w-full items-center justify-between gap-2">
                <span className="text-xs font-semibold">{opt.title}</span>
                {selected && (
                  <span className="h-2 w-2 rounded-full bg-orange-400" aria-hidden="true" />
                )}
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{opt.subtitle}</p>
            </button>
          );
        })}
      </div>

      {/* Add Anthropic Claude API Key Form */}
      <form
        onSubmit={handleAddKey}
        className="space-y-3 rounded-xl border border-slate-800 bg-[#0D1017] p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label
            htmlFor="claude-api-key-input"
            className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-300"
          >
            <KeyRound className="h-3.5 w-3.5 text-orange-400" />
            <span>Add Anthropic Claude API Key</span>
          </label>
          <span className="text-[11px] text-slate-400">
            Stored server-side with automatic key failover
          </span>
        </div>

        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
          <input
            id="claude-api-key-input"
            type="password"
            autoComplete="off"
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            placeholder="sk-ant-api03-..."
            disabled={addingKey}
            className="min-h-[44px] flex-[2] rounded-xl border border-slate-700/80 bg-[#090B10] px-3.5 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none disabled:opacity-50"
          />
          <input
            type="text"
            value={labelInput}
            onChange={(e) => setLabelInput(e.target.value)}
            placeholder="Optional label (e.g. Studio Claude)"
            disabled={addingKey}
            className="min-h-[44px] flex-1 rounded-xl border border-slate-700/80 bg-[#090B10] px-3.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={addingKey || !apiKeyInput.trim()}
            className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl bg-orange-600 px-4 text-xs font-semibold text-white transition-colors hover:bg-orange-500 disabled:opacity-50 whitespace-nowrap"
          >
            <Plus className="h-4 w-4" />
            <span>{addingKey ? 'Saving...' : 'Add Claude Key'}</span>
          </button>
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

      {/* Claude Keys Pool List */}
      <div className="space-y-2.5">
        {keyPool.keys.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-800 bg-[#0D1017]/60 px-4 py-5 text-center text-xs text-slate-400">
            No Anthropic Claude API key configured yet. Add a Claude key above or set{' '}
            <code className="font-mono text-slate-300">ANTHROPIC_API_KEY</code> in Settings &gt;
            Secrets to activate Claude Creative Director mode.
          </div>
        ) : (
          <div className="divide-y divide-slate-800/80 overflow-hidden rounded-xl border border-slate-800 bg-[#0D1017]">
            {keyPool.keys.map((item) => (
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
                      className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-0.5 text-[11px] font-semibold ${
                        item.status === 'invalid'
                          ? 'border-red-800/80 bg-red-950/50 text-red-300'
                          : item.status === 'rate_limited'
                          ? 'border-amber-700/70 bg-amber-950/50 text-amber-300'
                          : 'border-emerald-700/70 bg-emerald-950/50 text-emerald-300'
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          item.status === 'invalid'
                            ? 'bg-red-400'
                            : item.status === 'rate_limited'
                            ? 'bg-amber-400'
                            : 'bg-emerald-400'
                        }`}
                      />
                      <span>
                        {item.inUse
                          ? 'In Use'
                          : item.status === 'rate_limited'
                          ? 'Rate Limited'
                          : item.status === 'invalid'
                          ? 'Invalid'
                          : 'Ready'}
                      </span>
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
                    <code className="font-mono text-slate-200">{item.maskedKey}</code>
                    <span className="tabular-nums">
                      {item.totalRequests} req{item.totalRequests === 1 ? '' : 's'}
                    </span>
                    {item.totalErrors > 0 && (
                      <span className="text-amber-400 tabular-nums">
                        {item.totalErrors} err{item.totalErrors === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                </div>

                {item.source === 'user' && (
                  <button
                    type="button"
                    onClick={() => void handleDeleteKey(item.id, item.label)}
                    disabled={deletingId === item.id}
                    aria-label={`Delete ${item.label}`}
                    title="Delete Claude API key"
                    className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-800 bg-[#090B10] text-slate-400 transition-colors hover:border-red-900/70 hover:bg-red-950/40 hover:text-red-300 disabled:opacity-50 shrink-0"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
