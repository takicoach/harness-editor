import {expect,it} from 'vitest';
import {RULER_LABEL_PITCH_PX,rulerLabel,rulerLabelFromSeconds,rulerStep} from './rulerStep';

it('ラベルの最小間隔は 72px',()=>{expect(RULER_LABEL_PITCH_PX).toBe(72);});
it('72px ちょうどを満たす最小の候補を選ぶ（fps 30）',()=>{
  expect(rulerStep(72/30,30)!.stepFrames).toBe(30);        // 1 秒でちょうど 72px
  expect(rulerStep(72/30-.001,30)!.stepFrames).toBe(60);   // 足りなければ 1 段上がる
  expect(rulerStep(4,30)!.stepFrames).toBe(30);            // 余れば 1 秒のまま
});
it('fps 60 でも同じ秒数を選ぶ',()=>{
  expect(rulerStep(72/60,60)!.stepFrames).toBe(60);
  expect(rulerStep(72/60-.001,60)!.stepFrames).toBe(120);
});
it('600 秒でも足りなければ ×2 で伸ばす',()=>{
  const wide=rulerStep(72/(30*900),30)!;                   // 900 秒必要 → 1200 秒
  expect(wide.stepFrames).toBe(1200*30);
});
it('86400 秒で打ち切る',()=>{
  expect(rulerStep(1e-9,30)!.stepFrames).toBe(86400*30);
});
it('不正な入力では null を返す',()=>{
  for(const [px,fps] of [[0,30],[-1,30],[2,0],[2,-30],[NaN,30],[Infinity,30],[2,NaN],[2,Infinity]] as const)
    expect(rulerStep(px,fps)).toBeNull();
});
it('補助線は 5 の倍数秒なら 5 分割・それ以外は 2 分割で、8px 未満なら描かない',()=>{
  expect(rulerStep(4,30)).toEqual({stepFrames:30,minorFrames:15,stepSeconds:1,minorDivisions:2});      // 1 秒 → 2 分割、15fr*4px=60px
  expect(rulerStep(1,30)).toEqual({stepFrames:150,minorFrames:30,stepSeconds:5,minorDivisions:5});     // 5 秒 → 5 分割、30fr*1px=30px
  expect(rulerStep(72/30,30)!.minorFrames).toBe(15);
  expect(rulerStep(1e-9,30)!.minorFrames).toBeNull();
});
it('23.976fps では stepFrames を整数化しない（Codex P2）。1800 番目の目盛りは各位置を丸めた 43157 フレーム',()=>{
  const fps=24000/1001; // 23.976023976024…
  const step=rulerStep(72/fps,fps)!;
  expect(step.stepFrames).toBeCloseTo(fps,10);                 // 24 に丸めない
  expect(Math.round(1800*step.stepFrames)).toBe(Math.round(1800*fps));
  expect(Math.round(1800*step.stepFrames)).toBe(43157);
});
it('整数 fps（30／60）では従来どおりの位置になる',()=>{
  expect(Math.round(1800*rulerStep(72/30,30)!.stepFrames)).toBe(1800*30);
  expect(Math.round(900*rulerStep(72/60,60)!.stepFrames)).toBe(900*60);
});
it('ラベルは m:ss、長尺指定では h:mm:ss',()=>{
  expect(rulerLabel(0,30,false)).toBe('0:00');
  expect(rulerLabel(90,30,false)).toBe('0:03');
  expect(rulerLabel(30*754,30,false)).toBe('12:34');
  expect(rulerLabel(30*754,30,true)).toBe('0:12:34');
  expect(rulerLabel(30*4321,30,true)).toBe('1:12:01');
});

// R3-1: ラベルは stepSeconds（整数）から直接整形する。fps を経由して割り戻すと 29.97/23.976fps で
// 隣り合う目盛りが同じ表記になる（例: 29.97fps の 9 本目が 8 本目と同じ「0:08」）。
it('R3-1: 29.97fps で 5000 本のラベルに重複が無い（index*stepSeconds から整形）',()=>{
  const fps=30000/1001; // 29.97002997…
  const step=rulerStep(72/fps,fps)!;
  const labels=Array.from({length:5000},(_,i)=>rulerLabelFromSeconds(i*step.stepSeconds,false));
  expect(new Set(labels).size).toBe(labels.length);
});
it('R3-1: 23.976fps でも 5000 本のラベルに重複が無い',()=>{
  const fps=24000/1001;
  const step=rulerStep(72/fps,fps)!;
  const labels=Array.from({length:5000},(_,i)=>rulerLabelFromSeconds(i*step.stepSeconds,false));
  expect(new Set(labels).size).toBe(labels.length);
});

// R3-2: 補助線の除外は index % minorDivisions で行う。丸めたフレーム値どうしの剰余だと端数 fps でずれる。
it('R3-2: 端数 fps でも補助線の位置が主目盛りと重ならない',()=>{
  for(const fps of [30000/1001,24000/1001]){
    const step=rulerStep(72/fps,fps)!;
    if(!step.minorFrames)continue;
    const majorPositions=new Set(Array.from({length:3000},(_,i)=>Math.round(i*step.stepFrames)));
    const minorPositions=Array.from({length:3000},(_,i)=>i)
      .filter(i=>i%step.minorDivisions!==0)
      .map(i=>Math.round(i*step.minorFrames!));
    for(const pos of minorPositions)expect(majorPositions.has(pos)).toBe(false);
  }
});
it('R3-2: 整数 fps（30）では主目盛り・補助線の本数・位置が従来どおり',()=>{
  const step=rulerStep(4,30)!; // stepFrames=30, minorFrames=15, minorDivisions=2
  const majorPositions=Array.from({length:101},(_,i)=>Math.round(i*step.stepFrames));
  expect(majorPositions).toEqual(Array.from({length:101},(_,i)=>i*30));
  const minorPositions=Array.from({length:200},(_,i)=>i)
    .filter(i=>i%step.minorDivisions!==0)
    .map(i=>Math.round(i*step.minorFrames!));
  // 旧実装（丸めたフレーム値の剰余）と本数・位置が一致する
  const legacyMinorPositions=Array.from({length:200},(_,i)=>i*step.minorFrames!)
    .filter(tick=>Math.round(tick)%Math.round(step.stepFrames)!==0)
    .map(tick=>Math.round(tick));
  expect(minorPositions).toEqual(legacyMinorPositions);
});
