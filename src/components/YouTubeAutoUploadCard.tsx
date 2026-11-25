import { useState } from 'react';
import {
  CheckCircle2,
  ExternalLink,
  LogOut,
  ShieldAlert,
  UploadCloud,
  AlertTriangle,
} from 'lucide-react';
import type { YouTubeAutoUploadSettings, YouTubePrivacyStatus } from '../types.ts';
import { getYouTubeAccessToken, logoutYouTube, signInYouTube } from '../lib/youtubeAuth.ts';
import firebaseConfig from '../../firebase-applet-config.json';
import { ConfirmModal } from './ConfirmModal.tsx';
import { GoogleSignInButton } from './GoogleSignInButton.tsx';
import { YouTubeOAuthPoolCard } from './YouTubeOAuthPoolCard.tsx';

interface YouTubeAutoUploadCardProps {
  settings: YouTubeAutoUploadSettings;
  onUpdated: () => void;
}

const YOUTUBE_CATEGORIES = [
  { id: '20', label: 'Gaming (20)' },
  { id: '24', label: 'Entertainment (24)' },
  { id: '23', label: 'Comedy (23)' },
  { id: '22', label: 'People & Blogs (22)' },
  { id: '17', label: 'Sports (17)' },
];

export function YouTubeAutoUploadCard({
  settings,
  onUpdated,
}: YouTubeAutoUploadCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showOAuthHelp, setShowOAuthHelp] = useState(!settings.connected);
  const [confirmAction, setConfirmAction] = useState<
    | { type: 'enable_auto' }
    | { type: 'disconnect' }
    | null
  >(null);

  const handleGoogleConnect = async (slotId = 1) => {
    setBusy(true);
    setError(null);
    try {
      const { accessToken } = await signInYouTube();
      const res = await fetch(`/api/youtube/connect?slotId=${slotId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          slotId,
          privacyStatus: settings.privacyStatus,
          categoryId: settings.categoryId,
          madeForKids: settings.madeForKids,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to authorize YouTube channel.');
      }
      setShowOAuthHelp(false);
      onUpdated();
    } catch (err) {
      setShowOAuthHelp(true);
      setError(
        err instanceof Error ? err.message : 'Unable to connect Google / YouTube account.'
      );
    } finally {
      setBusy(false);
    }
  };

  const applySettings = async (patch: {
    autoUploadEnabled?: boolean;
    smartTimingEnabled?: boolean;
    privacyStatus?: YouTubePrivacyStatus;
    categoryId?: string;
    madeForKids?: boolean;
  }) => {
    setBusy(true);
    setError(null);
    try {
      const token = getYouTubeAccessToken();
      const res = await fetch('/api/youtube/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update YouTube auto-upload settings.');
      }
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save YouTube settings.');
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await fetch('/api/youtube/disconnect', { method: 'POST' });
      await logoutYouTube();
      setConfirmAction(null);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect YouTube.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-slate-800/90 bg-[#11151F] p-5 sm:p-6 space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <UploadCloud className="h-5 w-5 text-orange-400" />
            <h2 className="text-lg font-semibold text-slate-50">
              Automatic YouTube Shorts &amp; Long-Form Video Upload (Official API)
            </h2>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            Connect your YouTube channel via Google OAuth to automatically upload Shorts and 2–5+
            minute Long-Form Videos (with custom thumbnails, titles, descriptions, tags, and
            GTA6HUB channel branding).
          </p>
        </div>

        <div className="shrink-0">
          {settings.connected ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              <span>Authorized</span>
            </span>
          ) : settings.tokenExpired ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-400">
              <AlertTriangle className="h-4 w-4" />
              <span>Session Expired</span>
            </span>
          ) : (
            <span className="text-xs font-medium text-slate-400">Not Connected</span>
          )}
        </div>
      </div>

      {/* 3 YouTube API Slots with Automatic Failover Rotation */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            YouTube API Accounts &amp; Failover Slots (3 Slots)
          </div>
          <span className="text-[11px] text-slate-400">
            When Slot 1 reaches daily quota, uploads automatically failover to Slot 2 then Slot 3
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {(settings.slots || [1, 2, 3].map((id) => ({ slotId: id, connected: false, tokenExpired: false, quotaExhausted: false, channel: null }))).map((slot) => (
            <div
              key={slot.slotId}
              className={`flex flex-col justify-between rounded-xl border p-4 transition-colors ${
                slot.connected && !slot.quotaExhausted
                  ? 'border-emerald-800/80 bg-emerald-950/20'
                  : slot.quotaExhausted
                  ? 'border-amber-800/80 bg-amber-950/20'
                  : 'border-slate-800 bg-[#090B10]'
              }`}
            >
              <div>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs font-bold text-slate-200">
                    API Slot #{slot.slotId}
                  </span>
                  {slot.connected && !slot.quotaExhausted ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400">
                      <CheckCircle2 className="h-3 w-3" />
                      <span>Active</span>
                    </span>
                  ) : slot.quotaExhausted ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-400">
                      <AlertTriangle className="h-3 w-3" />
                      <span>Quota Reached</span>
                    </span>
                  ) : (
                    <span className="text-[11px] text-slate-500">Empty</span>
                  )}
                </div>

                {slot.channel ? (
                  <div className="mt-2.5 min-w-0">
                    <div className="truncate text-xs font-semibold text-slate-100">
                      {slot.channel.title}
                    </div>
                    <div className="truncate font-mono text-[11px] text-slate-400">
                      {slot.channel.customUrl || slot.channel.id}
                    </div>
                  </div>
                ) : (
                  <p className="mt-2 text-[11px] text-slate-400">
                    Connect a YouTube channel for failover slot #{slot.slotId}.
                  </p>
                )}
              </div>

              <div className="mt-4 pt-3 border-t border-slate-800/80 flex flex-col gap-2">
                {slot.connected ? (
                  <>
                    <GoogleSignInButton
                      compact
                      label={`Reconnect / Re-Authorize Full Scopes`}
                      loading={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await fetch('/api/youtube/disconnect', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ slotId: slot.slotId }),
                          });
                        } catch {}
                        await handleGoogleConnect(slot.slotId);
                      }}
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await fetch('/api/youtube/disconnect', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ slotId: slot.slotId }),
                          });
                          onUpdated();
                        } finally {
                          setBusy(false);
                        }
                      }}
                      className="inline-flex min-h-[32px] w-full items-center justify-center gap-1 rounded-lg border border-slate-700 px-2.5 text-xs font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                    >
                      <LogOut className="h-3 w-3" />
                      <span>Disconnect</span>
                    </button>
                  </>
                ) : (
                  <GoogleSignInButton
                    compact
                    label={`Connect Slot #${slot.slotId}`}
                    loading={busy}
                    onClick={() => void handleGoogleConnect(slot.slotId)}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Multi-Project Google Cloud OAuth2 Pool & Quota Rotation Manager */}
      <YouTubeOAuthPoolCard pool={settings.oauthPool} onUpdated={onUpdated} />

      {/* Auto-Upload Mode & Metadata Defaults */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="yt-privacy-select" className="block text-xs font-medium text-slate-300">
            Default Privacy Status
          </label>
          <select
            id="yt-privacy-select"
            value={settings.privacyStatus}
            disabled={busy}
            onChange={(e) =>
              void applySettings({ privacyStatus: e.target.value as YouTubePrivacyStatus })
            }
            className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-800 bg-[#090B10] px-3 py-2 text-sm text-slate-100 focus:border-orange-500 focus:outline-none disabled:opacity-60"
          >
            <option value="public">Public (Publish live — Default)</option>
            <option value="unlisted">Unlisted (Shareable link)</option>
            <option value="private">Private (Review first)</option>
          </select>
        </div>

        <div>
          <label htmlFor="yt-category-select" className="block text-xs font-medium text-slate-300">
            YouTube Category
          </label>
          <select
            id="yt-category-select"
            value={settings.categoryId}
            disabled={busy}
            onChange={(e) => void applySettings({ categoryId: e.target.value })}
            className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-800 bg-[#090B10] px-3 py-2 text-sm text-slate-100 focus:border-orange-500 focus:outline-none disabled:opacity-60"
          >
            {YOUTUBE_CATEGORIES.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="yt-kids-select" className="block text-xs font-medium text-slate-300">
            Audience Declaration
          </label>
          <select
            id="yt-kids-select"
            value={settings.madeForKids ? 'yes' : 'no'}
            disabled={busy}
            onChange={(e) => void applySettings({ madeForKids: e.target.value === 'yes' })}
            className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-800 bg-[#090B10] px-3 py-2 text-sm text-slate-100 focus:border-orange-500 focus:outline-none disabled:opacity-60"
          >
            <option value="no">Not made for kids</option>
            <option value="yes">Made for kids</option>
          </select>
        </div>
      </div>

      {/* Hands-Free Auto Upload Activation Row */}
      <div className="flex flex-col gap-3 rounded-xl border border-slate-800/80 bg-[#090B10] p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-100">
            Hands-Free Auto-Upload Pipeline:{' '}
            <span className={settings.autoUploadEnabled ? 'text-emerald-400' : 'text-slate-400'}>
              {settings.autoUploadEnabled ? 'ENABLED' : 'OFF (Manual Control)'}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-slate-400">
            When enabled, every finished Short or Long-Form Video automatically uploads to{' '}
            {settings.channel ? settings.channel.title : 'your channel'} with AI metadata and
            custom thumbnail.
          </p>
        </div>

        <button
          type="button"
          disabled={busy || (!settings.connected && !settings.autoUploadEnabled)}
          onClick={() => {
            if (settings.autoUploadEnabled) {
              void applySettings({ autoUploadEnabled: false });
            } else {
              setConfirmAction({ type: 'enable_auto' });
            }
          }}
          className={`min-h-[44px] rounded-xl px-4 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 ${
            settings.autoUploadEnabled
              ? 'border border-red-900/70 bg-red-950/40 text-red-200 hover:bg-red-900/60'
              : 'bg-orange-600 text-white hover:bg-orange-500'
          }`}
        >
          {settings.autoUploadEnabled ? 'Disable Auto-Upload' : 'Enable Auto-Upload'}
        </button>
      </div>

      {/* AI YouTube Search & Trend Timing Scheduler Toggle Row */}
      <div className="flex flex-col gap-3 rounded-xl border border-slate-800/80 bg-[#090B10] p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-100">
            AI YouTube Search &amp; Trend Timing Scheduler:{' '}
            <span className={settings.smartTimingEnabled ? 'text-emerald-400' : 'text-slate-400'}>
              {settings.smartTimingEnabled ? 'ENABLED' : 'OFF (Immediate Upload)'}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-slate-400">
            Before publishing, queries real YouTube Data API search results (
            <code className="font-mono text-slate-300">youtube.search.list</code> +{' '}
            <code className="font-mono text-slate-300">videos.list</code>) to analyze live niche
            view velocity and active Bangladesh/global audience windows, spacing uploads by at least
            40 minutes or publishing now when momentum is peaking.
          </p>
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={() => void applySettings({ smartTimingEnabled: !settings.smartTimingEnabled })}
          className={`min-h-[44px] rounded-xl px-4 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 ${
            settings.smartTimingEnabled
              ? 'border border-emerald-800/70 bg-emerald-950/40 text-emerald-200 hover:bg-emerald-900/50'
              : 'border border-slate-700 bg-slate-800 text-slate-100 hover:bg-slate-700'
          }`}
        >
          {settings.smartTimingEnabled ? 'Smart Timing: ON' : 'Enable Smart Timing'}
        </button>
      </div>

      {/* API Quota & Direct YouTube Studio Upload Mode Row */}
      <div className="flex flex-col gap-3 rounded-xl border border-amber-900/60 bg-amber-950/20 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
            <span>YouTube API Quota Exceeded or Limit Reached?</span>
          </div>
          <p className="mt-1 text-xs text-slate-300">
            Google Cloud daily API quotas (10,000 units/day) can be exhausted by bulk uploads.
            Enable <strong className="text-slate-100">Direct YouTube Studio Upload Mode</strong> to
            instantly download MP4 Shorts and copy AI metadata with 1 click to publish directly
            via YouTube Studio without API limits.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <a
            href="https://studio.youtube.com/channel/u/0/upload?d=1"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-orange-800/80 bg-orange-950/50 px-3.5 text-xs font-semibold text-orange-200 hover:bg-orange-900/60"
          >
            <span>Open YouTube Studio</span>
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200 space-y-2"
        >
          <div className="font-semibold text-red-100">Upload Action Notice:</div>
          <div>{error}</div>
          {error.toLowerCase().includes('quota') && (
            <div className="pt-1">
              <a
                href="https://studio.youtube.com/channel/u/0/upload?d=1"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-semibold text-orange-300 underline hover:text-orange-200"
              >
                <span>Click here to upload directly in YouTube Studio</span>
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          )}
        </div>
      )}

      {/* Google Cloud Permission & Test-User Checklist */}
      <div className="rounded-xl border border-slate-800/90 bg-[#090B10] p-4">
        <button
          type="button"
          onClick={() => setShowOAuthHelp((prev) => !prev)}
          className="flex w-full items-center justify-between gap-2 text-left text-xs font-semibold text-slate-200"
        >
          <span className="inline-flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-amber-400 shrink-0" />
            <span>
              Google Cloud OAuth Permissions Checklist (Fixes &ldquo;Error 403: access_denied&rdquo;)
            </span>
          </span>
          <span className="text-slate-400">{showOAuthHelp ? 'Hide' : 'Show'}</span>
        </button>

        {showOAuthHelp && (
          <div className="mt-3 space-y-3 border-t border-slate-800/80 pt-3 text-xs leading-relaxed text-slate-300">
            <p className="text-slate-400">
              Your AI Studio provisioned project is{' '}
              <code className="font-mono text-slate-200">{firebaseConfig.projectId}</code>.
              Because YouTube upload permissions are sensitive, Google Cloud keeps new OAuth
              projects in <strong className="text-slate-200">Testing</strong> mode until you
              approve your YouTube Gmail address inside project{' '}
              <code className="font-mono text-slate-200">{firebaseConfig.projectId}</code>:
            </p>
            <ol className="list-decimal space-y-2 pl-4">
              <li>
                Open{' '}
                <a
                  href={`https://console.cloud.google.com/auth/audience?project=${firebaseConfig.projectId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-semibold text-orange-400 underline hover:text-orange-300"
                >
                  <span>Google Cloud OAuth Audience / Test users</span>
                  <ExternalLink className="h-3 w-3" />
                </a>{' '}
                using your project owner account, scroll to <strong>Test users</strong>, and add
                the exact Gmail of your YouTube channel (e.g. your channel email).
              </li>
              <li>
                Ensure{' '}
                <a
                  href={`https://console.cloud.google.com/apis/library/youtube.googleapis.com?project=${firebaseConfig.projectId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-semibold text-orange-400 underline hover:text-orange-300"
                >
                  <span>YouTube Data API v3</span>
                  <ExternalLink className="h-3 w-3" />
                </a>{' '}
                is <strong>Enabled</strong> on project{' '}
                <code className="font-mono text-slate-200">{firebaseConfig.projectId}</code>.
              </li>
              <li>
                Verify preview host domains are listed in{' '}
                <a
                  href={`https://console.firebase.google.com/project/${firebaseConfig.projectId}/authentication/settings`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-semibold text-orange-400 underline hover:text-orange-300"
                >
                  <span>Firebase Auth Authorized Domains</span>
                  <ExternalLink className="h-3 w-3" />
                </a>{' '}
                (<code className="font-mono text-slate-300">{typeof window !== 'undefined' ? window.location.hostname : 'ais-dev-*.run.app'}</code>).
              </li>
            </ol>
          </div>
        )}
      </div>

      <ConfirmModal
        open={Boolean(confirmAction)}
        title={
          confirmAction?.type === 'disconnect'
            ? 'Disconnect YouTube account?'
            : 'Enable automatic YouTube Shorts upload?'
        }
        description={
          confirmAction?.type === 'disconnect'
            ? 'This revokes the active in-memory YouTube authorization token and disables automatic uploads.'
            : `Every newly completed 15+ second Short will automatically upload to "${
                settings.channel?.title || 'your YouTube channel'
              }" as "${settings.privacyStatus}" with its AI-generated title, description, hashtags, and SEO tags.`
        }
        confirmLabel={
          confirmAction?.type === 'disconnect'
            ? 'Disconnect YouTube'
            : 'Confirm & Enable Auto-Upload'
        }
        destructive={confirmAction?.type === 'disconnect'}
        busy={busy}
        onConfirm={() => {
          if (confirmAction?.type === 'disconnect') {
            void handleDisconnect();
          } else {
            void applySettings({ autoUploadEnabled: true }).then(() =>
              setConfirmAction(null)
            );
          }
        }}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}
