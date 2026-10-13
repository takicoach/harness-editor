import {afterAll,beforeAll,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {rational as r} from '../../core/sequence/time';
import {createSequenceProject} from './create';
import {SequenceStore} from './store';
import {framePresentationIndex} from './framePresentation';
import {prepareSequenceFrames} from './frameImages';
import {makeFrameNumberVideos,readFrameNumber,type FrameNumberVideos} from './__fixtures__/frameNumberVideos';
let media:string,root:string,videos:FrameNumberVideos;
beforeAll(async()=>{media=await mkdtemp(join(tmpdir(),'harness-frames-all-media-'));root=await mkdtemp(join(tmpdir(),'harness-frames-all-'));videos=makeFrameNumberVideos(media);},60000);
afterAll(async()=>{await rm(media,{recursive:true,force:true});await rm(root,{recursive:true,force:true});});
it('every frame through prepareSequenceFrames: the burned-in number is the indexed frame',async()=>{
  const report:string[]=[];
  for(const [name,file,stream,first] of [['cfr2997',videos.cfr2997,0,0],['editList',videos.editList,0,44],['vfr',videos.vfr,0,0],['twoStreams-1',videos.twoStreams,1,1000],['offsetAudio',videos.offsetAudio,0,0]] as const){
    const {id}=await createSequenceProject(root,{name,videoName:'source.mp4',sourcePath:file}),directory=join(root,id);
    const asset=new SequenceStore(directory).load()!.document.assets.find(a=>a.streams.some(s=>s.kind==='video'))!,index=await framePresentationIndex(directory,asset,stream),wrong:string[]=[];
    for(let at=0;at<index.pts.length;at+=24){   // 待ち行列の上限を超えないよう 24 コマずつ
      const times=index.pts.slice(at,at+24).map((pts,i)=>({key:String(at+i),time:r(pts*index.timeBase.num,index.timeBase.den)}));
      const result=await prepareSequenceFrames(directory,asset,{assetId:asset.id,streamIndex:stream,height:72,times});
      for(const f of result.frames){const n=readFrameNumber(Buffer.from(f.data.slice(f.data.indexOf(',')+1),'base64'));if(f.frame!==Number(f.time)||n!==first+f.frame)wrong.push(`${f.time}→${f.frame}/${n}`);}
      wrong.push(...result.failed.map(f=>`${f.time}:${f.error}`));
    }
    report.push(`${name}: ${index.pts.length} frames, mismatches ${wrong.length}${wrong.length?` (${wrong.slice(0,5).join(' ')})`:''}`);
  }
  console.log(report.join('\n'));
  expect(report.map(line=>Number(/: (\d+) frames/.exec(line)?.[1]))).toEqual([300,256,120,120,300]);   // 全フレームを本当に通したか（空の素材は不一致 0 で素通りする）
  expect(report.filter(line=>!line.endsWith('mismatches 0'))).toEqual([]);
},900000);
