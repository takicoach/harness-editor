// src/server/trashVideo.test.ts
/**
 * ゴミ箱カードのサムネイル配信のパス解決。
 * 配信パスは **クライアントから受け取らず** manifest（検証済み entry）＋ tombstone 内の
 * videoConfig.ts だけから導出する。ここで固定するのはその封じ込め規律
 * （UUID 以外の entryId・種別違い・トラバーサル・.trash の外・非通常ファイル）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTrashVideoPath } from './trashVideo';
import { moveToTrash, TRASH_DIR } from './trashStore';
import { HttpError } from './http';

const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'sample-project');

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sme-trashvideo-'));
  outside = mkdtempSync(join(tmpdir(), 'sme-outside-'));
  cpSync(SAMPLE, join(root, 'proj'), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** proj をゴミ箱へ移し、その entryId と tombstone 内のプロジェクトパスを返す。 */
function trashProject(): { entryId: string; dir: string } {
  const entry = moveToTrash(root, 'proj', 'project');
  return { entryId: entry.id, dir: join(root, TRASH_DIR, entry.id, entry.name) };
}

function statusOf(fn: () => unknown): number {
  try {
    fn();
  } catch (e) {
    if (e instanceof HttpError) return e.status;
    throw e;
  }
  return 200;
}

/** 400/404 の理由まで固定したい時に使う（別の理由で偶然 400 になっていないか）。 */
function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof HttpError) return e.message;
    throw e;
  }
  return '';
}

describe('resolveTrashVideoPath', () => {
  it('tombstone 内のメイン動画を返す（返り値は realpath 済み＝M-1）', () => {
    const { entryId, dir } = trashProject();
    // 検査したパスと配信するパスを同一にする（検査後に realpath を取り直さない）。
    expect(resolveTrashVideoPath(root, entryId)).toBe(realpathSync(join(dir, 'public', 'main.mp4')));
  });

  it('軽量プレビュープロキシがあれば原本より優先する（I-2）', () => {
    const { entryId, dir } = trashProject();
    const proxy = join(dir, 'public', 'main.preview.mp4');
    writeFileSync(proxy, 'PROXY', 'utf8');
    expect(resolveTrashVideoPath(root, entryId)).toBe(realpathSync(proxy));
  });

  // プロキシ経路の敵対テスト（レビュー M-5）。原本 main.mp4 が普通のファイルでも、
  // **プロキシ側を symlink にすれば**配信されるのは選ばれた後のパス＝プロキシになる。
  // 検査はプロキシ選択の後に掛かるので、原本と同じ規律がプロキシにも効く必要がある。
  it('プロキシ（main.preview.mp4）がリンク記録の無い symlink なら 400（M-5）', () => {
    const { entryId, dir } = trashProject();
    writeFileSync(join(outside, 'real.mp4'), 'OUTSIDE', 'utf8');
    symlinkSync(join(outside, 'real.mp4'), join(dir, 'public', 'main.preview.mp4'));
    expect(statusOf(() => resolveTrashVideoPath(root, entryId))).toBe(400);
    // 理由まで固定する（「プロキシが見つからない」等の別の 400 で緑にならないように）。
    expect(messageOf(() => resolveTrashVideoPath(root, entryId))).toBe('リンク記録の無いリンクは配信できません');
  });

  it('プロキシが記録と食い違う symlink なら 400（記録は原本の接続先・M-5）', () => {
    writeFileSync(join(outside, 'recorded.mp4'), 'RECORDED', 'utf8');
    writeFileSync(join(outside, 'other.mp4'), 'OTHER', 'utf8');
    // 原本はリンク取り込み（記録どおり）。プロキシだけ別の外部ファイルへ張り替える。
    rmSync(join(root, 'proj', 'public', 'main.mp4'), { force: true });
    symlinkSync(join(outside, 'recorded.mp4'), join(root, 'proj', 'public', 'main.mp4'));
    symlinkSync(join(outside, 'other.mp4'), join(root, 'proj', 'public', 'main.preview.mp4'));
    mkdirSync(join(root, 'proj', '.sme'), { recursive: true });
    writeFileSync(
      join(root, 'proj', '.sme', 'videoLink.json'),
      JSON.stringify({ target: join(outside, 'recorded.mp4'), sizeBytes: 8, mtimeMs: 0, width: 1920, height: 1080, fps: 30 }),
      'utf8',
    );
    const { entryId } = trashProject();
    expect(statusOf(() => resolveTrashVideoPath(root, entryId))).toBe(400);
    expect(messageOf(() => resolveTrashVideoPath(root, entryId)))
      .toBe('記録された接続先と異なるリンクは配信できません');
  });

  it('UUID 形式でない entryId は 400（manifest を引く前に弾く）', () => {
    trashProject();
    expect(statusOf(() => resolveTrashVideoPath(root, '../../etc/passwd'))).toBe(400);
    expect(statusOf(() => resolveTrashVideoPath(root, 'e1'))).toBe(400);
    expect(statusOf(() => resolveTrashVideoPath(root, ''))).toBe(400);
  });

  it('manifest に無い UUID は 404', () => {
    trashProject();
    expect(statusOf(() => resolveTrashVideoPath(root, '11111111-2222-3333-4444-555555555555'))).toBe(404);
  });

  it('プロジェクト以外（素材）の entry は 400', () => {
    const entry = moveToTrash(root, join('proj', 'public', 'se', 'beep.mp3'), 'se');
    expect(statusOf(() => resolveTrashVideoPath(root, entry.id))).toBe(400);
  });

  it('videoConfig.ts を読めない tombstone は 404（一覧を壊さない）', () => {
    const { entryId, dir } = trashProject();
    writeFileSync(join(dir, 'src', 'videoConfig.ts'), 'export const BROKEN = 1;\n', 'utf8');
    expect(statusOf(() => resolveTrashVideoPath(root, entryId))).toBe(404);
  });

  it('videoFile にパス区切り・.. が入っていれば 400（設定ファイル経由のトラバーサル拒否）', () => {
    const { entryId, dir } = trashProject();
    const vc = readFileSync(join(dir, 'src', 'videoConfig.ts'), 'utf8');
    writeFileSync(
      join(dir, 'src', 'videoConfig.ts'),
      vc.replace("VIDEO_FILE = 'main.mp4'", "VIDEO_FILE = '../../../../etc/passwd'"),
      'utf8',
    );
    expect(statusOf(() => resolveTrashVideoPath(root, entryId))).toBe(400);
  });

  it('動画の無い tombstone は 404（プレースホルダへ落とす）', () => {
    const { entryId, dir } = trashProject();
    rmSync(join(dir, 'public', 'main.mp4'), { force: true });
    expect(statusOf(() => resolveTrashVideoPath(root, entryId))).toBe(404);
  });

  it('public が外部フォルダへの symlink なら 400（.trash の外は配信しない）', () => {
    const { entryId, dir } = trashProject();
    mkdirSync(join(outside, 'public'), { recursive: true });
    writeFileSync(join(outside, 'public', 'main.mp4'), 'OUTSIDE', 'utf8');
    rmSync(join(dir, 'public'), { recursive: true, force: true });
    symlinkSync(join(outside, 'public'), join(dir, 'public'));
    expect(statusOf(() => resolveTrashVideoPath(root, entryId))).toBe(400);
  });

  it('リンク記録の無いプロジェクトに仕込まれた symlink は 400', () => {
    const { entryId, dir } = trashProject();
    writeFileSync(join(outside, 'real.mp4'), 'OUTSIDE', 'utf8');
    rmSync(join(dir, 'public', 'main.mp4'), { force: true });
    symlinkSync(join(outside, 'real.mp4'), join(dir, 'public', 'main.mp4'));
    expect(statusOf(() => resolveTrashVideoPath(root, entryId))).toBe(400);
  });

  it('リンク取り込み（.sme/videoLink.json あり）の symlink は配信できる', () => {
    writeFileSync(join(outside, 'real.mp4'), 'OUTSIDE', 'utf8');
    rmSync(join(root, 'proj', 'public', 'main.mp4'), { force: true });
    symlinkSync(join(outside, 'real.mp4'), join(root, 'proj', 'public', 'main.mp4'));
    mkdirSync(join(root, 'proj', '.sme'), { recursive: true });
    writeFileSync(
      join(root, 'proj', '.sme', 'videoLink.json'),
      JSON.stringify({ target: join(outside, 'real.mp4'), sizeBytes: 7, mtimeMs: 0, width: 1920, height: 1080, fps: 30 }),
      'utf8',
    );
    const { entryId } = trashProject();
    expect(resolveTrashVideoPath(root, entryId)).toBe(realpathSync(join(outside, 'real.mp4')));
  });

  it('記録された接続先と実際のリンク先が食い違えば 400（I-1）', () => {
    // videoLink.json の「存在」だけで symlink を許すと、記録と無関係な外部ファイルへ
    // 張り替えたリンクがそのまま配信される。実体の一致まで要求する。
    writeFileSync(join(outside, 'recorded.mp4'), 'RECORDED', 'utf8');
    writeFileSync(join(outside, 'other.mp4'), 'OTHER', 'utf8');
    rmSync(join(root, 'proj', 'public', 'main.mp4'), { force: true });
    symlinkSync(join(outside, 'other.mp4'), join(root, 'proj', 'public', 'main.mp4'));
    mkdirSync(join(root, 'proj', '.sme'), { recursive: true });
    writeFileSync(
      join(root, 'proj', '.sme', 'videoLink.json'),
      JSON.stringify({ target: join(outside, 'recorded.mp4'), sizeBytes: 8, mtimeMs: 0, width: 1920, height: 1080, fps: 30 }),
      'utf8',
    );
    const { entryId } = trashProject();
    expect(statusOf(() => resolveTrashVideoPath(root, entryId))).toBe(400);
  });

  it('リンク切れ（接続先が外れている）は 404 でプレースホルダへ落とす', () => {
    rmSync(join(root, 'proj', 'public', 'main.mp4'), { force: true });
    symlinkSync(join(outside, 'gone.mp4'), join(root, 'proj', 'public', 'main.mp4'));
    mkdirSync(join(root, 'proj', '.sme'), { recursive: true });
    writeFileSync(
      join(root, 'proj', '.sme', 'videoLink.json'),
      JSON.stringify({ target: join(outside, 'gone.mp4'), sizeBytes: 7, mtimeMs: 0, width: 1920, height: 1080, fps: 30 }),
      'utf8',
    );
    const { entryId } = trashProject();
    expect(statusOf(() => resolveTrashVideoPath(root, entryId))).toBe(404);
  });

  it('通常ファイルでなければ 400（FIFO・ディレクトリを配信しない）', () => {
    const { entryId, dir } = trashProject();
    rmSync(join(dir, 'public', 'main.mp4'), { force: true });
    mkdirSync(join(dir, 'public', 'main.mp4'), { recursive: true });
    expect(statusOf(() => resolveTrashVideoPath(root, entryId))).toBe(400);
  });
});
