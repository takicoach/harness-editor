/** 遅い媒体の素材のコピーの、画面とサーバで共通の型と文言。 */
export interface CopyTimeRange {minSeconds:number;maxSeconds:number}
export const formatGigabytes=(bytes:number)=>(bytes/1024**3).toFixed(1);
/**
 * 0.1GB 単位の丸め（GB は 1024³ バイト）。足りない側（空き・コピー後の空き）は切り捨て、余裕・コピーする量は切り上げて見せる
 * （同じ値に見えて「下回ります」と矛盾しないように。サーバの理由の文 space.ts と画面で同じ関数を使う）。
 */
export const floorGigabytes=(bytes:number)=>(Math.floor(Math.max(0,bytes)*10/1024**3)/10).toFixed(1);
export const ceilGigabytes=(bytes:number)=>(Math.ceil(bytes*10/1024**3)/10).toFixed(1);
/** コピー先の選択の空き・容量のそばに出す注記（Task 3 のレビュー）。 */
export const COPY_GB_NOTE='GB は 1024³ バイト単位で数えるため、Finder の空き表示より少なく出ることがあります（安全側）';
export const formatMinutes=(seconds:number)=>Math.max(1,Math.ceil(seconds/60));
export type CopyDestinationKind='internal'|'volume'|'custom';
/** 候補の空き（設計 §4）。空き・容量・コピー後に残る空き・安全余裕（バイト）。 */
export interface CopyDestinationSpace {free:number;capacity:number;after:number;margin:number}
/**
 * コピー先の候補（設計 §3・§4）。画面に要るものだけ（置き場所の絶対パスは渡さない。key が 'internal'・'volume:<UUID>'・'custom'）。
 * volume は選んだ時点の識別（開始時に同じかを確かめる）。場所のドライブを識別できない・ネットワークの場所は uuid が空・dev が -1（ネットワークの識別には利用者名が入りうる）。
 * note は行に添える注記（取り外し可能な媒体の COPY_REMOVABLE_NOTE）。
 * space は空きを測る前に断った候補（場所の確認・ネットワーク・書き込めない・元と同じドライブ・測れない）では null。time は所要時間の幅（元の速さが分からなければ null）。
 */
export interface CopyDestinationView {key:string;label:string;volume:{uuid:string;dev:number};space:CopyDestinationSpace|null;selectable:boolean;reason?:string;time:CopyTimeRange|null;recommended?:boolean;note?:string}
/** 取り外し可能な媒体（SD カード）の候補の行に添える注記（2026-10-08 承認の文言）。その候補は最後に回し、勧めない。 */
export const COPY_REMOVABLE_NOTE='SD カードは書き込みが遅いことがあります';
export interface CopyDestinationRequest {key:string;uuid:string;dev:number;customPath?:string}
/** canRemember:false はドライブの識別（UUID）を読めない素材: 「この接続先では今後出さない」を記録できない（画面はその操作を出さない）。 */
export interface SlowMediaAdviceTarget {assetId:string;name:string;sizeBytes:number;seconds:number;canRemember?:false}
/** 1回のコピーで扱える素材の数（窓口・作業・取り込みの束と同じ。ジョブ記録の大きさの上限もこの本数で見積もっている）。 */
export const MAX_COPY_ITEMS=50;
/**
 * 開いた時の案内（設計 §1・§2）。targets は照合に 60 秒以上かかる見込みの素材（seconds は切り上げ）、unmeasured はまだ読み取りの速さを測れていない素材の数。
 * more は画面が付ける: 1回のコピーの上限を超えて今回は並べない素材の数（並べた分を判断すると次の分が出る）。
 */
export interface SlowMediaAdvice {targets:SlowMediaAdviceTarget[];totalBytes:number;totalSeconds:number;unmeasured:number;more?:number}
/** 作業の各項目の段（設計 §5）。named は「名前を確定済み」（画面では「コピーを確認中」に含める）。 */
export const COPY_ITEM_PHASES=['waiting','copying','verifying','named','connecting','done','failed','cancelled'] as const;
export type CopyItemPhase=typeof COPY_ITEM_PHASES[number];
/** finished: 全項目が終わった。stopped: 残りを中止・失敗で止めた・アプリの終了で止まった。waiting-volume: コピー先のドライブの接続を待って回収する。 */
export type CopyJobState='running'|'finished'|'stopped'|'waiting-volume';
export interface CopyJobItemView {itemId:string;name:string;sizeBytes:number;phase:CopyItemPhase;bytesDone:number;assetId?:string;batchItem?:{batchId:string;itemId:string};error?:string}
/**
 * kept: 自分のものと確かめられず、消さずに残したファイル名（名前だけでは消さない）。
 * notThisProcess: このエディター（サーバのプロセス）が動かしている作業ではない（別のエディターの作業・持ち主を確かめられずに回収を待つ前回の作業）。
 * 画面は進み具合と「残りを中止」を出さず（中止できない）、その素材をコピー中として扱わない。サーバは 15 秒ごとに回収をやり直す。
 */
export interface CopyJobView {jobId:string;projectId:string;mode:'reconnect'|'add';state:CopyJobState;createdAt:string;destination:{kind:CopyDestinationKind;label:string};
  stopReason?:string;kept?:string[];notThisProcess?:true;items:CopyJobItemView[];current?:{index:number;bytesPerSecond?:number;remaining?:CopyTimeRange}}
export const COPY_PHASE_LABEL:Record<CopyItemPhase,string>={waiting:'待ち',copying:'コピー中',verifying:'コピーを確認中',named:'コピーを確認中',connecting:'接続を変更中',done:'完了',failed:'失敗',cancelled:'中止'};
export const COPY_DRIVE_WARNING='コピーが終わるまで、元の媒体とコピー先のドライブを取り外さないでください';
export const COPY_SPACE_NOTE='空きは1GBごと・5秒ごとに確かめますが、ほかのアプリが同時に書き込む分までは保証できません';
export const COPY_CANCEL_NOTE='完了した素材はコピー先につなぎ替えたまま残します';
/** このエディターが動かしていない作業（notThisProcess）の注記。 */
export const COPY_ELSEWHERE_NOTE='このコピーは別のエディターか、前回の起動のものです（ここからは中止できません）。終わったことを確かめられ次第、途中のファイルを片付けます';
export const COPY_WAITING_VOLUME_NOTE='コピー先のドライブが接続されていません。接続すると、途中のファイルを片付けます';
/** まだ元の媒体が要る素材（接続を変えていない）。 */
export const stillNeedsSource=(item:CopyJobItemView)=>item.phase!=='done';
