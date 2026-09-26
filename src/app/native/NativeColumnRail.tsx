import {Icon,type IconName} from '../Icon';

export interface RailItem {value:string;label:string;icon:IconName}
interface Props {side:'left'|'right';items:ReadonlyArray<RailItem>;onExpand(value?:string):void}

/**
 * 畳んだカラムの跡に残る 36px のレール（R2-F2 A）: 開くボタン＋タブごとのアイコン。
 * 名前は吹き出し（data-tip）で出す。縦組みの文字（writing-mode）は使わない（ユーザー指示 2026-09-21）。
 * aria-controls は付けない: 畳んでいる間は対象パネルが DOM に無い（旧実装と同じ判断）。
 */
export function NativeColumnRail({side,items,onExpand}:Props){
  const open=`${side==='left'?'左':'右'}パネルを開く`,tipSide=side==='left'?'right':'left';
  return <div className={`native-column-rail native-column-rail-${side}`}>
    <button type="button" className="btn-ghost native-column-rail-open" aria-expanded={false} aria-label={open} data-tip={open} data-tip-side={tipSide} onClick={()=>onExpand()}><Icon name={side==='left'?'chevron-right':'chevron-left'} size={14} strokeWidth={2.75}/></button>
    {items.map(item=><button key={item.value} type="button" className="btn-ghost native-column-rail-item" aria-label={`${item.label}を開く`} data-tip={item.label} data-tip-side={tipSide} onClick={()=>onExpand(item.value)}><Icon name={item.icon} size={16}/></button>)}
  </div>;
}
