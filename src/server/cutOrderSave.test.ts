import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCutOrdering } from '../core/cutOrder';
import { loadProjectFromDir } from './loadProjectFiles';
import { saveProjectToDir, validateSaveRequest } from './saveProject';

const SAMPLE = resolve(__dirname, '__fixtures__', 'sample-project');

describe('cutOrder save', () => {
  it('persists a client reorder and reloads the same source sequence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sme-cut-order-save-'));
    cpSync(SAMPLE, dir, { recursive: true });
    try {
      const loaded = loadProjectFromDir(dir);
      const before = buildCutOrdering(
        loaded.project.videoConfig.durationFrames,
        loaded.project.cutRegions,
        loaded.project.cutOrder,
      ).segments;
      expect(before.length).toBeGreaterThan(1);
      const reversed = [...before].reverse().map(({ originalStart, originalEnd }) => ({ originalStart, originalEnd }));
      saveProjectToDir(dir, {
        project: { ...loaded.project, cutOrder: reversed },
        fingerprint: loaded.save.fingerprint,
      });
      const reloaded = loadProjectFromDir(dir);
      expect(reloaded.project.cutOrder).toEqual(reversed);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves an existing reorder when an old payload omits cutOrder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sme-cut-order-legacy-'));
    cpSync(SAMPLE, dir, { recursive: true });
    try {
      const loaded = loadProjectFromDir(dir);
      const anchors = buildCutOrdering(loaded.project.videoConfig.durationFrames, loaded.project.cutRegions, loaded.project.cutOrder)
        .segments.reverse().map(({ originalStart, originalEnd }) => ({ originalStart, originalEnd }));
      saveProjectToDir(dir, { project: { ...loaded.project, cutOrder: anchors }, fingerprint: loaded.save.fingerprint });
      const reordered = loadProjectFromDir(dir);
      const { cutOrder: _omitted, ...legacyProject } = reordered.project;
      saveProjectToDir(dir, { project: legacyProject, fingerprint: reordered.save.fingerprint });
      expect(loadProjectFromDir(dir).project.cutOrder).toEqual(anchors);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed, out-of-range, and overlapping source anchors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sme-cut-order-invalid-'));
    cpSync(SAMPLE, dir, { recursive: true });
    try {
      const loaded = loadProjectFromDir(dir);
      const request = (cutOrder: unknown) => ({
        project: { ...loaded.project, cutOrder },
        fingerprint: loaded.save.fingerprint,
      });
      expect(() => validateSaveRequest(request([{ originalStart: 0.5, originalEnd: 10 }]))).toThrow(/cutOrder/);
      expect(() => validateSaveRequest(request([{ originalStart: 0, originalEnd: loaded.project.videoConfig.durationFrames + 1 }]))).toThrow(/cutOrder/);
      expect(() => validateSaveRequest(request([
        { originalStart: 0, originalEnd: 100 },
        { originalStart: 50, originalEnd: 150 },
      ]))).toThrow(/cutOrder/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
