/**
 * 既存のコピー取り込みプロジェクトを「外付けの実体へのリンク」へ張り替える（容量回収）。
 * 破壊的な置換なので、順序（実体一致の再検証 → tombstone 退避 → symlink → 記録）と
 * 失敗時の巻き戻しをここで固定する。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertProjectToLink, findConvertCandidate } from './convertToLink';
import { listTrash } from './trashStore';
import { HttpError } from './http';
import type { BrowseRoot } from './browsePaths';

const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'sample-project');

let base: string;
let root: string;
let ssd: string;
let dir: string;

beforeEach(() => {
  // macOS の /var は /private/var への symlink。realpath を基準にしないと
  // 起点の realpath 解決を通った戻り値と文字列が一致しない。
  base = realpathSync(mkdtempSync(join(tmpdir(), 'sme-convert-')));
  root = join(base, 'projects');
  ssd = join(base, 'ssd');
  mkdirSync(root, { recursive: true });
  mkdirSync(ssd, { recursive: true });
  dir = join(root, 'proj');
  cpSync(SAMPLE, dir, { recursive: true });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function roots(): BrowseRoot[] {
  return [{ key: ssd, label: 'ssd', path: ssd }];
}

/** 外付け側に、プロジェクトのコピーと同一バイトの実体を置く。 */
function placeExternalCopy(name = 'take1.mp4'): string {
  const target = join(ssd, name);
  cpSync(join(dir, 'public', 'main.mp4'), target);
  return target;
}

const deps = () => ({ roots: roots(), chunkBytes: 16, symlinkOk: () => true });

describe('findConvertCandidate', () => {
  it('外付けに同一実体があれば候補を返す', () => {
    const target = placeExternalCopy();
    const r = findConvertCandidate(root, dir, deps());
    expect(r).toEqual({
      matched: true,
      target,
      sizeBytes: statSync(target).size,
      mtimeMs: statSync(target).mtimeMs,
    });
  });

  it('無ければ matched:false（メニューは出ても実行時に理由を返す）', () => {
    expect(findConvertCandidate(root, dir, deps())).toEqual({
      matched: false,
      reason: 'no-candidate',
    });
  });

  it('すでにリンク型なら 409（二重変換しない）', () => {
    placeExternalCopy();
    mkdirSync(join(dir, '.sme'), { recursive: true });
    writeFileSync(join(dir, '.sme', 'videoLink.json'), JSON.stringify({ target: '/x/y.mp4' }));
    expect(() => findConvertCandidate(root, dir, deps())).toThrow(HttpError);
  });

  it('メイン動画が symlink なら 409（実体コピーではない）', () => {
    const target = placeExternalCopy();
    rmSync(join(dir, 'public', 'main.mp4'));
    symlinkSync(target, join(dir, 'public', 'main.mp4'));
    expect(() => findConvertCandidate(root, dir, deps())).toThrow(HttpError);
  });

  it('プロジェクト置き場が起点配下でも、自分のコピーは候補にならない', () => {
    // 起点にプロジェクト置き場そのものを含めても、自分自身を実体にしない。
    const r = findConvertCandidate(root, dir, {
      ...deps(),
      roots: [{ key: root, label: 'projects', path: root }],
    });
    expect(r).toEqual({ matched: false, reason: 'no-candidate' });
  });
});

/**
 * プロジェクト配下に**実体として置かれている動画**のバイト合計。
 * symlink は数えない（実体を持たない＝内蔵を消費していない）。`.trash` の退避も
 * ディスクを食っている以上そのまま数える — ここが「回収した」の実測値になる。
 */
function realVideoBytes(target: string): number {
  let total = 0;
  for (const e of readdirSync(target, { withFileTypes: true })) {
    const full = join(target, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) total += realVideoBytes(full);
    else if (e.isFile() && /\.(mp4|mov|m4v)$/i.test(e.name)) total += statSync(full).size;
  }
  return total;
}

/** .trash 直下に残っている tombstone（UUID 名のディレクトリ）。 */
function tombstones(target: string): string[] {
  const trash = join(target, '.trash');
  if (!existsSync(trash)) return [];
  return readdirSync(trash).filter((n) => /^[0-9a-f-]{36}$/i.test(n));
}

describe('convertProjectToLink', () => {
  it('コピーを破棄して symlink を張り、記録を残す（回収した容量は実測どおり）', () => {
    const target = placeExternalCopy();
    const before = statSync(join(dir, 'public', 'main.mp4')).size;
    const bytesBefore = realVideoBytes(dir);
    const out = convertProjectToLink(root, dir, deps());
    expect(out).toEqual({ target, freedBytes: before });

    // 「N GB を回収しました」を真にする（I-1）。退避したままだと実バイトは減らない。
    expect(realVideoBytes(dir)).toBe(bytesBefore - before);
    expect(listTrash(dir)).toEqual([]);
    expect(tombstones(dir)).toEqual([]);

    // メイン動画は symlink になり、実体は外付けを指す。
    expect(lstatSync(join(dir, 'public', 'main.mp4')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(dir, 'public', 'main.mp4'), 'utf8')).toBe(readFileSync(target, 'utf8'));

    // 記録（リンク切れ・差し替え検出の正本）。
    const record = JSON.parse(readFileSync(join(dir, '.sme', 'videoLink.json'), 'utf8')) as {
      target: string; sizeBytes: number; fps: number;
    };
    expect(record.target).toBe(target);
    expect(record.sizeBytes).toBe(before);
    expect(record.fps).toBe(60); // videoConfig.ts の値をそのまま使う（実体は同一バイト）
  });

  it('退避の破棄に失敗したら「回収 0・コピーはゴミ箱に残った」と正直に返す', () => {
    placeExternalCopy();
    const out = convertProjectToLink(root, dir, {
      ...deps(),
      discard: () => { throw new Error('discard boom'); },
    });
    // リンク自体は成立しているので巻き戻さない。ただし容量は回収できていない。
    expect(lstatSync(join(dir, 'public', 'main.mp4')).isSymbolicLink()).toBe(true);
    expect(out.freedBytes).toBe(0);
    expect(out.keptCopyPath).toContain('.trash');
    expect(listTrash(dir).map((e) => e.originalPath)).toContain(join('public', 'main.mp4'));
  });

  it('候補が無ければ 409 で、プロジェクトには一切触れない', () => {
    const before = readFileSync(join(dir, 'public', 'main.mp4'));
    expect(() => convertProjectToLink(root, dir, deps())).toThrow(HttpError);
    expect(readFileSync(join(dir, 'public', 'main.mp4'))).toEqual(before);
    expect(listTrash(dir)).toEqual([]);
  });

  it('symlink を作れない環境なら 400 で、コピーは元の場所に戻る', () => {
    placeExternalCopy();
    const before = readFileSync(join(dir, 'public', 'main.mp4'));
    expect(() =>
      convertProjectToLink(root, dir, { ...deps(), symlinkOk: () => false }),
    ).toThrow(HttpError);
    expect(readFileSync(join(dir, 'public', 'main.mp4'))).toEqual(before);
    expect(listTrash(dir)).toEqual([]);
  });

  it('リンク作成に失敗したらコピーを復元して失敗させる（動画を失わない）', () => {
    placeExternalCopy();
    const before = readFileSync(join(dir, 'public', 'main.mp4'));
    expect(() =>
      convertProjectToLink(root, dir, {
        ...deps(),
        link: () => { throw new Error('symlink boom'); },
      }),
    ).toThrow(HttpError);
    expect(lstatSync(join(dir, 'public', 'main.mp4')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, 'public', 'main.mp4'))).toEqual(before);
    // 巻き戻したので tombstone も残らない。
    expect(listTrash(dir)).toEqual([]);
  });

  it('巻き戻しの後、ゴミ箱に残骸（tombstone ディレクトリ）を残さない（I-2）', () => {
    placeExternalCopy();
    expect(() =>
      convertProjectToLink(root, dir, {
        ...deps(),
        link: () => { throw new Error('symlink boom'); },
      }),
    ).toThrow(HttpError);
    // 一覧（manifest）だけでなく実体側も空。残ると「復元できる動画」が二重に見える。
    expect(listTrash(dir)).toEqual([]);
    expect(tombstones(dir)).toEqual([]);
  });

  it('巻き戻しで symlink を消せなかったら、その状態を文言に出す（M-6）', () => {
    placeExternalCopy();
    const err = (() => {
      try {
        convertProjectToLink(root, dir, {
          ...deps(),
          writeLink: () => { throw new Error('write boom'); },
          rm: () => { throw new Error('rm boom'); },
        });
        return null;
      } catch (e) {
        return e as HttpError;
      }
    })();
    expect(err).toBeInstanceOf(HttpError);
    expect(err?.message).toContain('public/main.mp4 が中途半端なリンクのまま残りました');
    // 元の動画の在り処も必ず伝える（利用者が自力で戻せる情報）。
    expect(err?.message).toContain('.trash');
  });

  it('記録の書き込みに失敗したら symlink を撤去してコピーを復元する', () => {
    placeExternalCopy();
    const before = readFileSync(join(dir, 'public', 'main.mp4'));
    expect(() =>
      convertProjectToLink(root, dir, {
        ...deps(),
        writeLink: () => { throw new Error('write boom'); },
      }),
    ).toThrow(HttpError);
    expect(lstatSync(join(dir, 'public', 'main.mp4')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, 'public', 'main.mp4'))).toEqual(before);
    expect(existsSync(join(dir, '.sme', 'videoLink.json'))).toBe(false);
    expect(listTrash(dir)).toEqual([]);
  });
});
