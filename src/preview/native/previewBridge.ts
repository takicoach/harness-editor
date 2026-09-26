import type { ScenePlan } from '../../core/sequence/scenePlan';
import { serializeSequence } from '../../core/sequence/validate';
import type {RenderedSceneGeometry} from './renderGeometry';
import { previewFailure } from './previewError';
import type { LegacyMeasurementRequest, LegacyMeasurementDisplaySnapshot } from './legacyMeasurement';

// The iframe sends serializable metadata. Restore Error identity in the parent
// realm so existing manipulation errors keep their actionable message.
function parentError(error: unknown): Error {
  const failure = previewFailure(error);
  return Object.assign(new Error(failure.message), failure);
}

/** Preview and export use the same page/viewport, isolated from editor DOM/CSS. */
export class NativePreviewBridge {
  private frame = document.createElement('iframe');
  private ready!: Promise<void>;
  private disposed = false;
  private previousPlan?: ScenePlan;
  private serialized = '';
  constructor(private readonly container: HTMLElement, private readonly projectId: string, private readonly legacyContext?: string) {
    this.mount();
  }
  private mount(): void {
    this.frame = document.createElement('iframe');
    this.frame.dataset.nativePreview = 'true'; this.frame.title = '映像プレビュー'; this.frame.tabIndex = -1;
    this.frame.style.cssText = 'border:0;display:block;pointer-events:none';
    this.frame.src = `/native-render.html?${new URLSearchParams({ id: this.projectId, preview: '1', ...(this.legacyContext ? { legacyContext: this.legacyContext } : {}) })}`;
    this.container.appendChild(this.frame);
    this.ready = new Promise((resolve, reject) => {
      const deadline = performance.now() + 30000;
      const check = () => {
        if (this.disposed) { reject(new Error('プレビューは閉じられています')); return; }
        const view = this.frame.contentWindow;
        if (view?.harnessNativeError) { reject(parentError(view.harnessNativeFailure ?? new Error(view.harnessNativeError))); return; }
        if (view?.harnessNativeReady) { resolve(); return; }
        if (performance.now() > deadline) { reject(new Error('プレビューの起動がタイムアウトしました')); return; }
        setTimeout(check, 20);
      };
      check();
    });
    void this.ready.catch(() => undefined);
  }
  /** iframe を作り直す。フレームと再生状態の復元は呼び出し元（NativePreview）が行う。 */
  async reload():Promise<void>{
    if(this.disposed)throw new Error('プレビューは閉じられています');
    const old=this.frame;
    old.contentWindow?.harnessNativeDispose?.();old.remove();
    this.previousPlan=undefined;this.serialized='';
    this.mount();
    await this.ready;
  }
  async render(plan: ScenePlan, frame: number, bypass: boolean, isCurrent: () => boolean): Promise<RenderedSceneGeometry|undefined> {
    const {width,height}=plan.document.resolution;
    this.frame.width=String(width);this.frame.height=String(height);this.container.style.width=`${width}px`;this.container.style.height=`${height}px`;
    await this.ready; if (!isCurrent() || this.disposed) return;
    if (this.previousPlan !== plan) { this.previousPlan = plan; this.serialized = serializeSequence(plan.document); }
    let geometry: RenderedSceneGeometry | null;
    try { geometry=await this.frame.contentWindow!.harnessNativePreviewFrame!(this.serialized, frame, bypass, isCurrent); }
    catch (error) { throw parentError(error); }
    if (!isCurrent() || this.disposed) return;
    this.frame.dataset.nativeFrame=String(frame);this.frame.dataset.nativeRevision=String(plan.document.revision);this.frame.dataset.nativeLutBypass=String(bypass);
    return geometry??undefined;
  }
  measureLegacy(request:LegacyMeasurementRequest):LegacyMeasurementDisplaySnapshot|null {
    if(this.disposed)return null;
    try {
      const measured=this.frame.contentWindow?.harnessNativeMeasureLegacy?.(request);
      if(!measured)return null;
      const {left,top,width,height}=this.frame.getBoundingClientRect();
      return {...measured,viewport:{left,top,width,height}};
    }
    catch(error){throw parentError(error);}
  }
  clear():void { this.frame.contentWindow?.harnessNativeClear?.();delete this.frame.dataset.nativeFrame; }
  dispose():void { this.disposed=true;this.frame.contentWindow?.harnessNativeDispose?.();this.frame.remove(); }
}
