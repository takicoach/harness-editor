import {expect,it} from 'vitest';
import {inspectorHeading,inspectorSections,inspectorSelectionKind,inspectorGroups,defaultGroupOpen,SECTION_GROUP,type InspectorSelectionKind} from './inspectorSections';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';

function doc(clips:SequenceDocument['clips']):SequenceDocument{return {schemaVersion:2,id:'d',name:'n',revision:0,fps:r(30),
  resolution:{width:640,height:360},sequenceEndFrame:300,background:'#000',assets:[],transcripts:[],transitions:[],
  ducking:{enabled:false,strength:'mid'},tracks:[{id:'t',kind:'visual',name:'t',enabled:true}],clips};}
const clip=(id:string,content:any)=>({id,trackId:'t',name:id,startFrame:0,durationFrames:30,clock:{offset:r(0),rate:r(1),duration:r(30)},content});

it('classifies the selection by the kind of the first selected clip',()=>{
  const d=doc([clip('a',{kind:'telop',data:{text:'x'}}),clip('b',{kind:'title',data:{text:'y'},style:{top:0,left:0,fontSize:40}})]);
  expect(inspectorSelectionKind(d,[])).toBe('none');
  expect(inspectorSelectionKind(d,['a'])).toBe('telop');
  expect(inspectorSelectionKind(d,['b'])).toBe('title');
  expect(inspectorSelectionKind(d,['a','b'])).toBe('multi');
  expect(inspectorSelectionKind(d,['missing'])).toBe('none');
});
it('gives the project sections when nothing is selected',()=>{
  expect(inspectorSections('none')).toEqual(['project-speed','project-ducking','project-audio-fix','project-transitions']);
});
it('shows the style list to a caption but never to a title',()=>{
  expect(inspectorSections('telop')).toContain('text-style-list');
  expect(inspectorSections('title')).not.toContain('text-style-list');
  expect(inspectorSections('title')).toContain('font');
});
it('gives an audio clip volume and fade, and never a style list',()=>{
  expect(inspectorSections('audio')).toEqual(['project-speed','clip-speed','audio-volume','audio-fade','timing']);
});
it('gives a shape its palette and keeps the protractor readout',()=>{
  expect(inspectorSections('shape')).toEqual(['project-speed','shape','shape-palette','angle-readout','layout','position-3x3','keyframes','timing']);
});
it('includes project-speed in every selection kind, since the speed block always shows',()=>{
  const kinds:InspectorSelectionKind[]=['none','telop','title','video','image','audio','shape','scene-fade','multi'];
  for(const kind of kinds)expect(inspectorSections(kind)).toContain('project-speed');
});
it('names the heading after the selection',()=>{
  expect(inspectorHeading('none')).toBe('案件全体');
  expect(inspectorHeading('telop','こんにちは')).toBe('字幕「こんにちは」');
  expect(inspectorHeading('multi')).toBe('複数選択');
});
it('区分ごとの群は順序固定で、案件全体は常に最後（F14）',()=>{
  expect(inspectorGroups('telop')).toEqual(['content','look','place','motion','time','project']);
  expect(inspectorGroups('video')).toEqual(['look','place','motion','time','project']);
  expect(inspectorGroups('audio')).toEqual(['look','motion','time','project']);
  expect(inspectorGroups('none')).toEqual(['project']);
  expect(inspectorGroups('multi')).toEqual(['look','place','motion','time','project']);
});
it('最初に開く群: 字幕・タイトルは内容、映像・画像は配置、音声・図形は見た目、未選択は案件全体',()=>{
  expect(defaultGroupOpen('telop','content')).toBe(true);expect(defaultGroupOpen('telop','look')).toBe(false);
  expect(defaultGroupOpen('video','place')).toBe(true);expect(defaultGroupOpen('image','place')).toBe(true);
  expect(defaultGroupOpen('audio','look')).toBe(true);expect(defaultGroupOpen('shape','look')).toBe(true);
  expect(defaultGroupOpen('none','project')).toBe(true);expect(defaultGroupOpen('telop','project')).toBe(false);
});
it('全ての節がどこかの群に属する',()=>{
  for(const kind of ['none','telop','title','video','image','audio','shape','scene-fade','multi'] as const)for(const id of inspectorSections(kind))expect(SECTION_GROUP[id],id).toBeTruthy();
});
