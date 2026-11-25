import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { pipeline as streamPipeline } from 'stream/promises';
import { promisify } from 'util';
import { Client, Ytdl } from '@distube/ytdl-core';
import { normalizeYouTubeCookie } from './pipeline.ts';

const execFileAsync = promisify(execFile);

export const SITE_MUSIC_SOURCE_URL = 'https://www.youtube.com/watch?v=AHF-EZocdSI';
export const SITE_MUSIC_VIDEO_ID = 'AHF-EZocdSI';
export const SITE_MUSIC_TITLE = 'Tanveer Evan - Door Na Jaa';

const SITE_MUSIC_DIR = path.resolve(process.cwd(), 'data', 'site_music');
const SITE_MUSIC_CACHE = path.join(SITE_MUSIC_DIR, 'door_na_jaa_AHF-EZocdSI.m4a');

function ensureSiteMusicDir() {
  if (!fs.existsSync(SITE_MUSIC_DIR)) {
    fs.mkdirSync(SITE_MUSIC_DIR, { recursive: true });
  }
}

async function hasPlayableAudio(filePath: string): Promise<boolean> {
  try {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 50_000) return false;
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_streams', filePath],
      { timeout: 10_000 }
    );
    const parsed = JSON.parse(stdout || '{}') as { streams?: Array<{ codec_type?: string }> };
    return Boolean(parsed.streams?.some((s) => s.codec_type === 'audio'));
  } catch {
    return false;
  }
}

let pendingFetchPromise: Promise<string> | null = null;

export async function ensureSiteMusicAudioFile(): Promise<string> {
  ensureSiteMusicDir();

  if (await hasPlayableAudio(SITE_MUSIC_CACHE)) {
    return SITE_MUSIC_CACHE;
  }

  if (pendingFetchPromise) {
    return pendingFetchPromise;
  }

  pendingFetchPromise = (async () => {
    const cookie = normalizeYouTubeCookie(process.env.YOUTUBE_COOKIE);
    const clientConfigs = [
      { ...(cookie ? { cookie } : {}), clients: [Client.VisionOS] },
      {
        ...(cookie ? { cookie } : {}),
        clients: [Client.VisionOS, Client.WebEmbedded, Client.Tv],
      },
      { clients: [Client.VisionOS] },
    ];

    let ytdl: Ytdl | null = null;
    let info: Awaited<ReturnType<Ytdl['getInfo']>> | null = null;
    let lastErr: unknown = null;

    for (const cfg of clientConfigs) {
      try {
        const candidate = new Ytdl(cfg);
        const fetched = await candidate.getInfo(SITE_MUSIC_SOURCE_URL);
        if (Array.isArray(fetched.formats) && fetched.formats.some((f) => f.hasAudio && f.url)) {
          ytdl = candidate;
          info = fetched;
          break;
        }
      } catch (err) {
        lastErr = err;
      }
    }

    if (!ytdl || !info) {
      try {
        const { resolveYouTubeStreams } = await import('./youtubeExtractor.ts');
        const resolved = await resolveYouTubeStreams(SITE_MUSIC_SOURCE_URL, { audioOnly: true });
        if (resolved.videoUrl) {
          const tmpM4aFallback = path.join(SITE_MUSIC_DIR, `conv_fb_${Date.now()}.m4a`);
          await execFileAsync(
            'ffmpeg',
            ['-y', '-i', resolved.videoUrl, '-vn', '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart', tmpM4aFallback],
            { timeout: 60_000 }
          );
          if (await hasPlayableAudio(tmpM4aFallback)) {
            fs.renameSync(tmpM4aFallback, SITE_MUSIC_CACHE);
            return SITE_MUSIC_CACHE;
          }
        }
      } catch (fbErr) {
        lastErr = fbErr;
      }
      throw lastErr instanceof Error
        ? lastErr
        : new Error('Unable to resolve playable audio formats for site music.');
    }

    const formats = Array.isArray(info.formats) ? info.formats : [];
    const audioOnly = formats.filter((f) => f.hasAudio && !f.hasVideo && Boolean(f.url));
    const chosenFmt =
      audioOnly
        .filter((f) => f.container === 'mp4' || (f.audioCodec || '').toLowerCase().includes('mp4a'))
        .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0] ||
      audioOnly.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0] ||
      formats
        .filter((f) => f.hasAudio && Boolean(f.url))
        .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];

    if (!chosenFmt) {
      throw new Error('No playable audio stream available from site music source.');
    }

    const tmpDl = path.join(SITE_MUSIC_DIR, `dl_${Date.now()}.tmp`);
    const tmpM4a = path.join(SITE_MUSIC_DIR, `conv_${Date.now()}.m4a`);

    try {
      const stream = ytdl.download(info, { format: chosenFmt });
      await streamPipeline(stream, fs.createWriteStream(tmpDl));

      await execFileAsync(
        'ffmpeg',
        ['-y', '-i', tmpDl, '-vn', '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart', tmpM4a],
        { timeout: 60_000 }
      );

      if (!(await hasPlayableAudio(tmpM4a))) {
        throw new Error('Converted site music audio validation failed.');
      }

      fs.renameSync(tmpM4a, SITE_MUSIC_CACHE);
      return SITE_MUSIC_CACHE;
    } finally {
      for (const f of [tmpDl, tmpM4a]) {
        if (fs.existsSync(f)) {
          try {
            fs.unlinkSync(f);
          } catch {}
        }
      }
    }
  })().finally(() => {
    pendingFetchPromise = null;
  });

  return pendingFetchPromise;
}
