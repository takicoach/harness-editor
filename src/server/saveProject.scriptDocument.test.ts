import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createScriptDocument, serializeScriptDocumentData } from '../core/scriptDocumentData';
import type { SaveRequest } from '../shared/types';
import { HttpError } from './http';
import { loadProjectFromDir } from './loadProjectFiles';
import { saveProjectToDir, validateSaveRequest } from './saveProject';

const SAMPLE = resolve(import.meta.dirname, '__fixtures__', 'sample-project');
const dirs: string[] = [];
function projectCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sme-script-save-'));
  dirs.push(dir);
  cpSync(SAMPLE, dir, { recursive: true });
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function request(dir: string): SaveRequest {
  const loaded = loadProjectFromDir(dir);
  return { project: structuredClone(loaded.project), fingerprint: structuredClone(loaded.save.fingerprint) };
}

describe('shooting-script.json project save', () => {
  it('不在からstrict文書をatomic saveし、load/fingerprintへ対称に戻す', () => {
    const dir = projectCopy();
    const req = request(dir);
    expect(req.project.scriptDocument).toBeNull();
    expect(req.fingerprint.scriptDocument).toBeNull();
    const document = createScriptDocument('挨拶\n結論 12.5%', { documentId: 'shooting', revision: 'script-1' });
    req.project.scriptDocument = document;
    const result = saveProjectToDir(dir, req);
    expect(result.fingerprint.scriptDocument?.relPath).toBe('shooting-script.json');
    expect(readFileSync(join(dir, 'shooting-script.json'), 'utf8')).toBe(serializeScriptDocumentData(document));
    expect(loadProjectFromDir(dir).project.scriptDocument).toEqual(document);
  });

  it('同値文書と旧payload省略は既存byteを保持し、明示nullだけが削除する', () => {
    const dir = projectCopy();
    const document = createScriptDocument('本文', { documentId: 'shooting', revision: 'script-1' });
    writeFileSync(join(dir, 'shooting-script.json'), JSON.stringify(document));
    const same = request(dir);
    const originalBytes = readFileSync(join(dir, 'shooting-script.json'), 'utf8');
    saveProjectToDir(dir, same);
    expect(readFileSync(join(dir, 'shooting-script.json'), 'utf8')).toBe(originalBytes);

    const old = request(dir);
    delete old.project.scriptDocument;
    delete old.fingerprint.scriptDocument;
    const changedByAnotherWriter = createScriptDocument('別の画面の本文', { documentId: 'shooting', revision: 'script-2' });
    writeFileSync(join(dir, 'shooting-script.json'), JSON.stringify(changedByAnotherWriter, null, 4));
    saveProjectToDir(dir, old);
    expect(readFileSync(join(dir, 'shooting-script.json'), 'utf8')).toBe(JSON.stringify(changedByAnotherWriter, null, 4));

    const remove = request(dir);
    remove.project.scriptDocument = null;
    saveProjectToDir(dir, remove);
    expect(existsSync(join(dir, 'shooting-script.json'))).toBe(false);
  });

  it('明示変更は外部変更と競合し、unknown keyを保存前に400で拒否する', () => {
    const dir = projectCopy();
    const first = createScriptDocument('最初', { documentId: 'shooting', revision: 'script-1' });
    writeFileSync(join(dir, 'shooting-script.json'), serializeScriptDocumentData(first));
    const req = request(dir);
    req.project.scriptDocument = createScriptDocument('更新', { documentId: 'shooting', revision: 'script-2' });
    writeFileSync(join(dir, 'shooting-script.json'), serializeScriptDocumentData(
      createScriptDocument('外部更新', { documentId: 'shooting', revision: 'script-3' }),
    ));
    expect(() => saveProjectToDir(dir, req)).toThrow(/shooting-script\.json.*外部で変更/);

    const malformed = structuredClone(request(dir)) as unknown as Record<string, unknown>;
    const project = malformed.project as Record<string, unknown>;
    project.scriptDocument = { ...first, applied: true };
    try {
      validateSaveRequest(malformed);
      throw new Error('expected validation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(400);
    }
  });
});
