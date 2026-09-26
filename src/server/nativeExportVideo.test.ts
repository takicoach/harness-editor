import { describe, expect, it } from 'vitest';
import {
  applyOverlays,
  applyShapeOverlays,
  computeOverlayInputIndexBase,
  videoInsertPlacement,
  type OverlayLayer,
  type VideoOverlayLayer,
  type ShapeOverlay,
} from './nativeExportVideo';
import { applyAudioMix } from './nativeExportAudio';
import { buildCutFilterScript, scaleFilterFor } from './fastCutRender';
import { videoInsertAnimSteps } from './videoInsertAnim';

const BASE = '[0:v]fps=30,trim=start=0.000000:end=1.000000,setpts=PTS-STARTPTS[v0];\n' +
  '[0:a]atrim=start=0.000000:end=1.000000,asetpts=PTS-STARTPTS[a0];\n' +
  '[v0][a0]concat=n=1:v=1:a=1[outv][outa]\n';

describe('applyShapeOverlays', () => {
  it('overlays が空なら script をそのまま返す（恒等）', () => {
    expect(applyShapeOverlays(BASE, [], 30, 1)).toBe(BASE);
  });

  it('図形1個・D>=16（フェード対・s/n 実値）のスクリプト全文 pin', () => {
    // shape: startFrame=10, endFrame=30, durationFrames=20, fps=30, inputIndexBase=1 (音声なし想定)
    // S = sec(10,30) = 10/30 = 0.333333
    // fade: D>=16 → fade=t=in:s=0:n=8:alpha=1,fade=t=out:s=(D-8)=12:n=8:alpha=1
    // enable: gte(t,sec(startFrame-0.5,fps))*lt(t,sec(endFrame-0.5,fps))
    //   sec(9.5,30) = 9.5/30 = 0.3166666... → toFixed(6) = 0.316667
    //   sec(29.5,30) = 29.5/30 = 0.9833333... → toFixed(6) = 0.983333
    const overlay: ShapeOverlay = { startFrame: 10, endFrame: 30, durationFrames: 20 };
    const out = applyShapeOverlays(BASE, [overlay], 30, 1);
    const expected =
      '[0:v]fps=30,trim=start=0.000000:end=1.000000,setpts=PTS-STARTPTS[v0];\n' +
      '[0:a]atrim=start=0.000000:end=1.000000,asetpts=PTS-STARTPTS[a0];\n' +
      '[v0][a0]concat=n=1:v=1:a=1[shraw][outa];\n' +
      '[shraw]settb=1/30,setpts=N[shbase];\n' +
      "[1:v]format=rgba,fade=t=in:s=0:n=8:alpha=1,fade=t=out:s=12:n=8:alpha=1,settb=1/30,setpts=N+10[shp0];\n" +
      "[shbase][shp0]overlay=x=0:y=0:eof_action=pass:enable='gte(t,0.316667)*lt(t,0.983333)'[outv]\n";
    expect(out).toBe(expected);
  });

  it('図形1個・D=12（geq の式全文）のスクリプト全文 pin', () => {
    // shape: startFrame=5, endFrame=17, durationFrames=12, fps=30, inputIndexBase=1
    // S = sec(5,30) = 5/30 = 0.166667
    // fade: D<16 → geq（4プレーン明示・a のみ時間変化）: clip(min(N/8,(D-N)/8),0,1)
    // enable: sec(4.5,30) = 4.5/30 = 0.15 → 0.150000 / sec(16.5,30) = 16.5/30 = 0.55 → 0.550000
    const overlay: ShapeOverlay = { startFrame: 5, endFrame: 17, durationFrames: 12 };
    const out = applyShapeOverlays(BASE, [overlay], 30, 1);
    const expected =
      '[0:v]fps=30,trim=start=0.000000:end=1.000000,setpts=PTS-STARTPTS[v0];\n' +
      '[0:a]atrim=start=0.000000:end=1.000000,asetpts=PTS-STARTPTS[a0];\n' +
      '[v0][a0]concat=n=1:v=1:a=1[shraw][outa];\n' +
      '[shraw]settb=1/30,setpts=N[shbase];\n' +
      "[1:v]format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip(min(N/8,(12-N)/8),0,1)',settb=1/30,setpts=N+5[shp0];\n" +
      "[shbase][shp0]overlay=x=0:y=0:eof_action=pass:enable='gte(t,0.150000)*lt(t,0.550000)'[outv]\n";
    expect(out).toBe(expected);
  });

  it('図形3個・overlay 鎖のラベル連鎖（[shbase]→[ov0]→[ov1]→最終[outv]）のスクリプト全文 pin', () => {
    // shape0: start=0,end=20,D=20 / shape1: start=20,end=40,D=20 / shape2: start=40,end=60,D=20
    // fps=30, inputIndexBase=2 (音声2本ぶん先取り想定) → 入力 index 2,3,4
    // S0=sec(0,30)=0.000000 / S1=sec(20,30)=20/30=0.666667 / S2=sec(40,30)=40/30=1.333333
    // すべて D=20>=16 → fade=t=in:s=0:n=8:alpha=1,fade=t=out:s=12:n=8:alpha=1（共通）
    // enable0: sec(-0.5,30)=-0.5/30=-0.016667 / sec(19.5,30)=19.5/30=0.650000
    // enable1: sec(19.5,30)=0.650000 / sec(39.5,30)=39.5/30=1.316667
    // enable2: sec(39.5,30)=1.316667 / sec(59.5,30)=59.5/30=1.983333
    const overlays: ShapeOverlay[] = [
      { startFrame: 0, endFrame: 20, durationFrames: 20 },
      { startFrame: 20, endFrame: 40, durationFrames: 20 },
      { startFrame: 40, endFrame: 60, durationFrames: 20 },
    ];
    const out = applyShapeOverlays(BASE, overlays, 30, 2);
    const fade = 'fade=t=in:s=0:n=8:alpha=1,fade=t=out:s=12:n=8:alpha=1';
    const expected =
      '[0:v]fps=30,trim=start=0.000000:end=1.000000,setpts=PTS-STARTPTS[v0];\n' +
      '[0:a]atrim=start=0.000000:end=1.000000,asetpts=PTS-STARTPTS[a0];\n' +
      '[v0][a0]concat=n=1:v=1:a=1[shraw][outa];\n' +
      '[shraw]settb=1/30,setpts=N[shbase];\n' +
      `[2:v]format=rgba,${fade},settb=1/30,setpts=N+0[shp0];\n` +
      `[3:v]format=rgba,${fade},settb=1/30,setpts=N+20[shp1];\n` +
      `[4:v]format=rgba,${fade},settb=1/30,setpts=N+40[shp2];\n` +
      "[shbase][shp0]overlay=x=0:y=0:eof_action=pass:enable='gte(t,-0.016667)*lt(t,0.650000)'[ov0];\n" +
      "[ov0][shp1]overlay=x=0:y=0:eof_action=pass:enable='gte(t,0.650000)*lt(t,1.316667)'[ov1];\n" +
      "[ov1][shp2]overlay=x=0:y=0:eof_action=pass:enable='gte(t,1.316667)*lt(t,1.983333)'[outv]\n";
    expect(out).toBe(expected);
  });

  it('enable の実値 pin: startFrame=100, endFrame=250, fps=30 → gte(t,3.316667)*lt(t,8.316667)', () => {
    // sec(99.5,30) = 99.5/30 = 3.3166666... → toFixed(6) = 3.316667  ((100-0.5)/30)
    // sec(249.5,30) = 249.5/30 = 8.3166666... → toFixed(6) = 8.316667 ((250-0.5)/30)
    const overlay: ShapeOverlay = { startFrame: 100, endFrame: 250, durationFrames: 150 };
    const out = applyShapeOverlays(BASE, [overlay], 30, 1);
    expect(out).toContain("enable='gte(t,3.316667)*lt(t,8.316667)'");
  });

  it('合成不干渉: applyAudioMix（SE1+BGM1）→ applyShapeOverlays（inputIndexBase=3・図形1個）でも音声チェーン部分（atrim〜amix の全行）が applyAudioMix 単独適用時と1文字も変わらない', () => {
    const cutScript = buildCutFilterScript([{ start: 0, end: 30 }], 30);
    const audioOnly = applyAudioMix(cutScript, [
      { startFrame: 0, endFrame: 30, volume: 0.8 }, // SE (input 1)
      { startFrame: 0, endFrame: 30, volume: 0.5, fadeInFrames: 6 }, // BGM (input 2)
    ], 30);
    const overlay: ShapeOverlay = { startFrame: 0, endFrame: 15, durationFrames: 15 };
    const withShapes = applyShapeOverlays(audioOnly, [overlay], 30, 3);

    const anchor = '[1:a]atrim';
    const endMarker = '[outa]';
    const audioBlockA = audioOnly.slice(
      audioOnly.indexOf(anchor),
      audioOnly.lastIndexOf(endMarker) + endMarker.length,
    );
    const audioBlockB = withShapes.slice(
      withShapes.indexOf(anchor),
      withShapes.lastIndexOf(endMarker) + endMarker.length,
    );
    expect(audioBlockA.length).toBeGreaterThan(0);
    // アンカー保険: indexOf が -1（未検出）のまま slice すると 0 幅の偽陽性 PASS になりうるため、
    // アンカー自体が実在すること・拾った区間が実際に amix を含むことを明示する
    expect(audioOnly.indexOf(anchor)).toBeGreaterThanOrEqual(0);
    expect(withShapes.indexOf(anchor)).toBeGreaterThanOrEqual(0);
    expect(audioBlockA).toContain('amix=');
    expect(audioBlockB).toBe(audioBlockA);
    // -map [outv] -map [outa] を崩さない: [outa] は変わらず、[outv] は図形合成後のラベルとして残る
    expect(withShapes).toContain('[outv]');
    expect(withShapes).toContain('[outa]');
  });

  it('scale 挿入形（[outv] が中間行にある）でもスクリプト全文 pin: 「concat または scale の出力ラベル」契約の scale 側', () => {
    // 実挙動をそのまま使う（applyShapeOverlays 自体は使わない）:
    // buildCutFilterScript → fastCutRender.ts の scale 挿入置換（[outv][outa] → [catv][outa];\n[catv]scale...[outv]）
    // → applyAudioMix（SE1本）。ここまでは applyShapeOverlays の対象外（既存2関数の責務）で、
    // [outv] が「[catv]scale=...[outv]」という中間行の label として現れる状態を作る。
    const cutScript = buildCutFilterScript([{ start: 0, end: 30 }], 30);
    const scale = scaleFilterFor({ resolution: '1080p', quality: 'high' }, { width: 3840, height: 2160 });
    expect(scale).toBe('scale=1920:1080:flags=lanczos');
    const scaledScript = cutScript.replace('[outv][outa]', '[catv][outa];\n[catv]' + scale + '[outv]');
    const withAudio = applyAudioMix(scaledScript, [{ startFrame: 0, endFrame: 30, volume: 1 }], 30);
    // [outv] は scale 行にちょうど1個だけ存在すること（前提の検算）
    expect(withAudio.indexOf('[outv]')).toBe(withAudio.lastIndexOf('[outv]'));

    // 図形1個: startFrame=0, endFrame=20, durationFrames=20（D>=16）, inputIndexBase=2
    // （audio clip が input index 1 を使うため図形は 2 から）
    // S = sec(0,30) = 0.000000
    // enable: sec(-0.5,30) = -0.5/30 = -0.016667 / sec(19.5,30) = 19.5/30 = 0.650000
    const overlay: ShapeOverlay = { startFrame: 0, endFrame: 20, durationFrames: 20 };
    const out = applyShapeOverlays(withAudio, [overlay], 30, 2);

    // 期待値 = withAudio の唯一の [outv] を [shbase] に付け替えた文字列（trimEnd + ';\n'）
    // + 手計算した図形チェーン・overlay 行。[outv] 付け替え自体は withAudio から機械的に
    // 求まる（実装への転記ではなく「置換対象が一意である」という前提を使っているだけ）。
    const idx = withAudio.lastIndexOf('[outv]');
    const rewrittenBase = withAudio.slice(0, idx) + '[shraw]' + withAudio.slice(idx + '[outv]'.length);
    const expected =
      rewrittenBase.trimEnd() + ';\n' +
      '[shraw]settb=1/30,setpts=N[shbase];\n' +
      "[2:v]format=rgba,fade=t=in:s=0:n=8:alpha=1,fade=t=out:s=12:n=8:alpha=1,settb=1/30,setpts=N+0[shp0];\n" +
      "[shbase][shp0]overlay=x=0:y=0:eof_action=pass:enable='gte(t,-0.016667)*lt(t,0.650000)'[outv]\n";
    expect(out).toBe(expected);
    // scale 行自体は無傷（[catv]scale=...[shbase] のまま。中身の scale 文字列は変更されない）
    expect(out).toContain('[catv]scale=1920:1080:flags=lanczos[shraw]');
  });

  it('[outv] が script 中に複数個あると誤置換せず throw する', () => {
    const dup = '[0:v]dummy[outv];\n[0:v]dummy2[outv]\n';
    const overlay: ShapeOverlay = { startFrame: 0, endFrame: 10, durationFrames: 10 };
    expect(() => applyShapeOverlays(dup, [overlay], 30, 1)).toThrow(/複数個/);
  });

  it('durationFrames が endFrame-startFrame と食い違うと throw する（フェード長・-t尺・enable窓のずれを黙って通さない）', () => {
    const overlay: ShapeOverlay = { startFrame: 10, endFrame: 30, durationFrames: 19 };
    expect(() => applyShapeOverlays(BASE, [overlay], 30, 1)).toThrow(/durationFrames/);
  });

  it('enable の開始秒は丸めても境界フレームを跨がない: (start-1)/fps < s < start/fps', () => {
    const fps = 24;
    const overlay: ShapeOverlay = { startFrame: 40, endFrame: 100, durationFrames: 60 };
    const out = applyShapeOverlays(BASE, [overlay], fps, 1);
    const m = out.match(/enable='gte\(t,(-?\d+\.\d+)\)/);
    expect(m).not.toBeNull();
    const s = Number(m![1]);
    expect(s).toBeGreaterThan((overlay.startFrame - 1) / fps);
    expect(s).toBeLessThan(overlay.startFrame / fps);
  });
});

describe('applyOverlays（一般化・M2c T4: 静止型と連番型の両対応）', () => {
  it('overlays が空なら script をそのまま返す（恒等）', () => {
    expect(applyOverlays(BASE, [], 30, 1)).toBe(BASE);
  });

  it('連番型1個（fade なし・setpts シフト + enable スパン窓のみ）のスクリプト全文 pin', () => {
    // layer: kind=sequence, startFrame=10, endFrame=30, fps=30, inputIndexBase=1
    // S = sec(10,30) = 10/30 = 0.333333（static 版の同フィクスチャと同じ手計算）
    // フェードなし: format=rgba,setpts=...（fade/geq を挟まない）
    // enable: sec(9.5,30)=0.316667 / sec(29.5,30)=0.983333（static 版と同一の enable 計算）
    const layer: OverlayLayer = { kind: 'sequence', startFrame: 10, endFrame: 30 };
    const out = applyOverlays(BASE, [layer], 30, 1);
    const expected =
      '[0:v]fps=30,trim=start=0.000000:end=1.000000,setpts=PTS-STARTPTS[v0];\n' +
      '[0:a]atrim=start=0.000000:end=1.000000,asetpts=PTS-STARTPTS[a0];\n' +
      '[v0][a0]concat=n=1:v=1:a=1[shraw][outa];\n' +
      '[shraw]settb=1/30,setpts=N[shbase];\n' +
      "[1:v]format=rgba,settb=1/30,setpts=N+10[shp0];\n" +
      "[shbase][shp0]overlay=x=0:y=0:eof_action=pass:enable='gte(t,0.316667)*lt(t,0.983333)'[outv]\n";
    expect(out).toBe(expected);
  });

  it('連番型に scaleTo があると format=rgba の直後に scale を挟む（原寸撮影→出力解像度・M2c T5）', () => {
    const layer: OverlayLayer = { kind: 'sequence', startFrame: 10, endFrame: 30, scaleTo: { width: 1920, height: 1080 } };
    const out = applyOverlays(BASE, [layer], 30, 1);
    expect(out).toContain('[1:v]format=rgba,scale=1920:1080,settb=1/30,setpts=N+10[shp0];');
    // scaleTo 無しの出力に scale が混入しないこと（既存経路の回帰ガード）
    expect(applyOverlays(BASE, [{ kind: 'sequence', startFrame: 10, endFrame: 30 }], 30, 1)).not.toContain('scale=');
  });

  it('静止型→連番型→静止型の混在3層が z 順どおり [shbase]→[ov0]→[ov1]→[outv] に積層される（スクリプト全文 pin）', () => {
    // layer0(static): start=0,end=20,D=20 / layer1(sequence): start=20,end=40 / layer2(static): start=40,end=60,D=20
    // fps=30, inputIndexBase=2 → 入力 index 2,3,4
    // S0=sec(0,30)=0.000000 / S1=sec(20,30)=20/30=0.666667 / S2=sec(40,30)=40/30=1.333333
    //  （applyShapeOverlays「図形3個」テストと同一の手計算 fixture を流用。中央だけ連番型に差し替え）
    // static は D=20>=16 → fade=t=in:s=0:n=8:alpha=1,fade=t=out:s=12:n=8:alpha=1（共通）
    // sequence（layer1）はフェードなし
    // enable0: sec(-0.5,30)=-0.016667 / sec(19.5,30)=0.650000
    // enable1: sec(19.5,30)=0.650000 / sec(39.5,30)=1.316667
    // enable2: sec(39.5,30)=1.316667 / sec(59.5,30)=1.983333
    const layers: OverlayLayer[] = [
      { kind: 'static', startFrame: 0, endFrame: 20, durationFrames: 20 },
      { kind: 'sequence', startFrame: 20, endFrame: 40 },
      { kind: 'static', startFrame: 40, endFrame: 60, durationFrames: 20 },
    ];
    const out = applyOverlays(BASE, layers, 30, 2);
    const fade = 'fade=t=in:s=0:n=8:alpha=1,fade=t=out:s=12:n=8:alpha=1';
    const expected =
      '[0:v]fps=30,trim=start=0.000000:end=1.000000,setpts=PTS-STARTPTS[v0];\n' +
      '[0:a]atrim=start=0.000000:end=1.000000,asetpts=PTS-STARTPTS[a0];\n' +
      '[v0][a0]concat=n=1:v=1:a=1[shraw][outa];\n' +
      '[shraw]settb=1/30,setpts=N[shbase];\n' +
      `[2:v]format=rgba,${fade},settb=1/30,setpts=N+0[shp0];\n` +
      `[3:v]format=rgba,settb=1/30,setpts=N+20[shp1];\n` +
      `[4:v]format=rgba,${fade},settb=1/30,setpts=N+40[shp2];\n` +
      "[shbase][shp0]overlay=x=0:y=0:eof_action=pass:enable='gte(t,-0.016667)*lt(t,0.650000)'[ov0];\n" +
      "[ov0][shp1]overlay=x=0:y=0:eof_action=pass:enable='gte(t,0.650000)*lt(t,1.316667)'[ov1];\n" +
      "[ov1][shp2]overlay=x=0:y=0:eof_action=pass:enable='gte(t,1.316667)*lt(t,1.983333)'[outv]\n";
    expect(out).toBe(expected);
  });

  it('連番型のみ（durationFrames を持たない）でも assertShapeOverlayInvariant の検算対象にならない', () => {
    // static 版の「durationFrames 食い違いで throw」テストの対照:
    // sequence 型には durationFrames フィールド自体が無いので検算されず、正常に通ること
    const layer: OverlayLayer = { kind: 'sequence', startFrame: 0, endFrame: 10 };
    expect(() => applyOverlays(BASE, [layer], 30, 1)).not.toThrow();
  });

  it('applyShapeOverlays は applyOverlays(overlays.map(kind:static)) の薄いラッパー（同一出力）', () => {
    const overlays: ShapeOverlay[] = [
      { startFrame: 5, endFrame: 25, durationFrames: 20 },
      { startFrame: 25, endFrame: 40, durationFrames: 15 },
    ];
    const viaShapeApi = applyShapeOverlays(BASE, overlays, 30, 1);
    const viaGeneralApi = applyOverlays(
      BASE,
      overlays.map((o): OverlayLayer => ({ kind: 'static', ...o })),
      30,
      1,
    );
    expect(viaShapeApi).toBe(viaGeneralApi);
  });
});

describe('computeOverlayInputIndexBase（M2c 設計判断8: inputIndexBase の順送り）', () => {
  it('単元素でない fixture: 音声2本・画像3枚・サブ動画2本・図形2個・telop+title連番1本の積み上げ', () => {
    // imagesBase = 1(main) + 2(音声) = 3
    // videosBase = 3 + 3(画像) = 6      ← M4 正典⑦（画像の後・図形の前）
    // shapesBase = 6 + 2(サブ動画) = 8
    // telopTitleBase = 8 + 2(図形) = 10
    // nextBase = 10 + 1(telop+title) = 11
    const plan = computeOverlayInputIndexBase({
      audioInputCount: 2,
      imagesCount: 3,
      videosCount: 2,
      shapesCount: 2,
      telopTitleCount: 1,
    });
    expect(plan).toEqual({ imagesBase: 3, videosBase: 6, shapesBase: 8, telopTitleBase: 10, nextBase: 11 });
  });

  it('videosCount 省略時は従来どおり画像の直後に図形が続く（受入 E: 既存呼び出し側の割当が動かない）', () => {
    const plan = computeOverlayInputIndexBase({
      audioInputCount: 2,
      imagesCount: 3,
      shapesCount: 2,
      telopTitleCount: 1,
    });
    expect(plan).toEqual({ imagesBase: 3, videosBase: 6, shapesBase: 6, telopTitleBase: 8, nextBase: 9 });
  });

  it('全て0本なら画像群が音声[i+1:a]の直後（1）から始まり、他も同じ base に潰れる（音声添字は一切参照しない）', () => {
    const plan = computeOverlayInputIndexBase({
      audioInputCount: 0,
      imagesCount: 0,
      videosCount: 0,
      shapesCount: 0,
      telopTitleCount: 0,
    });
    expect(plan).toEqual({ imagesBase: 1, videosBase: 1, shapesBase: 1, telopTitleBase: 1, nextBase: 1 });
  });

  it('音声だけ本数があるケース（1+音声 の積み上げが imagesBase に正しく反映される）', () => {
    const plan = computeOverlayInputIndexBase({
      audioInputCount: 5,
      imagesCount: 0,
      shapesCount: 0,
      telopTitleCount: 0,
    });
    expect(plan.imagesBase).toBe(6);
  });
});

/**
 * M4 T2: サブ動画（videoInserts）レイヤ。
 *
 * 正典（実測で確定した M4 の規則）:
 * - ①② フレーム選択 = 「T2 実測1」で確定した canon 写像（tpad → setpts → fps=…:round=down）。
 *   **式は実測で確定した形そのもの**（`tpad` は `setpts` の前・`-1e-6` は必須・round=down）。
 * - ③ ソース末尾超過は最終フレームへクランプ（tpad=stop=-1:stop_mode=clone）
 * - ④ 窓は [startFrame,endFrame) 排他（enableExprFor・既存レイヤと同一）
 * - ⑤ 幾何は contain → scale（中心基準）→ translate（pos.x×幅/2）
 */
describe('videoInsertPlacement（正典⑤: contain → scale → translate の実値）', () => {
  const size = { width: 1280, height: 720 };

  it('T1(c) 実測表の c1〜c4 を実値で pin（Remotion 基準線と画素差ゼロだった組）', () => {
    // c1: 位置・拡大なし → 全画面
    expect(videoInsertPlacement(size, undefined, undefined)).toEqual({ width: 1280, height: 720, x: 0, y: 0 });
    // c2: pos(0.4,-0.25) scale=1 → x=0.4×640=256 / y=-0.25×360=-90（観測 bbox [256,0]-[1279,629]）
    // I-1: 画面外へはみ出す配置なので可視領域の crop が付く（幾何そのものは c2 の実測どおり）。
    expect(videoInsertPlacement(size, { x: 0.4, y: -0.25 }, 1)).toEqual({
      width: 1280, height: 720, x: 256, y: -90,
      crop: { x: 0, y: 90, width: 1024, height: 630 },
    });
    // c3: scale=0.5 → 640×360・中心基準で (320,180)（観測 bbox [320,180]-[959,539]）
    expect(videoInsertPlacement(size, undefined, 0.5)).toEqual({ width: 640, height: 360, x: 320, y: 180 });
    // c4: pos(-0.3,0.2) scale=0.35 → 448×252・x=(1280-448)/2-192=224 / y=(720-252)/2+72=306
    //     （観測 bbox [224,306]-[671,557]）
    expect(videoInsertPlacement(size, { x: -0.3, y: 0.2 }, 0.35)).toEqual({ width: 448, height: 252, x: 224, y: 306 });
  });

  it('弁別: translate を先・scale を後にした変異は c4 で別の値になる（正典⑤の順序が効いている）', () => {
    const canon = videoInsertPlacement(size, { x: -0.3, y: 0.2 }, 0.35);
    // 変異（誤った順序）: 中心基準で translate してから scale すると x = W/2 + (pos.x×W/2 - W/2)×scale
    const swappedX = Math.round(size.width / 2 + (-0.3 * (size.width / 2) - size.width / 2) * 0.35);
    expect(swappedX).not.toBe(canon.x);
  });

  it('scale が 0 以下・非有限なら throw（黙って幅0のレイヤを作らない）', () => {
    expect(() => videoInsertPlacement(size, undefined, 0)).toThrow(/scale/);
    expect(() => videoInsertPlacement(size, undefined, Number.NaN)).toThrow(/scale/);
  });

  /**
   * **I-1 の後半: 可視領域の crop。**
   *
   * `scale > 1` の配置は合成解像度を超える中間フレームを作る（4K × scale=5 なら
   * 19200×10800 の RGBA＝1 枚 800MB 超）。overlay は合成の外へはみ出した分を捨てるだけなので、
   * **overlay の前に可視領域へ切っておく**（切っても見える画素は 1 つも変わらない）。
   *
   * `crop` は「厳密に小さくできるとき」だけ返す——全面可視なら `undefined`（従来出力のまま）、
   * 完全に画面外なら空矩形になるので `undefined`（degenerate を crop で作らない）。
   */
  it('crop: 全面可視なら undefined（従来の出力を1文字も変えない）', () => {
    expect(videoInsertPlacement(size, undefined, 1).crop).toBeUndefined();
    expect(videoInsertPlacement(size, undefined, 0.5).crop).toBeUndefined();
    expect(videoInsertPlacement(size, { x: -0.3, y: 0.2 }, 0.35).crop).toBeUndefined();
  });

  it('crop: scale=5 は可視の 1280×720 だけを残す（中間フレームが合成解像度を超えない）', () => {
    const p = videoInsertPlacement(size, undefined, 5);
    expect({ width: p.width, height: p.height, x: p.x, y: p.y }).toEqual({
      width: 6400, height: 3600, x: -2560, y: -1440,
    });
    // 可視領域はレイヤ矩形の中央 1280×720。crop 後の描画位置は (x+crop.x, y+crop.y) = (0,0)。
    expect(p.crop).toEqual({ x: 2560, y: 1440, width: 1280, height: 720 });
    expect(p.x + p.crop!.x).toBe(0);
    expect(p.y + p.crop!.y).toBe(0);
  });

  it('crop: 画面外へはみ出す配置（c2）は見えている分だけを残す', () => {
    const p = videoInsertPlacement(size, { x: 0.4, y: -0.25 }, 1);
    // x=256（右へはみ出す 256px）・y=-90（上へはみ出す 90px）
    expect(p.crop).toEqual({ x: 0, y: 90, width: 1024, height: 630 });
    expect(p.x + p.crop!.x).toBe(256);
    expect(p.y + p.crop!.y).toBe(0);
  });

  it('crop: 完全に画面外なら undefined（空の crop を作って ffmpeg を壊さない）', () => {
    // pos.x=3 → x = 0 + 3×640 = 1920 ≥ 1280（合成の右外へ完全に出る）
    const p = videoInsertPlacement(size, { x: 3, y: 0 }, 1);
    expect(p.x).toBe(1920);
    expect(p.crop).toBeUndefined();
  });
});

describe('applyOverlays（M4 T2: サブ動画レイヤ）', () => {
  const videoLayer = (over: Partial<VideoOverlayLayer> = {}): VideoOverlayLayer => ({
    kind: 'video',
    startFrame: 10,
    endFrame: 30,
    sourceInFrame: 7,
    playbackRate: 1,
    placement: { width: 1280, height: 720, x: 0, y: 0 },
    ...over,
  });

  /** T2 実測1 で確定した canon 写像（この文字列そのものが実測の産物・整理禁止）。 */
  const canonChain = (s: number, rate: number, fps: number, windowFrames: number): string =>
    'tpad=stop=-1:stop_mode=clone,' +
    // 受入 F: `+0.5` でスロットの**中心**へ置き `round()` で整数化する（境界置きだと
    // 倍精度の丸め誤差がスロット 1 つ分のずれになる。非整数 fps=59.94 では全フレームがずれた）。
    `setpts='if(eq(N,0),0,round((max(0,ceil((((T+PREV_INT)/2-${s}/${fps})/${rate})*${fps}-1e-6))+0.5)/${fps}/TB))',` +
    // I-1: 窓長で打ち切る（窓の外のフレームを生成しない）。
    `fps=${fps}:round=down:eof_action=pass,trim=end_frame=${windowFrames}`;

  it('サブ動画1本のスクリプト全文 pin（canon 写像 → contain → 配置 → 窓）', () => {
    const out = applyOverlays(BASE, [videoLayer()], 30, 1);
    const expected =
      '[0:v]fps=30,trim=start=0.000000:end=1.000000,setpts=PTS-STARTPTS[v0];\n' +
      '[0:a]atrim=start=0.000000:end=1.000000,asetpts=PTS-STARTPTS[a0];\n' +
      '[v0][a0]concat=n=1:v=1:a=1[shraw][outa];\n' +
      '[shraw]settb=1/30,setpts=N[shbase];\n' +
      `[1:v]${canonChain(7, 1, 30, 20)},format=rgba,` +
      'scale=1280:720:force_original_aspect_ratio=decrease,' +
      'pad=1280:720:round((ow-iw)/2):round((oh-ih)/2):color=0x00000000,' +
      'settb=1/30,setpts=N+10[shp0];\n' +
      "[shbase][shp0]overlay=x=0:y=0:eof_action=pass:format=rgb:enable='gte(t,0.316667)*lt(t,0.983333)'[outv]\n";
    expect(out).toBe(expected);
  });

  it('sourceInFrame / playbackRate が canon 写像の式へ実値で入る（rate=0.7・S=13 の pin）', () => {
    const out = applyOverlays(BASE, [videoLayer({ sourceInFrame: 13, playbackRate: 0.7 })], 30, 1);
    expect(out).toContain(`[1:v]${canonChain(13, 0.7, 30, 20)},format=rgba,`);
    // 実測で必要と分かっている項が落ちていないこと（式の「整理」を禁じる pin）。
    expect(out).toContain('tpad=stop=-1:stop_mode=clone,setpts=');
    expect(out).toContain('-1e-6');
    expect(out).toContain('round=down:eof_action=pass');
  });

  it('placement が overlay の x/y と scale/pad の寸法へ入る（正典⑤・c4 の実値）', () => {
    const layer = videoLayer({ placement: videoInsertPlacement({ width: 1280, height: 720 }, { x: -0.3, y: 0.2 }, 0.35) });
    const out = applyOverlays(BASE, [layer], 30, 1);
    expect(out).toContain('scale=448:252:force_original_aspect_ratio=decrease,pad=448:252:');
    expect(out).toContain("overlay=x=224:y=306:eof_action=pass:format=rgb:enable='gte(t,0.316667)*lt(t,0.983333)'[outv]");
  });

  it('複数本（窓が重なる2本）は配列順に積層され、入力 index は inputIndexBase + 配列順', () => {
    const layers: OverlayLayer[] = [
      videoLayer({ startFrame: 10, endFrame: 40, sourceInFrame: 0, playbackRate: 1 }),
      videoLayer({ startFrame: 25, endFrame: 55, sourceInFrame: 5, playbackRate: 2 }),
    ];
    const out = applyOverlays(BASE, layers, 30, 3);
    expect(out).toContain(`[3:v]${canonChain(0, 1, 30, 30)},`);
    expect(out).toContain(`[4:v]${canonChain(5, 2, 30, 30)},`);
    // 窓が重なっても enable は互いに独立（[start,end) 排他）。後の層が上に載る。
    expect(out).toContain("[shbase][shp0]overlay=x=0:y=0:eof_action=pass:format=rgb:enable='gte(t,0.316667)*lt(t,1.316667)'[ov0];");
    expect(out).toContain("[ov0][shp1]overlay=x=0:y=0:eof_action=pass:format=rgb:enable='gte(t,0.816667)*lt(t,1.816667)'[outv]");
  });

  it('サブ動画0本なら script は1文字も変わらない（受入 E）', () => {
    expect(applyOverlays(BASE, [], 30, 1)).toBe(BASE);
  });

  it('playbackRate が 0 以下・非有限なら throw（式の分母がゼロになる形を黙って出さない）', () => {
    expect(() => applyOverlays(BASE, [videoLayer({ playbackRate: 0 })], 30, 1)).toThrow(/playbackRate/);
    expect(() => applyOverlays(BASE, [videoLayer({ playbackRate: -1 })], 30, 1)).toThrow(/playbackRate/);
  });

  /**
   * **I-1（中間レビュー・最重要）: 窓の外のフレームを作らない。**
   *
   * canon 写像は `tpad=stop=-1` で入力を**無限**にするので、後段を素のままにすると
   * サブ動画の鎖は合成の**全尺**を流れる（窓が 1 フレームでも 300 フレームでもコストが同じ）。
   * `fps` の直後に**窓長ぶんの `trim`** を置き、窓外のフレームを生成させない。
   *
   * `trim` は end に達した時点で上流へ EOF を返す（＝ `tpad` のクローンもそこで止まる）ため、
   * 「窓長に比例したコスト」になる。`trim` の後段で `setpts=N+startFrame` が PTS を
   * **フレーム番号**へ載せ直すので、時間軸（正典①②）の値は 1 つも変わらない。
   */
  it('I-1: `fps` の直後に窓長ぶんの trim が入る（窓長に追随する＝定数 pin ではない）', () => {
    const out20 = applyOverlays(BASE, [videoLayer({ startFrame: 10, endFrame: 30 })], 30, 1);
    expect(out20).toContain('fps=30:round=down:eof_action=pass,trim=end_frame=20,format=rgba,');
    // 窓 1 フレームなら trim も 1（窓長で決まる＝全尺を流していない証拠）。
    const out1 = applyOverlays(BASE, [videoLayer({ startFrame: 10, endFrame: 11 })], 30, 1);
    expect(out1).toContain('fps=30:round=down:eof_action=pass,trim=end_frame=1,format=rgba,');
    // 別の窓長でも追随（`trim=end_frame=20` を定数で焼いた実装はここで赤）。
    const out7 = applyOverlays(BASE, [videoLayer({ startFrame: 3, endFrame: 10 })], 30, 1);
    expect(out7).toContain('fps=30:round=down:eof_action=pass,trim=end_frame=7,format=rgba,');
  });

  /**
   * **I-1 の副作用に対する保険（弁別の回復）。**
   *
   * `trim` を入れた結果、窓の終端は **`trim`（ストリームの尺）と `enable`（合成の窓）の
   * 二重**で決まるようになった。二重化そのものは安全側だが、**片方だけを壊す変異は
   * 出力を変えない**（もう片方が押さえる）ため、画素で測る e2e が窓の終端を弁別できなくなる
   * ——実測でも「`enable` の終端を +1 する」変異は、変更前は画素 e2e が赤になったのに
   * 変更後は緑になった。
   *
   * そこで **同じ出力文字列の中で 2 つの機構が同じ窓長を指していること**を突き合わせる。
   * 期待値を書き写すのではなく、**生成された `enable` 式から窓長を復元**して `trim` と比べるので、
   * どちらか一方だけを動かす変異は必ず割れる。
   */
  it('I-1: trim の長さと enable 窓の長さが同一（片方だけ動かす変異を割る相互検査）', () => {
    const windowLengthOf = (script: string): { trim: number; enable: number } => {
      const trim = /trim=end_frame=(\d+)/.exec(script);
      const enable = /enable='gte\(t,(-?[\d.]+)\)\*lt\(t,(-?[\d.]+)\)'/.exec(script);
      expect(trim, 'trim が出力に無い').not.toBeNull();
      expect(enable, 'enable が出力に無い').not.toBeNull();
      return {
        trim: Number(trim![1]),
        // 秒 → フレーム（enable は半フレーム手前で刻むので差分がそのまま窓長）。
        enable: Math.round((Number(enable![2]) - Number(enable![1])) * 30),
      };
    };
    // 窓長の違う3本で突き合わせる（恒等 fixture 禁止・定数一致で通らない形）。
    for (const [startFrame, endFrame] of [[10, 30], [3, 10], [0, 1]] as const) {
      const out = applyOverlays(BASE, [videoLayer({ startFrame, endFrame })], 30, 1);
      const { trim, enable } = windowLengthOf(out);
      expect(trim, `窓 [${startFrame},${endFrame})`).toBe(endFrame - startFrame);
      expect(enable, `窓 [${startFrame},${endFrame})`).toBe(trim);
    }
  });

  it('I-1: placement.crop があれば pad の後に crop が入り、overlay の座標が crop 分だけ寄る', () => {
    const layer = videoLayer({ placement: videoInsertPlacement({ width: 1280, height: 720 }, undefined, 5) });
    const out = applyOverlays(BASE, [layer], 30, 1);
    expect(out).toContain(
      'scale=6400:3600:force_original_aspect_ratio=decrease,' +
        'pad=6400:3600:round((ow-iw)/2):round((oh-ih)/2):color=0x00000000,' +
        'crop=1280:720:2560:1440,',
    );
    // 描画位置は crop 後の座標（-2560+2560=0）。crop を入れて overlay の x を直し忘れると
    // 絵が -2560 へ飛ぶので、この 1 行が付け替え漏れを弁別する。
    expect(out).toContain("overlay=x=0:y=0:eof_action=pass:format=rgb:enable=");
  });

  it('I-1: crop が無い（全面可視）レイヤの幾何行は従来と1文字も変わらない', () => {
    const out = applyOverlays(BASE, [videoLayer({ placement: videoInsertPlacement({ width: 1280, height: 720 }, undefined, 0.5) })], 30, 1);
    expect(out).toContain('pad=640:360:round((ow-iw)/2):round((oh-ih)/2):color=0x00000000,settb=');
    expect(out).not.toContain('crop=');
  });

  it('I-1: 窓が空（endFrame <= startFrame）なら throw（0 フレームの trim を黙って出さない）', () => {
    expect(() => applyOverlays(BASE, [videoLayer({ startFrame: 10, endFrame: 10 })], 30, 1)).toThrow(/窓/);
    expect(() => applyOverlays(BASE, [videoLayer({ startFrame: 10, endFrame: 9 })], 30, 1)).toThrow(/窓/);
  });

  it('静止型・連番型と混在しても他種のレイヤ行は従来と1文字も変わらない（受入 E の同居版）', () => {
    const staticOnly = applyOverlays(BASE, [{ kind: 'static', startFrame: 0, endFrame: 20, durationFrames: 20 }], 30, 1);
    const mixed = applyOverlays(
      BASE,
      [{ kind: 'static', startFrame: 0, endFrame: 20, durationFrames: 20 }, videoLayer()],
      30,
      1,
    );
    // 静止型の layer 行（[1:v]…[shp0]）は単独時と同一文字列
    const staticLine = staticOnly.split('\n').find((l) => l.startsWith('[1:v]'));
    expect(mixed.split('\n').find((l) => l.startsWith('[1:v]'))).toBe(staticLine);
  });
});

describe('applyOverlays（M4 T4: サブ動画の出入りアニメ = フレーム分割された静的レイヤ列）', () => {
  const videoLayer = (over: Partial<VideoOverlayLayer> = {}): VideoOverlayLayer => ({
    kind: 'video',
    startFrame: 10,
    endFrame: 30,
    sourceInFrame: 0,
    playbackRate: 1,
    placement: videoInsertPlacement({ width: 1280, height: 720 }, undefined, 1),
    ...over,
  });

  const SIZE = { width: 1280, height: 720 };

  /** enter=fade 8fr のレイヤ（窓 [10,30)・D=20）。 */
  const fadeLayer = (): VideoOverlayLayer =>
    videoLayer({ animSteps: videoInsertAnimSteps(SIZE, undefined, 1, 20, { kind: 'fade', frames: 8 }, undefined) });

  it('animSteps が undefined なら従来の1レイヤ経路と1文字も変わらない（受入 E・アニメ無しにコストを足さない）', () => {
    expect(applyOverlays(BASE, [videoLayer({ animSteps: undefined })], 30, 1)).toBe(
      applyOverlays(BASE, [videoLayer()], 30, 1),
    );
    expect(applyOverlays(BASE, [videoLayer()], 30, 1)).not.toContain('split=');
    expect(applyOverlays(BASE, [videoLayer()], 30, 1)).not.toContain('colorchannelmixer');
  });

  it('canon 写像（正典①②③）は 1 本のまま split され、入力 `-i` は 1 レイヤ 1 本のまま', () => {
    const out = applyOverlays(BASE, [fadeLayer()], 30, 1);
    // 時間軸の鎖（tpad/setpts/fps/trim）は 1 回だけ＝素材のデコードも 1 回。
    expect(out.match(/tpad=stop=-1/g)).toHaveLength(1);
    expect(out.match(/\[1:v\]/g)).toHaveLength(1);
    expect(out).toContain(`,format=rgba,settb=1/30,split=8[vs0_0][vs0_1][vs0_2][vs0_3][vs0_4][vs0_5][vs0_6][vs0_7];`);
    // 他の入力 index を勝手に消費していない（サブ動画1本なら [2:v] は出てこない）。
    expect(out).not.toContain('[2:v]');
  });

  it('各 step は自分の k だけを trim し、絶対フレームへ setpts して固有の配置・alpha を持つ', () => {
    const out = applyOverlays(BASE, [fadeLayer()], 30, 1);
    // k=1（不透明度 1/8）。窓頭 10 + 1 = 絶対 11。
    expect(out).toContain(
      '[vs0_0]trim=start_frame=1:end_frame=2,setpts=N+11,' +
        'scale=1280:720:force_original_aspect_ratio=decrease,' +
        'pad=1280:720:round((ow-iw)/2):round((oh-ih)/2):color=0x00000000,' +
        'colorchannelmixer=aa=0.125[shp0_0];',
    );
    // k=3（3/8 = 0.375）。
    expect(out).toContain('[vs0_2]trim=start_frame=3:end_frame=4,setpts=N+13,');
    expect(out).toContain('colorchannelmixer=aa=0.375[shp0_2];');
    // 平坦部（k=8..19）は 1 段にまとまり、不透明なので colorchannelmixer が付かない。
    expect(out).toContain('[vs0_7]trim=start_frame=8:end_frame=20,setpts=N+18,');
    expect(out.split('\n').find((l) => l.startsWith('[vs0_7]'))).not.toContain('colorchannelmixer');
  });

  it('step ごとに overlay が 1 本ずつ積まれ、enable 窓が step の絶対フレーム範囲と一致する', () => {
    const out = applyOverlays(BASE, [fadeLayer()], 30, 1);
    // k=1 の step は絶対 [11,12)。
    expect(out).toContain(
      "[shbase][shp0_0]overlay=x=0:y=0:eof_action=pass:format=rgb:enable='gte(t,0.350000)*lt(t,0.383333)'[ov0];",
    );
    // 平坦部は絶対 [18,30)。最後の step が [outv] を持つ。
    expect(out).toContain(
      "[ov6][shp0_7]overlay=x=0:y=0:eof_action=pass:format=rgb:enable='gte(t,0.583333)*lt(t,0.983333)'[outv]",
    );
    expect(out.match(/\[outv\]/g)).toHaveLength(1);
  });

  it('enable 窓の総和が「可視 k の枚数」と一致する（step を1つ落とす変異を割る相互検査）', () => {
    for (const [kind, frames, D] of [['fade', 8, 20], ['zoom', 6, 24], ['pop', 8, 20], ['slideIn', 5, 18]] as const) {
      const steps = videoInsertAnimSteps(SIZE, undefined, 1, D, { kind, frames }, { kind, frames })!;
      const out = applyOverlays(BASE, [videoLayer({ startFrame: 10, endFrame: 10 + D, animSteps: steps })], 30, 1);
      let covered = 0;
      for (const m of out.matchAll(/enable='gte\(t,(-?[\d.]+)\)\*lt\(t,(-?[\d.]+)\)'/g)) {
        covered += Math.round((Number(m[2]) - Number(m[1])) * 30);
      }
      const visible = steps.reduce((n, s) => n + (s.kEnd - s.kStart), 0);
      expect(covered, `${kind}/${frames}/${D}`).toBe(visible);
      expect(visible).toBeLessThan(D); // 不可視の k（enter の頭）が実際に落ちている
      expect(visible).toBeGreaterThan(0);
    }
  });

  it('pop のオーバーシュート域は step ごとの crop を持ち、overlay 座標もその step の crop で寄る', () => {
    const steps = videoInsertAnimSteps(SIZE, undefined, 1, 20, { kind: 'pop', frames: 8 }, undefined)!;
    const out = applyOverlays(BASE, [videoLayer({ animSteps: steps })], 30, 1);
    const over = steps.map((s, j) => [j, s] as const).filter(([, s]) => s.placement.crop !== undefined);
    expect(over.length).toBeGreaterThan(0);
    for (const [j, s] of over) {
      const c = s.placement.crop!;
      const line = out.split('\n').find((l) => l.startsWith(`[vs0_${j}]`))!;
      expect(line, `step ${j}`).toContain(`,crop=${c.width}:${c.height}:${c.x}:${c.y}`);
      const ov = out.split('\n').find((l) => l.includes(`[shp0_${j}]overlay=`))!;
      expect(ov, `step ${j}`).toContain(`overlay=x=${s.placement.x + c.x}:y=${s.placement.y + c.y}:`);
    }
    // 静的 placement（scale=1・crop 無し）の座標をそのまま使い回した実装はここで赤になる。
    expect(out).toContain(',crop=1280:720:');
  });

  it('アニメ付き2本 + 静止型が混ざっても中間ラベルが衝突せず、入力 index は配列順のまま', () => {
    const layers: OverlayLayer[] = [
      { kind: 'static', startFrame: 0, endFrame: 20, durationFrames: 20 },
      videoLayer({ startFrame: 10, endFrame: 30, animSteps: videoInsertAnimSteps(SIZE, undefined, 1, 20, { kind: 'fade', frames: 4 }, undefined) }),
      videoLayer({ startFrame: 20, endFrame: 44, sourceInFrame: 2, animSteps: videoInsertAnimSteps(SIZE, undefined, 0.5, 24, undefined, { kind: 'slideIn', frames: 4, direction: 'right' }) }),
    ];
    const out = applyOverlays(BASE, layers, 30, 5);
    expect(out).toContain('[5:v]format=rgba,'); // 静止型
    expect(out).toContain('[6:v]tpad=stop=-1'); // 1本目のサブ動画
    expect(out).toContain('[7:v]tpad=stop=-1'); // 2本目のサブ動画
    expect(out).toContain('[vs1_0]');
    expect(out).toContain('[vs2_0]');
    expect(out.match(/\[outv\]/g)).toHaveLength(1);
    // ラベル重複は assertUniqueFilterOutputLabels が throw するので、ここまで来たら一意。
  });

  it('labelPrefix が付くと step のラベルにも伝播する（2回積む経路でのラベル衝突を防ぐ）', () => {
    const out = applyOverlays(BASE, [fadeLayer()], 30, 1, 'p2');
    expect(out).toContain('[p2vs0_0]');
    expect(out).toContain('[p2shp0_0]');
    expect(out).toContain('[p2ov0]');
  });

  it('animSteps が窓長を超える k を指していたら throw（呼び出し側の算出ミスを黙って通さない）', () => {
    const bad = videoInsertAnimSteps(SIZE, undefined, 1, 40, { kind: 'fade', frames: 8 }, undefined)!;
    expect(() => applyOverlays(BASE, [videoLayer({ startFrame: 10, endFrame: 30, animSteps: bad })], 30, 1)).toThrow(/step/);
  });

  it('animSteps が空配列なら throw（何も描かないレイヤを黙って作らない）', () => {
    expect(() => applyOverlays(BASE, [videoLayer({ animSteps: [] })], 30, 1)).toThrow(/step/);
  });
});

/**
 * M4 T5 持ち越し (c): **`scale > 1` が作る中間フレームの大きさを数値で固定する**。
 *
 * `scale` フィルタは合成解像度 × scale の RGBA フレームを実体化してから overlay が
 * はみ出しを捨てる（`crop` は `scale` の下流なので取り除けない）。UI のスライダ上限は
 * `videoInsertOps` の **scale = 5**、`pop` はさらに 1.12 倍のオーバーシュートを載せる。
 *
 * ここは**計算だけ**を pin する（性能はゲートに載せない・実行環境で揺れるため）。
 * 対応する実測（`scripts/bench-m4-video-insert.ts --label t5`・macOS・`/usr/bin/time -l`）:
 *
 * | ケース（4K 合成・50 フレーム） | real | CPU | 最大 RSS |
 * |---|---|---|---|
 * | 挿入なし（対照） | 0.48s | 2.0s | **2.45 GB** |
 * | scale=1 | 0.84s | 4.5s | **3.02 GB** |
 * | scale=5 | 3.65s | 24.8s | **5.11 GB** |
 * | scale=5 + pop（1.12 倍） | 3.18s | 17.9s | **5.87 GB** |
 *
 * 上限超えを事前分岐（Remotion 退避）にするかは**コントローラ裁定**（T5 では実装しない）。
 */
describe('M4 T5 持ち越し (c): scale > 1 の中間フレーム（UI 上限の実値を固定）', () => {
  const UHD = { width: 3840, height: 2160 };
  /** UI のスライダ上限（`src/app/edit/videoInsertOps.ts`）。 */
  const UI_MAX_SCALE = 5;
  /** `pop` のオーバーシュート（正典⑥・T1(d) 実測）。 */
  const POP_OVERSHOOT = 1.12;

  const bytesOf = (r: { width: number; height: number }): number => r.width * r.height * 4;

  it('4K × scale=5 の中間フレームは 19200×10800（RGBA 829 MB/枚）', () => {
    const r = videoInsertPlacement(UHD, undefined, UI_MAX_SCALE);
    expect([r.width, r.height]).toEqual([19200, 10800]);
    expect(Math.round(bytesOf(r) / 1024 / 1024)).toBe(791); // MiB
  });

  it('pop のオーバーシュートを載せると 20736×11664（RGBA 923 MiB/枚・実サンプルの最大は 1.08 倍）', () => {
    const steps = videoInsertAnimSteps(UHD, undefined, UI_MAX_SCALE, 20, { kind: 'pop', frames: 5 }, undefined)!;
    const worst = steps.reduce((a, b) => (bytesOf(a.placement) >= bytesOf(b.placement) ? a : b)).placement;
    // 連続式のオーバーシュートは 1.12 倍だが、**実際に描かれるのは整数 k のサンプルだけ**なので
    // 頂点にちょうど載るとは限らない（frames=5 では 1.08 倍が最大）。上限を置くなら
    // 「連続式の 1.12 倍」ではなく **サンプル最大**を見る必要がある。
    expect(worst.width / (UHD.width * UI_MAX_SCALE)).toBeCloseTo(1.08, 5);
    expect(worst.width / (UHD.width * UI_MAX_SCALE)).toBeLessThanOrEqual(POP_OVERSHOOT);
    expect([worst.width, worst.height]).toEqual([20736, 11664]);
    expect(Math.round(bytesOf(worst) / 1024 / 1024)).toBe(923); // MiB
  });

  it('1080p は scale=5 でも中間フレームが 1/4（＝上限を置くなら解像度依存にする根拠）', () => {
    const hd = videoInsertPlacement({ width: 1920, height: 1080 }, undefined, UI_MAX_SCALE);
    const uhd = videoInsertPlacement(UHD, undefined, UI_MAX_SCALE);
    expect(bytesOf(uhd) / bytesOf(hd)).toBe(4);
    expect(Math.round(bytesOf(hd) / 1024 / 1024)).toBe(198); // MiB
  });
});
