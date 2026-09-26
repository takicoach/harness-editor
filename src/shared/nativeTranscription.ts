export interface NativeTranscriptionStatus {
  id:string;projectId:string;executionId:string;assetId:string;assetName:string;streamIndex:number;
  phase:'queued'|'preparing'|'loading-model'|'analyzing'|'writing'|'completed'|'failed'|'cancelled';
  createdAt:string;percent?:number;wordCount?:number;excerpt?:string;error?:string;
}
export const transcriptionActive=(status:NativeTranscriptionStatus)=>!['completed','failed','cancelled'].includes(status.phase);
