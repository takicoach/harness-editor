/** Identifies one durable browser delivery at the existing project-save boundary. Not user authentication. */
export interface EditorDeliveryGuard { runId: string; token: string }
export const EDITOR_RUN_HEADER = 'X-Harness-Editor-Run';
export const EDITOR_TOKEN_HEADER = 'X-Harness-Editor-Token';
