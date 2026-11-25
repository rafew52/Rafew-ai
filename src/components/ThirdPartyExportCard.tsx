import { useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Send,
  Share2,
  Trash2,
  Webhook,
} from 'lucide-react';
import type {
  ClipItem,
  ThirdPartyExportPlatform,
  ThirdPartyExportSettings,
} from '../types.ts';

interface ThirdPartyExportCardProps {
  settings: ThirdPartyExportSettings;
  onUpdated: () => void;
  latestClip?: ClipItem | null;
  compactCollapsible?: boolean;
}

const PLATFORM_OPTIONS: Array<{
  id: ThirdPartyExportPlatform;
  label: string;
  hint: string;
}> = [
  {
    id: 'custom_webhook',
    label: 'Custom Automation Webhook',
    hint: 'HTTPS POST with 9:16 video URL, Bangla/Banglish/English copy & #BD tags',
  },
  {
    id: 'zapier_make',
    label: 'Make.com / Zapier / n8n Webhook',
    hint: 'Trigger multi-platform social posting scenarios automatically',
  },
  {
    id: 'buffer',
    label: 'Buffer (External Tool)',
    hint: 'Open Buffer Composer or connect via Zapier/Make webhook',
  },
  {
    id: 'metricool',
    label: 'Metricool (External Tool)',
    hint: 'Open Metricool Planner or connect via automation webhook',
  },
];

const EXTERNAL_PUBLISHERS = [
  {
    name: 'Open Buffer',
    href: 'https://publish.buffer.com/',
    note: 'Schedule Shorts & Reels',
  },
  {
    name: 'Open Metricool',
    href: 'https://app.metricool.com/',
    note: 'Multi-channel planner',
  },
  {
    name: 'Open Zernio',
    href: 'https://zernio.com/dashboard',
    note: 'Connected social accounts & scheduler',
  },
];

export function ensureBDHashtagList(hashtags: string[]): string[] {
  const cleaned = hashtags
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => (h.startsWith('#') ? h : `#${h}`));
  if (!cleaned.some((h) => h.toLowerCase() === '#bd')) {
    cleaned.unshift('#BD');
  }
  return Array.from(new Set(cleaned));
}

export function ThirdPartyExportCard({
  settings,
  onUpdated,
  latestClip,
  compactCollapsible = false,
}: ThirdPartyExportCardProps) {
  const [expanded, setExpanded] = useState(!compactCollapsible);
  const [webhookUrl, setWebhookUrl] = useState(settings.webhookUrl || '');
  const [webhookLabel, setWebhookLabel] = useState(settings.webhookLabel || '');
  const [preferredPlatform, setPreferredPlatform] = useState<ThirdPartyExportPlatform>(
    settings.preferredPlatform || 'custom_webhook'
  );
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [sendingLatest, setSendingLatest] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setWebhookUrl(settings.webhookUrl || '');
    setWebhookLabel(settings.webhookLabel || '');
    setPreferredPlatform(settings.preferredPlatform || 'custom_webhook');
  }, [settings.webhookUrl, settings.webhookLabel, settings.preferredPlatform]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/third-party-export/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookUrl: webhookUrl.trim(),
          webhookLabel: webhookLabel.trim(),
          preferredPlatform,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to save third-party export settings.');
      }
      setNotice(
        webhookUrl.trim()
          ? 'Saved optional third-party webhook endpoint.'
          : 'Cleared third-party webhook endpoint.'
      );
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save webhook settings.');
    } finally {
      setBusy(false);
    }
  };

  const handleClearWebhook = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/third-party-export/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhookUrl: '', autoSendOnComplete: false }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to clear webhook URL.');
      }
      setWebhookUrl('');
      setNotice('Optional webhook endpoint cleared.');
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to clear webhook.');
    } finally {
      setBusy(false);
    }
  };

  const handleToggleAutoSend = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/third-party-export/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoSendOnComplete: !settings.autoSendOnComplete }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to toggle webhook auto-send.');
      }
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update auto-send setting.');
    } finally {
      setBusy(false);
    }
  };

  const handleTestWebhook = async () => {
    setTesting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/third-party-export/test', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Webhook test failed.');
      }
      setNotice(data.message || 'Webhook test succeeded.');
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Webhook test failed.');
    } finally {
      setTesting(false);
    }
  };

  const handleSendLatestClip = async () => {
    if (!latestClip) return;
    setSendingLatest(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/clips/${latestClip.id}/third-party-export`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to send latest clip to webhook.');
      }
      setNotice(`Sent "${latestClip.title}" + #BD metadata to webhook.`);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to dispatch clip to webhook.');
    } finally {
      setSendingLatest(false);
    }
  };

  const handleCopy = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  };

  const latestHashtags = latestClip
    ? ensureBDHashtagList(latestClip.hashtags || [])
    : ['#BD', '#Shorts', '#Gaming', '#Viral'];
  const latestCaptionText = latestClip
    ? [latestClip.title.trim(), latestClip.description.trim(), latestHashtags.join(' ')]
        .filter(Boolean)
        .join('\n\n')
    : `GTA VI Highlight Clip\n\n${latestHashtags.join(' ')}`;

  const latestDetailsText = latestClip
    ? JSON.stringify(
        {
          clipId: latestClip.id,
          title: latestClip.title,
          description: latestClip.description,
          hashtags: latestHashtags,
          tags: latestClip.tags,
          language: latestClip.languageChoice || 'banglish',
          aspectMode: latestClip.aspectMode || 'portrait',
          durationSeconds: latestClip.durationSeconds,
          videoUrl:
            latestClip.videoUrl && typeof window !== 'undefined'
              ? `${window.location.origin}${latestClip.videoUrl}`
              : latestClip.videoUrl,
        },
        null,
        2
      )
    : '';

  return (
    <section
      id="third-party-export-panel"
      className="rounded-2xl border border-slate-800/90 bg-[#11151F] p-5 sm:p-6 space-y-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Share2 className="h-4 w-4 text-slate-300 shrink-0" />
            <h2 className="text-base font-semibold text-slate-100">
              Third-Party Publish &amp; Export
            </h2>
            <span className="font-mono text-[11px] font-medium text-slate-400">
              (Optional External Fallback)
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            Optional external workflow for Buffer, Metricool, Make/Zapier, or a custom HTTPS
            webhook. YouTube OAuth &amp; Zernio Connected Accounts remain dedicated above.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span
            className={`text-xs font-medium whitespace-nowrap ${
              settings.webhookConfigured ? 'text-cyan-300' : 'text-slate-400'
            }`}
          >
            {settings.webhookConfigured
              ? settings.autoSendOnComplete
                ? 'Webhook Auto-Send ON'
                : 'Webhook Ready'
              : 'Optional · Off'}
          </span>
          {compactCollapsible && (
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl border border-slate-700 bg-[#090B10] px-3 text-xs font-semibold text-slate-200 hover:bg-slate-800 whitespace-nowrap"
            >
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              <span>{expanded ? 'Hide Helper' : 'Open Export Helper'}</span>
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="space-y-4 border-t border-slate-800/80 pt-4">
          {/* Webhook Configuration Form */}
          <form
            onSubmit={(e) => void handleSave(e)}
            className="rounded-xl border border-slate-800 bg-[#090B10] p-4 space-y-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-200">
                <Webhook className="h-3.5 w-3.5 text-cyan-400" />
                <span>Optional Third-Party Webhook / Helper Endpoint (HTTPS)</span>
              </span>
              {settings.webhookConfigured && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleToggleAutoSend()}
                  className={`min-h-[30px] rounded-lg px-2.5 text-[11px] font-semibold transition-colors ${
                    settings.autoSendOnComplete
                      ? 'border border-cyan-700 bg-cyan-950/50 text-cyan-200 hover:bg-cyan-900/60'
                      : 'border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {settings.autoSendOnComplete ? 'Auto-Send 9:16: ON' : 'Auto-Send 9:16: OFF'}
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              <select
                value={preferredPlatform}
                onChange={(e) =>
                  setPreferredPlatform(e.target.value as ThirdPartyExportPlatform)
                }
                aria-label="Preferred external publishing tool"
                className="min-h-[40px] rounded-lg border border-slate-800 bg-[#11151F] px-3 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none"
              >
                {PLATFORM_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>

              <input
                type="url"
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                placeholder="https://hook.us1.make.com/... (optional)"
                className="min-h-[40px] sm:col-span-2 rounded-lg border border-slate-800 bg-[#11151F] px-3 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none"
              />
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <input
                type="text"
                value={webhookLabel}
                onChange={(e) => setWebhookLabel(e.target.value)}
                placeholder="Optional label (e.g. Buffer / Metricool Relay)"
                className="min-h-[38px] flex-1 rounded-lg border border-slate-800 bg-[#11151F] px-3 text-xs text-slate-100 placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none"
              />

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex min-h-[38px] items-center justify-center rounded-lg border border-slate-700 bg-slate-800 px-3.5 text-xs font-semibold text-slate-100 hover:bg-slate-700 disabled:opacity-50"
                >
                  {busy ? 'Saving...' : 'Save Endpoint'}
                </button>
                {settings.webhookConfigured && (
                  <>
                    <button
                      type="button"
                      disabled={testing || busy}
                      onClick={() => void handleTestWebhook()}
                      className="inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg border border-cyan-800/80 bg-cyan-950/40 px-3 text-xs font-semibold text-cyan-200 hover:bg-cyan-900/60 disabled:opacity-50"
                    >
                      <Send className="h-3.5 w-3.5" />
                      <span>{testing ? 'Testing...' : 'Test Webhook'}</span>
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleClearWebhook()}
                      aria-label="Clear webhook URL"
                      className="inline-flex min-h-[38px] min-w-[38px] items-center justify-center rounded-lg border border-slate-800 text-slate-400 hover:border-red-800 hover:text-red-300 disabled:opacity-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
            </div>

            {settings.lastTestStatus && (
              <div className="text-[11px] text-slate-400">
                Last check: <span className="text-slate-200">{settings.lastTestStatus}</span>
                {settings.lastTestedAt
                  ? ` (${new Date(settings.lastTestedAt).toLocaleTimeString()})`
                  : ''}
              </div>
            )}
          </form>

          {/* One-Click Copy + Latest Clip Export & External Platforms */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="rounded-xl border border-slate-800 bg-[#090B10] p-4 space-y-2.5">
              <div className="text-xs font-semibold text-slate-200">
                One-Click Copy ({latestClip ? `Latest Clip: ${latestClip.title.slice(0, 36)}` : 'Ready #BD Copy Pack'})
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleCopy('caption', latestCaptionText)}
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-700 bg-[#11151F] px-3 text-xs font-medium text-slate-200 hover:bg-slate-800"
                >
                  {copiedKey === 'caption' ? (
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  <span>{copiedKey === 'caption' ? 'Copied Caption!' : 'Copy Caption + #BD'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => void handleCopy('hashtags', latestHashtags.join(' '))}
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-700 bg-[#11151F] px-3 text-xs font-medium text-slate-200 hover:bg-slate-800"
                >
                  {copiedKey === 'hashtags' ? (
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  <span>{copiedKey === 'hashtags' ? 'Copied Tags!' : 'Copy Hashtags (#BD)'}</span>
                </button>

                {latestClip && (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleCopy('details', latestDetailsText)}
                      className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-700 bg-[#11151F] px-3 text-xs font-medium text-slate-200 hover:bg-slate-800"
                    >
                      {copiedKey === 'details' ? (
                        <Check className="h-3.5 w-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                      <span>{copiedKey === 'details' ? 'Copied Details!' : 'Copy Clip Details'}</span>
                    </button>

                    {settings.webhookConfigured && (
                      <button
                        type="button"
                        disabled={sendingLatest}
                        onClick={() => void handleSendLatestClip()}
                        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-cyan-800/80 bg-cyan-950/40 px-3 text-xs font-semibold text-cyan-200 hover:bg-cyan-900/60 disabled:opacity-50"
                      >
                        <Send className="h-3.5 w-3.5" />
                        <span>{sendingLatest ? 'Sending...' : 'Send Latest Clip to Webhook'}</span>
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-[#090B10] p-4 space-y-2.5">
              <div className="text-xs font-semibold text-slate-200">
                Open External Publishing Tool (Optional)
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {EXTERNAL_PUBLISHERS.map((tool) => (
                  <a
                    key={tool.name}
                    href={tool.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={tool.note}
                    className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-700 bg-[#11151F] px-3 text-xs font-medium text-slate-200 hover:border-slate-500 hover:text-white"
                  >
                    <span>{tool.name}</span>
                    <ExternalLink className="h-3 w-3 text-slate-400" />
                  </a>
                ))}
              </div>
            </div>
          </div>

          {(error || notice) && (
            <div
              role={error ? 'alert' : 'status'}
              className={`rounded-xl border px-3.5 py-2.5 text-xs ${
                error
                  ? 'border-red-900/60 bg-red-950/40 text-red-200'
                  : 'border-emerald-900/60 bg-emerald-950/30 text-emerald-200'
              }`}
            >
              {error || notice}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
