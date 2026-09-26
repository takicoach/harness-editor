import {useFilmstripFrames} from '../timeline/useFilmstrip';
import {filmstripPresentation,type NativeFilmstripInput} from './filmstripPresentation';

export type NativeFilmstripProps=NativeFilmstripInput;

/** Decorative source thumbnails inside an existing clip; never an interactive overlay or another timeline. */
export function NativeFilmstrip(props:NativeFilmstripProps){
 const view=filmstripPresentation(props);
 const frames=useFilmstripFrames(view.ok&&view.cells.length?view.url:null,view.ok?view.totalFrames:0,
  view.ok?view.cells.map(cell=>cell.frame):[],view.ok?{sourceFps:view.sourceFps,ownerKey:view.ownerKey}:undefined);
 const images=new Map(frames.map(frame=>[frame.frame,frame.url]));
 return <div aria-hidden="true" data-native-filmstrip={!view.ok?view.reason:view.cells.length===0?'outside':frames.length?'ready':'loading'}
  style={{position:'absolute',inset:0,overflow:'hidden',pointerEvents:'none'}}>
  {view.ok&&view.cells.map((cell,index)=>{const url=images.get(cell.frame);return url?<img key={`${view.ownerKey}:${index}:${cell.frame}`} src={url} alt="" draggable={false}
    style={{position:'absolute',top:0,left:cell.left,width:cell.width,height:'100%',objectFit:'cover',opacity:.65}}/>:null;})}
 </div>;
}
