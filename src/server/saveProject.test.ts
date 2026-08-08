import { describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { saveProjectToDir, validateSaveRequest } from './saveProject';
import { loadProjectFromDir } from './loadProjectFiles';
import { HttpError } from './http';
import type { SaveRequest } from '../shared/types';

const SAMPLE = resolve(__dirname, '__fixtures__', 'sample-project');

/** sample-project を一時ディレクトリへ複製し、テスト後に消す。 */
function withProjectCopy(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sme-save-'));
  // cpSync(recursive) は並列テスト負荷下で稀に ENOENT を投げる（macOS の recursive copy レース）。
  // 少数回リトライして安定させる（フルスイートのフレーキー回避）。
  for (let attempt = 0; ; attempt++) {
    try {
      cpSync(SAMPLE, dir, { recursive: true });
      break;
    } catch (err) {
      if (attempt >= 2) throw err;
    }
  }
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('validateSaveRequest', () => {
  it('オブジェクトでない・null・配列を弾く', () => {
    expect(() => validateSaveRequest(null)).toThrow(HttpError);
    expect(() => validateSaveRequest('x')).toThrow(HttpError);
    expect(() => validateSaveRequest([])).toThrow(HttpError);
  });

  it('project / fingerprint が欠けたボディを弾く', () => {
    expect(() => validateSaveRequest({})).toThrow(/project/);
    expect(() => validateSaveRequest({ project: {} })).toThrow(/fingerprint/);
  });

  it('fingerprint.telopData が欠落していると HttpError(400) を投げる', () => {
    // telopData キー欠落 → 後続の fingerprintsMatch で TypeError になるのではなく 400 で弾く
    expect(() => validateSaveRequest({
      project: {},
      fingerprint: {},
    })).toThrow(HttpError);
    try {
      validateSaveRequest({ project: {}, fingerprint: {} });
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(400);
      expect((err as HttpError).message).toMatch(/fingerprint\.telopData/);
    }
  });

  it('fingerprint.cutData が null でもオブジェクトでもない場合は HttpError(400) を投げる', () => {
    expect(() => validateSaveRequest({
      project: {},
      fingerprint: { telopData: { relPath: 'a', size: 1, mtimeMs: 1 }, cutData: 'bad', seData: null, insertImageData: null, videoInsertData: null, bgmData: null, titleData: null },
    })).toThrow(HttpError);
    try {
      validateSaveRequest({
        project: {},
        fingerprint: { telopData: { relPath: 'a', size: 1, mtimeMs: 1 }, cutData: 'bad', seData: null, insertImageData: null, videoInsertData: null, bgmData: null, titleData: null },
      });
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(400);
      expect((err as HttpError).message).toMatch(/fingerprint\.cutData/);
    }
  });

  it('fingerprint.cutData が null のとき（cutData.ts 不在）は弾かない', () => {
    // null は正常値 → telopData 検証は通るので、次の project 検証エラーが来ること
    expect(() => validateSaveRequest({
      project: {},
      fingerprint: { telopData: { relPath: 'a', size: 1, mtimeMs: 1 }, cutData: null, seData: null, insertImageData: null, videoInsertData: null, bgmData: null, titleData: null },
    })).toThrow(/telops/);
  });

  it('project.telops が配列でないボディを弾く', () => {
    expect(() => validateSaveRequest({
      project: { telops: 'x', cutRegions: [] },
      fingerprint: { telopData: { relPath: 'a', size: 1, mtimeMs: 1 }, cutData: null, seData: null, insertImageData: null, videoInsertData: null, bgmData: null, titleData: null },
    })).toThrow(/telops/);
  });
});

describe('validateSaveRequest — SE', () => {
  it('project.se が配列でなければ 400', () => {
    expect(() =>
      validateSaveRequest({
        project: { telops: [], cutRegions: [], videoConfig: {}, telopDataSource: 'x', se: 'no', images: [], insertImageDataSource: null },
        fingerprint: { telopData: {}, cutData: null, seData: null, insertImageData: null, videoInsertData: null, bgmData: null, titleData: null },
      }),
    ).toThrow();
  });

  it('se が配列・seDataSource が null/文字列なら通る', () => {
    expect(() =>
      validateSaveRequest({
        project: {
          telops: [], cutRegions: [], videoConfig: {}, telopDataSource: 'x',
          se: [], seDataSource: null,
          images: [], insertImageDataSource: null,
        },
        fingerprint: { telopData: {}, cutData: null, seData: null, insertImageData: null, videoInsertData: null, bgmData: null, titleData: null },
      }),
    ).not.toThrow();
  });
});

describe('validateSaveRequest — 画像', () => {
  it('project.images が配列でなければ 400', () => {
    expect(() =>
      validateSaveRequest({
        project: {
          telops: [], cutRegions: [], videoConfig: {}, telopDataSource: 'x',
          se: [], seDataSource: null,
          images: 'no', insertImageDataSource: null,
        },
        fingerprint: { telopData: {}, cutData: null, seData: null, insertImageData: null, videoInsertData: null, bgmData: null, titleData: null },
      }),
    ).toThrow();
  });

  it('images が配列・insertImageDataSource が null/文字列なら通る', () => {
    expect(() =>
      validateSaveRequest({
        project: {
          telops: [], cutRegions: [], videoConfig: {}, telopDataSource: 'x',
          se: [], seDataSource: null,
          images: [], insertImageDataSource: null,
        },
        fingerprint: { telopData: {}, cutData: null, seData: null, insertImageData: null, videoInsertData: null, bgmData: null, titleData: null },
      }),
    ).not.toThrow();
  });
});

describe('saveProjectToDir', () => {
  it('編集後の telopData.ts を書き戻し、ラウンドトリップで読み直せる', () => {
    withProjectCopy((dir) => {
      const loaded = loadProjectFromDir(dir);
      const project = { ...loaded.project };
      project.telops = project.telops.map((t) =>
        t.id === 1 ? { ...t, text: '直した素振り' } : t,
      );
      const req: SaveRequest = { project, fingerprint: loaded.save.fingerprint };
      const res = saveProjectToDir(dir, req);
      expect(res.ok).toBe(true);
      // 書き戻した内容を再読込
      const reloaded = loadProjectFromDir(dir);
      expect(reloaded.project.telops.find((t) => t.id === 1)?.text).toBe('直した素振り');
      // 返ってきた新指紋は再読込の指紋と一致
      expect(res.fingerprint.telopData.size).toBe(reloaded.save.fingerprint.telopData.size);
    });
  });

  it('seData.ts 不在から SE 新規追加・保存後、全 SE 削除・保存で空配列へ更新される（Codex P2-1 回帰）', () => {
    withProjectCopy((dir) => {
      // フィクスチャの seData.ts を消し「SE 不在」プロジェクトをシミュレートする。
      const seAbs = join(dir, 'src', 'SoundEffects', 'seData.ts');
      rmSync(seAbs);

      // 1) 不在から SE 1 件を追加して保存 → seData.ts が新規作成される。
      const loaded = loadProjectFromDir(dir);
      expect(loaded.project.seDataSource).toBeNull();
      expect(loaded.save.fingerprint.seData).toBeNull();
      const firstReq: SaveRequest = {
        project: {
          ...loaded.project,
          se: [{ id: 1, originalStart: 50, originalEnd: 140, file: 'beep.mp3', volume: 0.3 }],
        },
        fingerprint: loaded.save.fingerprint,
      };
      const firstRes = saveProjectToDir(dir, firstReq);
      expect(firstRes.fingerprint.seData).not.toBeNull();
      // 保存先は ハーネス形式の seData.ts なのでフィールド名は startFrame（再生フレーム）。
      expect(readFileSync(seAbs, 'utf8')).toContain('startFrame: 50');

      // 2) クライアント側 baseProject.seDataSource は null のまま（読込時スナップショット）
      //    で、SE を全削除して保存する。バグでは serializeSeData(null, []) → null と
      //    判定され既存ファイルが残ってしまう。修正後は disk 状態から serialize し
      //    seData.ts が空配列へ更新される。
      const staleReq: SaveRequest = {
        project: {
          ...loaded.project, // seDataSource は依然 null（古いクライアントの状態）
          se: [],
        },
        fingerprint: firstRes.fingerprint,
      };
      saveProjectToDir(dir, staleReq);
      const reloaded = loadProjectFromDir(dir);
      expect(reloaded.project.se).toEqual([]);
      // 念のためファイルが残っていて空配列になっていることも確認する。
      expect(readFileSync(seAbs, 'utf8')).toContain('seData');
    });
  });

  it('cutData.ts が無いプロジェクトでカットを保存すると cutData.ts を新規作成する', () => {
    withProjectCopy((dir) => {
      // fixture に src/cutData.ts が追加されたため、削除して cutData なし状態を再現する。
      rmSync(join(dir, 'src', 'cutData.ts'), { force: true });
      const loaded = loadProjectFromDir(dir);
      const project = { ...loaded.project, cutRegions: [{ start: 100, end: 200 }] };
      const req: SaveRequest = { project, fingerprint: loaded.save.fingerprint };
      saveProjectToDir(dir, req);
      const cutPath = join(dir, 'cutData.ts');
      expect(statSync(cutPath).isFile()).toBe(true);
      expect(readFileSync(cutPath, 'utf8')).toContain('cutData');
    });
  });

  it('insertImageData.ts 不在から画像追加・保存後、全画像削除・保存で空配列へ更新される（Codex P2-1 教訓・先回り）', () => {
    withProjectCopy((dir) => {
      // フィクスチャに insertImageData.ts があれば消す（T18 で追加するため、その後はこのテストが本番状況をシミュレート）。
      const insAbs = join(dir, 'src', 'InsertImage', 'insertImageData.ts');
      rmSync(insAbs, { force: true });

      // 1) 不在から画像 1 件を追加して保存 → insertImageData.ts が新規作成される。
      const loaded = loadProjectFromDir(dir);
      expect(loaded.project.insertImageDataSource).toBeNull();
      expect(loaded.save.fingerprint.insertImageData).toBeNull();
      const firstReq: SaveRequest = {
        project: {
          ...loaded.project,
          images: [
            { id: 1, originalStart: 50, originalEnd: 200, file: 'sample.png', type: 'photo' },
          ],
        },
        fingerprint: loaded.save.fingerprint,
      };
      const firstRes = saveProjectToDir(dir, firstReq);
      expect(firstRes.fingerprint.insertImageData).not.toBeNull();
      expect(readFileSync(insAbs, 'utf8')).toContain('startFrame: 50');

      // 2) クライアント側 baseProject.insertImageDataSource は null のままで、画像を全削除して保存。
      //    Codex P2-1 教訓どおり saveProjectToDir はサーバ現行 disk 状態で serialize するため、
      //    insertImageData.ts が空配列へ正しく更新される。
      const staleReq: SaveRequest = {
        project: { ...loaded.project, images: [] },
        fingerprint: firstRes.fingerprint,
      };
      saveProjectToDir(dir, staleReq);
      const reloaded = loadProjectFromDir(dir);
      expect(reloaded.project.images).toEqual([]);
      expect(readFileSync(insAbs, 'utf8')).toContain('insertImageData');
    });
  });

  it('読込後にファイルが外部変更されていたら HttpError(409) を投げて書き込まない', () => {
    withProjectCopy((dir) => {
      const loaded = loadProjectFromDir(dir);
      const telopPath = join(dir, 'src', 'テロップテンプレート', 'telopData.ts');
      const original = readFileSync(telopPath, 'utf8');
      // 外部変更をシミュレート
      writeFileSync(telopPath, original + '\n// 外部編集\n', 'utf8');
      const req: SaveRequest = {
        project: loaded.project,
        fingerprint: loaded.save.fingerprint,
      };
      expect(() => saveProjectToDir(dir, req)).toThrow(HttpError);
      try {
        saveProjectToDir(dir, req);
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).status).toBe(409);
      }
      // 書き込まれていない（外部編集マーカーが残る）
      expect(readFileSync(telopPath, 'utf8')).toContain('外部編集');
    });
  });
});

describe('saveProjectToDir が学習レコードを記録する', () => {
  it('baseline 有り＋保存 → cutLearning.json が生成され finalCutRegions と delta を含む', () => {
    withProjectCopy((dir) => {
      // loadProjectFromDir は baseline を自動生成するが、テストでは意図的に
      // autoCutRegions=[] の baseline を上書き配置して「差分が出る状況」を作る。
      // まず fingerprint を得るために一度読み込む。
      const loaded = loadProjectFromDir(dir);

      // cut-baseline.json を autoCutRegions:[] で明示的に書き込む（上書き）。
      // これにより baseline と保存する cutRegions の差分が生じる。
      writeFileSync(
        join(dir, 'cut-baseline.json'),
        JSON.stringify({
          schemaVersion: 1,
          capturedAt: '2026-05-29T10:00:00.000Z',
          video: {
            file: loaded.project.videoConfig.videoFile,
            fps: loaded.project.videoConfig.fps,
            durationFrames: loaded.project.videoConfig.durationFrames,
          },
          autoCutRegions: [],
          transcriptDigest: { durationMs: 1, wordCount: 1 },
        }),
        'utf8',
      );

      // cutRegions に [{ start: 0, end: 30 }] を入れて保存する。
      const req: SaveRequest = {
        project: { ...loaded.project, cutRegions: [{ start: 0, end: 30 }] },
        fingerprint: loaded.save.fingerprint,
      };
      const res = saveProjectToDir(dir, req);
      expect(res.ok).toBe(true);

      // cutLearning.json が生成されている。
      const learnPath = join(dir, 'cutLearning.json');
      expect(existsSync(learnPath)).toBe(true);

      const rec = JSON.parse(readFileSync(learnPath, 'utf8'));
      // finalCutRegions は保存した cutRegions と一致する。
      expect(rec.finalCutRegions).toEqual([{ start: 0, end: 30 }]);
      // autoCutRegions は baseline の値（空）。
      expect(rec.autoCutRegions).toEqual([]);
      // delta.addedRegions: baseline(空) に無く final にある区間 → [{start:0,end:30}]
      expect(rec.delta.addedRegions).toEqual([{ start: 0, end: 30 }]);
      expect(rec.delta.restoredRegions).toEqual([]);
    });
  });

  it('baseline が壊れている（readCutBaseline が null 返す）→ cutLearning.json が生成されない（スキップ）', () => {
    withProjectCopy((dir) => {
      // loadProjectFromDir を呼ぶと baseline が自動生成される。
      // 生成後に baseline を壊れた JSON で上書きすることで readCutBaseline が null を返し、
      // 学習記録がスキップされることを確認する。
      const loaded = loadProjectFromDir(dir);
      // baseline を壊れた内容で上書きする。
      writeFileSync(join(dir, 'cut-baseline.json'), '{ broken json', 'utf8');

      const req: SaveRequest = {
        project: { ...loaded.project, cutRegions: [{ start: 0, end: 30 }] },
        fingerprint: loaded.save.fingerprint,
      };
      const res = saveProjectToDir(dir, req);
      expect(res.ok).toBe(true);

      // readCutBaseline が null を返すので cutLearning.json は生成されない。
      expect(existsSync(join(dir, 'cutLearning.json'))).toBe(false);
    });
  });
});

describe('saveProjectToDir — サブ動画インサート ラウンドトリップ (M3-T1)', () => {
  it('insertVideoData.ts を書いてロード・保存するとラウンドトリップが成立する', () => {
    withProjectCopy((dir) => {
      // InsertVideo ディレクトリと insertVideoData.ts をプロジェクトに配置する。
      const insertVideoDir = join(dir, 'src', 'InsertVideo');
      mkdirSync(insertVideoDir, { recursive: true });
      const insertVideoAbs = join(insertVideoDir, 'insertVideoData.ts');
      writeFileSync(
        insertVideoAbs,
        `import type { VideoInsert } from './types';
export const insertVideoData: VideoInsert[] = [
  { id: 1, startFrame: 10, endFrame: 40, file: "sub/cam2.mp4", sourceInFrame: 5 },
];
`,
        'utf8',
      );

      // ロードして videoInserts が正しく読まれることを確認。
      const loaded = loadProjectFromDir(dir);
      expect(loaded.project.videoInserts).toEqual([
        { id: 1, originalStart: 10, originalEnd: 40, file: 'sub/cam2.mp4', sourceInFrame: 5 },
      ]);
      // 指紋が存在する（ファイルがあるので非 null）。
      expect(loaded.save.fingerprint.videoInsertData).not.toBeNull();

      // 保存する。
      const req: SaveRequest = { project: loaded.project, fingerprint: loaded.save.fingerprint };
      const res = saveProjectToDir(dir, req);
      expect(res.ok).toBe(true);
      // 新しい指紋も非 null。
      expect(res.fingerprint.videoInsertData).not.toBeNull();

      // 書き戻したファイルに期待する内容が含まれる。
      const written = readFileSync(insertVideoAbs, 'utf8');
      expect(written).toContain('startFrame: 10,');
      expect(written).toContain('sourceInFrame: 5,');
    });
  });
});

describe('saveProjectToDir — BGM データ損失予防 (Task6 ミラー)', () => {
  it('bgmData.ts 不在から BGM 追加・保存後、全削除・保存で空配列へ更新される（Codex P2-1 先回り）', () => {
    withProjectCopy((dir) => {
      // bgmData.ts が無い状態をシミュレート（フィクスチャに無いので不在がデフォルト）。
      const bgmAbs = join(dir, 'src', 'Bgm', 'bgmData.ts');
      rmSync(bgmAbs, { force: true });

      // 1) 不在から BGM 1 件を追加して保存 → bgmData.ts が新規作成される。
      const loaded = loadProjectFromDir(dir);
      expect(loaded.project.bgmDataSource).toBeNull();
      expect(loaded.save.fingerprint.bgmData).toBeNull();
      const firstReq: SaveRequest = {
        project: {
          ...loaded.project,
          bgm: [{ id: 1, originalStart: 100, originalEnd: 400, file: 'bgm.mp3', volume: 0.8, fadeInFrames: 0, fadeOutFrames: 0 }],
        },
        fingerprint: loaded.save.fingerprint,
      };
      const firstRes = saveProjectToDir(dir, firstReq);
      expect(firstRes.fingerprint.bgmData).not.toBeNull();
      expect(readFileSync(bgmAbs, 'utf8')).toContain('startFrame: 100');

      // 2) クライアント側 baseProject.bgmDataSource は null のままで、BGM を全削除して保存。
      //    saveProjectToDir はサーバ現行 disk 状態（current.project.bgmDataSource）で
      //    serialize するため、bgmData.ts が空配列へ正しく更新される。
      const staleReq: SaveRequest = {
        project: { ...loaded.project, bgm: [] },
        fingerprint: firstRes.fingerprint,
      };
      saveProjectToDir(dir, staleReq);
      const reloaded = loadProjectFromDir(dir);
      expect(reloaded.project.bgm).toEqual([]);
      expect(readFileSync(bgmAbs, 'utf8')).toContain('bgmData');
    });
  });
});

describe('saveProjectToDir — タイトル fingerprint（fast-follow）', () => {
  it('titleData.ts 不在からタイトル追加・保存で titleData.ts が作られ fingerprint.titleData が非 null になる', () => {
    withProjectCopy((dir) => {
      const loaded = loadProjectFromDir(dir);
      // sample-project に src/Title/titleData.ts は無い → 読込時は null。
      expect(loaded.project.titleDataSource).toBeNull();
      expect(loaded.save.fingerprint.titleData).toBeNull();

      const req: SaveRequest = {
        project: {
          ...loaded.project,
          titles: [{ id: 1, originalStart: 100, originalEnd: 400, text: 'ゆる素振り' }],
        },
        fingerprint: loaded.save.fingerprint,
      };
      const res = saveProjectToDir(dir, req);
      // 新規作成されたので fingerprint.titleData は非 null。
      expect(res.fingerprint.titleData).not.toBeNull();
      const titleAbs = join(dir, 'src', 'Title', 'titleData.ts');
      expect(existsSync(titleAbs)).toBe(true);
      expect(readFileSync(titleAbs, 'utf8')).toContain('ゆる素振り');
    });
  });

  it('titleData.ts が読込後に外部変更されていたら HttpError(409) を投げて書き込まない', () => {
    withProjectCopy((dir) => {
      // まずタイトルを 1 件保存して titleData.ts を存在させる。
      const first = loadProjectFromDir(dir);
      saveProjectToDir(dir, {
        project: {
          ...first.project,
          titles: [{ id: 1, originalStart: 100, originalEnd: 400, text: 'タイトル' }],
        },
        fingerprint: first.save.fingerprint,
      });

      // 読み直して現在の指紋を取得（titleData は非 null）。
      const loaded = loadProjectFromDir(dir);
      expect(loaded.save.fingerprint.titleData).not.toBeNull();

      // 外部変更をシミュレート。
      const titleAbs = join(dir, 'src', 'Title', 'titleData.ts');
      writeFileSync(titleAbs, readFileSync(titleAbs, 'utf8') + '\n// 外部編集\n', 'utf8');

      const req: SaveRequest = { project: loaded.project, fingerprint: loaded.save.fingerprint };
      expect(() => saveProjectToDir(dir, req)).toThrow(HttpError);
      try {
        saveProjectToDir(dir, req);
      } catch (err) {
        expect((err as HttpError).status).toBe(409);
      }
      // 書き込まれていない（外部編集マーカーが残る）。
      expect(readFileSync(titleAbs, 'utf8')).toContain('外部編集');
    });
  });
});

describe('saveProjectToDir — speedData stale ファイル削除 (Task-10 回帰)', () => {
  it('0.5x 保存後に mainSpeed=1 で保存すると speedData.ts が削除される', () => {
    withProjectCopy((dir) => {
      // 1) speedData.ts を 0.5x 内容でディスクに置く（0.5x 保存をシミュレート）。
      const speedAbs = join(dir, 'src', 'speedData.ts');
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(speedAbs, 'export const MAIN_SPEED = 0.5;\n', 'utf8');

      // 2) ロード → fingerprint.speedData が 0.5x ファイルの指紋を持つ。
      const loaded = loadProjectFromDir(dir);
      expect(loaded.project.mainSpeed).toBe(0.5);
      expect(loaded.save.fingerprint.speedData).not.toBeNull();

      // 3) mainSpeed=1 で保存（serializeSpeedData(1) → null）。
      const req: SaveRequest = {
        project: { ...loaded.project, mainSpeed: 1 },
        fingerprint: loaded.save.fingerprint,
      };
      const res = saveProjectToDir(dir, req);
      expect(res.ok).toBe(true);

      // 4) speedData.ts が削除されている。
      expect(existsSync(speedAbs)).toBe(false);
      // 5) 返された指紋も null（ファイル不在）。
      expect(res.fingerprint.speedData).toBeNull();
    });
  });
});

describe('saveProjectToDir — 速度導入済みは speedData.ts を常時保持 (Task-6)', () => {
  it('速度導入済み (marker あり) は mainSpeed=1 でも speedData.ts を残し MAIN_SPEED=1 を書く', () => {
    withProjectCopy((dir) => {
      // marker を配置して「速度導入済み」をシミュレート。
      const speedDir = join(dir, 'src', 'Speed');
      mkdirSync(speedDir, { recursive: true });
      writeFileSync(join(speedDir, 'speed.json'), JSON.stringify({ feature: 'speed' }), 'utf8');

      // speedData.ts は不在のまま（インストール後・1x でリセットされた状態を想定）。
      const speedAbs = join(dir, 'src', 'speedData.ts');
      expect(existsSync(speedAbs)).toBe(false);

      // プロジェクト読込 → 指紋を取得（speedData.ts 不在 → fingerprint.speedData=null）。
      const loaded = loadProjectFromDir(dir);
      expect(loaded.save.fingerprint.speedData).toBeNull();

      // mainSpeed=1 で保存する。
      const req: SaveRequest = {
        project: { ...loaded.project, mainSpeed: 1 },
        fingerprint: loaded.save.fingerprint,
      };
      const res = saveProjectToDir(dir, req);
      expect(res.ok).toBe(true);

      // 速度導入済みなので speedData.ts が作成（保持）される。
      expect(existsSync(speedAbs)).toBe(true);
      const content = readFileSync(speedAbs, 'utf8');
      expect(content).toContain('MAIN_SPEED = 1');
      // 返された fingerprint.speedData も非 null（ファイルが存在する）。
      expect(res.fingerprint.speedData).not.toBeNull();
    });
  });

  it('速度未導入 (marker なし) は mainSpeed=1 で speedData.ts を作らない（従来どおり）', () => {
    withProjectCopy((dir) => {
      // marker なし・speedData.ts もなし。
      const speedAbs = join(dir, 'src', 'speedData.ts');
      expect(existsSync(speedAbs)).toBe(false);

      const loaded = loadProjectFromDir(dir);
      expect(loaded.save.fingerprint.speedData).toBeNull();

      const req: SaveRequest = {
        project: { ...loaded.project, mainSpeed: 1 },
        fingerprint: loaded.save.fingerprint,
      };
      const res = saveProjectToDir(dir, req);
      expect(res.ok).toBe(true);

      // 未導入なので speedData.ts は作られない。
      expect(existsSync(speedAbs)).toBe(false);
      expect(res.fingerprint.speedData).toBeNull();
    });
  });
});

describe('saveProjectToDir — 速度導入済みは SEGMENT_SPEEDS を常時保持 (Task-7)', () => {
  it('marker あり + mainSpeed=1 + segmentSpeeds={} → speedData.ts に MAIN_SPEED=1 と SEGMENT_SPEEDS の両方を書く', () => {
    withProjectCopy((dir) => {
      // marker を配置して「速度導入済み」をシミュレート。
      const speedDir = join(dir, 'src', 'Speed');
      mkdirSync(speedDir, { recursive: true });
      writeFileSync(join(speedDir, 'speed.json'), JSON.stringify({ feature: 'speed' }), 'utf8');

      const speedAbs = join(dir, 'src', 'speedData.ts');
      expect(existsSync(speedAbs)).toBe(false);

      const loaded = loadProjectFromDir(dir);
      expect(loaded.save.fingerprint.speedData).toBeNull();

      const req: SaveRequest = {
        project: { ...loaded.project, mainSpeed: 1, segmentSpeeds: {} },
        fingerprint: loaded.save.fingerprint,
      };
      const res = saveProjectToDir(dir, req);
      expect(res.ok).toBe(true);

      // 速度導入済みなので speedData.ts が作成・保持される。
      expect(existsSync(speedAbs)).toBe(true);
      const content = readFileSync(speedAbs, 'utf8');
      expect(content).toContain('MAIN_SPEED = 1');
      // SEGMENT_SPEEDS も両方 export が必要（Root/SpeedPlayer の import 解決）。
      expect(content).toContain('SEGMENT_SPEEDS');
      expect(res.fingerprint.speedData).not.toBeNull();
    });
  });

  it('marker なし + mainSpeed=1 → speedData.ts は作られない（従来どおり）', () => {
    withProjectCopy((dir) => {
      // marker なし・speedData.ts もなし。
      const speedAbs = join(dir, 'src', 'speedData.ts');
      expect(existsSync(speedAbs)).toBe(false);

      const loaded = loadProjectFromDir(dir);
      const req: SaveRequest = {
        project: { ...loaded.project, mainSpeed: 1 },
        fingerprint: loaded.save.fingerprint,
      };
      const res = saveProjectToDir(dir, req);
      expect(res.ok).toBe(true);

      // 未導入なので speedData.ts は作られない。
      expect(existsSync(speedAbs)).toBe(false);
      expect(res.fingerprint.speedData).toBeNull();
    });
  });

  it('marker あり + mainSpeed=0.5 + segmentSpeeds={1:2} → serializeSpeedData 経路で MAIN_SPEED と SEGMENT_SPEEDS の両方を書く', () => {
    withProjectCopy((dir) => {
      // marker を配置。
      const speedDir = join(dir, 'src', 'Speed');
      mkdirSync(speedDir, { recursive: true });
      writeFileSync(join(speedDir, 'speed.json'), JSON.stringify({ feature: 'speed' }), 'utf8');

      const speedAbs = join(dir, 'src', 'speedData.ts');
      const loaded = loadProjectFromDir(dir);
      expect(loaded.save.fingerprint.speedData).toBeNull();

      // mainSpeed=0.5 かつ区間個別速度あり → serializeSpeedData(0.5, {1:2}) は非 null を返す経路。
      const req: SaveRequest = {
        project: { ...loaded.project, mainSpeed: 0.5, segmentSpeeds: { 1: 2 } },
        fingerprint: loaded.save.fingerprint,
      };
      const res = saveProjectToDir(dir, req);
      expect(res.ok).toBe(true);

      expect(existsSync(speedAbs)).toBe(true);
      const content = readFileSync(speedAbs, 'utf8');
      expect(content).toContain('MAIN_SPEED');
      expect(content).toContain('SEGMENT_SPEEDS');
      expect(res.fingerprint.speedData).not.toBeNull();
    });
  });
});

describe('saveProjectToDir transcriptDrifted', () => {
  it('baseline digest が現 transcript と乖離 → cutLearning.json で true', () => {
    withProjectCopy((dir) => {
      const loaded = loadProjectFromDir(dir);
      // 乖離 digest を持つ baseline を明示配置（残置物があっても上書き）。
      writeFileSync(
        join(dir, 'cut-baseline.json'),
        JSON.stringify({
          schemaVersion: 1,
          capturedAt: '2026-05-30T00:00:00.000Z',
          video: {
            file: loaded.project.videoConfig.videoFile,
            fps: loaded.project.videoConfig.fps,
            durationFrames: loaded.project.videoConfig.durationFrames,
          },
          autoCutRegions: [],
          transcriptDigest: { durationMs: 1, wordCount: 1 },
        }),
        'utf8',
      );
      const req: SaveRequest = {
        project: { ...loaded.project, cutRegions: [{ start: 0, end: 30 }] },
        fingerprint: loaded.save.fingerprint,
      };
      saveProjectToDir(dir, req);
      const learn = JSON.parse(readFileSync(join(dir, 'cutLearning.json'), 'utf8'));
      expect(learn.transcriptDrifted).toBe(true);
    });
  });

  it('baseline digest が現 transcript と一致 → false', () => {
    withProjectCopy((dir) => {
      const loaded = loadProjectFromDir(dir);
      writeFileSync(
        join(dir, 'cut-baseline.json'),
        JSON.stringify({
          schemaVersion: 1,
          capturedAt: '2026-05-30T00:00:00.000Z',
          video: {
            file: loaded.project.videoConfig.videoFile,
            fps: loaded.project.videoConfig.fps,
            durationFrames: loaded.project.videoConfig.durationFrames,
          },
          autoCutRegions: [],
          transcriptDigest: {
            durationMs: loaded.project.transcript.durationMs,
            wordCount: loaded.project.transcript.words.length,
          },
        }),
        'utf8',
      );
      const req: SaveRequest = {
        project: { ...loaded.project, cutRegions: [{ start: 0, end: 30 }] },
        fingerprint: loaded.save.fingerprint,
      };
      saveProjectToDir(dir, req);
      const learn = JSON.parse(readFileSync(join(dir, 'cutLearning.json'), 'utf8'));
      expect(learn.transcriptDrifted).toBe(false);
    });
  });
});

describe('loadProjectFromDir — mainLayoutData 読込 (Plan 2a)', () => {
  it('mainLayoutData.ts があれば project.mainLayout と fingerprint に載る', () => {
    withProjectCopy((dir) => {
      const abs = join(dir, 'src', 'mainLayoutData.ts');
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(
        abs,
        'export const MAIN_LAYOUT = { position: { x: 0.5, y: 0 }, scale: 2, background: "#ffffff" };\n',
        'utf8',
      );
      const loaded = loadProjectFromDir(dir);
      expect(loaded.project.mainLayout).toEqual({
        position: { x: 0.5, y: 0 },
        scale: 2,
        background: '#ffffff',
        rotation: 0,
        flipH: false,
        flipV: false,
      });
      expect(loaded.save.fingerprint.mainLayoutData).not.toBeNull();
      expect(loaded.save.mainLayoutDataRelPath).toBe('src/mainLayoutData.ts');
    });
  });
  it('mainLayoutData.ts が無ければ既定・fingerprint は null', () => {
    withProjectCopy((dir) => {
      const loaded = loadProjectFromDir(dir);
      expect(loaded.project.mainLayout).toEqual({
        position: { x: 0, y: 0 },
        scale: 1,
        background: '#000000',
        rotation: 0,
        flipH: false,
        flipV: false,
      });
      expect(loaded.save.fingerprint.mainLayoutData ?? null).toBeNull();
    });
  });
});

describe('saveProjectToDir — mainLayout 保存往復 (Plan 2a)', () => {
  it('レイアウト付きで保存すると mainLayoutData.ts が書かれ、再読込で保持', () => {
    withProjectCopy((dir) => {
      const loaded = loadProjectFromDir(dir);
      const req: SaveRequest = {
        project: {
          ...loaded.project,
          mainLayout: {
            position: { x: 0.5, y: 0 },
            scale: 2,
            background: '#000000',
            rotation: 0,
            flipH: false,
            flipV: false,
          },
        },
        fingerprint: loaded.save.fingerprint,
      };
      const res = saveProjectToDir(dir, req);
      expect(res.ok).toBe(true);
      expect(existsSync(join(dir, 'src', 'mainLayoutData.ts'))).toBe(true);
      expect(res.fingerprint.mainLayoutData).not.toBeNull();
      // 再読込で保持。
      const reloaded = loadProjectFromDir(dir);
      expect(reloaded.project.mainLayout).toEqual({
        position: { x: 0.5, y: 0 },
        scale: 2,
        background: '#000000',
        rotation: 0,
        flipH: false,
        flipV: false,
      });
    });
  });

  it('非既定→既定で保存すると mainLayoutData.ts が削除され指紋 null', () => {
    withProjectCopy((dir) => {
      const abs = join(dir, 'src', 'mainLayoutData.ts');
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(abs, 'export const MAIN_LAYOUT = { position: { x: 0.5, y: 0 }, scale: 2, background: "#000000" };\n', 'utf8');
      const loaded = loadProjectFromDir(dir);
      expect(loaded.save.fingerprint.mainLayoutData).not.toBeNull();
      const req: SaveRequest = {
        project: {
          ...loaded.project,
          mainLayout: {
            position: { x: 0, y: 0 },
            scale: 1,
            background: '#000000',
            rotation: 0,
            flipH: false,
            flipV: false,
          },
        },
        fingerprint: loaded.save.fingerprint,
      };
      const res = saveProjectToDir(dir, req);
      expect(res.ok).toBe(true);
      expect(existsSync(abs)).toBe(false);
      expect(res.fingerprint.mainLayoutData).toBeNull();
    });
  });
});

describe('saveProjectToDir — mainLayout install keep-file (Plan 2b)', () => {
  it('導入済みなら恒等（全画面）でも mainLayoutData.ts を残す（MAIN_LAYOUT import 解決）', () => {
    withProjectCopy((dir) => {
      // install マーカーだけ作って「導入済み」にする（isMainLayoutInstalled が true）。
      mkdirSync(join(dir, 'src', 'MainLayout'), { recursive: true });
      writeFileSync(join(dir, 'src', 'MainLayout', 'main-layout.json'), '{}', 'utf8');
      const loaded = loadProjectFromDir(dir);
      const req: SaveRequest = {
        project: {
          ...loaded.project,
          mainLayout: {
            position: { x: 0, y: 0 },
            scale: 1,
            background: '#000000',
            rotation: 0,
            flipH: false,
            flipV: false,
          },
        },
        fingerprint: loaded.save.fingerprint,
      };
      const res = saveProjectToDir(dir, req);
      expect(res.ok).toBe(true);
      expect(existsSync(join(dir, 'src', 'mainLayoutData.ts'))).toBe(true); // 削除されない
      expect(readFileSync(join(dir, 'src', 'mainLayoutData.ts'), 'utf8')).toContain('MAIN_LAYOUT');
      expect(res.fingerprint.mainLayoutData).not.toBeNull();
    });
  });
});

describe('saveProjectToDir — レイアウト導入済みは speedData.ts を保持', () => {
  it('レイアウト導入済み・速度未導入でも speedData.ts を残す（frame 対応 payload の import 解決のため）', () => {
    withProjectCopy((dir) => {
      // レイアウト導入済みをシミュレート（marker のみ）。
      mkdirSync(join(dir, 'src', 'MainLayout'), { recursive: true });
      writeFileSync(join(dir, 'src', 'MainLayout', 'main-layout.json'), JSON.stringify({ feature: 'mainLayout' }), 'utf8');
      // 速度は未導入（speed.json なし）。speedData.ts は不在。
      const speedAbs = join(dir, 'src', 'speedData.ts');
      expect(existsSync(speedAbs)).toBe(false);

      const loaded = loadProjectFromDir(dir);
      const req: SaveRequest = { project: { ...loaded.project, mainSpeed: 1 }, fingerprint: loaded.save.fingerprint };
      const res = saveProjectToDir(dir, req);
      expect(res.ok).toBe(true);

      // レイアウト導入済みなので speedData.ts が作成（保持）される。
      expect(existsSync(speedAbs)).toBe(true);
      expect(readFileSync(speedAbs, 'utf8')).toContain('MAIN_SPEED = 1');
    });
  });
});
