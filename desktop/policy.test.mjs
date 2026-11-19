import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {isEditorURL,isExternalURL,installNavigationGuards,validateProjectRoot,widenBackendThreadPool}=createRequire(import.meta.url)('./policy.cjs');
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
test('opens a user-chosen mail draft from either navigation event',()=>{
  const {installNavigationGuards}=createRequire(import.meta.url)('./policy.cjs');
  const opened=[], hooks={};
  installNavigationGuards({
    setWindowOpenHandler:fn=>{hooks.open=fn;},
    on:(name,fn)=>{hooks[name]=fn;},
  },'http://localhost:42000',url=>opened.push(url),'example@example.test');
  const draft='mailto:example@example.test?subject=Test&body=Draft%0ANext';
  assert.ok(isExternalURL(draft,'example@example.test'));
  assert.equal(isExternalURL('mailto:example@example.test?bcc=other@example.test'),false);
  assert.deepEqual(hooks.open({url:draft}),{action:'deny'});
  let prevented=false;
  hooks['will-navigate']({preventDefault(){prevented=true;}},draft);
  assert.ok(prevented);
  assert.deepEqual(opened,[draft,draft]);
  hooks.open({url:'javascript:alert(1)'});
  hooks['will-navigate']({preventDefault(){}},'file:///tmp/path');
  assert.deepEqual(opened,[draft,draft]);
});

test('only permits the configured feedback address and safe mail draft fields', () => {
  const email = 'example@example.test';
  const draft = `mailto:${email}`;
  assert.equal(isExternalURL(draft, ''), false);
  assert.equal(isExternalURL(draft), false);
  assert.equal(isExternalURL(draft + '?subject=Feedback&body=One%0ATwo', email), true);
  for (const url of [
    'mailto:other@example.test?body=Test',
    draft + ',other@example.test',
    draft + '?to=other@example.test',
    draft + '?cc=other@example.test',
    draft + '?CC=other@example.test',
    draft + '?bcc=other@example.test',
    draft + '?BCC=other@example.test',
    draft + '?%63c=other@example.test',
    draft + '?subject=One&subject=Two',
    draft + '?body=One&%62ody=Two',
    draft + '?subject=Test#hash',
    draft + '?subject=Test#',
    draft + '?subject=a%00b',
    draft + '?subject=a%0Ab',
    draft + '?subject=a%09b',
    draft + '?subject=a%7Fb',
    draft + '?subject=a%E2%80%A8b',
    draft + '?subject=a%E2%80%A9b',
    draft + '?body=' + 'x'.repeat(8000),
  ]) assert.equal(isExternalURL(url, email), false, url.slice(0, 120));
});
