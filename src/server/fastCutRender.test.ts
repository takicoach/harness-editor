import { describe, it, expect } from 'vitest';
import {
  buildCutFilterScript,
  buildFastCutArgs,
  expectedCutFrames,
  parseFfmpegProgress,
  scaleFilterFor,
} from './fastCutRender';
import { isCutsOnly, type CutsOnlyInput } from '../shared/cutsOnly';

const BARE: CutsOnlyInput = {
  telops: [], se: [], images: [], videoInserts: [], bgm: [], titles: [], shapes: [],
  sceneTransitions: [], mainSpeed: 1, segmentSpeeds: {}, layoutKeyframes: [],
};

describe('isCutsOnly', () => {
  it('カット以外が何も無ければ true', () => {
    expect(isCutsOnly(BARE)).toBe(true);
  });

  it('テロップ・SE・画像・サブ動画・BGM・図形・タイトル・場面転換のどれか 1 つで false', () => {
    for (const key of ['telops', 'se', 'images', 'videoInserts', 'bgm', 'titles', 'shapes', 'sceneTransitions'] as const) {
      expect(isCutsOnly({ ...BARE, [key]: [{}] })).toBe(false);
    }
  });

  it('速度・レイアウトが付いていたら false（描画が要る）', () => {
    expect(isCutsOnly({ ...BARE, mainSpeed: 2 })).toBe(false);
    expect(isCutsOnly({ ...BARE, segmentSpeeds: { 1: 2 } })).toBe(false);
    expect(isCutsOnly({ ...BARE, segmentLayouts: { 1: {} } })).toBe(false);
    expect(isCutsOnly({ ...BARE, mainLayout: { scale: 0.5 } })).toBe(false);
    expect(isCutsOnly({ ...BARE, mainLayout: { position: { x: 0.2, y: 0 } } })).toBe(false);
    expect(isCutsOnly({ ...BARE, mainLayout: { rotation: 90 } })).toBe(false);
    expect(isCutsOnly({ ...BARE, mainLayout: { flipH: true } })).toBe(false);
    expect(isCutsOnly({ ...BARE, layoutKeyframes: [{}, {}] })).toBe(false);
  });

  it('既定値のレイアウト（素のまま）は true（読み込むと必ず既定値が入るため）', () => {
    expect(isCutsOnly({
      ...BARE,
      mainLayout: { position: { x: 0, y: 0 }, scale: 1, rotation: 0, flipH: false, flipV: false },
    })).toBe(true);
  });

  it('未設定（undefined）のフィールドは「無い」とみなす', () => {
    const minimal = { telops: [], se: [], images: [], titles: [], mainSpeed: 1, segmentSpeeds: {} };
    expect(isCutsOnly(minimal)).toBe(true);
  });
});

describe('expectedCutFrames', () => {
  it('残す区間の合計フレーム数（＝カット後の尺）', () => {
    expect(expectedCutFrames([{ start: 0, end: 100 }, { start: 200, end: 250 }])).toBe(150);
    expect(expectedCutFrames([])).toBe(0);
  });
});

describe('buildCutFilterScript', () => {
  it('区間ごとに trim/atrim して concat する', () => {
    const script = buildCutFilterScript([{ start: 0, end: 30 }, { start: 60, end: 120 }], 30);
    expect(script).toContain('[0:v]trim=start=0.000000:end=1.000000,setpts=PTS-STARTPTS[v0];');
    expect(script).toContain('[0:a]atrim=start=2.000000:end=4.000000,asetpts=PTS-STARTPTS[a1];');
    expect(script).toContain('[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]');
  });

  it('残す区間が無ければエラー（全部カットは書き出せない）', () => {
    expect(() => buildCutFilterScript([], 30)).toThrow();
  });
});

describe('scaleFilterFor', () => {
  const source = { width: 3840, height: 2160 };
  it('そのままならスケールしない', () => {
    expect(scaleFilterFor({ resolution: 'full', quality: 'high' }, source)).toBeNull();
  });
  it('1080p は 1920×1080 へ縮小する', () => {
    expect(scaleFilterFor({ resolution: '1080p', quality: 'high' }, source)).toBe('scale=1920:1080:flags=lanczos');
  });
  it('原本が小さければ拡大しない', () => {
    expect(scaleFilterFor({ resolution: '1080p', quality: 'high' }, { width: 1280, height: 720 })).toBeNull();
  });
});

describe('buildFastCutArgs', () => {
  const base = {
    input: '/p/public/main.mp4',
    filterScript: '/p/out/cut-filter.txt',
    output: '/p/out/tmp.mp4',
    target: { width: 3840, height: 2160 },
  };

  it('macOS はハードウェアエンコーダ＋ビットレート指定', () => {
    const args = buildFastCutArgs({ ...base, options: { resolution: 'full', quality: 'high' }, hardware: true });
    const joined = args.join(' ');
    expect(joined).toContain('-filter_complex_script /p/out/cut-filter.txt');
    expect(joined).toContain('-map [outv] -map [outa]');
    expect(joined).toContain('-c:v h264_videotoolbox');
    expect(joined).toContain('-b:v 80M');
    expect(joined).toContain('-c:a aac');
    expect(args[args.length - 1]).toBe('/p/out/tmp.mp4');
  });

  it('ハードウェアが無い環境は libx264＋CRF', () => {
    const joined = buildFastCutArgs({ ...base, options: { resolution: 'full', quality: 'high' }, hardware: false }).join(' ');
    expect(joined).toContain('-c:v libx264');
    expect(joined).toContain('-crf 18');
  });

  it('ビットレートは解像度に比例させる（1080p は 4K の 1/4）', () => {
    const joined = buildFastCutArgs({
      ...base,
      target: { width: 1920, height: 1080 },
      options: { resolution: '1080p', quality: 'high' },
      hardware: true,
    }).join(' ');
    expect(joined).toContain('-b:v 20M');
  });

  it('進捗を stdout へ流す（UI の進捗バー用）', () => {
    const args = buildFastCutArgs({ ...base, options: { resolution: 'full', quality: 'high' }, hardware: true });
    expect(args.join(' ')).toContain('-progress pipe:1');
  });
});

describe('parseFfmpegProgress', () => {
  it('最後の frame= を拾って % にする', () => {
    expect(parseFfmpegProgress('frame=10\nfps=30\nframe=  50\nprogress=continue\n', 200))
      .toEqual({ frames: 50, total: 200, percent: 25 });
  });
  it('frame= が無ければ null（UI はスピナーのまま）', () => {
    expect(parseFfmpegProgress('bitrate=N/A\n', 200)).toBeNull();
  });
  it('総フレーム数が不明なら null', () => {
    expect(parseFfmpegProgress('frame=10\n', 0)).toBeNull();
  });
  it('100% を超えない', () => {
    expect(parseFfmpegProgress('frame=500\n', 200)?.percent).toBe(100);
  });
});
