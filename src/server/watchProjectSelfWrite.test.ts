/**
 * 自己保存で自分の画面に外部変更バナーが出ない（サイクル 2 レビュー Important）。
 *
 * 監視・自己書込ウィンドウ・内容判定を **実物のまま** 組み合わせて回す。
 * 純ロジック側（changeNotifier.test.ts）は偽タイマーで判定の形を固定するが、
 * 「保存 → chokidar → 窓明けの再評価」という実際の連鎖で誤警告が消えたことは
 * ここでしか確かめられない（誤発火は実配線の側で起きていた）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { watchProject } from './watchProject';
import { projectContentSignature } from './projectWatchPaths';
import {
  clearSelfWrite,
  isSelfWriteContent,
  isSelfWriting,
  markSelfWrite,
  recordSelfWriteContent,
  selfWriteRemainingMs,
} from './selfWrite';

const PROJECT = 'watch-self-write';
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  clearSelfWrite(PROJECT);
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function makeProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sme-watch-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const telop = join(dir, 'src', 'テロップテンプレート', 'telopData.ts');
  mkdirSync(dirname(telop), { recursive: true });
  writeFileSync(telop, 'export const TELOP_DATA = [];\n');
  return dir;
}

/** 実サーバ（eventsApi.wireWatchChannel）と同じ配線で watch を開始する。 */
function startWatch(dir: string, writerId: string, onChange: () => void): void {
  const stop = watchProject(dir, onChange, {
    debounceMs: 500, // 本番既定と同じ（FS イベントの分裂を production と同じ幅で束ねる）
    isSelfWrite: () => isSelfWriting(PROJECT, writerId),
    selfWriteRemainingMs: () => selfWriteRemainingMs(PROJECT, writerId),
    isSelfContent: () => isSelfWriteContent(PROJECT, writerId, projectContentSignature(dir)),
  });
  cleanups.push(stop);
}

/** PUT /api/project と同じ順序で保存する（マーク → 書込 → 指紋の記録）。 */
function saveAs(dir: string, writerId: string, source: string): void {
  markSelfWrite(PROJECT, writerId);
  writeFileSync(join(dir, 'src', 'テロップテンプレート', 'telopData.ts'), source);
  recordSelfWriteContent(PROJECT, projectContentSignature(dir));
}

describe('自己保存と外部変更の見分け（実配線）', () => {
  it('自分で保存しただけなら onChange は 0 回（自分の画面に誤警告を出さない）', async () => {
    const dir = makeProjectDir();
    const onChange = vi.fn();
    startWatch(dir, 'writer-A', onChange);
    await sleep(400); // chokidar の初期スキャン待ち

    saveAs(dir, 'writer-A', 'export const TELOP_DATA = [1];\n');

    // 自己書込ウィンドウ（1500ms）＋再評価の余裕を十分に超えて待つ。
    await sleep(2600);
    expect(onChange).not.toHaveBeenCalled();
  }, 20000);

  it('保存直後に外部が書き換えたら onChange は 1 回（data-safety-6 を壊さない）', async () => {
    const dir = makeProjectDir();
    const onChange = vi.fn();
    startWatch(dir, 'writer-A', onChange);
    await sleep(400);

    saveAs(dir, 'writer-A', 'export const TELOP_DATA = [1];\n');
    // 自己書込ウィンドウの最中に外部（Claude Code 等）が書き換える。
    await sleep(200);
    writeFileSync(
      join(dir, 'src', 'テロップテンプレート', 'telopData.ts'),
      'export const TELOP_DATA = [999];\n',
    );

    await sleep(2600);
    expect(onChange).toHaveBeenCalledTimes(1);
  }, 20000);

  it('導入 API（writerId 無しのマーク＋指紋記録）でも onChange は 0 回／その後の外部書換は 1 回', async () => {
    // install 系ルートは writerId を持たない（POST にヘッダが無い）。
    // markSelfWrite(id) だけでは窓明けの再評価が必ず通り、自分で押した導入で
    // バナーが出ていた（サイクル 3 レビュー Important）。指紋の記録で塞ぐ。
    const dir = makeProjectDir();
    // 監視対象として既に在るファイルを導入 API が書き換える形にする
    // （新規作成の add に頼ると「そもそもイベントが起きていない」緑と区別できない）。
    const shape = join(dir, 'src', 'InsertShape', 'shapeData.ts');
    mkdirSync(dirname(shape), { recursive: true });
    writeFileSync(shape, 'export const SHAPE_DATA = [];\n');

    const onChange = vi.fn();
    startWatch(dir, 'writer-A', onChange);
    await sleep(400);

    // install 相当: マーク（writerId 無し）→ 監視対象ファイルを書き換え → 指紋を記録。
    markSelfWrite(PROJECT);
    writeFileSync(shape, 'export const SHAPE_DATA = [1];\n');
    recordSelfWriteContent(PROJECT, projectContentSignature(dir));

    await sleep(2600);
    expect(onChange).not.toHaveBeenCalled();

    // 本物の外部変更は従来どおり通る。
    writeFileSync(shape, 'export const SHAPE_DATA = [999];\n');
    await sleep(2600);
    expect(onChange).toHaveBeenCalledTimes(1);
  }, 20000);

  it('別画面の保存は外部変更として通知される（data-safety-5 を壊さない）', async () => {
    const dir = makeProjectDir();
    const onChange = vi.fn();
    startWatch(dir, 'writer-B', onChange); // 見ているのは B、保存するのは A
    await sleep(400);

    saveAs(dir, 'writer-A', 'export const TELOP_DATA = [1];\n');

    await sleep(2600);
    expect(onChange).toHaveBeenCalledTimes(1);
  }, 20000);
});
