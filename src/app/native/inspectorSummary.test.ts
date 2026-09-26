import {expect,it} from 'vitest';
import {summarizeGroup} from './inspectorSummary';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';

function doc(clips:SequenceDocument['clips'],extra:Partial<SequenceDocument>={}):SequenceDocument{return {schemaVersion:2,id:'d',name:'n',revision:0,fps:r(30),
  resolution:{width:640,height:360},sequenceEndFrame:300,background:'#000',assets:[],transcripts:[],transitions:[],
  ducking:{enabled:false,strength:'mid'},tracks:[{id:'t',kind:'visual',name:'t',enabled:true}],clips,...extra};}
const clip=(id:string,content:any,visual?:any)=>({id,trackId:'t',name:id,startFrame:120,durationFrames:96,clock:{offset:r(0),rate:r(1),duration:r(96)},content,...(visual?{visual}:{})});

it('内容: 字幕の本文を 24 文字まで',()=>{
  const c=clip('a',{kind:'telop',data:{text:'まっすぐ向けない理由\n二行目',template:3}});
  expect(summarizeGroup('content',doc([c]),c)).toBe('まっすぐ向けない理由 二行目');
});
it('配置: 位置の言葉と大きさ',()=>{
  const c=clip('a',{kind:'telop',data:{text:'x',position:{x:0,y:0.6},scale:1.2}});
  expect(summarizeGroup('place',doc([c]),c)).toBe('中央下 · 120%');
  const v=clip('b',{kind:'image',assetId:'i'},{layout:{position:{x:-0.5,y:0},scale:0.8,rotation:0,flipH:false},opacity:1,keyframes:[]});
  expect(summarizeGroup('place',doc([v]),v)).toBe('左 · 80%');
});
it('時間: 開始と長さ（フレーム）',()=>{
  const c=clip('a',{kind:'telop',data:{text:'x'}});
  expect(summarizeGroup('time',doc([c]),c)).toBe('120 fr · 96 fr');
});
it('案件全体: 速度と自動音量',()=>{
  expect(summarizeGroup('project',doc([]),null)).toBe('速度 1.0× · 自動音量 OFF');
  expect(summarizeGroup('project',doc([],{ducking:{enabled:true,strength:'strong'}}),null)).toBe('速度 1.0× · 自動音量 強');
});
it('未選択の群は空文字',()=>{expect(summarizeGroup('look',doc([]),null)).toBe('');});
