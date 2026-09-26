import {z} from 'zod';

const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const frame=z.number().int().nonnegative().safe(),positiveFrame=frame.min(1);
const signedFrame=z.number().int().safe();
const text=z.string().min(1).max(10000).refine(value=>!!value.trim(),'本文を指定してください');
const ids=z.array(id).min(1).max(100).refine(values=>new Set(values).size===values.length,'対象IDが重複しています');
const time=z.object({num:frame,den:positiveFrame}).strict();
const rate=z.object({num:positiveFrame,den:positiveFrame}).strict();
const range=z.object({startFrame:frame,endFrame:positiveFrame}).strict().refine(v=>v.endFrame>v.startFrame,'範囲が逆転しています');
const finite=z.number().finite();
const position=z.object({x:finite.min(-1).max(1),y:finite.min(-1).max(1)}).strict();
const layout=z.object({position:position.optional(),scale:finite.min(.1).max(5).optional(),rotation:finite.min(-180).max(180).optional(),flipH:z.boolean().optional(),flipV:z.boolean().optional(),background:z.string().min(1).max(128).optional()}).strict();
const gradeValue=finite.min(-100).max(100);
const colorGrade=z.object({brightness:gradeValue.optional(),contrast:gradeValue.optional(),saturation:gradeValue.optional(),temperature:gradeValue.optional()}).strict();
const appearance=z.object({fontFamily:z.string().min(1).max(500).optional(),fontSize:finite.positive().max(1000).optional(),fontWeight:finite.int().min(1).max(1000).optional(),color:z.string().min(1).max(128).optional(),strokeColor:z.string().min(1).max(128).optional(),strokeWidth:finite.min(0).max(100).optional(),background:z.string().min(1).max(128).optional(),align:z.enum(['left','center','right']).optional(),lineHeight:finite.positive().max(10).optional(),letterSpacing:finite.min(-100).max(100).optional()}).strict();
const audioSettings=z.object({gainDb:finite.min(-60).max(12).optional(),muted:z.boolean().optional(),fadeInFrames:frame.optional(),fadeOutFrames:frame.optional()}).strict();
const linked={linked:z.boolean().default(true)};

/** A closed set of editing intentions, not an arbitrary SequenceCommand/clip/asset JSON API.
 * All ordinary frames are completion frames; restore ranges are saved-band local frames.
 * Source times/rates are exact Rational values. No nested batch or metadata replacement. */
export const nativeEditorCommandSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('ripple-delete'),startFrame:frame,endFrame:positiveFrame}).strict(),
 z.object({type:z.literal('restore-cut'),entryId:id,range:range.optional(),atFrame:frame.optional()}).strict(),
 z.object({type:z.literal('resize-cut-boundary'),cut:z.object({kind:z.enum(['entry','group']),id}).strict(),edge:z.enum(['start','end']),target:z.discriminatedUnion('kind',[
  z.object({kind:z.literal('archived'),entryId:id,localFrame:frame}).strict(),z.object({kind:z.literal('live'),clipId:id,frame}).strict(),
 ])}).strict(),
 z.object({type:z.literal('move'),clipIds:ids,deltaFrames:signedFrame,trackId:id.optional(),...linked}).strict(),
 z.object({type:z.literal('trim'),clipId:id,edge:z.enum(['start','end']),frame,...linked}).strict(),
 z.object({type:z.literal('split'),clipIds:ids,frame,...linked}).strict(),
 z.object({type:z.literal('delete'),clipIds:ids,...linked}).strict(),
 z.object({type:z.literal('unlink'),clipIds:ids}).strict(),
 z.object({type:z.literal('fill-cut-captions'),templateClipId:id}).strict(),
 z.object({type:z.literal('split-caption'),clipId:id,frame,leftText:text,rightText:text}).strict(),
 z.object({type:z.literal('merge-captions'),firstClipId:id,secondClipId:id}).strict(),
 z.object({type:z.literal('set-caption-text'),clipId:id,text}).strict(),
 z.object({type:z.literal('set-track-enabled'),trackId:id,enabled:z.boolean()}).strict(),
 z.object({type:z.literal('move-track'),trackId:id,index:frame}).strict(),
 z.object({type:z.literal('add-track'),track:z.object({id,kind:z.enum(['visual','audio']),name:z.string().min(1).max(256),enabled:z.boolean().default(true)}).strict(),index:frame.optional()}).strict(),
 z.object({type:z.literal('remove-track'),trackId:id}).strict(),
 z.object({type:z.literal('insert-media'),assetId:id,kind:z.enum(['video','audio','image']),trackId:id,startFrame:frame,durationFrames:positiveFrame.optional(),
  sourceIn:time.optional(),rate:rate.optional(),videoStreamIndex:frame.optional(),audioStreamIndex:frame.optional(),withAudio:z.boolean().optional(),audioTrackId:id.optional(),role:z.enum(['speech','music','effect']).optional(),loop:z.boolean().optional()}).strict(),
 z.object({type:z.literal('insert-caption'),trackId:id,startFrame:frame,durationFrames:positiveFrame,text,appearance:appearance.optional()}).strict(),
 z.object({type:z.literal('update-clip-visual'),clipId:id,patch:z.object({layout:layout.optional(),opacity:finite.min(0).max(1).optional(),colorGrade:colorGrade.optional(),lut:z.object({assetId:id,intensity:finite.min(0).max(1)}).strict().nullable().optional()}).strict().refine(p=>Object.keys(p).length>0,'変更を指定してください')}).strict(),
 z.object({type:z.literal('update-clip-audio'),clipId:id,settings:audioSettings.refine(p=>Object.keys(p).length>0,'変更を指定してください')}).strict(),
]);
export const nativeEditorEditSchema=z.object({documentId:id,commands:z.array(nativeEditorCommandSchema).min(1).max(50)}).strict();
export type NativeEditorEdit=z.infer<typeof nativeEditorEditSchema>;
export type NativeEditorCommand=NativeEditorEdit['commands'][number];
export const NATIVE_EDITOR_COMMAND_TYPES=nativeEditorCommandSchema.options.map(option=>option.shape.type.value);
