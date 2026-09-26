import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCaptureSequenceInput, type CaptureSequenceRun } from './captureSequenceInput';

describe('buildCaptureSequenceInput', () => {
  it('run 列（可変長・2本）を 0 起点の密連番へハードリンクし、frameCount/framerate/startNumber を返す', () => {
    const base = mkdtempSync(join(tmpdir(), 'm2c-seq-'));
    try {
      const png0 = join(base, 'src0.png');
      const png1 = join(base, 'src1.png');
      writeFileSync(png0, Buffer.from('PNG0'));
      writeFileSync(png1, Buffer.from('PNG1'));
      const outDir = join(base, 'dense');

      // run0: pngFileIndex=0, startFrame=100, endFrame=103 (長さ3, 絶対フレーム開始は100だが
      //       連番は 0 起点で作る契約なので 000000..000002)
      // run1: pngFileIndex=1, startFrame=103, endFrame=105 (長さ2 → 000003..000004)
      const runs: CaptureSequenceRun[] = [
        { pngFileIndex: 0, startFrame: 100, endFrame: 103 },
        { pngFileIndex: 1, startFrame: 103, endFrame: 105 },
      ];
      const result = buildCaptureSequenceInput(runs, [png0, png1], { dir: outDir, fps: 30 });

      expect(result.dir).toBe(outDir);
      expect(result.framerate).toBe(30);
      expect(result.startNumber).toBe(0);
      expect(result.frameCount).toBe(5); // 3 + 2
      expect(result.linkMs).toBeGreaterThanOrEqual(0);

      // 0 起点の連番ファイル名（%06d.png）で run0 の内容が000000-000002, run1 が000003-000004
      for (const n of [0, 1, 2]) {
        expect(readFileSync(join(outDir, `${String(n).padStart(6, '0')}.png`)).toString()).toBe('PNG0');
      }
      for (const n of [3, 4]) {
        expect(readFileSync(join(outDir, `${String(n).padStart(6, '0')}.png`)).toString()).toBe('PNG1');
      }
      expect(existsSync(join(outDir, '000005.png'))).toBe(false);

      // ハードリンクであること（同一 inode）＝コピーではない
      expect(statSync(join(outDir, '000000.png')).ino).toBe(statSync(png0).ino);
      expect(statSync(join(outDir, '000004.png')).ino).toBe(statSync(png1).ino);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('startNumber を明示すると連番がその番号から始まる（-start_number 明示 pin）', () => {
    const base = mkdtempSync(join(tmpdir(), 'm2c-seq-start-'));
    try {
      const png0 = join(base, 'src0.png');
      writeFileSync(png0, Buffer.from('PNG0'));
      const outDir = join(base, 'dense');
      const runs: CaptureSequenceRun[] = [{ pngFileIndex: 0, startFrame: 0, endFrame: 2 }];
      const result = buildCaptureSequenceInput(runs, [png0], { dir: outDir, fps: 60, startNumber: 500 });

      expect(result.startNumber).toBe(500);
      expect(result.frameCount).toBe(2);
      expect(existsSync(join(outDir, '000500.png'))).toBe(true);
      expect(existsSync(join(outDir, '000501.png'))).toBe(true);
      expect(existsSync(join(outDir, '000000.png'))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('link() が EXDEV を投げたら copyFile() へフォールバックする（同一 volume 内でもモック注入で pin 可）', () => {
    const base = mkdtempSync(join(tmpdir(), 'm2c-seq-exdev-'));
    try {
      const png0 = join(base, 'src0.png');
      writeFileSync(png0, Buffer.from('PNG0'));
      const outDir = join(base, 'dense');
      const runs: CaptureSequenceRun[] = [{ pngFileIndex: 0, startFrame: 0, endFrame: 2 }];

      const linkCalls: Array<[string, string]> = [];
      const copyCalls: Array<[string, string]> = [];
      const exdevErr = Object.assign(new Error('cross-device link'), { code: 'EXDEV' });

      const result = buildCaptureSequenceInput(runs, [png0], {
        dir: outDir,
        fps: 30,
        mkdir: (dir) => {
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        },
        link: (src, dst) => {
          linkCalls.push([src, dst]);
          throw exdevErr;
        },
        copyFile: (src, dst) => {
          copyCalls.push([src, dst]);
          writeFileSync(dst, readFileSync(src));
        },
      });

      expect(result.frameCount).toBe(2);
      expect(linkCalls.length).toBe(2); // link は毎回試みられる（EXDEV は毎回投げてよい・全体で1回だけ判定はしない）
      expect(copyCalls.length).toBe(2); // 両方ともフォールバックでコピーされる
      expect(readFileSync(join(outDir, '000000.png')).toString()).toBe('PNG0');
      expect(readFileSync(join(outDir, '000001.png')).toString()).toBe('PNG0');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('link() が EXDEV 以外のエラーを投げたら黙って握りつぶさずそのまま投げる', () => {
    const base = mkdtempSync(join(tmpdir(), 'm2c-seq-otherr-'));
    try {
      const png0 = join(base, 'src0.png');
      writeFileSync(png0, Buffer.from('PNG0'));
      const outDir = join(base, 'dense');
      const runs: CaptureSequenceRun[] = [{ pngFileIndex: 0, startFrame: 0, endFrame: 1 }];
      const otherErr = Object.assign(new Error('permission denied'), { code: 'EACCES' });

      expect(() =>
        buildCaptureSequenceInput(runs, [png0], {
          dir: outDir,
          fps: 30,
          mkdir: () => {
            mkdirSync(outDir, { recursive: true });
          },
          link: () => {
            throw otherErr;
          },
          copyFile: () => {
            throw new Error('copyFile は呼ばれてはいけない');
          },
        }),
      ).toThrow(/permission denied/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('pngFiles[pngFileIndex] が存在しないと throw する（呼び出し側の算出ミスを黙って通さない）', () => {
    const base = mkdtempSync(join(tmpdir(), 'm2c-seq-badidx-'));
    try {
      const outDir = join(base, 'dense');
      const runs: CaptureSequenceRun[] = [{ pngFileIndex: 3, startFrame: 0, endFrame: 1 }];
      expect(() => buildCaptureSequenceInput(runs, ['a.png'], { dir: outDir, fps: 30 })).toThrow(/pngFiles/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('run 長が0以下だと throw する', () => {
    const base = mkdtempSync(join(tmpdir(), 'm2c-seq-badlen-'));
    try {
      const outDir = join(base, 'dense');
      const runs: CaptureSequenceRun[] = [{ pngFileIndex: 0, startFrame: 10, endFrame: 10 }];
      expect(() => buildCaptureSequenceInput(runs, ['a.png'], { dir: outDir, fps: 30 })).toThrow(/run 長/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('run 列にギャップがあると throw する（ギャップは以降の全フレームを黙って前詰まりさせるため fail-loud）', () => {
    const base = mkdtempSync(join(tmpdir(), 'm2c-seq-gap-'));
    try {
      const outDir = join(base, 'dense');
      // run0: [0,3) / run1: [5,7) → run1.startFrame(5) !== run0.endFrame(3) のギャップ
      const runs: CaptureSequenceRun[] = [
        { pngFileIndex: 0, startFrame: 0, endFrame: 3 },
        { pngFileIndex: 0, startFrame: 5, endFrame: 7 },
      ];
      expect(() => buildCaptureSequenceInput(runs, ['a.png'], { dir: outDir, fps: 30 })).toThrow(/ギャップ/);
      // fail-loud はファイル生成の前に効くこと（副作用を残さない）
      expect(existsSync(outDir)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('先頭 run の startFrame が spanStart と一致しないと throw する（spanStart 省略時は runs[0] 自身を基準にするため検査は通る）', () => {
    const base = mkdtempSync(join(tmpdir(), 'm2c-seq-spanstart-'));
    try {
      const outDir = join(base, 'dense');
      const runs: CaptureSequenceRun[] = [{ pngFileIndex: 0, startFrame: 10, endFrame: 15 }];
      // spanStart=0 なのに先頭 run が 10 から始まる → 先頭にもギャップがあるということ
      expect(() =>
        buildCaptureSequenceInput(runs, ['a.png'], { dir: outDir, fps: 30, spanStart: 0 }),
      ).toThrow(/スパン開始/);
      // spanStart 省略時は runs[0].startFrame 自身が基準になるので通る（副作用がある = throw していない証拠として frameCount を見る）
      const okResultDir = join(base, 'dense-ok');
      const png0 = join(base, 'src0.png');
      writeFileSync(png0, Buffer.from('X'));
      const result = buildCaptureSequenceInput(runs, [png0], { dir: okResultDir, fps: 30 });
      expect(result.frameCount).toBe(5);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('frameCount はスパン長（最終 run の endFrame - 先頭 run の startFrame）と一致する（末尾フレームの黙った欠落を防ぐ assert の正常系 pin）', () => {
    const base = mkdtempSync(join(tmpdir(), 'm2c-seq-span-'));
    try {
      const outDir = join(base, 'dense');
      const png0 = join(base, 'src0.png');
      writeFileSync(png0, Buffer.from('X'));
      // 3本の連続 run: [20,23)[23,29)[29,30) → スパン長 = 30-20 = 10 = 3+6+1
      const runs: CaptureSequenceRun[] = [
        { pngFileIndex: 0, startFrame: 20, endFrame: 23 },
        { pngFileIndex: 0, startFrame: 23, endFrame: 29 },
        { pngFileIndex: 0, startFrame: 29, endFrame: 30 },
      ];
      const result = buildCaptureSequenceInput(runs, [png0], { dir: outDir, fps: 30 });
      const spanLength = runs[runs.length - 1]!.endFrame - runs[0]!.startFrame;
      expect(spanLength).toBe(10);
      expect(result.frameCount).toBe(spanLength);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
