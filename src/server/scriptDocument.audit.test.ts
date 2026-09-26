import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProjectFromDir } from './loadProjectFiles';
import { saveProjectToDir } from './saveProject';
import { createEditState, toEditorProject } from '../app/edit/editState';
import { setShootingScriptText } from '../app/edit/scriptOps';
import { collectScriptAlignmentArtifact } from './scriptAlignmentApi';

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'script-independent-save-')); dirs.push(dir);
  cpSync(resolve(import.meta.dirname, '__fixtures__/sample-project'), dir, { recursive: true });
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('independent shooting script save audit', () => {
  it.each(['script', 'source'] as const)('rejects %s changes during asynchronous source collection', async target => {
    const dir = fixture();
    const loaded = loadProjectFromDir(dir);
    const changed = setShootingScriptText(createEditState(loaded.project), '撮影台本');
    saveProjectToDir(dir, { project: toEditorProject(changed, loaded.project), fingerprint: loaded.save.fingerprint });
    // Inject only the probe boundary to deterministically simulate a concurrent writer after hashing.
    await expect(collectScriptAlignmentArtifact('owned', dir, { mode: 'caption' }, { probeSource: async () => {
      const file = target === 'script' ? join(dir, 'shooting-script.json') : join(dir, 'public', loaded.project.videoConfig.videoFile);
      if (target === 'script') {
        const data = JSON.parse(readFileSync(file, 'utf8'));
        data.revision = 'concurrent-change'; writeFileSync(file, JSON.stringify(data));
      } else writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from('changed')]));
      const video = loaded.project.videoConfig;
      return { fps: video.fps, durationSeconds: video.durationFrames / video.fps, width: 1280, height: 720 };
    } })).rejects.toMatchObject({ status: 409 });
  });

  it('roundtrips through actual EditState and disk while retaining caption anchors and cut order', () => {
    const dir = fixture();
    const loaded = loadProjectFromDir(dir);
    const state = createEditState(loaded.project);
    const changed = setShootingScriptText(state, ' 台本😀\r\n二行目');
    const outgoing = toEditorProject(changed, loaded.project);
    saveProjectToDir(dir, { project: outgoing, fingerprint: loaded.save.fingerprint });
    const reloaded = loadProjectFromDir(dir);
    expect(reloaded.project.scriptDocument).toEqual(changed.scriptDocument);
    expect(reloaded.project.telops).toEqual(loaded.project.telops);
    expect(reloaded.project.cutRegions).toEqual(loaded.project.cutRegions);
    expect(reloaded.project.cutOrder).toEqual(loaded.project.cutOrder);
    const reset = toEditorProject(state, reloaded.project);
    saveProjectToDir(dir, { project: reset, fingerprint: reloaded.save.fingerprint });
    expect(loadProjectFromDir(dir).project.scriptDocument).toBeNull();
  });

  it('rejects a stale explicit deletion even when the client omitted the new fingerprint', () => {
    const dir = fixture();
    const loaded = loadProjectFromDir(dir);
    const changed = setShootingScriptText(createEditState(loaded.project), '別画面の原稿');
    saveProjectToDir(dir, { project: toEditorProject(changed, loaded.project), fingerprint: loaded.save.fingerprint });
    const bytes = readFileSync(join(dir, 'shooting-script.json'), 'utf8');
    const staleFingerprint = { ...loaded.save.fingerprint };
    delete staleFingerprint.scriptDocument;
    expect(() => saveProjectToDir(dir, { project: { ...loaded.project, scriptDocument: null }, fingerprint: staleFingerprint })).toThrow();
    expect(readFileSync(join(dir, 'shooting-script.json'), 'utf8')).toBe(bytes);
  });

  it('never overwrites a corrupt script while saving an unrelated caption edit', () => {
    const dir = fixture();
    const loaded = loadProjectFromDir(dir);
    writeFileSync(join(dir, 'shooting-script.json'), '{broken');
    const outgoing = structuredClone(loaded.project);
    outgoing.telops[0]!.text = '変更';
    const telopPath = join(dir, loaded.save.telopDataRelPath);
    const before = readFileSync(telopPath, 'utf8');
    expect(() => saveProjectToDir(dir, { project: outgoing, fingerprint: loaded.save.fingerprint })).toThrow();
    expect(readFileSync(join(dir, 'shooting-script.json'), 'utf8')).toBe('{broken');
    expect(readFileSync(telopPath, 'utf8')).toBe(before);
  });
});
