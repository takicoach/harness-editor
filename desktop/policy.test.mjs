import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {isEditorURL,isExternalURL,validateProjectRoot}=createRequire(import.meta.url)('./policy.cjs');
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
