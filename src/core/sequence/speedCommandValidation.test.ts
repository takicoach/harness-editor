import {describe,it,expect} from 'vitest';
import {validateNativeSpeedCommand,nativeSpeedRate} from './speedCommandValidation';
const r=(num:number,den=1)=>({num,den});
const badRates=[null,false,0,'1',[],{},r(NaN),r(Infinity),r(-Infinity),r(1,0),r(1,-1),r(0),r(-1),r(.5),r(1,.5),r(Number.MAX_SAFE_INTEGER+1),r(1,Number.MAX_SAFE_INTEGER+1),r(17),r(9,100),{num:1,den:1,extra:0}];
describe('shared native speed input shape',()=>{
 it.each(badRates)('rejects rate %j before any document edit',rate=>{expect(()=>nativeSpeedRate(rate)).toThrow();expect(()=>validateNativeSpeedCommand({type:'set-native-global-speed',rate})).toThrow();});
 it.each([r(1,10),r(16),r(34,25),r(2,2)])('accepts exact supported rate %j',rate=>{expect(()=>validateNativeSpeedCommand({type:'set-native-main-speed',clipId:'main-1',rate})).not.toThrow();});
 it.each(['upgrade-native-speed','upgrade-native-speed-operations','reset-native-main-speed','set-native-main-speed','set-native-global-speed'])('rejects extra fields on %s',type=>{const value={type,...(type.includes('set-')&&!type.startsWith('reset')?{rate:r(1)}:{}),...(type.includes('main-speed')?{clipId:'main'}:{}),extra:true};expect(()=>validateNativeSpeedCommand(value)).toThrow();});
 it('rejects sparse arrays, array properties, duplicate targets and binding extras',()=>{
  const base={type:'register-native-speed',groupId:'g',mainClipIds:['v'],mainAudioBindings:[{audioClipId:'a',providerId:'v'}]};expect(()=>validateNativeSpeedCommand(base)).not.toThrow();
  const sparse=Array(2);sparse[1]='v';const extra=['v'];Object.assign(extra,{extra:true});
  for(const mainClipIds of [sparse,extra,[],['v','v'],['../v'],['v',null]])expect(()=>validateNativeSpeedCommand({...base,mainClipIds})).toThrow();
  for(const mainAudioBindings of [[...base.mainAudioBindings,...base.mainAudioBindings],[{audioClipId:'a',providerId:'missing'}],[{audioClipId:'v',providerId:'v'}],[{audioClipId:'a',providerId:'v',extra:1}]])expect(()=>validateNativeSpeedCommand({...base,mainAudioBindings})).toThrow();
 });
});
