import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline as streamPipeline } from 'stream/promises';
import { promisify } from 'util';
import { chooseFormat, Client, Ytdl } from '@distube/ytdl-core';

const execFileAsync = promisify(execFile);

const BIN_DIR = path.resolve(process.cwd(), 'data', 'bin');
const LOCAL_YTDLP_PATH = path.join(
  BIN_DIR,
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
);

export interface ParsedYouTubeCookie {
  domain: string;
  includeSubdomains: boolean;
  path: string;
  secure: boolean;
  expires: number;
  name: string;
  value: string;
}

export function extractYouTubeVideoId(rawUrl?: string): string | null {
  const input = String(rawUrl || '').trim();
  if (!input) return null;
  try {
    const u = new URL(input);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (host === 'youtu.be') {
      const id = u.pathname.replace(/^\/+/, '').split('/')[0];
      return id && /^[a-zA-Z0-9_-]{6,20}$/.test(id) ? id : null;
    }
    if (host.includes('youtube.com') || host.includes('youtube-nocookie.com')) {
      const vParam = u.searchParams.get('v');
      if (vParam && /^[a-zA-Z0-9_-]{6,20}$/.test(vParam)) return vParam;
      const pathMatch = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([a-zA-Z0-9_-]{6,20})/);
      if (pathMatch?.[1]) return pathMatch[1];
    }
  } catch {
    const rawMatch = input.match(/(?:v=|youtu\.be\/|\/shorts\/|\/live\/|\/embed\/)([a-zA-Z0-9_-]{6,20})/);
    if (rawMatch?.[1]) return rawMatch[1];
  }
  return null;
}

export function findPrimaryVideoUrlInText(text: string): string | undefined {
  const matches = String(text || '').match(/https?:\/\/[^\s<>"'`)\]]+/gi);
  if (!matches || matches.length === 0) return undefined;

  const cleaned = matches
    .map((m) => m.replace(/[.,;!?]+$/, '').trim())
    .filter(Boolean);

  // Prioritize YouTube links or direct video/stream links
  const ytLink = cleaned.find((u) => /(?:youtube\.com|youtu\.be)/i.test(u));
  if (ytLink) return ytLink;

  const directMedia = cleaned.find((u) => /\.(?:mp4|mov|webm|mkv|m3u8)(?:[?#]|$)/i.test(u));
  return directMedia || cleaned[0];
}

function isRelevantCookieDomain(domain?: string): boolean {
  if (!domain) return true;
  const d = domain.toLowerCase();
  return (
    d.includes('youtube.com') ||
    d.includes('google.com') ||
    d.includes('youtu.be') ||
    d.includes('youtube-nocookie.com')
  );
}

function unwrapRawCookieInput(raw?: string): string {
  if (!raw) return '';
  let trimmed = raw.trim();
  if (!trimmed) return '';

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }

  // Unescape literal \r\n, \n, \t when pasted into single-line secret fields
  if (!trimmed.includes('\n') && (trimmed.includes('\\n') || trimmed.includes('\\t'))) {
    trimmed = trimmed
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t');
  }

  if (/^cookie\s*:/i.test(trimmed)) {
    trimmed = trimmed.replace(/^cookie\s*:/i, '').trim();
  }

  return trimmed;
}

/**
 * Parses YOUTUBE_COOKIE whether supplied as:
 * 1) Cookie-Editor JSON array ([{ name, value, domain, ... }]) or { cookies: [...] }
 * 2) Netscape cookies.txt (7-column tab/space separated rows)
 * 3) Standard HTTP Cookie header string (NAME=VALUE; NAME2=VALUE2)
 */
export function parseYouTubeCookies(raw?: string): ParsedYouTubeCookie[] {
  const trimmed = unwrapRawCookieInput(raw);
  if (!trimmed) return [];

  // 1) Cookie-Editor JSON array or { cookies: [...] }
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as
        | Array<Record<string, unknown>>
        | { cookies?: Array<Record<string, unknown>> };
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.cookies)
        ? parsed.cookies
        : null;

      if (list && list.length > 0) {
        const cookies: ParsedYouTubeCookie[] = [];
        for (const item of list) {
          const name = typeof item?.name === 'string' ? item.name.trim() : '';
          const value =
            typeof item?.value === 'string'
              ? item.value
              : item?.value !== undefined && item?.value !== null
              ? String(item.value)
              : '';
          if (!name) continue;
          const domainRaw =
            typeof item?.domain === 'string' && item.domain.trim()
              ? item.domain.trim()
              : '.youtube.com';
          if (!isRelevantCookieDomain(domainRaw)) continue;

          const domain = domainRaw.startsWith('.') || domainRaw.includes('.')
            ? domainRaw
            : `.${domainRaw}`;
          const expRaw =
            typeof item?.expirationDate === 'number'
              ? item.expirationDate
              : typeof item?.expires === 'number'
              ? item.expires
              : Math.floor(Date.now() / 1000) + 365 * 24 * 3600;

          cookies.push({
            domain,
            includeSubdomains: domain.startsWith('.'),
            path: typeof item?.path === 'string' && item.path.trim() ? item.path.trim() : '/',
            secure: typeof item?.secure === 'boolean' ? item.secure : name.startsWith('__Secure-'),
            expires: Math.max(0, Math.floor(Number(expRaw) || 0)),
            name,
            value: value.replace(/[\r\n]+/g, ''),
          });
        }
        if (cookies.length > 0) return cookies;
      }
    } catch {
      // Not valid JSON; fall through to Netscape / header detection
    }
  }

  // 2) Netscape cookies.txt format
  const lines = trimmed.split(/\r?\n/);
  const looksLikeNetscape =
    /#\s*(?:Netscape\s+)?HTTP\s+Cookie\s+File/i.test(trimmed) ||
    lines.some((line) => {
      const l = line.trim();
      if (!l || l.startsWith('#')) return false;
      const tabCols = l.split('\t');
      return tabCols.length >= 7;
    });

  if (looksLikeNetscape) {
    const cookies: ParsedYouTubeCookie[] = [];
    for (const rawLine of lines) {
      let line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('#HttpOnly_')) {
        line = line.slice('#HttpOnly_'.length);
      } else if (line.startsWith('#')) {
        continue;
      }

      const cols = line.includes('\t') ? line.split('\t') : line.split(/\s+/);
      if (cols.length < 7) continue;

      const domain = cols[0].trim();
      if (!isRelevantCookieDomain(domain)) continue;
      const includeSubdomains = cols[1].trim().toUpperCase() === 'TRUE';
      const cookiePath = cols[2].trim() || '/';
      const secure = cols[3].trim().toUpperCase() === 'TRUE';
      const expires = Math.max(0, Math.floor(Number(cols[4]) || 0));
      const name = cols[5].trim();
      const value = cols.slice(6).join(line.includes('\t') ? '\t' : ' ').trim();
      if (!name) continue;

      cookies.push({
        domain,
        includeSubdomains,
        path: cookiePath,
        secure,
        expires,
        name,
        value: value.replace(/[\r\n]+/g, ''),
      });
    }
    if (cookies.length > 0) return cookies;
  }

  // 3) Standard HTTP Cookie header format: "KEY=VALUE; KEY2=VALUE2"
  const headerSingleLine = trimmed.replace(/[\r\n]+/g, '; ');
  const parts = headerSingleLine.split(';').map((p) => p.trim()).filter(Boolean);
  const parsedHeader: ParsedYouTubeCookie[] = [];
  const defaultExp = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;

  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx <= 0) continue;
    const name = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();
    if (!name) continue;
    parsedHeader.push({
      domain: '.youtube.com',
      includeSubdomains: true,
      path: '/',
      secure: name.startsWith('__Secure-') || name.startsWith('SAPISID'),
      expires: defaultExp,
      name,
      value,
    });
  }

  return parsedHeader;
}

/**
 * Returns a clean single-line HTTP `Cookie` header value (`k1=v1; k2=v2`)
 * safe for `@distube/ytdl-core` and fetch/FFmpeg headers regardless of whether
 * `YOUTUBE_COOKIE` was supplied as JSON array, Netscape `cookies.txt`, or raw header.
 */
export function normalizeYouTubeCookieHeader(raw?: string): string | undefined {
  const cookies = parseYouTubeCookies(raw);
  if (cookies.length === 0) return undefined;

  const seen = new Map<string, string>();
  for (const c of cookies) {
    // Prefer youtube.com entries when cookie names collide across .google.com/.youtube.com
    if (!seen.has(c.name) || c.domain.includes('youtube.com')) {
      seen.set(c.name, c.value);
    }
  }

  const pairs: string[] = [];
  for (const [name, value] of seen.entries()) {
    pairs.push(`${name}=${value}`);
  }
  return pairs.length > 0 ? pairs.join('; ') : undefined;
}

/**
 * Converts Cookie-Editor JSON, raw Cookie header, or Netscape cookies.txt into
 * canonical Netscape cookies.txt text ready for `yt-dlp --cookies`.
 */
export function formatNetscapeCookiesTxt(raw?: string): string | undefined {
  const cookies = parseYouTubeCookies(raw);
  if (cookies.length === 0) return undefined;

  const rows = cookies.map((c) =>
    [
      c.domain,
      c.includeSubdomains ? 'TRUE' : 'FALSE',
      c.path || '/',
      c.secure ? 'TRUE' : 'FALSE',
      String(c.expires > 0 ? c.expires : Math.floor(Date.now() / 1000) + 86400 * 365),
      c.name,
      c.value,
    ].join('\t')
  );

  return ['# Netscape HTTP Cookie File', '# Generated by Clips ai Runtime Cookie Converter', '', ...rows, ''].join(
    '\n'
  );
}

export async function withTempNetscapeCookieFile<T>(
  fn: (cookieFilePath?: string) => Promise<T>,
  rawCookie = process.env.YOUTUBE_COOKIE
): Promise<T> {
  const netscapeText = formatNetscapeCookiesTxt(rawCookie);
  if (!netscapeText) {
    return fn(undefined);
  }

  const tmpPath = path.join(
    os.tmpdir(),
    `clips_ai_yt_cookies_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.txt`
  );
  fs.writeFileSync(tmpPath, netscapeText, { encoding: 'utf-8', mode: 0o600 });
  try {
    return await fn(tmpPath);
  } finally {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
    }
  }
}

let pendingYtDlpInstall: Promise<string | null> | null = null;

export function resolveInstalledYtDlpPath(): string | null {
  if (fs.existsSync(LOCAL_YTDLP_PATH)) {
    return LOCAL_YTDLP_PATH;
  }
  return null;
}

async function isExecutableWorking(bin: string): Promise<boolean> {
  try {
    await execFileAsync(bin, ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function ensureYtDlpBinary(): Promise<string | null> {
  if (await isExecutableWorking('yt-dlp')) {
    return 'yt-dlp';
  }
  if (fs.existsSync(LOCAL_YTDLP_PATH) && (await isExecutableWorking(LOCAL_YTDLP_PATH))) {
    return LOCAL_YTDLP_PATH;
  }

  if (pendingYtDlpInstall) {
    return pendingYtDlpInstall;
  }

  pendingYtDlpInstall = (async () => {
    try {
      if (!fs.existsSync(BIN_DIR)) {
        fs.mkdirSync(BIN_DIR, { recursive: true });
      }
      const assetName =
        process.platform === 'win32'
          ? 'yt-dlp.exe'
          : process.arch === 'arm64'
          ? 'yt-dlp_linux_aarch64'
          : 'yt-dlp_linux';

      const downloadUrl = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName}`;
      const res = await fetch(downloadUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok || !res.body) {
        return null;
      }

      const tmpBin = `${LOCAL_YTDLP_PATH}.tmp_${Date.now()}`;
      const { Readable } = await import('stream');
      const nodeStream = Readable.fromWeb(res.body as any);
      await streamPipeline(nodeStream, fs.createWriteStream(tmpBin));

      if (process.platform !== 'win32') {
        fs.chmodSync(tmpBin, 0o755);
      }
      fs.renameSync(tmpBin, LOCAL_YTDLP_PATH);

      if (await isExecutableWorking(LOCAL_YTDLP_PATH)) {
        return LOCAL_YTDLP_PATH;
      }
      return null;
    } catch {
      return null;
    } finally {
      pendingYtDlpInstall = null;
    }
  })();

  return pendingYtDlpInstall;
}

export function formatFriendlyYouTubeError(rawMsg: string, sourceUrl?: string): string {
  const vid = extractYouTubeVideoId(sourceUrl);
  const vidTag = vid ? ` [${vid}]` : '';
  const lower = rawMsg.toLowerCase();

  if (
    rawMsg.includes('SAPISID') ||
    rawMsg.includes('AUTH_FAILED') ||
    lower.includes('signed out') ||
    lower.includes('cookies are no longer valid')
  ) {
    return `YouTube authentication failed${vidTag}: YOUTUBE_COOKIE is signed out, expired, or missing SAPISID. Export fresh YouTube cookies (JSON or Netscape cookies.txt) and update YOUTUBE_COOKIE in Settings > Secrets.`;
  }

  if (
    rawMsg.includes('BOT_CHECK') ||
    lower.includes('not a bot') ||
    lower.includes('sign in to confirm') ||
    lower.includes('403')
  ) {
    return `YouTube requested sign-in verification${vidTag} from this server IP (bot check). Set or refresh YOUTUBE_COOKIE (Cookie-Editor JSON or Netscape cookies.txt) in Settings > Secrets.`;
  }

  if (lower.includes('could not prepare player') || lower.includes('player_solve_failed')) {
    return `YouTube player extraction error${vidTag} (${rawMsg.slice(0, 140)}). Refresh YOUTUBE_COOKIE or verify the video link is public/playable — never substituting dummy color bars.`;
  }

  return `Real YouTube extraction failed${vidTag} (${rawMsg.slice(0, 200)}). Never substituting dummy color bars — verify the Source Video URL or refresh YOUTUBE_COOKIE.`;
}

interface YtDlpFormat {
  url?: string;
  vcodec?: string;
  acodec?: string;
  ext?: string;
  height?: number;
  width?: number;
  fps?: number;
  tbr?: number;
  abr?: number;
  http_headers?: Record<string, string>;
}

interface YtDlpMetadata {
  id?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  thumbnail?: string;
  is_live?: boolean;
  duration?: number;
  url?: string;
  requested_formats?: YtDlpFormat[];
  formats?: YtDlpFormat[];
  http_headers?: Record<string, string>;
}

const YTDLP_CLIENT_PROFILES = [
  'youtube:player_client=web,android,ios,tv_embedded',
  'youtube:player_client=android_vr,tv_embedded,web_embedded,mweb',
];

async function queryYtDlpJson(params: {
  ytDlpBin: string;
  sourceUrl: string;
  cookieFile?: string;
  clientProfile: string;
  audioOnly?: boolean;
}): Promise<YtDlpMetadata> {
  const formatSelector = params.audioOnly
    ? 'bestaudio[ext=m4a]/bestaudio/best'
    : 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b[height<=1080]/best';

  const args = [
    '--no-warnings',
    '--no-playlist',
    '--js-runtimes',
    'node',
    '--extractor-args',
    params.clientProfile,
    '-f',
    formatSelector,
    '-j',
  ];

  if (params.cookieFile) {
    args.push('--cookies', params.cookieFile);
  }
  args.push(params.sourceUrl);

  const { stdout } = await execFileAsync(params.ytDlpBin, args, {
    timeout: 45_000,
    maxBuffer: 15 * 1024 * 1024,
  });

  const parsed = JSON.parse(stdout.trim()) as YtDlpMetadata;
  return parsed;
}

function buildFfmpegHeaderArgs(headers?: Record<string, string>, cookieHeader?: string): string[] {
  const entries: string[] = [];
  const ua = headers?.['User-Agent'] || headers?.['user-agent'];
  if (ua) {
    entries.push(`User-Agent: ${ua}`);
  }
  const ref = headers?.['Referer'] || headers?.['referer'];
  if (ref) {
    entries.push(`Referer: ${ref}`);
  }
  const effectiveCookie = cookieHeader || headers?.['Cookie'] || headers?.['cookie'];
  if (effectiveCookie) {
    entries.push(`Cookie: ${effectiveCookie}`);
  }
  if (entries.length === 0) return [];
  return ['-headers', `${entries.join('\r\n')}\r\n`];
}

function formatYtDlpSectionStamp(sec: number): string {
  const safe = Math.max(0, sec);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = (safe % 60).toFixed(2).padStart(5, '0');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s}`;
}

/**
 * Extracts a real clipped video+audio segment [startSec .. startSec + duration]
 * directly from the active YouTube Source Video URL.
 * Tier 1: yt-dlp (web, android, ios, tv_embedded + Node JS runtime + JSON/Netscape cookies)
 * Tier 2: @distube/ytdl-core (VisionOS first — no player script needed — then WebEmbedded/Tv)
 * Never substitutes dummy color bars (`testsrc`).
 */
export async function extractYouTubeSegment(params: {
  sourceUrl: string;
  startSec: number;
  duration: number;
  rawCutPath: string;
}): Promise<void> {
  const { sourceUrl, startSec, duration, rawCutPath } = params;
  const cookieHeader = normalizeYouTubeCookieHeader(process.env.YOUTUBE_COOKIE);
  const errors: string[] = [];

  // Tier 1: yt-dlp with modern player client fallbacks
  const ytDlpBin = await ensureYtDlpBinary();
  if (ytDlpBin) {
    await withTempNetscapeCookieFile(async (cookieFile) => {
      for (const clientProfile of YTDLP_CLIENT_PROFILES) {
        // 1A: Fast stream URL extraction + FFmpeg range-seek cut
        try {
          const meta = await queryYtDlpJson({
            ytDlpBin,
            sourceUrl,
            cookieFile,
            clientProfile,
          });

          const reqFmts = Array.isArray(meta.requested_formats) ? meta.requested_formats : [];
          const videoFmt =
            reqFmts.find((f) => f.vcodec && f.vcodec !== 'none' && f.url) ||
            (meta.formats || []).find((f) => f.vcodec && f.vcodec !== 'none' && f.url);
          const audioFmt =
            reqFmts.find((f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none') && f.url) ||
            reqFmts.find((f) => f.acodec && f.acodec !== 'none' && f.url);

          const directCombinedUrl =
            !reqFmts.length && meta.url ? meta.url : undefined;

          if (videoFmt?.url && audioFmt?.url && videoFmt.url !== audioFmt.url) {
            const vHeaders = buildFfmpegHeaderArgs(videoFmt.http_headers || meta.http_headers, cookieHeader);
            const aHeaders = buildFfmpegHeaderArgs(audioFmt.http_headers || meta.http_headers, cookieHeader);
            await execFileAsync(
              'ffmpeg',
              [
                '-y',
                ...vHeaders,
                '-ss',
                String(startSec),
                '-t',
                String(duration),
                '-i',
                videoFmt.url,
                ...aHeaders,
                '-ss',
                String(startSec),
                '-t',
                String(duration),
                '-i',
                audioFmt.url,
                '-map',
                '0:v:0',
                '-map',
                '1:a:0',
                '-c:v',
                'libx264',
                '-preset',
                'ultrafast',
                '-crf',
                '20',
                '-c:a',
                'aac',
                '-b:a',
                '128k',
                rawCutPath,
              ],
              { timeout: 65_000 }
            );
          } else if (directCombinedUrl || videoFmt?.url) {
            const urlToCut = directCombinedUrl || videoFmt!.url!;
            const headers = buildFfmpegHeaderArgs(
              videoFmt?.http_headers || meta.http_headers,
              cookieHeader
            );
            await execFileAsync(
              'ffmpeg',
              [
                '-y',
                ...headers,
                '-ss',
                String(startSec),
                '-t',
                String(duration),
                '-i',
                urlToCut,
                '-c:v',
                'libx264',
                '-preset',
                'ultrafast',
                '-crf',
                '20',
                '-c:a',
                'aac',
                '-b:a',
                '128k',
                rawCutPath,
              ],
              { timeout: 65_000 }
            );
          }

          if (fs.existsSync(rawCutPath) && fs.statSync(rawCutPath).size > 4096) {
            return;
          }
        } catch (err1a) {
          errors.push(err1a instanceof Error ? err1a.message : String(err1a));
          if (fs.existsSync(rawCutPath)) {
            try {
              fs.unlinkSync(rawCutPath);
            } catch {}
          }
        }

        // 1B: Direct section download via yt-dlp --download-sections
        try {
          const endSec = startSec + duration;
          const sectionTemplate = `${rawCutPath}.sec_%(id)s.%(ext)s`;
          const args = [
            '--no-warnings',
            '--no-playlist',
            '--js-runtimes',
            'node',
            '--extractor-args',
            clientProfile,
            '-f',
            'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b[height<=1080]/best',
            '--download-sections',
            `*${formatYtDlpSectionStamp(startSec)}-${formatYtDlpSectionStamp(endSec)}`,
            '--force-keyframes-at-cuts',
            '--merge-output-format',
            'mp4',
            '-o',
            sectionTemplate,
          ];
          if (cookieFile) {
            args.push('--cookies', cookieFile);
          }
          args.push(sourceUrl);

          await execFileAsync(ytDlpBin, args, { timeout: 85_000 });
          const dir = path.dirname(rawCutPath);
          const prefix = `${path.basename(rawCutPath)}.sec_`;
          const downloadedFile = fs
            .readdirSync(dir)
            .find((name) => name.startsWith(prefix) && fs.statSync(path.join(dir, name)).size > 4096);

          if (downloadedFile) {
            const fullDlPath = path.join(dir, downloadedFile);
            try {
              await execFileAsync(
                'ffmpeg',
                [
                  '-y',
                  '-i',
                  fullDlPath,
                  '-t',
                  String(duration),
                  '-c:v',
                  'libx264',
                  '-preset',
                  'ultrafast',
                  '-crf',
                  '20',
                  '-c:a',
                  'aac',
                  '-b:a',
                  '128k',
                  rawCutPath,
                ],
                { timeout: 45_000 }
              );
            } finally {
              if (fs.existsSync(fullDlPath)) {
                try {
                  fs.unlinkSync(fullDlPath);
                } catch {}
              }
            }
            if (fs.existsSync(rawCutPath) && fs.statSync(rawCutPath).size > 4096) {
              return;
            }
          }
        } catch (err1b) {
          errors.push(err1b instanceof Error ? err1b.message : String(err1b));
          if (fs.existsSync(rawCutPath)) {
            try {
              fs.unlinkSync(rawCutPath);
            } catch {}
          }
        }
      }
    });

    if (fs.existsSync(rawCutPath) && fs.statSync(rawCutPath).size > 4096) {
      return;
    }
  }

  // Tier 2: @distube/ytdl-core starting with VisionOS (no player JS script needed)
  const ytdlConfigs = [
    { ...(cookieHeader ? { cookie: cookieHeader } : {}), clients: [Client.VisionOS] },
    {
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      clients: [Client.VisionOS, Client.WebEmbedded, Client.Tv],
    },
  ];

  for (const cfg of ytdlConfigs) {
    try {
      const ytdl = new Ytdl(cfg);
      const info = await ytdl.getInfo(sourceUrl);
      const formats = Array.isArray(info.formats) ? info.formats : [];

      const combinedFormats = formats.filter(
        (f) => f.hasVideo && f.hasAudio && (f.height || 0) <= 1080 && Boolean(f.url)
      );
      const bestCombined = combinedFormats.sort(
        (a, b) => (b.height || 0) - (a.height || 0) || (b.fps || 0) - (a.fps || 0)
      )[0];

      const videoCandidates = formats.filter(
        (f) => f.hasVideo && (f.height || 0) <= 1080 && Boolean(f.url)
      );
      const mp4Video = videoCandidates
        .filter((f) => f.container === 'mp4')
        .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0))[0];
      const bestVideo =
        mp4Video ||
        videoCandidates.sort(
          (a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0)
        )[0] ||
        (() => {
          try {
            return chooseFormat(formats, { quality: 'highestvideo', filter: { hasVideo: true } });
          } catch {
            return undefined;
          }
        })();

      const audioCandidates = formats.filter((f) => f.hasAudio && !f.hasVideo && Boolean(f.url));
      const bestAudio =
        audioCandidates
          .filter((f) => f.container === 'mp4' || (f.audioCodec || '').toLowerCase().includes('mp4a'))
          .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0] ||
        audioCandidates.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];

      if (bestVideo?.url && !bestVideo.hasAudio && bestAudio?.url) {
        await execFileAsync(
          'ffmpeg',
          [
            '-y',
            '-ss',
            String(startSec),
            '-t',
            String(duration),
            '-i',
            bestVideo.url,
            '-ss',
            String(startSec),
            '-t',
            String(duration),
            '-i',
            bestAudio.url,
            '-map',
            '0:v:0',
            '-map',
            '1:a:0',
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-crf',
            '20',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            rawCutPath,
          ],
          { timeout: 65_000 }
        );
      } else if (bestCombined?.url || bestVideo?.url) {
        await execFileAsync(
          'ffmpeg',
          [
            '-y',
            '-ss',
            String(startSec),
            '-t',
            String(duration),
            '-i',
            (bestCombined || bestVideo)!.url,
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-crf',
            '20',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            rawCutPath,
          ],
          { timeout: 65_000 }
        );
      }

      if (fs.existsSync(rawCutPath) && fs.statSync(rawCutPath).size > 4096) {
        return;
      }

      if (bestCombined || bestVideo) {
        const tmpRaw = `${rawCutPath}.ytdl_${Date.now()}.mp4`;
        try {
          const stream = ytdl.download(info, { format: bestCombined || bestVideo! });
          await streamPipeline(stream, fs.createWriteStream(tmpRaw));
          await execFileAsync(
            'ffmpeg',
            [
              '-y',
              '-ss',
              String(startSec),
              '-t',
              String(duration),
              '-i',
              tmpRaw,
              '-c:v',
              'libx264',
              '-preset',
              'ultrafast',
              '-crf',
              '20',
              '-c:a',
              'aac',
              '-b:a',
              '128k',
              rawCutPath,
            ],
            { timeout: 65_000 }
          );
          if (fs.existsSync(rawCutPath) && fs.statSync(rawCutPath).size > 4096) {
            return;
          }
        } finally {
          if (fs.existsSync(tmpRaw)) {
            try {
              fs.unlinkSync(tmpRaw);
            } catch {}
          }
        }
      }
    } catch (err2) {
      errors.push(err2 instanceof Error ? err2.message : String(err2));
      if (fs.existsSync(rawCutPath)) {
        try {
          fs.unlinkSync(rawCutPath);
        } catch {}
      }
    }
  }

  const combinedErr = errors.find(Boolean) || 'Unable to extract requested YouTube video segment.';
  throw new Error(formatFriendlyYouTubeError(combinedErr, sourceUrl));
}

export interface ResolvedYouTubeStreams {
  title?: string;
  channelName?: string;
  thumbnailUrl?: string;
  isLive?: boolean;
  videoUrl: string;
  audioUrl?: string;
  hasAudioInVideoUrl: boolean;
  httpHeaders?: Record<string, string>;
}

/**
 * Resolves live/VOD stream metadata + playable direct URLs for live ingestion,
 * site music, or restreaming — avoiding `@distube/ytdl-core` `Could not prepare player` crashes.
 */
export async function resolveYouTubeStreams(
  sourceUrl: string,
  options?: { audioOnly?: boolean }
): Promise<ResolvedYouTubeStreams> {
  const cookieHeader = normalizeYouTubeCookieHeader(process.env.YOUTUBE_COOKIE);
  const errors: string[] = [];

  // 1) Try yt-dlp JSON resolution first
  const ytDlpBin = await ensureYtDlpBinary();
  if (ytDlpBin) {
    const resolved = await withTempNetscapeCookieFile(async (cookieFile) => {
      for (const clientProfile of YTDLP_CLIENT_PROFILES) {
        try {
          const meta = await queryYtDlpJson({
            ytDlpBin,
            sourceUrl,
            cookieFile,
            clientProfile,
            audioOnly: options?.audioOnly,
          });
          const reqFmts = Array.isArray(meta.requested_formats) ? meta.requested_formats : [];
          const videoFmt =
            reqFmts.find((f) => f.vcodec && f.vcodec !== 'none' && f.url) ||
            (!options?.audioOnly
              ? (meta.formats || []).find((f) => f.vcodec && f.vcodec !== 'none' && f.url)
              : undefined);
          const audioFmt =
            reqFmts.find((f) => f.acodec && f.acodec !== 'none' && f.url) ||
            (meta.formats || []).find((f) => f.acodec && f.acodec !== 'none' && f.url);

          const primaryUrl = options?.audioOnly
            ? audioFmt?.url || meta.url
            : videoFmt?.url || meta.url || audioFmt?.url;

          if (primaryUrl) {
            return {
              title: meta.title,
              channelName: meta.channel || meta.uploader,
              thumbnailUrl: meta.thumbnail,
              isLive: Boolean(meta.is_live),
              videoUrl: primaryUrl,
              audioUrl:
                !options?.audioOnly && videoFmt?.url && audioFmt?.url && audioFmt.url !== videoFmt.url
                  ? audioFmt.url
                  : undefined,
              hasAudioInVideoUrl: Boolean(
                options?.audioOnly ||
                  (videoFmt?.acodec && videoFmt.acodec !== 'none') ||
                  (!reqFmts.length && meta.url)
              ),
              httpHeaders: videoFmt?.http_headers || audioFmt?.http_headers || meta.http_headers,
            } satisfies ResolvedYouTubeStreams;
          }
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
      return null;
    });

    if (resolved) return resolved;
  }

  // 2) Fallback to @distube/ytdl-core starting with VisionOS (no player JS script)
  for (const cfg of [
    { ...(cookieHeader ? { cookie: cookieHeader } : {}), clients: [Client.VisionOS] },
    {
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      clients: [Client.VisionOS, Client.WebEmbedded, Client.Tv],
    },
  ]) {
    try {
      const ytdl = new Ytdl(cfg);
      const info = await ytdl.getInfo(sourceUrl);
      const formats = Array.isArray(info.formats) ? info.formats : [];

      if (options?.audioOnly) {
        const audioOnly = formats.filter((f) => f.hasAudio && !f.hasVideo && f.url);
        const fmt =
          audioOnly.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0] ||
          formats.filter((f) => f.hasAudio && f.url).sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];
        if (fmt?.url) {
          return {
            title: info.videoDetails.title,
            channelName: info.videoDetails.author?.name,
            isLive: Boolean(info.videoDetails.isLive),
            videoUrl: fmt.url,
            hasAudioInVideoUrl: true,
          };
        }
      } else {
        const combined = formats
          .filter((f) => f.hasVideo && f.hasAudio && (f.height || 0) <= 1080 && f.url)
          .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
        if (combined?.url) {
          return {
            title: info.videoDetails.title,
            channelName: info.videoDetails.author?.name,
            isLive: Boolean(info.videoDetails.isLive),
            videoUrl: combined.url,
            hasAudioInVideoUrl: true,
          };
        }
        const vid = formats
          .filter((f) => f.hasVideo && (f.height || 0) <= 1080 && f.url)
          .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
        const aud = formats
          .filter((f) => f.hasAudio && !f.hasVideo && f.url)
          .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];
        if (vid?.url) {
          return {
            title: info.videoDetails.title,
            channelName: info.videoDetails.author?.name,
            isLive: Boolean(info.videoDetails.isLive),
            videoUrl: vid.url,
            audioUrl: aud?.url,
            hasAudioInVideoUrl: Boolean(vid.hasAudio),
          };
        }
      }
    } catch (err2) {
      errors.push(err2 instanceof Error ? err2.message : String(err2));
    }
  }

  throw new Error(formatFriendlyYouTubeError(errors.find(Boolean) || 'Stream lookup failed.', sourceUrl));
}
