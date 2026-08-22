import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  commonFfmpegPaths,
  ffprobeFromFfmpeg,
  resolveFfmpegBin,
  type ResolveFfmpegDeps,
} from './resolveFfmpeg';

describe('resolveFfmpegBin', () => {
  const neverFound: ResolveFfmpegDeps = {
    which: () => null,
    env: {},
    platform: 'darwin',
  };

  it('PATH 上にあれば "ffmpeg" を返す', () => {
    const bin = resolveFfmpegBin({
      which: (name) => (name === 'ffmpeg' ? '/usr/bin/ffmpeg' : null),
      env: {},
    });
    expect(bin).toEqual({ ok: true, bin: 'ffmpeg' });
  });

  it('SUPERMOVIE_FFMPEG が設定されていればそれを優先する', () => {
    const bin = resolveFfmpegBin({
      which: (name) => (name === 'ffmpeg' ? '/usr/bin/ffmpeg' : null),
      env: { SUPERMOVIE_FFMPEG: '/opt/custom/ffmpeg' },
    });
    expect(bin).toEqual({ ok: true, bin: '/opt/custom/ffmpeg' });
  });

  it('SUPERMOVIE_FFMPEG が空白だけなら無視して PATH 解決へ進む', () => {
    const bin = resolveFfmpegBin({
      which: (name) => (name === 'ffmpeg' ? '/usr/bin/ffmpeg' : null),
      env: { SUPERMOVIE_FFMPEG: '   ' },
    });
    expect(bin).toEqual({ ok: true, bin: 'ffmpeg' });
  });

  it('PATH になければ一般的な場所を探す（~/.local/bin/ffmpeg 等）', () => {
    let tried: string[] = [];
    const bin = resolveFfmpegBin({
      which: (name) => {
        tried.push(name);
        // PATH 上の ffmpeg はなし、絶対パス候補の一つは存在
        if (name === '/usr/local/bin/ffmpeg') return name;
        return null;
      },
      env: {},
    });
    expect(bin).toEqual({ ok: true, bin: '/usr/local/bin/ffmpeg' });
    // PATH 候補 ffmpeg の次に絶対パス候補を試すこと
    expect(tried[0]).toBe('ffmpeg');
  });

  it('PATH も絶対パスも見つからなければ error を返す', () => {
    const result = resolveFfmpegBin(neverFound);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ffmpeg-not-found');
    }
  });

  it('一般パスよりも SUPERMOVIE_FFMPEG を優先する（env 優先）', () => {
    const bin = resolveFfmpegBin({
      which: () => null,
      env: { SUPERMOVIE_FFMPEG: '/custom/ffmpeg' },
    });
    expect(bin).toEqual({ ok: true, bin: '/custom/ffmpeg' });
  });

  it('Windows では絶対パス候補が .exe 付きの Windows 配置先になる', () => {
    const winEnv = { USERPROFILE: 'C:\\Users\\taki', LOCALAPPDATA: 'C:\\Users\\taki\\AppData\\Local' };
    const bin = resolveFfmpegBin({
      which: (name) => (name === 'C:\\ffmpeg\\bin\\ffmpeg.exe' ? name : null),
      env: winEnv,
      platform: 'win32',
    });
    expect(bin).toEqual({ ok: true, bin: 'C:\\ffmpeg\\bin\\ffmpeg.exe' });
  });

  it('他が無ければエディタ直下 tools/ffmpeg（setup が置く静的ビルド）を解決する', () => {
    const toolsBin = join(process.cwd(), 'tools', 'ffmpeg');
    const bin = resolveFfmpegBin({
      which: (name) => (name === toolsBin ? name : null),
      env: {},
      platform: 'darwin',
    });
    expect(bin).toEqual({ ok: true, bin: toolsBin });
  });
});

describe('commonFfmpegPaths', () => {
  it('win32 は zip 展開先・winget・scoop・chocolatey とエディタ直下 tools を候補にする', () => {
    const paths = commonFfmpegPaths(
      'win32',
      {
        USERPROFILE: 'C:\\Users\\taki',
        LOCALAPPDATA: 'C:\\Users\\taki\\AppData\\Local',
        ProgramData: 'C:\\ProgramData',
      },
      'C:\\HarnessEditor',
    );
    expect(paths).toEqual([
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\Users\\taki\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe',
      'C:\\Users\\taki\\scoop\\shims\\ffmpeg.exe',
      'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
      'C:\\HarnessEditor\\tools\\ffmpeg.exe',
    ]);
  });

  it('win32 の tools 候補は末尾の区切り文字を重ねない', () => {
    const paths = commonFfmpegPaths('win32', { USERPROFILE: 'C:\\Users\\taki' }, 'C:\\HarnessEditor\\');
    expect(paths.at(-1)).toBe('C:\\HarnessEditor\\tools\\ffmpeg.exe');
  });

  it('darwin/linux は従来の Unix 候補を返す', () => {
    const paths = commonFfmpegPaths('darwin', {});
    expect(paths).toContain('/opt/homebrew/bin/ffmpeg');
    expect(paths).toContain('/usr/bin/ffmpeg');
    expect(paths.every((p) => !p.endsWith('.exe'))).toBe(true);
  });

  it('darwin はエディタ直下 tools/ffmpeg を最後の候補にする（既存候補を優先）', () => {
    const paths = commonFfmpegPaths('darwin', {}, '/Users/taki/HarnessEditor');
    expect(paths.at(-1)).toBe('/Users/taki/HarnessEditor/tools/ffmpeg');
    // 既存の解決順は不変（システム導入が tools/ より優先される）
    expect(paths.indexOf('/opt/homebrew/bin/ffmpeg')).toBeLessThan(paths.length - 1);
  });

  it('editorRoot 未指定なら cwd 直下 tools/ffmpeg を候補にする', () => {
    const paths = commonFfmpegPaths('darwin', {});
    expect(paths.at(-1)).toBe(join(process.cwd(), 'tools', 'ffmpeg'));
  });
});

describe('ffprobeFromFfmpeg', () => {
  it('裸の "ffmpeg" は "ffprobe" になる', () => {
    expect(ffprobeFromFfmpeg('ffmpeg')).toBe('ffprobe');
  });

  it('Unix 絶対パスは同ディレクトリの ffprobe になる', () => {
    expect(ffprobeFromFfmpeg('/opt/homebrew/bin/ffmpeg')).toBe('/opt/homebrew/bin/ffprobe');
  });

  it('Windows の ffmpeg.exe は末尾 .exe を保って ffprobe.exe になる', () => {
    expect(ffprobeFromFfmpeg('C:\\ffmpeg\\bin\\ffmpeg.exe')).toBe('C:\\ffmpeg\\bin\\ffprobe.exe');
  });

  it('winget の LosslessCut 同梱 ffmpeg.exe でも同ディレクトリの ffprobe.exe になる', () => {
    expect(
      ffprobeFromFfmpeg('C:\\Users\\t\\AppData\\Local\\Microsoft\\WinGet\\Packages\\ch.LosslessCut_x\\resources\\ffmpeg.exe'),
    ).toBe('C:\\Users\\t\\AppData\\Local\\Microsoft\\WinGet\\Packages\\ch.LosslessCut_x\\resources\\ffprobe.exe');
  });

  it('大文字 FFMPEG.EXE でも導出できる（大文字小文字を無視）', () => {
    expect(ffprobeFromFfmpeg('C:\\Tools\\FFMPEG.EXE')).toBe('C:\\Tools\\ffprobe.EXE');
  });

  it('ffmpeg で終わらないパスは PATH 上の ffprobe へフォールバックする', () => {
    expect(ffprobeFromFfmpeg('/usr/local/bin/my-encoder')).toBe('ffprobe');
  });
});
