import { useEffect, useRef, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  KeyRound,
  Layers,
  Loader2,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  X,
} from 'lucide-react';
import type {
  ZernioAccount,
  ZernioConnectionSettings,
  ZernioTikTokOptions,
  ZernioUploadMode,
} from '../types.ts';

interface ZernioConnectModalProps {
  open: boolean;
  settings: ZernioConnectionSettings;
  onClose: () => void;
  onUpdated: () => void;
}

interface PendingAuthChallenge {
  userCode: string;
  browserUrl: string;
  expiresAt: string;
  intervalSeconds: number;
}

const PLATFORM_META: Record<string, { label: string; colorClass: string }> = {
  tiktok: {
    label: 'TikTok',
    colorClass: 'border-cyan-700/70 bg-cyan-950/60 text-cyan-200',
  },
  youtube: {
    label: 'YouTube',
    colorClass: 'border-red-700/70 bg-red-950/50 text-red-200',
  },
  instagram: {
    label: 'Instagram',
    colorClass: 'border-pink-700/70 bg-pink-950/50 text-pink-200',
  },
  facebook: {
    label: 'Facebook',
    colorClass: 'border-blue-700/70 bg-blue-950/50 text-blue-200',
  },
  twitter: {
    label: 'X / Twitter',
    colorClass: 'border-slate-600 bg-slate-800/80 text-slate-200',
  },
  threads: {
    label: 'Threads',
    colorClass: 'border-slate-600 bg-slate-800/80 text-slate-200',
  },
  linkedin: {
    label: 'LinkedIn',
    colorClass: 'border-sky-700/70 bg-sky-950/50 text-sky-200',
  },
  bluesky: {
    label: 'Bluesky',
    colorClass: 'border-sky-700/70 bg-sky-950/50 text-sky-200',
  },
  pinterest: {
    label: 'Pinterest',
    colorClass: 'border-rose-700/70 bg-rose-950/50 text-rose-200',
  },
  reddit: {
    label: 'Reddit',
    colorClass: 'border-orange-700/70 bg-orange-950/50 text-orange-200',
  },
};

export function getPlatformBadgeMeta(platform: string): {
  label: string;
  colorClass: string;
} {
  const key = platform.toLowerCase();
  return (
    PLATFORM_META[key] || {
      label: platform.charAt(0).toUpperCase() + platform.slice(1),
      colorClass: 'border-indigo-700/70 bg-indigo-950/50 text-indigo-200',
    }
  );
}

export function ZernioConnectModal({
  open,
  settings,
  onClose,
  onUpdated,
}: ZernioConnectModalProps) {
  const [challenge, setChallenge] = useState<PendingAuthChallenge | null>(null);
  const [initiating, setInitiating] = useState(false);
  const [pollingNow, setPollingNow] = useState(false);
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [connectingKey, setConnectingKey] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pollTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) {
      if (pollTimerRef.current) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }
    setError(null);
    setNotice(null);
  }, [open]);

  const checkPollStatus = async (manual = false) => {
    if (manual) setPollingNow(true);
    try {
      const res = await fetch('/api/zernio/auth/poll');
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to check Zernio authorization status.');
      }
      if (data.status === 'authorized') {
        setChallenge(null);
        setNotice(
          `Connected Zernio! Synced ${data.zernio?.accounts?.length ?? 0} social account(s).`
        );
        if (pollTimerRef.current) {
          window.clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        onUpdated();
      } else if (data.status === 'expired') {
        setChallenge(null);
        setError(data.message || 'Zernio authorization code expired. Try again.');
        if (pollTimerRef.current) {
          window.clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      } else if (manual) {
        setNotice('Waiting for you to click Authorize on zernio.com...');
      }
    } catch (err) {
      if (manual) {
        setError(err instanceof Error ? err.message : 'Unable to verify Zernio sign-in.');
      }
    } finally {
      if (manual) setPollingNow(false);
    }
  };

  useEffect(() => {
    if (!open || !challenge || settings.connected) {
      if (pollTimerRef.current) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }

    const intervalMs = Math.max(5000, (challenge.intervalSeconds || 5) * 1000);
    pollTimerRef.current = window.setInterval(() => {
      void checkPollStatus(false);
    }, intervalMs);

    return () => {
      if (pollTimerRef.current) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, challenge, settings.connected]);

  if (!open) return null;

  const handleStartDeviceAuth = async () => {
    setInitiating(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/zernio/auth/initiate', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to start Zernio sign-in.');
      }
      setChallenge(data as PendingAuthChallenge);
      // Try opening Zernio login tab directly on user click
      window.open(data.browserUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start Zernio authorization.');
    } finally {
      setInitiating(false);
    }
  };

  const handleConnectWithKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKeyInput.trim()) return;
    setConnectingKey(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/zernio/connect-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKeyInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Invalid Zernio API key.');
      }
      setApiKeyInput('');
      setShowKeyForm(false);
      setChallenge(null);
      setNotice(
        `Connected Zernio and synced ${data.zernio?.accounts?.length ?? 0} account(s)!`
      );
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect Zernio API key.');
    } finally {
      setConnectingKey(false);
    }
  };

  const handleRefreshAccounts = async () => {
    setRefreshing(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/zernio/accounts/refresh', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to refresh Zernio accounts.');
      }
      setNotice(`Synced ${data.zernio?.accounts?.length ?? 0} connected account(s) from Zernio.`);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to refresh accounts.');
    } finally {
      setRefreshing(false);
    }
  };

  const applySettingsPatch = async (patch: {
    autoUploadEnabled?: boolean;
    uploadMode?: ZernioUploadMode;
    selectedAccountIds?: string[];
    tiktokOptions?: Partial<ZernioTikTokOptions>;
  }) => {
    setSavingSettings(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/zernio/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update Zernio settings.');
      }
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save Zernio settings.');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleToggleAccount = (acc: ZernioAccount) => {
    const current = new Set(settings.selectedAccountIds);
    if (current.has(acc.id)) {
      current.delete(acc.id);
    } else {
      current.add(acc.id);
    }
    void applySettingsPatch({ selectedAccountIds: Array.from(current) });
  };

  const handleDisconnect = async () => {
    setSavingSettings(true);
    setError(null);
    try {
      await fetch('/api/zernio/disconnect', { method: 'POST' });
      setChallenge(null);
      setNotice('Disconnected Zernio session and cleared API key.');
      onUpdated();
    } finally {
      setSavingSettings(false);
    }
  };

  const copyCode = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 1800);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="zernio-modal-title"
    >
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-800 bg-[#11151F] p-5 sm:p-6 shadow-2xl space-y-5">
        <div className="flex items-start justify-between gap-3 border-b border-slate-800/80 pb-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Layers className="h-5 w-5 text-indigo-400 shrink-0" />
              <h2 id="zernio-modal-title" className="text-base font-semibold text-slate-50">
                Zernio Multi-Platform Accounts &amp; Auto-Upload
              </h2>
              {settings.connected && (
                <span className="text-xs font-semibold text-emerald-400">· Connected</span>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-400">
              Sign in with Zernio to load every social account connected in your Zernio workspace
              (TikTok, YouTube, Instagram, Facebook, X, Threads, etc.) and auto-upload clips.
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close Zernio modal"
            className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded-xl border border-slate-800 text-slate-400 hover:bg-slate-800 hover:text-slate-100 shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {!settings.connected ? (
          <div className="space-y-4">
            {/* Step 1: Zernio Device Sign-In */}
            <div className="rounded-xl border border-indigo-900/60 bg-indigo-950/20 p-4 space-y-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-sm font-semibold text-slate-100">
                    Sign in with Zernio (1-Click Authorization)
                  </div>
                  <p className="mt-0.5 text-xs text-slate-400">
                    Opens Zernio authorization link, waits for you to click Authorize, then
                    automatically loads all your connected social accounts.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={initiating}
                  onClick={() => void handleStartDeviceAuth()}
                  className="inline-flex min-h-[42px] items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 shrink-0"
                >
                  {initiating ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ExternalLink className="h-4 w-4" />
                  )}
                  <span>
                    {initiating
                      ? 'Generating Link...'
                      : challenge
                      ? 'New Sign-In Link'
                      : 'Sign in with Zernio'}
                  </span>
                </button>
              </div>

              {challenge && (
                <div className="rounded-xl border border-indigo-800/70 bg-[#090B10] p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2 text-xs font-semibold text-indigo-300">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Waiting for you to authorize in browser...</span>
                    </span>
                    <div className="flex items-center gap-1.5 font-mono text-xs text-slate-200">
                      <span>Code:</span>
                      <strong className="rounded bg-slate-800 px-2 py-0.5 text-indigo-300">
                        {challenge.userCode}
                      </strong>
                      <button
                        type="button"
                        onClick={() => void copyCode(challenge.userCode)}
                        className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
                        title="Copy user code"
                      >
                        {copiedCode ? (
                          <Check className="h-3.5 w-3.5 text-emerald-400" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      href={challenge.browserUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 text-xs font-semibold text-white hover:bg-emerald-500"
                    >
                      <span>Open Zernio Authorization Link</span>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                    <button
                      type="button"
                      disabled={pollingNow}
                      onClick={() => void checkPollStatus(true)}
                      className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${pollingNow ? 'animate-spin' : ''}`} />
                      <span>I Authorized — Check Now</span>
                    </button>
                  </div>

                  <p className="break-all font-mono text-[11px] text-slate-400">
                    {challenge.browserUrl}
                  </p>
                </div>
              )}
            </div>

            {/* Alternative: Paste Zernio API Key */}
            <div className="rounded-xl border border-slate-800 bg-[#090B10] p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-200">
                  <KeyRound className="h-3.5 w-3.5 text-indigo-400" />
                  <span>Or Connect with Zernio API Key</span>
                </span>
                <button
                  type="button"
                  onClick={() => setShowKeyForm((prev) => !prev)}
                  className="text-xs font-medium text-indigo-300 hover:underline"
                >
                  {showKeyForm ? 'Hide' : 'Paste API Key'}
                </button>
              </div>

              {showKeyForm && (
                <form onSubmit={(e) => void handleConnectWithKey(e)} className="space-y-2.5">
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      type="password"
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      placeholder="sk_... (from zernio.com/dashboard/settings)"
                      className="min-h-[42px] flex-1 rounded-xl border border-slate-800 bg-[#11151F] px-3 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={connectingKey || !apiKeyInput.trim()}
                      className="inline-flex min-h-[42px] items-center justify-center rounded-xl border border-indigo-700 bg-indigo-950/60 px-4 text-xs font-semibold text-indigo-100 hover:bg-indigo-900/70 disabled:opacity-50"
                    >
                      {connectingKey ? 'Verifying...' : 'Verify & Connect'}
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Stored only on the backend server. Never returned to browser scripts.
                  </p>
                </form>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Connected Header Strip */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-900/60 bg-emerald-950/20 px-4 py-3 text-xs">
              <div className="space-y-0.5">
                <div className="flex items-center gap-1.5 font-semibold text-emerald-300">
                  <CheckCircle2 className="h-4 w-4" />
                  <span>
                    Zernio Connected · {settings.accounts.length} Account
                    {settings.accounts.length === 1 ? '' : 's'} Found
                  </span>
                </div>
                <div className="font-mono text-[11px] text-slate-400">
                  Key: {settings.apiKeyMasked || 'Authorized'}
                  {settings.lastSyncedAt
                    ? ` · Synced ${new Date(settings.lastSyncedAt).toLocaleTimeString()}`
                    : ''}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={refreshing}
                  onClick={() => void handleRefreshAccounts()}
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-700 bg-[#090B10] px-3 font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                  <span>{refreshing ? 'Syncing...' : 'Refresh Accounts'}</span>
                </button>
                <a
                  href="https://zernio.com/dashboard/connections"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-indigo-800/80 bg-indigo-950/50 px-3 font-medium text-indigo-200 hover:bg-indigo-900/60"
                >
                  <span>Add Accounts in Zernio</span>
                  <ExternalLink className="h-3 w-3" />
                </a>
                <button
                  type="button"
                  disabled={savingSettings}
                  onClick={() => void handleDisconnect()}
                  className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-red-900/70 bg-red-950/40 px-2.5 font-medium text-red-200 hover:bg-red-900/60 disabled:opacity-50"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  <span>Disconnect</span>
                </button>
              </div>
            </div>

            {/* Connected Social Accounts List */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-200">
                  Your Connected Zernio Accounts ({settings.selectedAccountIds.length} selected for
                  upload)
                </span>
                <span className="text-slate-400">
                  Check which accounts receive clips
                </span>
              </div>

              {settings.accounts.length === 0 ? (
                <div className="rounded-xl border border-amber-900/60 bg-amber-950/20 p-4 text-xs text-amber-200 space-y-2">
                  <p>
                    No social accounts are connected in your Zernio workspace yet. Add your
                    TikTok, Instagram, YouTube, or X accounts on Zernio, then click{' '}
                    <strong>Refresh Accounts</strong>.
                  </p>
                  <a
                    href="https://zernio.com/dashboard/connections"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-semibold text-amber-100 underline"
                  >
                    <span>Open Zernio Connections Dashboard</span>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {settings.accounts.map((acc) => {
                    const meta = getPlatformBadgeMeta(acc.platform);
                    return (
                      <label
                        key={acc.id}
                        className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border p-3 transition-colors ${
                          acc.selectedForUpload
                            ? 'border-indigo-600/80 bg-indigo-950/30'
                            : 'border-slate-800 bg-[#090B10] hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <input
                            type="checkbox"
                            checked={acc.selectedForUpload}
                            disabled={savingSettings || !acc.isActive}
                            onChange={() => handleToggleAccount(acc)}
                            className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-indigo-500 focus:ring-indigo-500 shrink-0"
                          />
                          {acc.profilePicture ? (
                            <img
                              src={acc.profilePicture}
                              alt={acc.displayName || acc.username || acc.platform}
                              className="h-8 w-8 rounded-full border border-slate-700 object-cover shrink-0"
                            />
                          ) : (
                            <div className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-700 bg-slate-900 text-xs font-bold text-slate-200 shrink-0 uppercase">
                              {acc.platform.slice(0, 2)}
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span
                                className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${meta.colorClass}`}
                              >
                                {meta.label}
                              </span>
                              {acc.tiktokAccountType && (
                                <span className="font-mono text-[10px] text-slate-400 uppercase">
                                  {acc.tiktokAccountType}
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 truncate text-xs font-semibold text-slate-100">
                              {acc.displayName || acc.username || acc.id}
                            </div>
                            {acc.username && acc.displayName !== acc.username && (
                              <div className="truncate font-mono text-[10px] text-slate-400">
                                @{acc.username.replace(/^@/, '')}
                              </div>
                            )}
                          </div>
                        </div>

                        <span
                          className={`text-[10px] font-semibold shrink-0 ${
                            acc.isActive ? 'text-emerald-400' : 'text-amber-400'
                          }`}
                        >
                          {acc.isActive ? 'Active' : 'Reconnect'}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Auto-Upload & Publish Mode Controls */}
            <div className="rounded-xl border border-slate-800 bg-[#090B10] p-4 space-y-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-100">
                    <UploadCloud className="h-4 w-4 text-indigo-400" />
                    <span>Auto-Upload Rendered Clips to Selected Accounts</span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    Automatically uploads finished clips with Bangla/Banglish/English copy and{' '}
                    <code className="text-orange-300">#BD</code> hashtags.
                  </p>
                </div>

                <button
                  type="button"
                  disabled={savingSettings || settings.selectedAccountIds.length === 0}
                  onClick={() =>
                    void applySettingsPatch({
                      autoUploadEnabled: !settings.autoUploadEnabled,
                    })
                  }
                  className={`min-h-[38px] rounded-xl px-4 text-xs font-semibold transition-colors whitespace-nowrap disabled:opacity-50 ${
                    settings.autoUploadEnabled
                      ? 'border border-emerald-700 bg-emerald-950/50 text-emerald-200 hover:bg-emerald-900/60'
                      : 'border border-slate-700 bg-slate-800 text-slate-100 hover:bg-slate-700'
                  }`}
                >
                  {settings.autoUploadEnabled ? 'Auto-Upload: ON' : 'Auto-Upload: OFF'}
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-slate-800/80 pt-3 text-xs">
                <span className="text-slate-400">Default Delivery Mode:</span>
                <button
                  type="button"
                  disabled={savingSettings}
                  onClick={() => void applySettingsPatch({ uploadMode: 'publish_now' })}
                  className={`min-h-[34px] rounded-lg border px-3 font-medium ${
                    settings.uploadMode === 'publish_now'
                      ? 'border-indigo-600 bg-indigo-950/60 text-indigo-200'
                      : 'border-slate-800 bg-[#11151F] text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Publish Immediately
                </button>
                <button
                  type="button"
                  disabled={savingSettings}
                  onClick={() => void applySettingsPatch({ uploadMode: 'draft' })}
                  className={`min-h-[34px] rounded-lg border px-3 font-medium ${
                    settings.uploadMode === 'draft'
                      ? 'border-indigo-600 bg-indigo-950/60 text-indigo-200'
                      : 'border-slate-800 bg-[#11151F] text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Save as Draft in Zernio
                </button>
              </div>
            </div>

            {/* Dynamic TikTok Features Panel — shown automatically whenever TikTok is connected in Zernio */}
            {settings.hasTikTokAccount ? (
              <div className="rounded-xl border border-cyan-900/60 bg-cyan-950/20 p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-cyan-200">
                    <Sparkles className="h-4 w-4 text-cyan-400" />
                    <span>TikTok Upload &amp; Publishing Features Active</span>
                  </div>
                  <span className="text-[11px] font-medium text-emerald-400">
                    9:16 Vertical + #BD
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-xs">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-300">
                      TikTok Posting Destination
                    </label>
                    <select
                      value={settings.tiktokOptions.draft ? 'draft' : 'direct'}
                      disabled={savingSettings}
                      onChange={(e) =>
                        void applySettingsPatch({
                          tiktokOptions: { draft: e.target.value === 'draft' },
                        })
                      }
                      className="mt-1 min-h-[38px] w-full rounded-lg border border-slate-800 bg-[#090B10] px-2.5 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none"
                    >
                      <option value="direct">Direct Post (Public)</option>
                      <option value="draft">Send to TikTok Drafts (Creator Inbox)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-slate-300">
                      TikTok Cover Frame (ms)
                    </label>
                    <input
                      type="number"
                      min={0}
                      step={500}
                      value={settings.tiktokOptions.videoCoverTimestampMs}
                      onChange={(e) =>
                        void applySettingsPatch({
                          tiktokOptions: {
                            videoCoverTimestampMs: Math.max(0, Number(e.target.value) || 0),
                          },
                        })
                      }
                      className="mt-1 min-h-[38px] w-full rounded-lg border border-slate-800 bg-[#090B10] px-2.5 font-mono text-xs text-slate-100 focus:border-cyan-500 focus:outline-none"
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-4 pt-1 text-xs text-slate-200">
                  <label className="inline-flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={settings.tiktokOptions.allowComment}
                      disabled={savingSettings}
                      onChange={(e) =>
                        void applySettingsPatch({
                          tiktokOptions: { allowComment: e.target.checked },
                        })
                      }
                      className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-cyan-500"
                    />
                    <span>Allow Comments</span>
                  </label>
                  <label className="inline-flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={settings.tiktokOptions.allowDuet}
                      disabled={savingSettings}
                      onChange={(e) =>
                        void applySettingsPatch({
                          tiktokOptions: { allowDuet: e.target.checked },
                        })
                      }
                      className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-cyan-500"
                    />
                    <span>Allow Duet</span>
                  </label>
                  <label className="inline-flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={settings.tiktokOptions.allowStitch}
                      disabled={savingSettings}
                      onChange={(e) =>
                        void applySettingsPatch({
                          tiktokOptions: { allowStitch: e.target.checked },
                        })
                      }
                      className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-cyan-500"
                    />
                    <span>Allow Stitch</span>
                  </label>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-xl border border-slate-800 bg-[#090B10] px-3.5 py-2.5 text-[11px] text-slate-400">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 text-indigo-400 shrink-0" />
                <span>
                  Want TikTok upload &amp; Auto-Upload? Add your TikTok account inside Zernio
                  Dashboard and click <strong>Refresh Accounts</strong> — TikTok publishing and
                  Duet/Stitch/Creator Inbox options appear automatically once detected.
                </span>
              </div>
            )}
          </div>
        )}

        {(error || settings.lastError || notice) && (
          <div
            role={error || settings.lastError ? 'alert' : 'status'}
            className={`rounded-xl border px-4 py-2.5 text-xs ${
              error || settings.lastError
                ? 'border-red-900/60 bg-red-950/40 text-red-200'
                : 'border-emerald-900/60 bg-emerald-950/30 text-emerald-200'
            }`}
          >
            {error || settings.lastError || notice}
          </div>
        )}
      </div>
    </div>
  );
}
