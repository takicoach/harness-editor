import {describe,it,expect} from 'vitest';
import {timelineBottom,isNarrow,rightColumnWidth,lowStage,toolbarFit,fitPanelGains,TOOLBAR_FIT_INITIAL,TOOLBAR_RESTORE_MARGIN,BOTTOM_MIN,BOTTOM_MAX,PREVIEW_CHROME,RAIL_ROW,STAGE_MIN} from './layoutBudget';

describe('timelineBottom（F1）',()=>{
  it('自動: 窓の高さの 34% を 180〜320px に収める',()=>{
    expect(timelineBottom({windowHeight:1249,bottom:null})).toBe(BOTTOM_MAX);  // 425 → 320
    expect(timelineBottom({windowHeight:800,bottom:null})).toBe(272);         // 1280×800（MacBook Air）
  });
  it('自動: 舞台が 240px を下回るならタイムラインを先に縮める（横 1 列の工具列 38px を見込む）',()=>{
    // 683: 34% = 232 → 舞台 683-190-232 = 261 < 320 で横 1 列 → 223 < 240 → 232-17 = 215
    expect(timelineBottom({windowHeight:683,bottom:null})).toBe(215);
    expect(timelineBottom({windowHeight:600,bottom:null})).toBe(BOTTOM_MIN);  // 足りなくても 180 より下げない
  });
  it('手動（ドラッグで決めた値）は舞台の最低高が取れる範囲でそのまま',()=>{
    expect(timelineBottom({windowHeight:800,bottom:300})).toBe(300);
    expect(timelineBottom({windowHeight:600,bottom:300})).toBe(BOTTOM_MIN);   // 600-190-240=170 → 180 で止める
  });
  it('定数は設計どおりの値',()=>{expect(STAGE_MIN).toBe(240);expect(RAIL_ROW).toBe(38);expect(PREVIEW_CHROME).toBe(190);expect(BOTTOM_MIN).toBe(180);});
});
describe('幅の分岐',()=>{
  it('1200px 未満で狭い（0 は未計測）',()=>{expect(isNarrow(1199)).toBe(true);expect(isNarrow(1200)).toBe(false);expect(isNarrow(0)).toBe(false);});
  it('狭いときの右カラムは 272px まで',()=>{expect(rightColumnWidth(1000,296)).toBe(272);expect(rightColumnWidth(1000,260)).toBe(260);expect(rightColumnWidth(1400,296)).toBe(296);});
  it('舞台の内容域が 320px 未満なら低い（F6）',()=>{expect(lowStage(319)).toBe(true);expect(lowStage(320)).toBe(false);expect(lowStage(0)).toBe(false);});
});
// I-7: 固定閾値 1100 では、ボタン数が違う仕上げモードで溢れたまま退避しなかった。実測で決める。
// I'-1: 記憶するのは「足りなかった容器幅」ではなく「必要だった幅（scrollWidth）」。
describe('toolbarFit（F4 / I-7 / I\'-1）',()=>{
  const fit=(compact:boolean,requiredWidth:number|null)=>({compact,requiredWidth});
  it('溢れたら退避し、その時の必要幅を覚える',()=>{
    expect(toolbarFit(TOOLBAR_FIT_INITIAL,{scrollWidth:1256,clientWidth:1100})).toEqual(fit(true,1256));
    expect(toolbarFit(TOOLBAR_FIT_INITIAL,{scrollWidth:1101,clientWidth:1100})).toEqual(TOOLBAR_FIT_INITIAL);   // 1px は丸めぶんとして許す
  });
  it('退避したあとは、必要幅＋余裕まで広くなってから戻す',()=>{
    const retreated=toolbarFit(TOOLBAR_FIT_INITIAL,{scrollWidth:1256,clientWidth:1100});
    // 退避すると中身がポップオーバーへ移って溢れが消える（scrollWidth は容器幅まで縮む）。
    expect(toolbarFit(retreated,{scrollWidth:1100,clientWidth:1100})).toBe(retreated);
    expect(toolbarFit(retreated,{scrollWidth:1255,clientWidth:1256+TOOLBAR_RESTORE_MARGIN-1})).toBe(retreated);
    expect(toolbarFit(retreated,{scrollWidth:1256,clientWidth:1256+TOOLBAR_RESTORE_MARGIN})).toEqual(fit(false,null));
  });
  /**
   * 掃き掃除（Rec 2）: 単点の入出力を固定するテストは実装の写しになる。容器幅を刻みで動かし、
   * 遷移の回数を数える。戻す基準が必要幅でなければ「戻す→溢れる→退避」を繰り返して必ず落ちる。
   */
  it('必要幅 1256 のまま容器を 1000→1400 まで 10px 刻みで広げても、compact の遷移は 1 回だけ（往復しない）',()=>{
    const required=1256;
    let state=toolbarFit(TOOLBAR_FIT_INITIAL,{scrollWidth:required,clientWidth:1000});
    expect(state.compact).toBe(true);   // 存在検査: 起点が退避済みでなければ以下は何も言っていない
    const flips:number[]=[];
    for(let clientWidth=1000;clientWidth<=1400;clientWidth+=10){
      // 退避中は中身が減って溢れが消える（scrollWidth は容器幅まで）。戻っていれば必要幅そのまま。
      const scrollWidth=state.compact?Math.min(required,clientWidth):required;
      const next=toolbarFit(state,{scrollWidth,clientWidth});
      if(next.compact!==state.compact)flips.push(clientWidth);
      state=next;
    }
    expect(flips).toHaveLength(1);
    expect(flips[0]).toBeGreaterThanOrEqual(required+TOOLBAR_RESTORE_MARGIN);
    expect(state.compact).toBe(false);   // 1400 まで広げ切ったら戻っている
  });
  it('未マウント・非表示（幅 0）では判定しない',()=>{
    expect(toolbarFit(TOOLBAR_FIT_INITIAL,{scrollWidth:0,clientWidth:0})).toBe(TOOLBAR_FIT_INITIAL);
  });
  /**
   * M-2: 退避中に必要幅がさらに増えた（例: 「選択範囲を戻す」が現れて必要幅が伸びた）後、
   * 古い必要幅のまま容器を広げると本当はまだ溢れる幅で戻ってしまい往復しうる。
   * requiredWidth が max 更新されていれば、伸びた必要幅＋余裕まで広げるまで遷移しない（1 回だけ）。
   */
  it('退避中に必要幅が増えた後、広げても compact の遷移は 1 回だけ',()=>{
    let state=toolbarFit(TOOLBAR_FIT_INITIAL,{scrollWidth:1256,clientWidth:1100});
    expect(state).toEqual({compact:true,requiredWidth:1256});
    // 退避中にさらに中身が増え、必要幅が 1256→1340 に伸びる（容器幅はまだ狭いまま溢れている）。
    state=toolbarFit(state,{scrollWidth:1340,clientWidth:1100});
    expect(state).toEqual({compact:true,requiredWidth:1340});
    const flips:number[]=[];
    for(let clientWidth=1100;clientWidth<=1400;clientWidth+=10){
      const scrollWidth=state.compact?Math.min(1340,clientWidth):1340;
      const next=toolbarFit(state,{scrollWidth,clientWidth});
      if(next.compact!==state.compact)flips.push(clientWidth);
      state=next;
    }
    expect(flips).toHaveLength(1);
    expect(flips[0]).toBeGreaterThanOrEqual(1340+TOOLBAR_RESTORE_MARGIN);
    expect(state.compact).toBe(false);
  });
});

// T7: 狭幅では右カラムが rightColumnWidth で 272 に丸められる。ここで右を太らせると見た目は変わらないのに
// 保存値だけ 460 近くまで育ち、あとで窓を 1200px 以上へ広げた瞬間に右カラムが跳ねる。
describe('fitPanelGains（「パネルを収める」の配り方・T7）',()=>{
  const wide={space:400,narrow:false,leftCollapsed:false,rightHidden:false,leftSize:248,rightSize:296};
  it('広幅では右へ先に配り、残りを左へ配る',()=>{
    const gains=fitPanelGains(wide);
    expect(gains.right).toBeGreaterThan(0);
    expect(gains.left).toBeGreaterThan(0);
    expect(gains.right).toBeLessThanOrEqual(460-wide.rightSize);
    expect(gains.left).toBeLessThanOrEqual(420-wide.leftSize);
  });
  it('狭幅では右の取り分を 0 にする（保存値を太らせない）',()=>{
    const gains=fitPanelGains({...wide,narrow:true});
    expect(gains.right).toBe(0);
    expect(gains.left).toBeGreaterThan(0);   // 左が開いているぶんは従来どおり配る
  });
  it('畳んでいる・隠している側には配らない',()=>{
    expect(fitPanelGains({...wide,rightHidden:true}).right).toBe(0);
    expect(fitPanelGains({...wide,leftCollapsed:true}).left).toBe(0);
    expect(fitPanelGains({...wide,space:0}).right).toBe(0);
  });
});
