import {describe,it,expect} from 'vitest';
import {applySequenceCommand,type SequenceCommand} from './commands';
import {rational as r,compareTime} from './time';
import {type SequenceDocument,DEFAULT_TEXT_APPEARANCE,sourceTimeAt,clipEnd} from './model';
import {validateSequenceDocument,sequenceContentBytes} from './validate';
import {captionLedgers,materializeSpeedCaptions} from './speedCaptionLedger';
import {projectNativeSpeedMedia} from './speedMediaProjection';
import {DEFAULT_MAIN_LAYOUT} from '../mainLayout';
function fixture():SequenceDocument {
  return {schemaVersion:2,id:'split-test',name:'split',revision:0,fps:r(1),resolution:{width:640,height:360},sequenceEndFrame:4,background:'#000',ducking:{enabled:false,strength:'mid'},transcripts:[],
    assets:[{id:'asset',kind:'media',file:'media/test.mp4',name:'test',fingerprint:'private',streams:[{index:0,kind:'video',codec:'h264',duration:r(100),width:640,height:360,frameRate:r(1)},{index:1,kind:'audio',codec:'aac',duration:r(100),sampleRate:48000,channels:2}]}],
    tracks:[{id:'v',kind:'visual',name:'v',enabled:true},{id:'a',kind:'audio',name:'a',enabled:true},{id:'t',kind:'visual',name:'t',enabled:true}],
    clips:[{id:'video',trackId:'v',name:'video',startFrame:0,durationFrames:4,linkGroupId:'linked',clock:{offset:r(-1),rate:r(1),duration:r(20)},content:{kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(0),rate:r(2)}},
      {id:'audio',trackId:'a',name:'audio',startFrame:0,durationFrames:4,linkGroupId:'linked',clock:{offset:r(-3),rate:r(3),duration:r(40)},content:{kind:'audio',assetId:'asset',streamIndex:1,sourceIn:r(0),rate:r(2),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}},
      {id:'caption',trackId:'t',name:'caption',startFrame:1,durationFrames:2,clock:{offset:r(0),rate:r(1),duration:r(2)},content:{kind:'telop',data:{text:'保持'},appearance:{...DEFAULT_TEXT_APPEARANCE}},anchor:{kind:'source',role:'speech',sourceAssetId:'asset',clipOccurrenceId:'audio',sourceStart:r(2),sourceEnd:r(6)}}],transitions:[]};
}

function registered(input = fixture()): SequenceDocument {
  return applySequenceCommand(applySequenceCommand(input, {type:'register-native-speed',groupId:'group',mainClipIds:['video'],
    mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]}), {type:'upgrade-native-speed'});
}
// Test assembly intentionally covers the currently registered main/audio/source
// caption family only. The production command/fade/follow coordinator is pending.
function assembled(input: SequenceDocument, rate: ReturnType<typeof r>): SequenceDocument {
  const result=projectNativeSpeedMedia(input,rate), next=structuredClone(input);
  next.speed=result.speed;next.sequenceEndFrame=result.projection.sequenceEndFrame;
  const media=new Map(result.mediaClips.map(c=>[c.id,c]));
  const captionIds=new Set(captionLedgers(next).flatMap(l=>l.parts.map(p=>p.reservedRenderId)));
  next.clips=next.clips.map(c=>media.get(c.id)??c);
  const captions=new Map(materializeSpeedCaptions(next).map(c=>[c.id,c]));
  next.clips=next.clips.flatMap(c=>{
    if(!captionIds.has(c.id))return [c];
    const replacement=captions.get(c.id);captions.delete(c.id);return replacement?[replacement]:[];
  }).concat([...captions.values()]);
  validateSequenceDocument(next);return next;
}
const bytes=(d:SequenceDocument)=>sequenceContentBytes(d);

describe('saved-basis media projection for a global speed command',()=>{
  it('halves rates and doubles the literal media windows without rewriting intent or source clocks',()=>{
    const input=registered(),before=bytes(input),next=assembled(input,r(1));
    expect(next.clips.slice(0,2).map(c=>[c.id,c.startFrame,c.durationFrames,c.clock])).toEqual([
      ['video',0,8,{offset:r(-1),rate:r(1,2),duration:r(20)}],
      ['audio',0,8,{offset:r(-3),rate:r(3,2),duration:r(40)}],
    ]);
    expect(next.clips.find(c=>c.id==='caption')).toMatchObject({startFrame:2,durationFrames:4});
    expect(next.clips.map(c=>c.speed)).toEqual(input.clips.map(c=>c.speed));
    expect(next.sequenceEndFrame).toBe(8);expect(bytes(input)).toBe(before);
    expect(bytes(assembled(next,r(2)))).toBe(before);
  });
  it('evaluates shared split roots after all placements, regardless of storage order',()=>{
    const split=applySequenceCommand(registered(),{type:'split',clipIds:['video'],frame:1,linked:true});
    const reversed={...split,clips:[...split.clips].reverse()};validateSequenceDocument(reversed);
    for(const input of [split,reversed]){
      const result=projectNativeSpeedMedia(input,r(1));
      const videos=result.mediaClips.filter(c=>c.content.kind==='video').sort((a,b)=>a.startFrame-b.startFrame);
      expect(videos.map(c=>[c.startFrame,c.durationFrames,c.content.kind==='video'?c.content.sourceIn:null,c.clock])).toEqual([
        [0,2,r(0),{offset:r(-1),rate:r(1,2),duration:r(20)}],
        [2,6,r(2),{offset:r(0),rate:r(1,2),duration:r(20)}],
      ]);
    }
    expect(bytes(assembled(assembled(split,r(1)),r(2)))).toBe(bytes(split));
  });
  it('retains a virtual root after trimming and preserves non-time edits across a round trip',()=>{
    const trim=applySequenceCommand(registered(),{type:'trim',clipId:'video',edge:'start',frame:1,linked:true});
    const renamed=applySequenceCommand(trim,{type:'update-clip',clipId:'video',patch:{name:'edited name'}});
    const before=bytes(renamed),slow=assembled(renamed,r(1));
    expect(slow.clips.find(c=>c.id==='video')).toMatchObject({name:'edited name'});
    expect(bytes(assembled(slow,r(2)))).toBe(before);expect(bytes(renamed)).toBe(before);
  });
  it('keeps explicitly separated audio fixed when the remaining main video changes speed',()=>{
    const input=applySequenceCommand(registered(),{type:'unlink',clipIds:['audio']});
    const original=input.clips.find(c=>c.id==='audio')!;
    expect(original.speed?.kind).toBe('independent-audio');
    const projected=projectNativeSpeedMedia(input,r(1));
    expect(projected.mediaClips.find(c=>c.id==='audio')).toEqual(original);
    expect(projected.mediaClips.find(c=>c.id==='video')!.durationFrames).toBe(8);
  });
  it('preserves signed dedicated key clock offsets and full clock duration',()=>{
    const input=fixture();input.clips[0]!.visual={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[],keyframeClock:{offset:r(-5),rate:r(7),duration:r(40)}};
    const original=registered(input),next=assembled(original,r(1));
    expect(next.clips[0]!.visual!.keyframeClock).toEqual({offset:r(-5),rate:r(7,2),duration:r(40)});
    expect(bytes(assembled(next,r(2)))).toBe(bytes(original));
  });
  it('distinguishes retained 17-frame intent from the 17.68-frame coverage at speed1.36',()=>{
    const input=fixture();input.fps=r(30);input.sequenceEndFrame=17;input.clips=input.clips.slice(0,2);
    for(const clip of input.clips){clip.durationFrames=17;if(clip.content.kind==='video'||clip.content.kind==='audio')clip.content.rate=r(1);}
    const original=registered(input),next=assembled(original,r(34,25)),video=next.clips[0]!;
    expect(video.durationFrames).toBe(13);expect(video.speed!.source.sourceEnd).toEqual(r(17,30));
    expect(sourceTimeAt(video,clipEnd(video),next.fps)).toEqual(r(221,375));
    expect(compareTime(sourceTimeAt(video,clipEnd(video),next.fps),video.speed!.source.sourceEnd)).toBe(1);
    expect(bytes(assembled(next,r(1)))).toBe(bytes(original));
  });
  it.each([r(1,10),r(33,100),r(1,2),r(34,25),r(3),r(5),r(16)])('uses one immutable baseline for rate %j',rate=>{
    const input=fixture();input.sequenceEndFrame=160;input.clips=input.clips.slice(0,2);input.assets[0]!.streams.forEach(s=>s.duration=r(1000));
    for(const clip of input.clips)clip.durationFrames=160;
    const original=registered(input),before=bytes(original),next=assembled(original,rate);
    expect(bytes(assembled(next,r(2)))).toBe(before);expect(bytes(original)).toBe(before);
  });
  it('rejects a missing main, invalid rate and invalid input without touching the input',()=>{
    const input=registered(),before=bytes(input);
    for(const rate of [r(0),r(17),r(1,11),{num:1,den:0}])expect(()=>projectNativeSpeedMedia(input,rate)).toThrow();
    expect(bytes(input)).toBe(before);
    const empty=applySequenceCommand(input,{type:'delete',clipIds:['video'],linked:true});
    expect(()=>projectNativeSpeedMedia(empty,r(1))).toThrow(/主映像/);
    const invalid=structuredClone(input);invalid.clips[0]!.durationFrames++;const raw=JSON.stringify(invalid);
    expect(()=>projectNativeSpeedMedia(invalid,r(1))).toThrow();expect(JSON.stringify(invalid)).toBe(raw);
  });
  it('preserves an explicit override equal to the previous global value when global changes',()=>{
    const input=fixture(),second=input.clips.slice(0,2).map(c=>structuredClone(c));input.sequenceEndFrame=8;
    for(const clip of second){clip.id+='-second';clip.linkGroupId='linked-second';clip.startFrame=4;if(clip.content.kind==='video'||clip.content.kind==='audio')clip.content.sourceIn=r(8);}
    input.clips.push(...second);
    const original=applySequenceCommand(applySequenceCommand(input,{type:'register-native-speed',groupId:'group',mainClipIds:['video','video-second'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'},{audioClipId:'audio-second',providerId:'video-second'}]}),{type:'upgrade-native-speed'});
    const main=original.clips.find(c=>c.id==='video')!;if(main.speed?.kind!=='main')throw Error();main.speed.override=r(2);validateSequenceDocument(original);
    const projected=assembled(original,r(1));
    expect(projected.clips.filter(c=>c.content.kind==='video').map(c=>[c.id,c.startFrame,c.durationFrames,c.content.kind==='video'?c.content.rate:null])).toEqual([
      ['video',0,4,r(2)],['video-second',4,8,r(1)],
    ]);
    expect(projected.clips.find(c=>c.id==='video')!.speed).toEqual(main.speed);
    expect(bytes(assembled(projected,r(2)))).toBe(bytes(original));
  });
  it.each(['move','delete','ripple-delete','reorder-ranges'] as const)('round trips after %s without recapturing topology',operation=>{
    const split=applySequenceCommand(registered(),{type:'split',clipIds:['video'],frame:2,linked:true});
    const videos=split.clips.filter(c=>c.content.kind==='video').sort((a,b)=>a.startFrame-b.startFrame);
    const command:SequenceCommand=operation==='move'?{type:operation,clipIds:[videos[1]!.id],deltaFrames:3,linked:true}
      :operation==='delete'?{type:operation,clipIds:[videos[0]!.id],linked:true}
      :operation==='ripple-delete'?{type:operation,startFrame:0,endFrame:2}
      :{type:operation,ranges:[{startFrame:2,endFrame:4},{startFrame:0,endFrame:2}]};
    const input=applySequenceCommand(split,command),before=bytes(input);
    expect(bytes(assembled(assembled(input,r(1)),r(2)))).toBe(before);expect(bytes(input)).toBe(before);
  });
});
