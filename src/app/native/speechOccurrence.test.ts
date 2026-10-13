import {expect,it} from 'vitest';
import {fixture} from '../../core/sequence/fixtures';
import type {SequenceClip,SequenceDocument} from '../../core/sequence/model';
import {followsPlayhead,pickSpeechOccurrence} from './speechOccurrence';

/** メインの原音トラック a1 に別素材の原音を2本（0-300 と 300-360）、メイン外に b-roll の原音（0-30）。 */
const two=(secondAsset='second'):SequenceDocument=>{const d=fixture(),first=d.clips.find(c=>c.id==='audio')!,content=first.content as Extract<SequenceClip['content'],{kind:'audio'}>;
  const second:SequenceClip={...structuredClone(first),id:'audio-2',startFrame:300,durationFrames:60,linkGroupId:'linked-2',content:{...structuredClone(content),assetId:secondAsset}};
  const broll:SequenceClip={...structuredClone(first),id:'broll',trackId:'a2',startFrame:0,durationFrames:30,linkGroupId:undefined};
  return {...d,sequenceEndFrame:360,main:{videoTrackId:'v1',audioTrackId:'a1'},assets:[...d.assets,{...d.assets[0]!,id:'second',fingerprint:'test-second'}],clips:[...d.clips.filter(c=>c.id!=='music'),broll,second]};};
const pick=(doc:SequenceDocument,o:Partial<{speechId:string;selected:string[];frame:number}>)=>pickSpeechOccurrence(doc,{speechId:o.speechId??'',selected:o.selected??[],frame:o.frame??0})?.id;
it('keeps the single speech source as before',()=>{expect(pick(fixture(),{frame:999})).toBe('audio');});
it('prefers the explicit occurrence, then the selection, then the main source under the playhead, then the first main source',()=>{
  expect(pick(two(),{speechId:'audio-2'})).toBe('audio-2');
  expect(pick(two(),{selected:['broll']})).toBe('broll');
  expect(pick(two(),{frame:320})).toBe('audio-2');
  expect(pick(two(),{frame:10})).toBe('audio');
  expect(pick(two(),{frame:5000})).toBe('audio');
});
it('follows the selected clip through its link group',()=>{
  const doc=two(),video=doc.clips.find(c=>c.id==='video')!;
  expect(pickSpeechOccurrence(doc,{speechId:'',selected:['video'],selectedClip:video,frame:320})?.id).toBe('audio');
});
it('keeps one main source split into several occurrences unchosen until picked, as before',()=>{
  const doc=two('source');
  expect(pick(doc,{frame:320})).toBeUndefined();
  expect(pick(doc,{frame:10})).toBeUndefined();
  expect(pick(doc,{selected:['audio-2']})).toBe('audio-2');
});
it('prefers the main source over an earlier off-main clip under the playhead',()=>{
  const d=two(),broll=d.clips.find(c=>c.id==='broll')!,doc={...d,clips:[broll,...d.clips.filter(c=>c!==broll)]};
  expect(doc.clips[0]!.id).toBe('broll');
  expect(pick(doc,{frame:10})).toBe('audio');
});
it('skips the playhead step when no frame is given (script matching does not follow playback)',()=>{
  const at=(doc:SequenceDocument,o:{speechId?:string;selected?:string[]}={})=>pickSpeechOccurrence(doc,{speechId:o.speechId??'',selected:o.selected??[]})?.id;
  expect(at(two())).toBeUndefined();
  expect(at(two(),{speechId:'audio-2'})).toBe('audio-2');
  expect(at(two(),{selected:['broll']})).toBe('broll');
  expect(at(fixture())).toBe('audio');
});
it('follows the playhead only when the main audio holds two or more sources',()=>{
  expect(followsPlayhead(fixture())).toBe(false);
  expect(followsPlayhead(two('source'))).toBe(false);
  expect(followsPlayhead(two())).toBe(true);
});
