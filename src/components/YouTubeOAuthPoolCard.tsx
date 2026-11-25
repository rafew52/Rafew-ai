import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  KeyRound,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import type { YouTubeOAuthPoolSummary, YouTubeOAuthSlotStatus } from '../types.ts';

interface YouTubeOAuthPoolCardProps {
  pool?: YouTubeOAuthPoolSummary;
  onUpdated: () => void;
}

const STATUS_META: Record<
  YouTubeOAuthSlotStatus,
  { label: string; textClass: string; borderClass: string }
> = {
  active_ready: {
    label: 'Active / Ready',
    textClass: 'text-emerald-400',
    borderClass: 'border-emerald-800/80 bg-emerald-950/15',
  },
  quota_exhausted: {
    label: 'Quota Exhausted (Cooldown until PT reset)',
    textClass: 'text-amber-400',
    borderClass: 'border-amber-800/80 bg-amber-950/15',
  },
  needs_reauth: {
    label: 'Needs Re-Auth',
    textClass: 'text-orange-400',
    borderClass: 'border-orange-800/80 bg-orange-950/15',
  },
  invalid_credentials: {
    label: 'Invalid Credentials',
    textClass: 'text-red-400',
    borderClass: 'border-red-900/80 bg-red-950/20',
  },
};

export function YouTubeOAuthPoolCard({ pool, onUpdated }: YouTubeOAuthPoolCardProps) {
  const [localPool, setLocalPool] = useState<YouTubeOAuthPoolSummary | undefined>(pool);
  const [label, setLabel] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [showAdvancedRedirect, setShowAdvancedRedirect] = useState(false);

  const [busySlotId, setBusySlotId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [copiedUri, setCopiedUri] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingAuthLink, setPendingAuthLink] = useState<string | null>(null);
  const [awaitingSlotId, setAwaitingSlotId] = useState<string | null>(null);

  useEffect(() => {
    if (pool) {
      setLocalPool(pool);
    }
  }, [pool]);

  const refreshPool = useCallback(async () => {
    try {
      const res = await fetch('/api/youtube/oauth-pool');
      if (!res.ok) return;
      const data = (await res.json()) as { oauthPool?: YouTubeOAuthPoolSummary };
      if (data.oauthPool) {
        setLocalPool(data.oauthPool);
        if (awaitingSlotId) {
          const matched = data.oauthPool.slots.find((s) => s.id === awaitingSlotId);
          if (matched && matched.status === 'active_ready' && matched.hasAccessToken) {
            setAwaitingSlotId(null);
            setPendingAuthLink(null);
            setError(null);
            setNotice(
              `Authorized "${matched.label}" for "${
                matched.channel?.title || 'YouTube'
              }". Queued uploads resumed.`
            );
          }
        }
      }
    } catch {
      // ignore transient network check
    }
  }, [awaitingSlotId]);

  useEffect(() => {
    if (!pool) {
      void refreshPool();
    }
  }, [pool, refreshPool]);

  // Listen for OAuth popup completion via window.postMessage AND fallback focus/visibility sync (mobile Chrome often detaches window.opener)
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as
        | { type?: string; slotId?: string; label?: string; channelTitle?: string; error?: string }
        | undefined;
      if (!data || typeof data.type !== 'string') return;

      if (data.type === 'YT_OAUTH_SUCCESS') {
        setError(null);
        setPendingAuthLink(null);
        setAwaitingSlotId(null);
        setNotice(
          `Authorized "${data.label || 'OAuth Slot'}" for channel "${
            data.channelTitle || 'YouTube'
          }". Refresh token saved & queued uploads resumed.`
        );
        void refreshPool();
        onUpdated();
      } else if (data.type === 'YT_OAUTH_ERROR') {
        setAwaitingSlotId(null);
        setError(data.error || 'Google OAuth authorization failed.');
      }
    };

    const syncOnReturn = () => {
      if (awaitingSlotId) {
        void refreshPool();
        onUpdated();
      }
    };

    window.addEventListener('message', onMessage);
    window.addEventListener('focus', syncOnReturn);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('focus', syncOnReturn);
    };
  }, [awaitingSlotId, onUpdated, refreshPool]);

  useEffect(() => {
    if (!awaitingSlotId) return;
    const timer = setInterval(() => {
      void refreshPool();
      onUpdated();
    }, 2500);
    const timeout = setTimeout(() => setAwaitingSlotId(null), 120_000);
    return () => {
      clearInterval(timer);
      clearTimeout(timeout);
    };
  }, [awaitingSlotId, onUpdated, refreshPool]);

  const effectiveRedirectUri =
    (typeof window !== 'undefined'
      ? `${window.location.origin}/api/youtube/oauth/callback`
      : localPool?.defaultRedirectUri) ||
    localPool?.defaultRedirectUri ||
    'http://localhost:3000/api/youtube/oauth/callback';

  const handleCopyRedirectUri = async () => {
    try {
      await navigator.clipboard.writeText(effectiveRedirectUri);
      setCopiedUri(true);
      setTimeout(() => setCopiedUri(false), 2000);
    } catch {
      setError('Could not copy to clipboard automatically. Highlight and copy the URI below.');
    }
  };

  const handleAddCredential = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdding(true);
    setError(null);
    setNotice(null);

    try {
      const res = await fetch('/api/youtube/oauth-pool/slots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: label.trim() || undefined,
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
          redirectUri: redirectUri.trim() || effectiveRedirectUri,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to add OAuth2 credential.');
      }
      if (data.oauthPool) setLocalPool(data.oauthPool);
      setLabel('');
      setClientId('');
      setClientSecret('');
      setNotice(
        `Added "${data.slot?.label || 'Google Cloud Project'}". Click "Authorize" next to connect your YouTube channel.`
      );
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save OAuth2 credential.');
    } finally {
      setAdding(false);
    }
  };

  const handleAuthorizeSlot = async (slotId: string) => {
    setBusySlotId(slotId);
    setError(null);
    setNotice(null);
    setPendingAuthLink(null);

    // Open blank popup SYNCHRONOUSLY inside user click gesture so Android Chrome / Safari doesn't block it after await fetch()
    const popup = window.open(
      'about:blank',
      'yt_oauth_popup',
      'width=600,height=720,menubar=no,toolbar=no,status=no'
    );

    try {
      const res = await fetch(`/api/youtube/oauth-pool/slots/${encodeURIComponent(slotId)}/auth-url`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        if (popup && !popup.closed) popup.close();
        throw new Error(data.error || 'Failed to generate Google OAuth consent URL.');
      }

      setAwaitingSlotId(slotId);
      setPendingAuthLink(data.url);

      if (popup && !popup.closed) {
        popup.location.href = data.url;
      } else {
        setError(
          'Your browser blocked the automatic popup. Tap "Continue to Google OAuth" below to authorize directly.'
        );
      }
    } catch (err) {
      if (popup && !popup.closed) popup.close();
      setError(err instanceof Error ? err.message : 'Failed to start OAuth flow.');
    } finally {
      setBusySlotId(null);
    }
  };

  const handleTestSlot = async (slotId: string) => {
    setBusySlotId(slotId);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/youtube/oauth-pool/slots/${encodeURIComponent(slotId)}/test`, {
        method: 'POST',
      });
      const data = await res.json();
      if (data.oauthPool) setLocalPool(data.oauthPool);
      if (!res.ok) {
        throw new Error(data.error || 'Failed to test YouTube OAuth slot.');
      }
      if (data.result?.ok) {
        setNotice(data.result.message);
      } else {
        setError(data.result?.message || 'Slot check returned an error.');
      }
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Slot test failed.');
    } finally {
      setBusySlotId(null);
    }
  };

  const handleResetQuota = async (slotId: string) => {
    setBusySlotId(slotId);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(
        `/api/youtube/oauth-pool/slots/${encodeURIComponent(slotId)}/reset-quota`,
        { method: 'POST' }
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to reset slot quota counter.');
      }
      if (data.oauthPool) setLocalPool(data.oauthPool);
      setNotice('Reset daily quota state for slot and resumed any paused uploads.');
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to reset slot quota.');
    } finally {
      setBusySlotId(null);
    }
  };

  const handleDeleteSlot = async (slotId: string) => {
    setBusySlotId(slotId);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/youtube/oauth-pool/slots/${encodeURIComponent(slotId)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to remove OAuth slot.');
      }
      if (data.oauthPool) setLocalPool(data.oauthPool);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to remove slot.');
    } finally {
      setBusySlotId(null);
    }
  };

  const slots = localPool?.slots || [];
  const readyCount = localPool?.readyCount || 0;
  const exhaustedCount = localPool?.exhaustedCount || 0;
  const remainingQuota = localPool?.estimatedRemainingQuota || 0;

  return (
    <div className="rounded-xl border border-slate-800/90 bg-[#090B10] p-4 sm:p-5 space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-orange-400 shrink-0" />
            <h3 className="text-sm font-semibold text-slate-100">
              Multi-Project Google Cloud OAuth2 Pool &amp; Quota Rotation Engine
            </h3>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">
            Add multiple Google Cloud OAuth2 credentials (10,000 units/day per project) authorized
            to the same YouTube channel. If a project hits <code className="font-mono text-slate-300">quotaExceeded</code>,
            uploads, thumbnails, searches, and live broadcasts fail over automatically without
            losing queued MP4s.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-2 shrink-0">
          <div className="rounded-lg border border-slate-800 bg-[#11151F] px-3 py-2 text-right">
            <div className="text-[10px] uppercase tracking-wider text-slate-400">Ready</div>
            <div className="font-mono text-sm font-bold text-emerald-400">{readyCount}</div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-[#11151F] px-3 py-2 text-right">
            <div className="text-[10px] uppercase tracking-wider text-slate-400">Exhausted</div>
            <div className="font-mono text-sm font-bold text-amber-400">{exhaustedCount}</div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-[#11151F] px-3 py-2 text-right">
            <div className="text-[10px] uppercase tracking-wider text-slate-400">Pool Quota</div>
            <div className="font-mono text-sm font-bold text-slate-100">
              {remainingQuota.toLocaleString()}
            </div>
          </div>
        </div>
      </div>

      {/* Authorized Redirect URI Box */}
      <div className="rounded-lg border border-slate-800/80 bg-[#11151F] p-3 space-y-1.5">
        <div className="text-[11px] font-medium text-slate-300">
          Authorized Redirect URI (Add this to each Google Cloud OAuth2 Client):
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <code className="block break-all font-mono text-[11px] text-orange-300">
            {effectiveRedirectUri}
          </code>
          <button
            type="button"
            onClick={() => void handleCopyRedirectUri()}
            className="inline-flex min-h-[32px] shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
          >
            {copiedUri ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-400" />
                <span>Copied</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                <span>Copy Redirect URI</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Add Google Cloud OAuth2 Credential Form */}
      <form
        onSubmit={(e) => void handleAddCredential(e)}
        className="rounded-lg border border-slate-800 bg-[#11151F]/80 p-3.5 space-y-3"
      >
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-200">
            Add Google Cloud OAuth2 Project Credential
          </span>
          <button
            type="button"
            onClick={() => setShowAdvancedRedirect((v) => !v)}
            className="text-[11px] font-medium text-slate-400 hover:text-slate-200"
          >
            {showAdvancedRedirect ? 'Hide custom Redirect URI' : 'Custom Redirect URI'}
          </button>
        </div>

        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (e.g. Project #2)"
            className="min-h-[40px] rounded-lg border border-slate-800 bg-[#090B10] px-3 text-xs text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
          />
          <input
            type="text"
            required
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="OAuth2 Client ID (*.apps.googleusercontent.com)"
            className="min-h-[40px] rounded-lg border border-slate-800 bg-[#090B10] px-3 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
          />
          <input
            type="password"
            required
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder="OAuth2 Client Secret"
            className="min-h-[40px] rounded-lg border border-slate-800 bg-[#090B10] px-3 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
          />
        </div>

        {showAdvancedRedirect && (
          <input
            type="url"
            value={redirectUri}
            onChange={(e) => setRedirectUri(e.target.value)}
            placeholder={effectiveRedirectUri}
            className="min-h-[40px] w-full rounded-lg border border-slate-800 bg-[#090B10] px-3 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
          />
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] text-slate-400">
            Requests <code className="font-mono text-slate-300">youtube</code> &amp;{' '}
            <code className="font-mono text-slate-300">youtube.force-ssl</code> with offline refresh
            tokens. Secrets remain server-side only.
          </p>
          <button
            type="submit"
            disabled={adding || !clientId.trim() || !clientSecret.trim()}
            className="inline-flex min-h-[38px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-orange-600 px-3.5 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>{adding ? 'Saving...' : 'Add OAuth2 Slot'}</span>
          </button>
        </div>
      </form>

      {(error || pendingAuthLink) && (
        <div
          role={error ? 'alert' : 'status'}
          className={`rounded-lg border px-3.5 py-2.5 text-xs space-y-2 ${
            error
              ? 'border-red-900/70 bg-red-950/40 text-red-200'
              : 'border-slate-700 bg-[#11151F] text-slate-200'
          }`}
        >
          {error && <div>{error}</div>}
          {pendingAuthLink && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] text-slate-300">
                Waiting for Google consent completion...
              </span>
              <a
                href={pendingAuthLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg bg-orange-600 px-3 text-[11px] font-semibold text-white hover:bg-orange-500"
              >
                <ExternalLink className="h-3 w-3" />
                <span>Continue to Google OAuth</span>
              </a>
            </div>
          )}
        </div>
      )}

      {notice && (
        <div className="rounded-lg border border-emerald-900/70 bg-emerald-950/30 px-3.5 py-2.5 text-xs text-emerald-200">
          {notice}
        </div>
      )}

      {/* Credential Slots List */}
      {slots.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-800 px-4 py-5 text-center text-xs text-slate-400">
          No Google Cloud OAuth2 project slots added yet. Add your backup OAuth2 Client ID &amp;
          Secret above or connect Quick OAuth Slots above.
        </div>
      ) : (
        <div className="space-y-2.5">
          {slots.map((slot) => {
            const meta = STATUS_META[slot.status] || STATUS_META.needs_reauth;
            const pct = Math.min(
              100,
              Math.round((slot.quotaUnitsUsedToday / Math.max(1, slot.dailyQuotaLimit)) * 100)
            );
            const isBusy = busySlotId === slot.id;

            return (
              <div
                key={slot.id}
                className={`rounded-xl border p-3.5 space-y-2.5 ${meta.borderClass}`}
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold text-slate-100">{slot.label}</span>
                      <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
                        {slot.authType === 'oauth2_credentials'
                          ? 'Google Cloud OAuth2'
                          : 'Quick Sign-In'}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 text-[11px] font-semibold ${meta.textClass}`}
                      >
                        {slot.status === 'active_ready' ? (
                          <CheckCircle2 className="h-3 w-3" />
                        ) : (
                          <AlertTriangle className="h-3 w-3" />
                        )}
                        <span>{meta.label}</span>
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
                      {slot.channel && (
                        <span className="text-slate-200 font-medium">
                          Channel: {slot.channel.title}
                        </span>
                      )}
                      {slot.clientIdMasked && (
                        <span className="font-mono">Client: {slot.clientIdMasked}</span>
                      )}
                      {slot.authType === 'oauth2_credentials' && (
                        <span
                          className={
                            slot.hasRefreshToken ? 'text-emerald-400' : 'text-amber-400'
                          }
                        >
                          {slot.hasRefreshToken ? 'Refresh Token Saved' : 'Not Authorized Yet'}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                    {slot.authType === 'oauth2_credentials' && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void handleAuthorizeSlot(slot.id)}
                        className="inline-flex min-h-[32px] items-center gap-1 rounded-lg bg-orange-600 px-2.5 text-[11px] font-semibold text-white hover:bg-orange-500 disabled:opacity-50"
                      >
                        <ExternalLink className="h-3 w-3" />
                        <span>
                          {slot.hasRefreshToken || slot.hasAccessToken
                            ? 'Re-Authorize'
                            : 'Authorize'}
                        </span>
                      </button>
                    )}

                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleTestSlot(slot.id)}
                      className="inline-flex min-h-[32px] items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-2.5 text-[11px] font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                    >
                      <RefreshCw className={`h-3 w-3 ${isBusy ? 'animate-spin' : ''}`} />
                      <span>Test</span>
                    </button>

                    {slot.status === 'quota_exhausted' && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void handleResetQuota(slot.id)}
                        className="inline-flex min-h-[32px] items-center gap-1 rounded-lg border border-amber-700/80 bg-amber-950/40 px-2.5 text-[11px] font-medium text-amber-200 hover:bg-amber-900/60 disabled:opacity-50"
                      >
                        <RotateCcw className="h-3 w-3" />
                        <span>Reset Quota</span>
                      </button>
                    )}

                    {slot.authType === 'oauth2_credentials' && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void handleDeleteSlot(slot.id)}
                        aria-label={`Remove ${slot.label}`}
                        className="inline-flex min-h-[32px] items-center justify-center rounded-lg border border-slate-700 px-2 text-slate-400 hover:border-red-800 hover:text-red-300 disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Quota Meter */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[11px] text-slate-400">
                    <span>
                      Daily Quota Usage ({slot.quotaDatePt} PT)
                    </span>
                    <span className="font-mono text-slate-200">
                      {slot.quotaUnitsUsedToday.toLocaleString()} /{' '}
                      {slot.dailyQuotaLimit.toLocaleString()} units ({pct}%)
                    </span>
                  </div>
                  <progress
                    value={pct}
                    max={100}
                    className={`block h-1.5 w-full overflow-hidden rounded-full bg-slate-800 [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-slate-800 [&::-webkit-progress-value]:rounded-full ${
                      slot.status === 'quota_exhausted' || pct >= 90
                        ? '[&::-webkit-progress-value]:bg-amber-500 [&::-moz-progress-bar]:bg-amber-500'
                        : '[&::-webkit-progress-value]:bg-emerald-500 [&::-moz-progress-bar]:bg-emerald-500'
                    }`}
                  />
                </div>

                {slot.lastError && (
                  <div className="text-[11px] text-amber-300/90 break-words">
                    Last notice: {slot.lastError}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
