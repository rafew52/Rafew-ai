import { useEffect, useState, type FormEvent } from 'react';
import {
  CheckCircle2,
  Compass,
  ExternalLink,
  Eye,
  Play,
  Search,
  ShieldCheck,
  Sparkles,
  ThumbsUp,
  TrendingUp,
} from 'lucide-react';
import { getYouTubeAccessToken, signInYouTube } from '../lib/youtubeAuth.ts';
import type {
  ClipFormatMode,
  IdeaCandidateVideo,
  IdeaCategoryOption,
  IdeaLanguagePreference,
  IdeaSearchResult,
  StreamJob,
  SystemReadiness,
  VideoAspectMode,
} from '../types.ts';
import { GoogleSignInButton } from './GoogleSignInButton.tsx';
import { ZernioButton } from './ZernioButton.tsx';

interface IdeaFinderCardProps {
  readiness: SystemReadiness;
  onStarted: () => void;
  onOpenZernioConnect?: () => void;
}

const CATEGORY_OPTIONS: Array<{ id: IdeaCategoryOption; label: string }> = [
  { id: 'GTA', label: 'GTA' },
  { id: 'Free Fire', label: 'Free Fire' },
  { id: 'Comedy', label: 'Comedy' },
  { id: 'Funny', label: 'Funny' },
  { id: 'Viral', label: 'Viral' },
  { id: 'Adventure', label: 'Adventure' },
  { id: 'Other', label: 'Other / Custom' },
];

const LANGUAGE_OPTIONS: Array<{ id: IdeaLanguagePreference; label: string }> = [
  { id: 'auto', label: 'Auto (Smart Mix)' },
  { id: 'bengali', label: 'Bangla (বাংলা)' },
  { id: 'banglish', label: 'Banglish' },
  { id: 'english', label: 'English' },
  { id: 'any', label: 'Any Language' },
];

type ActionMode = 'auto_pick' | 'preview_top5';

export function IdeaFinderCard({
  readiness,
  onStarted,
  onOpenZernioConnect,
}: IdeaFinderCardProps) {
  const [idea, setIdea] = useState('');
  const [selectedCategories, setSelectedCategories] = useState<IdeaCategoryOption[]>(['GTA', 'Funny']);
  const [customCategory, setCustomCategory] = useState('');
  const [languagePreference, setLanguagePreference] = useState<IdeaLanguagePreference>('auto');
  const [clipCount, setClipCount] = useState<number | ''>('');
  const [actionMode, setActionMode] = useState<ActionMode>('auto_pick');
  const [formatMode, setFormatMode] = useState<ClipFormatMode>('short');
  const [aspectMode, setAspectMode] = useState<VideoAspectMode>('portrait');
  const [segmentSeconds, setSegmentSeconds] = useState(120);
  const [customInstructions, setCustomInstructions] = useState('');
  const [authorizedConfirmed, setAuthorizedConfirmed] = useState(false);

  const [busy, setBusy] = useState(false);
  const [startingVideoId, setStartingVideoId] = useState<string | null>(null);
  const [ytAuthBusy, setYtAuthBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchResult, setSearchResult] = useState<IdeaSearchResult | null>(null);
  const [launchedInfo, setLaunchedInfo] = useState<{
    stream: StreamJob;
    winner: IdeaCandidateVideo;
  } | null>(null);

  const ytConnected = readiness.youtubeAutoUpload.connected;
  const zernio = readiness.zernio;
  const hasAnySocialAuth = ytConnected || Boolean(zernio?.connected);

  useEffect(() => {
    if (!hasAnySocialAuth) return;
    if (searchResult?.apiStatus === 'no_youtube_auth') {
      setSearchResult(null);
    }
    setError((prev) =>
      prev && /connect either google|sign in with google|not authorized/i.test(prev)
        ? null
        : prev
    );
  }, [hasAnySocialAuth, searchResult?.apiStatus]);

  const toggleCategory = (cat: IdeaCategoryOption) => {
    setSelectedCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    );
  };

  const buildResolvedCategories = (): string[] => {
    const base: string[] = selectedCategories.filter((c) => c !== 'Other');
    if (selectedCategories.includes('Other') && customCategory.trim()) {
      base.push(customCategory.trim());
    }
    return base;
  };

  const handleQuickYouTubeAuth = async () => {
    setYtAuthBusy(true);
    setError(null);
    try {
      const { accessToken } = await signInYouTube();
      const res = await fetch('/api/youtube/connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to connect YouTube.');
      }
      onStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to authorize YouTube search.');
    } finally {
      setYtAuthBusy(false);
    }
  };

  const startCandidatePipeline = async (candidate?: IdeaCandidateVideo) => {
    if (!hasAnySocialAuth) {
      setError('Connect either Google or Zernio first to search YouTube and start clipping.');
      return;
    }
    if (!readiness.geminiConfigured) {
      setError('Gemini API key required for video frame/audio scanning. Add one in System Setup.');
      return;
    }
    if (!readiness.ffmpegAvailable) {
      setError('FFmpeg binary is not available on the server host.');
      return;
    }
    if (!authorizedConfirmed) {
      setError('Confirm authorized footage / transformation permission before launching clipping.');
      return;
    }

    const targetId = candidate?.videoId || '__auto__';
    setStartingVideoId(targetId);
    setError(null);
    setLaunchedInfo(null);

    try {
      const token = getYouTubeAccessToken();
      const res = await fetch('/api/idea-finder/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          idea: idea.trim(),
          categories: buildResolvedCategories(),
          languagePreference,
          ...(clipCount !== '' ? { clipCount: Number(clipCount) } : {}),
          customInstructions: customInstructions.trim(),
          formatMode,
          aspectMode: formatMode === 'long' ? aspectMode : 'portrait',
          segmentSeconds,
          brandingEnabled: true,
          authorizedConfirmed: true,
          ...(candidate ? { selectedCandidate: candidate } : {}),
        }),
      });
      const data = await res.json();
      if (data.searchResult) {
        setSearchResult(data.searchResult as IdeaSearchResult);
      }
      if (!res.ok) {
        throw new Error(data.error || 'Failed to launch Idea-to-Video clipping job.');
      }

      setLaunchedInfo({
        stream: data.stream as StreamJob,
        winner: data.winner as IdeaCandidateVideo,
      });
      onStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start Idea-to-Video job.');
    } finally {
      setStartingVideoId(null);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLaunchedInfo(null);

    if (!hasAnySocialAuth) {
      setError('Connect either Google or Zernio first to search YouTube and start clipping.');
      return;
    }

    if (!idea.trim()) {
      setError('Enter a video idea or topic (e.g., "GTA 6 Bangla funny moments").');
      return;
    }

    if (actionMode === 'auto_pick') {
      await startCandidatePipeline(undefined);
      return;
    }

    // "Show Top Ranked Matches First" mode
    setBusy(true);
    try {
      const token = getYouTubeAccessToken();
      const res = await fetch('/api/idea-finder/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          idea: idea.trim(),
          categories: buildResolvedCategories(),
          languagePreference,
        }),
      });
      const data = (await res.json()) as IdeaSearchResult & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'YouTube idea search failed.');
      }
      setSearchResult(data);
      if (data.apiStatus !== 'ok' && data.errorMessage) {
        setError(data.errorMessage);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to search YouTube.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-800/90 bg-[#11151F] p-5 sm:p-6 space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Compass className="h-5 w-5 text-orange-400" />
            <h2 className="text-lg font-semibold text-slate-50">
              AI Idea-to-YouTube Video Finder &amp; Auto-Clipper
            </h2>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            Describe any video idea, pick niche &amp; language filters, and let Claude search real
            YouTube videos, rank top velocity &amp; engagement candidates, and send the winner
            straight into 9:16 Facecam 50/50 Split clipping.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {ytConnected ? (
            <span className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-emerald-800/70 bg-emerald-950/35 px-3 text-xs font-semibold text-emerald-300 whitespace-nowrap">
              <CheckCircle2 className="h-4 w-4" />
              <span>Google Connected</span>
            </span>
          ) : (
            <GoogleSignInButton
              compact
              label="Sign in with Google"
              loading={ytAuthBusy}
              onClick={() => void handleQuickYouTubeAuth()}
            />
          )}

          <ZernioButton
            compact
            zernio={zernio}
            label="Connect Zernio"
            onClick={() => onOpenZernioConnect?.()}
          />
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {!hasAnySocialAuth && (
          <div className="rounded-xl border border-amber-800/60 bg-amber-950/30 p-3.5 text-xs text-amber-100 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="font-semibold text-amber-200">
                Connect Google or Zernio to Unlock Idea Discovery &amp; Clipping
              </div>
              <p className="mt-0.5 text-amber-200/80">
                Connecting either Google OR Zernio unlocks YouTube discovery, 9:16 split rendering, and auto-upload immediately.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <GoogleSignInButton
                compact
                label="Sign in with Google"
                loading={ytAuthBusy}
                onClick={() => void handleQuickYouTubeAuth()}
              />
              <ZernioButton
                compact
                zernio={zernio}
                label="Connect Zernio"
                onClick={() => onOpenZernioConnect?.()}
              />
            </div>
          </div>
        )}
        {/* Video Idea Input */}
        <div className="space-y-2">
          <label
            htmlFor="idea-finder-input"
            className="block text-xs font-semibold uppercase tracking-wider text-slate-300"
          >
            Video Idea / Topic Prompt
          </label>
          <textarea
            id="idea-finder-input"
            rows={2}
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder='e.g. "GTA 6 Bangla funny moments", "Free Fire one tap clutch highlights", or "Bangla gaming comedy rage"'
            className="w-full rounded-xl border border-slate-800 bg-[#090B10] px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
          />
        </div>

        {/* Category Quick-Pick Multi-Select */}
        <div className="space-y-2">
          <div className="text-xs font-medium text-slate-300">Category / Niche Filters</div>
          <div className="flex flex-wrap items-center gap-2">
            {CATEGORY_OPTIONS.map((cat) => {
              const active = selectedCategories.includes(cat.id);
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => toggleCategory(cat.id)}
                  className={`min-h-[34px] rounded-xl border px-3 text-xs font-semibold transition-colors ${
                    active
                      ? 'border-orange-500/80 bg-orange-950/40 text-orange-200'
                      : 'border-slate-800 bg-[#090B10] text-slate-400 hover:border-slate-700 hover:text-slate-200'
                  }`}
                >
                  {cat.label}
                </button>
              );
            })}
          </div>

          {selectedCategories.includes('Other') && (
            <input
              type="text"
              value={customCategory}
              onChange={(e) => setCustomCategory(e.target.value)}
              placeholder="Enter custom category/game (e.g. Valorant, Minecraft, IRL Comedy)..."
              className="mt-2 min-h-[40px] w-full rounded-xl border border-slate-800 bg-[#090B10] px-3.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
            />
          )}
        </div>

        {/* Language, Clip Count, Output Format, and Action Mode Row */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label
              htmlFor="idea-language-select"
              className="block text-xs font-medium text-slate-300"
            >
              Language Filter
            </label>
            <select
              id="idea-language-select"
              value={languagePreference}
              onChange={(e) => setLanguagePreference(e.target.value as IdeaLanguagePreference)}
              className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-800 bg-[#090B10] px-3 text-sm text-slate-100 focus:border-orange-500 focus:outline-none"
            >
              {LANGUAGE_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="idea-clip-count"
              className="block text-xs font-medium text-slate-300"
            >
              Clip Count Limit
            </label>
            <select
              id="idea-clip-count"
              value={clipCount}
              onChange={(e) => setClipCount(e.target.value ? Number(e.target.value) : '')}
              className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-800 bg-[#090B10] px-3 text-sm text-slate-100 focus:border-orange-500 focus:outline-none"
            >
              <option value="">Auto (All Highlights)</option>
              <option value="1">1 Clip Only</option>
              <option value="2">Up to 2 Clips</option>
              <option value="3">Up to 3 Clips</option>
              <option value="5">Up to 5 Clips</option>
              <option value="10">Up to 10 Clips</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="idea-format-select"
              className="block text-xs font-medium text-slate-300"
            >
              Clip Output Format
            </label>
            <select
              id="idea-format-select"
              value={formatMode === 'short' ? 'short' : `long_${aspectMode}`}
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'short') {
                  setFormatMode('short');
                  setAspectMode('portrait');
                  setSegmentSeconds(120);
                } else if (v === 'long_landscape') {
                  setFormatMode('long');
                  setAspectMode('landscape');
                  setSegmentSeconds(300);
                } else {
                  setFormatMode('long');
                  setAspectMode('portrait');
                  setSegmentSeconds(300);
                }
              }}
              className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-800 bg-[#090B10] px-3 text-sm text-slate-100 focus:border-orange-500 focus:outline-none"
            >
              <option value="short">Shorts (9:16 Facecam 50/50 Split)</option>
              <option value="long_landscape">Long-Form Highlights (16:9)</option>
              <option value="long_portrait">Long-Form Vertical (9:16)</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="idea-action-mode"
              className="block text-xs font-medium text-slate-300"
            >
              Discovery Mode
            </label>
            <select
              id="idea-action-mode"
              value={actionMode}
              onChange={(e) => setActionMode(e.target.value as ActionMode)}
              className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-800 bg-[#090B10] px-3 text-sm text-slate-100 focus:border-orange-500 focus:outline-none"
            >
              <option value="auto_pick">Auto-Pick Best &amp; Start Clipping</option>
              <option value="preview_top5">Show Top Ranked Matches First</option>
            </select>
          </div>
        </div>

        {/* Optional Extra Editing Rules */}
        <div>
          <label
            htmlFor="idea-custom-rules"
            className="block text-xs font-medium text-slate-300"
          >
            Optional Claude Director Notes (Captions, Focus, Exact Timing)
          </label>
          <input
            id="idea-custom-rules"
            type="text"
            value={customInstructions}
            onChange={(e) => setCustomInstructions(e.target.value)}
            placeholder="Optional: e.g. 'Focus on funny rage jumpscares and witty Bangla #BD titles'"
            className="mt-1.5 min-h-[42px] w-full rounded-xl border border-slate-800 bg-[#090B10] px-3.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
          />
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <label className="flex min-h-[44px] flex-1 cursor-pointer items-start gap-2.5 rounded-xl border border-slate-800 bg-[#090B10] p-3">
            <input
              type="checkbox"
              checked={authorizedConfirmed}
              onChange={(e) => setAuthorizedConfirmed(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-700 bg-slate-900 text-orange-500 focus:ring-orange-500 shrink-0"
            />
            <span className="text-xs leading-relaxed text-slate-300">
              <span className="inline-flex items-center gap-1 font-semibold text-slate-100">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                Authorized Clipping Confirmation:
              </span>{' '}
              I confirm I am authorized to clip/transform the selected YouTube source and publish
              my edited videos responsibly.
            </span>
          </label>

          <button
            type="submit"
            disabled={!hasAnySocialAuth || busy || startingVideoId !== null}
            className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-orange-600 px-5 text-sm font-semibold text-white transition-colors hover:bg-orange-500 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            {actionMode === 'auto_pick' ? (
              <>
                <Play className="h-4 w-4 fill-current" />
                <span>
                  {startingVideoId === '__auto__'
                    ? 'Finding & Launching...'
                    : 'Auto-Pick Best & Clip Now'}
                </span>
              </>
            ) : (
              <>
                <Search className="h-4 w-4" />
                <span>{busy ? 'Searching YouTube...' : 'Find Top 5 Real Matches'}</span>
              </>
            )}
          </button>
        </div>
      </form>

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-red-900/70 bg-red-950/40 px-4 py-3 text-xs leading-relaxed text-red-200 space-y-2"
        >
          <div>{error}</div>
          {!hasAnySocialAuth && searchResult?.apiStatus === 'no_youtube_auth' && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <GoogleSignInButton
                compact
                label="Sign in with Google"
                loading={ytAuthBusy}
                onClick={() => void handleQuickYouTubeAuth()}
              />
              <ZernioButton
                compact
                zernio={zernio}
                label="Connect Zernio"
                onClick={() => onOpenZernioConnect?.()}
              />
            </div>
          )}
        </div>
      )}

      {launchedInfo && (
        <div className="rounded-xl border border-emerald-800/70 bg-emerald-950/25 p-4 text-xs space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-300">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>Launched Claude Clipping Pipeline for Top Match!</span>
            </span>
            <a
              href={launchedInfo.winner.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-mono text-emerald-200 underline hover:text-white"
            >
              <span>Watch Source on YouTube</span>
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <div className="font-semibold text-slate-100">{launchedInfo.winner.title}</div>
          <p className="text-slate-300">
            Channel: <strong>{launchedInfo.winner.channelTitle}</strong> ·{' '}
            {launchedInfo.winner.viewCount.toLocaleString()} views
            {launchedInfo.winner.likeCount > 0
              ? ` · ${launchedInfo.winner.likeCount.toLocaleString()} likes`
              : ''}{' '}
            · Duration {launchedInfo.winner.durationLabel}
          </p>
          {launchedInfo.winner.claudeReasoning && (
            <p className="text-slate-400">{launchedInfo.winner.claudeReasoning}</p>
          )}
        </div>
      )}

      {/* Ranked Candidates Results Panel */}
      {searchResult && searchResult.candidates.length > 0 && (
        <div className="space-y-3 border-t border-slate-800/80 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-300">
              Top {searchResult.candidates.length} Strict Requirement-Matched Videos
              {typeof searchResult.rejectedCount === 'number' && searchResult.rejectedCount > 0 ? (
                <span className="ml-2 font-normal text-amber-300/90 normal-case">
                  ({searchResult.rejectedCount} off-topic/wrong-language discarded)
                </span>
              ) : null}
            </div>
            <div className="text-[11px] text-slate-400">
              Queries: {searchResult.expandedQueries.join(' | ')}
            </div>
          </div>

          {searchResult.winnerReasoning && (
            <div className="rounded-xl border border-orange-800/50 bg-orange-950/20 p-3.5 text-xs text-slate-200 space-y-1">
              <div className="flex items-center gap-1.5 font-semibold text-orange-300">
                <Sparkles className="h-3.5 w-3.5" />
                <span>Claude #1 Winner Selection Reasoning (Real YouTube Metrics)</span>
              </div>
              <p className="leading-relaxed text-slate-300">{searchResult.winnerReasoning}</p>
            </div>
          )}

          <div className="space-y-3">
            {searchResult.candidates.map((cand, idx) => (
              <div
                key={cand.videoId}
                className={`flex flex-col gap-3 rounded-xl border p-3.5 sm:flex-row sm:items-center sm:justify-between ${
                  idx === 0
                    ? 'border-emerald-800/80 bg-emerald-950/15'
                    : 'border-slate-800 bg-[#090B10]'
                }`}
              >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  {cand.thumbnailUrl && (
                    <img
                      src={cand.thumbnailUrl}
                      alt={cand.title}
                      className="h-16 w-28 rounded-lg border border-slate-800 object-cover shrink-0 bg-black"
                      loading="lazy"
                    />
                  )}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`font-mono text-[11px] font-bold ${
                          idx === 0 ? 'text-emerald-400' : 'text-orange-300'
                        }`}
                      >
                        Rank #{idx + 1} · Score {cand.totalScore}/100
                      </span>
                      <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                        {cand.durationLabel}
                      </span>
                    </div>

                    <a
                      href={cand.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate text-sm font-semibold text-slate-100 hover:text-orange-300"
                      title={cand.title}
                    >
                      {cand.title}
                    </a>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400 tabular-nums">
                      <span className="font-medium text-slate-300">{cand.channelTitle}</span>
                      <span className="inline-flex items-center gap-1">
                        <Eye className="h-3 w-3" />
                        {cand.viewCount.toLocaleString()} views
                      </span>
                      {cand.likeCount > 0 && (
                        <span className="inline-flex items-center gap-1">
                          <ThumbsUp className="h-3 w-3" />
                          {cand.likeCount.toLocaleString()} likes
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1 text-emerald-300">
                        <TrendingUp className="h-3 w-3" />
                        {Math.round(cand.viewVelocityPerHour).toLocaleString()} views/hr
                        {cand.likeCount > 0 ? ` (${cand.engagementPct}% eng)` : ''}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={startingVideoId !== null}
                    onClick={() => void startCandidatePipeline(cand)}
                    className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-xl bg-orange-600 px-3.5 text-xs font-semibold text-white transition-colors hover:bg-orange-500 disabled:opacity-50 whitespace-nowrap"
                  >
                    <Play className="h-3.5 w-3.5 fill-current" />
                    <span>
                      {startingVideoId === cand.videoId ? 'Starting...' : 'Clip This Video'}
                    </span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
