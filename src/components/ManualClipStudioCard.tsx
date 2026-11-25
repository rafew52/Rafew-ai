import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Cpu,
  ExternalLink,
  Link as LinkIcon,
  Loader2,
  Plus,
  Send,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import type {
  ClaudeClipEditPlan,
  ClipSensorIssue,
  ClipSensorResult,
  ContentLanguageChoice,
  IdeaLanguagePreference,
  ManualClipGeneratedItem,
  ManualClipUploadStatus,
  SensorStatusLevel,
  ZernioConnectionSettings,
  ZernioPlatformPostResult,
  ZernioUploadMode,
} from '../types.ts';
import { ZernioButton } from './ZernioButton.tsx';
import { getPlatformBadgeMeta } from './ZernioConnectModal.tsx';
import { LiveActionsBox } from './LiveActionsBox.tsx';
import { notifyActionsUpdated, recordClientAction } from '../lib/actionLog.ts';

interface ManualClipStudioCardProps {
  zernio?: ZernioConnectionSettings;
  onOpenZernioConnect?: () => void;
  onRefreshSnapshot?: () => void;
}

interface ManualClipEntry {
  id: string;
  clipNumber: number;
  notes: string;
  startTime: string;
  endTime: string;
  momentSummary: string;
  title: string;
  description: string;
  hashtagsText: string;
  languageChoice?: ContentLanguageChoice;
  selectedForBatchUpload: boolean;
  uploadStatus: ManualClipUploadStatus;
  zernioPostId?: string;
  zernioPlatformResults?: ZernioPlatformPostResult[];
  claudeEditPlan?: ClaudeClipEditPlan;
  uploadError?: string;
  needsConfirmation?: boolean;
  isConfirmed?: boolean;
  sensorResult?: ClipSensorResult;
}

const STORAGE_KEY = 'clips_ai_manual_studio_v2';

function createEmptyEntry(clipNumber: number): ManualClipEntry {
  return {
    id: `mc_entry_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    clipNumber,
    notes: '',
    startTime: '',
    endTime: '',
    momentSummary: '',
    title: '',
    description: '',
    hashtagsText: '#BD',
    selectedForBatchUpload: true,
    uploadStatus: 'idle',
  };
}

export function parseTimestampToSeconds(raw: string): number {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return 0;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(0, parseFloat(trimmed));
  }
  const parts = trimmed.split(':').map((p) => parseFloat(p));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) {
    return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
  }
  if (parts.length === 2) {
    return Math.max(0, parts[0] * 60 + parts[1]);
  }
  return 0;
}

function formatDurationLabel(startStr: string, endStr: string): string {
  const startSec = parseTimestampToSeconds(startStr);
  const endSec = parseTimestampToSeconds(endStr);
  if (startStr.trim() && endStr.trim() && endSec <= startSec) {
    return '⚠️ End time must be greater than start time';
  }
  if (endSec <= startSec) return '';
  const diff = Math.round(endSec - startSec);
  if (diff < 60) return `Duration: ${diff}s`;
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  return s > 0 ? `Duration: ${m}m ${s}s` : `Duration: ${m}m`;
}

function normalizeHashtagList(raw: string): string[] {
  const tokens = raw
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t.startsWith('#') ? t : `#${t}`));
  const seen = new Set<string>(['#bd']);
  const out = ['#BD'];
  for (const tok of tokens) {
    const clean = tok.replace(/[^#\p{L}\p{M}\p{N}_]/gu, '');
    if (!clean || clean === '#' || clean.toLowerCase() === '#bd') continue;
    const lower = clean.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      out.push(clean);
    }
  }
  return out;
}

function extractActiveYouTubeId(rawUrl: string): string | null {
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
    const m = input.match(/(?:v=|youtu\.be\/|\/shorts\/|\/live\/|\/embed\/)([a-zA-Z0-9_-]{6,20})/);
    if (m?.[1]) return m[1];
  }
  return null;
}

function loadSavedWorkspace(): {
  sourceVideoUrl: string;
  entries: ManualClipEntry[];
} {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        sourceVideoUrl: '',
        entries: [createEmptyEntry(1), createEmptyEntry(2)],
      };
    }
    const parsed = JSON.parse(raw);
    const sourceVideoUrl =
      typeof parsed?.sourceVideoUrl === 'string' ? parsed.sourceVideoUrl : '';
    const activeVidId = extractActiveYouTubeId(sourceVideoUrl);
    const rawEntries = Array.isArray(parsed?.entries)
      ? parsed.entries
      : Array.isArray(parsed)
      ? parsed
      : [createEmptyEntry(1), createEmptyEntry(2)];

    const entries = rawEntries.map((item: any, idx: number) => {
      const startTime = typeof item.startTime === 'string' ? item.startTime : '';
      const endTime = typeof item.endTime === 'string' ? item.endTime : '';
      const title = typeof item.title === 'string' ? item.title : '';
      const hasLinkRange = Boolean(sourceVideoUrl.trim() && startTime.trim() && endTime.trim());
      const startSec = parseTimestampToSeconds(startTime);
      const endSec = parseTimestampToSeconds(endTime);
      const isConfirmed = Boolean(item.isConfirmed);
      const needsConfirmation = Boolean(item.needsConfirmation);
      const rawError = typeof item.uploadError === 'string' ? item.uploadError.trim() : '';

      const errVidMatch = rawError.match(/(?:Could not play|\[)([a-zA-Z0-9_-]{11})(?:\]|:|\s)/);
      const errorFromDifferentVideo = Boolean(
        errVidMatch?.[1] && activeVidId && errVidMatch[1] !== activeVidId
      );

      const isStaleError =
        item.uploadStatus === 'error' &&
        (!rawError ||
          errorFromDifferentVideo ||
          /could not prepare player|real youtube extraction failed|youtube extraction|attach a rendered 9:16|shorts gallery/i.test(
            rawError
          ) ||
          ((isConfirmed || !needsConfirmation) && /review and confirm/i.test(rawError)) ||
          (hasLinkRange &&
            endSec > startSec &&
            Boolean(title.trim()) &&
            /source video url and start time|title first before publishing|end time must be strictly/i.test(
              rawError
            )));

      const fallbackReady: ManualClipUploadStatus =
        title.trim() && hasLinkRange ? 'ready' : 'idle';

      const uploadStatus: ManualClipUploadStatus =
        item.uploadStatus === 'uploading' || isStaleError
          ? fallbackReady
          : item.uploadStatus || fallbackReady;

      return {
        id: typeof item.id === 'string' ? item.id : `mc_entry_${idx + 1}`,
        clipNumber: idx + 1,
        notes: typeof item.notes === 'string' ? item.notes : '',
        startTime,
        endTime,
        momentSummary: typeof item.momentSummary === 'string' ? item.momentSummary : '',
        title,
        description: typeof item.description === 'string' ? item.description : '',
        hashtagsText: typeof item.hashtagsText === 'string' ? item.hashtagsText : '#BD',
        languageChoice: item.languageChoice,
        selectedForBatchUpload: item.selectedForBatchUpload !== false,
        uploadStatus,
        zernioPostId: item.zernioPostId,
        zernioPlatformResults: item.zernioPlatformResults,
        claudeEditPlan: item.claudeEditPlan,
        uploadError: isStaleError || uploadStatus !== 'error' ? undefined : rawError,
        needsConfirmation,
        isConfirmed,
      };
    });

    return { sourceVideoUrl, entries };
  } catch {
    return {
      sourceVideoUrl: '',
      entries: [createEmptyEntry(1), createEmptyEntry(2)],
    };
  }
}

function getClearedUploadStatus(
  entry: Pick<ManualClipEntry, 'startTime' | 'endTime' | 'title' | 'uploadStatus'>,
  sourceUrl: string
): ManualClipUploadStatus {
  if (entry.uploadStatus === 'uploaded') return 'uploaded';
  const hasLinkRange = Boolean(
    sourceUrl.trim() && entry.startTime.trim() && entry.endTime.trim()
  );
  return entry.title.trim() && hasLinkRange ? 'ready' : 'idle';
}

function getEffectiveUploadStatus(
  entry: ManualClipEntry,
  sourceUrl: string
): ManualClipUploadStatus {
  if (entry.uploadStatus === 'uploading') return 'uploading';
  if (entry.uploadStatus === 'uploaded') return 'uploaded';
  if (entry.uploadStatus === 'error') {
    if (
      (entry.isConfirmed || !entry.needsConfirmation) &&
      entry.uploadError &&
      /review and confirm/i.test(entry.uploadError)
    ) {
      return getClearedUploadStatus(entry, sourceUrl);
    }
    return 'error';
  }
  const hasLinkRange = Boolean(
    sourceUrl.trim() && entry.startTime.trim() && entry.endTime.trim()
  );
  if (entry.title.trim() && hasLinkRange) return 'ready';
  return 'idle';
}

function computeEffectiveSensorState(
  entry: ManualClipEntry,
  allEntries: ManualClipEntry[],
  sourceUrl: string
): {
  status: SensorStatusLevel;
  issues: ClipSensorIssue[];
  audited: boolean;
} {
  const issues: ClipSensorIssue[] = [];
  const startRaw = entry.startTime.trim();
  const endRaw = entry.endTime.trim();
  const startSec = parseTimestampToSeconds(startRaw);
  const endSec = parseTimestampToSeconds(endRaw);
  const trimmedUrl = sourceUrl.trim();

  if (!trimmedUrl) {
    issues.push({
      layer: 'timeline',
      severity: 'block',
      code: 'MISSING_SOURCE_URL',
      message: 'Paste a Source Video URL / Link above for link-only clipping and Zernio publishing.',
    });
  } else {
    try {
      const u = new URL(trimmedUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        issues.push({
          layer: 'timeline',
          severity: 'block',
          code: 'INVALID_SOURCE_URL',
          message: 'Source Video URL must begin with https:// or http://.',
        });
      }
    } catch {
      issues.push({
        layer: 'timeline',
        severity: 'block',
        code: 'INVALID_SOURCE_URL',
        message: 'Source Video URL format is invalid. Enter a full https:// link.',
      });
    }
  }

  if (!startRaw || !endRaw) {
    issues.push({
      layer: 'timeline',
      severity: 'block',
      code: 'MISSING_TIME_RANGE',
      message: 'Start Time & End Time are required to extract this clip from the Source Video URL.',
    });
  }

  if (startRaw && endRaw) {
    if (endSec <= startSec) {
      issues.push({
        layer: 'timeline',
        severity: 'block',
        code: 'INVALID_TIME_RANGE',
        message: `End Time (${endRaw}) must be strictly greater than Start Time (${startRaw}).`,
      });
    } else {
      for (const other of allEntries) {
        if (other.id === entry.id) continue;
        const oStart = other.startTime.trim();
        const oEnd = other.endTime.trim();
        if (!oStart || !oEnd) continue;
        const oS = parseTimestampToSeconds(oStart);
        const oE = parseTimestampToSeconds(oEnd);
        if (oE <= oS) continue;
        if (Math.abs(startSec - oS) < 0.5 && Math.abs(endSec - oE) < 0.5) {
          issues.push({
            layer: 'timeline',
            severity: 'block',
            code: 'DUPLICATE_TIMELINE',
            message: `Identical timeline [${startRaw} – ${endRaw}] shared with Clip #${other.clipNumber}.`,
          });
          break;
        }
      }
    }
  }

  const title = entry.title.trim();
  const combinedMeta = `${title}\n${entry.description}\n${entry.hashtagsText}`;
  if (title) {
    if (title.length > 80) {
      issues.push({
        layer: 'metadata',
        severity: 'warning',
        code: 'TITLE_TOO_LONG',
        message: `Title exceeds 80 chars (${title.length}/80).`,
      });
    }
    if (/[▯□\uFFFD]/.test(combinedMeta)) {
      issues.push({
        layer: 'metadata',
        severity: 'block',
        code: 'BROKEN_GLYPHS',
        message: 'Broken box glyph characters (▯/□) detected in metadata.',
      });
    }
    if (
      /\b(?:gta\s*6?\s*clutch\s*(?:action\s+)?moment|clutch\s+(?:action\s+)?moment|hashtag\s+(?:zero|one|two|three))\b/i.test(
        combinedMeta
      ) ||
      /(?:^|\s)#(?:0|1|2|3|zero|one|two)\b/i.test(`${entry.hashtagsText} ${entry.description}`)
    ) {
      issues.push({
        layer: 'metadata',
        severity: 'block',
        code: 'DUMMY_OR_NUMBERED_TAGS',
        message: 'Dummy phrase or numbered tag (#0/#1/#2/Clutch Moment) detected.',
      });
    }
    if (!/#bd\b/i.test(`${entry.hashtagsText} ${entry.description}`)) {
      issues.push({
        layer: 'metadata',
        severity: 'warning',
        code: 'MISSING_BD_TAG',
        message: 'Mandatory #BD hashtag is missing.',
      });
    }
    const normTitle = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    for (const other of allEntries) {
      if (other.id === entry.id || !other.title.trim()) continue;
      const otherNorm = other.title
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
      if (normTitle && otherNorm && normTitle === otherNorm) {
        issues.push({
          layer: 'metadata',
          severity: 'block',
          code: 'DUPLICATE_TITLE',
          message: `Duplicate title shared with Clip #${other.clipNumber}.`,
        });
        break;
      }
    }
  }

  // Merge server Sensor Audit results (Gemini Flash + FFmpeg Visual Sensor)
  if (entry.sensorResult) {
    for (const srvIssue of entry.sensorResult.issues) {
      if (
        !issues.some(
          (i) => i.code === srvIssue.code && i.message.toLowerCase() === srvIssue.message.toLowerCase()
        )
      ) {
        issues.push(srvIssue);
      }
    }
  }

  const hasBlock = issues.some((i) => i.severity === 'block');
  const hasWarn = issues.some((i) => i.severity === 'warning');
  const status: SensorStatusLevel = hasBlock ? 'blocked' : hasWarn ? 'warning' : 'passed';
  return {
    status,
    issues,
    audited: Boolean(entry.sensorResult),
  };
}

export function ManualClipStudioCard({
  zernio,
  onOpenZernioConnect,
  onRefreshSnapshot,
}: ManualClipStudioCardProps) {
  const initial = loadSavedWorkspace();
  const [sourceVideoUrl, setSourceVideoUrl] = useState(initial.sourceVideoUrl);
  const [entries, setEntries] = useState<ManualClipEntry[]>(initial.entries);

  const [languagePreference, setLanguagePreference] =
    useState<IdeaLanguagePreference>('banglish');
  const [nicheHint, setNicheHint] = useState('');
  const [uploadMode, setUploadMode] = useState<ZernioUploadMode>(
    zernio?.uploadMode || 'publish_now'
  );
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>(
    () => zernio?.selectedAccountIds || []
  );

  const [generatingAll, setGeneratingAll] = useState(false);
  const [generatingRowId, setGeneratingRowId] = useState<string | null>(null);
  const [auditingSensors, setAuditingSensors] = useState(false);
  const [uploadingBatch, setUploadingBatch] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [claudeStatusNote, setClaudeStatusNote] = useState<string | null>(null);
  const [pipelineStatus, setPipelineStatus] = useState<{
    claudeConfigured: boolean;
    geminiConfigured: boolean;
  }>({
    claudeConfigured: true,
    geminiConfigured: true,
  });
  const [aiDetectOpen, setAiDetectOpen] = useState(false);
  const [pastedBreakdownText, setPastedBreakdownText] = useState('');
  const [detectingAi, setDetectingAi] = useState(false);
  const [aiDetectSummary, setAiDetectSummary] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    fetch('/api/manual-clips/status', { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          setPipelineStatus({
            claudeConfigured: Boolean(data.claudeConfigured),
            geminiConfigured: Boolean(data.geminiConfigured),
          });
        }
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return;
        void recordClientAction({
          category: 'claude_edit',
          actionName: 'Pipeline Status Check',
          sourceRef: '/api/manual-clips/status',
          status: 'error',
          summary: `Background engine status check failed (${err instanceof Error ? err.message : 'network error'}); workspace defaults remain active.`,
        });
      })
      .finally(() => clearTimeout(timeoutId));
    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, []);

  const runSensorAudit = async (
    targetEntries?: ManualClipEntry[],
    sourceUrlOverride?: string
  ): Promise<ClipSensorResult[]> => {
    const list = targetEntries || entries;
    if (list.length === 0) return [];
    setAuditingSensors(true);
    try {
      const effectiveUrl = (sourceUrlOverride ?? sourceVideoUrl).trim();
      const res = await fetch('/api/manual-clips/sensor-audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceVideoUrl: effectiveUrl || undefined,
          nicheHint: nicheHint.trim() || undefined,
          languagePreference,
          enableVisualAudit: true,
          clips: list.map((e) => ({
            id: e.id,
            clipNumber: e.clipNumber,
            notes: e.notes,
            startTime: e.startTime.trim() || undefined,
            endTime: e.endTime.trim() || undefined,
            title: e.title,
            description: e.description,
            hashtags: normalizeHashtagList(e.hashtagsText),
            sourceVideoUrl: effectiveUrl || undefined,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Sensor audit failed.');
      }
      const results = (data.results || []) as ClipSensorResult[];
      const mapById = new Map(results.map((r) => [r.clipId, r]));
      setEntries((prev) =>
        prev.map((entry) => {
          const r = mapById.get(entry.id);
          if (!r) return entry;
          const shouldClearSensorError =
            r.status !== 'blocked' &&
            entry.uploadStatus === 'error' &&
            (!entry.uploadError || /sensor|blocked/i.test(entry.uploadError));
          return {
            ...entry,
            sensorResult: r,
            ...(shouldClearSensorError
              ? {
                  uploadStatus: getClearedUploadStatus(entry, effectiveUrl),
                  uploadError: undefined,
                }
              : {}),
          };
        })
      );
      return results;
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Sensor audit failed.');
      return [];
    } finally {
      setAuditingSensors(false);
      notifyActionsUpdated();
    }
  };

  const handleApplySensorFix = (entryId: string) => {
    setEntries((prev) =>
      prev.map((entry) => {
        if (entry.id !== entryId || !entry.sensorResult?.autoFixedFields) return entry;
        const fix = entry.sensorResult.autoFixedFields;
        const nextEntryBase: ManualClipEntry = {
          ...entry,
          ...(fix.title ? { title: fix.title } : {}),
          ...(fix.description ? { description: fix.description } : {}),
          ...(fix.hashtags && fix.hashtags.length > 0
            ? { hashtagsText: fix.hashtags.join(' ') }
            : {}),
        };
        const updated: ManualClipEntry = {
          ...nextEntryBase,
          ...(entry.uploadStatus === 'error'
            ? {
                uploadStatus: getClearedUploadStatus(nextEntryBase, sourceVideoUrl),
                uploadError: undefined,
              }
            : {}),
          sensorResult: {
            ...entry.sensorResult,
            issues: entry.sensorResult.issues.filter((i) => i.layer !== 'metadata'),
            autoFixedFields: undefined,
            status: entry.sensorResult.issues.some(
              (i) => i.layer !== 'metadata' && i.severity === 'block'
            )
              ? 'blocked'
              : entry.sensorResult.issues.some((i) => i.layer !== 'metadata')
              ? 'warning'
              : 'passed',
          },
        };
        return updated;
      })
    );
  };

  const handleAiDetectAndFill = async () => {
    setGlobalError(null);
    if (!pastedBreakdownText.trim()) {
      setGlobalError('Paste your raw clip breakdown, notes, or transcript first.');
      return;
    }
    setDetectingAi(true);
    try {
      const res = await fetch('/api/manual-clips/ai-detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pastedText: pastedBreakdownText.trim(),
          sourceVideoUrl: sourceVideoUrl.trim() || undefined,
          languagePreference,
          nicheHint: nicheHint.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'AI detect failed.');
      }
      const generatedList = (data.clips || []) as ManualClipGeneratedItem[];
      if (generatedList.length === 0) {
        throw new Error('No clips could be parsed from the pasted text.');
      }

      const detectedSourceUrl =
        generatedList.find((g) => typeof g.sourceVideoUrl === 'string' && g.sourceVideoUrl.trim())
          ?.sourceVideoUrl?.trim() || sourceVideoUrl.trim();

      if (detectedSourceUrl && detectedSourceUrl !== sourceVideoUrl.trim()) {
        setSourceVideoUrl(detectedSourceUrl);
      }

      const newEntries: ManualClipEntry[] = generatedList.map((g, idx) => ({
        id: g.id || `mc_ai_${Date.now()}_${idx + 1}`,
        clipNumber: idx + 1,
        notes: g.notes || g.momentSummary || `Clip #${idx + 1} scene details`,
        startTime: g.startTime || '00:00',
        endTime: g.endTime || '00:30',
        momentSummary: g.momentSummary || g.title,
        title: g.title,
        description: g.description,
        hashtagsText: Array.isArray(g.hashtags) ? g.hashtags.join(' ') : '#BD',
        languageChoice: g.languageChoice,
        selectedForBatchUpload: true,
        uploadStatus: detectedSourceUrl ? 'ready' : 'idle',
        uploadError: undefined,
        sensorResult: undefined,
        needsConfirmation: true,
        isConfirmed: false,
      }));

      setEntries(newEntries);
      setAiDetectSummary(
        `Detected ${newEntries.length} clips${
          extractActiveYouTubeId(detectedSourceUrl)
            ? ` bound to Video ID ${extractActiveYouTubeId(detectedSourceUrl)}`
            : ''
        } with distinct timelines & unique titles! Sensor Guard is verifying timelines & metadata...`
      );
      setAiDetectOpen(false);
      setPastedBreakdownText('');
      void runSensorAudit(newEntries, detectedSourceUrl);
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'AI detect failed.');
    } finally {
      setDetectingAi(false);
      notifyActionsUpdated();
    }
  };

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ sourceVideoUrl, entries })
      );
    } catch {
      // Ignore quota errors
    }
  }, [sourceVideoUrl, entries]);

  useEffect(() => {
    if (zernio?.accounts && zernio.accounts.length > 0 && selectedAccountIds.length === 0) {
      setSelectedAccountIds(
        zernio.selectedAccountIds.length > 0
          ? zernio.selectedAccountIds
          : zernio.accounts.filter((a) => a.isActive).map((a) => a.id)
      );
    }
  }, [zernio?.accounts, zernio?.selectedAccountIds, selectedAccountIds.length]);

  const activeZernioAccounts = useMemo(
    () => (zernio?.accounts || []).filter((a) => a.isActive),
    [zernio?.accounts]
  );

  const updateEntry = (
    id: string,
    updater: (prev: ManualClipEntry) => ManualClipEntry
  ) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? updater(e) : e)));
  };

  const handleAddClip = () => {
    setEntries((prev) => [...prev, createEmptyEntry(prev.length + 1)]);
  };

  const handleRemoveClip = (id: string) => {
    setEntries((prev) => {
      if (prev.length <= 1) return prev;
      return prev
        .filter((e) => e.id !== id)
        .map((e, idx) => ({ ...e, clipNumber: idx + 1 }));
    });
  };

  const handleCopy = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  };

  const handleCopyTitleAndDescription = async (entry: ManualClipEntry) => {
    const tags = normalizeHashtagList(entry.hashtagsText).join(' ');
    const cleanDesc = entry.description.trim();
    const descHasBd = /#bd\b/i.test(cleanDesc);
    const timeSpan =
      entry.startTime || entry.endTime
        ? `[Time Range: ${entry.startTime || '0'}s — ${entry.endTime || 'End'}]`
        : '';
    const srcRef = sourceVideoUrl.trim() ? `Source Video: ${sourceVideoUrl.trim()}` : '';

    const fullCopy = [
      srcRef,
      timeSpan,
      `Title: ${entry.title.trim()}`,
      '',
      descHasBd ? cleanDesc : [cleanDesc, tags].filter(Boolean).join('\n\n'),
    ]
      .filter((line, idx) => (idx === 0 || idx === 1 ? Boolean(line) : true))
      .filter(Boolean)
      .join('\n');

    await handleCopy(`full_${entry.id}`, fullCopy);
  };

  const handleGenerateMetadata = async (singleEntry?: ManualClipEntry) => {
    setGlobalError(null);
    const targets = singleEntry
      ? [singleEntry]
      : entries.filter((e) => e.notes.trim().length > 0);

    if (targets.length === 0) {
      setGlobalError(
        'Write notes or scene details in at least one clip box before generating metadata.'
      );
      return;
    }

    if (singleEntry && !singleEntry.notes.trim()) {
      setGlobalError(`Enter notes for Clip #${singleEntry.clipNumber} first.`);
      return;
    }

    if (singleEntry) {
      setGeneratingRowId(singleEntry.id);
    } else {
      setGeneratingAll(true);
    }

    try {
      const otherTitles = singleEntry
        ? entries
            .filter((e) => e.id !== singleEntry.id && e.title.trim())
            .map((e) => e.title.trim())
        : [];

      const res = await fetch('/api/manual-clips/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceVideoUrl: sourceVideoUrl.trim() || undefined,
          clips: targets.map((t) => ({
            id: t.id,
            clipNumber: t.clipNumber,
            notes: t.notes,
            startTime: t.startTime.trim() || undefined,
            endTime: t.endTime.trim() || undefined,
          })),
          languagePreference,
          nicheHint: nicheHint.trim() || undefined,
          existingTitles: otherTitles,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to generate clip metadata.');
      }

      const generatedList = (data.clips || []) as ManualClipGeneratedItem[];
      const mapById = new Map(generatedList.map((g) => [g.id, g]));
      const firstDiag = generatedList.find((g) => g.claudeDiagnostic)?.claudeDiagnostic;
      setClaudeStatusNote(firstDiag || null);

      const updatedEntries = entries.map((entry) => {
        const gen = mapById.get(entry.id);
        if (!gen) return entry;
        return {
          ...entry,
          momentSummary: gen.momentSummary,
          title: gen.title,
          description: gen.description,
          hashtagsText: gen.hashtags.join(' '),
          languageChoice: gen.languageChoice,
          uploadStatus: (sourceVideoUrl.trim() && entry.startTime.trim() && entry.endTime.trim()
            ? 'ready'
            : 'idle') as ManualClipUploadStatus,
          uploadError: undefined,
          sensorResult: undefined,
        };
      });

      setEntries(updatedEntries);
      void runSensorAudit(updatedEntries);
    } catch (err) {
      setGlobalError(
        err instanceof Error ? err.message : 'Unable to generate metadata.'
      );
    } finally {
      setGeneratingAll(false);
      setGeneratingRowId(null);
      notifyActionsUpdated();
    }
  };

  const handlePublishSingleToZernio = async (entry: ManualClipEntry) => {
    setGlobalError(null);
    if (!zernio?.connected) {
      onOpenZernioConnect?.();
      return;
    }

    const sensorState = computeEffectiveSensorState(entry, entries, sourceVideoUrl);
    if (sensorState.status === 'blocked') {
      const firstBlock =
        sensorState.issues.find((i) => i.severity === 'block')?.message ||
        'Blocked by Sensor Guard.';
      updateEntry(entry.id, (prev) => ({
        ...prev,
        uploadStatus: 'error',
        uploadError: `Sensor Blocked: ${firstBlock}`,
      }));
      return;
    }

    const hasValidLinkAndRange = Boolean(
      sourceVideoUrl.trim() && entry.startTime.trim() && entry.endTime.trim()
    );

    if (!hasValidLinkAndRange) {
      updateEntry(entry.id, (prev) => ({
        ...prev,
        uploadStatus: 'error',
        uploadError:
          'Provide a Source Video URL and Start Time / End Time for this clip before publishing.',
      }));
      return;
    }

    if (!entry.title.trim()) {
      updateEntry(entry.id, (prev) => ({
        ...prev,
        uploadStatus: 'error',
        uploadError: 'Generate or enter a Title first before publishing.',
      }));
      return;
    }

    if (entry.needsConfirmation && !entry.isConfirmed) {
      updateEntry(entry.id, (prev) => ({
        ...prev,
        uploadStatus: 'error',
        uploadError: `Please review and confirm Clip #${entry.clipNumber} before publishing.`,
      }));
      return;
    }

    const s = parseTimestampToSeconds(entry.startTime);
    const e = parseTimestampToSeconds(entry.endTime);
    if (e <= s) {
      updateEntry(entry.id, (prev) => ({
        ...prev,
        uploadStatus: 'error',
        uploadError: 'End Time must be strictly greater than Start Time.',
      }));
      return;
    }

    updateEntry(entry.id, (prev) => ({
      ...prev,
      uploadStatus: 'uploading',
      uploadError: undefined,
    }));

    try {
      const hashtags = normalizeHashtagList(entry.hashtagsText);
      const res = await fetch('/api/manual-clips/publish-zernio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clipNumber: entry.clipNumber,
          title: entry.title.trim(),
          description: entry.description.trim(),
          hashtags,
          notes: entry.notes.trim() || undefined,
          sourceVideoUrl: sourceVideoUrl.trim(),
          startTime: entry.startTime.trim(),
          endTime: entry.endTime.trim(),
          nicheHint: nicheHint.trim() || undefined,
          languageChoice:
            entry.languageChoice ||
            (languagePreference === 'auto' || languagePreference === 'any'
              ? undefined
              : languagePreference),
          accountIds: selectedAccountIds.length > 0 ? selectedAccountIds : undefined,
          uploadMode,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Zernio upload failed.');
      }

      updateEntry(entry.id, (prev) => ({
        ...prev,
        uploadStatus: 'uploaded',
        zernioPostId: data.postId,
        zernioPlatformResults: Array.isArray(data.platformResults)
          ? data.platformResults
          : undefined,
        claudeEditPlan: data.claudeEditPlan,
        uploadError: undefined,
      }));
      onRefreshSnapshot?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Zernio upload failed.';
      updateEntry(entry.id, (prev) => ({
        ...prev,
        uploadStatus: 'error',
        uploadError: message,
      }));
    } finally {
      notifyActionsUpdated();
    }
  };

  const handleBatchUploadToZernio = async () => {
    setGlobalError(null);
    if (!zernio?.connected) {
      onOpenZernioConnect?.();
      return;
    }

    const candidates = entries.filter(
      (e) =>
        e.selectedForBatchUpload &&
        e.uploadStatus !== 'uploaded' &&
        Boolean(sourceVideoUrl.trim() && e.startTime.trim() && e.endTime.trim()) &&
        Boolean(e.title.trim())
    );

    if (candidates.length === 0) {
      setGlobalError(
        'Enter a Source Video URL plus Start/End Time and a Title on at least one selected clip before publishing.'
      );
      return;
    }

    const unconfirmed = candidates.filter((e) => e.needsConfirmation && !e.isConfirmed);
    if (unconfirmed.length > 0) {
      setGlobalError(
        `Clip #${unconfirmed[0].clipNumber} has not been confirmed yet. Please review and confirm all clips (or click "Confirm All Clips") before batch publishing.`
      );
      return;
    }

    // Pre-Publish Sensor Guard check across all selected candidates
    const blockedCandidate = candidates.find(
      (e) => computeEffectiveSensorState(e, entries, sourceVideoUrl).status === 'blocked'
    );
    if (blockedCandidate) {
      const state = computeEffectiveSensorState(blockedCandidate, entries, sourceVideoUrl);
      const reason =
        state.issues.find((i) => i.severity === 'block')?.message || 'Critical sensor block.';
      setGlobalError(
        `Sensor Guard blocked batch upload on Clip #${blockedCandidate.clipNumber}: ${reason}`
      );
      return;
    }

    setUploadingBatch(true);
    try {
      for (const item of candidates) {
        await handlePublishSingleToZernio(item);
      }
    } finally {
      setUploadingBatch(false);
    }
  };

  const readyToUploadCount = entries.filter(
    (e) =>
      e.selectedForBatchUpload &&
      e.uploadStatus !== 'uploaded' &&
      Boolean(sourceVideoUrl.trim() && e.startTime.trim() && e.endTime.trim()) &&
      Boolean(e.title.trim()) &&
      (!e.needsConfirmation || e.isConfirmed) &&
      computeEffectiveSensorState(e, entries, sourceVideoUrl).status !== 'blocked'
  ).length;

  const notesFilledCount = entries.filter((e) => e.notes.trim().length > 0).length;

  return (
    <div className="space-y-6">
      {/* Studio Control Header */}
      <section className="rounded-2xl border border-slate-800/90 bg-[#11151F] p-5 sm:p-6 space-y-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="font-display text-lg font-bold tracking-tight text-slate-50 sm:text-xl">
              Manual Clip Info to Metadata &amp; Zernio Upload
            </h1>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-400">
              Paste a source video URL, add exact start/end time ranges and scene notes for Clip 1,
              Clip 2, Clip 3… and automatically generate scene-matched Titles, Descriptions, and
              #BD Hashtags.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={auditingSensors || entries.length === 0}
              onClick={() => void runSensorAudit()}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-emerald-700/60 bg-emerald-950/30 px-4 text-xs font-semibold text-emerald-200 hover:bg-emerald-900/40 disabled:opacity-50 whitespace-nowrap"
            >
              {auditingSensors ? (
                <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
              ) : (
                <ShieldCheck className="h-4 w-4 text-emerald-400" />
              )}
              <span>{auditingSensors ? 'Inspecting Clips...' : 'Run Sensor Guard'}</span>
            </button>

            <button
              type="button"
              onClick={() => setAiDetectOpen(true)}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-indigo-700/60 bg-indigo-950/40 px-4 text-xs font-semibold text-indigo-200 hover:bg-indigo-900/50 whitespace-nowrap"
            >
              <Sparkles className="h-4 w-4 text-indigo-400" />
              <span>AI Detect &amp; Auto-Fill</span>
            </button>

            <button
              type="button"
              onClick={handleAddClip}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 text-xs font-semibold text-slate-100 hover:bg-slate-800 whitespace-nowrap"
            >
              <Plus className="h-4 w-4 text-orange-400" />
              <span>Add Clip</span>
            </button>

            <button
              type="button"
              disabled={generatingAll || notesFilledCount === 0}
              onClick={() => void handleGenerateMetadata()}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-orange-600 px-4 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-50 whitespace-nowrap"
            >
              {generatingAll ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              <span className="tabular-nums">
                {generatingAll
                  ? 'Generating Unique Copy...'
                  : `Generate All (${notesFilledCount})`}
              </span>
            </button>
          </div>
        </div>

        {/* Workspace-Level Source Video URL / Link Input + Engine & BGM Pipeline */}
        <div className="rounded-xl border border-slate-800 bg-[#090B10] p-4 space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <LinkIcon className="h-4 w-4 text-orange-400 shrink-0" />
              <label
                htmlFor="source-video-url-input"
                className="text-xs font-semibold text-slate-200"
              >
                Source Video URL / Link (Link-Only Clipping Engine)
              </label>
            </div>
            {sourceVideoUrl.trim() && (
              <div className="flex flex-wrap items-center gap-2">
                {extractActiveYouTubeId(sourceVideoUrl) && (
                  <span className="inline-flex items-center rounded-md border border-indigo-700/60 bg-indigo-950/50 px-2 py-0.5 font-mono text-[11px] font-medium text-indigo-200">
                    Video ID: {extractActiveYouTubeId(sourceVideoUrl)}
                  </span>
                )}
                <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-800/60 bg-emerald-950/40 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
                  <CheckCircle2 className="h-3 w-3 shrink-0" />
                  <span>Active Source Link Ready</span>
                </span>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2.5 sm:flex-row">
            <input
              id="source-video-url-input"
              type="url"
              value={sourceVideoUrl}
              onChange={(e) => {
                const nextUrl = e.target.value;
                setSourceVideoUrl(nextUrl);
                setGlobalError(null);
                setEntries((prev) =>
                  prev.map((item) => ({
                    ...item,
                    uploadStatus:
                      item.uploadStatus === 'error'
                        ? getClearedUploadStatus(item, nextUrl)
                        : item.uploadStatus,
                    uploadError: undefined,
                    sensorResult: undefined,
                  }))
                );
              }}
              onBlur={() => {
                const trimmed = sourceVideoUrl.trim();
                if (trimmed) {
                  const vidId = extractActiveYouTubeId(trimmed);
                  void recordClientAction({
                    category: 'source_url',
                    actionName: 'Source Video URL Set',
                    sourceRef: vidId || trimmed.slice(0, 48),
                    status: 'success',
                    summary: vidId
                      ? `Bound workspace to YouTube Video ID ${vidId}.`
                      : 'Bound workspace to active Source Video URL.',
                    details: trimmed,
                  });
                }
              }}
              placeholder="https://www.youtube.com/watch?v=... or stream URL"
              className="min-h-[44px] w-full flex-1 rounded-xl border border-slate-800 bg-[#11151F] px-3.5 text-xs text-slate-100 placeholder:text-slate-600 focus:border-orange-500 focus:outline-none"
            />
            {sourceVideoUrl.trim() && (
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    const oldUrl = sourceVideoUrl.trim();
                    setSourceVideoUrl('');
                    setGlobalError(null);
                    setEntries((prev) =>
                      prev.map((item) => ({
                        ...item,
                        uploadStatus:
                          item.uploadStatus === 'error'
                            ? getClearedUploadStatus(item, '')
                            : item.uploadStatus,
                        uploadError: undefined,
                        sensorResult: undefined,
                      }))
                    );
                    void recordClientAction({
                      category: 'source_url',
                      actionName: 'Source Video URL Cleared',
                      sourceRef: extractActiveYouTubeId(oldUrl) || undefined,
                      status: 'success',
                      summary: 'Cleared Source Video URL and reset clip extraction errors.',
                      details: oldUrl ? `Previous URL: ${oldUrl}` : undefined,
                    });
                  }}
                  title="Clear old Source Video URL"
                  className="inline-flex min-h-[44px] items-center justify-center gap-1 rounded-xl border border-slate-700 bg-slate-900 px-3 text-xs font-medium text-slate-300 hover:bg-slate-800 hover:text-slate-100 whitespace-nowrap"
                >
                  <X className="h-3.5 w-3.5" />
                  <span>Clear</span>
                </button>
                <a
                  href={sourceVideoUrl.trim()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900 px-4 text-xs font-medium text-slate-200 hover:bg-slate-800 whitespace-nowrap"
                >
                  <span>Open Source</span>
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-slate-800/70 pt-2.5 text-[11px] text-slate-400">
            <span className="inline-flex items-center gap-1.5 text-slate-300">
              <Cpu className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
              <span>
                Claude Editing Engine:{' '}
                <strong className={pipelineStatus.claudeConfigured ? 'text-emerald-300' : 'text-amber-300'}>
                  {pipelineStatus.claudeConfigured ? 'Active' : 'Fallback Ready'}
                </strong>
              </span>
            </span>
            <span className="inline-flex items-center gap-1.5 text-slate-300">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
              <span>Gemini Flash Fast Sensor: Active</span>
            </span>
            <span className="text-slate-400">
              Clean Source Audio Preserved (Website music plays in top bar only)
            </span>
          </div>

          {claudeStatusNote && (
            <div className="rounded-lg border border-amber-800/50 bg-amber-950/30 px-3 py-1.5 text-[11px] text-amber-200">
              {claudeStatusNote}
            </div>
          )}
        </div>

        {/* Language, Topic & Zernio Target Strip */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div>
            <label
              htmlFor="manual-lang"
              className="block text-[11px] font-medium text-slate-400"
            >
              Metadata Language
            </label>
            <select
              id="manual-lang"
              value={languagePreference}
              onChange={(e) =>
                setLanguagePreference(e.target.value as IdeaLanguagePreference)
              }
              className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-800 bg-[#090B10] px-3 text-xs text-slate-100 focus:border-orange-500 focus:outline-none"
            >
              <option value="banglish">Banglish (Natural Creator Mix)</option>
              <option value="bengali">বাংলা (Bangla Unicode)</option>
              <option value="english">English</option>
              <option value="auto">Auto (Match Clip Notes)</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="manual-niche"
              className="block text-[11px] font-medium text-slate-400"
            >
              Optional Game / Niche Hint
            </label>
            <input
              id="manual-niche"
              type="text"
              value={nicheHint}
              onChange={(e) => setNicheHint(e.target.value)}
              placeholder="e.g., GTA 6, Free Fire, Funny Stream..."
              className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-800 bg-[#090B10] px-3 text-xs text-slate-100 placeholder:text-slate-600 focus:border-orange-500 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="manual-zernio-mode"
              className="block text-[11px] font-medium text-slate-400"
            >
              Zernio Upload Mode
            </label>
            <select
              id="manual-zernio-mode"
              value={uploadMode}
              onChange={(e) => setUploadMode(e.target.value as ZernioUploadMode)}
              className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-800 bg-[#090B10] px-3 text-xs text-slate-100 focus:border-orange-500 focus:outline-none"
            >
              <option value="publish_now">Publish Now (Selected Channels)</option>
              <option value="draft">Save as Draft in Zernio</option>
            </select>
          </div>
        </div>

        {/* Connected Zernio Account Selector & Batch Upload Bar */}
        <div className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-[#090B10] p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1.5 min-w-0">
            {zernio?.connected ? (
              <>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span className="font-semibold text-emerald-400">
                    Zernio Connected
                  </span>
                  <span className="text-slate-500" aria-hidden="true">
                    ·
                  </span>
                  <span className="text-slate-400 tabular-nums">
                    {activeZernioAccounts.length} active account
                    {activeZernioAccounts.length === 1 ? '' : 's'}
                  </span>
                </div>
                {activeZernioAccounts.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-3 pt-0.5">
                    {activeZernioAccounts.map((acc) => {
                      const checked = selectedAccountIds.includes(acc.id);
                      const badge = getPlatformBadgeMeta(acc.platform);
                      return (
                        <label
                          key={acc.id}
                          className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-200"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              setSelectedAccountIds((prev) =>
                                e.target.checked
                                  ? Array.from(new Set([...prev, acc.id]))
                                  : prev.filter((id) => id !== acc.id)
                              );
                            }}
                            className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-indigo-500 focus:ring-indigo-500"
                          />
                          <span className="font-medium text-slate-200">
                            {badge.label}
                            {acc.username
                              ? ` (@${acc.username.replace(/^@/, '')})`
                              : acc.displayName
                              ? ` (${acc.displayName})`
                              : ''}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-slate-400">
                    No active channels synced yet — click Zernio Login to sync accounts.
                  </p>
                )}
              </>
            ) : (
              <div className="text-xs text-slate-400">
                <span className="font-semibold text-slate-200">
                  Zernio Account Not Connected:
                </span>{' '}
                Connect Zernio to publish directly to your TikTok, YouTube, Reels, and X
                accounts. You can still generate and copy all metadata anytime.
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {!zernio?.connected ? (
              <ZernioButton
                compact
                zernio={zernio}
                label="Connect Zernio"
                onClick={() => onOpenZernioConnect?.()}
              />
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => onOpenZernioConnect?.()}
                  className="min-h-[40px] rounded-xl border border-slate-700 px-3 text-xs font-medium text-slate-300 hover:bg-slate-800 whitespace-nowrap"
                >
                  Zernio Accounts
                </button>
                <button
                  type="button"
                  disabled={uploadingBatch || readyToUploadCount === 0}
                  onClick={() => void handleBatchUploadToZernio()}
                  className="inline-flex min-h-[40px] items-center gap-2 rounded-xl bg-indigo-600 px-4 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 whitespace-nowrap"
                >
                  {uploadingBatch ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                  <span className="tabular-nums">
                    {uploadingBatch
                      ? 'Uploading Batch...'
                      : `Upload Ready (${readyToUploadCount})`}
                  </span>
                </button>
              </>
            )}
          </div>
        </div>

        {globalError && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-xs text-red-200"
          >
            <span>{globalError}</span>
            <button
              type="button"
              onClick={() => setGlobalError(null)}
              className="rounded-lg border border-red-800 px-2.5 py-1 text-red-100 hover:bg-red-900/50"
            >
              Dismiss
            </button>
          </div>
        )}
      </section>

      {/* AI Auto-Fill Detection Summary & Confirm All Banner */}
      {entries.some((e) => e.needsConfirmation && !e.isConfirmed) && (
        <div className="flex flex-col gap-3 rounded-2xl border border-amber-800/80 bg-amber-950/30 p-4 sm:flex-row sm:items-center sm:justify-between shadow-lg">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-900/60 text-amber-300 shrink-0">
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-bold text-amber-200">
                {aiDetectSummary || `Detected ${entries.length} clips with distinct timelines! Review & confirm before upload.`}
              </p>
              <p className="text-[11px] text-amber-300/80">
                Each clip has its own distinct timeline and scene-matched title. You can edit any field and confirm individually or confirm all at once.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                setEntries((prev) =>
                  prev.map((e) => ({
                    ...e,
                    needsConfirmation: false,
                    isConfirmed: true,
                    ...(e.uploadStatus === 'error'
                      ? {
                          uploadStatus: getClearedUploadStatus(e, sourceVideoUrl),
                          uploadError: undefined,
                        }
                      : {}),
                  }))
                );
                setAiDetectSummary(null);
              }}
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl bg-amber-600 px-4 py-2 text-xs font-bold text-white hover:bg-amber-500 whitespace-nowrap shadow-sm"
            >
              <Check className="h-4 w-4" />
              <span>Confirm All Clips ({entries.filter((e) => e.needsConfirmation && !e.isConfirmed).length})</span>
            </button>
          </div>
        </div>
      )}

      {/* Always-Visible Inline Live Actions Status Box Directly Above Clip #1 */}
      <LiveActionsBox
        activeWork={
          detectingAi ||
          auditingSensors ||
          generatingAll ||
          uploadingBatch ||
          Boolean(generatingRowId) ||
          entries.some((e) => e.uploadStatus === 'uploading')
        }
      />

      {/* Per-Clip Info Card Grid */}
      <div className="space-y-5">
        {entries.map((entry) => {
          const status = getEffectiveUploadStatus(entry, sourceVideoUrl);
          const isGeneratingRow = generatingRowId === entry.id || generatingAll;
          const durationLabel = formatDurationLabel(entry.startTime, entry.endTime);

          const statusMeta: Record<
            ManualClipUploadStatus,
            { label: string; className: string }
          > = {
            idle: { label: 'Draft', className: 'text-slate-400' },
            ready: { label: 'Ready for Zernio', className: 'text-sky-400' },
            uploading: { label: 'Uploading...', className: 'text-orange-400' },
            uploaded: { label: 'Uploaded', className: 'text-emerald-400' },
            error: { label: 'Error', className: 'text-red-400' },
          };

          const sMeta = statusMeta[status];
          const titleLen = entry.title.length;
          const sensorState = computeEffectiveSensorState(entry, entries, sourceVideoUrl);

          const sensorBadgeConfig: Record<
            SensorStatusLevel,
            { label: string; className: string; Icon: typeof ShieldCheck }
          > = {
            passed: {
              label: sensorState.audited ? 'Sensor Passed' : 'Sensor Ready',
              className: 'border-emerald-800/70 bg-emerald-950/40 text-emerald-300',
              Icon: ShieldCheck,
            },
            warning: {
              label: 'Sensor Warning',
              className: 'border-amber-800/70 bg-amber-950/40 text-amber-300',
              Icon: ShieldAlert,
            },
            blocked: {
              label: 'Sensor Blocked',
              className: 'border-red-800/80 bg-red-950/50 text-red-300',
              Icon: ShieldX,
            },
          };
          const sensorBadge = sensorBadgeConfig[sensorState.status];
          const SensorIcon = sensorBadge.Icon;

          return (
            <article
              key={entry.id}
              className="rounded-2xl border border-slate-800/90 bg-[#11151F] p-5 sm:p-6 space-y-4"
            >
              {/* Card Header */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3.5">
                <div className="flex flex-wrap items-center gap-2.5 min-w-0">
                  <label className="inline-flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={entry.selectedForBatchUpload}
                      onChange={(e) =>
                        updateEntry(entry.id, (prev) => ({
                          ...prev,
                          selectedForBatchUpload: e.target.checked,
                        }))
                      }
                      aria-label={`Select Clip #${entry.clipNumber} for batch upload`}
                      className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-indigo-500 focus:ring-indigo-500"
                    />
                    <span className="font-mono text-sm font-bold text-slate-100 tabular-nums">
                      Clip #{entry.clipNumber}
                    </span>
                  </label>

                  <span className="text-slate-600" aria-hidden="true">
                    ·
                  </span>
                  <span
                    className={`text-xs font-semibold ${sMeta.className}`}
                    title={status === 'error' ? entry.uploadError || 'Error' : undefined}
                  >
                    {sMeta.label}
                  </span>

                  <span
                    className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${sensorBadge.className}`}
                  >
                    <SensorIcon className="h-3.5 w-3.5 shrink-0" />
                    <span>{sensorBadge.label}</span>
                  </span>

                  {(entry.startTime || entry.endTime) && (
                    <>
                      <span className="text-slate-600" aria-hidden="true">
                        ·
                      </span>
                      <span className="font-mono text-xs text-orange-300 tabular-nums">
                        {entry.startTime || '0s'} – {entry.endTime || 'End'}
                        {durationLabel ? ` (${durationLabel})` : ''}
                      </span>
                    </>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={isGeneratingRow || !entry.notes.trim()}
                    onClick={() => void handleGenerateMetadata(entry)}
                    className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900 px-3 text-xs font-semibold text-slate-100 hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                  >
                    {generatingRowId === entry.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-orange-400" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5 text-orange-400" />
                    )}
                    <span>
                      {entry.title.trim() ? 'Regenerate' : 'Generate Metadata'}
                    </span>
                  </button>

                  {entries.length > 1 && (
                    <button
                      type="button"
                      onClick={() => handleRemoveClip(entry.id)}
                      aria-label={`Remove Clip #${entry.clipNumber}`}
                      className="inline-flex min-h-[38px] min-w-[38px] items-center justify-center rounded-xl border border-slate-800 text-slate-400 hover:border-red-900/70 hover:bg-red-950/30 hover:text-red-300"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>

              {entry.needsConfirmation && !entry.isConfirmed ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-800/70 bg-amber-950/30 p-3 text-xs text-amber-200">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-amber-400 shrink-0" />
                    <span className="font-semibold">
                      AI Auto-Filled — Review &amp; Confirm Before Upload
                      {entry.startTime && entry.endTime ? (
                        <span className="font-mono text-amber-300 ml-1.5 font-bold">
                          [{entry.startTime} – {entry.endTime}]
                        </span>
                      ) : null}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      updateEntry(entry.id, (prev) => ({
                        ...prev,
                        needsConfirmation: false,
                        isConfirmed: true,
                        ...(prev.uploadStatus === 'error'
                          ? {
                              uploadStatus: getClearedUploadStatus(prev, sourceVideoUrl),
                              uploadError: undefined,
                            }
                          : {}),
                      }))
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 font-semibold text-white hover:bg-amber-500 whitespace-nowrap"
                  >
                    <Check className="h-3.5 w-3.5" />
                    <span>Confirm Clip #{entry.clipNumber}</span>
                  </button>
                </div>
              ) : entry.isConfirmed ? (
                <div className="flex items-center justify-between gap-2 rounded-xl border border-emerald-800/60 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                    <span className="font-semibold">
                      Confirmed &amp; Ready for Publishing
                      {entry.startTime && entry.endTime ? (
                        <span className="font-mono text-emerald-400/90 ml-1.5">
                          [{entry.startTime} – {entry.endTime}]
                        </span>
                      ) : null}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      updateEntry(entry.id, (prev) => ({
                        ...prev,
                        needsConfirmation: true,
                        isConfirmed: false,
                        ...(prev.uploadStatus === 'error'
                          ? {
                              uploadStatus: getClearedUploadStatus(prev, sourceVideoUrl),
                              uploadError: undefined,
                            }
                          : {}),
                      }))
                    }
                    className="text-[11px] text-slate-400 hover:text-slate-200 underline"
                  >
                    Edit / Re-review
                  </button>
                </div>
              ) : null}

              {sensorState.issues.length > 0 && (
                <div
                  className={`rounded-xl border p-3 text-xs space-y-2 ${
                    sensorState.status === 'blocked'
                      ? 'border-red-900/70 bg-red-950/35 text-red-200'
                      : 'border-amber-800/60 bg-amber-950/25 text-amber-200'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 font-semibold">
                      <SensorIcon className="h-4 w-4 shrink-0" />
                      <span>
                        {sensorState.status === 'blocked'
                          ? 'Sensor Guard Blocked Publish — Fix Before Uploading'
                          : 'Sensor Guard Warnings'}
                      </span>
                      {entry.sensorResult?.modelUsed && (
                        <span className="font-mono text-[10px] opacity-75">
                          ({entry.sensorResult.modelUsed})
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {entry.sensorResult?.autoFixedFields && (
                        <button
                          type="button"
                          onClick={() => handleApplySensorFix(entry.id)}
                          className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-500 whitespace-nowrap"
                        >
                          <Wand2 className="h-3 w-3" />
                          <span>Apply Gemini Flash Fix</span>
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={auditingSensors}
                        onClick={() => void runSensorAudit([entry])}
                        className="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                      >
                        Re-Inspect
                      </button>
                    </div>
                  </div>
                  <ul className="space-y-1 pl-1">
                    {sensorState.issues.map((iss, idx) => (
                      <li key={`${iss.code}_${idx}`} className="flex items-start gap-2 text-[11px]">
                        <span className="font-mono uppercase text-[10px] px-1.5 py-0.5 rounded bg-black/30 shrink-0">
                          {iss.layer}
                        </span>
                        <span>{iss.message}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
                {/* Left Column: Start/End Time + Scene Notes + Video Attachment */}
                <div className="space-y-4 lg:col-span-5">
                  {/* Start & End Time Range Inputs */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label
                        htmlFor={`start_${entry.id}`}
                        className="block text-[11px] font-medium text-slate-400"
                      >
                        Start Time (Sec / MM:SS)
                      </label>
                      <input
                        id={`start_${entry.id}`}
                        type="text"
                        value={entry.startTime}
                        onChange={(e) =>
                          updateEntry(entry.id, (prev) => {
                            const next = { ...prev, startTime: e.target.value };
                            return {
                              ...next,
                              ...(prev.uploadStatus === 'error'
                                ? {
                                    uploadStatus: getClearedUploadStatus(next, sourceVideoUrl),
                                    uploadError: undefined,
                                  }
                                : {}),
                            };
                          })
                        }
                        placeholder="e.g. 10 or 00:10"
                        className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-800 bg-[#090B10] px-3 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-orange-500 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor={`end_${entry.id}`}
                        className="block text-[11px] font-medium text-slate-400"
                      >
                        End Time (Sec / MM:SS)
                      </label>
                      <input
                        id={`end_${entry.id}`}
                        type="text"
                        value={entry.endTime}
                        onChange={(e) =>
                          updateEntry(entry.id, (prev) => {
                            const next = { ...prev, endTime: e.target.value };
                            return {
                              ...next,
                              ...(prev.uploadStatus === 'error'
                                ? {
                                    uploadStatus: getClearedUploadStatus(next, sourceVideoUrl),
                                    uploadError: undefined,
                                  }
                                : {}),
                            };
                          })
                        }
                        placeholder="e.g. 35 or 00:35"
                        className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-800 bg-[#090B10] px-3 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-orange-500 focus:outline-none"
                      />
                    </div>
                  </div>

                  {durationLabel && (
                    <div
                      className={`text-[11px] font-medium tabular-nums ${
                        durationLabel.startsWith('⚠️')
                          ? 'text-amber-400 font-semibold'
                          : 'text-emerald-400'
                      }`}
                    >
                      {durationLabel.startsWith('⚠️') ? durationLabel : `⏱ ${durationLabel}`}
                    </div>
                  )}

                  <div>
                    <label
                      htmlFor={`notes_${entry.id}`}
                      className="block text-xs font-medium text-slate-300"
                    >
                      Clip #{entry.clipNumber} Scene Info / Moment Notes
                    </label>
                    <textarea
                      id={`notes_${entry.id}`}
                      rows={3}
                      value={entry.notes}
                      onChange={(e) =>
                        updateEntry(entry.id, (prev) => ({
                          ...prev,
                          notes: e.target.value,
                          ...(prev.uploadStatus === 'error'
                            ? {
                                uploadStatus: getClearedUploadStatus(prev, sourceVideoUrl),
                                uploadError: undefined,
                              }
                            : {}),
                        }))
                      }
                      placeholder={`Describe what happens in Clip #${entry.clipNumber} (e.g., "Lucia crashes a police car off the bridge while screaming joke")`}
                      className="mt-1.5 w-full rounded-xl border border-slate-800 bg-[#090B10] px-3.5 py-2 text-xs text-slate-100 placeholder:text-slate-600 focus:border-orange-500 focus:outline-none"
                    />
                  </div>

                  {/* Link-Only Clip Render Summary */}
                  <div className="space-y-2 rounded-xl border border-slate-800 bg-[#090B10] p-3.5">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="inline-flex items-center gap-1.5 font-semibold text-slate-200">
                        <LinkIcon className="h-3.5 w-3.5 text-orange-400 shrink-0" />
                        <span>Link-Only 9:16 Split-Screen &amp; Subtitles</span>
                      </span>
                      <span className="font-mono text-[11px] text-emerald-300 tabular-nums">
                        {entry.startTime || '00:00'} – {entry.endTime || '00:30'}
                      </span>
                    </div>
                    <p className="text-[11px] leading-relaxed text-slate-400">
                      Cuts real footage from Source Video URL using Claude 9:16 upper gameplay +
                      clear facecam split-screen framing, burns full-duration UTF-8 Bangla/Banglish
                      subtitles until the end timestamp, preserves clean source audio, and passes
                      Gemini Flash inspection before upload.
                    </p>
                    {entry.claudeEditPlan && (
                      <div className="rounded-lg border border-indigo-900/50 bg-indigo-950/30 px-2.5 py-1.5 text-[11px] text-indigo-200">
                        <span className="font-semibold">
                          {entry.claudeEditPlan.claudeUsed ? 'Claude Edit Plan: ' : 'Edit Profile: '}
                        </span>
                        {entry.claudeEditPlan.editingSummary}
                      </div>
                    )}
                  </div>
                </div>

                {/* Right Column: Generated Editable Metadata + Copy + Zernio Upload */}
                <div className="space-y-3.5 lg:col-span-7">
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <label
                        htmlFor={`title_${entry.id}`}
                        className="text-xs font-medium text-slate-300"
                      >
                        Unique Scene-Matched Title
                      </label>
                      <div className="flex items-center gap-2 text-[11px] tabular-nums">
                        <span
                          className={
                            titleLen > 80 ? 'text-red-400 font-semibold' : 'text-slate-500'
                          }
                        >
                          {titleLen} / 80
                        </span>
                        {entry.title.trim() && (
                          <button
                            type="button"
                            onClick={() =>
                              void handleCopy(`title_${entry.id}`, entry.title.trim())
                            }
                            className="inline-flex items-center gap-1 text-slate-400 hover:text-slate-100"
                          >
                            {copiedKey === `title_${entry.id}` ? (
                              <Check className="h-3 w-3 text-emerald-400" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                            <span>Copy</span>
                          </button>
                        )}
                      </div>
                    </div>
                    <input
                      id={`title_${entry.id}`}
                      type="text"
                      maxLength={80}
                      value={entry.title}
                      onChange={(e) =>
                        updateEntry(entry.id, (prev) => ({
                          ...prev,
                          title: e.target.value,
                          uploadError:
                            prev.uploadStatus === 'error' ? undefined : prev.uploadError,
                          uploadStatus:
                            prev.uploadStatus === 'uploaded'
                              ? 'uploaded'
                              : e.target.value.trim() &&
                                sourceVideoUrl.trim() &&
                                prev.startTime.trim() &&
                                prev.endTime.trim()
                              ? 'ready'
                              : 'idle',
                        }))
                      }
                      placeholder="Generated unique Bangla/Banglish title will appear here..."
                      className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-800 bg-[#090B10] px-3.5 py-2 text-sm font-medium text-slate-100 placeholder:text-slate-600 focus:border-orange-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor={`desc_${entry.id}`}
                      className="block text-xs font-medium text-slate-300"
                    >
                      Description &amp; Caption
                    </label>
                    <textarea
                      id={`desc_${entry.id}`}
                      rows={3}
                      value={entry.description}
                      onChange={(e) =>
                        updateEntry(entry.id, (prev) => ({
                          ...prev,
                          description: e.target.value,
                          ...(prev.uploadStatus === 'error'
                            ? {
                                uploadStatus: getClearedUploadStatus(prev, sourceVideoUrl),
                                uploadError: undefined,
                              }
                            : {}),
                        }))
                      }
                      placeholder="Generated scene-matched Bangla/Banglish description + #BD hashtags..."
                      className="mt-1.5 w-full rounded-xl border border-slate-800 bg-[#090B10] px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-orange-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor={`tags_${entry.id}`}
                      className="block text-xs font-medium text-slate-300"
                    >
                      Hashtags (#BD always included)
                    </label>
                    <input
                      id={`tags_${entry.id}`}
                      type="text"
                      value={entry.hashtagsText}
                      onChange={(e) =>
                        updateEntry(entry.id, (prev) => ({
                          ...prev,
                          hashtagsText: e.target.value,
                          ...(prev.uploadStatus === 'error'
                            ? {
                                uploadStatus: getClearedUploadStatus(prev, sourceVideoUrl),
                                uploadError: undefined,
                              }
                            : {}),
                        }))
                      }
                      placeholder="#BD #GTA6 #BanglaGaming #FunnyMoments"
                      className="mt-1.5 min-h-[42px] w-full rounded-xl border border-slate-800 bg-[#090B10] px-3.5 py-2 font-mono text-xs text-orange-300 placeholder:text-slate-600 focus:border-orange-500 focus:outline-none"
                    />
                  </div>

                  {/* Upload Result / Error Feedback */}
                  {status === 'uploaded' && (
                    <div className="space-y-1.5 rounded-xl border border-emerald-800/70 bg-emerald-950/30 p-3 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-300">
                          <CheckCircle2 className="h-4 w-4 shrink-0" />
                          <span>
                            {uploadMode === 'draft'
                              ? 'Saved as Draft on Zernio'
                              : 'Published via Zernio'}
                          </span>
                        </span>
                        {entry.zernioPostId && (
                          <span className="font-mono text-[11px] text-slate-400">
                            ID: {entry.zernioPostId}
                          </span>
                        )}
                      </div>
                      {entry.zernioPlatformResults &&
                        entry.zernioPlatformResults.length > 0 && (
                          <div className="flex flex-wrap items-center gap-3 pt-1">
                            {entry.zernioPlatformResults.map((pr, idx) => (
                              <span
                                key={`${pr.accountId}_${idx}`}
                                className="inline-flex items-center gap-1 text-[11px] text-slate-300"
                              >
                                <span className="capitalize font-medium text-slate-100">
                                  {pr.platform}
                                </span>
                                <span className="text-slate-500">({pr.status})</span>
                                {pr.platformPostUrl && (
                                  <a
                                    href={pr.platformPostUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-0.5 text-indigo-300 hover:text-indigo-200 underline"
                                  >
                                    <span>View</span>
                                    <ExternalLink className="h-2.5 w-2.5" />
                                  </a>
                                )}
                              </span>
                            ))}
                          </div>
                        )}
                    </div>
                  )}

                  {status === 'error' && (
                    <div
                      role="alert"
                      className="flex flex-wrap items-start justify-between gap-2 rounded-xl border border-red-900/70 bg-red-950/40 p-3 text-xs text-red-200"
                    >
                      <div className="flex items-start gap-2 min-w-0 flex-1">
                        <AlertCircle className="mt-0.5 h-4 w-4 text-red-400 shrink-0" />
                        <span className="break-words">
                          {entry.uploadError ||
                            'Previous upload or validation check failed — review clip details and retry.'}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          updateEntry(entry.id, (prev) => ({
                            ...prev,
                            uploadStatus: getClearedUploadStatus(prev, sourceVideoUrl),
                            uploadError: undefined,
                          }))
                        }
                        className="rounded-lg border border-red-800/80 bg-red-950/60 px-2.5 py-1 text-[11px] font-medium text-red-100 hover:bg-red-900/60 shrink-0"
                      >
                        Clear Error
                      </button>
                    </div>
                  )}

                  {/* Copy + Zernio Publish Action Row */}
                  <div className="flex flex-wrap items-center justify-between gap-2.5 pt-1">
                    <button
                      type="button"
                      disabled={!entry.title.trim() && !entry.description.trim()}
                      onClick={() => void handleCopyTitleAndDescription(entry)}
                      className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 text-xs font-semibold text-slate-100 hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                    >
                      {copiedKey === `full_${entry.id}` ? (
                        <Check className="h-4 w-4 text-emerald-400" />
                      ) : (
                        <Copy className="h-4 w-4 text-orange-400" />
                      )}
                      <span>
                        {copiedKey === `full_${entry.id}`
                          ? 'Copied Title & Description!'
                          : 'Copy Title & Description'}
                      </span>
                    </button>

                    <button
                      type="button"
                      disabled={
                        status === 'uploading' ||
                        (Boolean(zernio?.connected) && sensorState.status === 'blocked')
                      }
                      onClick={() => void handlePublishSingleToZernio(entry)}
                      className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-indigo-600 px-4 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 whitespace-nowrap"
                    >
                      {status === 'uploading' ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                      <span>
                        {!zernio?.connected
                          ? 'Connect Zernio to Publish'
                          : sensorState.status === 'blocked'
                          ? 'Blocked by Sensor Guard'
                          : status === 'uploading'
                          ? 'Extracting & Auditing...'
                          : status === 'uploaded'
                          ? 'Publish Again via Zernio'
                          : 'Publish / Upload via Zernio'}
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {/* Bottom Convenience Add Button */}
      <div className="flex justify-center">
        <button
          type="button"
          onClick={handleAddClip}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-dashed border-slate-700 bg-[#11151F] px-5 text-xs font-semibold text-slate-300 hover:border-orange-500/70 hover:text-slate-100 whitespace-nowrap"
        >
          <Plus className="h-4 w-4 text-orange-400" />
          <span>Add Another Clip (#{entries.length + 1})</span>
        </button>
      </div>

      {aiDetectOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-xl space-y-4 rounded-2xl border border-slate-800 bg-[#0B0E14] p-6 text-slate-100 shadow-2xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-indigo-400" />
                <h3 className="text-base font-bold text-slate-100">
                  AI Detect &amp; Smart Paste Auto-Fill
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setAiDetectOpen(false)}
                className="text-slate-400 hover:text-slate-200"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              Paste your raw clip breakdown, timestamps (e.g. 00:10 - 00:25), scene notes, or transcript. AI will automatically parse and populate Start/End times, Scene Info, Unique Titles, Captions, and #BD Hashtags into all clip cards for your review &amp; confirmation.
            </p>

            <div>
              <label
                htmlFor="pasted-breakdown"
                className="block text-xs font-medium text-slate-300 mb-1.5"
              >
                Raw Breakdown / Transcript / Notes
              </label>
              <textarea
                id="pasted-breakdown"
                rows={6}
                value={pastedBreakdownText}
                onChange={(e) => setPastedBreakdownText(e.target.value)}
                placeholder="Clip 1 (00:12 - 00:35): Lucia crashes a police car while shouting joke...&#10;Clip 2 (01:10 - 01:45): Epic 1v3 shotgun clutch in warehouse..."
                className="w-full rounded-xl border border-slate-800 bg-[#090B10] p-3 text-xs text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setAiDetectOpen(false)}
                className="rounded-xl border border-slate-700 px-4 py-2.5 text-xs font-semibold text-slate-300 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={detectingAi || !pastedBreakdownText.trim()}
                onClick={() => void handleAiDetectAndFill()}
                className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 whitespace-nowrap"
              >
                {detectingAi ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                <span>{detectingAi ? 'Analyzing & Filling...' : 'AI Detect & Fill Boxes'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
