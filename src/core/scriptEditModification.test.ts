import { describe, expect, it } from 'vitest';
import { scriptAdoptionFixture } from './__fixtures__/scriptAdoption';
import {
  resolveScriptEditPlan,
  validateScriptEditModification,
} from './scriptEditModification';

describe('validateScriptEditModification caption', () => {
  it('accepts one free human replacement for every proposed target and canonicalizes target order', () => {
    const artifact = scriptAdoptionFixture('caption');
    expect(validateScriptEditModification(artifact, {
      kind: 'caption', changes: [{ telopId: 1, after: 'はい！' }],
    })).toEqual({ kind: 'caption', changes: [{ telopId: 1, after: 'はい！' }] });
  });

  it('rejects missing, duplicate, unknown, blank, and overlong caption replacements', () => {
    const artifact = scriptAdoptionFixture('caption');
    expect(() => validateScriptEditModification(artifact, { kind: 'caption', changes: [] }))
      .toThrow(/TARGETS_INCOMPLETE/);
    expect(() => validateScriptEditModification(artifact, {
      kind: 'caption', changes: [{ telopId: 1, after: 'a' }, { telopId: 1, after: 'b' }],
    })).toThrow(/TARGET_DUPLICATE/);
    expect(() => validateScriptEditModification(artifact, {
      kind: 'caption', changes: [{ telopId: 2, after: 'a' }],
    })).toThrow(/TARGET_UNKNOWN/);
    expect(() => validateScriptEditModification(artifact, {
      kind: 'caption', changes: [{ telopId: 1, after: '   ' }],
    })).toThrow(/TEXT_REQUIRED/);
    expect(() => validateScriptEditModification(artifact, {
      kind: 'caption', changes: [{ telopId: 1, after: 'a'.repeat(10_001) }],
    })).toThrow(/INVALID_SCRIPT_MODIFICATION/);
  });

  it('does not mislabel the unchanged current caption or exact model proposal as a correction', () => {
    const artifact = scriptAdoptionFixture('caption');
    expect(() => validateScriptEditModification(artifact, {
      kind: 'caption', changes: [{ telopId: 1, after: 'ハイ' }],
    })).toThrow(/NO_SCRIPT_MODIFICATION.*却下/);
    expect(() => validateScriptEditModification(artifact, {
      kind: 'caption', changes: [{ telopId: 1, after: 'はい' }],
    })).toThrow(/NO_SCRIPT_MODIFICATION.*採用/);
  });
});

describe('validateScriptEditModification structure', () => {
  it('rejects a different kind, empty/range-invalid input, duplicates, and overlap', () => {
    const artifact = scriptAdoptionFixture('structure');
    expect(() => validateScriptEditModification(artifact, {
      kind: 'caption', changes: [{ telopId: 1, after: '自由文' }],
    })).toThrow(/KIND_MISMATCH/);
    expect(() => validateScriptEditModification(artifact, { kind: 'structure', cutOrder: [] }))
      .toThrow(/STRUCTURE_EMPTY/);
    expect(() => validateScriptEditModification(artifact, {
      kind: 'structure', cutOrder: [{ originalStart: 10, originalEnd: 61 }],
    })).toThrow(/RANGE_INVALID/);
    expect(() => validateScriptEditModification(artifact, {
      kind: 'structure', cutOrder: [
        { originalStart: 10, originalEnd: 20 },
        { originalStart: 10, originalEnd: 20 },
      ],
    })).toThrow(/RANGE_DUPLICATE/);
    expect(() => validateScriptEditModification(artifact, {
      kind: 'structure', cutOrder: [
        { originalStart: 10, originalEnd: 30 },
        { originalStart: 20, originalEnd: 40 },
      ],
    })).toThrow(/RANGE_OVERLAP/);
  });

  it('does not record the current source order or exact model plan as a correction', () => {
    const artifact = scriptAdoptionFixture('structure');
    expect(() => validateScriptEditModification(artifact, {
      kind: 'structure', cutOrder: [{ originalStart: 0, originalEnd: 60 }],
    })).toThrow(/NO_SCRIPT_MODIFICATION.*却下/);
    expect(() => validateScriptEditModification(artifact, {
      kind: 'structure', cutOrder: [{ originalStart: 15, originalEnd: 45 }],
    })).toThrow(/NO_SCRIPT_MODIFICATION.*採用/);
  });
});

describe('resolveScriptEditPlan', () => {
  it('keeps existing proposal behavior when no modification is supplied', () => {
    expect(resolveScriptEditPlan(scriptAdoptionFixture('caption'))).toEqual({
      kind: 'caption', changes: [{ telopId: 1, before: 'ハイ', after: 'はい' }],
    });
    expect(resolveScriptEditPlan(scriptAdoptionFixture('structure'))).toEqual({
      kind: 'structure',
      cutRegions: [{ start: 0, end: 15 }, { start: 45, end: 60 }],
      cutOrder: [{ originalStart: 15, originalEnd: 45 }],
    });
  });

  it('uses human caption text while retaining model target and before text', () => {
    expect(resolveScriptEditPlan(scriptAdoptionFixture('caption'), {
      kind: 'caption', changes: [{ telopId: 1, after: '人が直した本文' }],
    })).toEqual({
      kind: 'caption', changes: [{ telopId: 1, before: 'ハイ', after: '人が直した本文' }],
    });
  });

  it('derives complement cuts from trimmed ranges while preserving human playback order and the artifact', () => {
    const artifact = scriptAdoptionFixture('structure');
    const snapshot = structuredClone(artifact);
    const modification = {
      kind: 'structure' as const,
      cutOrder: [
        { originalStart: 30, originalEnd: 50 },
        { originalStart: 5, originalEnd: 20 },
      ],
    };

    expect(resolveScriptEditPlan(artifact, modification)).toEqual({
      kind: 'structure',
      cutRegions: [{ start: 0, end: 5 }, { start: 20, end: 30 }, { start: 50, end: 60 }],
      cutOrder: modification.cutOrder,
    });
    expect(artifact).toEqual(snapshot);
    expect(artifact.proposal.generator.provider).toBe('fixture');
  });
});
