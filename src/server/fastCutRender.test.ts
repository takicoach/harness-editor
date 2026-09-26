import { describe, it, expect } from 'vitest';
import {
  applyScaleFilter,
  buildCutFilterScript,
  buildFastCutArgs,
  expectedCutFrames,
  parseFfmpegProgress,
  scaleFilterFor,
  verifyCutFramesStrict,
} from './fastCutRender';
import { isCutsOnly, type CutsOnlyInput } from '../shared/cutsOnly';

const BARE: CutsOnlyInput = {
  telops: [], se: [], images: [], videoInserts: [], bgm: [], bgmDucking: false, titles: [], shapes: [],
  sceneTransitions: [], mainSpeed: 1, segmentSpeeds: {}, layoutKeyframes: [],
};

describe('isCutsOnly', () => {
  it('カット以外が何も無ければ true', () => {
    expect(isCutsOnly(BARE)).toBe(true);
  });

  it('速度変更が入っていれば false', () => {
    expect(isCutsOnly({ ...BARE, mainSpeed: 2 })).toBe(false);
  });

  it('テロップ・画像・タイトルは理由にならない（nativeExport 対応済み・M2c）', () => {
    for (const key of ['telops', 'images', 'titles'] as const) {
      expect(isCutsOnly({ ...BARE, [key]: [{}] })).toBe(true);
    }
  });

  it('場面転換は理由にならない（nativeExport 対応済み・M3）', () => {
    expect(isCutsOnly({ ...BARE, sceneTransitions: [{}] })).toBe(true);
  });

  it('サブ動画は理由にならない（nativeExport 対応済み・M4）', () => {
    expect(isCutsOnly({ ...BARE, videoInserts: [{}] })).toBe(true);
  });

  it('SE は理由にならない（nativeExport 対応済み）', () => {
    expect(isCutsOnly({ ...BARE, se: [{}] })).toBe(true);
  });

  it('BGM は理由にならない（nativeExport 対応済み・ダッキング無しの場合）', () => {
    expect(isCutsOnly({ ...BARE, bgm: [{}] })).toBe(true);
  });

  it('図形は理由にならない（nativeExport 対応済み・M1d）', () => {
    expect(isCutsOnly({ ...BARE, shapes: [{}] })).toBe(true);
  });

  it('BGM があってもダッキング設定が有効なら false（M1c まで非対応）', () => {
    expect(isCutsOnly({ ...BARE, bgm: [{}], bgmDucking: true })).toBe(false);
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
    const minimal = { telops: [], se: [], images: [], bgmDucking: false, titles: [], mainSpeed: 1, segmentSpeeds: {} };
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
    expect(script).toContain('[0:v]fps=30,trim=start=0.000000:end=1.000000,setpts=PTS-STARTPTS[v0];');
    expect(script).toContain('[0:a]atrim=start=2.000000:end=4.000000,asetpts=PTS-STARTPTS[a1];');
    expect(script).toContain('[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]');
  });

  it('残す区間が無ければエラー（全部カットは書き出せない）', () => {
    expect(() => buildCutFilterScript([], 30)).toThrow();
  });

  it('各映像チェーンの先頭で fps 正規化する', () => {
    const script = buildCutFilterScript([{ start: 0, end: 30 }], 30);
    expect(script).toContain('[0:v]fps=30,trim=start=0.000000:end=1.000000');
  });
});

describe('verifyCutFramesStrict', () => {
  it('計測不能は失敗（従来 verify との差分）', () => {
    expect(verifyCutFramesStrict('/out.mp4', 100, () => null)).toMatch(/計測できません/);
  });
  it('1 フレームのずれも失敗', () => {
    expect(verifyCutFramesStrict('/out.mp4', 100, () => 101)).toMatch(/一致しません/);
  });
  it('一致なら null', () => {
    expect(verifyCutFramesStrict('/out.mp4', 100, () => 100)).toBeNull();
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
    expect(joined).toContain('-/filter_complex /p/out/cut-filter.txt');
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

  it('extraInputs は main 入力の直後に順序どおり並ぶ', () => {
    const args = buildFastCutArgs({ ...base, options: { resolution: 'full', quality: 'high' }, hardware: true, extraInputs: [{ path: '/pj/public/se/a.mp3' }, { path: '/pj/public/se/b.wav' }] });
    const i1 = args.indexOf('/pj/public/se/a.mp3');
    expect(args[i1 - 1]).toBe('-i');
    expect(args[i1 + 1]).toBe('-i');
    expect(args[i1 + 2]).toBe('/pj/public/se/b.wav');
  });

  it('extraInputs は main の直後・loop は -stream_loop -1 が -i の直前に付く', () => {
    const args = buildFastCutArgs({ ...base, options: { resolution: 'full', quality: 'high' }, hardware: true, extraInputs: [
      { path: '/pj/public/se/a.mp3' },
      { path: '/pj/public/BGM/b.mp3', loop: true },
    ] });
    const ia = args.indexOf('/pj/public/se/a.mp3');
    expect(args[ia - 1]).toBe('-i');
    const ib = args.indexOf('/pj/public/BGM/b.mp3');
    expect(args.slice(ib - 3, ib)).toEqual(['-stream_loop', '-1', '-i']);
    expect(ia).toBeLessThan(ib);
  });

  it('image 入力は -loop 1 -framerate {F} -t {D} -i path・音声 extraInputs の後ろに並ぶ（既存音声テストは無変更で通る）', () => {
    const args = buildFastCutArgs({ ...base, options: { resolution: 'full', quality: 'high' }, hardware: true, extraInputs: [
      { path: '/pj/public/se/a.mp3' },
      { path: '/pj/public/BGM/b.mp3', loop: true },
      { path: '/pj/out/shapes/shp0.png', image: { framerate: 30, durationSec: '0.500000' } },
    ] });
    const ip = args.indexOf('/pj/out/shapes/shp0.png');
    expect(args.slice(ip - 7, ip)).toEqual([
      '-loop', '1', '-framerate', '30', '-t', '0.500000', '-i',
    ]);
    // 音声 extraInputs（SE→BGM）の後ろに画像入力が来る
    const ib = args.indexOf('/pj/public/BGM/b.mp3');
    expect(ib).toBeLessThan(ip);
  });

  it('sequence 入力は -framerate {F} -start_number {N} -i path（image/loop とは別分岐・既存挙動不変）', () => {
    const args = buildFastCutArgs({ ...base, options: { resolution: 'full', quality: 'high' }, hardware: true, extraInputs: [
      { path: '/pj/public/se/a.mp3' },
      { path: '/pj/out/seq/telop/%06d.png', sequence: { framerate: 30, startNumber: 0 } },
    ] });
    const iq = args.indexOf('/pj/out/seq/telop/%06d.png');
    expect(args.slice(iq - 5, iq)).toEqual(['-framerate', '30', '-start_number', '0', '-i']);
    // sequence には -loop 1 も -t も付かない（image 分岐とは別・排他）
    expect(args.slice(iq - 5, iq)).not.toContain('-loop');
    expect(args.slice(iq - 5, iq)).not.toContain('-t');
    // 音声 extraInputs の後ろに sequence 入力が来る
    const ia = args.indexOf('/pj/public/se/a.mp3');
    expect(ia).toBeLessThan(iq);
  });

  it('sequence の startNumber が0以外でも忠実に反映される', () => {
    const args = buildFastCutArgs({ ...base, options: { resolution: 'full', quality: 'high' }, hardware: true, extraInputs: [
      { path: '/pj/out/seq/title/%06d.png', sequence: { framerate: 60, startNumber: 213 } },
    ] });
    const iq = args.indexOf('/pj/out/seq/title/%06d.png');
    expect(args.slice(iq - 5, iq)).toEqual(['-framerate', '60', '-start_number', '213', '-i']);
  });

  it('image と sequence が混在しても各々の分岐が独立に出力される（image の -t は sequence に混入しない）', () => {
    const args = buildFastCutArgs({ ...base, options: { resolution: 'full', quality: 'high' }, hardware: true, extraInputs: [
      { path: '/pj/out/shapes/shp0.png', image: { framerate: 30, durationSec: '0.500000' } },
      { path: '/pj/out/seq/telop/%06d.png', sequence: { framerate: 30, startNumber: 0 } },
    ] });
    const joined = args.join(' ');
    expect(joined).toContain('-loop 1 -framerate 30 -t 0.500000 -i /pj/out/shapes/shp0.png');
    expect(joined).toContain('-framerate 30 -start_number 0 -i /pj/out/seq/telop/%06d.png');
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

/**
 * M-2: `applyScaleFilter` の 2 つの throw を**個別に** pin する。
 * 「[outv] が無い」と「[outv] が複数」は原因も直し方も別（前者は挿入点の消滅・
 * 後者は鎖の合成ミス）なので、まとめて `toThrow()` にすると片方を消しても緑のまま通る。
 */
describe('applyScaleFilter の契約（M-2）', () => {
  const scale = 'scale=1920:1080:flags=lanczos';

  it('[outv] が 1 個なら最後段へ挿入する', () => {
    const out = applyScaleFilter('[0:v]concat=n=1:v=1:a=0[outv]\n', scale);
    expect(out).toBe('[0:v]concat=n=1:v=1:a=0[catv];\n[catv]scale=1920:1080:flags=lanczos[outv]\n');
    expect(out.match(/\[outv\]/g)).toHaveLength(1);
  });

  it('[outv] が無ければ throw（黙って原寸で書き出さない）', () => {
    expect(() => applyScaleFilter('[0:v]concat=n=1:v=1:a=0[catv]\n', scale)).toThrow(
      /\[outv\] が見つかりません/,
    );
  });

  it('[outv] が複数あれば throw（挿入点が一意に決まらない）', () => {
    const twice = '[0:v]trim=start_frame=0:end_frame=1[outv];\n[outv]null[outv]\n';
    expect(() => applyScaleFilter(twice, scale)).toThrow(/\[outv\] が複数個あります/);
  });
});
