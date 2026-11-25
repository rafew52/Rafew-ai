import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { startActionLog, updateActionLog } from './actionLog.ts';
import { detectFacecamRegionWithGemini } from './gemini.ts';

const execFileAsync = promisify(execFile);

export interface PortraitLayoutPlan {
  isSplitScreen: boolean;
  filterGraph: string;
  framingMode: 'split_screen' | 'vertical_crop';
  summary: string;
}

async function probeDimensions(filePath: string): Promise<{ width: number; height: number } | null> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_streams', filePath],
      { timeout: 10_000 }
    );
    const parsed = JSON.parse(stdout || '{}') as {
      streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
    };
    const v = parsed.streams?.find((s) => s.codec_type === 'video');
    if (v?.width && v?.height) {
      return { width: v.width, height: v.height };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Builds clean 9:16 (1080x1920) vertical layout:
 * - When a streamer facecam box is detected in 16:9 / landscape footage:
 *   Top Half (1080x960): 100% full uncropped gameplay scaled proportionally to fit 1080 width
 *   and padded vertically to 1080x960 so zero horizontal gameplay is cut off.
 *   Bottom Half (1080x960): Cropped strictly to the detected facecam bounding box and filled cleanly.
 *   Stacked vertically via vstack=inputs=2 into 1080x1920.
 * - When NO facecam is present (or source is already vertical):
 *   Prominent full-bleed 9:16 vertical gameplay framing (1080x1920).
 */
export async function buildPortraitSplitScreenLayout(params: {
  videoPath: string;
  seekSeconds: number;
  cropBias?: 'center' | 'top' | 'bottom';
  contrast?: number;
  saturation?: number;
  tempDir?: string;
  sourceRef?: string;
}): Promise<PortraitLayoutPlan> {
  const contrast = Number((params.contrast ?? 1.04).toFixed(2));
  const saturation = Number((params.saturation ?? 1.06).toFixed(2));
  const cropYExpr =
    params.cropBias === 'top'
      ? '0'
      : params.cropBias === 'bottom'
      ? 'ih-1920'
      : '(ih-1920)/2';

  const prominentFullFilter =
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,` +
    `crop=1080:1920:(iw-1080)/2:${cropYExpr},` +
    `eq=contrast=${contrast}:saturation=${saturation},setsar=1,format=yuv420p[base]`;

  const dims = await probeDimensions(params.videoPath);
  if (!dims || dims.height >= dims.width) {
    return {
      isSplitScreen: false,
      framingMode: 'vertical_crop',
      filterGraph: prominentFullFilter,
      summary: 'Source is already vertical or unknown aspect; framed 1080x1920 gameplay.',
    };
  }

  const facecamActionId = startActionLog({
    category: 'gemini_sensor',
    actionName: 'Facecam Region Detection',
    sourceRef: params.sourceRef,
    summary: `Scanning ${dims.width}x${dims.height} frame for streamer facecam bounding box...`,
  });

  const probeDir = params.tempDir || path.dirname(params.videoPath);
  const framePath = path.join(
    probeDir,
    `fc_layout_probe_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.jpg`
  );

  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-ss',
        Math.max(0.2, params.seekSeconds).toFixed(2),
        '-i',
        params.videoPath,
        '-frames:v',
        '1',
        '-vf',
        'scale=960:-2',
        '-q:v',
        '4',
        framePath,
      ],
      { timeout: 10_000 }
    );

    if (fs.existsSync(framePath) && fs.statSync(framePath).size > 1000) {
      const frameBuf = fs.readFileSync(framePath);
      const facecam = await detectFacecamRegionWithGemini(frameBuf);
      if (facecam?.hasFacecam) {
        const cw = Math.max(64, Math.floor((dims.width * facecam.wPct) / 2) * 2);
        const ch = Math.max(64, Math.floor((dims.height * facecam.hPct) / 2) * 2);
        const cx = Math.max(
          0,
          Math.min(dims.width - cw, Math.floor((dims.width * facecam.xPct) / 2) * 2)
        );
        const cy = Math.max(
          0,
          Math.min(dims.height - ch, Math.floor((dims.height * facecam.yPct) / 2) * 2)
        );

        // Top Half (1080x960): 100% full uncropped 16:9 gameplay scaled proportionally to fit 1080 width & padded vertically.
        // Bottom Half (1080x960): Strictly cropped facecam bounding box scaled/cropped to fill 1080x960 cleanly.
        const splitFilter =
          `[0:v]split=2[gp_in][fc_in];` +
          `[gp_in]scale=1080:960:force_original_aspect_ratio=decrease,pad=1080:960:(ow-iw)/2:(oh-ih)/2:black,eq=contrast=${contrast}:saturation=${saturation},setsar=1,format=yuv420p[gameplay_top];` +
          `[fc_in]crop=${cw}:${ch}:${cx}:${cy},scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,drawbox=x=0:y=0:w=iw:h=4:color=white@0.28:t=fill,setsar=1,format=yuv420p[facecam_bot];` +
          `[gameplay_top][facecam_bot]vstack=inputs=2,setsar=1,format=yuv420p[base]`;

        updateActionLog(facecamActionId, {
          status: 'success',
          summary: `Detected facecam box (${cw}x${ch} at ${cx},${cy}) -> Top 1080x960 full uncropped gameplay + Bottom 1080x960 facecam.`,
          details: `Reason: ${facecam.reason}\nNormalized: x=${facecam.xPct.toFixed(3)}, y=${facecam.yPct.toFixed(3)}, w=${facecam.wPct.toFixed(3)}, h=${facecam.hPct.toFixed(3)}\nFilter: ${splitFilter}`,
        });

        return {
          isSplitScreen: true,
          framingMode: 'split_screen',
          filterGraph: splitFilter,
          summary: `9:16 Split-Screen: Top 1080x960 full uncropped gameplay + Bottom 1080x960 facecam (${facecam.reason}).`,
        };
      }

      updateActionLog(facecamActionId, {
        status: 'success',
        summary: `No picture-in-picture facecam detected (${facecam?.reason || 'pure gameplay'}); using full 9:16 gameplay framing.`,
      });
    } else {
      updateActionLog(facecamActionId, {
        status: 'success',
        summary: 'Probe frame unavailable; using full 9:16 gameplay framing.',
      });
    }
  } catch (err) {
    updateActionLog(facecamActionId, {
      status: 'success',
      summary: 'Facecam scan skipped; using full 9:16 gameplay framing.',
      details: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (fs.existsSync(framePath)) {
      try {
        fs.unlinkSync(framePath);
      } catch {}
    }
  }

  return {
    isSplitScreen: false,
    framingMode: 'vertical_crop',
    filterGraph: prominentFullFilter,
    summary: 'No facecam detected; framed gameplay prominently across full 9:16 canvas.',
  };
}
