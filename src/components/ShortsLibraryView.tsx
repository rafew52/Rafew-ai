import { useMemo, useState } from 'react';
import {
  Check,
  Clock,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Pencil,
  RotateCcw,
  Search,
  Share2,
  Sparkles,
  Trash2,
  TrendingUp,
  UploadCloud,
  Video,
} from 'lucide-react';
import { getYouTubeAccessToken, signInYouTube } from '../lib/youtubeAuth.ts';
import type {
  ClipItem,
  ClipJobStatus,
  ContentLanguageChoice,
  MomentCategory,
  ThirdPartyExportSettings,
  YouTubeAutoUploadSettings,
  ZernioConnectionSettings,
} from '../types.ts';
import { ConfirmModal } from './ConfirmModal.tsx';
import { ThirdPartyExportModal } from './ThirdPartyExportModal.tsx';
import { ZernioButton } from './ZernioButton.tsx';
import { getPlatformBadgeMeta } from './ZernioConnectModal.tsx';

interface ShortsLibraryViewProps {
  clips: ClipItem[];
  youtubeSettings: YouTubeAutoUploadSettings;
  zernioSettings?: ZernioConnectionSettings;
  thirdPartyExportSettings?: ThirdPartyExportSettings;
  onRefresh: () => void;
  onGoToMonitor: () => void;
  onOpenZernioConnect?: () => void;
}

const FALLBACK_THIRD_PARTY: ThirdPartyExportSettings = {
  webhookUrl: '',
  webhookConfigured: false,
  preferredPlatform: 'custom_webhook',
  autoSendOnComplete: false,
};

type ClipFilter = 'all' | ClipJobStatus;

const CATEGORY_LABELS: Record<MomentCategory, string> = {
  funny: 'Funny Moment',
  epic_gameplay: 'Epic Gameplay',
  highlight: 'Highlight',
  reaction: 'Reaction',
  viral: 'Viral Moment',
};

const LANGUAGE_LABELS: Record<ContentLanguageChoice, string> = {
  bengali: 'বাংলা Script',
  banglish: 'Banglish',
  english: 'English',
};

function getClipStatusDisplay(status: ClipJobStatus): {
  label: string;
  colorClass: string;
} {
  switch (status) {
    case 'completed':
      return { label: 'Completed', colorClass: 'text-emerald-400' };
    case 'processing':
      return { label: 'Processing 9:16 + Captions', colorClass: 'text-orange-400' };
    case 'queued':
      return { label: 'Queued', colorClass: 'text-amber-300' };
    case 'failed':
      return { label: 'Failed', colorClass: 'text-red-400' };
  }
}

export function ShortsLibraryView({
  clips,
  youtubeSettings,
  zernioSettings,
  thirdPartyExportSettings,
  onRefresh,
  onGoToMonitor,
  onOpenZernioConnect,
}: ShortsLibraryViewProps) {
  const [filter, setFilter] = useState<ClipFilter>('all');
  const [search, setSearch] = useState('');
  const [editingClipId, setEditingClipId] = useState<string | null>(null);
  const [editMomentSummary, setEditMomentSummary] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editHashtags, setEditHashtags] = useState('');
  const [editTags, setEditTags] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [openCaptions, setOpenCaptions] = useState<Record<string, boolean>>({});
  const [confirmDelete, setConfirmDelete] = useState<ClipItem | null>(null);
  const [confirmUploadClip, setConfirmUploadClip] = useState<ClipItem | null>(null);
  const [confirmZernioClip, setConfirmZernioClip] = useState<ClipItem | null>(null);
  const [exportModalClipId, setExportModalClipId] = useState<string | null>(null);
  const [uploadingYtId, setUploadingYtId] = useState<string | null>(null);
  const [publishingZernioId, setPublishingZernioId] = useState<string | null>(null);
  const [regeneratingThumbId, setRegeneratingThumbId] = useState<string | null>(null);
  const [previewModeByClip, setPreviewModeByClip] = useState<Record<string, 'video' | 'thumbnail'>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [downloadPercent, setDownloadPercent] = useState<number | null>(null);

  const filteredClips = useMemo(() => {
    const q = search.trim().toLowerCase();
    return clips.filter((c) => {
      if (filter !== 'all' && c.status !== filter) return false;
      if (q) {
        return (
          c.title.toLowerCase().includes(q) ||
          c.streamLabel.toLowerCase().includes(q) ||
          c.hashtags.some((h) => h.toLowerCase().includes(q)) ||
          c.tags.some((t) => t.toLowerCase().includes(q))
        );
      }
      return true;
    });
  }, [clips, filter, search]);

  const copyText = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  };

  const handleCopyAllForYouTube = async (clip: ClipItem) => {
    const clipNo = clip.clipNumber ?? 1;
    const summary = clip.momentSummary || clip.viralReason || clip.title;
    const formatted = [
      `Clip #: ${clipNo}`,
      `Moment Summary: ${summary}`,
      `Title: ${clip.title}`,
      `Caption: ${clip.description}`,
      `Hashtags: ${clip.hashtags.join(' ')}`,
      clip.tags.length > 0 ? `Tags: ${clip.tags.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    await copyText(`all_${clip.id}`, formatted);
  };

  const startEdit = (clip: ClipItem) => {
    setEditingClipId(clip.id);
    setEditMomentSummary(clip.momentSummary || clip.viralReason || '');
    setEditTitle(clip.title);
    setEditDesc(clip.description);
    setEditHashtags(clip.hashtags.join(' '));
    setEditTags(clip.tags.join(', '));
    setActionError(null);
  };

  const handleSaveEdit = async (clipId: string) => {
    setSavingId(clipId);
    setActionError(null);
    try {
      const hashtags = editHashtags
        .split(/[\s,]+/)
        .map((h) => h.trim())
        .filter(Boolean)
        .map((h) => (h.startsWith('#') ? h : `#${h}`));
      const tags = editTags
        .split(',')
        .map((t) => t.trim().replace(/^#/, ''))
        .filter(Boolean);

      const res = await fetch(`/api/clips/${clipId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          momentSummary: editMomentSummary,
          title: editTitle.slice(0, 80),
          description: editDesc,
          hashtags,
          tags,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to update clip metadata.');
      }
      setEditingClipId(null);
      onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to save metadata.');
    } finally {
      setSavingId(null);
    }
  };

  const handleRetry = async (clipId: string) => {
    setRetryingId(clipId);
    setActionError(null);
    try {
      const res = await fetch(`/api/clips/${clipId}/retry`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to requeue clip.');
      }
      onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Retry failed.');
    } finally {
      setRetryingId(null);
    }
  };

  const handleRegenerateThumbnail = async (clipId: string) => {
    setRegeneratingThumbId(clipId);
    setActionError(null);
    try {
      const res = await fetch(`/api/clips/${clipId}/regenerate-thumbnail`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to regenerate thumbnail.');
      }
      setPreviewModeByClip((prev) => ({ ...prev, [clipId]: 'thumbnail' }));
      onRefresh();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Unable to regenerate thumbnail.'
      );
    } finally {
      setRegeneratingThumbId(null);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    setSavingId(confirmDelete.id);
    try {
      await fetch(`/api/clips/${confirmDelete.id}`, { method: 'DELETE' });
      setConfirmDelete(null);
      onRefresh();
    } finally {
      setSavingId(null);
    }
  };

  const handleDownloadFile = async (
    baseUrl: string,
    filename: string,
    expectedMime: string,
    trackingKey: string
  ) => {
    setDownloadingKey(trackingKey);
    setDownloadPercent(null);
    setActionError(null);

    try {
      const requestUrl = `${baseUrl}?download=1&name=${encodeURIComponent(filename)}`;
      const res = await fetch(requestUrl, {
        credentials: 'include',
        cache: 'no-store',
      });

      if (!res.ok) {
        const errContentType = (res.headers.get('content-type') || '').toLowerCase();
        if (errContentType.includes('application/json')) {
          const errData = (await res.json()) as { error?: string };
          throw new Error(errData.error || `Download failed (${res.status}).`);
        }
        throw new Error(`Download failed (${res.status}).`);
      }

      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('text/html')) {
        throw new Error(
          'Download returned an HTML page instead of the media file. Please refresh the app and try again.'
        );
      }

      let blob: Blob;
      const totalBytes = Number(res.headers.get('content-length') || '0');

      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const chunks: BlobPart[] = [];
        let receivedBytes = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            receivedBytes += value.byteLength;
            if (totalBytes > 0) {
              setDownloadPercent(
                Math.min(100, Math.round((receivedBytes / totalBytes) * 100))
              );
            }
          }
        }

        if (receivedBytes === 0) {
          throw new Error('Downloaded file was empty (0 bytes).');
        }
        blob = new Blob(chunks, { type: expectedMime });
      } else {
        const rawBlob = await res.blob();
        if (rawBlob.size === 0) {
          throw new Error('Downloaded file was empty (0 bytes).');
        }
        blob = new Blob([rawBlob], { type: expectedMime });
      }

      const blobUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = filename;
      anchor.rel = 'noopener noreferrer';
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      setTimeout(() => {
        URL.revokeObjectURL(blobUrl);
      }, 60_000);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to download file.');
    } finally {
      setDownloadingKey(null);
      setDownloadPercent(null);
    }
  };

  const handleConfirmYouTubeUpload = async () => {
    if (!confirmUploadClip) return;
    const targetClip = confirmUploadClip;
    setUploadingYtId(targetClip.id);
    setActionError(null);
    try {
      let token = getYouTubeAccessToken();
      if (!token && !youtubeSettings.connected) {
        const authResult = await signInYouTube();
        token = authResult.accessToken;
      }

      const res = await fetch(`/api/clips/${targetClip.id}/youtube-upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to upload clip to YouTube.');
      }
      setConfirmUploadClip(null);
      onRefresh();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Unable to start YouTube upload.'
      );
      setConfirmUploadClip(null);
    } finally {
      setUploadingYtId(null);
    }
  };

  const handleConfirmZernioPublish = async () => {
    if (!confirmZernioClip) return;
    const targetClip = confirmZernioClip;
    setPublishingZernioId(targetClip.id);
    setActionError(null);
    try {
      const eligibleIds = (zernioSettings?.accounts || [])
        .filter(
          (a) =>
            a.isActive &&
            a.selectedForUpload &&
            (targetClip.aspectMode !== 'landscape' || a.platform.toLowerCase() !== 'tiktok')
        )
        .map((a) => a.id);

      const res = await fetch(`/api/clips/${targetClip.id}/zernio-publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(eligibleIds.length > 0 ? { accountIds: eligibleIds } : {}),
          uploadMode: zernioSettings?.uploadMode || 'publish_now',
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to queue clip for Zernio upload.');
      }
      setConfirmZernioClip(null);
      onRefresh();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Unable to start Zernio upload.'
      );
      setConfirmZernioClip(null);
    } finally {
      setPublishingZernioId(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Filter & Search Bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-1 overflow-x-auto rounded-xl border border-slate-800 bg-[#11151F] p-1">
          {(
            [
              { id: 'all', label: 'All Clips' },
              { id: 'completed', label: 'Completed' },
              { id: 'processing', label: 'Processing' },
              { id: 'queued', label: 'Queued' },
              { id: 'failed', label: 'Failed' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilter(tab.id)}
              className={`min-h-[38px] rounded-lg px-3 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                filter === tab.id
                  ? 'bg-slate-800 text-slate-50'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, tag, or stream..."
            className="min-h-[44px] w-full rounded-xl border border-slate-800 bg-[#11151F] py-2 pl-9 pr-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
          />
        </div>
      </div>

      {actionError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200"
        >
          <span>{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="rounded-lg border border-red-800 bg-red-900/40 px-3 py-1 text-xs font-semibold text-red-100 hover:bg-red-900/70"
          >
            Dismiss
          </button>
        </div>
      )}

      {filteredClips.length === 0 ? (
        <div className="rounded-2xl border border-slate-800 bg-[#11151F] px-6 py-14 text-center">
          <h3 className="text-lg font-semibold text-slate-100">
            {clips.length === 0
              ? 'No Shorts clipped yet'
              : 'No clips match this filter'}
          </h3>
          <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-slate-400">
            {clips.length === 0
              ? 'Start monitoring an authorized stream or upload a recording. Detected funny moments, epic gameplay, and highlights will appear here with 9:16 previews, captions, metadata, and MP4 downloads.'
              : 'Switch the status filter or clear your search query.'}
          </p>
          {clips.length === 0 && (
            <button
              type="button"
              onClick={onGoToMonitor}
              className="mt-6 min-h-[44px] rounded-xl bg-orange-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-orange-500 whitespace-nowrap"
            >
              Go to Stream Monitor
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
          {filteredClips.map((clip) => {
            const statusMeta = getClipStatusDisplay(clip.status);
            const isEditing = editingClipId === clip.id;
            const captionsExpanded = Boolean(openCaptions[clip.id]);
            const sizeMb = clip.fileSizeBytes
              ? `${(clip.fileSizeBytes / (1024 * 1024)).toFixed(1)} MB`
              : null;

            return (
              <article
                key={clip.id}
                className="flex flex-col overflow-hidden rounded-2xl border border-slate-800/90 bg-[#11151F]"
              >
                {/* Video / Viral Thumbnail Preview Viewport (9:16 Portrait or 16:9 Landscape) */}
                <div
                  className={`relative flex w-full items-center justify-center bg-black ${
                    clip.formatMode === 'long' && clip.aspectMode === 'landscape'
                      ? 'aspect-video max-h-[260px]'
                      : 'aspect-[9/16] max-h-[380px]'
                  }`}
                >
                  {clip.status === 'completed' && clip.videoUrl ? (
                    <>
                      {(previewModeByClip[clip.id] ?? 'video') === 'thumbnail' &&
                      clip.thumbnailUrl ? (
                        <img
                          src={clip.thumbnailUrl}
                          alt={`Thumbnail for ${clip.title}`}
                          className="h-full w-full object-contain bg-black"
                        />
                      ) : (
                        <video
                          src={clip.videoUrl}
                          poster={clip.thumbnailUrl}
                          controls
                          preload={clip.thumbnailUrl ? 'none' : 'metadata'}
                          playsInline
                          className="h-full w-full object-contain bg-black"
                        />
                      )}

                      {clip.thumbnailUrl && (
                        <div className="absolute right-2.5 top-2.5 z-10 flex items-center gap-1 rounded-lg border border-slate-700/80 bg-black/80 p-0.5 backdrop-blur-sm">
                          <button
                            type="button"
                            onClick={() =>
                              setPreviewModeByClip((prev) => ({
                                ...prev,
                                [clip.id]: 'video',
                              }))
                            }
                            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors ${
                              (previewModeByClip[clip.id] ?? 'video') === 'video'
                                ? 'bg-orange-600 text-white'
                                : 'text-slate-300 hover:text-white'
                            }`}
                          >
                            <Video className="h-3 w-3" />
                            <span>Video</span>
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setPreviewModeByClip((prev) => ({
                                ...prev,
                                [clip.id]: 'thumbnail',
                              }))
                            }
                            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors ${
                              previewModeByClip[clip.id] === 'thumbnail'
                                ? 'bg-orange-600 text-white'
                                : 'text-slate-300 hover:text-white'
                            }`}
                          >
                            <ImageIcon className="h-3 w-3" />
                            <span>Thumb</span>
                          </button>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="flex flex-col items-center justify-center px-6 text-center">
                      <span className={`text-sm font-semibold ${statusMeta.colorClass}`}>
                        {statusMeta.label}
                      </span>
                      <p className="mt-2 text-xs text-slate-400 tabular-nums">
                        Segment #{clip.chunkIndex} · {clip.startSeconds}s–{clip.endSeconds}s (
                        {clip.durationSeconds}s)
                      </p>
                      {clip.errorMessage && (
                        <p className="mt-2 max-w-xs text-xs text-red-400">
                          {clip.errorMessage}
                        </p>
                      )}
                      {clip.status === 'failed' && (
                        <button
                          type="button"
                          onClick={() => handleRetry(clip.id)}
                          disabled={retryingId === clip.id}
                          className="mt-4 inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 text-xs font-semibold text-slate-100 hover:bg-slate-800 disabled:opacity-50"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          <span>
                            {retryingId === clip.id ? 'Re-queuing...' : 'Retry Render'}
                          </span>
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Metadata & Controls */}
                <div className="flex flex-1 flex-col justify-between p-5">
                  {isEditing ? (
                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-400">
                          Moment Summary (1 short line)
                        </label>
                        <input
                          type="text"
                          value={editMomentSummary}
                          onChange={(e) => setEditMomentSummary(e.target.value)}
                          maxLength={140}
                          className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-700 bg-[#090B10] px-3 py-2 text-xs text-slate-100 focus:border-orange-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-400">
                          Title (max 80 chars)
                        </label>
                        <input
                          type="text"
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          maxLength={80}
                          className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-700 bg-[#090B10] px-3 py-2 text-sm text-slate-100 focus:border-orange-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-400">
                          Description
                        </label>
                        <textarea
                          rows={2}
                          value={editDesc}
                          onChange={(e) => setEditDesc(e.target.value)}
                          className="mt-1 w-full rounded-xl border border-slate-700 bg-[#090B10] px-3 py-2 text-sm text-slate-100 focus:border-orange-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-400">
                          Hashtags
                        </label>
                        <input
                          type="text"
                          value={editHashtags}
                          onChange={(e) => setEditHashtags(e.target.value)}
                          className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-700 bg-[#090B10] px-3 py-2 text-sm text-slate-100 focus:border-orange-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-400">
                          Tags (comma-separated)
                        </label>
                        <input
                          type="text"
                          value={editTags}
                          onChange={(e) => setEditTags(e.target.value)}
                          className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-700 bg-[#090B10] px-3 py-2 text-sm text-slate-100 focus:border-orange-500 focus:outline-none"
                        />
                      </div>
                      <div className="flex items-center justify-end gap-2 pt-2">
                        <button
                          type="button"
                          onClick={() => setEditingClipId(null)}
                          className="min-h-[44px] rounded-xl border border-slate-700 px-4 text-xs font-medium text-slate-300 hover:bg-slate-800"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSaveEdit(clip.id)}
                          disabled={savingId === clip.id}
                          className="min-h-[44px] rounded-xl bg-orange-600 px-4 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-50"
                        >
                          {savingId === clip.id ? 'Saving...' : 'Save Changes'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div>
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="text-base font-semibold leading-snug text-slate-50">
                            {clip.title}
                          </h3>
                          <button
                            type="button"
                            onClick={() => copyText(`title_${clip.id}`, clip.title)}
                            className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-100 shrink-0"
                            aria-label="Copy YouTube title"
                            title="Copy title"
                          >
                            {copiedKey === `title_${clip.id}` ? (
                              <Check className="h-4 w-4 text-emerald-400" />
                            ) : (
                              <Copy className="h-4 w-4" />
                            )}
                          </button>
                        </div>

                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400 tabular-nums">
                          {typeof clip.clipNumber === 'number' && (
                            <>
                              <span className="font-mono font-semibold text-slate-200">
                                Clip #{clip.clipNumber}
                              </span>
                              <span aria-hidden="true">·</span>
                            </>
                          )}
                          <span className="font-mono font-semibold text-orange-300">
                            {clip.formatMode === 'long' ? 'Long-Form Video' : 'Short'}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className={`font-medium ${statusMeta.colorClass}`}>
                            {statusMeta.label}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{CATEGORY_LABELS[clip.category]}</span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {clip.durationSeconds >= 60
                              ? `${Math.floor(clip.durationSeconds / 60)}m ${clip.durationSeconds % 60}s`
                              : `${clip.durationSeconds}s`}
                          </span>
                          {sizeMb && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>{sizeMb}</span>
                            </>
                          )}
                          {clip.languageChoice && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-medium text-emerald-300">
                                {LANGUAGE_LABELS[clip.languageChoice]}
                              </span>
                            </>
                          )}
                        </div>
                      </div>

                      {(clip.momentSummary || clip.viralReason) && (
                        <p className="rounded-lg border border-slate-800/80 bg-[#090B10] px-3 py-2 text-xs text-slate-300">
                          <span className="font-semibold text-orange-300">Moment Summary:</span>{' '}
                          {clip.momentSummary || clip.viralReason}
                        </p>
                      )}

                      {clip.description && (
                        <p className="text-sm leading-relaxed text-slate-300 whitespace-pre-line">
                          {clip.description}
                        </p>
                      )}

                      <div className="space-y-1.5 text-xs">
                        {clip.detectedWatermarkSpot && (
                          <p className="text-[11px] font-medium text-emerald-300/90">
                            Watermark GTA6HUB:{' '}
                            {clip.watermarkPosition === 'auto' ? 'Smart-Spot → ' : ''}
                            <span className="uppercase">{clip.detectedWatermarkSpot}</span>
                          </p>
                        )}
                        {clip.hashtags.length > 0 && (
                          <p className="text-orange-300/90">
                            {clip.hashtags.join(' ')}
                          </p>
                        )}
                        {clip.tags.length > 0 && (
                          <p className="text-slate-400">
                            Tags: {clip.tags.join(', ')}
                          </p>
                        )}
                      </div>

                      {/* Viral High-CTR Thumbnail Preview & Grounding Strip */}
                      {clip.status === 'completed' && clip.thumbnailUrl && (
                        <div className="rounded-xl border border-slate-800 bg-[#090B10] p-3 space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <img
                                src={clip.thumbnailUrl}
                                alt={`Viral thumbnail for ${clip.title}`}
                                className="h-12 w-20 rounded-md border border-slate-700 object-cover shrink-0 bg-black"
                              />
                              <div className="min-w-0">
                                <div className="flex items-center gap-1 text-[11px] font-semibold text-amber-300 truncate">
                                  <Sparkles className="h-3 w-3 shrink-0" />
                                  <span className="truncate">
                                    {clip.thumbnailHook || 'HIGH-CTR THUMBNAIL'}
                                  </span>
                                </div>
                                <div className="text-[10px] text-slate-400 tabular-nums">
                                  {clip.aspectMode === 'landscape' ? '1280×720' : '1080×1920'}
                                  {typeof clip.thumbnailTimestamp === 'number'
                                    ? ` · Frame @ ${clip.thumbnailTimestamp}s`
                                    : ''}
                                </div>
                              </div>
                            </div>

                            <button
                              type="button"
                              disabled={regeneratingThumbId === clip.id}
                              onClick={() => void handleRegenerateThumbnail(clip.id)}
                              className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2.5 text-[11px] font-medium text-slate-100 hover:bg-slate-800 disabled:opacity-50 shrink-0"
                            >
                              <RotateCcw
                                className={`h-3 w-3 ${
                                  regeneratingThumbId === clip.id ? 'animate-spin' : ''
                                }`}
                              />
                              <span>
                                {regeneratingThumbId === clip.id
                                  ? 'Styling...'
                                  : 'Regenerate Thumbnail'}
                              </span>
                            </button>
                          </div>

                          {clip.thumbnailSearchInsights && (
                            <p className="text-[11px] leading-relaxed text-slate-400">
                              <span className="font-medium text-slate-300">Search CTR Trend:</span>{' '}
                              {clip.thumbnailSearchInsights}
                            </p>
                          )}

                          {clip.thumbnailSearchSources &&
                            clip.thumbnailSearchSources.length > 0 && (
                              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                                {clip.thumbnailSearchSources.slice(0, 3).map((src, sIdx) => (
                                  <a
                                    key={sIdx}
                                    href={src.uri}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 rounded border border-slate-800 bg-slate-900/80 px-2 py-0.5 text-[10px] text-slate-300 hover:border-slate-700 hover:text-white max-w-[170px] truncate"
                                  >
                                    <span className="truncate">{src.title}</span>
                                    <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                                  </a>
                                ))}
                              </div>
                            )}
                        </div>
                      )}

                      {/* Captions / Subtitles Accordion */}
                      <div className="border-t border-slate-800/80 pt-3">
                        <div className="flex items-center justify-between">
                          <button
                            type="button"
                            onClick={() =>
                              setOpenCaptions((prev) => ({
                                ...prev,
                                [clip.id]: !prev[clip.id],
                              }))
                            }
                            className="inline-flex min-h-[36px] items-center gap-1.5 text-xs font-medium text-slate-300 hover:text-slate-50"
                          >
                            <FileText className="h-3.5 w-3.5 text-slate-400" />
                            <span>
                              Captions ({clip.captions.length} cues){' '}
                              {captionsExpanded ? '▲' : '▼'}
                            </span>
                          </button>

                          {clip.srtUrl && (
                            <button
                              type="button"
                              disabled={downloadingKey === `srt_${clip.id}`}
                              onClick={() =>
                                void handleDownloadFile(
                                  clip.srtUrl!,
                                  `${clip.id}.srt`,
                                  'application/x-subrip',
                                  `srt_${clip.id}`
                                )
                              }
                              className="text-xs font-medium text-orange-400 hover:text-orange-300 disabled:opacity-50"
                            >
                              {downloadingKey === `srt_${clip.id}`
                                ? 'Saving .SRT...'
                                : 'Save .SRT'}
                            </button>
                          )}
                        </div>

                        {captionsExpanded && (
                          <div className="mt-2 max-h-32 space-y-1 overflow-y-auto rounded-xl border border-slate-800 bg-[#090B10] p-2.5 font-mono text-xs">
                            {clip.captions.length === 0 ? (
                              <span className="text-slate-500">No spoken captions detected.</span>
                            ) : (
                              clip.captions.map((cue, idx) => (
                                <div key={idx} className="flex gap-2">
                                  <span className="text-slate-500 shrink-0 tabular-nums">
                                    {cue.startOffsetSeconds.toFixed(1)}s
                                  </span>
                                  <span className="text-slate-200">{cue.text}</span>
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {!isEditing && (
                    <div className="mt-4 space-y-2.5 border-t border-slate-800/80 pt-4">
                      {/* YouTube Data API v3 Upload Status & Action */}
                      {clip.status === 'completed' && (
                        <div className="rounded-xl border border-slate-800 bg-[#090B10] p-3 text-xs">
                          {clip.youtubeUploadStatus === 'uploaded' && clip.youtubeUrl ? (
                            <div className="space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <span className="font-semibold text-emerald-400">
                                    {clip.youtubeScheduledPublishAt
                                      ? `Scheduled on YouTube (${new Date(
                                          clip.youtubeScheduledPublishAt
                                        ).toLocaleString([], {
                                          month: 'short',
                                          day: 'numeric',
                                          hour: '2-digit',
                                          minute: '2-digit',
                                        })})`
                                      : `Uploaded to YouTube (${
                                          clip.youtubePrivacyStatus || 'public'
                                        })`}
                                    {clip.youtubeThumbnailSet ? ' + Custom Thumbnail' : ''}
                                  </span>
                                  <p className="mt-0.5 truncate font-mono text-[11px] text-slate-400">
                                    {clip.youtubeUrl}
                                  </p>
                                </div>
                                <a
                                  href={clip.youtubeUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-slate-700 px-2.5 font-medium text-slate-200 hover:bg-slate-800 shrink-0"
                                >
                                  <span>Open</span>
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              </div>
                            </div>
                          ) : clip.youtubeUploadStatus === 'uploading' ? (
                            <div className="flex items-center gap-2 font-medium text-orange-400">
                              <UploadCloud className="h-4 w-4 animate-pulse shrink-0" />
                              <span>
                                Uploading {clip.formatMode === 'long' ? 'Video + Thumbnail' : 'Short'}{' '}
                                &amp; AI metadata to YouTube...
                              </span>
                            </div>
                          ) : clip.youtubeUploadStatus === 'queued_upload' ? (
                            <div className="space-y-1">
                              <div className="flex items-center gap-2 font-medium text-amber-300">
                                <UploadCloud className="h-4 w-4 shrink-0" />
                                <span>
                                  {clip.youtubeUploadError
                                    ? 'Paused safely in queue (awaiting quota slot)'
                                    : 'Queued for automatic YouTube upload...'}
                                </span>
                              </div>
                              {clip.youtubeUploadError && (
                                <div className="text-[11px] text-amber-200/80 break-words">
                                  {clip.youtubeUploadError}
                                </div>
                              )}
                            </div>
                          ) : clip.youtubeUploadStatus === 'upload_failed' ? (
                            <div className="space-y-2.5">
                              <div className="text-red-400 break-words font-medium">
                                {clip.youtubeUploadError || 'Upload failed'}
                              </div>
                              <div className="flex flex-wrap items-center gap-2 pt-1">
                                <button
                                  type="button"
                                  disabled={uploadingYtId === clip.id}
                                  onClick={() => setConfirmUploadClip(clip)}
                                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 font-medium text-slate-100 hover:bg-slate-800 disabled:opacity-50"
                                >
                                  <RotateCcw className="h-3.5 w-3.5" />
                                  <span>Retry API Upload</span>
                                </button>
                                <a
                                  href="https://studio.youtube.com/channel/u/0/upload?d=1"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-orange-800/80 bg-orange-950/50 px-3 font-semibold text-orange-200 hover:bg-orange-900/60"
                                >
                                  <span>Upload in YouTube Studio</span>
                                  <ExternalLink className="h-3.5 w-3.5" />
                                </a>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-slate-400">
                                {youtubeSettings.connected
                                  ? `Ready for ${youtubeSettings.channel?.title || 'YouTube'}`
                                  : zernioSettings?.connected
                                  ? 'Optional: Direct YouTube Data API upload'
                                  : 'YouTube upload available'}
                              </span>
                              <button
                                type="button"
                                disabled={uploadingYtId === clip.id}
                                onClick={() => setConfirmUploadClip(clip)}
                                className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-3 font-medium text-slate-100 hover:bg-slate-700 disabled:opacity-50 shrink-0"
                              >
                                <UploadCloud className="h-3.5 w-3.5 text-orange-400" />
                                <span>Upload to YouTube</span>
                              </button>
                            </div>
                          )}

                          {clip.youtubeTimingAnalysis && (
                            <div className="mt-2.5 border-t border-slate-800/80 pt-2.5 space-y-1.5 text-[11px]">
                              <div className="flex flex-wrap items-center justify-between gap-1.5">
                                <span className="inline-flex items-center gap-1 font-semibold text-slate-200">
                                  {clip.youtubeTimingAnalysis.decision === 'scheduled' ? (
                                    <Clock className="h-3 w-3 text-amber-400" />
                                  ) : (
                                    <TrendingUp className="h-3 w-3 text-emerald-400" />
                                  )}
                                  <span>
                                    {clip.youtubeTimingAnalysis.decision === 'scheduled'
                                      ? 'Scheduled for Best Slot'
                                      : clip.youtubeTimingAnalysis.decision === 'publish_now'
                                      ? 'Published Immediately (Peak Window)'
                                      : 'Immediate Fallback Upload'}
                                  </span>
                                </span>
                                <span className="font-mono text-[10px] text-slate-400 tabular-nums">
                                  {clip.youtubeTimingAnalysis.analyzedVideoCount} videos ·{' '}
                                  {clip.youtubeTimingAnalysis.peakAudienceLabel}
                                </span>
                              </div>

                              <p className="leading-relaxed text-slate-400">
                                {clip.youtubeTimingAnalysis.reasoning}
                              </p>

                              {clip.youtubeTimingAnalysis.analyzedVideoCount > 0 && (
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] text-slate-500 tabular-nums">
                                  <span>
                                    Top velocity: {clip.youtubeTimingAnalysis.topSampledVelocity}{' '}
                                    views/hr
                                  </span>
                                  <span>
                                    Avg engagement:{' '}
                                    {clip.youtubeTimingAnalysis.avgNicheEngagementPct}%
                                  </span>
                                  <span>
                                    Spacing: {clip.youtubeTimingAnalysis.queueSpacingMinutes}m
                                  </span>
                                </div>
                              )}

                              {clip.youtubeTimingAnalysis.queries.length > 0 && (
                                <div className="text-[10px] text-slate-500 truncate">
                                  Search queries: {clip.youtubeTimingAnalysis.queries.join(' | ')}
                                </div>
                              )}

                              {clip.youtubeTimingAnalysis.fallbackReason && (
                                <div className="text-[10px] text-amber-300/90 break-words">
                                  API fallback notice: {clip.youtubeTimingAnalysis.fallbackReason}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Zernio Connected Accounts Upload (TikTok + Multi-Platform) */}
                      {clip.status === 'completed' && (
                        <div className="rounded-xl border border-slate-800 bg-[#090B10] p-3 text-xs space-y-2">
                          {clip.zernioPublishStatus === 'published' ||
                          clip.zernioPublishStatus === 'draft_sent' ||
                          clip.zernioPublishStatus === 'partial_failed' ? (
                            <div className="space-y-2">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span
                                  className={`font-semibold ${
                                    clip.zernioPublishStatus === 'partial_failed'
                                      ? 'text-amber-300'
                                      : 'text-emerald-400'
                                  }`}
                                >
                                  {clip.zernioPublishStatus === 'draft_sent'
                                    ? 'Saved as Draft in Zernio'
                                    : clip.zernioPublishStatus === 'partial_failed'
                                    ? 'Uploaded via Zernio (Partial Warning)'
                                    : 'Published via Zernio'}
                                </span>
                                {clip.zernioPostId && (
                                  <span className="font-mono text-[10px] text-slate-400">
                                    ID: {clip.zernioPostId.slice(0, 14)}
                                  </span>
                                )}
                              </div>

                              {clip.zernioPlatformResults &&
                                clip.zernioPlatformResults.length > 0 && (
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    {clip.zernioPlatformResults.map((res, rIdx) => {
                                      const meta = getPlatformBadgeMeta(res.platform);
                                      return res.platformPostUrl ? (
                                        <a
                                          key={`${res.accountId}_${rIdx}`}
                                          href={res.platformPostUrl}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-semibold hover:brightness-110 ${meta.colorClass}`}
                                        >
                                          <span>
                                            {meta.label}
                                            {res.accountName ? ` (${res.accountName})` : ''}
                                          </span>
                                          <ExternalLink className="h-2.5 w-2.5" />
                                        </a>
                                      ) : (
                                        <span
                                          key={`${res.accountId}_${rIdx}`}
                                          title={res.error || res.status}
                                          className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-semibold ${
                                            res.error
                                              ? 'border-red-800/70 bg-red-950/50 text-red-200'
                                              : meta.colorClass
                                          }`}
                                        >
                                          <span>
                                            {meta.label}: {res.error ? 'Failed' : res.status}
                                          </span>
                                        </span>
                                      );
                                    })}
                                  </div>
                                )}

                              {clip.zernioPublishError && (
                                <p className="text-[11px] text-amber-200/90 break-words">
                                  {clip.zernioPublishError}
                                </p>
                              )}

                              {clip.zernioPublishStatus === 'partial_failed' && (
                                <button
                                  type="button"
                                  disabled={publishingZernioId === clip.id}
                                  onClick={() => setConfirmZernioClip(clip)}
                                  className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg border border-indigo-700 bg-indigo-950/50 px-2.5 text-[11px] font-semibold text-indigo-200 hover:bg-indigo-900/60"
                                >
                                  <RotateCcw className="h-3 w-3" />
                                  <span>Re-Upload via Zernio</span>
                                </button>
                              )}
                            </div>
                          ) : clip.zernioPublishStatus === 'uploading' ? (
                            <div className="flex items-center gap-2 font-medium text-indigo-300">
                              <UploadCloud className="h-4 w-4 animate-pulse shrink-0" />
                              <span>
                                Uploading {clip.aspectMode === 'landscape' ? 'Video' : '9:16 Short'}{' '}
                                + #BD metadata to Zernio...
                              </span>
                            </div>
                          ) : clip.zernioPublishStatus === 'pending' ? (
                            <div className="flex items-center gap-2 font-medium text-amber-300">
                              <UploadCloud className="h-4 w-4 shrink-0" />
                              <span>Pending Zernio multi-platform upload...</span>
                            </div>
                          ) : clip.zernioPublishStatus === 'failed' ? (
                            <div className="space-y-2">
                              <div className="text-red-400 break-words font-medium">
                                Zernio upload failed: {clip.zernioPublishError || 'Upload error'}
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                <button
                                  type="button"
                                  disabled={publishingZernioId === clip.id}
                                  onClick={() => setConfirmZernioClip(clip)}
                                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-indigo-800/80 bg-indigo-950/50 px-3 font-medium text-indigo-200 hover:bg-indigo-900/60 disabled:opacity-50"
                                >
                                  <RotateCcw className="h-3.5 w-3.5" />
                                  <span>Retry Zernio Upload</span>
                                </button>
                              </div>
                            </div>
                          ) : !zernioSettings?.connected ? (
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="text-slate-400">
                                Connect Zernio to upload to TikTok &amp; connected accounts
                              </span>
                              <ZernioButton
                                compact
                                zernio={zernioSettings}
                                label="Connect Zernio"
                                onClick={() => onOpenZernioConnect?.()}
                              />
                            </div>
                          ) : (
                            (() => {
                              const selectedTargets = zernioSettings.accounts.filter(
                                (a) =>
                                  a.isActive &&
                                  a.selectedForUpload &&
                                  (clip.aspectMode !== 'landscape' ||
                                    a.platform.toLowerCase() !== 'tiktok')
                              );
                              const hasTikTokTarget = selectedTargets.some(
                                (a) => a.platform.toLowerCase() === 'tiktok'
                              );
                              const onlyTikTokTarget =
                                hasTikTokTarget && selectedTargets.length === 1;

                              return (
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <div className="min-w-0 flex flex-wrap items-center gap-1.5">
                                    {selectedTargets.length === 0 ? (
                                      <span className="text-slate-400">
                                        {zernioSettings.accounts.length === 0
                                          ? 'No accounts in Zernio yet'
                                          : 'Select target accounts in Zernio'}
                                      </span>
                                    ) : (
                                      selectedTargets.map((acc) => {
                                        const meta = getPlatformBadgeMeta(acc.platform);
                                        return (
                                          <span
                                            key={acc.id}
                                            className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${meta.colorClass}`}
                                          >
                                            {meta.label}
                                            {acc.username
                                              ? ` @${acc.username.replace(/^@/, '')}`
                                              : ''}
                                          </span>
                                        );
                                      })
                                    )}
                                  </div>

                                  {selectedTargets.length === 0 ? (
                                    <button
                                      type="button"
                                      onClick={() => onOpenZernioConnect?.()}
                                      className="inline-flex min-h-[36px] items-center rounded-lg border border-indigo-700 bg-indigo-950/40 px-3 text-xs font-semibold text-indigo-200 hover:bg-indigo-900/50"
                                    >
                                      Configure Zernio Accounts
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      disabled={publishingZernioId === clip.id}
                                      onClick={() => setConfirmZernioClip(clip)}
                                      className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-indigo-700/80 bg-indigo-950/50 px-3 font-medium text-indigo-100 hover:bg-indigo-900/60 disabled:opacity-50 shrink-0"
                                    >
                                      <UploadCloud className="h-3.5 w-3.5 text-indigo-300" />
                                      <span>
                                        {onlyTikTokTarget
                                          ? 'Upload to TikTok (Zernio)'
                                          : hasTikTokTarget
                                          ? `Upload to TikTok + ${selectedTargets.length - 1} More`
                                          : `Upload via Zernio (${selectedTargets.length})`}
                                      </span>
                                    </button>
                                  )}
                                </div>
                              );
                            })()
                          )}
                        </div>
                      )}

                      {/* Primary Mobile-Friendly Save Clip & Thumbnail Buttons */}
                      {clip.status === 'completed' && clip.videoUrl && (
                        <div className="space-y-2">
                          <button
                            type="button"
                            disabled={downloadingKey === `mp4_${clip.id}`}
                            onClick={() => {
                              const safeTitle = clip.title
                                .replace(/[^a-zA-Z0-9]+/g, '_')
                                .replace(/^_+|_+$/g, '')
                                .slice(0, 48);
                              const fileName = `${safeTitle || clip.id}.mp4`;
                              void handleDownloadFile(
                                clip.videoUrl!,
                                fileName,
                                'video/mp4',
                                `mp4_${clip.id}`
                              );
                            }}
                            className="flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl bg-orange-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-orange-500 active:scale-[0.99] disabled:opacity-70"
                          >
                            <Download className="h-4 w-4" />
                            <span>
                              {downloadingKey === `mp4_${clip.id}`
                                ? downloadPercent !== null
                                  ? `Downloading MP4 (${downloadPercent}%)...`
                                  : 'Downloading MP4...'
                                : 'Save Video to Phone (MP4)'}
                            </span>
                          </button>

                          {clip.thumbnailUrl && (
                            <button
                              type="button"
                              disabled={downloadingKey === `thumb_${clip.id}`}
                              onClick={() => {
                                const safeTitle = clip.title
                                  .replace(/[^a-zA-Z0-9]+/g, '_')
                                  .replace(/^_+|_+$/g, '')
                                  .slice(0, 40);
                                void handleDownloadFile(
                                  clip.thumbnailUrl!,
                                  `${safeTitle || clip.id}_thumbnail.jpg`,
                                  'image/jpeg',
                                  `thumb_${clip.id}`
                                );
                              }}
                              className="flex min-h-[38px] w-full items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-3 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800 disabled:opacity-70"
                            >
                              <Download className="h-3.5 w-3.5 text-orange-400" />
                              <span>
                                {downloadingKey === `thumb_${clip.id}`
                                  ? 'Downloading Thumbnail...'
                                  : `Save Viral Thumbnail (${
                                      clip.aspectMode === 'landscape' ? '1280×720' : '1080×1920'
                                    } JPG)`}
                              </span>
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => setExportModalClipId(clip.id)}
                            className="flex min-h-[38px] w-full items-center justify-between gap-2 rounded-xl border border-slate-800 bg-[#090B10] px-3 text-xs font-medium text-slate-300 transition-colors hover:border-slate-700 hover:text-white"
                          >
                            <span className="inline-flex items-center gap-1.5">
                              <Share2 className="h-3.5 w-3.5 text-cyan-400" />
                              <span>Third-Party Export / Webhook (Optional)</span>
                            </span>
                            {clip.thirdPartyExportStatus === 'sent' && (
                              <span className="text-[10px] font-semibold text-emerald-400">
                                Sent
                              </span>
                            )}
                          </button>
                        </div>
                      )}

                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => handleCopyAllForYouTube(clip)}
                          className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-xl border border-slate-700 px-3 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800 whitespace-nowrap"
                        >
                          {copiedKey === `all_${clip.id}` ? (
                            <Check className="h-3.5 w-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                          <span>
                            {copiedKey === `all_${clip.id}`
                              ? 'Copied Metadata!'
                              : 'Copy YouTube Metadata'}
                          </span>
                        </button>

                        <button
                          type="button"
                          onClick={() => startEdit(clip)}
                          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-800 text-slate-300 transition-colors hover:bg-slate-800 hover:text-slate-50"
                          aria-label={`Edit ${clip.title}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </button>

                        <button
                          type="button"
                          onClick={() => setConfirmDelete(clip)}
                          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-800 text-slate-400 transition-colors hover:bg-slate-800 hover:text-red-300"
                          aria-label={`Delete ${clip.title}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <ConfirmModal
        open={Boolean(confirmDelete)}
        title="Delete clip?"
        description={
          confirmDelete
            ? `This permanently deletes "${confirmDelete.title}" and its rendered MP4 and subtitle files from the server.`
            : ''
        }
        confirmLabel="Delete Clip"
        destructive
        busy={savingId === confirmDelete?.id}
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(null)}
      />

      <ConfirmModal
        open={Boolean(confirmUploadClip)}
        title={
          confirmUploadClip?.formatMode === 'long'
            ? 'Upload Long-Form Video to YouTube?'
            : 'Upload Short to YouTube?'
        }
        description={
          confirmUploadClip
            ? `Upload "${confirmUploadClip.title}" (${confirmUploadClip.durationSeconds}s) to ${
                youtubeSettings.channel?.title || 'your authorized YouTube channel'
              } as "${youtubeSettings.privacyStatus}" with its AI title, description, tags, hashtags, and custom high-CTR thumbnail via the official YouTube Data API.`
            : ''
        }
        confirmLabel={
          youtubeSettings.connected
            ? 'Upload to YouTube'
            : 'Sign in with Google & Upload'
        }
        busy={Boolean(uploadingYtId)}
        onConfirm={() => void handleConfirmYouTubeUpload()}
        onCancel={() => setConfirmUploadClip(null)}
      />

      <ConfirmModal
        open={Boolean(confirmZernioClip)}
        title="Upload Clip via Zernio Connected Accounts?"
        description={
          confirmZernioClip
            ? `Upload "${confirmZernioClip.title}" (${confirmZernioClip.durationSeconds}s) via Zernio (${
                zernioSettings?.uploadMode === 'draft' ? 'Save as Draft' : 'Publish Now'
              }) to: ${
                (zernioSettings?.accounts || [])
                  .filter(
                    (a) =>
                      a.isActive &&
                      a.selectedForUpload &&
                      (confirmZernioClip.aspectMode !== 'landscape' ||
                        a.platform.toLowerCase() !== 'tiktok')
                  )
                  .map(
                    (a) =>
                      `${a.platform.toUpperCase()}${
                        a.username ? ` (@${a.username.replace(/^@/, '')})` : ''
                      }`
                  )
                  .join(', ') || 'selected Zernio accounts'
              } with dynamic Bangla/Banglish/English copy and #BD hashtags.`
            : ''
        }
        confirmLabel={
          zernioSettings?.uploadMode === 'draft'
            ? 'Save Draft in Zernio'
            : 'Upload & Publish via Zernio'
        }
        busy={Boolean(publishingZernioId)}
        onConfirm={() => void handleConfirmZernioPublish()}
        onCancel={() => setConfirmZernioClip(null)}
      />

      <ThirdPartyExportModal
        clip={clips.find((c) => c.id === exportModalClipId) || null}
        settings={thirdPartyExportSettings || FALLBACK_THIRD_PARTY}
        onClose={() => setExportModalClipId(null)}
        onUpdated={onRefresh}
      />
    </div>
  );
}
