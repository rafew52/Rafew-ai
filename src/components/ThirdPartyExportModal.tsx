import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Send,
  Share2,
  Webhook,
  X,
} from 'lucide-react';
import type { ClipItem, ThirdPartyExportSettings } from '../types.ts';
import { ensureBDHashtagList } from './ThirdPartyExportCard.tsx';

interface ThirdPartyExportModalProps {
  clip: ClipItem | null;
  settings: ThirdPartyExportSettings;
  onClose: () => void;
  onUpdated: () => void;
}

const EXTERNAL_TOOLS = [
  {
    name: 'Open Zernio',
    href: 'https://zernio.com/dashboard',
    description: 'Manage connected accounts & scheduled posts in Zernio',
  },
  {
    name: 'Open Ayrshare',
    href: 'https://app.ayrshare.com/',
    description: 'Publish 9:16 video via Ayrshare Social API',
  },
  {
    name: 'Open Buffer',
    href: 'https://publish.buffer.com/',
    description: 'Schedule 9:16 Shorts / Reels via Buffer',
  },
  {
    name: 'Open Metricool',
    href: 'https://app.metricool.com/',
    description: 'Publish or schedule in Metricool Planner',
  },
];

export function ThirdPartyExportModal({
  clip,
  settings,
  onClose,
  onUpdated,
}: ThirdPartyExportModalProps) {
  const [webhookInput, setWebhookInput] = useState(settings.webhookUrl || '');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [savingWebhook, setSavingWebhook] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setWebhookInput(settings.webhookUrl || '');
    setError(null);
    setNotice(null);
  }, [clip?.id, settings.webhookUrl]);

  if (!clip) return null;

  const hashtags = ensureBDHashtagList(clip.hashtags || []);
  const fullCaption = [clip.title.trim(), clip.description.trim(), hashtags.join(' ')]
    .filter(Boolean)
    .join('\n\n');

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const clipDetailsJson = JSON.stringify(
    {
      clipId: clip.id,
      title: clip.title,
      description: clip.description,
      hashtags,
      tags: clip.tags,
      languageChoice: clip.languageChoice || 'banglish',
      formatMode: clip.formatMode,
      aspectMode: clip.aspectMode || 'portrait',
      durationSeconds: clip.durationSeconds,
      videoUrl: clip.videoUrl ? `${origin}${clip.videoUrl}` : null,
      thumbnailUrl: clip.thumbnailUrl ? `${origin}${clip.thumbnailUrl}` : null,
      srtUrl: clip.srtUrl ? `${origin}${clip.srtUrl}` : null,
    },
    null,
    2
  );

  const handleCopy = async (key: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  };

  const handleSaveWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingWebhook(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/third-party-export/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhookUrl: webhookInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to save webhook URL.');
      }
      setNotice(
        webhookInput.trim()
          ? 'Saved third-party webhook URL. You can now send this clip directly.'
          : 'Cleared third-party webhook URL.'
      );
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save webhook URL.');
    } finally {
      setSavingWebhook(false);
    }
  };

  const handleSendToWebhook = async () => {
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/clips/${clip.id}/third-party-export`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Webhook delivery failed.');
      }
      setNotice('Clip + #BD metadata delivered to your configured third-party webhook.');
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to send clip to webhook.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="third-party-export-title"
    >
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-800 bg-[#11151F] p-5 sm:p-6 shadow-2xl space-y-5">
        <div className="flex items-start justify-between gap-3 border-b border-slate-800/80 pb-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Share2 className="h-4 w-4 text-cyan-400 shrink-0" />
              <h2
                id="third-party-export-title"
                className="text-base font-semibold text-slate-50"
              >
                Third-Party Publish &amp; Export
              </h2>
              <span className="font-mono text-[11px] font-medium text-slate-400">
                (Optional External Fallback)
              </span>
            </div>
            <p className="mt-1 truncate text-xs text-slate-400" title={clip.title}>
              {clip.title} · {clip.aspectMode === 'landscape' ? '16:9' : '9:16'} ·{' '}
              {clip.durationSeconds}s · {clip.languageChoice || 'banglish'}
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close Third-Party Export modal"
            className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded-xl border border-slate-800 text-slate-400 hover:bg-slate-800 hover:text-slate-100 shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* One-Click Copy Section */}
        <div className="rounded-xl border border-slate-800 bg-[#090B10] p-4 space-y-3">
          <div className="text-xs font-semibold text-slate-200">
            1. One-Click Copy Caption, #BD Hashtags &amp; Clip Details
          </div>
          <div className="rounded-lg border border-slate-800/90 bg-[#11151F] p-3 text-xs leading-relaxed text-slate-300 whitespace-pre-wrap max-h-32 overflow-y-auto">
            {fullCaption}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleCopy('caption', fullCaption)}
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl bg-orange-600 px-3.5 text-xs font-semibold text-white hover:bg-orange-500"
            >
              {copiedKey === 'caption' ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              <span>{copiedKey === 'caption' ? 'Copied Caption!' : 'Copy Caption + #BD'}</span>
            </button>

            <button
              type="button"
              onClick={() => void handleCopy('hashtags', hashtags.join(' '))}
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900 px-3 text-xs font-medium text-slate-200 hover:bg-slate-800"
            >
              {copiedKey === 'hashtags' ? (
                <Check className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              <span>{copiedKey === 'hashtags' ? 'Copied Hashtags!' : 'Copy #BD Hashtags'}</span>
            </button>

            <button
              type="button"
              onClick={() => void handleCopy('details', clipDetailsJson)}
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900 px-3 text-xs font-medium text-slate-200 hover:bg-slate-800"
            >
              {copiedKey === 'details' ? (
                <Check className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              <span>{copiedKey === 'details' ? 'Copied JSON!' : 'Copy Clip Details'}</span>
            </button>

            {clip.videoUrl && (
              <a
                href={`${clip.videoUrl}?download=1`}
                download={`${clip.id}.mp4`}
                className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900 px-3 text-xs font-medium text-slate-200 hover:bg-slate-800"
              >
                <Download className="h-3.5 w-3.5 text-orange-400" />
                <span>Download 9:16 MP4</span>
              </a>
            )}
          </div>
        </div>

        {/* Optional Webhook Endpoint Dispatch */}
        <div className="rounded-xl border border-slate-800 bg-[#090B10] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-200">
              <Webhook className="h-3.5 w-3.5 text-cyan-400" />
              <span>2. Send Clip &amp; Metadata to Optional Automation Webhook</span>
            </span>
            {clip.thirdPartyExportStatus === 'sent' && clip.thirdPartyExportedAt && (
              <span className="text-[11px] font-medium text-emerald-400">
                Sent {new Date(clip.thirdPartyExportedAt).toLocaleTimeString()}
              </span>
            )}
          </div>

          <form onSubmit={(e) => void handleSaveWebhook(e)} className="flex flex-col gap-2 sm:flex-row">
            <input
              type="url"
              value={webhookInput}
              onChange={(e) => setWebhookInput(e.target.value)}
              placeholder="https://hook.us1.make.com/... or custom HTTPS webhook"
              className="min-h-[40px] flex-1 rounded-xl border border-slate-800 bg-[#11151F] px-3 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none"
            />
            <button
              type="submit"
              disabled={savingWebhook}
              className="min-h-[40px] rounded-xl border border-slate-700 bg-slate-800 px-3.5 text-xs font-semibold text-slate-100 hover:bg-slate-700 disabled:opacity-50 shrink-0"
            >
              {savingWebhook ? 'Saving...' : 'Save URL'}
            </button>
          </form>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-slate-400">
              Sends clip URL, caption, #BD hashtags, SEO tags &amp; language choice via HTTPS POST.
            </span>
            <button
              type="button"
              disabled={sending || !settings.webhookConfigured}
              onClick={() => void handleSendToWebhook()}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-cyan-700 px-4 text-xs font-semibold text-white hover:bg-cyan-600 disabled:opacity-50 shrink-0"
            >
              <Send className="h-3.5 w-3.5" />
              <span>{sending ? 'Sending Clip...' : 'Send to Webhook Now'}</span>
            </button>
          </div>
        </div>

        {/* External Third-Party Platforms */}
        <div className="rounded-xl border border-slate-800 bg-[#090B10] p-4 space-y-2.5">
          <div className="text-xs font-semibold text-slate-200">
            3. Open External Third-Party Publisher (Optional Fallback)
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {EXTERNAL_TOOLS.map((tool) => (
              <a
                key={tool.name}
                href={tool.href}
                target="_blank"
                rel="noopener noreferrer"
                className="flex flex-col justify-between rounded-xl border border-slate-800 bg-[#11151F] p-3 text-left transition-colors hover:border-slate-600"
              >
                <div className="flex items-center justify-between gap-1 text-xs font-semibold text-slate-100">
                  <span>{tool.name}</span>
                  <ExternalLink className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                </div>
                <span className="mt-1 text-[11px] text-slate-400">{tool.description}</span>
              </a>
            ))}
          </div>
        </div>

        {(error || clip.thirdPartyExportError || notice) && (
          <div
            role={error || clip.thirdPartyExportError ? 'alert' : 'status'}
            className={`rounded-xl border px-4 py-2.5 text-xs ${
              error || clip.thirdPartyExportError
                ? 'border-red-900/60 bg-red-950/40 text-red-200'
                : 'border-emerald-900/60 bg-emerald-950/30 text-emerald-200'
            }`}
          >
            {error || clip.thirdPartyExportError || notice}
          </div>
        )}
      </div>
    </div>
  );
}
