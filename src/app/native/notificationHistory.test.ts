import {expect,it} from 'vitest';
import {appendNotification,emptyNotificationHistory,readNotificationHistory,nativeCutRateWarning} from './notificationHistory';
import type {SequenceDocument} from '../../core/sequence/model';
import {applySequenceCommand} from '../../core/sequence/commands';
it('persists notifications, aggregates repeats, keeps dismissal separate and bounds retained messages',()=>{
 let history=appendNotification(emptyNotificationHistory(),{severity:'error',source:'プレビュー',message:'復号タイムアウト',frame:600},10);
 history.seenAt=11;
 history=appendNotification(history,{severity:'error',source:'プレビュー',message:'復号タイムアウト',frame:900},12);
 expect(history.records).toHaveLength(1);expect(history.records[0]).toMatchObject({firstAt:10,lastAt:12,count:2,frame:900});
 expect(readNotificationHistory(JSON.stringify(history))).toEqual(history);
 for(let i=0;i<210;i++)history=appendNotification(history,{severity:'warning',source:'test',message:String(i)},i+20);
 expect(history.records).toHaveLength(200);expect(readNotificationHistory('broken')).toEqual(emptyNotificationHistory());
});
it('warns on recorded cuts over 50%, using source coverage rather than playback speed',()=>{
 const r=(num:number)=>({num,den:1});
 const doc:SequenceDocument={schemaVersion:2,id:'case',name:'case',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:300,background:'#000',ducking:{enabled:false,strength:'mid'},transitions:[],transcripts:[],
 assets:[{id:'media',kind:'media',name:'a',file:'a.mp4',fingerprint:'a',streams:[{index:0,kind:'video',codec:'h264',duration:r(10),frameRate:r(30),width:320,height:180}]}],
 tracks:[{id:'v',kind:'visual',name:'video',enabled:true}],clips:[{id:'clip',trackId:'v',name:'v',startFrame:0,durationFrames:300,clock:{offset:r(0),rate:r(1),duration:r(300)},content:{kind:'video',assetId:'media',streamIndex:0,sourceIn:r(0),rate:r(1)}}]};
 expect(nativeCutRateWarning(doc)).toBeNull();
 const cut=applySequenceCommand(doc,{type:'ripple-delete',startFrame:30,endFrame:240});
 expect(nativeCutRateWarning(cut)).toContain('70%');
 const restored=applySequenceCommand(cut,{type:'restore-cut',entryId:cut.cutArchive!.entries[0]!.id});
 expect(nativeCutRateWarning(restored)).toBeNull();
});
