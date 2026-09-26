import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProjectFromDir } from './loadProjectFiles';
import { saveProjectToDir, validateSaveRequest } from './saveProject';
import { buildPlaybackModel } from '../preview/playbackModel';
import { projectContentSignature, projectWatchPaths } from './projectWatchPaths';
import type { SaveRequest } from '../shared/types';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sme-placement-save-')); dirs.push(dir);
  cpSync(resolve(import.meta.dirname, '__fixtures__/sample-project'), dir, { recursive: true });
  return dir;
}
function request(dir: string): SaveRequest {
  const p = loadProjectFromDir(dir);
  return { project: structuredClone(p.project), fingerprint: structuredClone(p.save.fingerprint) };
}
function place(req: SaveRequest) {
  const duration = req.project.videoConfig.durationFrames;
  const mid = Math.floor(duration / 2);
  req.project.cutRegions = [];
  req.project.cutOrder = [{ originalStart: mid, originalEnd: duration }, { originalStart: 0, originalEnd: mid }];
  req.project.images = [{ id: 50, originalStart: 0, originalEnd: 10, file: 'owned.png', type: 'photo', scale: 0.7,
    timelinePlacement: { startFrame: duration - mid - 5, endFrame: duration - mid + 5 } }];
  return req.project.images[0]!;
}

describe('independent asset persistence', () => {
  it('saves a join-crossing placement and its binding atomically, then reloads exact final time', () => {
    const dir = fixture(), req = request(dir), image = place(req);
    expect(req.fingerprint.editorTimeline).toBeNull();
    const result = saveProjectToDir(dir, req);
    expect(result.fingerprint.editorTimeline?.relPath).toBe('editor-timeline.json');
    const reloaded = loadProjectFromDir(dir);
    expect(reloaded.project.images[0]).toMatchObject(image);
    expect(buildPlaybackModel(reloaded.project).images[0]).toMatchObject({ playbackStart: image.timelinePlacement!.startFrame, playbackEnd: image.timelinePlacement!.endFrame });
    const bytes = readFileSync(join(dir, 'editor-timeline.json'), 'utf8');
    saveProjectToDir(dir, request(dir));
    expect(readFileSync(join(dir, 'editor-timeline.json'), 'utf8')).toBe(bytes);
  });

  it('detects binding-only external changes, including changes that were absent at load', () => {
    const dir = fixture(), req = request(dir);
    const before = projectContentSignature(dir);
    writeFileSync(join(dir, 'editor-timeline.json'), '{"version":1,"placements":[]}\n');
    expect(projectWatchPaths(dir)).toContain(join(dir, 'editor-timeline.json'));
    expect(projectContentSignature(dir)).not.toBe(before);
    expect(() => saveProjectToDir(dir, req)).toThrow(/editor-timeline.json.*外部で変更/);
    const fresh = request(dir);
    writeFileSync(join(dir, 'editor-timeline.json'), '{"version":1, "placements":[]}\n');
    expect(() => saveProjectToDir(dir, fresh)).toThrow(/editor-timeline.json.*外部で変更/);
  });

  it('does not add a marker to legacy projects, but clears the last binding in the write batch', () => {
    const dir = fixture();
    saveProjectToDir(dir, request(dir));
    expect(existsSync(join(dir, 'editor-timeline.json'))).toBe(false);
    const req = request(dir); place(req); saveProjectToDir(dir, req);
    const remove = request(dir); remove.project.images = []; saveProjectToDir(dir, remove);
    expect(JSON.parse(readFileSync(join(dir, 'editor-timeline.json'), 'utf8'))).toEqual({ version: 1, placements: [] });
    expect(loadProjectFromDir(dir).project.images).toEqual([]);
  });

  it('rejects invalid final frames before changing any saved asset data', () => {
    const dir = fixture(), req = request(dir), image = place(req);
    image.timelinePlacement!.endFrame = Number.NaN;
    const before = projectContentSignature(dir);
    expect(() => saveProjectToDir(dir, req)).toThrow(/配置|範囲/);
    expect(projectContentSignature(dir)).toBe(before);
    expect(() => validateSaveRequest({ ...req, fingerprint: { ...req.fingerprint, editorTimeline: 1 } })).toThrow(/fingerprint.editorTimeline/);
  });

  it('prevents an old editor from reinterpreting final clock assets, even with overwrite', () => {
    const dir = fixture(), req = request(dir); place(req); saveProjectToDir(dir, req);
    const old = request(dir); delete old.fingerprint.editorTimeline;
    delete old.project.images[0]!.timelinePlacement;
    const before = projectContentSignature(dir);
    expect(() => saveProjectToDir(dir, old)).toThrow(/対応した画面/);
    expect(() => saveProjectToDir(dir, { ...old, overwrite: true })).toThrow(/対応した画面/);
    expect(projectContentSignature(dir)).toBe(before);
  });
});
