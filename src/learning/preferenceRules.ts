import { z } from 'zod';
import { eligibleDecisionExamples, type DecisionLedger, type JudgmentExample } from './preferenceDecisions';

const id = z.string().trim().min(1).max(256);
const text = z.string().min(1).max(10000);
export const fragmentReplacementSchema = z.object({
  from: text, to: text, exceptTextIncludes: z.array(text).max(100),
}).strict().refine((value) => value.from !== value.to, '変更前後の語句が同じです');
export type FragmentReplacement = z.infer<typeof fragmentReplacementSchema>;
export const preferenceRuleSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]), id, version: z.number().int().positive(),
  status: z.enum(['candidate', 'active', 'suspended', 'revoked']), editKind: z.literal('telop_text'),
  scope: z.object({ kind: z.literal('profile'), id }).strict(),
  conditions: z.union([z.object({ textEquals: text }).strict(),
    z.object({ textIncludes: text, exceptTextIncludes: z.array(text).max(100) }).strict()]),
  action: z.object({ kind: z.enum(['replace_text', 'replace_occurrences']), text }).strict(),
  exceptions: z.object({ projectIds: z.array(id).max(1000) }).strict(),
  evidenceIds: z.array(id).min(1).max(1000), createdAt: z.string().datetime({ offset: true }),
  supersedesVersion: z.number().int().positive().optional(),
  activation: z.object({
    actorId: id, evaluationId: id, at: z.string().datetime({ offset: true }),
    dataset: z.object({ id, version: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    caseDependencies: z.array(z.object({ decisionId: id, operationId: id }).strict()).min(1).max(10000),
  }).strict().optional(),
}).strict().superRefine((rule, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (new Set(rule.evidenceIds).size !== rule.evidenceIds.length) fail('根拠の記録が重複しています');
  const exact = 'textEquals' in rule.conditions;
  if (rule.schemaVersion !== (exact ? 1 : 2) || rule.action.kind !== (exact ? 'replace_text' : 'replace_occurrences')) {
    fail('保存形式・条件・置換方法が一致していません');
  }
  if (rule.action.text === ('textEquals' in rule.conditions ? rule.conditions.textEquals : rule.conditions.textIncludes)) fail('変更前後の本文が同じです');
  if (rule.status === 'active' && !rule.activation) fail('有効化の記録がありません');
  if (rule.activation && new Set(rule.activation.caseDependencies.map((dependency) => dependency.decisionId)).size
    !== rule.activation.caseDependencies.length) fail('有効化が参照する評価実例が重複しています');
  if (rule.supersedesVersion !== undefined && rule.supersedesVersion >= rule.version) fail('置き換える版は新しい版より前である必要があります');
});
export type PreferenceRule = z.infer<typeof preferenceRuleSchema>;

export function replacePreferenceFragment(before: string, replacement: FragmentReplacement): string | null {
  const {from, to, exceptTextIncludes} = replacement;
  if (before.length > 10000 || !from || !to || from === to || !before.includes(from)
    || exceptTextIncludes.some((fragment) => before.includes(fragment))) return null;
  const parts = before.split(from);
  const length = before.length + (parts.length - 1) * (to.length - from.length);
  return length > 10000 ? null : parts.join(to);
}

/** Literal string operations only. Never expand regexes or replacement templates. */
export function applyPreferenceRuleText(rule: PreferenceRule, before: string): string | null {
  if (before.length > 10000) return null;
  if ('textEquals' in rule.conditions) return rule.conditions.textEquals === before ? rule.action.text : null;
  return replacePreferenceFragment(before, {from: rule.conditions.textIncludes, to: rule.action.text, exceptTextIncludes: rule.conditions.exceptTextIncludes});
}

/** Generalization to a fragment is explicit; recorded edits must be reproduced exactly. */
export function createRuleCandidate(ledger: DecisionLedger, input: {
  id: string; version: number; evidenceIds: string[]; createdAt: string;
  exceptions?: { projectIds: string[] }; supersedesVersion?: number; fragment?: FragmentReplacement;
}): PreferenceRule {
  const eligible = eligibleDecisionExamples(ledger);
  const examples = input.evidenceIds.map((key) => eligible.find((e) => e.id === key));
  const first = examples[0];
  if (!first || first.scope.kind !== 'profile' || first.actualAfter === null || first.decision === 'rejected') {
    throw new Error('EVIDENCE_REQUIRED: 学習に同意した編集方針の採用例が必要です');
  }
  const {fragment, ...metadata} = input;
  const replacement = fragment === undefined ? undefined : fragmentReplacementSchema.parse(fragment);
  const rule = preferenceRuleSchema.parse({ ...metadata, schemaVersion: replacement ? 2 : 1,
    status: 'candidate', editKind: 'telop_text', scope: first.scope,
    conditions: replacement ? {textIncludes: replacement.from, exceptTextIncludes: replacement.exceptTextIncludes} : {textEquals: first.before},
    action: {kind: replacement ? 'replace_occurrences' : 'replace_text', text: replacement?.to ?? first.actualAfter},
    exceptions: input.exceptions ?? {projectIds: []} });
  if (examples.some((e) => !e || e.scope.kind !== 'profile' || e.scope.id !== first.scope.id
    || e.actualAfter === null || applyPreferenceRuleText(rule, e.before) !== e.actualAfter || e.decision === 'rejected')) {
    throw new Error('EVIDENCE_MISMATCH: 同じ条件と修正を示す採用例だけを指定してください');
  }
  return rule;
}

export function ruleEvidence(rule: PreferenceRule, ledger: DecisionLedger): JudgmentExample[] | null {
  const eligible = eligibleDecisionExamples(ledger);
  const evidence = rule.evidenceIds.map((key) => eligible.find((e) => e.id === key));
  if (!evidence.length || evidence.some((e) => !e || e.scope.kind !== 'profile' || e.scope.id !== rule.scope.id
    || e.actualAfter === null || applyPreferenceRuleText(rule, e.before) !== e.actualAfter || e.decision === 'rejected')) return null;
  return evidence as JudgmentExample[];
}

export function ruleAvailability(rule: PreferenceRule, ledger: DecisionLedger):
  'available' | 'candidate' | 'suspended' | 'revoked' | 'evidence_invalidated' | 'evaluation_invalidated' {
  if (rule.status !== 'active') return rule.status;
  if (!ruleEvidence(rule, ledger)) return 'evidence_invalidated';
  if (!rule.activation) return 'evaluation_invalidated';
  const eligible = eligibleDecisionExamples(ledger);
  if (rule.activation.caseDependencies.some((dependency) => !eligible.some((example) =>
    example.id === dependency.decisionId && example.operationId === dependency.operationId))) {
    return 'evaluation_invalidated';
  }
  return 'available';
}

/** Activation is intentionally absent here: the evaluation service must compute its own gate. */
export function transitionRule(rule: PreferenceRule, status: PreferenceRule['status'], actor: { kind: 'human' | 'model'; id: string }): PreferenceRule {
  if (actor.kind !== 'human') throw new Error('HUMAN_REQUIRED: 編集方針の状態変更は人が行います');
  if (rule.status === 'revoked') throw new Error('RULE_REVOKED: 撤回した版は再開できません。新しい候補を作成してください');
  if (status === 'active') throw new Error('EVALUATION_REQUIRED: 固定した評価と人の有効化操作が必要です');
  if (status === 'candidate') throw new Error('NEW_VERSION_REQUIRED: 修正は新しい候補の版として作成してください');
  return preferenceRuleSchema.parse({ ...rule, status });
}

export interface PreferenceTarget {
  projectId: string; projectRevision: string; profileId: string | null;
  elements: { id: string; text: string; sourceFrameRange: { start: number; end: number } }[];
}
export interface PreferenceProposal {
  projectId: string; projectRevision: string; elementId: string; before: string; after: string;
  sourceFrameRange: { start: number; end: number }; rule: { id: string; version: number }; evidenceIds: string[];
  activationEvaluationId?: string;
}

/** No edits occur here. The application must revalidate this proposal against the current session before applying it. */
export function proposePreferenceEdits(rules: PreferenceRule[], ledger: DecisionLedger, target: PreferenceTarget): {
  proposals: PreferenceProposal[]; conflicts: { elementId: string; rules: { id: string; version: number }[] }[];
} {
  const proposals: PreferenceProposal[] = [];
  const conflicts: { elementId: string; rules: { id: string; version: number }[] }[] = [];
  const available = rules.filter((r) => ruleAvailability(r, ledger) === 'available'
    && r.scope.id === target.profileId && !r.exceptions.projectIds.includes(target.projectId));
  for (const element of target.elements) {
    const matches = available.map((rule) => ({rule, after: applyPreferenceRuleText(rule, element.text)}))
      .filter((match): match is {rule: PreferenceRule; after: string} => match.after !== null);
    if (!matches.length) continue;
    if (new Set(matches.map((match) => match.after)).size > 1) {
      conflicts.push({ elementId: element.id, rules: matches.map(({rule}) => ({ id: rule.id, version: rule.version })) });
      continue;
    }
    // Identical proposals are one edit; stable ordering keeps the chosen provenance reproducible.
    const {rule, after} = [...matches].sort((a, b) => a.rule.id.localeCompare(b.rule.id) || b.rule.version - a.rule.version)[0]!;
    proposals.push({ projectId: target.projectId, projectRevision: target.projectRevision,
      elementId: element.id, before: element.text, after,
      sourceFrameRange: { ...element.sourceFrameRange }, rule: { id: rule.id, version: rule.version },
      evidenceIds: [...rule.evidenceIds], activationEvaluationId: rule.activation!.evaluationId });
  }
  return { proposals, conflicts };
}
