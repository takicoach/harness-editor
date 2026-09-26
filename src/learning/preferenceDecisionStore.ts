import path from 'node:path';
import { globalStoreDir } from './paths';
import { appendDecisionEvent, emptyDecisionLedger, parseDecisionLedger, type DecisionLedger } from './preferenceDecisions';
import { readPreferenceFile, updatePreferenceFile } from './atomicPreferenceFile';

/** 同期APIはサーバのイベントループ内で直列実行。別プロセスとの競合は排他ディレクトリで拒否する。 */
export class PreferenceDecisionStore {
  readonly file: string;
  constructor(readonly directory = globalStoreDir()) {
    this.file = path.join(directory, 'preference-decisions.v1.json');
  }

  read(): DecisionLedger {
    return readPreferenceFile(this.file, parseDecisionLedger, emptyDecisionLedger);
  }

  append(event: unknown): DecisionLedger {
    return this.mutate((current) => appendDecisionEvent(current, event));
  }

  /** インポートは追記として統合。既存IDの異なる内容や未知版は全件を拒否する。 */
  import(input: unknown): DecisionLedger {
    const incoming = parseDecisionLedger(input);
    return this.mutate((current) => incoming.events.reduce<DecisionLedger>(
      (ledger, event) => appendDecisionEvent(ledger, event), current,
    ));
  }

  export(): string {
    return `${JSON.stringify(this.read(), null, 2)}\n`;
  }

  private mutate(update: (current: DecisionLedger) => DecisionLedger): DecisionLedger {
    return updatePreferenceFile(this.file, () => this.read(), update);
  }
}
