import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Music,
  Pause,
  Play,
  Volume2,
  VolumeX,
  Youtube,
} from 'lucide-react';
import { recordClientAction } from '../lib/actionLog.ts';

const DEFAULT_TRACK_TITLE = 'Tanveer Evan - Door Na Jaa';
const DEFAULT_SOURCE_URL = 'https://www.youtube.com/watch?v=AHF-EZocdSI';
const DEFAULT_VIDEO_ID = 'AHF-EZocdSI';
const MUSIC_PREFS_KEY = 'clips_ai_site_music_prefs_v1';

interface SiteMusicPrefs {
  volume: number;
  muted: boolean;
  wantedPlay: boolean;
}

function loadMusicPrefs(): SiteMusicPrefs {
  try {
    const raw = localStorage.getItem(MUSIC_PREFS_KEY);
    if (!raw) return { volume: 0.35, muted: false, wantedPlay: false };
    const parsed = JSON.parse(raw) as Partial<SiteMusicPrefs>;
    const volume =
      typeof parsed.volume === 'number' && parsed.volume >= 0 && parsed.volume <= 1
        ? parsed.volume
        : 0.35;
    return {
      volume,
      muted: Boolean(parsed.muted),
      wantedPlay: Boolean(parsed.wantedPlay),
    };
  } catch {
    return { volume: 0.35, muted: false, wantedPlay: false };
  }
}

export function SiteMusicPlayer() {
  const initialPrefs = useRef<SiteMusicPrefs>(loadMusicPrefs());
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const [trackTitle, setTrackTitle] = useState(DEFAULT_TRACK_TITLE);
  const [sourceUrl, setSourceUrl] = useState(DEFAULT_SOURCE_URL);
  const [videoId, setVideoId] = useState(DEFAULT_VIDEO_ID);
  const [streamUrl, setStreamUrl] = useState('/api/site-music/stream');

  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(initialPrefs.current.volume);
  const [muted, setMuted] = useState(initialPrefs.current.muted);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [streamFailed, setStreamFailed] = useState(false);
  const [showEmbedFallback, setShowEmbedFallback] = useState(false);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    fetch('/api/site-music/info', { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!active || !data) return;
        if (typeof data.title === 'string' && data.title.trim()) {
          setTrackTitle(data.title.trim());
        }
        if (typeof data.sourceUrl === 'string' && data.sourceUrl.trim()) {
          setSourceUrl(data.sourceUrl.trim());
        }
        if (typeof data.videoId === 'string' && data.videoId.trim()) {
          setVideoId(data.videoId.trim());
        }
        if (typeof data.streamUrl === 'string' && data.streamUrl.trim()) {
          setStreamUrl(data.streamUrl.trim());
        }
      })
      .catch((err: unknown) => {
        if (!active || (err instanceof Error && err.name === 'AbortError')) return;
        void recordClientAction({
          category: 'site_music',
          actionName: 'Website Music Metadata Fetch',
          sourceRef: DEFAULT_TRACK_TITLE,
          status: 'error',
          summary: `Music info check fell back to default track "${DEFAULT_TRACK_TITLE}".`,
        });
      })
      .finally(() => clearTimeout(timeoutId));
    return () => {
      active = false;
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        MUSIC_PREFS_KEY,
        JSON.stringify({ volume, muted, wantedPlay: isPlaying })
      );
    } catch {
      // Ignore storage errors
    }
  }, [volume, muted, isPlaying]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = volume;
    audio.muted = muted;
  }, [volume, muted]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !initialPrefs.current.wantedPlay || streamFailed) return;
    audio
      .play()
      .then(() => {
        setIsPlaying(true);
        setAutoplayBlocked(false);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'NotAllowedError') {
          setAutoplayBlocked(true);
        }
        setIsPlaying(false);
      });
  }, [streamFailed]);

  const handleTogglePlay = async () => {
    if (streamFailed) {
      setShowEmbedFallback((prev) => !prev);
      return;
    }
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
      setAutoplayBlocked(false);
      void recordClientAction({
        category: 'site_music',
        actionName: 'Website Music Paused',
        sourceRef: trackTitle,
        status: 'success',
        summary: `Paused website background track "${trackTitle}".`,
      });
      return;
    }

    try {
      audio.volume = volume;
      audio.muted = muted;
      await audio.play();
      setIsPlaying(true);
      setAutoplayBlocked(false);
      void recordClientAction({
        category: 'site_music',
        actionName: 'Website Music Playing',
        sourceRef: trackTitle,
        status: 'success',
        summary: `Playing "${trackTitle}" in website workspace UI only (not mixed into video clips).`,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setAutoplayBlocked(true);
      } else {
        setStreamFailed(true);
        setShowEmbedFallback(true);
        void recordClientAction({
          category: 'site_music',
          actionName: 'Website Music Embed Fallback',
          sourceRef: trackTitle,
          status: 'error',
          summary: 'Direct audio stream blocked or unavailable; switched to YouTube embed player.',
          details: err instanceof Error ? err.message : String(err),
        });
      }
      setIsPlaying(false);
    }
  };

  const handleToggleMute = () => {
    const nextMuted = !muted;
    setMuted(nextMuted);
    if (audioRef.current) {
      audioRef.current.muted = nextMuted;
    }
    void recordClientAction({
      category: 'site_music',
      actionName: nextMuted ? 'Website Music Muted' : 'Website Music Unmuted',
      sourceRef: trackTitle,
      status: 'success',
      summary: nextMuted
        ? `Muted website background track (${trackTitle}).`
        : `Unmuted website background track at ${Math.round(volume * 100)}% volume.`,
    });
  };

  const handleVolumeChange = (nextVol: number) => {
    const clamped = Math.min(1, Math.max(0, nextVol));
    setVolume(clamped);
    if (clamped > 0 && muted) {
      setMuted(false);
    }
    if (audioRef.current) {
      audioRef.current.volume = clamped;
      if (clamped > 0 && audioRef.current.muted) {
        audioRef.current.muted = false;
      }
    }
  };

  const handleToggleEmbed = () => {
    const next = !showEmbedFallback;
    if (next && isPlaying && audioRef.current) {
      audioRef.current.pause();
      setIsPlaying(false);
    }
    setShowEmbedFallback(next);
    void recordClientAction({
      category: 'site_music',
      actionName: next ? 'YouTube Embed Player Opened' : 'YouTube Embed Player Closed',
      sourceRef: videoId,
      status: 'success',
      summary: next
        ? `Opened YouTube embed fallback player for "${trackTitle}".`
        : `Closed YouTube embed player.`,
    });
  };

  const volumePct = Math.round((muted ? 0 : volume) * 100);

  return (
    <div className="border-b border-slate-800/80 bg-[#0D1017]/95 px-3 py-2 sm:px-6">
      <audio
        ref={audioRef}
        src={streamUrl}
        loop
        preload="metadata"
        onPlay={() => {
          setIsPlaying(true);
          setAutoplayBlocked(false);
        }}
        onPause={() => setIsPlaying(false)}
        onError={() => {
          setIsPlaying(false);
          setStreamFailed(true);
        }}
      />

      <div className="flex flex-wrap items-center justify-between gap-2.5">
        {/* Track Identity & Live Workspace Indicator */}
        <div className="flex min-w-0 items-center gap-2.5">
          <div
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${
              isPlaying
                ? 'border-orange-500/50 bg-orange-950/50 text-orange-300'
                : 'border-slate-800 bg-slate-900/90 text-slate-400'
            }`}
          >
            <Music className={`h-4 w-4 ${isPlaying ? 'animate-pulse' : ''}`} />
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="truncate text-xs font-semibold text-slate-100">
                {trackTitle}
              </span>
              <span className="rounded border border-slate-700/80 bg-slate-900 px-1.5 py-0.5 text-[10px] font-medium text-slate-300">
                Website BGM
              </span>
              {isPlaying && (
                <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Playing
                </span>
              )}
              {autoplayBlocked && !isPlaying && (
                <span className="text-[10px] font-medium text-amber-300">
                  Click Play to listen
                </span>
              )}
              {streamFailed && (
                <span className="text-[10px] font-medium text-amber-300">
                  Use YouTube Embed
                </span>
              )}
            </div>
            <p className="hidden sm:block text-[10px] text-slate-500 truncate">
              Plays only in this website workspace — exported video clips keep clean original source audio.
            </p>
          </div>
        </div>

        {/* Player Controls */}
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {!streamFailed && (
            <>
              <button
                type="button"
                onClick={() => void handleTogglePlay()}
                aria-label={isPlaying ? 'Pause website music' : 'Play website music'}
                className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                  isPlaying
                    ? 'border border-orange-600/60 bg-orange-600/20 text-orange-200 hover:bg-orange-600/30'
                    : 'border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800'
                }`}
              >
                {isPlaying ? (
                  <Pause className="h-3.5 w-3.5 fill-current" />
                ) : (
                  <Play className="h-3.5 w-3.5 fill-current" />
                )}
                <span>{isPlaying ? 'Pause' : 'Play'}</span>
              </button>

              <button
                type="button"
                onClick={handleToggleMute}
                aria-label={muted ? 'Unmute website music' : 'Mute website music'}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-800 bg-slate-900/90 text-slate-300 hover:bg-slate-800 hover:text-slate-100"
                title={muted ? 'Unmute' : 'Mute'}
              >
                {muted || volume === 0 ? (
                  <VolumeX className="h-3.5 w-3.5 text-slate-400" />
                ) : (
                  <Volume2 className="h-3.5 w-3.5 text-orange-300" />
                )}
              </button>

              <div className="hidden xs:flex sm:flex items-center gap-1.5 rounded-lg border border-slate-800 bg-[#090B10] px-2 h-8">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={volumePct}
                  onChange={(e) => handleVolumeChange(Number(e.target.value) / 100)}
                  aria-label="Website music volume"
                  className="h-1.5 w-16 sm:w-20 cursor-pointer accent-orange-500"
                />
                <span className="w-7 text-right font-mono text-[10px] text-slate-400 tabular-nums">
                  {volumePct}%
                </span>
              </div>
            </>
          )}

          <button
            type="button"
            onClick={handleToggleEmbed}
            className={`inline-flex h-8 items-center gap-1 rounded-lg border px-2.5 text-[11px] font-medium transition-colors whitespace-nowrap ${
              showEmbedFallback
                ? 'border-red-700/70 bg-red-950/40 text-red-200 hover:bg-red-900/40'
                : 'border-slate-800 bg-slate-900 text-slate-300 hover:bg-slate-800'
            }`}
            title="Toggle YouTube embed player fallback"
          >
            <Youtube className="h-3.5 w-3.5 text-red-400 shrink-0" />
            <span className="hidden md:inline">
              {showEmbedFallback ? 'Hide Embed' : 'YouTube Player'}
            </span>
            {showEmbedFallback ? (
              <ChevronUp className="h-3 w-3 shrink-0" />
            ) : (
              <ChevronDown className="h-3 w-3 shrink-0" />
            )}
          </button>

          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open Door Na Jaa on YouTube"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-800 bg-slate-900 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
            title="Open on YouTube"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>

      {showEmbedFallback && (
        <div className="mt-2.5 flex flex-col gap-2 rounded-xl border border-slate-800 bg-[#090B10] p-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="w-full max-w-md overflow-hidden rounded-lg border border-slate-800 bg-black">
            <iframe
              title={trackTitle}
              src={`https://www.youtube.com/embed/${videoId}?autoplay=1&loop=1&playlist=${videoId}`}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              className="h-24 w-full border-0"
            />
          </div>
          <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400 sm:flex-col sm:items-end">
            <span>Fallback YouTube embed active for workspace listening.</span>
            <button
              type="button"
              onClick={() => setShowEmbedFallback(false)}
              className="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-800"
            >
              Close Player
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
