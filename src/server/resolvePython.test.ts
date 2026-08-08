import { describe, it, expect } from 'vitest';
import { resolvePythonBin } from './resolvePython';

describe('resolvePythonBin', () => {
  it('HARNESS_PYTHON が旧 SUPERMOVIE_PYTHON より優先される', () => {
    const bin = resolvePythonBin({
      env: { HARNESS_PYTHON: '/new/python', SUPERMOVIE_PYTHON: '/old/python' },
      hasWhisper: () => false,
      readConfig: () => '/config/python',
    });
    expect(bin).toBe('/new/python');
  });

  it('旧 SUPERMOVIE_PYTHON が設定されていれば検証せずそれを使う', () => {
    const bin = resolvePythonBin({
      env: { SUPERMOVIE_PYTHON: '/custom/python' },
      hasWhisper: () => false, // 検証は呼ばれない
      readConfig: () => '/config/python', // override が勝つ
    });
    expect(bin).toBe('/custom/python');
  });

  it('SUPERMOVIE_PYTHON が空白だけなら無視して次へ', () => {
    const bin = resolvePythonBin({
      env: { SUPERMOVIE_PYTHON: '   ' },
      hasWhisper: () => false,
      readConfig: () => '/config/python',
    });
    expect(bin).toBe('/config/python');
  });

  it('env が無ければ .supermovie-python 設定ファイルの値を使う（probe せず尊重）', () => {
    let probed = false;
    const bin = resolvePythonBin({
      env: {},
      hasWhisper: () => {
        probed = true;
        return false;
      },
      readConfig: () => '/venv/bin/python3',
    });
    expect(bin).toBe('/venv/bin/python3');
    expect(probed).toBe(false); // 設定ファイルがあれば PATH probe しない
  });

  it('env も設定ファイルも無ければ、whisper を import できる最初の PATH 候補を返す', () => {
    const probed: string[] = [];
    const bin = resolvePythonBin({
      env: {},
      readConfig: () => null,
      hasWhisper: (b) => {
        probed.push(b);
        return b === 'python3.11';
      },
    });
    expect(bin).toBe('python3.11');
    // python3 → 3.14 → 3.13 → 3.12 → 3.11 の順で探索し、見つけたら止まる
    expect(probed).toEqual(['python3', 'python3.14', 'python3.13', 'python3.12', 'python3.11']);
  });

  it('壊れた早い候補は skip し、後ろの動く候補を拾う（実 import 判定）', () => {
    // python3 は import 失敗（壊れ）、python3.10 で成功する想定
    const bin = resolvePythonBin({
      env: {},
      readConfig: () => null,
      hasWhisper: (b) => b === 'python3.10',
    });
    expect(bin).toBe('python3.10');
  });

  it('win32 では py ランチャーも候補になる（python3/python が無い環境の定番）', () => {
    const bin = resolvePythonBin({
      env: {},
      readConfig: () => null,
      hasWhisper: (b) => b === 'py',
      platform: 'win32',
    });
    expect(bin).toBe('py');
  });

  it('win32 以外では py は候補にならない', () => {
    const bin = resolvePythonBin({
      env: {},
      readConfig: () => null,
      hasWhisper: (b) => b === 'py',
      platform: 'darwin',
    });
    expect(bin).toBe('python3');
  });

  it('どの候補にも whisper が無ければ python3 にフォールバック（既存エラー表示に委ねる）', () => {
    const bin = resolvePythonBin({
      env: {},
      readConfig: () => null,
      hasWhisper: () => false,
    });
    expect(bin).toBe('python3');
  });
});
