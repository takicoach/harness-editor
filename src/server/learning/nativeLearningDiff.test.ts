import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeNativeLearningDiff, countAiEditsAfterImport, NATIVE_BASELINE_LABEL } from './nativeLearningDiff';
import { createImportedProject, markAddedInEditor, standardEdit, standardFinish, type ImportedProjectFixture } from './__fixtures__/importedProject';
import { HttpError } from '../http';

/** 案件フォルダ内の全ファイルの相対パスと中身（base64）。読むだけの処理が何も書かないことの確認に使う。 */
function projectFiles(dir: string): Array<[string, string]> {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort()
    .filter((name) => statSync(join(dir, name)).isFile())
    .map((name) => [name, readFileSync(join(dir, name)).toString('base64')]);
}

let fixture: ImportedProjectFixture | undefined;
let learningHome = '';
beforeEach(() => {
  learningHome = mkdtempSync(join(tmpdir(), 'harness-native-learning-home-'));
  vi.stubEnv('HARNESS_LEARNING_HOME', learningHome);
});
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
  vi.unstubAllEnvs();
  rmSync(learningHome, { recursive: true, force: true });
});

describe('computeNativeLearningDiff', () => {
  it('標準試料: 比較元（取り込み時点の旧ファイル）と書き出した文書の差分を返す', async () => {
    fixture = await createImportedProject({ edit: standardEdit, finish: standardFinish });
    // 複製元の sample-project は基準ファイルを持っているので、消してから始める（残したままだと
    // loadProjectFromDir を呼んでも何も新しく書かれず、下の前後一致が空振りで通る）。
    const baselineFiles = [join(fixture.dir, 'cut-baseline.json'), join(fixture.dir, '.learning')];
    baselineFiles.forEach((path) => rmSync(path, { recursive: true, force: true }));
    expect(baselineFiles.filter((path) => existsSync(path))).toEqual([]);
    const before = projectFiles(fixture.dir);
    const result = await computeNativeLearningDiff(fixture.dir, fixture.jobId);
    expect(result.eligible).toBe(true);
    const diff = result.response;
    expect(diff.cut?.map((c) => [c.kind, c.startFrame, c.endFrame, c.text])).toEqual([['added-cut', 100, 115, 'えー'], ['restored-cut', 120, 150, 'あの']]);
    expect(diff.words).toBeNull();
    expect(diff.telops?.map((t) => [t.kind, t.before, t.after])).toEqual([
      ['changed', 'ゆる素振り', 'ゆるい素振り'], ['removed', 'つなぎ目の後ろ', ''], ['added', '', '追加した字幕']]);
    expect(diff.ses?.map((s) => [s.kind, s.file, s.nearbyText])).toEqual([['added', 'whoosh.mp3', '追加した字幕'], ['removed', 'beep.mp3', 'ゆる素振り']]);
    expect(diff.aiEditCount).toBe(0);
    expect(diff.baselineLabel).toBe(NATIVE_BASELINE_LABEL);
    expect(diff.candidateKey).toEqual({ jobId: fixture.jobId, documentId: 'doc-a', contentHash: fixture.contentHash });
    // 差分を読むだけで案件を書き換えない（基準ファイルを作る loadProjectFromDir を使っていない）。
    expect(baselineFiles.filter((path) => existsSync(path))).toEqual([]);
    expect(projectFiles(fixture.dir)).toEqual(before);
  });

  it('空の cutData（旧ファイル上は全カット）は、仕上げに残る範囲をすべて restored-cut にする', async () => {
    fixture = await createImportedProject({ legacy: { cutData: 'export const cutData: { id: number; originalStart: number; originalEnd: number; playbackStart: number; playbackEnd: number }[] = [];\n' },
      edit: (project) => { project.cutRegions = []; } });
    const { response } = await computeNativeLearningDiff(fixture.dir, fixture.jobId);
    expect(response.cut).toEqual([{ kind: 'restored-cut', startFrame: 0, endFrame: 300, startSec: 0, endSec: 10, text: 'ゆる素振りえーあの' }]);
  });

  it('映像カットで cutArchive へ移ったテロップは削除に数えない', async () => {
    fixture = await createImportedProject({ edit: (project) => { project.cutRegions = [{ start: 120, end: 150 }, { start: 155, end: 215 }]; } });
    // 存在検査: 試料が本当に「本編に無く cutArchive にある」状態になっていること。
    expect(fixture.document.clips.some((c) => c.content.kind === 'telop' && c.content.legacyId === 3)).toBe(false);
    expect(fixture.document.cutArchive?.entries.some((e) => e.clips.some((c) => c.content.kind === 'telop' && c.content.legacyId === 3))).toBe(true);
    const { response } = await computeNativeLearningDiff(fixture.dir, fixture.jobId);
    expect(response.telops).toEqual([]);
    expect(response.cut?.map((c) => [c.kind, c.startFrame, c.endFrame])).toEqual([['added-cut', 155, 215]]);
  });

  it('カットで分かれたテロップ: 違う本文が1種類なら修正、2種類ならあいまいなので候補にしない', async () => {
    const split = (texts: [string, string]) => createImportedProject({
      edit: (project) => { project.cutRegions = [{ start: 120, end: 150 }, { start: 75, end: 85 }]; },
      finish: (document) => {
        const parts = document.clips.filter((c) => c.content.kind === 'telop' && c.content.legacyId === 2).sort((a, b) => a.startFrame - b.startFrame);
        expect(parts).toHaveLength(2); // 存在検査: 本当に2断片に分かれている
        parts.forEach((part, index) => { if (part.content.kind === 'telop') part.content.data.text = texts[index]!; });
      } });
    fixture = await split(['長いアイアン', '長いアイアンです']);
    expect((await computeNativeLearningDiff(fixture.dir, fixture.jobId)).response.telops?.map((t) => [t.kind, t.before, t.after]))
      .toEqual([['changed', '長いアイアン', '長いアイアンです']]);
    fixture.cleanup();
    fixture = await split(['A版', 'B版']);
    expect((await computeNativeLearningDiff(fixture.dir, fixture.jobId)).response.telops).toEqual([]);
  });

  it('新エディターで作った案件（legacy なし）は対象外（全カテゴリ null）', async () => {
    fixture = await createImportedProject({ finish: (document) => { delete document.legacy; } });
    const result = await computeNativeLearningDiff(fixture.dir, fixture.jobId);
    expect(result.eligible).toBe(false);
    expect(result.response).toMatchObject({ cut: null, words: null, telops: null, ses: null });
  });

  it('旧形式のまま書き出したジョブ（記録 version 3）は対象外（人の仕上げではない）', async () => {
    fixture = await createImportedProject({ edit: standardEdit, finish: standardFinish, recordVersion: 3 });
    // 存在検査: 記録は本当に version 3 として保存され、読み込みの検査（記録・入力の整合）も通る状態であること。
    const manifest = JSON.parse(readFileSync(join(fixture.dir, '.harness', 'exports', fixture.jobId, 'manifest.json'), 'utf8')) as { record: { version: number } };
    expect(manifest.record.version).toBe(3);
    const result = await computeNativeLearningDiff(fixture.dir, fixture.jobId);
    expect(result).toMatchObject({ eligible: false, reason: '旧形式のまま書き出したジョブには新エディターでの仕上げがありません',
      response: { cut: null, words: null, telops: null, ses: null } });
  });

  it('取り込み後に旧形式の telopData.ts が消えた案件は対象外', async () => {
    fixture = await createImportedProject({ edit: standardEdit, finish: standardFinish });
    const telopData = join(fixture.dir, 'src', 'テロップテンプレート', 'telopData.ts');
    rmSync(telopData);
    expect(existsSync(telopData)).toBe(false); // 存在検査: 本当に消えている
    const result = await computeNativeLearningDiff(fixture.dir, fixture.jobId);
    expect(result).toMatchObject({ eligible: false, reason: '取り込み元の旧形式ファイルがありません',
      response: { cut: null, words: null, telops: null, ses: null } });
  });

  it('取り込み後に旧ファイルが書き換わった案件は対象外', async () => {
    fixture = await createImportedProject({ edit: standardEdit, finish: standardFinish });
    writeFileSync(join(fixture.dir, 'src/cutData.ts'), 'export const cutData = [];\n');
    const result = await computeNativeLearningDiff(fixture.dir, fixture.jobId);
    expect(result).toMatchObject({ eligible: false, reason: '取り込み後に旧形式ファイルが変更されています' });
  });

  it('書き出しジョブが無ければ 404、完了していなければ 409（現在の文書で代用しない）', async () => {
    fixture = await createImportedProject({ edit: standardEdit, finish: standardFinish });
    await expect(computeNativeLearningDiff(fixture.dir, 'f'.repeat(32))).rejects.toMatchObject({ status: 404 });
    fixture.cleanup();
    fixture = await createImportedProject({ edit: standardEdit, finish: standardFinish, phase: 'rendering' });
    const error = await computeNativeLearningDiff(fixture.dir, fixture.jobId).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 409 });
  });

  it('仕上げは書き出し記録の input.json から読む: 現在の文書が無くても同じ差分、input.json が無ければ現在の文書があっても失敗', async () => {
    fixture = await createImportedProject({ edit: standardEdit, finish: standardFinish });
    const current = join(fixture.dir, '.harness', 'project.v2.json');
    rmSync(current);
    const result = await computeNativeLearningDiff(fixture.dir, fixture.jobId);
    expect(result.eligible).toBe(true);
    expect(result.response.telops?.map((t) => [t.kind, t.after])).toEqual([['changed', 'ゆるい素振り'], ['removed', ''], ['added', '追加した字幕']]);
    fixture.cleanup();
    fixture = await createImportedProject({ edit: standardEdit, finish: standardFinish });
    // 存在検査: 現在の文書は残っている（代用できる状態でも代用しないことを確かめる）。
    expect(statSync(join(fixture.dir, '.harness', 'project.v2.json')).isFile()).toBe(true);
    rmSync(join(fixture.dir, '.harness', 'exports', fixture.jobId, 'input.json'));
    await expect(computeNativeLearningDiff(fixture.dir, fixture.jobId)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('countAiEditsAfterImport', () => {
  it('external-edits の kind:ai（baseline.json 以外）と、操作台帳の saved をこの文書の分だけ数える', async () => {
    fixture = await createImportedProject({ edit: standardEdit, finish: standardFinish });
    const edits = join(fixture.dir, '.harness', 'external-edits');
    mkdirSync(edits, { recursive: true });
    writeFileSync(join(edits, 'a.json'), JSON.stringify({ kind: 'ai', status: 'failed' }));
    writeFileSync(join(edits, 'b.json'), JSON.stringify({ kind: 'external' }));
    writeFileSync(join(edits, 'baseline.json'), JSON.stringify({ kind: 'ai' }));
    writeFileSync(join(fixture.root, '.sme-editor-operations.json'), JSON.stringify({ schemaVersion: 1, operations: [
      { phase: 'saved', request: { projectId: 'case-a', sequence: { documentId: 'doc-a' } } },
      { phase: 'saved', request: { projectId: 'case-a', sequence: { documentId: 'other-doc' } } },
      { phase: 'applied', request: { projectId: 'case-a', sequence: { documentId: 'doc-a' } } },
      { phase: 'saved', request: { projectId: 'case-a' } },
    ] }));
    expect(countAiEditsAfterImport(fixture.dir, 'doc-a')).toBe(3);
    expect((await computeNativeLearningDiff(fixture.dir, fixture.jobId)).response.aiEditCount).toBe(3);
  });

  it('台帳に壊れた行（request:null）があってもほかの行は数える。sequence:null は旧形式の操作として数える（harvest_v2 と同じ）', async () => {
    fixture = await createImportedProject();
    writeFileSync(join(fixture.root, '.sme-editor-operations.json'), JSON.stringify({ schemaVersion: 1, operations: [
      { phase: 'saved', request: null },
      null,
      { phase: 'saved', request: { projectId: 'case-a', sequence: null } },
      { phase: 'saved', request: { projectId: 'case-a', sequence: { documentId: 'doc-a' } } },
    ] }));
    expect(countAiEditsAfterImport(fixture.dir, 'doc-a')).toBe(2);
  });
});

describe('fixture helper', () => {
  it('markAddedInEditor は無い ID で止まる（試料の取り違えを黙って通さない）', async () => {
    fixture = await createImportedProject();
    expect(() => markAddedInEditor(fixture!.document, 'legacy-telop-404', 'x')).toThrow('legacy-telop-404');
  });
});
