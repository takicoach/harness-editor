export interface NativeViewState {
  mode: 'review' | 'edit' | 'finish'; tab: 'video' | 'image' | 'bgm' | 'se'; frame: number; selected: string[];
  zoom: number; left: number; right: number; bottom: number; leftHidden: boolean; rightHidden: boolean;
  /** 「詰める」（リップル）トグル。既定 ON（設計 §6）。 */
  ripple: boolean;
  /** タイムライン行の高さを自動（窓の 34%・F1）にするか。ドラッグで決めたら false。 */
  bottomAuto: boolean;
  /** 調整タブの群の開閉。鍵は `${kind}:${group}`（F14）。 */
  inspectorOpen: Record<string, boolean>;
  activeCutId?: string | null;
}
const defaults: NativeViewState = {mode:'edit',tab:'video',frame:0,selected:[],zoom:1.5,left:248,right:296,bottom:280,bottomAuto:true,inspectorOpen:{},leftHidden:false,rightHidden:false,ripple:true};
/** 旧 tab 値（T…〜B 以前）の移行表。ここに無い値はすべて 'video' に落とす。 */
const LEGACY_TABS: Record<string, NativeViewState['tab']> = {assets:'video', music:'bgm', transcript:'video', captions:'video', script:'video'};
const key = (project: string) => `harness-native-view:${project}`;
export function readNativeView(project: string): NativeViewState {
  const fallback = { ...defaults, selected:[] };
  try {
    const raw = sessionStorage.getItem(key(project)); if (!raw || raw.length > 16384) return fallback;
    const value = JSON.parse(raw); if (!value || typeof value !== 'object') return fallback;
    const number = (name: 'frame' | 'zoom' | 'left' | 'right' | 'bottom', min: number, max: number) => typeof value[name] === 'number' && Number.isFinite(value[name]) ? Math.max(min,Math.min(max,value[name])) : defaults[name];
    return {mode:['review','edit','finish'].includes(value.mode) ? value.mode : 'edit',tab:((['video','image','bgm','se'].includes(value.tab) ? value.tab : LEGACY_TABS[String(value.tab)] ?? 'video') as NativeViewState['tab']),
      frame:Math.round(number('frame',0,Number.MAX_SAFE_INTEGER)),zoom:number('zoom',.01,12),
      activeCutId:typeof value.activeCutId==='string'&&value.activeCutId.length<=256?value.activeCutId:null,
      left:number('left',190,420),right:number('right',240,460),bottom:number('bottom',170,Math.max(170,window.innerHeight*.6)),
      ripple: value.ripple === false ? false : true,   // 未保存・不正値は ON（設計の既定）
      // 旧データ（bottomAuto を持たない）に保存済みの bottom があるなら、ユーザーがドラッグで決めた高さ。
      // 既定 true のままだと、その高さを 1 回だけ自動（窓の 34%）で上書きして捨てる（M-1）。
      bottomAuto: value.bottomAuto === false ? false : typeof value.bottom === 'number' && Number.isFinite(value.bottom) ? false : true,
      inspectorOpen: value.inspectorOpen && typeof value.inspectorOpen === 'object' ? Object.fromEntries(Object.entries(value.inspectorOpen).filter(([k, v]) => k.length <= 48 && typeof v === 'boolean').slice(0, 64)) as Record<string, boolean> : {},
      leftHidden:value.leftHidden === true,rightHidden:value.rightHidden === true,selected:Array.isArray(value.selected) ? value.selected.filter((id:unknown) => typeof id === 'string').slice(0,128) : []};
  } catch { return fallback; }
}
export function writeNativeView(project: string, view: NativeViewState): void {
  try { sessionStorage.setItem(key(project),JSON.stringify(view)); } catch { /* Editing data is persisted separately on the server. */ }
}
