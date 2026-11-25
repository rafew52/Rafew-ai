import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Cpu,
  RefreshCw,
  ShieldAlert,
  Stethoscope,
  Trash2,
} from 'lucide-react';
import type { AutoDoctorFinding, AutoDoctorReport, SystemReadiness } from '../types.ts';

interface AutoDoctorViewProps {
  readiness: SystemReadiness;
  onRefreshSnapshot: () => void;
}

function getHealthMeta(health: AutoDoctorReport['overallHealth']) {
  switch (health) {
    case 'healthy':
      return {
        label: 'Healthy',
        badgeClass: 'border-emerald-700/70 bg-emerald-950/45 text-emerald-300',
        scoreClass: 'text-emerald-400',
      };
    case 'degraded':
      return {
        label: 'Needs Attention',
        badgeClass: 'border-amber-700/70 bg-amber-950/45 text-amber-300',
        scoreClass: 'text-amber-400',
      };
    default:
      return {
        label: 'Critical',
        badgeClass: 'border-red-800/80 bg-red-950/50 text-red-300',
        scoreClass: 'text-red-400',
      };
  }
}

function getSeverityBadge(severity: AutoDoctorFinding['severity']) {
  switch (severity) {
    case 'critical':
      return 'border-red-800/80 bg-red-950/55 text-red-300';
    case 'high':
      return 'border-orange-700/80 bg-orange-950/45 text-orange-300';
    case 'medium':
      return 'border-amber-700/70 bg-amber-950/40 text-amber-300';
    default:
      return 'border-slate-700 bg-slate-900/70 text-slate-300';
  }
}

export function AutoDoctorView({ readiness, onRefreshSnapshot }: AutoDoctorViewProps) {
  const [report, setReport] = useState<AutoDoctorReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [diagnosing, setDiagnosing] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [openPatches, setOpenPatches] = useState<Record<number, boolean>>({});

  const fetchReport = useCallback(async () => {
    try {
      const res = await fetch('/api/doctor/report');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load Auto-Doctor report.');
      setReport(data.report);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to reach Auto-Doctor.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchReport();
    const timer = setInterval(() => void fetchReport(), 5000);
    return () => clearInterval(timer);
  }, [fetchReport]);

  const handleRunDiagnosis = async () => {
    setDiagnosing(true);
    setError(null);
    try {
      const res = await fetch('/api/doctor/diagnose', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'AI diagnosis failed.');
      setReport(data.report);
      onRefreshSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run AI diagnosis.');
    } finally {
      setDiagnosing(false);
    }
  };

  const handleToggleAutoDiagnose = async () => {
    if (!report) return;
    try {
      const res = await fetch('/api/doctor/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoDiagnoseEnabled: !report.autoDiagnoseEnabled }),
      });
      const data = await res.json();
      if (res.ok && data.report) {
        setReport(data.report);
      }
    } catch {
      // Ignore toggle error
    }
  };

  const handleDiscoverModels = async () => {
    setDiscovering(true);
    setError(null);
    try {
      const res = await fetch('/api/gemini/models/discover', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to discover models.');
      onRefreshSnapshot();
      await fetchReport();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Model discovery failed.');
    } finally {
      setDiscovering(false);
    }
  };

  const handleClearEvents = async () => {
    try {
      const res = await fetch('/api/doctor/clear', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.report) {
        setReport(data.report);
        onRefreshSnapshot();
      }
    } catch {
      // Ignore
    }
  };

  const handleCopyPrompt = async (idx: number, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      setTimeout(() => {
        setCopiedIdx((prev) => (prev === idx ? null : prev));
      }, 2000);
    } catch {
      setError('Clipboard access was denied by the browser.');
    }
  };

  const healthMeta = getHealthMeta(report?.overallHealth || 'healthy');
  const models = readiness.geminiModels;

  return (
    <div className="space-y-6">
      {/* Header & Supervisor Controls */}
      <div className="rounded-2xl border border-slate-800/90 bg-[#11151F] p-5 sm:p-6 space-y-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <Stethoscope className="h-5 w-5 text-orange-400" />
              <h2 className="text-lg font-semibold text-slate-50">
                AI Auto-Doctor &amp; Self-Healing Supervisor
              </h2>
              {report && (
                <span
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-0.5 text-xs font-semibold ${healthMeta.badgeClass}`}
                >
                  {healthMeta.label}
                </span>
              )}
            </div>
            <p className="text-sm text-slate-400">
              Continuously monitors stream logs, Gemini key rotation, model availability, FFmpeg
              rendering, and stalls—diagnosing root causes with 1-click fix prompts.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={handleRunDiagnosis}
              disabled={diagnosing || report?.diagnosing}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-orange-600 px-4 text-xs font-semibold text-white transition-colors hover:bg-orange-500 disabled:opacity-50 whitespace-nowrap"
            >
              <RefreshCw
                className={`h-4 w-4 ${diagnosing || report?.diagnosing ? 'animate-spin' : ''}`}
              />
              <span>
                {diagnosing || report?.diagnosing ? 'Diagnosing...' : 'Run AI Diagnosis'}
              </span>
            </button>

            <button
              type="button"
              onClick={handleDiscoverModels}
              disabled={discovering}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-700 bg-[#0D1017] px-3.5 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
            >
              <Cpu className={`h-4 w-4 ${discovering ? 'animate-pulse text-orange-400' : ''}`} />
              <span>{discovering ? 'Refreshing Models...' : 'Refresh Models'}</span>
            </button>

            {report && (
              <button
                type="button"
                onClick={handleToggleAutoDiagnose}
                className={`inline-flex min-h-[44px] items-center gap-2 rounded-xl border px-3.5 text-xs font-medium transition-colors whitespace-nowrap ${
                  report.autoDiagnoseEnabled
                    ? 'border-emerald-700/70 bg-emerald-950/35 text-emerald-300'
                    : 'border-slate-700 bg-[#0D1017] text-slate-400'
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    report.autoDiagnoseEnabled ? 'bg-emerald-400' : 'bg-slate-500'
                  }`}
                />
                <span>Auto-Diagnose {report.autoDiagnoseEnabled ? 'ON' : 'OFF'}</span>
              </button>
            )}
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-xl border border-red-800/70 bg-red-950/40 px-4 py-3 text-xs text-red-200"
          >
            {error}
          </div>
        )}

        {/* Executive Summary & Metrics Strip */}
        {loading && !report ? (
          <div className="h-20 animate-pulse rounded-xl bg-slate-800/50" />
        ) : (
          report && (
            <div className="grid gap-4 rounded-xl border border-slate-800 bg-[#0D1017] p-4 sm:grid-cols-4">
              <div>
                <div className="text-xs text-slate-400">System Health Score</div>
                <div
                  className={`mt-1 font-mono text-2xl font-bold tabular-nums ${healthMeta.scoreClass}`}
                >
                  {report.healthScore}/100
                </div>
                <div className="mt-0.5 text-[11px] text-slate-500">
                  {report.aiPowered
                    ? `AI Analyzed (${report.modelUsed || 'Gemini'})`
                    : 'Real-Time Baseline Check'}
                </div>
              </div>

              <div className="sm:col-span-3 flex flex-col justify-center">
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Supervisor Summary
                </div>
                <p className="mt-1 text-sm leading-relaxed text-slate-200">{report.summary}</p>
              </div>
            </div>
          )
        )}
      </div>

      {/* Dynamic Model Discovery & Watchdog Card */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-800/90 bg-[#11151F] p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-100">
              Dynamic Gemini Model Pool (Auto-Discovered)
            </h3>
            <span className="font-mono text-[11px] text-emerald-400">
              {models.activeModels.length} Active
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            {models.activeModels.slice(0, 6).map((m, i) => (
              <span
                key={m}
                className={`rounded-lg border px-2.5 py-1 font-mono text-xs ${
                  i === 0
                    ? 'border-orange-700/70 bg-orange-950/35 text-orange-200'
                    : 'border-slate-700 bg-[#0D1017] text-slate-300'
                }`}
              >
                {i === 0 ? `Primary: ${m}` : m}
              </span>
            ))}
          </div>

          {models.quarantinedModels.length > 0 ? (
            <div className="space-y-1.5 rounded-xl border border-amber-800/60 bg-amber-950/25 p-3 text-xs">
              <div className="font-semibold text-amber-300">
                Quarantined Bad/404 Models ({models.quarantinedModels.length})
              </div>
              {models.quarantinedModels.map((q) => (
                <div key={q.modelId} className="text-amber-200/90 font-mono text-[11px]">
                  {q.modelId} · {q.remainingSeconds}s left · {q.reason}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-400">
              No quarantined models. Any 404 or deprecated model is quarantined automatically for
              30 minutes and replaced via <code className="font-mono">models.list()</code>.
            </p>
          )}
        </div>

        <div className="rounded-2xl border border-slate-800/90 bg-[#11151F] p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-100">
              Anti-Freeze Watchdog &amp; Local Fallback
            </h3>
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
              <Activity className="h-3.5 w-3.5" />
              <span>Armed (45s)</span>
            </span>
          </div>
          <ul className="space-y-2 text-xs leading-relaxed text-slate-300">
            <li className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
              <span>
                <strong>45s Stall Recovery:</strong> Aborts hung segment calls automatically and
                retries immediately on a fresh API key &amp; model.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
              <span>
                <strong>FFmpeg Local Fallback:</strong> If all remote Gemini APIs are temporarily
                unreachable, detects scene cuts &amp; audio intensity peaks locally so monitoring
                never freezes.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
              <span>
                <strong>Dual-Quality Buffer:</strong> Analyzes lightweight 360p/2fps proxies
                while cutting final clips from original HD buffers.
              </span>
            </li>
          </ul>
        </div>
      </div>

      {/* Diagnosed Root Causes & 1-Click Fix Prompts */}
      <section className="space-y-3">
        <h3 className="text-base font-semibold text-slate-100">
          Root-Cause Diagnostics &amp; 1-Click Fix Prompts
        </h3>

        {!report || report.rootCauses.length === 0 ? (
          <div className="rounded-2xl border border-slate-800 bg-[#11151F] p-6 text-center">
            <CheckCircle2 className="mx-auto h-7 w-7 text-emerald-400" />
            <p className="mt-2 text-sm font-medium text-slate-200">
              No active errors or bottlenecks detected.
            </p>
            <p className="mt-1 text-xs text-slate-400">
              Click <strong>Run AI Diagnosis</strong> anytime for a full supervisor audit.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {report.rootCauses.map((finding, idx) => {
              const patchOpen = Boolean(openPatches[idx]);
              return (
                <div
                  key={`${finding.title}_${idx}`}
                  className="rounded-2xl border border-slate-800/90 bg-[#11151F] p-5 space-y-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${getSeverityBadge(
                            finding.severity
                          )}`}
                        >
                          {finding.severity}
                        </span>
                        <span className="font-mono text-xs text-slate-400">{finding.area}</span>
                      </div>
                      <h4 className="text-base font-semibold text-slate-50">{finding.title}</h4>
                    </div>

                    <button
                      type="button"
                      onClick={() => void handleCopyPrompt(idx, finding.readyToCopyFixPrompt)}
                      className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-orange-700/70 bg-orange-950/35 px-3.5 text-xs font-semibold text-orange-200 transition-colors hover:bg-orange-900/50 whitespace-nowrap"
                    >
                      {copiedIdx === idx ? (
                        <>
                          <Check className="h-4 w-4 text-emerald-400" />
                          <span className="text-emerald-300">Copied Fix Prompt</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-4 w-4" />
                          <span>Copy 1-Click Fix Prompt</span>
                        </>
                      )}
                    </button>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2 text-xs leading-relaxed">
                    <div className="rounded-xl border border-slate-800 bg-[#0D1017] p-3.5">
                      <div className="font-semibold text-slate-300">Root Cause</div>
                      <p className="mt-1 text-slate-400">{finding.rootCause}</p>
                    </div>
                    <div className="rounded-xl border border-slate-800 bg-[#0D1017] p-3.5">
                      <div className="font-semibold text-slate-300">Recommended Fix</div>
                      <p className="mt-1 text-slate-400">{finding.recommendation}</p>
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-800 bg-[#090B10] p-3 text-xs">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      Ready-to-Copy Fix Prompt
                    </div>
                    <p className="mt-1 font-mono text-slate-200 break-words">
                      {finding.readyToCopyFixPrompt}
                    </p>
                  </div>

                  {finding.codePatchPreview && (
                    <div>
                      <button
                        type="button"
                        onClick={() =>
                          setOpenPatches((prev) => ({ ...prev, [idx]: !prev[idx] }))
                        }
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-300 hover:text-slate-100"
                      >
                        {patchOpen ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                        <span>Code Patch Preview</span>
                      </button>

                      {patchOpen && (
                        <pre className="mt-2 overflow-x-auto rounded-xl border border-slate-800 bg-[#090B10] p-3.5 font-mono text-xs text-emerald-300">
                          <code>{finding.codePatchPreview}</code>
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Missing Improvements Checklist */}
      {report && report.missingImprovements.length > 0 && (
        <section className="rounded-2xl border border-slate-800/90 bg-[#11151F] p-5 space-y-3">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-amber-400" />
            <h3 className="text-sm font-semibold text-slate-100">
              Suggested Missing Improvements
            </h3>
          </div>
          <ul className="space-y-2 text-xs leading-relaxed text-slate-300 list-disc pl-5">
            {report.missingImprovements.map((item, idx) => (
              <li key={idx}>{item}</li>
            ))}
          </ul>
        </section>
      )}

      {/* Recent Telemetry & Event Log */}
      <section className="rounded-2xl border border-slate-800/90 bg-[#11151F] p-5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-100">
            Live Supervisor Event Stream ({report?.recentEvents.length || 0})
          </h3>
          {report && report.recentEvents.length > 0 && (
            <button
              type="button"
              onClick={handleClearEvents}
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 text-xs text-slate-300 hover:bg-slate-800"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Clear</span>
            </button>
          )}
        </div>

        {!report || report.recentEvents.length === 0 ? (
          <p className="text-xs text-slate-500">
            No runtime warnings or error events recorded yet.
          </p>
        ) : (
          <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-xl border border-slate-800 bg-[#090B10] p-3 font-mono text-xs">
            {report.recentEvents.map((ev) => {
              const color =
                ev.severity === 'critical' || ev.severity === 'error'
                  ? 'text-red-400'
                  : ev.severity === 'warn'
                  ? 'text-amber-300'
                  : 'text-slate-300';
              return (
                <div key={ev.id} className="flex flex-wrap gap-2 leading-relaxed">
                  <span className="text-slate-500 shrink-0 tabular-nums">
                    {ev.timestamp.slice(11, 19)}
                  </span>
                  <span className="rounded bg-slate-800 px-1.5 text-[10px] text-slate-300">
                    {ev.category}
                  </span>
                  {ev.httpCode && (
                    <span className="rounded bg-amber-950/60 px-1.5 text-[10px] text-amber-300">
                      HTTP {ev.httpCode}
                    </span>
                  )}
                  <span className={`${color} min-w-0 break-words flex-1`}>{ev.message}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
