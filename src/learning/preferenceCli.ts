import { readFileSync } from 'node:fs';
import { PreferenceWorkspaceStore } from './preferenceWorkspaceStore';
import { evaluatePreferenceRule } from './preferenceEvaluation';
import { buildPreferenceModelInput, replayPreferenceAdapter, runPreferenceModelEvaluation } from './preferenceModelEvaluation';
import type { CliResult } from './cli';
import { join } from 'node:path';
import { EditorOperationStore } from '../server/editorOperationStore';
import { prepareScriptModelInput, compareScriptModelOutputs } from './scriptModelEvaluation';

const HELP = `構造化した好みの評価（動画・学習記録を書き換えません）

npm run --silent learn -- preferences-list --store DIR
  ルールと固定評価データのID・版を一覧します。

npm run --silent learn -- preferences-input --store DIR --rule ID --rule-version N --dataset ID --dataset-version N
  正解ラベルを除いた、生成モデルへ渡す固定入力をJSONで出力します。

npm run --silent learn -- preferences-replay --store DIR --rule ID --rule-version N --dataset ID --dataset-version N --predictions FILE --provider NAME --model NAME
  保存したモデル出力JSONを同じ実例・基準で採点し、結果をJSONで出力します。
  実モデルを呼びません。別モデル名を付けてもmodeはreplayです。

出力は標準出力をファイルへ保存できます。シェルの上書き先に注意してください。
台本判断の比較:
npm run --silent learn -- preferences-script-input --store DIR --projects-root DIR --dataset ID --dataset-version N
npm run --silent learn -- preferences-script-compare --store DIR --projects-root DIR --dataset ID --dataset-version N --predictions-a FILE --predictions-b FILE
  実saved記録と現在の同意を再確認します。合成例はHARNESS_PREFERENCE_TEST_FIXTURE=1の専用環境のみ。
評価の不足・不合格・未知形式は終了コード1。有効化は人がアプリから行います。`;

/** Uses the existing learn CLI entry point; no second evaluation daemon or provider framework. */
export async function runPreferenceCli(args: string[]): Promise<CliResult> {
  if (args[0] === 'preferences-help') return { code: 0, message: HELP };
  try {
    if (!['preferences-list', 'preferences-input', 'preferences-replay', 'preferences-script-input', 'preferences-script-compare'].includes(args[0] ?? '')) throw new Error('不明な好みの評価コマンドです');
    const options = new Map<string, string>();
    const allowed = new Set(['store', 'rule', 'rule-version', 'dataset', 'dataset-version', 'predictions', 'provider', 'model', 'projects-root', 'predictions-a', 'predictions-b']);
    for (let i = 1; i < args.length; i += 2) {
      const option = args[i]; const value = args[i + 1];
      if (!option?.startsWith('--') || !allowed.has(option.slice(2)) || !value || value.startsWith('--') || options.has(option.slice(2))) {
        throw new Error('引数が不正または重複しています。preferences-helpで形式を確認してください');
      }
      options.set(option.slice(2), value);
    }
    const require = (key: string): string => {
      const value = options.get(key); if (!value) throw new Error(`--${key} を指定してください`); return value;
    };
    const version = (key: string): number => {
      const raw = require(key); if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error(`--${key} は正の整数を指定してください`);
      return Number(raw);
    };
    const state = new PreferenceWorkspaceStore(require('store')).read();
    if (args[0] === 'preferences-list') return { code: 0, message: JSON.stringify({
      rules: state.rules.map((r) => ({ id: r.id, version: r.version, status: r.status, conditions: r.conditions, action: r.action })),
      datasets: state.datasets.map((d) => ({ id: d.id, version: d.version, cases: d.cases.length, hash: d.hash })),
      scriptDatasets: (state.scriptDatasets ?? []).map(d => ({ id: d.id, version: d.version, cases: d.cases.length, hash: d.hash, labelSource: d.labelSource })),
    }, null, 2) };
    if (args[0]?.startsWith('preferences-script-')) {
      const datasetId = require('dataset'), datasetVersion = version('dataset-version');
      const dataset = state.scriptDatasets?.find(d => d.id === datasetId && d.version === datasetVersion);
      if (!dataset) throw new Error('固定した台本の評価データがありません');
      const operations = new EditorOperationStore(join(require('projects-root'), '.sme-editor-operations.json'), 'script-cli-readonly').list();
      const evaluationOptions = { includeSynthetic: process.env.HARNESS_PREFERENCE_TEST_FIXTURE === '1' };
      const prepared = prepareScriptModelInput(dataset, state.decisions, operations, evaluationOptions);
      if (args[0] === 'preferences-script-input') return { code: 0, message: JSON.stringify({ ...prepared.input, inputHash: prepared.inputHash }, null, 2) };
      const comparison = await compareScriptModelOutputs(dataset, state.decisions, operations, { inputHash: prepared.inputHash,
        outputs: [
          { label: 'A', output: JSON.parse(readFileSync(require('predictions-a'), 'utf8')) },
          { label: 'B', output: JSON.parse(readFileSync(require('predictions-b'), 'utf8')) },
        ] }, evaluationOptions);
      const passesExactCases = comparison.humanCalibrationStatus === 'human_labeled_exact_cases'
        && comparison.reports.every(report => report.status === 'completed' && report.aggregate.knownAccepted === report.aggregate.total);
      return { code: passesExactCases ? 0 : 1, message: JSON.stringify(comparison, null, 2) };
    }
    const ruleId = require('rule'); const ruleVersion = version('rule-version');
    const datasetId = require('dataset'); const datasetVersion = version('dataset-version');
    const rule = state.rules.find((r) => r.id === ruleId && r.version === ruleVersion);
    const dataset = state.datasets.find((d) => d.id === datasetId && d.version === datasetVersion);
    if (!rule || !dataset) throw new Error('指定された版のルールまたは評価データがありません');
    const run = { id: crypto.randomUUID(), startedAt: new Date().toISOString() };
    if (args[0] === 'preferences-input') {
      const evaluation = evaluatePreferenceRule(rule, state.decisions, dataset, run);
      if (evaluation.failures.some((f) => ['EVIDENCE_INVALIDATED', 'CASE_INVALIDATED', 'TRAIN_EVAL_PROJECT_OVERLAP', 'RULE_REVOKED'].includes(f))) {
        throw new Error('同意・実例の失効または案件の混入があるため、モデル用の入力を出力できません');
      }
      return { code: 0, message: JSON.stringify(buildPreferenceModelInput(rule, dataset), null, 2) };
    }
    const output: unknown = JSON.parse(readFileSync(require('predictions'), 'utf8'));
    const adapter = replayPreferenceAdapter({ id: 'learn-cli-replay', version: '1', provider: require('provider'), model: require('model'), output });
    const report = await runPreferenceModelEvaluation(rule, state.decisions, dataset, adapter, run);
    return { code: report.status === 'completed' && report.failures.length === 0 ? 0 : 1, message: JSON.stringify(report, null, 2) };
  } catch (error) {
    return { code: 1, message: JSON.stringify({ error: error instanceof Error ? error.message : '評価を実行できませんでした' }) };
  }
}
