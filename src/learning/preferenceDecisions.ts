import { z } from 'zod';
import { scriptJudgmentSchema, validateScriptJudgment, type ScriptJudgmentExample } from './scriptDecisions';

const identifier = z.string().trim().min(1).max(256);
const actorSchema = z.object({ kind: z.enum(['human', 'model']), id: identifier }).strict();
const eventBase = {
  schemaVersion: z.literal(1), id: identifier, operationId: identifier,
  createdAt: z.string().datetime({ offset: true }), actor: actorSchema,
};

const judgmentSchema = z.object({
  ...eventBase, type: z.literal('judgment'), editKind: z.literal('telop_text'),
  proposalId: identifier.optional(),
  rule: z.object({ id: identifier, version: z.number().int().positive() }).strict().optional(),
  projectId: identifier, projectRevision: identifier, elementId: identifier,
  sourceFrameRange: z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict(),
  before: z.string().min(1).max(10000), proposedAfter: z.string().min(1).max(10000),
  actualAfter: z.string().min(1).max(10000).nullable(),
  decision: z.enum(['accepted', 'accepted_modified', 'rejected', 'deferred']),
  reasonCode: z.enum(['unspecified', 'wording', 'factual_correction', 'tone', 'readability', 'context_mismatch', 'one_off', 'other']),
  note: z.string().max(4000),
  scope: z.object({ kind: z.enum(['project', 'profile']), id: identifier }).strict(),
  learningConsent: z.boolean(),
  provenance: z.object({
    kind: z.enum(['human', 'imported_human', 'synthetic', 'model']),
    provider: identifier.optional(), model: identifier.optional(), promptVersion: identifier.optional(),
  }).strict(),
  supersedes: identifier.optional(),
}).strict();

const withdrawalSchema = z.object({
  ...eventBase, type: z.literal('withdrawal'), targetId: identifier, reason: z.string().trim().min(1).max(4000),
}).strict();

/** UI/API/インポート共通。自然言語メモの解釈で同意・採否を補完しない。 */
export const decisionEventSchema = z.union([judgmentSchema, withdrawalSchema, scriptJudgmentSchema]).superRefine((event, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (event.type === 'withdrawal') {
    if (event.actor.kind !== 'human') fail('同意を撤回する操作は人に帰属する必要があります');
    return;
  }
  if (event.type === 'script_judgment') {
    try { validateScriptJudgment(event); }
    catch (error) { fail(error instanceof Error ? error.message : '台本の判断が不正です'); }
    return;
  }
  if (event.sourceFrameRange.end <= event.sourceFrameRange.start) fail('元フレーム範囲が逆転しています');
  if (event.reasonCode === 'other' && event.note.trim() === '') fail('その他の理由には説明が必要です');
  if (event.scope.kind === 'project' && event.scope.id !== event.projectId) fail('今回限りの範囲には当該案件を指定してください');
  if (event.learningConsent && event.actor.kind !== 'human') fail('モデルは学習への同意を付与できません');
  if (event.provenance.kind === 'human' && event.actor.kind !== 'human') fail('人の判断の出所と操作主体が一致しません');
  if (event.provenance.kind === 'model' && (!event.provenance.provider || !event.provenance.model || !event.provenance.promptVersion)) fail('モデル由来の実例にはprovider/model/promptVersionが必要です');
  if (event.decision === 'accepted' && event.actualAfter !== event.proposedAfter) fail('採用した本文が提案と一致しません');
  if (event.decision === 'accepted_modified' && (event.actualAfter === null || event.actualAfter === event.proposedAfter)) fail('修正採用には提案と異なる実際の本文が必要です');
  if ((event.decision === 'rejected' || event.decision === 'deferred') && event.actualAfter !== null) fail('却下・保留は適用した本文を持ちません');
});

export type DecisionEvent = z.infer<typeof decisionEventSchema>;
export type JudgmentExample = Extract<DecisionEvent, { type: 'judgment' }>;
export interface DecisionLedger { schemaVersion: 1; events: DecisionEvent[] }

export function emptyDecisionLedger(): DecisionLedger {
  return { schemaVersion: 1, events: [] };
}

/** 追記前の契約検証。保存層はこの結果を永続化できてから成功を返す。 */
export function appendDecisionEvent(ledger: DecisionLedger, input: unknown): DecisionLedger {
  const event = decisionEventSchema.parse(input);
  const previous = ledger.events.find((e) => e.operationId === event.operationId);
  if (previous) {
    if (JSON.stringify(previous) !== JSON.stringify(event)) throw new Error('OPERATION_CONFLICT: 同じ操作IDの内容が異なります');
    return ledger;
  }
  if (ledger.events.some((e) => e.id === event.id)) throw new Error('ID_CONFLICT: 記録IDが重複しています');
  const targetId = event.type === 'withdrawal' ? event.targetId : event.supersedes;
  if (targetId) {
    const target = ledger.events.find((e) => e.id === targetId);
    if (!target || target.type === 'withdrawal') throw new Error('TARGET_NOT_FOUND: 対象の判断実例がありません');
    if (event.type === 'judgment') {
      if (target.type !== 'judgment' || target.projectId !== event.projectId || target.elementId !== event.elementId) throw new Error('TARGET_MISMATCH: 別案件・別要素の判断は訂正できません');
      if (ledger.events.some((e) => e.type === 'judgment' && e.supersedes === targetId)) throw new Error('TARGET_SUPERSEDED: 最新の判断を訂正してください');
    }
    if (event.type === 'script_judgment') {
      if (target.type !== 'script_judgment' || target.projectId !== event.projectId
        || target.projectRevision !== event.projectRevision
        || target.artifact.proposal.proposalId !== event.artifact.proposal.proposalId
        || target.artifact.input.inputHash !== event.artifact.input.inputHash
        || target.artifact.proposal.kind !== event.artifact.proposal.kind) throw new Error('TARGET_MISMATCH: 別の台本案の判断は訂正できません');
      if (ledger.events.some(e => e.type === 'script_judgment' && e.supersedes === targetId)) throw new Error('TARGET_SUPERSEDED: 最新の判断を訂正してください');
    }
  }
  return { schemaVersion: 1, events: [...ledger.events, event] };
}

/** 未知版や壊れた履歴を空データへ黙って置き換えない。参照関係と再送も検証する。 */
export function parseDecisionLedger(input: unknown): DecisionLedger {
  const file = z.object({ schemaVersion: z.literal(1), events: z.array(z.unknown()) }).strict().parse(input);
  return file.events.reduce<DecisionLedger>((ledger, event) => appendDecisionEvent(ledger, event), emptyDecisionLedger());
}

export function judgmentSourceAllowed(event: JudgmentExample, includeSynthetic = false): boolean {
  return event.actor.kind === 'human' && (event.provenance.kind === 'human' || event.provenance.kind === 'imported_human'
    || (includeSynthetic && event.provenance.kind === 'synthetic'));
}

/** A real correction can cross a synthetic intermediate; an excluded synthetic correction alone has no effect. */
export function supersededDecisionIds(ledger: DecisionLedger, includeSynthetic = false): Set<string> {
  const judgments = new Map(ledger.events.filter((event): event is JudgmentExample => event.type === 'judgment').map((event) => [event.id, event]));
  const invalidated = new Set<string>();
  for (const event of judgments.values()) {
    if (!judgmentSourceAllowed(event, includeSynthetic)) continue;
    let previous = event.supersedes;
    while (previous && !invalidated.has(previous)) {
      invalidated.add(previous);
      previous = judgments.get(previous)?.supersedes;
    }
  }
  return invalidated;
}

/** 学習に利用可能な実例。却下を保持し、保留・撤回・旧版を除外する。 */
export function eligibleDecisionExamples(
  ledger: DecisionLedger,
  options: { includeSynthetic?: boolean } = {},
): JudgmentExample[] {
  const invalidated = supersededDecisionIds(ledger, options.includeSynthetic);
  for (const e of ledger.events) {
    if (e.type === 'withdrawal') invalidated.add(e.targetId);
  }
  return ledger.events.filter((e): e is JudgmentExample =>
    e.type === 'judgment' && e.learningConsent && e.decision !== 'deferred' && !invalidated.has(e.id)
    && judgmentSourceAllowed(e, options.includeSynthetic),
  );
}

/** Script judgments share persistence/withdrawal with text preferences, but are not text-replacement training cases. */
export function eligibleScriptDecisionExamples(ledger: DecisionLedger, savedJudgmentIds: ReadonlySet<string>): ScriptJudgmentExample[] {
  const judgments = ledger.events.filter((e): e is ScriptJudgmentExample => e.type === 'script_judgment');
  const allowed = (e: ScriptJudgmentExample) => e.actor.kind === 'human' && (e.provenance.kind === 'human'
    || e.provenance.kind === 'imported_human');
  const byId = new Map(judgments.map(e => [e.id, e]));
  const invalid = new Set(ledger.events.filter(e => e.type === 'withdrawal').map(e => e.targetId));
  for (const e of judgments.filter(allowed)) {
    let previous = e.supersedes;
    while (previous && !invalid.has(previous)) { invalid.add(previous); previous = byId.get(previous)?.supersedes; }
  }
  return judgments.filter(e => allowed(e) && e.learningConsent && e.decision !== 'deferred' && !invalid.has(e.id)
    && (e.decision === 'rejected' || ((e.decision === 'accepted' || e.decision === 'accepted_modified')
      && savedJudgmentIds.has(e.id))));
}
