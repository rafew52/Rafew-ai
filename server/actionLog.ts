import type {
  ActionActivityEntry,
  ActionLogCategory,
  ActionLogStatus,
} from '../src/types.ts';

const MAX_ACTION_ENTRIES = 250;
const actionLogs: ActionActivityEntry[] = [];

function trimToMax() {
  if (actionLogs.length > MAX_ACTION_ENTRIES) {
    actionLogs.length = MAX_ACTION_ENTRIES;
  }
}

export function startActionLog(params: {
  category: ActionLogCategory;
  actionName: string;
  sourceRef?: string;
  status?: Extract<ActionLogStatus, 'queued' | 'running'>;
  summary: string;
  details?: string;
}): string {
  const id = `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  actionLogs.unshift({
    id,
    timestamp: new Date().toISOString(),
    category: params.category,
    actionName: params.actionName,
    ...(params.sourceRef ? { sourceRef: params.sourceRef } : {}),
    status: params.status || 'running',
    summary: params.summary,
    ...(params.details ? { details: params.details } : {}),
  });
  trimToMax();
  return id;
}

export function updateActionLog(
  id: string,
  patch: Partial<
    Pick<ActionActivityEntry, 'status' | 'summary' | 'details' | 'sourceRef' | 'actionName'>
  >
): void {
  const idx = actionLogs.findIndex((a) => a.id === id);
  if (idx === -1) return;
  const existing = actionLogs[idx];
  actionLogs[idx] = {
    ...existing,
    ...patch,
    timestamp: patch.status ? new Date().toISOString() : existing.timestamp,
  };
}

export function appendActionLogDetails(id: string, line: string): void {
  const idx = actionLogs.findIndex((a) => a.id === id);
  if (idx === -1) return;
  const prev = actionLogs[idx].details || '';
  actionLogs[idx].details = prev ? `${prev}\n${line}` : line;
}

export function recordActionLog(params: {
  category: ActionLogCategory;
  actionName: string;
  sourceRef?: string;
  status: ActionLogStatus;
  summary: string;
  details?: string;
  timestamp?: string;
}): ActionActivityEntry {
  const entry: ActionActivityEntry = {
    id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: params.timestamp || new Date().toISOString(),
    category: params.category,
    actionName: params.actionName,
    ...(params.sourceRef ? { sourceRef: params.sourceRef } : {}),
    status: params.status,
    summary: params.summary,
    ...(params.details ? { details: params.details } : {}),
  };
  actionLogs.unshift(entry);
  trimToMax();
  return entry;
}

export function getAllActionLogs(): ActionActivityEntry[] {
  return [...actionLogs];
}

export function clearAllActionLogs(): void {
  actionLogs.length = 0;
}
