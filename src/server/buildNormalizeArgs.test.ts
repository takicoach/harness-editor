import { describe, it, expect } from 'vitest';
import {
  targetToLufs,
  buildMeasureArgs,
  buildApplyArgs,
  parseLoudnormJson,
  type LoudnormMeasured,
} from './buildNormalizeArgs';

describe('targetToLufs', () => {
  it('強さ→LUFS（loud=-10 / standard=-14 / quiet=-18）', () => {
    expect(targetToLufs('loud')).toBe(-10);
    expect(targetToLufs('standard')).toBe(-14);
    expect(targetToLufs('quiet')).toBe(-18);
  });
  it('未指定は standard(-14)', () => {
    expect(targetToLufs(undefined)).toBe(-14);
  });
});

describe('buildMeasureArgs', () => {
  it('1パス目: print_format=json と -f null - を含む', () => {
    const args = buildMeasureArgs({ input: '/in.mp4', targetLufs: -14 });
    expect(args).toEqual([
      '-hide_banner',
      '-i', '/in.mp4',
      '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json',
      '-f', 'null', '-',
    ]);
  });
});

describe('buildApplyArgs', () => {
  const measured: LoudnormMeasured = {
    input_i: '-27.10', input_tp: '-9.93', input_lra: '7.40',
    input_thresh: '-37.41', target_offset: '0.46',
  };
  it('2パス目（measured 有り）: linear=true と measured_* を埋め、-c:v copy 等を付ける', () => {
    const args = buildApplyArgs({ input: '/in.mp4', output: '/tmp/out.mp4', targetLufs: -14, measured });
    expect(args).toEqual([
      '-y',
      '-i', '/in.mp4',
      '-af',
      'loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=-27.10:measured_TP=-9.93:measured_LRA=7.40:measured_thresh=-37.41:offset=0.46:linear=true:print_format=summary',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '/tmp/out.mp4',
    ]);
  });
  it('2パス目（measured=null）: 動的フォールバック（measured 無しの loudnorm 単体）', () => {
    const args = buildApplyArgs({ input: '/in.mp4', output: '/tmp/out.mp4', targetLufs: -16, measured: null });
    expect(args).toContain('-c:v');
    expect(args[args.indexOf('-af') + 1]).toBe('loudnorm=I=-16:TP=-1.5:LRA=11');
  });
});

describe('parseLoudnormJson', () => {
  it('stderr 末尾の JSON ブロックから measured を抽出する', () => {
    const stderr = [
      'ffmpeg version ...',
      '[Parsed_loudnorm_0 @ 0x] ',
      '{',
      '  "input_i" : "-27.10",',
      '  "input_tp" : "-9.93",',
      '  "input_lra" : "7.40",',
      '  "input_thresh" : "-37.41",',
      '  "output_i" : "-14.00",',
      '  "target_offset" : "0.46"',
      '}',
    ].join('\n');
    expect(parseLoudnormJson(stderr)).toEqual({
      input_i: '-27.10', input_tp: '-9.93', input_lra: '7.40',
      input_thresh: '-37.41', target_offset: '0.46',
    });
  });
  it('複数の波括弧があれば末尾の JSON を採用する', () => {
    const stderr = '{ "noise": 1 } trailing log\n{\n"input_i":"-20.0","input_tp":"-3.0","input_lra":"5.0","input_thresh":"-30.0","target_offset":"1.0"\n}';
    expect(parseLoudnormJson(stderr)?.input_i).toBe('-20.0');
  });
  it('JSON が無い/キー欠落なら null', () => {
    expect(parseLoudnormJson('no json here')).toBeNull();
    expect(parseLoudnormJson('{ "input_i": "-1.0" }')).toBeNull();
  });
});
