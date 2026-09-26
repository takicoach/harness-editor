import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {laneMode,DENSITY_BELOW} from './densityLane';
const clips=(n:number,durationFrames:number)=>Array.from({length:n},(_,i)=>({startFrame:i*durationFrames*2,durationFrames}));

describe('laneMode（F10）',()=>{
  it('8 個以上でクリップ幅の中央値が 24px 未満なら密度帯',()=>{
    expect(DENSITY_BELOW).toBe(24);
    expect(laneMode(clips(314,60),0.09)).toBe('density');   // 60fr × 0.09 = 5.4px（実測 0.09× の中央値 5px）
    expect(laneMode(clips(314,60),0.5)).toBe('clips');      // 30px
  });
  it('7 個以下は常にクリップ（監査の小さな案件を変えない）',()=>{
    expect(laneMode(clips(7,10),0.05)).toBe('clips');
    expect(laneMode([],0.05)).toBe('clips');
  });
  it('中央値で判定する（長い章ラベルが 2 つ混ざっても密度帯）',()=>{
    expect(laneMode([...clips(20,30),{startFrame:0,durationFrames:3000},{startFrame:1,durationFrames:3000}],0.09)).toBe('density');
  });
  it('native.css の .native-density-lane は pointer-events:none を宣言する（帯がシーク・範囲選択を飲み込まない唯一の保証。jsdom はヒットテストを評価しないため CSS を文字列で検査する）',()=>{
    const css=readFileSync(fileURLToPath(new URL('./native.css',import.meta.url)),'utf8');
    const rule=css.match(/\.native-density-lane\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule![0]).toMatch(/pointer-events:\s*none/);
  });
});
