import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLiteralAlignments } from '../core/scriptAlignment';
import { createScriptDocument } from '../core/scriptDocumentData';
import { createScriptEditArtifact, sealScriptEditInput } from '../server/scriptEditArtifacts';
import { createScriptProposalArtifact, sealScriptInputPacket } from '../server/scriptProposalArtifacts';
import {
  appendDecisionEvent,
  decisionEventSchema,
  eligibleScriptDecisionExamples,
  emptyDecisionLedger,
  parseDecisionLedger,
  type DecisionLedger,
} from './preferenceDecisions';
import { PreferenceWorkspaceStore } from './preferenceWorkspaceStore';
import { scriptJudgmentSchema } from './scriptDecisions';

const script = createScriptDocument('はい', { documentId: 'script', revision: 'script-1' });
const generator = {
  skillId: 'subtitle-orthography' as const,
  skillVersion: '1', provider: 'fixture', model: 'fixture', configHash: '0'.repeat(64),
};
const packet = sealScriptInputPacket({
  schemaVersion: 1, packetHash: '0'.repeat(64), projectId: 'project', editRevision: 'edit-1',
  source: { id: 'main.mp4', revision: 'source-1', durationMs: 1000 }, script,
  transcript: { revision: 'transcript-1', words: [{ index: 0, text: 'はい', startMs: 0, endMs: 1000 }] },
});
const input = sealScriptEditInput({
  schemaVersion: 1, inputHash: '0'.repeat(64),
  alignment: createScriptProposalArtifact(packet, buildLiteralAlignments(packet, generator)),
  editing: {
    fps: 30, totalFrames: 30,
    telops: [{ id: 1, text: 'ハイ', originalStart: 0, originalEnd: 30 }],
    cutRegions: [], cutOrder: [],
  },
});
const artifact = createScriptEditArtifact(input, {
  schemaVersion: 1, kind: 'caption', proposalId: `script-edit:caption:${input.inputHash}`,
  inputHash: input.inputHash, generator,
  passages: [{ passageId: script.passages[0]!.id, action: 'use', candidateIndex: 0, reason: '台本に合わせる' }],
  changes: [{
    telopId: 1, before: 'ハイ', after: 'はい', passageId: script.passages[0]!.id,
    scriptRange: { start: 0, end: 2 },
    wordRef: { transcriptRevision: 'transcript-1', startIndex: 0, endIndex: 1 },
  }],
});

function judgment(id: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, type: 'script_judgment', id, operationId: `judge:${id}`,
    createdAt: '2026-09-08T00:00:00Z', actor: { kind: 'human', id: 'owner' },
    projectId: 'project', projectRevision: 'edit-1', artifact,
    decision: 'accepted', reasonCode: 'unspecified', note: '', learningConsent: true,
    scope: { kind: 'project', id: 'project' }, provenance: { kind: 'human' },
    ...overrides,
  };
}

function append(ledger: DecisionLedger, event: unknown): DecisionLedger {
  return appendDecisionEvent(ledger, event);
}

function withdrawal(id: string, targetId: string) {
  return {
    schemaVersion: 1, type: 'withdrawal', id, operationId: `withdraw:${id}`,
    createdAt: '2026-09-08T00:01:00Z', actor: { kind: 'human', id: 'owner' },
    targetId, reason: '判断を撤回',
  };
}

describe('script judgment ledger', () => {
  it('records accepted, rejected, and deferred with an explicit unspecified reason and empty note', () => {
    let ledger = append(emptyDecisionLedger(), judgment('accepted'));
    ledger = append(ledger, judgment('rejected', { decision: 'rejected' }));
    ledger = append(ledger, judgment('deferred', { decision: 'deferred' }));
    expect(ledger.events.map(event => event.type === 'script_judgment'
      ? [event.decision, event.reasonCode, event.note] : null)).toEqual([
      ['accepted', 'unspecified', ''], ['rejected', 'unspecified', ''], ['deferred', 'unspecified', ''],
    ]);
  });

  it('requires a successful-save judgment ID for acceptance, keeps consented rejection, and never learns from deferred', () => {
    let ledger = append(emptyDecisionLedger(), judgment('accepted'));
    ledger = append(ledger, judgment('rejected', { decision: 'rejected' }));
    ledger = append(ledger, judgment('rejected-without-consent', { decision: 'rejected', learningConsent: false }));
    ledger = append(ledger, judgment('deferred', { decision: 'deferred' }));
    expect(eligibleScriptDecisionExamples(ledger, new Set()).map(event => event.id)).toEqual(['rejected']);
    expect(eligibleScriptDecisionExamples(ledger, new Set(['accepted', 'deferred'])).map(event => event.id))
      .toEqual(['accepted', 'rejected']);
  });

  it('uses only human/imported-human labels and cannot opt synthetic or model provenance into learning', () => {
    let ledger = append(emptyDecisionLedger(), judgment('synthetic', { provenance: { kind: 'synthetic' } }));
    ledger = append(ledger, judgment('imported', { decision: 'rejected', provenance: { kind: 'imported_human' } }));
    expect(eligibleScriptDecisionExamples(ledger, new Set(['synthetic'])) .map(event => event.id)).toEqual(['imported']);
    expect(() => decisionEventSchema.parse(judgment('model-actor', {
      actor: { kind: 'model', id: 'agent' }, learningConsent: false,
    }))).toThrow(/HUMAN_REQUIRED/);
    expect(() => decisionEventSchema.parse(judgment('model-source', {
      provenance: { kind: 'model' }, learningConsent: false,
    }))).toThrow(/HUMAN_REQUIRED/);
  });

  it('resolves corrections and withdrawals without reviving an older accepted judgment', () => {
    let ledger = append(emptyDecisionLedger(), judgment('original'));
    ledger = append(ledger, judgment('corrected', { supersedes: 'original', decision: 'rejected' }));
    expect(eligibleScriptDecisionExamples(ledger, new Set(['original'])).map(event => event.id)).toEqual(['corrected']);
    ledger = append(ledger, withdrawal('withdraw-corrected', 'corrected'));
    expect(eligibleScriptDecisionExamples(ledger, new Set(['original'])).map(event => event.id)).toEqual([]);
    ledger = append(ledger, judgment('after-withdrawal', { supersedes: 'corrected', learningConsent: false }));
    expect(ledger.events).toHaveLength(4);
    expect(eligibleScriptDecisionExamples(ledger, new Set(['original', 'after-withdrawal']))).toEqual([]);
  });

  it('requires a new save receipt when a correction changes the final judgment to accepted', () => {
    let ledger = append(emptyDecisionLedger(), judgment('original', { decision: 'rejected' }));
    ledger = append(ledger, judgment('corrected', { supersedes: 'original' }));
    expect(eligibleScriptDecisionExamples(ledger, new Set(['original']))).toEqual([]);
    expect(eligibleScriptDecisionExamples(ledger, new Set(['corrected'])).map(event => event.id)).toEqual(['corrected']);
  });

  it('requires a real human modification only for accepted_modified', () => {
    const modification = { kind: 'caption', changes: [{ telopId: 1, after: 'はい！' }] };
    const modified = scriptJudgmentSchema.parse(judgment('modified', {
      decision: 'accepted_modified', modification,
    }));
    expect(modified.modification).toEqual(modification);
    expect(modified.actor).toEqual({ kind: 'human', id: 'owner' });
    expect(modified.artifact.proposal.generator).toEqual(generator);
    expect(() => scriptJudgmentSchema.parse(judgment('missing', { decision: 'accepted_modified' })))
      .toThrow(/SCRIPT_MODIFICATION_REQUIRED/);
    expect(() => decisionEventSchema.parse(judgment('unmodified', { modification })))
      .toThrow(/SCRIPT_MODIFICATION_NOT_ALLOWED/);
    expect(() => decisionEventSchema.parse(judgment('same-as-model', {
      decision: 'accepted_modified',
      modification: { kind: 'caption', changes: [{ telopId: 1, after: 'はい' }] },
    }))).toThrow(/NO_SCRIPT_MODIFICATION/);
  });

  it('learns a consented human modified acceptance only after its judgment ID is saved', () => {
    const modified = judgment('modified', {
      decision: 'accepted_modified',
      modification: { kind: 'caption', changes: [{ telopId: 1, after: 'はい！' }] },
    });
    const ledger = append(emptyDecisionLedger(), modified);
    expect(eligibleScriptDecisionExamples(ledger, new Set())).toEqual([]);
    expect(eligibleScriptDecisionExamples(ledger, new Set(['modified'])).map(event => event.id)).toEqual(['modified']);
  });

  it('rejects forged imports and missing reason text', () => {
    expect(() => decisionEventSchema.parse(judgment('other', { reasonCode: 'other', note: '' }))).toThrow(/SCRIPT_JUDGMENT_REASON/);
    expect(() => parseDecisionLedger({ schemaVersion: 1, events: [judgment('forged', {
      actor: { kind: 'model', id: 'agent' }, learningConsent: false,
    })] })).toThrow(/HUMAN_REQUIRED/);
  });

  it('replays and imports the same human script decision atomically through the preference workspace', () => {
    const sourceDir = mkdtempSync(path.join(os.tmpdir(), 'script-decision-source-'));
    const targetDir = mkdtempSync(path.join(os.tmpdir(), 'script-decision-target-'));
    try {
      const event = decisionEventSchema.parse(judgment('workspace'));
      const command = {
        operationId: event.operationId, at: event.createdAt, actor: event.actor,
        kind: 'decision', event,
      };
      const source = new PreferenceWorkspaceStore(sourceDir);
      expect(source.execute(command).decisions.events).toHaveLength(1);
      expect(source.execute(command).decisions.events).toHaveLength(1);
      const missingProfile = decisionEventSchema.parse(judgment('missing-profile', {
        scope: { kind: 'profile', id: 'missing' },
      }));
      expect(() => source.execute({
        operationId: missingProfile.operationId, at: missingProfile.createdAt,
        actor: missingProfile.actor, kind: 'decision', event: missingProfile,
      })).toThrow(/PROFILE_NOT_FOUND/);

      const target = new PreferenceWorkspaceStore(targetDir);
      target.import(JSON.parse(source.export()));
      expect(target.export()).toBe(source.export());
      const saved = target.export();
      const forged = JSON.parse(source.export()) as { commands: Array<Record<string, unknown>> };
      forged.commands[0] = {
        ...forged.commands[0],
        actor: { kind: 'model', id: 'agent' },
        event: { ...(forged.commands[0]!.event as object), actor: { kind: 'model', id: 'agent' } },
      };
      expect(() => target.import(forged)).toThrow(/HUMAN_REQUIRED/);
      expect(target.export()).toBe(saved);
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});
