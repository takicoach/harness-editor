/** 受付時に固定する並べ順（設計 §1）: ファイル名の自然順（0727 < 0728 < 0729、clip2 < clip10）。同じ名前は受け付けた順。 */
export const IMPORT_NAME_ORDER=new Intl.Collator('ja',{numeric:true});
export function orderByName<T>(items:readonly T[],name:(item:T)=>string):T[]{
  return items.map((item,index)=>({item,index})).sort((a,b)=>IMPORT_NAME_ORDER.compare(name(a.item),name(b.item))||a.index-b.index).map(entry=>entry.item);
}
