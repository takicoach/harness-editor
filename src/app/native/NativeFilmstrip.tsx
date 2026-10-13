import {thumbTimeKey} from './frameThumbnails';
import {useFrameThumbnails} from './useFrameThumbnails';
import {filmstripPresentation,type NativeFilmstripInput} from './filmstripPresentation';

export type NativeFilmstripProps=NativeFilmstripInput&{
 /** ドラッグ中: 新しく取りに行かず、取得済みのコマを近い時刻で並べ替えて出す（設計 §2-1）。 */frozen?:boolean;
 /** 最初のプレビューの絵が出るまで: 取りに行かない（設計 §2-1「取得の開始」）。 */held?:boolean};

/** Decorative source thumbnails inside an existing clip; never an interactive overlay or another timeline. */
export function NativeFilmstrip({frozen=false,held=false,...props}:NativeFilmstripProps){
 const view=filmstripPresentation(props),cells=view.ok?view.cells:[];
 const images=useFrameThumbnails(view.ok&&cells.length?{projectId:props.projectId,...view.source}:null,cells.map(cell=>cell.time),frozen,held,props.document.revision);
 const shown=cells.filter(cell=>images.has(thumbTimeKey(cell.time))).length;
 return <div aria-hidden="true" data-native-filmstrip={!view.ok?view.reason:cells.length===0?'outside':shown===cells.length?'ready':held&&!frozen?'held':'loading'}
  style={{position:'absolute',inset:0,overflow:'hidden',pointerEvents:'none'}}>
  {view.ok&&cells.map((cell,index)=>{const key=thumbTimeKey(cell.time),url=images.get(key);return url?<img key={`${view.ownerKey}:${index}:${key}`} src={url} alt="" draggable={false} data-native-filmstrip-time={key}
    style={{position:'absolute',top:0,left:cell.left,width:cell.width,height:'100%',objectFit:'cover',opacity:.65}}/>:null;})}
 </div>;
}
