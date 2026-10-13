import {expect,it,vi} from 'vitest';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {FRAME_REQUEST_MAX_TIMES} from '../../shared/filmstripHeight';
import {filmstripPresentation} from './filmstripPresentation';

// 表示のセル数の上限（MAX_THUMBS）を誰かが上げても、1要求の時刻の数はサーバが受ける上限（FRAME_REQUEST_MAX_TIMES）を越えない。
vi.mock('../timeline/useFilmstrip',()=>({MAX_THUMBS:40,STRIP_THUMB_PX:80}));
it('never puts more times in one filmstrip than the frames route accepts in one request',()=>{
 const document:SequenceDocument={schemaVersion:2,id:'doc',name:'映像',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:600,background:'#000',tracks:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'},
  assets:[{id:'source',kind:'media',file:'public/source.mp4',name:'原本',fingerprint:'a'.repeat(64),streams:[{index:0,kind:'video',duration:r(100),frameRate:r(30),codec:'h264'}]}],
  clips:[{id:'c',name:'映像',trackId:'v',startFrame:0,durationFrames:600,clock:{offset:r(0),rate:r(1),duration:r(600)},content:{kind:'video',assetId:'source',streamIndex:0,sourceIn:r(0),rate:r(1)}}]};
 const view=filmstripPresentation({document,projectId:'p',clip:document.clips[0]!,sourceOffsetFrames:0,displayStartFrame:0,displayDuration:600,pixelsPerFrame:100,scrollLeft:0,viewportWidth:20132});
 if(!view.ok)throw Error(view.reason);
 expect(FRAME_REQUEST_MAX_TIMES).toBe(24);expect(view.cells).toHaveLength(FRAME_REQUEST_MAX_TIMES);
});
