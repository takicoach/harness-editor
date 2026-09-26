const {app, BrowserWindow, dialog, Menu, shell} = require('electron');
const {spawn} = require('node:child_process');
const {mkdirSync, existsSync, appendFileSync, readFileSync, writeFileSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {isEditorURL, isExternalURL, validateProjectRoot} = require('./policy.cjs');
app.setName('Harness Editor');
app.setPath('userData', process.env.HARNESS_DESKTOP_USER_DATA ? resolve(process.env.HARNESS_DESKTOP_USER_DATA) : join(app.getPath('appData'),'Harness Editor'));
let window, backend, origin, quitting = false, stopping = false;
const runtime = app.isPackaged ? join(process.resourcesPath,'runtime') : resolve(__dirname,'..');
const node = app.isPackaged ? join(runtime,'tools','node') : process.env.HARNESS_DESKTOP_NODE;
let projectRoot;
const settingsFile=join(app.getPath('userData'),'desktop-settings.json');
const applicationRoot=app.isPackaged ? resolve(process.resourcesPath,'../..') : runtime;
const log = join(app.getPath('userData'),'desktop.log');
const portFile = join(app.getPath('userData'),'server-port.json');
function savedPort() {
  if(!existsSync(portFile))return 0;
  const port=JSON.parse(readFileSync(portFile,'utf8')).port;
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('保存された接続設定が不正です');
  return port;
}
function writeLog(value) { appendFileSync(log, `${new Date().toISOString()} ${value}\n`); }
function reportError(title,message) {
  writeLog(`${title}: ${message}`);
  if(process.env.HARNESS_DESKTOP_TEST!=='1')dialog.showErrorBox(title,message);
}
function stopBackend() {
  if (stopping) return; stopping = true;
  if (!backend || backend.exitCode !== null) { quitting=true;app.quit();return; }
  backend.once('exit',()=>{quitting=true;app.quit();});
  if (backend.connected) backend.send('shutdown'); else backend.kill('SIGTERM');
  const timer = setTimeout(()=>backend?.kill('SIGKILL'),6500);timer.unref();
}
async function undoMenu(redo) {
  if(!window)return;
  const handled=await window.webContents.executeJavaScript(`(() => {
    const target=document.activeElement || document.body;
    if(target.closest('input,textarea,select,[contenteditable=true]'))return false;
    target.dispatchEvent(new KeyboardEvent('keydown',{key:'z',code:'KeyZ',metaKey:true,shiftKey:${redo},bubbles:true,cancelable:true}));
    return true;
  })()`);
  if(!handled)window.webContents[redo?'redo':'undo']();
}
async function openWindow() {
  window = new BrowserWindow({width:1440,height:960,minWidth:1000,minHeight:680,backgroundColor:'#17201c',show:false,
    title:'Harness Editor',webPreferences:{preload:join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  window.webContents.setWindowOpenHandler(({url})=>{if(isExternalURL(url))void shell.openExternal(url);return {action:'deny'};});
  window.webContents.on('will-navigate',(event,url)=>{if(!isEditorURL(url,origin)){event.preventDefault();if(isExternalURL(url))void shell.openExternal(url);}});
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  window.webContents.on('will-prevent-unload',event=>{
    if(dialog.showMessageBoxSync(window,{type:'question',buttons:['編集に戻る','終了する'],defaultId:0,cancelId:0,message:'保存していない変更があります。終了しますか？'})===1)event.preventDefault();
  });
  window.on('close',event=>{
    if(quitting)return;
    event.preventDefault();
    // Covers pending field edits and exports as well as saved document revisions.
    const response=dialog.showMessageBoxSync(window,{type:'question',buttons:['編集に戻る','終了する'],defaultId:0,cancelId:0,message:'Harness Editorを終了しますか？',detail:'必要な編集を保存し、書き出しの完了を確認してください。'});
    if(response===1){quitting=true;window.destroy();stopBackend();}
  });
  window.once('ready-to-show',()=>process.env.HARNESS_DESKTOP_TEST==='1'?window.showInactive():window.show());
  await window.loadURL(origin);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});
  app.on('before-quit',event=>{if(!quitting){event.preventDefault();if(window)window.close();else stopBackend();}});
  app.on('window-all-closed',()=>stopBackend());
  app.whenReady().then(async()=>{
    mkdirSync(app.getPath('userData'),{recursive:true});
    const settings=existsSync(settingsFile)?JSON.parse(readFileSync(settingsFile,'utf8')):{};
    projectRoot=validateProjectRoot(process.env.HARNESS_DESKTOP_PROJECT_ROOT || settings.projectRoot || join(app.getPath('documents'),'Harness Editor','Projects'),applicationRoot);
    mkdirSync(projectRoot,{recursive:true});
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {label:'Harness Editor',submenu:[{role:'about'},{type:'separator'},{role:'quit',label:'Harness Editorを終了'}]},
      {label:'編集',submenu:[{label:'元に戻す',accelerator:'CmdOrCtrl+Z',click:()=>void undoMenu(false).catch(error=>writeLog(error.message))},{label:'やり直す',accelerator:'CmdOrCtrl+Shift+Z',click:()=>void undoMenu(true).catch(error=>writeLog(error.message))},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
      {label:'表示',submenu:[{role:'togglefullscreen'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'}]},
      {label:'保存先',submenu:[{label:'プロジェクトフォルダーを開く',click:()=>void shell.openPath(projectRoot)},{label:'次回起動時のプロジェクトフォルダーを選ぶ…',click:async()=>{
        const choice=await dialog.showOpenDialog(window,{title:'プロジェクトを保管するフォルダー',defaultPath:projectRoot,properties:['openDirectory','createDirectory']});
        if(choice.canceled||!choice.filePaths[0])return;
        try{
          const next=validateProjectRoot(choice.filePaths[0],applicationRoot);
          writeFileSync(settingsFile,JSON.stringify({projectRoot:next}));
          await dialog.showMessageBox(window,{message:'次回起動時から選択したフォルダーを開きます',detail:'現在の編集を保存してから、アプリを終了して開き直してください。既存の動画は移動しません。'});
        }catch(error){dialog.showErrorBox('保存先を変更できませんでした',error.message);}
      }},{label:'ログフォルダーを開く',click:()=>void shell.openPath(app.getPath('userData'))}]},
    ]));
    if (!node || !existsSync(node)) throw new Error('同梱Node.jsが見つかりません。開発時はHARNESS_DESKTOP_NODEを指定してください。');
    const env={...process.env,HARNESS_PROJECT_ROOT:projectRoot,HARNESS_DESKTOP_CACHE:join(app.getPath('userData'),'vite-cache'),HARNESS_MANAGED_AI_DIR:join(app.getPath('userData'),'ai-tools'),SME_NO_OPEN:'1',HARNESS_DESKTOP_PORT:String(savedPort()),PATH:`${join(runtime,'tools')}:${process.env.PATH||'/usr/bin:/bin'}`};
    delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.ELECTRON_RUN_AS_NODE;
    if(app.isPackaged){env.HARNESS_FFMPEG=join(runtime,'tools','ffmpeg');env.HARNESS_FFPROBE=join(runtime,'tools','ffprobe');}
    backend=spawn(node,['--import','tsx',join(runtime,'desktop','server.mjs')],{cwd:runtime,env,stdio:['ignore','pipe','pipe','ipc']});
    backend.stdout.on('data',data=>writeLog(data.toString()));backend.stderr.on('data',data=>writeLog(data.toString()));
    backend.on('exit',(code)=>{writeLog(`server exit ${code}`);if(!stopping&&origin){reportError('エディターが停止しました','編集サーバーが停止しました。ログフォルダーのdesktop.logを確認してください。');quitting=true;app.quit();}});
    origin=await new Promise((accept,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('起動が時間内に完了しませんでした')),90000);
      backend.once('error',error=>{clearTimeout(timeout);reject(error);});
      backend.once('exit',code=>{clearTimeout(timeout);reject(new Error(`編集サーバーの終了: ${code}`));});
      backend.on('message',message=>{if(message?.type==='ready'&&/^http:\/\/127\.0\.0\.1:\d+$/.test(message.origin)){clearTimeout(timeout);accept(message.origin);}});
    });
    writeFileSync(portFile,JSON.stringify({port:Number(new URL(origin).port)}));
    writeLog(`ready ${origin}`);await openWindow();
  }).catch(error=>{writeLog(error.stack||String(error));reportError('起動できませんでした',error.message);stopBackend();});
}
