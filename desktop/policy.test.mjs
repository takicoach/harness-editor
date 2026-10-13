import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {isEditorURL,isExternalURL,validateProjectRoot,widenBackendThreadPool}=createRequire(import.meta.url)('./policy.cjs');
test('navigation stays on this application server',()=>{
  const origin='http://127.0.0.1:42000';
  assert.ok(isEditorURL(`${origin}/?project=demo`,origin));
  for(const url of ['http://127.0.0.1:2109','http://localhost:42000','file:///etc/passwd','javascript:alert(1)','http://user@127.0.0.1:42000'])assert.equal(isEditorURL(url,origin),false,url);
});
test('external opening rejects local file and protocol execution',()=>{
  assert.ok(isExternalURL('https://example.com/help'));
  for(const url of ['file:///tmp/x','javascript:alert(1)','smb://host/share','invalid'])assert.equal(isExternalURL(url),false);
});
test('project files cannot be stored inside replaceable app bundle',()=>{
  assert.equal(validateProjectRoot('/Users/x/Documents/Projects','/Applications/Harness.app'),'/Users/x/Documents/Projects');
  for(const path of ['relative','/Applications/Harness.app','/Applications/Harness.app/Contents/Projects'])assert.throws(()=>validateProjectRoot(path,'/Applications/Harness.app'));
});
test('the backend gets a wider file-thread pool so slow linked media cannot block page loads',()=>{
  const env={};widenBackendThreadPool(env);assert.equal(env.UV_THREADPOOL_SIZE,'16');
  const own={UV_THREADPOOL_SIZE:'64'};widenBackendThreadPool(own);assert.equal(own.UV_THREADPOOL_SIZE,'64');
  const small={UV_THREADPOOL_SIZE:'4'};widenBackendThreadPool(small);assert.equal(small.UV_THREADPOOL_SIZE,'16');
  const broken={UV_THREADPOOL_SIZE:'abc'};widenBackendThreadPool(broken);assert.equal(broken.UV_THREADPOOL_SIZE,'16');
});
test('a backend ended from outside by a signal counts as already exited (2026-10-06: quit waited forever)',async()=>{
  const {childHasExited}=createRequire(import.meta.url)('./policy.cjs');
  assert.equal(childHasExited(undefined),true,'no backend');
  assert.equal(childHasExited({exitCode:null,signalCode:null}),false,'still running');
  assert.equal(childHasExited({exitCode:0,signalCode:null}),true,'normal exit');
  assert.equal(childHasExited({exitCode:null,signalCode:'SIGTERM'}),true,'SIGTERM from outside');
  // 実プロセスでも、外からの SIGKILL の後は exitCode が null のまま signalCode にだけ値が入ることを確かめる。
  const {spawn}=await import('node:child_process');
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  assert.equal(childHasExited(child),false);
  const exited=new Promise(accept=>child.once('exit',accept));
  child.kill('SIGKILL');await exited;
  assert.equal(child.exitCode,null);assert.equal(child.signalCode,'SIGKILL');
  assert.equal(childHasExited(child),true);
});
