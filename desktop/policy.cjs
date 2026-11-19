const {isAbsolute, resolve, sep} = require('node:path');
exports.isEditorURL = (value, origin) => {
  try { const url = new URL(value); return url.origin === origin && url.username === '' && url.password === ''; }
  catch { return false; }
};
exports.isExternalURL = (value, feedbackEmail = '') => {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') return true;
    if (url.protocol !== 'mailto:' || !feedbackEmail || value.includes('#') || value.length > 8000
      || url.pathname !== feedbackEmail || !/^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(url.pathname)) return false;
    return [...url.searchParams.keys()].every(key => key === 'subject' || key === 'body')
      && url.searchParams.getAll('subject').length <= 1 && url.searchParams.getAll('body').length <= 1
      && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(url.searchParams.get('subject') ?? '');
  } catch { return false; }
};

exports.installNavigationGuards = (contents, origin, openExternal, feedbackEmail) => {
  contents.setWindowOpenHandler(({url})=>{
    if(exports.isExternalURL(url, feedbackEmail))openExternal(url);
    return {action:'deny'};
  });
  contents.on('will-navigate',(event,url)=>{
    if(exports.isEditorURL(url,origin))return;
    event.preventDefault();
    if(exports.isExternalURL(url, feedbackEmail))openExternal(url);
  });
};
exports.validateProjectRoot = (value, appRoot) => {
  if (!isAbsolute(value)) throw new Error('保存先には絶対パスを指定してください');
  const folder = resolve(value), application = resolve(appRoot);
  if (folder === application || folder.startsWith(application + sep)) throw new Error('保存先はアプリの外に指定してください');
  return folder;
};
// libuv の既定 4 本は、遅い媒体（SD カード等）の読み取りがふさぐと画面のページ本体の読み込みまで止める（2026-10-04 実測: 起動が時間切れ）。
exports.widenBackendThreadPool = env => {
  const current = Number(env.UV_THREADPOOL_SIZE);
  if (!Number.isInteger(current) || current < 16) env.UV_THREADPOOL_SIZE = '16';
  return env;
};
// 子プロセスが終わったか。外から SIGKILL/SIGTERM で終わると exitCode は null のまま signalCode にだけ値が入る。
// exitCode だけで見ると終わった子を「動いている」と誤認し、既に来た exit を待ち続けて本体が終わらない（2026-10-06 実測）。
exports.childHasExited = child => !child || child.exitCode !== null || child.signalCode !== null;
