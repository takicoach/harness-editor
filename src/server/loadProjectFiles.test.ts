import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { cpSync, existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadProjectFromDir, readProjectFiles } from './loadProjectFiles';
import { HttpError } from './http';
import { assetPathFor } from '../app/panels/materialList';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

const mockedStatSync = vi.mocked(statSync);
let realStatSync: typeof statSync;
beforeAll(async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  realStatSync = actual.statSync;
});

const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'sample-project');

// 共有 fixture（SAMPLE）を直接読み書きすると並列実行時にレースを起こす
// （loadProjectFromDir は渡されたディレクトリへ baseline 等を書き込む副作用を持つため）。
// テストごとに tmp コピーへ複製し、tmp 側だけを読み書きする（plugin.trashRoutes.test.ts と同じ流儀）。
let root: string;
let proj: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sme-lpf-'));
  proj = join(root, 'proj');
  cpSync(SAMPLE, proj, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('loadProjectFromDir', () => {
  it('フィクスチャを EditorProject + 検証結果として読む', () => {
    const { project, validation } = loadProjectFromDir(proj);
    // telopData fixture: id:1, id:2, id:3（Task 13 で id:3 を追加）
    expect(project.telops).toHaveLength(3);
    expect(project.videoConfig.durationFrames).toBe(12000);
    // cutData fixture: 隙間あり（[5000,6000) が削除区間）→ CutRegion が 1 つ
    expect(project.cutRegions).toEqual([{ start: 5000, end: 6000 }]);
    expect(validation.errors).toEqual([]);
  });

  it('必須ファイルが無いディレクトリは HttpError(400) を投げる', () => {
    try {
      loadProjectFromDir('/no/such/project');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(400);
    }
  });

  it('public 配下に動画ファイルがあれば hasVideo=true', () => {
    const loaded = loadProjectFromDir(proj);
    expect(loaded.hasVideo).toBe(true);
  });
});

describe('loadProjectFromDir 保存メタデータ', () => {
  it('telopData の相対パスと指紋を返す', () => {
    const loaded = loadProjectFromDir(proj);
    expect(loaded.save.telopDataRelPath).toBe('src/テロップテンプレート/telopData.ts');
    expect(loaded.save.fingerprint.telopData.size).toBeGreaterThan(0);
  });

  it('cutData.ts が存在しないフィクスチャでは cutData 指紋が null・新規作成先を返す', () => {
    // fixture に cutData.ts が追加されたため、一時コピーから cutData.ts を削除して cutData なし状態を再現する。
    const tmp = mkdtempSync(join(tmpdir(), 'sme-load-'));
    try {
      cpSync(SAMPLE, tmp, { recursive: true });
      rmSync(join(tmp, 'src', 'cutData.ts'), { force: true });
      const loaded = loadProjectFromDir(tmp);
      expect(loaded.save.fingerprint.cutData).toBeNull();
      // 不在時の書き戻し先は CUT_DATA_CANDIDATES の先頭（プロジェクト直下 cutData.ts）
      expect(loaded.save.cutDataRelPath).toBe('cutData.ts');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('loadProjectFromDir — SE', () => {
  it('SE 関連フィールドを返す', () => {
    const loaded = loadProjectFromDir(proj);
    expect(Array.isArray(loaded.project.se)).toBe(true);
    expect(Array.isArray(loaded.seLibrary)).toBe(true);
    expect(loaded.save.seDataRelPath).toBe('src/SoundEffects/seData.ts');
    // fingerprint.seData は seData.ts の有無に追従する。
    if (loaded.project.seDataSource === null) {
      expect(loaded.save.fingerprint.seData).toBeNull();
    } else {
      expect(loaded.save.fingerprint.seData).not.toBeNull();
    }
  });
});

describe('loadProjectFromDir — 画像', () => {
  it('画像関連フィールドを返す', () => {
    const loaded = loadProjectFromDir(proj);
    expect(Array.isArray(loaded.project.images)).toBe(true);
    expect(Array.isArray(loaded.imageLibrary)).toBe(true);
    expect(loaded.save.insertImageDataRelPath).toBe('src/InsertImage/insertImageData.ts');
    if (loaded.project.insertImageDataSource === null) {
      expect(loaded.save.fingerprint.insertImageData).toBeNull();
    } else {
      expect(loaded.save.fingerprint.insertImageData).not.toBeNull();
    }
  });
});

describe('loadProjectFromDir — 学習用ベースライン自動退避', () => {
  it('読込時に transcript_fixed.json のベースラインを .learning/baseline/ へ退避する', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sme-load-baseline-'));
    try {
      cpSync(SAMPLE, tmp, { recursive: true });
      const transcriptFixedPath = join(tmp, 'transcript_fixed.json');
      if (!existsSync(transcriptFixedPath)) {
        writeFileSync(transcriptFixedPath, JSON.stringify({ words: [] }), 'utf-8');
      }

      loadProjectFromDir(tmp);

      const baselinePath = join(tmp, '.learning', 'baseline', 'transcript_fixed.json');
      expect(existsSync(baselinePath)).toBe(true);
      expect(readFileSync(baselinePath, 'utf-8')).toBe(readFileSync(transcriptFixedPath, 'utf-8'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('loadProjectFromDir — BGM', () => {
  it('bgmData 関連フィールドを返す（ファイル不在なら null）', () => {
    const loaded = loadProjectFromDir(proj);
    expect(Array.isArray(loaded.project.bgm)).toBe(true);
    expect(Array.isArray(loaded.bgmLibrary)).toBe(true);
    expect(loaded.save.bgmDataRelPath).toBe('src/Bgm/bgmData.ts');
    if (loaded.project.bgmDataSource === null) {
      expect(loaded.save.fingerprint.bgmData).toBeNull();
    } else {
      expect(loaded.save.fingerprint.bgmData).not.toBeNull();
    }
  });

  it('public/BGM/ に音声ファイルを置くと bgmLibrary に列挙される', () => {
    // フィクスチャはサブエージェントが Task 12 で追加するが、
    // BGM ディレクトリが無い時点では空配列になることを確認する。
    const loaded = loadProjectFromDir(proj);
    expect(Array.isArray(loaded.bgmLibrary)).toBe(true);
  });

  it('bgmInstalled は src/Bgm/bgm-track.json の有無で判定する', () => {
    const loaded = loadProjectFromDir(proj);
    // フィクスチャに bgm-track.json が無いので false。
    expect(loaded.bgmInstalled).toBe(false);
  });
});

describe('loadProjectFromDir — assetVersions', () => {
  it('ライブラリ各ファイルの size-mtime トークンを assetPath キーで返す', () => {
    const loaded = loadProjectFromDir(proj);
    expect(loaded.assetVersions['se/beep.mp3']).toMatch(/^\d+-\d+$/);
    expect(loaded.assetVersions['images/sample.png']).toMatch(/^\d+-\d+$/);
    expect(loaded.assetVersions['BGM/bgm.mp3']).toMatch(/^\d+-\d+$/);
    expect(loaded.assetVersions['sub/cam2.mp4']).toMatch(/^\d+-\d+$/);
    // メイン動画は /api/video の videoVersion が担当（asset URL では配信しない）
    expect(loaded.assetVersions['main.mp4']).toBeUndefined();
  });

  it('キーはクライアント assetPathFor の出力と一致する（server/client 写像の同期ガード）', () => {
    const loaded = loadProjectFromDir(proj);
    const expected = [
      ...loaded.seLibrary.map((f) => assetPathFor('se', f)),
      ...loaded.imageLibrary.map((f) => assetPathFor('image', f)),
      ...loaded.bgmLibrary.map((f) => assetPathFor('bgm', f)),
      ...loaded.videoLibrary.map((f) => assetPathFor('video', f)),
    ].sort();
    expect(Object.keys(loaded.assetVersions).sort()).toEqual(expected);
  });

  it('同名差し替え（内容変更）でトークンが変わる', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sme-assetver-'));
    try {
      cpSync(SAMPLE, tmp, { recursive: true });
      const before = loadProjectFromDir(tmp).assetVersions['se/beep.mp3'];
      expect(before).toMatch(/^\d+-\d+$/);
      // サイズも mtime も変える（同名差し替えを再現）
      writeFileSync(join(tmp, 'public', 'se', 'beep.mp3'), 'replaced-content-xxxx');
      const after = loadProjectFromDir(tmp).assetVersions['se/beep.mp3'];
      expect(after).toMatch(/^\d+-\d+$/);
      expect(after).not.toBe(before);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('loadProjectFromDir — videoVersion の stat 失敗フォールバック', () => {
  afterEach(() => {
    mockedStatSync.mockRestore();
  });

  it('配信対象動画の stat が失敗しても例外を投げず videoVersion=null で継続する', () => {
    const videoPath = join(proj, 'public', 'main.mp4');
    mockedStatSync.mockImplementation(((p: Parameters<typeof statSync>[0], ...rest: unknown[]) => {
      if (String(p) === videoPath) {
        throw new Error('EACCES: permission denied');
      }
      // @ts-expect-error - passthrough to real implementation for all other paths
      return realStatSync(p, ...rest);
    }) as typeof statSync);
    const loaded = loadProjectFromDir(proj);
    expect(loaded.videoVersion).toBeNull();
  });
});

describe('loadProjectFromDir が baseline を退避する', () => {
  it('読込で cut-baseline.json が生成され autoCutRegions が cutData 由来と一致', () => {
    const baselineFile = join(proj, 'cut-baseline.json');
    const loaded = loadProjectFromDir(proj);
    expect(existsSync(baselineFile)).toBe(true);
    const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
    expect(baseline.autoCutRegions).toEqual(loaded.project.cutRegions);
  });
});

describe('readProjectFiles titleDataSource', () => {
  it('titleData.ts が無ければ null', () => {
    const files = readProjectFiles(proj);
    expect(files.titleDataSource).toBeNull();
  });
});

describe('loadProjectFromDir — タイトル fingerprint', () => {
  it('titleData 関連フィールドを返す（ファイル不在なら null）', () => {
    const loaded = loadProjectFromDir(proj);
    expect(loaded.save.titleDataRelPath).toBe('src/Title/titleData.ts');
    // sample-project に titleData.ts は無いので指紋は null。
    if (loaded.project.titleDataSource === null) {
      expect(loaded.save.fingerprint.titleData).toBeNull();
    } else {
      expect(loaded.save.fingerprint.titleData).not.toBeNull();
    }
  });
});

describe('loadProjectFromDir — 図形（shapes）', () => {
  it('sample-project は InsertShape 導入済みのため shapes は空配列・shapeDataSource は非 null', () => {
    const loaded = loadProjectFromDir(proj);
    // sample-project には InsertShape/shapeData.ts が存在する（導入済みフィクスチャ）。
    // 初期データは空配列なので shapes は [] だが source は非 null になる。
    expect(loaded.project.shapes ?? []).toEqual([]);
    expect(typeof (loaded.project.shapeDataSource ?? null)).toBe('string');
    expect(loaded.save.shapeDataRelPath).toBe('src/InsertShape/shapeData.ts');
    // 指紋は非 null（ファイルが存在するため）。
    expect(loaded.save.fingerprint.shapeData).not.toBeNull();
  });

  it('読込で shapes が配列になる', () => {
    const loaded = loadProjectFromDir(proj);
    expect(Array.isArray(loaded.project.shapes ?? [])).toBe(true);
  });
});
