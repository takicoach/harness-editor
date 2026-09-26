// src/app/native/NativeAiBand.tsx
interface Props {open:boolean;disabled:boolean;onOpen():void;onBack():void}

/**
 * 右カラムの頭に置く AI の帯（#7）。AI をタブの 4 つ目に埋めず、常に見える場所へ出す。
 * `aria-controls` は付けない — 畳んでいる間はパネルが DOM に無いため（`NativeColumnRail` と同じ判断）。
 * Task 8b: 帯そのものを 1 つの押せるボタンにする（ユーザー要望「タブごとボタンのように」）。
 * 閉じている間はキラキラ、開いたら（`aria-expanded=true`）落ち着いた表示に切り替わる — 見た目は CSS 側の状態セレクタで駆動する。
 */
export function NativeAiBand({open,disabled,onOpen,onBack}:Props){
  const label=open?'編集画面に戻る':'✦ AI で編集する';
  return <button type="button" className="native-ai-band" data-tutorial="ai-panel" aria-label={label} aria-expanded={open} disabled={disabled}
    onClick={()=>open?onBack():onOpen()}>
    <span className="native-ai-band-caption">AI に頼む</span>
    <span className="native-ai-band-main">{label}</span>
    <span className="native-ai-band-arrow" aria-hidden="true">{open?'←':'→'}</span>
    <span className="native-ai-band-stars" aria-hidden="true">
      <i className="native-ai-band-star"/>
      <i className="native-ai-band-star"/>
      <i className="native-ai-band-star"/>
      <i className="native-ai-band-star"/>
      <i className="native-ai-band-star"/>
    </span>
  </button>;
}
