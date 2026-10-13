import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addedMainRanges, addedMainSources, addedSourcesNote, computeNativeLearningDiff, countAiEditsAfterImport, NATIVE_BASELINE_LABEL } from './nativeLearningDiff';
import { createImportedProject, markAddedInEditor, standardEdit, standardFinish, type ImportedProjectFixture } from './__fixtures__/importedProject';
import { HttpError } from '../http';
import { rational } from '../../core/sequence/time';
import type { SequenceAsset, SequenceClip, SequenceDocument } from '../../core/sequence/model';

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

  it('移行した案件のメインに後から足した素材は比べず、注記を出す（完了扱いにしない）', async () => {
    fixture = await createImportedProject({ finish: (document) => {
      const asset = { ...document.assets.find((a) => a.id === document.legacy!.primaryAssetId)!, id: 'added-take', fingerprint: 'added-take', name: 'take2.mp4' };
      document.assets.push(asset);
      const end = Math.max(...document.clips.filter((c) => c.trackId === 'v-main').map((c) => c.startFrame + c.durationFrames));
      document.clips.push({ id: 'added-video', name: 'take2.mp4', trackId: 'v-main', startFrame: end, durationFrames: 30, clock: { offset: rational(0), rate: rational(1), duration: rational(30) },
        content: { kind: 'video', assetId: 'added-take', streamIndex: 0, sourceIn: rational(0), rate: rational(1), endBehavior: 'hold' } });
      document.sequenceEndFrame = Math.max(document.sequenceEndFrame, end + 30);
      // 足した素材の上に人が置いた字幕（候補の中身は変えない。既定のチェックを外すのは画面の役目）。
      const telop = structuredClone(document.clips.find((c) => c.content.kind === 'telop')!);
      telop.id = 'user-telop-take2';
      delete telop.anchor; // 元の素材の使用箇所への参照は外す（タイムラインに置いた字幕）
      delete telop.continuationGroupId;
      telop.startFrame = end;
      telop.durationFrames = 30;
      if (telop.content.kind === 'telop') { delete telop.content.legacyId; telop.content.data.text = '足した素材の字幕'; }
      document.clips.push(telop);
    } });
    // 存在検査: main を持たない移行案件（v-main の既定）で、足したクリップが本当にメインの映像トラックに載っている。
    expect(fixture.document.main).toBeUndefined();
    expect(fixture.document.clips.find((c) => c.id === 'added-video')?.trackId).toBe('v-main');
    const result = await computeNativeLearningDiff(fixture.dir, fixture.jobId);
    expect(result.eligible).toBe(true);
    expect(result.response.partialNote).toBe(addedSourcesNote(1));
    expect(addedSourcesNote(1)).toBe('後から足した素材（1本）のカットは比べていません。その部分の字幕・効果音の候補は、最初はチェックを外しています');
    const end = fixture.document.clips.find((c) => c.id === 'added-video')!.startFrame;
    expect(result.response.partialRanges).toEqual([{ startFrame: end, endFrame: end + 30 }]);
    // 候補の中身は変えない（harvest_v2 との照合を保つ）: 足した素材の上の字幕も added として出る。
    expect(result.response.telops?.filter((t) => t.after === '足した素材の字幕').map((t) => [t.kind, t.startFrame, t.endFrame])).toEqual([['added', end, end + 30]]);
  });
  it('足していない移行案件には注記を出さない', async () => {
    fixture = await createImportedProject({ edit: standardEdit, finish: standardFinish });
    const { response } = await computeNativeLearningDiff(fixture.dir, fixture.jobId);
    expect(response.partialNote).toBeUndefined();
    expect(response.partialRanges).toBeUndefined();
    expect(addedMainSources(fixture.document)).toBe(0);
    expect(addedMainRanges(fixture.document)).toEqual([]);
  });
});

/** 試料の文書へ「後から足した素材」を登録する（取り込んだ元の素材の複製。origin を渡すと音声補正版）。 */
function addAsset(document: SequenceDocument, id: string, origin?: SequenceAsset['origin']): void {
  const primary = document.assets.find((a) => a.id === document.legacy!.primaryAssetId)!;
  document.assets.push({ ...structuredClone(primary), id, fingerprint: id, name: `${id}.mp4`, ...(origin ? { origin } : {}) });
}
/** trackId の既存クリップを型にして、assetId のクリップをそのトラックの末尾に置く（数え方だけを見る純関数の試験用）。 */
function placeClip(document: SequenceDocument, trackId: string, assetId: string, into: SequenceClip[] = document.clips): SequenceClip {
  const template = [...document.clips, ...(document.cutArchive?.entries ?? []).flatMap((e) => e.clips)].find((c) => c.trackId === trackId
    && (c.content.kind === 'video' || c.content.kind === 'audio'));
  if (!template) throw new Error(`試料の ${trackId} に映像・音声のクリップがありません`);
  const clip = structuredClone(template);
  if (clip.content.kind !== 'video' && clip.content.kind !== 'audio') throw new Error('unreachable');
  clip.id = `${trackId}-${assetId}-${into.length}`;
  clip.content.assetId = assetId;
  clip.startFrame = Math.max(0, ...into.filter((c) => c.trackId === trackId).map((c) => c.startFrame + c.durationFrames));
  into.push(clip);
  return clip;
}

describe('addedMainSources', () => {
  it('カットして保管庫（cutArchive）にだけ残った追加素材も数える', async () => {
    fixture = await createImportedProject({ edit: (project) => { project.cutRegions = [{ start: 120, end: 150 }, { start: 155, end: 215 }]; } });
    const document = structuredClone(fixture.document);
    const entry = document.cutArchive?.entries[0];
    // 存在検査: 保管庫に本当にメインの映像クリップがある（試料の保管庫が空なら下の数え方は何も確かめない）。
    expect(entry?.clips.some((c) => c.trackId === 'v-main' && c.content.kind === 'video')).toBe(true);
    addAsset(document, 'archived-take');
    placeClip(document, 'v-main', 'archived-take', entry!.clips);
    expect(document.clips.some((c) => (c.content.kind === 'video' || c.content.kind === 'audio') && c.content.assetId === 'archived-take')).toBe(false);
    expect(addedMainSources(document)).toBe(1);
    expect(addedMainSources(fixture.document)).toBe(0);
  });

  it('補正した素材は原本で数える: 元の素材の補正版は足したものに数えず、足した素材とその補正版は1本', async () => {
    fixture = await createImportedProject();
    const document = structuredClone(fixture.document);
    addAsset(document, 'main-denoise', { kind: 'audio-fix', from: 'main', fix: 'denoise' });
    addAsset(document, 'main-denoise-normalize', { kind: 'audio-fix', from: 'main-denoise', fix: 'normalize' });
    placeClip(document, 'a-main', 'main-denoise-normalize');
    expect(addedMainSources(document)).toBe(0);
    addAsset(document, 'take2');
    addAsset(document, 'take2-denoise', { kind: 'audio-fix', from: 'take2', fix: 'denoise' });
    placeClip(document, 'v-main', 'take2');
    placeClip(document, 'a-main', 'take2-denoise');
    expect(addedMainSources(document)).toBe(1);
  });

  it('main の無い移行案件は v-main / a-main をメインとして数え、メインでないトラックの素材は数えない', async () => {
    fixture = await createImportedProject();
    const document = structuredClone(fixture.document);
    expect(document.main).toBeUndefined();
    expect(document.tracks.filter((t) => t.id === 'v-main' || t.id === 'a-main').map((t) => t.kind)).toEqual(['visual', 'audio']);
    addAsset(document, 'insert-take');
    document.tracks.push({ id: 'v-insert', kind: 'visual', name: '映像2', enabled: true });
    placeClip(document, 'v-main', 'insert-take', document.clips);
    document.clips.at(-1)!.trackId = 'v-insert';
    expect(addedMainSources(document)).toBe(0);
    addAsset(document, 'voice-only');
    placeClip(document, 'a-main', 'voice-only');
    expect(addedMainSources(document)).toBe(1);
    addAsset(document, 'voice-two');
    placeClip(document, 'a-main', 'voice-two');
    expect(addedMainSources(document)).toBe(2);
    // 明示した main があればそれに従う（v-insert をメインの映像にすると、a-main は原音のメインではなくなる）。
    document.main = { videoTrackId: 'v-insert' };
    expect(addedMainSources(document)).toBe(1);
  });

  it('循環した補正の記録でも止まり、たどり始めた素材で数える', async () => {
    fixture = await createImportedProject();
    const document = structuredClone(fixture.document);
    addAsset(document, 'loop-a', { kind: 'audio-fix', from: 'loop-b', fix: 'denoise' });
    addAsset(document, 'loop-b', { kind: 'audio-fix', from: 'loop-a', fix: 'normalize' });
    placeClip(document, 'a-main', 'loop-a');
    expect(addedMainSources(document)).toBe(1);
  });

  it('メインの原音トラックに置いた BGM・効果音（speech 以外）は足した素材に数えず、区間にも入れない', async () => {
    fixture = await createImportedProject();
    const document = structuredClone(fixture.document);
    addAsset(document, 'bgm-track');
    const bgm = placeClip(document, 'a-main', 'bgm-track');
    // 存在検査: 型にしたクリップは原音（speech）なので、役割を music に変えて BGM にする。
    expect(bgm.content.kind === 'audio' && bgm.content.role).toBe('speech');
    if (bgm.content.kind === 'audio') bgm.content.role = 'music';
    expect(addedMainSources(document)).toBe(0);
    expect(addedMainRanges(document)).toEqual([]);
    if (bgm.content.kind === 'audio') bgm.content.role = 'speech';
    expect(addedMainSources(document)).toBe(1);
    expect(addedMainRanges(document)).toEqual([{ startFrame: bgm.startFrame, endFrame: bgm.startFrame + bgm.durationFrames }]);
  });

  it('区間: 本編のメイン上で足した素材のクリップの区間を、重なり・隣接を合わせて並べる（元の素材・保管庫・メイン外は入れない）', async () => {
    fixture = await createImportedProject({ edit: (project) => { project.cutRegions = [{ start: 120, end: 150 }]; } });
    const document = structuredClone(fixture.document);
    const at = (clip: SequenceClip, startFrame: number, durationFrames: number) => { clip.startFrame = startFrame; clip.durationFrames = durationFrames; };
    addAsset(document, 'take2');
    addAsset(document, 'take3');
    at(placeClip(document, 'v-main', 'take2'), 1000, 30);
    at(placeClip(document, 'a-main', 'take2'), 1010, 30); // 重なり → 1000–1040
    at(placeClip(document, 'v-main', 'take3'), 1040, 20); // 隣接 → 1000–1060
    at(placeClip(document, 'v-main', 'take3'), 1100, 10); // 離れている → 別の区間
    at(placeClip(document, 'a-main', 'main'), 1200, 10); // 元の素材 → 入れない
    document.tracks.push({ id: 'v-insert', kind: 'visual', name: '映像2', enabled: true });
    const insert = placeClip(document, 'v-main', 'take2');
    at(insert, 1300, 10);
    insert.trackId = 'v-insert'; // メイン外 → 入れない
    const entry = document.cutArchive?.entries[0];
    expect(entry?.clips.length).toBeGreaterThan(0); // 存在検査: 保管庫がある
    placeClip(document, 'v-main', 'take3', entry!.clips); // 保管庫（今のタイムラインに無い）→ 区間に入れない
    expect(addedMainRanges(document)).toEqual([{ startFrame: 1000, endFrame: 1060 }, { startFrame: 1100, endFrame: 1110 }]);
    expect(addedMainSources(document)).toBe(2);
  });

  it('移行していない案件（legacy なし）は 0', async () => {
    fixture = await createImportedProject();
    const document = structuredClone(fixture.document);
    addAsset(document, 'take2');
    placeClip(document, 'v-main', 'take2');
    expect(addedMainSources(document)).toBe(1);
    delete document.legacy;
    expect(addedMainSources(document)).toBe(0);
    expect(addedMainRanges(document)).toEqual([]);
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
