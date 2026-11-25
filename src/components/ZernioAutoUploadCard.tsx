import { useState } from 'react';
import {
  CheckCircle2,
  ExternalLink,
  Layers,
  LogOut,
  RefreshCw,
  Sparkles,
  UploadCloud,
} from 'lucide-react';
import type {
  ZernioAccount,
  ZernioConnectionSettings,
  ZernioTikTokOptions,
  ZernioUploadMode,
} from '../types.ts';
import { ZernioButton } from './ZernioButton.tsx';
import { getPlatformBadgeMeta } from './ZernioConnectModal.tsx';

interface ZernioAutoUploadCardProps {
  settings: ZernioConnectionSettings;
  onUpdated: () => void;
  onOpenConnectModal: () => void;
}

export function ZernioAutoUploadCard({
  settings,
  onUpdated,
  onOpenConnectModal,
}: ZernioAutoUploadCardProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const handleRefresh = async () => {
    setRefreshing(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/zernio/accounts/refresh', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to sync accounts from Zernio.');
      }
      setNotice(`Synced ${data.zernio?.accounts?.length ?? 0} account(s) from Zernio.`);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sync Zernio accounts.');
    } finally {
      setRefreshing(false);
    }
  };

  const applyPatch = async (patch: {
    autoUploadEnabled?: boolean;
    uploadMode?: ZernioUploadMode;
    selectedAccountIds?: string[];
    tiktokOptions?: Partial<ZernioTikTokOptions>;
  }) => {
    setSaving(true);
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
      setError(err instanceof Error ? err.message : 'Unable to update Zernio settings.');
    } finally {
      setSaving(false);
    }
  };

  const toggleAccount = (acc: ZernioAccount) => {
    const set = new Set(settings.selectedAccountIds);
    if (set.has(acc.id)) set.delete(acc.id);
    else set.add(acc.id);
    void applyPatch({ selectedAccountIds: Array.from(set) });
  };

  const handleDisconnect = async () => {
    setSaving(true);
    setError(null);
    try {
      await fetch('/api/zernio/disconnect', { method: 'POST' });
      setNotice('Disconnected Zernio workspace.');
      onUpdated();
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-800/90 bg-[#11151F] p-5 sm:p-6 space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Layers className="h-5 w-5 text-indigo-400" />
            <h2 className="text-lg font-semibold text-slate-50">
              Zernio Connected Accounts &amp; Multi-Platform Auto-Upload
            </h2>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            Connect Zernio once to sync all your linked social channels (TikTok, Instagram,
            YouTube, Facebook, X, Threads, LinkedIn) and auto-upload clips with dynamic captions
            and mandatory <code className="text-orange-300">#BD</code> hashtags.
          </p>
        </div>

        <ZernioButton
          zernio={settings}
          label="Sign in with Zernio"
          onClick={onOpenConnectModal}
        />
      </div>

      {!settings.connected ? (
        <div className="rounded-xl border border-slate-800 bg-[#090B10] p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between text-xs text-slate-300">
          <div>
            Click <strong>Sign in with Zernio</strong> to authorize your workspace and show all
            accounts connected in your Zernio account—including automatic TikTok 9:16 upload when
            TikTok is connected.
          </div>
          <button
            type="button"
            onClick={onOpenConnectModal}
            className="min-h-[38px] rounded-xl bg-indigo-600 px-4 text-xs font-semibold text-white hover:bg-indigo-500 shrink-0"
          >
            Open Zernio Sign-In
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Sync Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-[#090B10] px-4 py-3 text-xs">
            <div className="flex items-center gap-2 text-emerald-300 font-semibold">
              <CheckCircle2 className="h-4 w-4" />
              <span>
                {settings.accounts.length} Connected Account
                {settings.accounts.length === 1 ? '' : 's'}
                {settings.hasTikTokAccount ? ' · TikTok Upload Active' : ''}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={refreshing}
                onClick={() => void handleRefresh()}
                className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border border-slate-700 bg-[#11151F] px-3 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                <span>{refreshing ? 'Refreshing...' : 'Refresh Accounts'}</span>
              </button>
              <a
                href="https://zernio.com/dashboard/connections"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-indigo-800/70 bg-indigo-950/40 px-3 text-xs font-medium text-indigo-200 hover:bg-indigo-900/50"
              >
                <span>Manage on Zernio</span>
                <ExternalLink className="h-3 w-3" />
              </a>
              <button
                type="button"
                disabled={saving}
                onClick={() => void handleDisconnect()}
                className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-red-900/70 bg-red-950/30 px-2.5 text-xs font-medium text-red-200 hover:bg-red-900/50 disabled:opacity-50"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span>Disconnect</span>
              </button>
            </div>
          </div>

          {/* Connected Accounts Grid */}
          {settings.accounts.length > 0 && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {settings.accounts.map((acc) => {
                const meta = getPlatformBadgeMeta(acc.platform);
                return (
                  <label
                    key={acc.id}
                    className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border p-3 ${
                      acc.selectedForUpload
                        ? 'border-indigo-600/80 bg-indigo-950/25'
                        : 'border-slate-800 bg-[#090B10] hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <input
                        type="checkbox"
                        checked={acc.selectedForUpload}
                        disabled={saving || !acc.isActive}
                        onChange={() => toggleAccount(acc)}
                        className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-indigo-500 shrink-0"
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
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
                      </div>
                    </div>

                    <span
                      className={`text-[10px] font-semibold shrink-0 ${
                        acc.isActive ? 'text-emerald-400' : 'text-amber-400'
                      }`}
                    >
                      {acc.isActive ? 'Ready' : 'Reconnect'}
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          {/* Auto-Upload Controls */}
          <div className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-[#090B10] p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-0.5">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-100">
                <UploadCloud className="h-4 w-4 text-indigo-400" />
                <span>Automatic Multi-Platform Upload</span>
              </div>
              <p className="text-[11px] text-slate-400">
                Auto-uploads rendered clips to your {settings.selectedAccountIds.length} selected
                Zernio account{settings.selectedAccountIds.length === 1 ? '' : 's'} ({settings.uploadMode === 'draft' ? 'Draft' : 'Publish Now'}).
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <select
                value={settings.uploadMode}
                disabled={saving}
                onChange={(e) =>
                  void applyPatch({ uploadMode: e.target.value as ZernioUploadMode })
                }
                aria-label="Zernio default upload mode"
                className="min-h-[38px] rounded-xl border border-slate-700 bg-[#11151F] px-3 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                <option value="publish_now">Publish Now</option>
                <option value="draft">Save as Draft</option>
              </select>

              <button
                type="button"
                disabled={saving || settings.selectedAccountIds.length === 0}
                onClick={() =>
                  void applyPatch({ autoUploadEnabled: !settings.autoUploadEnabled })
                }
                className={`min-h-[38px] rounded-xl px-4 text-xs font-semibold transition-colors disabled:opacity-50 ${
                  settings.autoUploadEnabled
                    ? 'border border-emerald-700 bg-emerald-950/50 text-emerald-200 hover:bg-emerald-900/60'
                    : 'border border-slate-700 bg-slate-800 text-slate-100 hover:bg-slate-700'
                }`}
              >
                {settings.autoUploadEnabled ? 'Auto-Upload: ON' : 'Enable Auto-Upload'}
              </button>
            </div>
          </div>

          {/* TikTok Specific Features when TikTok account exists */}
          {settings.hasTikTokAccount && (
            <div className="rounded-xl border border-cyan-900/60 bg-cyan-950/20 p-4 space-y-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 font-semibold text-cyan-200">
                  <Sparkles className="h-4 w-4 text-cyan-400" />
                  <span>TikTok Features (Active via Zernio Connected TikTok)</span>
                </span>
                <button
                  type="button"
                  onClick={onOpenConnectModal}
                  className="text-[11px] font-medium text-cyan-300 hover:underline"
                >
                  All Zernio Options
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-4">
                <select
                  value={settings.tiktokOptions.draft ? 'draft' : 'direct'}
                  disabled={saving}
                  onChange={(e) =>
                    void applyPatch({
                      tiktokOptions: { draft: e.target.value === 'draft' },
                    })
                  }
                  aria-label="TikTok posting mode"
                  className="min-h-[36px] rounded-lg border border-slate-800 bg-[#090B10] px-2.5 text-xs text-slate-100"
                >
                  <option value="direct">Direct Post (Public)</option>
                  <option value="draft">TikTok Creator Inbox (Draft)</option>
                </select>

                <label className="inline-flex cursor-pointer items-center gap-1.5 text-slate-200">
                  <input
                    type="checkbox"
                    checked={settings.tiktokOptions.allowComment}
                    disabled={saving}
                    onChange={(e) =>
                      void applyPatch({
                        tiktokOptions: { allowComment: e.target.checked },
                      })
                    }
                    className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-cyan-500"
                  />
                  <span>Comments</span>
                </label>

                <label className="inline-flex cursor-pointer items-center gap-1.5 text-slate-200">
                  <input
                    type="checkbox"
                    checked={settings.tiktokOptions.allowDuet}
                    disabled={saving}
                    onChange={(e) =>
                      void applyPatch({
                        tiktokOptions: { allowDuet: e.target.checked },
                      })
                    }
                    className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-cyan-500"
                  />
                  <span>Duet</span>
                </label>

                <label className="inline-flex cursor-pointer items-center gap-1.5 text-slate-200">
                  <input
                    type="checkbox"
                    checked={settings.tiktokOptions.allowStitch}
                    disabled={saving}
                    onChange={(e) =>
                      void applyPatch({
                        tiktokOptions: { allowStitch: e.target.checked },
                      })
                    }
                    className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-cyan-500"
                  />
                  <span>Stitch</span>
                </label>
              </div>
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
    </section>
  );
}
