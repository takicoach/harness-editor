import type {ClipVisual,SequenceClip} from '../../core/sequence/model';
export type ChangeVisual=(change:(visual:ClipVisual)=>void)=>Promise<boolean>;
export type ChangeContent=<K extends SequenceClip['content']['kind']>(kind:K,change:(content:Extract<SequenceClip['content'],{kind:K}>)=>void)=>Promise<boolean>;

export interface IntentRevision {id:string;revision:number}
/** Only revisions produced by this queue may bridge a stale displayed revision. */
export class InspectorRevisionGuard {
  private chain:{id:string;start:number;end:number}|undefined;
  before(displayed:IntentRevision,current:IntentRevision){
    const chain=this.chain;
    if(displayed.id!==current.id||!(displayed.revision===current.revision||chain?.id===current.id&&displayed.revision>=chain.start&&displayed.revision<=chain.end&&current.revision===chain.end))
      throw new Error('別の編集で内容が更新されました。表示を確認してから、もう一度入力してください。');
  }
  accepted(before:IntentRevision,after:IntentRevision){
    if(before.id!==after.id||(after.revision!==before.revision&&after.revision!==before.revision+1)){
      this.chain=undefined;
      throw new Error('保存中に別の編集が入りました。表示を確認してください。');
    }
    if(this.chain?.id===before.id&&this.chain.end===before.revision)this.chain.end=after.revision;
    else this.chain={id:before.id,start:before.revision,end:after.revision};
  }
}

/** Inspector-owned commits run one at a time; each operation reads its data when it starts. */
export class InspectorIntentQueue {
  private tail:Promise<void>=Promise.resolve();
  private count=0;
  private failures=0;
  constructor(private readonly changed:(pending:number)=>void=()=>{},private readonly rejected:(error?:unknown)=>void=()=>{}){}
  get pending(){return this.count;}
  enqueue(work:()=>Promise<boolean>,reportFailure=true):Promise<boolean>{
    this.count++;
    const result=this.tail.then(work);
    this.tail=result.then(ok=>{if(!ok){this.failures++;if(reportFailure)this.rejected();}},error=>{this.failures++;if(reportFailure)this.rejected(error);}).then(()=>{this.count--;this.changed(this.count);});
    this.changed(this.count);
    return result;
  }
  async flush():Promise<boolean>{
    const before=this.failures;
    let current:Promise<void>;
    do{current=this.tail;await current;}while(current!==this.tail);
    // Already reported failures do not block a later Undo or a corrected input.
    return this.failures===before;
  }
}
