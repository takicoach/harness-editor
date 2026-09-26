import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProjectSteps, MAX_TELOP_STATIC_BYTES, MAX_TRANSCRIPT_BYTES } from './projectSteps';
import { autoStatusFromSteps } from './projectStatus';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** 旧形式の進捗判定に使う現用部品・データ。起動設定は不要。 */
const TEMPLATE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'project-template',
  'src',
);

const TELOP_DIR = 'テロップテンプレート';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sme-steps-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeTelop(content: string): void {
  mkdirSync(join(dir, 'src', TELOP_DIR), { recursive: true });
  writeFileSync(join(dir, 'src', TELOP_DIR, 'telopData.ts'), content, 'utf8');
}

describe('resolveProjectSteps', () => {
  it('何もない → 全 false / telop=invalid', () => {
    expect(resolveProjectSteps(dir)).toEqual({
      transcribe: false,
      cut: false,
      telop: 'invalid',
      audio: false,
      rendered: false,
    });
  });

  it('各工程を中身ベースで判定する（雛形のまま＝未済）', () => {
    // transcript も seData も「中身が入っていること」が済の条件（空の雛形は未済）。
    writeFileSync(
      join(dir, 'transcript.json'),
      JSON.stringify({ segments: [{ start: 0, end: 1, text: 'あ' }] }),
      'utf8',
    );
    mkdirSync(join(dir, 'src', 'SoundEffects'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'SoundEffects', 'seData.ts'),
      "export const seData = [{ id: 1, startFrame: 30, file: 'x.mp3' }];",
      'utf8',
    );
    mkdirSync(join(dir, 'out'), { recursive: true });
    writeFileSync(join(dir, 'out', 'video.mp4'), 'x', 'utf8');
    writeTelop('export const telopData = [\n  { id: 1, startFrame: 0, endFrame: 30, text: "a" },\n];');
    // cutData はルート直下候補（旧形式）でも検出する
    writeFileSync(join(dir, 'cutData.ts'), 'export const cutData = [];', 'utf8');
    expect(resolveProjectSteps(dir)).toEqual({
      transcribe: true,
      cut: true,
      telop: 'nonempty',
      audio: true,
      rendered: true,
    });
  });

  it('telopData 空配列 → telop=empty（生成直後から存在するためエントリ有無で判定）', () => {
    writeTelop('export const telopData = [];');
    expect(resolveProjectSteps(dir).telop).toBe('empty');
  });

  it('サイズ上限超の telopData は読まずに invalid（DoS 防止）', () => {
    writeTelop('// ' + 'x'.repeat(MAX_TELOP_STATIC_BYTES + 1));
    expect(resolveProjectSteps(dir).telop).toBe('invalid');
  });

  // FIFO は statSync().size が 0 になるためサイズ上限を素通りし、readFileSync が
  // 書き手が現れるまで恒久ブロックする（一覧走査が固まる）。通常ファイル以外は読まない。
  it.skipIf(process.platform === 'win32')(
    '通常ファイルでない telopData（FIFO）はハングせず invalid',
    { timeout: 5_000 },
    () => {
      mkdirSync(join(dir, 'src', TELOP_DIR), { recursive: true });
      execFileSync('mkfifo', [join(dir, 'src', TELOP_DIR, 'telopData.ts')]);
      expect(resolveProjectSteps(dir).telop).toBe('invalid');
    },
  );

  it('bgmData にエントリがあれば audio=true（se が無くても）', () => {
    mkdirSync(join(dir, 'src', 'Bgm'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'Bgm', 'bgmData.ts'),
      "export const bgmData = [{ id: 1, file: 'a.mp3' }];",
      'utf8',
    );
    expect(resolveProjectSteps(dir).audio).toBe(true);
  });

  it('空の seData / bgmData は audio=false（雛形は空配列で同梱される）', () => {
    mkdirSync(join(dir, 'src', 'SoundEffects'), { recursive: true });
    writeFileSync(join(dir, 'src', 'SoundEffects', 'seData.ts'), 'export const seData = [];', 'utf8');
    mkdirSync(join(dir, 'src', 'Bgm'), { recursive: true });
    writeFileSync(join(dir, 'src', 'Bgm', 'bgmData.ts'), 'export const bgmData = [];', 'utf8');
    expect(resolveProjectSteps(dir).audio).toBe(false);
  });

  it('上限超の transcript.json はパースせず済扱い（空であり得ないサイズ）', () => {
    writeFileSync(
      join(dir, 'transcript.json'),
      '{"words":[' + '0,'.repeat(MAX_TRANSCRIPT_BYTES / 2) + '0]}',
      'utf8',
    );
    expect(resolveProjectSteps(dir).transcribe).toBe(true);
  });
});

describe('新規作成直後の工程判定', () => {
  /**
   * 旧形式では空の transcript.json と空の seData.ts が存在しうる。ファイルの**有無**だけで
   * 判定すると、1 秒も編集していない動画が transcribe/audio 済み扱いになり、
   * 進行ボードでいきなり「カット」列に並ぶ。
   * 現用の空データと旧形式の transcript.json で固定する。新規v2作成とは別の互換検査。
   */
  it('旧形式の空データでは transcribe/cut/audio がすべて未済', () => {
    // 現用データをコピーする（空データの内容が変わったら追随して落ちる）。
    cpSync(TEMPLATE, join(dir, 'src'), { recursive: true });
    // 旧形式の空 transcript.json。
    writeFileSync(
      join(dir, 'transcript.json'),
      JSON.stringify({ engine: 'none', language: 'ja', duration_ms: 1000, words: [], segments: [] }),
      'utf8',
    );
    const steps = resolveProjectSteps(dir);
    expect(steps.transcribe, '空の transcript.json は文字起こし済みではない').toBe(false);
    expect(steps.cut, '雛形に cutData.ts は無い').toBe(false);
    expect(steps.audio, '空の seData.ts は SE/BGM 済みではない').toBe(false);
    expect(steps.rendered).toBe(false);
    // ボードの初期配置は「未着手」列（telop も空なので idle）。
    expect(autoStatusFromSteps(steps)).toBe('idle');
  });

  it('中身が入れば済扱いになる（判定が常に false ではないことの固定）', () => {
    cpSync(TEMPLATE, join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'transcript.json'),
      JSON.stringify({ segments: [{ start: 0, end: 1, text: 'あ' }], words: [] }),
      'utf8',
    );
    writeFileSync(
      join(dir, 'src', 'SoundEffects', 'seData.ts'),
      "export const seData = [\n  { id: 1, startFrame: 30, file: 'x.mp3', volume: 0.3 },\n];",
      'utf8',
    );
    const steps = resolveProjectSteps(dir);
    expect(steps.transcribe).toBe(true);
    expect(steps.audio).toBe(true);
    expect(autoStatusFromSteps(steps)).toBe('cut'); // 文字起こし済み・カット未
  });

  it('words だけの transcript（segments を持たないエンジン）も済扱いにする', () => {
    writeFileSync(
      join(dir, 'transcript.json'),
      JSON.stringify({ words: [{ start: 0, end: 0.4, word: 'あ' }] }),
      'utf8',
    );
    expect(resolveProjectSteps(dir).transcribe).toBe(true);
  });

  it('壊れた transcript.json は未済（読めないものを済扱いにしない）', () => {
    writeFileSync(join(dir, 'transcript.json'), '{ broken', 'utf8');
    expect(resolveProjectSteps(dir).transcribe).toBe(false);
  });

  it('bgmData に静的エントリがあれば audio 済み（se が空でも）', () => {
    mkdirSync(join(dir, 'src', 'Bgm'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'Bgm', 'bgmData.ts'),
      "export const bgmData = [{ id: 1, file: 'a.mp3' }];",
      'utf8',
    );
    expect(resolveProjectSteps(dir).audio).toBe(true);
  });
});
