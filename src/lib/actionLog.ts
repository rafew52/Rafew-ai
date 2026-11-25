import type { ActionLogCategory, ActionLogStatus } from '../types.ts';

export const ACTIONS_UPDATED_EVENT = 'clips-ai:actions-updated';

export interface RecordClientActionInput {
  category: ActionLogCategory;
  actionName: string;
  sourceRef?: string;
  status: ActionLogStatus;
  summary: string;
  details?: string;
}

export function notifyActionsUpdated(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(ACTIONS_UPDATED_EVENT));
  }
}

export async function recordClientAction(input: RecordClientActionInput): Promise<void> {
  try {
    await fetch('/api/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    notifyActionsUpdated();
  } catch {
    // Non-blocking telemetry helper; never interrupt user workflow
  }
}
