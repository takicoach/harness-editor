import {expect,it} from 'vitest';
import {nativeEditorEditSchema,NATIVE_EDITOR_COMMAND_TYPES} from './nativeEditorCommands';
const request=(command:unknown)=>({documentId:'doc',commands:[command]});
it('bounds instructions at 50 and rejects nested batches and unknown metadata',()=>{
 const c={type:'delete',clipIds:['clip']};expect(nativeEditorEditSchema.parse({documentId:'doc',commands:Array(50).fill(c)}).commands).toHaveLength(50);
 for(const commands of [[],Array(51).fill(c),[{type:'batch',commands:[c]}],[{...c,speed:{}}]])expect(()=>nativeEditorEditSchema.parse({documentId:'doc',commands})).toThrow();
 expect(()=>nativeEditorEditSchema.parse({...request(c),revision:1})).toThrow();
});
it.each(['move','trim','split','delete'])('uses linked=true by default for %s and retains deliberate false',type=>{
 const c=type==='move'?{type,clipIds:['clip'],deltaFrames:1}:type==='trim'?{type,clipId:'clip',edge:'start',frame:1}:type==='split'?{type,clipIds:['clip'],frame:1}:{type,clipIds:['clip']};
 expect(nativeEditorEditSchema.parse(request(c)).commands[0]).toMatchObject({linked:true});
 expect(nativeEditorEditSchema.parse(request({...c,linked:false})).commands[0]).toMatchObject({linked:false});
});
it.each(['file','path','content','clock','speed','continuationGroupId'])('does not accept %s in a media insertion',field=>{
 expect(()=>nativeEditorEditSchema.parse(request({type:'insert-media',assetId:'asset',kind:'video',trackId:'v',startFrame:0,[field]:'untrusted'}))).toThrow();
});
it('rejects JSON patch, code/component registration, speed mutation and document replacement',()=>{
 for(const c of [{type:'update-clip',clipId:'x',patch:{content:{}}},{type:'register-assets',assets:[]},{type:'set-native-global-speed',rate:{num:2,den:1}},{type:'replace-document',document:{}}])expect(()=>nativeEditorEditSchema.parse(request(c))).toThrow();
});
it('rejects fractional timeline frames, invalid rates, duplicate owners and out-of-range settings',()=>{
 for(const c of [{type:'move',clipIds:['x'],deltaFrames:.5},{type:'split',clipIds:['x','x'],frame:1},{type:'insert-media',assetId:'a',kind:'audio',trackId:'t',startFrame:0,rate:{num:0,den:1}},{type:'update-clip-audio',clipId:'x',settings:{gainDb:13}},{type:'update-clip-visual',clipId:'x',patch:{opacity:NaN}},{type:'update-clip-visual',clipId:'x',patch:{keyframeClock:{}}}])expect(()=>nativeEditorEditSchema.parse(request(c))).toThrow();
});
it('keeps exact source fractions and discriminates archived-local from live-completion cut coordinates',()=>{
 const c={type:'insert-media',assetId:'a',kind:'audio',trackId:'t',startFrame:0,sourceIn:{num:1001,den:60000},rate:{num:3,den:2}};
 expect(nativeEditorEditSchema.parse(request(c)).commands[0]).toEqual(c);
 const resize={type:'resize-cut-boundary',cut:{kind:'entry',id:'cut'},edge:'end',target:{kind:'archived',entryId:'cut',localFrame:3}};
 expect(nativeEditorEditSchema.parse(request(resize)).commands[0]).toEqual(resize);
 expect(()=>nativeEditorEditSchema.parse(request({...resize,target:{kind:'archived',clipId:'clip',frame:3}}))).toThrow();
});
it('exports the actual unique schema operation names for capabilities',()=>{
 expect(new Set(NATIVE_EDITOR_COMMAND_TYPES).size).toBe(NATIVE_EDITOR_COMMAND_TYPES.length);
 expect(NATIVE_EDITOR_COMMAND_TYPES).toEqual(['ripple-delete','restore-cut','resize-cut-boundary','move','trim','split','delete','unlink','fill-cut-captions','split-caption','merge-captions','set-caption-text','set-track-enabled','move-track','add-track','remove-track','insert-media','insert-caption','update-clip-visual','update-clip-audio']);
});
