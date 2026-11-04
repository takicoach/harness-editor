import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importMediaFolder, scanMediaFiles } from './importMediaFolder';
import { HttpError } from './http';

const dirs: string[] = [];
function tempDir(prefix = 'sme-import-folder-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeMedia(path: string, bytes = 8): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes));
}

/** 書類はフォルダを用意してから置く（素材フォルダと同じく入れ子に置かれる）。 */
function writeDocument(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/** 撮影日ごとにサブフォルダへ分かれた、よくある素材フォルダ。 */
function materialsFolder(): string {
  const folder = tempDir('sme-materials-');
  writeMedia(join(folder, '撮影日1120', 'clip1.mp4'));
  writeMedia(join(folder, '撮影日1120', 'clip2.MOV'));
  writeMedia(join(folder, '撮影日1121', 'sub', 'clip3.mp4'));
  writeMedia(join(folder, 'bgm.mp3'));
  writeMedia(join(folder, 'images', 'thumb.png'));
  // 台本は Word・PDF・テキスト・Markdown・字幕の5形式を拾う（中身は読まない）。
  writeFileSync(join(folder, '台本.docx'), 'word');
  writeDocument(join(folder, '資料', '構成.md'), 'markdown');
  writeFileSync(join(folder, 'テロップ.srt'), '1\n00:00:00,000 --> 00:00:01,000\nこんにちは\n');
  writeFileSync(join(folder, '請求書.xlsx'), '書類だが台本の形式ではないので拾わない');
  return folder;
}

describe('scanMediaFiles', () => {
  it('サブフォルダを再帰し、相対パスと階層を付けて拡張子一致だけ集める', () => {
    const folder = materialsFolder();
    const found = scanMediaFiles(folder, ['.mp4', '.mov']);
    expect(found.map((item) => item.relativePath).sort()).toEqual([
      '撮影日1120/clip1.mp4',
      '撮影日1120/clip2.MOV',
      '撮影日1121/sub/clip3.mp4',
    ]);
    expect(found.find((item) => item.relativePath === '撮影日1121/sub/clip3.mp4')?.depth).toBe(2);
  });

  it('ドットで始まるファイル・フォルダは見ない', () => {
    const folder = tempDir('sme-materials-');
    writeMedia(join(folder, '.hidden', 'clip.mp4'));
    writeMedia(join(folder, '.clip.mp4'));
    writeMedia(join(folder, 'clip.mp4'));
    expect(scanMediaFiles(folder, ['.mp4']).map((item) => item.relativePath)).toEqual(['clip.mp4']);
  });

  it('ディレクトリへのシンボリックリンクは辿らない（循環で固まらない）', () => {
    const folder = tempDir('sme-materials-');
    writeMedia(join(folder, 'clip.mp4'));
    symlinkSync(folder, join(folder, 'loop'));
    expect(scanMediaFiles(folder, ['.mp4']).map((item) => item.relativePath)).toEqual(['clip.mp4']);
  });

  it('深さ・件数の上限で打ち切る', () => {
    const folder = tempDir('sme-materials-');
    writeMedia(join(folder, 'a', 'b', 'c', 'deep.mp4'));
    writeMedia(join(folder, 'top.mp4'));
    expect(scanMediaFiles(folder, ['.mp4'], { maxDepth: 1 }).map((item) => item.relativePath)).toEqual(['top.mp4']);
    expect(scanMediaFiles(folder, ['.mp4'], { maxFiles: 1 })).toHaveLength(1);
  });
});

describe('importMediaFolder', () => {
  it('フォルダ1つから作品を1つ作り、中身を全部素材として記録する', async () => {
    const root = tempDir('sme-projects-');
    const folder = materialsFolder();
    const result = await importMediaFolder(root, { folderPath: folder, name: '撮影素材' });

    expect(result.counts).toEqual({ videos: 3, audio: 1, images: 1, documents: 3 });
    const directory = join(root, result.id);
    // 素材はコピーせず、フォルダ本体へのリンクで参照する。
    expect(readlinkSync(join(directory, '素材'))).toBe(folder);
    expect(existsSync(join(directory, '.harness', 'project.v2.json'))).toBe(true);

    const record = JSON.parse(readFileSync(join(directory, '.sme', 'materials.json'), 'utf8'));
    expect(record.materialsDir).toBe(folder);
    // 入れ子のままの相対パス＝ `素材/<relativePath>` で開ける。
    expect(record.materials.videos.sort()).toEqual([
      '撮影日1120/clip1.mp4',
      '撮影日1120/clip2.MOV',
      '撮影日1121/sub/clip3.mp4',
    ]);
    expect(record.materials.audio).toEqual(['bgm.mp3']);
    expect(record.materials.images).toEqual(['images/thumb.png']);
    // 台本・構成・字幕も素材として記録する（拾うのは docx / pdf / txt / md / srt）。
    expect(record.materials.documents.sort()).toEqual(['テロップ.srt', '台本.docx', '資料/構成.md']);
    const guide = readFileSync(join(directory, 'CLAUDE.md'), 'utf8');
    expect(guide).toContain('素材/<relativePath>');
    expect(guide).toContain('`素材/台本.docx`');
  });

  it('作品名を省いたらフォルダ名を使う', async () => {
    const root = tempDir('sme-projects-');
    const folder = materialsFolder();
    const result = await importMediaFolder(root, { folderPath: folder });
    expect(result.id).toBe(folder.split('/').pop());
  });

  it('フォルダでなければ not-a-directory（画面がファイル作成へ戻すための合図）', async () => {
    const root = tempDir('sme-projects-');
    const folder = tempDir('sme-materials-');
    const file = join(folder, 'clip.mp4');
    writeMedia(file);
    await expect(importMediaFolder(root, { folderPath: file })).rejects.toMatchObject({
      status: 400,
      message: 'not-a-directory',
    });
  });

  it('見つからないフォルダ・メディアが1件も無いフォルダは作らずに断る', async () => {
    const root = tempDir('sme-projects-');
    const empty = tempDir('sme-materials-');
    writeFileSync(join(empty, 'メモ.txt'), 'media ではない');
    await expect(importMediaFolder(root, { folderPath: join(empty, 'なし') })).rejects.toBeInstanceOf(HttpError);
    await expect(importMediaFolder(root, { folderPath: empty })).rejects.toMatchObject({ status: 400 });
    expect(existsSync(join(root, empty.split('/').pop() ?? ''))).toBe(false);
  });

  it('同じ名前の作品があるときは上書きしない', async () => {
    const root = tempDir('sme-projects-');
    const folder = materialsFolder();
    await importMediaFolder(root, { folderPath: folder, name: '撮影素材' });
    await expect(importMediaFolder(root, { folderPath: folder, name: '撮影素材' })).rejects.toMatchObject({
      status: 409,
    });
  });
});
