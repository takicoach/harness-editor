import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { PreferenceWorkspaceStore } from '../learning/preferenceWorkspaceStore';
import { freezeScriptDataset, listScriptDecisionAvailability, resolveScriptDataset } from '../learning/scriptEvaluation';
import { prepareScriptModelInput, compareScriptModelOutputs } from '../learning/scriptModelEvaluation';
import { EditorOperationStore } from './editorOperationStore';
import { HttpError, sendJson } from './http';
import { readJsonBody } from './readBody';

const id = z.string().trim().min(1).max(256);
const version = z.number().int().positive();
const selectionSchema = z.object({ datasetId: id, datasetVersion: version }).strict();
const comparisonSchema = selectionSchema.extend({ inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  outputs: z.array(z.object({ label: z.string().trim().min(1).max(100), output: z.unknown() }).strict()).length(2) }).strict();
const freezeSchema = z.object({ id, version, frozenAt: z.string().datetime({ offset: true }),
  caseIds: z.array(id).min(1).max(10000) }).strict();

/** Reading this store never claims, acknowledges, reconnects or changes an editor operation. */
export function readScriptEvaluationOperations(root: string) {
  return new EditorOperationStore(join(root, '.sme-editor-operations.json'), 'script-evaluation-readonly').list();
}
export function scriptEvaluationOptions() { return { includeSynthetic: process.env.HARNESS_PREFERENCE_TEST_FIXTURE === '1' }; }

/** Human workflow only. External model execution and learning activation are absent. */
export async function handleScriptEvaluationApi(req: IncomingMessage, res: ServerResponse, url: URL,
  root: string, store: PreferenceWorkspaceStore): Promise<boolean> {
  const route = url.pathname;
  if (!['/api/preferences/script-evaluation', '/api/preferences/script-dataset-prepare',
    '/api/preferences/script-model-input', '/api/preferences/script-model-compare'].includes(route)) return false;
  if (route === '/api/preferences/script-evaluation') {
    if ((req.method ?? 'GET') !== 'GET') throw new HttpError(405, 'この操作は GET で実行してください');
    const state = store.read(), operations = readScriptEvaluationOperations(root), options = scriptEvaluationOptions();
    const datasets = (state.scriptDatasets ?? []).map(dataset => {
      try { resolveScriptDataset(dataset, state.decisions, operations, options); return { dataset, available: true, reason: null }; }
      catch (error) { return { dataset, available: false, reason: error instanceof Error ? error.message : String(error) }; }
    });
    sendJson(res, 200, { cases: listScriptDecisionAvailability(state.decisions, operations, options), datasets,
      syntheticWorkspace: options.includeSynthetic });
    return true;
  }
  if (req.method !== 'POST') throw new HttpError(405, 'この操作は POST で実行してください');
  const body = await readJsonBody(req);
  // A request can remain open while another request withdraws consent or changes
  // its receipt. Resolve authority only after receiving the complete request.
  const state = store.read(), operations = readScriptEvaluationOperations(root), options = scriptEvaluationOptions();
  if (route === '/api/preferences/script-dataset-prepare') {
    sendJson(res, 200, { dataset: freezeScriptDataset(state.decisions, operations, freezeSchema.parse(body), options) });
    return true;
  }
  const selection = route.endsWith('script-model-input') ? selectionSchema.parse(body) : comparisonSchema.parse(body);
  const dataset = state.scriptDatasets?.find(d => d.id === selection.datasetId && d.version === selection.datasetVersion);
  if (!dataset) throw new HttpError(404, '固定した台本の評価データが見つかりません');
  if (route.endsWith('script-model-input')) {
    sendJson(res, 200, prepareScriptModelInput(dataset, state.decisions, operations, options));
  } else {
    sendJson(res, 200, await compareScriptModelOutputs(dataset, state.decisions, operations, comparisonSchema.parse(body), options));
  }
  return true;
}
