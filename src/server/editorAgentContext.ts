import { eligibleDecisionExamples } from '../learning/preferenceDecisions';
import { preferenceHash } from '../learning/preferenceEvaluation';
import { ruleAvailability } from '../learning/preferenceRules';
import { PreferenceWorkspaceStore } from '../learning/preferenceWorkspaceStore';
import { scanProjects } from './scanProjects';
import type { EditorSessionSummary } from '../shared/editorSessions';
import { publicEditorOperation, type EditorOperation, type PublicEditorOperation } from '../shared/editorOperations';
import { editorReviewStatus } from '../shared/editorReview';
import type { EditorChangeSet } from '../shared/editorCommands';
import { parseScriptEditArtifact } from './scriptEditArtifacts';
import { scriptContentHash } from './scriptProposalArtifacts';
import type { ScriptDocument } from '../core/scriptAlignment';
import type { ScriptEditArtifact } from '../core/scriptEditArtifact';
import { resolveScriptEditPlan, type ScriptEditModification } from '../core/scriptEditModification';
import { resolveProjectDir } from './projectRoot';
import { loadProjectFromDir } from './loadProjectFiles';
import { createHash } from 'node:crypto';
import { scriptEditingPresenceContent } from '../shared/editorSessions';
import { hasSequenceDocument } from './sequence/summary';
import { inspectNativeSavedScriptEdit } from './sequence/scriptEdits';

export interface SavedScriptEditingState {
  scriptDocument: ScriptDocument | null;
  fps: number;
  totalFrames: number;
  telops: Array<{ id: number; text: string; originalStart: number; originalEnd: number }>;
  cutRegions: Array<{ start: number; end: number }>;
  cutOrder: Array<{ originalStart: number; originalEnd: number }>;
}

export interface SavedScriptEditInspection {
  kind: 'caption' | 'structure';
  /** Disk content matches the sealed input, the proposed result, or neither. This is not an execution/save receipt. */
  savedState: 'input' | 'proposal' | 'diverged';
  stateHash: string;
  inputStateHash: string;
  proposalStateHash: string;
  fingerprintHash: string;
  presenceHash: string;
}

export interface LegacySavedScriptEditReview extends SavedScriptEditInspection {
  documentFormat?:'legacy';
  modified?: boolean;
  current: {
    fps: number;
    totalFrames: number;
    scriptDocument: ScriptDocument | null;
    scriptDocumentMatchesInput: boolean;
    telopsMatchInput: boolean;
    cutRegionsMatchInput: boolean;
    cutOrderMatchInput: boolean;
    targetTelops: Array<{ id: number; before: string; after: string; proposedAfter?: string;
      current: { text: string; originalStart: number; originalEnd: number } | null }>;
    cutRegions: Array<{ start: number; end: number }>;
    cutOrder: Array<{ originalStart: number; originalEnd: number }>;
  };
}

export interface NativeSavedScriptEditReview extends SavedScriptEditInspection {
  documentFormat:'sequence-v2';modified?:boolean;
  current:{fps:number;totalFrames:number;scriptDocument:ScriptDocument|null;
    clips:Array<{id:string;name:string;kind:string;startFrame:number;endFrame:number;text?:string}>};
}
export type SavedScriptEditReview=LegacySavedScriptEditReview|NativeSavedScriptEditReview;

function inputStateOf(artifact: ScriptEditArtifact): SavedScriptEditingState {
  const editing = artifact.input.editing;
  return {
    scriptDocument: artifact.input.alignment.packet.script,
    fps: editing.fps,
    totalFrames: editing.totalFrames,
    telops: editing.telops.map(telop => ({ ...telop })),
    cutRegions: editing.cutRegions.map(region => ({ ...region })),
    cutOrder: editing.cutOrder.map(anchor => ({ ...anchor })),
  };
}

/** Classify stable on-disk script-related content without claiming that the old browser saved it. */
export function inspectSavedScriptEdit(
  saved: SavedScriptEditingState,
  fingerprint: unknown,
  artifactValue: ScriptEditArtifact,
  modification?: ScriptEditModification,
): LegacySavedScriptEditReview {
  const artifact = parseScriptEditArtifact(artifactValue);
  const plan = resolveScriptEditPlan(artifact, modification);
  const input = inputStateOf(artifact);
  let proposal: SavedScriptEditingState;
  if (plan.kind === 'caption') {
    const replacements = new Map(plan.changes.map(change => [change.telopId, change.after]));
    proposal = { ...input, telops: input.telops.map(telop => ({ ...telop, text: replacements.get(telop.id) ?? telop.text })) };
  } else {
    proposal = { ...input, cutRegions: plan.cutRegions.map(region => ({ ...region })),
      cutOrder: plan.cutOrder.map(anchor => ({ ...anchor })) };
  }
  const stateHash = scriptContentHash(saved);
  const inputStateHash = scriptContentHash(input);
  const proposalStateHash = scriptContentHash(proposal);
  return {
    kind: artifact.proposal.kind,
    ...(modification ? { modified: true } : {}),
    savedState: stateHash === proposalStateHash ? 'proposal' : stateHash === inputStateHash ? 'input' : 'diverged',
    stateHash,
    inputStateHash,
    proposalStateHash,
    fingerprintHash: scriptContentHash(fingerprint),
    presenceHash: createHash('sha256').update(scriptEditingPresenceContent({ ...saved,
      originalTotalFrames: saved.totalFrames })).digest('hex'),
    current: {
      fps: saved.fps,
      totalFrames: saved.totalFrames,
      scriptDocument: saved.scriptDocument,
      scriptDocumentMatchesInput: scriptContentHash(saved.scriptDocument) === scriptContentHash(input.scriptDocument),
      telopsMatchInput: scriptContentHash(saved.telops) === scriptContentHash(input.telops),
      cutRegionsMatchInput: scriptContentHash(saved.cutRegions) === scriptContentHash(input.cutRegions),
      cutOrderMatchInput: scriptContentHash(saved.cutOrder) === scriptContentHash(input.cutOrder),
      targetTelops: plan.kind === 'caption'
        ? plan.changes.map(change => {
          const telop = saved.telops.find(candidate => candidate.id === change.telopId);
          return { id: change.telopId, before: change.before, after: change.after,
            ...(modification && artifact.proposal.kind === 'caption'
              ? { proposedAfter: artifact.proposal.changes.find(c => c.telopId === change.telopId)!.after } : {}),
            current: telop ? { text: telop.text, originalStart: telop.originalStart, originalEnd: telop.originalEnd } : null };
        }) : [],
      cutRegions: saved.cutRegions.map(region => ({ ...region })),
      cutOrder: saved.cutOrder.map(anchor => ({ ...anchor })),
    },
  };
}

export interface EditorPreferencePage { offset?: number; limit?: number; ruleId?: string; version?: number }

export function editorPage(offset = 0, limit = 20) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('INVALID_PAGE: 取得件数は1〜100件で指定してください');
  }
  return { offset, limit };
}
const page = <T,>(items: T[], offset: number, limit: number) => ({ items: items.slice(offset, offset + limit),
  total: items.length, nextOffset: offset + limit < items.length ? offset + limit : null });

/** Read-only discovery. It never assigns profiles, records judgments, or activates rules. */
export class EditorAgentContext {
  inspectSavedScriptEdit(projectId: string, artifact: ScriptEditArtifact, modification?: ScriptEditModification): SavedScriptEditReview {
    const directory=resolveProjectDir(this.root,projectId);
    if(hasSequenceDocument(directory)) return inspectNativeSavedScriptEdit(directory,projectId,artifact,modification);
    const loaded = loadProjectFromDir(directory);
    const project = loaded.project;
    return inspectSavedScriptEdit({
      scriptDocument: project.scriptDocument ?? null,
      fps: project.videoConfig.fps,
      totalFrames: project.videoConfig.durationFrames,
      telops: project.telops.map(({ id, text, originalStart, originalEnd }) => ({ id, text, originalStart, originalEnd })),
      cutRegions: project.cutRegions.map(({ start, end }) => ({ start, end })),
      cutOrder: (project.cutOrder ?? []).map(({ originalStart, originalEnd }) => ({ originalStart, originalEnd })),
    }, loaded.save.fingerprint, artifact, modification);
  }
  validateScriptDecision(request: EditorChangeSet): void {
    if (!request.script) return;
    const artifact = parseScriptEditArtifact(request.script.artifact);
    const ledger = this.preferences.read().decisions;
    const judgment = ledger.events.find(e => e.id === request.script!.judgmentId);
    if (!judgment || judgment.type !== 'script_judgment' || !['accepted', 'accepted_modified'].includes(judgment.decision)
      || judgment.actor.kind !== 'human' || judgment.provenance.kind === 'model'
      || judgment.projectId !== request.projectId || scriptContentHash(judgment.artifact) !== scriptContentHash(artifact)
      || JSON.stringify(judgment.modification) !== JSON.stringify(request.script.modification)
      || ledger.events.some(e => e.type === 'script_judgment' && e.supersedes === judgment.id)) {
      throw new Error('SCRIPT_REVIEW_REQUIRED: 現在の案に対する人の採用記録が必要です');
    }
  }
  constructor(private readonly root: string, private readonly preferences = new PreferenceWorkspaceStore()) {}
  projects(offset = 0, limit = 20, sessions: EditorSessionSummary[] = []) {
    editorPage(offset, limit);
    const projects = scanProjects(this.root).map((project) => ({ id: project.id, name: project.name,
      orientation: project.orientation, durationLabel: project.durationLabel, status: project.status,
      activityLabel: project.activityLabel ?? null, activityStale: project.activityStale ?? false,
      mediaAvailable: project.videoFile !== null && (!project.videoLink || project.videoLink.state === 'ok'),
      sessions: sessions.filter((session) => session.projectId === project.id).sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    })).sort((a, b) => a.id.localeCompare(b.id));
    return { ...page(projects, offset, limit), snapshotHash: preferenceHash(projects) };
  }
  review(operations: EditorOperation[]): PublicEditorOperation[] {
    try {
      const ledger = this.preferences.read().decisions;
      return operations.map((operation) => editorReviewStatus(publicEditorOperation(operation), ledger,
        process.env.HARNESS_PREFERENCE_TEST_FIXTURE === '1'));
    } catch {
      // A missing/corrupt preference journal must not hide an already committed execution receipt.
      return operations.map((operation) => ({ ...publicEditorOperation(operation), humanReview: 'unavailable' }));
    }
  }
  readPreferences(projectId: string, options: EditorPreferencePage = {}) {
    const { offset, limit } = editorPage(options.offset, options.limit);
    if ((options.ruleId === undefined) !== (options.version === undefined)
      || (options.version !== undefined && (!Number.isSafeInteger(options.version) || options.version < 1))) {
      throw new Error('INVALID_RULE_REFERENCE: ルールIDと版を一緒に指定してください');
    }
    if (!scanProjects(this.root).some((project) => project.id === projectId)) {
      throw new Error('PROJECT_NOT_FOUND: 一覧にある案件を指定してください');
    }
    const state = this.preferences.read();
    const profileId = state.projectProfiles[projectId] ?? null;
    const rules = state.rules.filter((rule) => rule.scope.id === profileId)
      .sort((a, b) => a.id.localeCompare(b.id) || b.version - a.version);
    const common = { projectId, profile: state.profiles.find((profile) => profile.id === profileId) ?? null,
      snapshotHash: preferenceHash(state), automaticActivation: false as const };
    if (options.ruleId !== undefined) {
      const rule = rules.find((candidate) => candidate.id === options.ruleId && candidate.version === options.version);
      if (!rule) throw new Error('RULE_NOT_FOUND: この案件の編集方針に該当ルールがありません');
      const eligible = eligibleDecisionExamples(state.decisions);
      // Withdrawal, supersession, no consent, deferred, and synthetic examples are excluded by the same learning contract.
      const examples = rule.evidenceIds.flatMap((id) => {
        const example = eligible.find((entry) => entry.id === id);
        return example ? [{ id: example.id, projectId: example.projectId, elementId: example.elementId,
          sourceFrameRange: example.sourceFrameRange, before: example.before, proposedAfter: example.proposedAfter,
          actualAfter: example.actualAfter, decision: example.decision, reasonCode: example.reasonCode,
          scope: example.scope, provenance: example.provenance.kind }] : [];
      });
      return { ...common, section: 'examples' as const, rule: { id: rule.id, version: rule.version },
        availability: ruleAvailability(rule, state.decisions), ...page(examples, offset, limit) };
    }
    return { ...common, section: 'rules' as const, ...page(rules.map((rule) => ({ id: rule.id, version: rule.version,
      editKind: rule.editKind, conditions: rule.conditions, action: rule.action,
      availability: ruleAvailability(rule, state.decisions),
      excludedForProject: rule.exceptions.projectIds.includes(projectId), evidenceCount: rule.evidenceIds.length,
      evaluationId: rule.activation?.evaluationId ?? null,
    })), offset, limit) };
  }
}
