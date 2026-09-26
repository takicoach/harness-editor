import path from 'node:path';
import { z } from 'zod';
import { globalStoreDir } from './paths';
import { readPreferenceFile, updatePreferenceFile } from './atomicPreferenceFile';
import { appendDecisionEvent, decisionEventSchema, emptyDecisionLedger, type DecisionLedger } from './preferenceDecisions';
import { createRuleCandidate, fragmentReplacementSchema, transitionRule, type PreferenceRule } from './preferenceRules';
import { activateEvaluatedRule, evaluatePreferenceRule, freezePreferenceDataset, preferenceHash,
  type EvaluationDataset, type PreferenceEvaluation } from './preferenceEvaluation';
import { parseScriptEditArtifact } from '../server/scriptEditArtifacts';
import {
  parseScriptDataset,
  verifyScriptDatasetReferences,
  type ScriptEvaluationDataset,
} from './scriptEvaluation';

const id = z.string().trim().min(1).max(256);
const version = z.number().int().positive();
const base = { operationId: id, at: z.string().datetime({ offset: true }),
  actor: z.object({ kind: z.enum(['human', 'model']), id }).strict() };
const evaluated = { ...base, ruleId: id, version, datasetId: id, datasetVersion: version };
const storedScriptDataset = z.unknown().transform((value, ctx) => {
  try { return parseScriptDataset(value); }
  catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : '台本の評価データが不正です' });
    return z.NEVER;
  }
});
export const preferenceCommandSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('profile'), profileId: id, name: z.string().trim().min(1).max(80) }).strict(),
  z.object({ ...base, kind: z.literal('assign'), projectId: id, profileId: id.nullable() }).strict(),
  z.object({ ...base, kind: z.literal('decision'), event: decisionEventSchema }).strict(),
  z.object({ ...base, kind: z.literal('candidate'), ruleId: id, version, evidenceIds: z.array(id).min(1).max(1000),
    exceptions: z.object({ projectIds: z.array(id).max(1000) }).strict().optional(), supersedesVersion: version.optional(), fragment: fragmentReplacementSchema.optional() }).strict(),
  z.object({ ...base, kind: z.literal('dataset'), datasetId: id, datasetVersion: version, caseIds: z.array(id).min(1).max(10000) }).strict(),
  z.object({ ...base, kind: z.literal('script_dataset'), dataset: storedScriptDataset }).strict(),
  z.object({ ...evaluated, kind: z.literal('evaluate') }).strict(),
  z.object({ ...evaluated, kind: z.literal('activate') }).strict(),
  z.object({ ...base, kind: z.literal('status'), ruleId: id, version, status: z.enum(['suspended', 'revoked']) }).strict(),
]);
export type PreferenceCommand = z.infer<typeof preferenceCommandSchema>;
/** Node persistence boundary shared by HTTP, CLI, restore and restart. Shape validation alone cannot verify hashes. */
function verifyScriptInput(command: PreferenceCommand): void {
  if (command.kind === 'decision' && command.event.type === 'script_judgment') {
    parseScriptEditArtifact(command.event.artifact);
  }
}
interface PreferenceJournal { schemaVersion: 1; commands: PreferenceCommand[] }
export interface PreferenceWorkspace {
  schemaVersion: 1; decisions: DecisionLedger; rules: PreferenceRule[]; datasets: EvaluationDataset[];
  scriptDatasets?: ScriptEvaluationDataset[];
  evaluations: PreferenceEvaluation[]; profiles: { id: string; name: string }[];
  projectProfiles: Record<string, string | null>; operations: { id: string; hash: string }[];
}
const emptyJournal = (): PreferenceJournal => ({ schemaVersion: 1, commands: [] });
const emptyWorkspace = (): PreferenceWorkspace => ({ schemaVersion: 1, decisions: emptyDecisionLedger(),
  rules: [], datasets: [], scriptDatasets: [], evaluations: [], profiles: [],
  projectProfiles: Object.create(null) as Record<string, string | null>, operations: [] });

/** Commands are the persisted source of truth. Replaying validates every activation and reference in order. */
function applyCommand(state: PreferenceWorkspace, command: PreferenceCommand): PreferenceWorkspace {
  const hash = preferenceHash(command);
  const previous = state.operations.find((op) => op.id === command.operationId);
  if (previous) {
    if (previous.hash !== hash) throw new Error('OPERATION_CONFLICT: 同じ操作IDの内容が異なります');
    return state;
  }
  // This is a local human workflow. Models receive proposals through a separate, narrower contract.
  if (command.actor.kind !== 'human') throw new Error('HUMAN_REQUIRED: この好みの操作は人が行います');
  const next: PreferenceWorkspace = { ...state, operations: [...state.operations, { id: command.operationId, hash }] };
  switch (command.kind) {
    case 'profile':
      next.profiles = [...state.profiles.filter((p) => p.id !== command.profileId), { id: command.profileId, name: command.name }];
      break;
    case 'assign':
      if (command.profileId !== null && !state.profiles.some((p) => p.id === command.profileId)) throw new Error('PROFILE_NOT_FOUND: 編集方針がありません');
      next.projectProfiles = { ...state.projectProfiles, [command.projectId]: command.profileId };
      break;
    case 'decision': {
      const event = command.event;
      if (command.event.operationId !== command.operationId || command.event.createdAt !== command.at
        || preferenceHash(command.event.actor) !== preferenceHash(command.actor)) throw new Error('ACTOR_MISMATCH: 判断と操作の記録が一致しません');
      if (event.type !== 'withdrawal' && event.scope.kind === 'profile'
        && !state.profiles.some((p) => p.id === event.scope.id)) throw new Error('PROFILE_NOT_FOUND: 編集方針がありません');
      next.decisions = appendDecisionEvent(state.decisions, command.event);
      break;
    }
    case 'candidate': {
      const existing = state.rules.filter((r) => r.id === command.ruleId);
      if (existing.some((r) => r.version === command.version)) throw new Error('RULE_VERSION_CONFLICT: この版はすでにあります');
      const latest = Math.max(0, ...existing.map((r) => r.version));
      if (command.version !== latest + 1 || (latest > 0 && command.supersedesVersion !== latest)
        || (latest === 0 && command.supersedesVersion !== undefined)) throw new Error('RULE_VERSION_CONFLICT: 最新の版を指定して順番に改訂してください');
      const rule = createRuleCandidate(state.decisions, { id: command.ruleId, version: command.version,
        evidenceIds: command.evidenceIds, createdAt: command.at, exceptions: command.exceptions, supersedesVersion: command.supersedesVersion, fragment: command.fragment });
      next.rules = [...state.rules, rule];
      break;
    }
    case 'dataset': {
      const existing = state.datasets.filter((d) => d.id === command.datasetId);
      if (command.datasetVersion !== Math.max(0, ...existing.map((d) => d.version)) + 1) throw new Error('DATASET_VERSION_CONFLICT: 評価データは順番に新しい版を作成してください');
      next.datasets = [...state.datasets, freezePreferenceDataset(state.decisions, {
        id: command.datasetId, version: command.datasetVersion, caseIds: command.caseIds, frozenAt: command.at })];
      break;
    }
    case 'script_dataset': {
      const dataset = verifyScriptDatasetReferences(command.dataset, state.decisions);
      const existing = (state.scriptDatasets ?? []).filter(item => item.id === dataset.id);
      if (dataset.version !== Math.max(0, ...existing.map(item => item.version)) + 1) {
        throw new Error('DATASET_VERSION_CONFLICT: 台本の評価データは順番に新しい版を作成してください');
      }
      next.scriptDatasets = [...(state.scriptDatasets ?? []), dataset];
      break;
    }
    case 'evaluate':
    case 'activate':
    case 'status': {
      const rule = state.rules.find((r) => r.id === command.ruleId && r.version === command.version);
      if (!rule) throw new Error('RULE_NOT_FOUND: 指定された版のルールがありません');
      if (command.kind === 'status') {
        next.rules = state.rules.map((r) => r === rule ? transitionRule(r, command.status, command.actor) : r);
        break;
      }
      const dataset = state.datasets.find((d) => d.id === command.datasetId && d.version === command.datasetVersion);
      if (!dataset) throw new Error('DATASET_NOT_FOUND: 指定された版の評価データがありません');
      const run = { id: command.operationId, startedAt: command.at };
      if (command.kind === 'activate') {
        if (state.rules.some((r) => r.id === rule.id && r.version > rule.version)) throw new Error('STALE_RULE_VERSION: 最新の候補を評価してください');
        const activated = activateEvaluatedRule(rule, state.decisions, dataset, { ...run, actor: command.actor });
        next.rules = state.rules.map((r) => r === rule ? activated.rule
          : r.id === rule.id && r.status === 'active' ? { ...r, status: 'suspended' } : r);
        next.evaluations = [...state.evaluations, activated.evaluation];
      } else next.evaluations = [...state.evaluations, evaluatePreferenceRule(rule, state.decisions, dataset, run)];
      break;
    }
  }
  return next;
}
function parseJournal(input: unknown): PreferenceJournal {
  const journal = z.object({ schemaVersion: z.literal(1), commands: z.array(preferenceCommandSchema) }).strict().parse(input);
  journal.commands.forEach(verifyScriptInput);
  journal.commands.reduce(applyCommand, emptyWorkspace()); // Reject bad references or forged activation history on read/import.
  return journal;
}

/** All preference state commits together; no half-saved activation or evaluation in a companion file. */
export class PreferenceWorkspaceStore {
  readonly file: string;
  constructor(readonly directory = globalStoreDir()) { this.file = path.join(directory, 'preference-workspace.v1.json'); }
  private journal(): PreferenceJournal { return readPreferenceFile(this.file, parseJournal, emptyJournal); }
  read(): PreferenceWorkspace { return this.journal().commands.reduce(applyCommand, emptyWorkspace()); }
  execute(input: unknown): PreferenceWorkspace {
    const command = preferenceCommandSchema.parse(input);
    verifyScriptInput(command);
    const journal = updatePreferenceFile(this.file, () => this.journal(), (current) => {
      const state = current.commands.reduce(applyCommand, emptyWorkspace());
      const next = applyCommand(state, command);
      return next === state ? current : { schemaVersion: 1 as const, commands: [...current.commands, command] };
    });
    return journal.commands.reduce(applyCommand, emptyWorkspace());
  }
  export(): string { return `${JSON.stringify(this.journal(), null, 2)}\n`; }
  /** Explicit local restore. Merge is all-or-nothing; conflicting IDs never overwrite existing history. */
  import(input: unknown): PreferenceWorkspace {
    const incoming = parseJournal(input);
    const journal = updatePreferenceFile(this.file, () => this.journal(), (current) => {
      let state = current.commands.reduce(applyCommand, emptyWorkspace());
      const commands = [...current.commands];
      for (const command of incoming.commands) {
        const next = applyCommand(state, command);
        if (next !== state) commands.push(command);
        state = next;
      }
      return commands.length === current.commands.length ? current : { schemaVersion: 1 as const, commands };
    });
    return journal.commands.reduce(applyCommand, emptyWorkspace());
  }
}
