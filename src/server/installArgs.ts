/**
 * npm install の共通引数。
 *
 * `--ignore-scripts`: 対象プロジェクトの package.json に書かれた lifecycle スクリプト
 * （preinstall / install / postinstall 等）を実行しない。これらは npm install だけで
 * ユーザー権限で自動実行されるため、素性の分からないプロジェクトでは任意コード実行の
 * 経路になる。エディタが自動で install を走らせる場面（新規プロジェクト作成・書き出し前）
 * では、この経路を塞いだ状態でインストールする。Remotion / 同梱テンプレートの依存は
 * install スクリプトに依存しないため、書き出しには影響しない。
 */
export const NPM_INSTALL_ARGS = ['install', '--ignore-scripts'] as const;
