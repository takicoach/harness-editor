import { statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { PreferenceWorkspaceStore, preferenceCommandSchema } from '../learning/preferenceWorkspaceStore';
import { proposePreferenceEdits, ruleAvailability, type PreferenceProposal } from '../learning/preferenceRules';
import { preferenceHash, PREFERENCE_RUBRIC } from '../learning/preferenceEvaluation';
import { modelSelectionSchema, modelComparisonSchema, preparePreferenceModelInput, comparePreferenceModelOutputs } from '../learning/preferenceModelComparison';
import { readJsonBody } from './readBody';
import { resolveProjectDir } from './projectRoot';
import { HttpError, sendJson } from './http';
import { handleScriptEvaluationApi, readScriptEvaluationOperations, scriptEvaluationOptions } from './scriptEvaluationApi';
import { resolveScriptDataset } from '../learning/scriptEvaluation';

const id = z.string().trim().min(1).max(256);
const rangeSchema = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict()
  .refine((r) => r.end > r.start, '範囲の終わりは始まりより後を指定してください');
const targetSchema = z.object({ projectId: id, projectRevision: id,
  elements: z.array(z.object({ id, text: z.string().min(1).max(10000), sourceFrameRange: rangeSchema }).strict()).max(10000),
}).strict().refine((target) => new Set(target.elements.map((e) => e.id)).size === target.elements.length, '対象が重複しています');
const proposalSchema = z.object({ projectId: id, projectRevision: id, elementId: id,
  before: z.string().min(1).max(10000), after: z.string().min(1).max(10000), sourceFrameRange: rangeSchema,
  rule: z.object({ id, version: z.number().int().positive() }).strict(), evidenceIds: z.array(id).min(1),
  activationEvaluationId: id.optional(),
}).strict();

function recordingProvenance(): 'human' | 'synthetic' {
  return process.env.HARNESS_PREFERENCE_TEST_FIXTURE === '1' ? 'synthetic' : 'human';
}

function requireProject(root: string, projectId: string): void {
  const directory = resolveProjectDir(root, projectId);
  try {
    if (!statSync(directory).isDirectory()) throw new HttpError(404, '案件が見つかりません');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, '案件が見つかりません');
    throw error;
  }
}

/** Mounted behind the existing localhost request guard. Human workflow endpoints are not MCP tools. */
export async function handlePreferenceApi(req: IncomingMessage, res: ServerResponse, url: URL,
  root: string, store = new PreferenceWorkspaceStore()): Promise<void> {
  try {
    if (await handleScriptEvaluationApi(req, res, url, root, store)) return;
    const route = url.pathname;
    const method = req.method ?? 'GET';
    if (route === '/api/preferences' && method === 'GET') {
      const state = store.read();
      sendJson(res, 200, { ...state, rubric: PREFERENCE_RUBRIC,
        recordingProvenance: recordingProvenance(),
        availability: state.rules.map((rule) => ({ id: rule.id, version: rule.version, status: ruleAvailability(rule, state.decisions) })) });
      return;
    }
    if (route === '/api/preferences/export' && method === 'GET') {
      res.setHeader('Content-Disposition', 'attachment; filename="editor-preferences.v1.json"');
      sendJson(res, 200, JSON.parse(store.export()));
      return;
    }
    if (method !== 'POST') throw new HttpError(405, 'この操作は POST で実行してください');
    const body = await readJsonBody(req);
    if (route === '/api/preferences/model-input') {
      sendJson(res, 200, preparePreferenceModelInput(store.read(), modelSelectionSchema.parse(body)));
      return;
    }
    if (route === '/api/preferences/model-compare') {
      sendJson(res, 200, await comparePreferenceModelOutputs(store.read(), modelComparisonSchema.parse(body)));
      return;
    }
    if (route === '/api/preferences/command') {
      const parsedCommand = preferenceCommandSchema.parse(body);
      const command = recordingProvenance() === 'synthetic' && parsedCommand.kind === 'decision'
        && parsedCommand.event.type !== 'withdrawal'
        ? preferenceCommandSchema.parse({ ...parsedCommand,
          event: { ...parsedCommand.event, provenance: { kind: 'synthetic' } } })
        : parsedCommand;
      if (command.kind === 'assign') requireProject(root, command.projectId);
      if (command.kind === 'script_dataset') {
        const current = store.read();
        // A retry confirms an existing historical freeze; it does not authorize
        // using cases whose consent may have since been withdrawn.
        if (!current.operations.some(operation => operation.id === command.operationId)) {
          resolveScriptDataset(command.dataset, current.decisions, readScriptEvaluationOperations(root), scriptEvaluationOptions());
        }
      }
      if (command.kind === 'decision' && command.event.type !== 'withdrawal') requireProject(root, command.event.projectId);
      sendJson(res, 200, { ...store.execute(command), recordingProvenance: recordingProvenance() });
      return;
    }
    if (route === '/api/preferences/import') {
      const input = z.object({ confirmedRestore: z.literal(true), journal: z.unknown() }).strict().parse(body);
      sendJson(res, 200, store.import(input.journal));
      return;
    }
    if (route === '/api/preferences/proposals' || route === '/api/preferences/validate') {
      const input = route.endsWith('/validate')
        ? z.object({ target: targetSchema, proposal: proposalSchema }).strict().parse(body)
        : { target: targetSchema.parse(body), proposal: null };
      requireProject(root, input.target.projectId);
      const state = store.read();
      const result = proposePreferenceEdits(state.rules, state.decisions, { ...input.target,
        profileId: state.projectProfiles[input.target.projectId] ?? null });
      if (input.proposal !== null) {
        const proposed = input.proposal as PreferenceProposal;
        const valid = result.proposals.some((p) => preferenceHash(p) === preferenceHash(proposed));
        if (!valid) throw new HttpError(409, 'STALE_PROPOSAL: 本文・方針・ルール・同意が変わりました。提案を更新してください');
        sendJson(res, 200, { valid: true, proposal: proposed });
      } else sendJson(res, 200, result);
      return;
    }
    throw new HttpError(404, '好みの操作が見つかりません');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof z.ZodError) throw new HttpError(400, `INVALID_PREFERENCE_INPUT: ${error.issues.map((e) => e.message).join(' / ')}`);
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('STORE_BUSY:')) throw new HttpError(503, message);
    if (/^[A-Z_]+:/.test(message)) throw new HttpError(message.startsWith('HUMAN_REQUIRED:') ? 403 : 409, message);
    throw error;
  }
}
