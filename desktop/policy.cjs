const {isAbsolute, resolve, sep} = require('node:path');
exports.isEditorURL = (value, origin) => {
  try { const url = new URL(value); return url.origin === origin && url.username === '' && url.password === ''; }
  catch { return false; }
};
exports.isExternalURL = value => {
  try { return ['https:', 'http:'].includes(new URL(value).protocol); } catch { return false; }
};
exports.validateProjectRoot = (value, appRoot) => {
  if (!isAbsolute(value)) throw new Error('保存先には絶対パスを指定してください');
  const folder = resolve(value), application = resolve(appRoot);
  if (folder === application || folder.startsWith(application + sep)) throw new Error('保存先はアプリの外に指定してください');
  return folder;
};
