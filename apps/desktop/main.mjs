import { app, BrowserWindow, Menu, dialog, shell, session, clipboard, ipcMain, powerSaveBlocker } from 'electron';
import { createTaskPowerState } from './power-state.mjs';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRuntime, localTarget } from './lifecycle.mjs';
app.setName('DreamaticArt');
const smoke = process.env.DREAMATIC_DESKTOP_SMOKE === '1';
app.setPath('userData', process.env.DREAMATIC_DESKTOP_TEST_DATA || join(app.getPath('appData'), 'Dreamatic'));
let service, mainWindow, log, quitting = false;
const taskPower = createTaskPowerState(powerSaveBlocker);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
  app.on('before-quit', event => {
    taskPower.dispose();
    if (service && !quitting) { event.preventDefault(); quitting = true; void service.stop().finally(() => { log?.end(); app.quit(); }); }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => { mainWindow?.show(); });
  void app.whenReady().then(async () => {
    const dataDir = app.getPath('userData');
    await mkdir(dataDir, { recursive: true });
    log = createWriteStream(join(dataDir, 'desktop.log'), { flags: 'a', mode: 0o600 });
    const developmentRuntime = process.platform === 'win32' ? '../../.desktop-runtime-win-x64' : '../../.desktop-runtime';
    const runtime = app.isPackaged ? join(process.resourcesPath, 'runtime') : resolve(fileURLToPath(new URL(developmentRuntime, import.meta.url)));
    service = await startRuntime({ runtime, dataDir, log });
    service.child.on('message', taskPower.handle);
    service.child.once('exit', taskPower.dispose);
    service.child.once('exit', () => { if (!quitting) { dialog.showErrorBox('DreamaticArt', 'The local service stopped. Restart DreamaticArt. Details are in desktop.log.'); app.quit(); } });
    const origin = service.url;
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', (_event, item, contents) => {
      if (!localTarget(contents.getURL(), origin)) { item.cancel(); return; }
      const path = dialog.showSaveDialogSync(BrowserWindow.fromWebContents(contents) ?? mainWindow, { title: 'Export', defaultPath: join(app.getPath('downloads'), basename(item.getFilename())) });
      if (path) item.setSavePath(path); else item.cancel();
    });
    function guard(window) {
      window.webContents.on('will-navigate', (event, url) => { if (!localTarget(url, origin)) { event.preventDefault(); openExternal(url); } });
      window.webContents.setWindowOpenHandler(({ url }) => {
        if (!localTarget(url, origin)) { openExternal(url); return { action: 'deny' }; }
        const preview = new BrowserWindow({ title: 'DreamaticArt Preview', width: 1280, height: 850, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
        guard(preview); void preview.loadURL(url); return { action: 'deny' };
      });
    }
    function openExternal(value) { try { const url = new URL(value); if (url.protocol === 'https:' || url.protocol === 'http:') void shell.openExternal(url.href); } catch {} }
    ipcMain.handle('dreamatic-copy-publication-link', (event, value) => {
      if (event.sender !== mainWindow?.webContents || event.senderFrame?.parent || new URL(event.senderFrame.url).origin !== origin) throw new Error('Untrusted clipboard request');
      if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid publication link');
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid publication link');
      clipboard.writeText(url.href);
    });
    mainWindow = new BrowserWindow({ title: 'DreamaticArt', width: 1440, height: 940, minWidth: 900, minHeight: 600, show: false, backgroundColor: '#f8f7f5', webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    guard(mainWindow);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'DreamaticArt', submenu: [{ role: 'about' }, { type: 'separator' }, { label: 'Open Project Folder', click: async () => { const health = await fetch(`${origin}/api/health`).then(r => r.json()); await shell.openPath(health.workspaceDir); } }, { label: 'Open Configuration Folder', click: () => { void shell.openPath(dataDir); } }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ]));
    mainWindow.once('ready-to-show', () => mainWindow.show());
    await mainWindow.loadURL(origin);
    if (smoke) {
      const result = await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => { const until = Date.now() + 5000; const check = () => { if (document.body.innerText.includes('Dreamatic · Art')) resolve({ body: document.body.innerText, node: typeof require }); else if (Date.now() > until) reject(new Error('UI did not render')); else setTimeout(check, 100); }; check(); })`);
      if (!result.body.includes('Dreamatic · Art') || result.node !== 'undefined') throw new Error('Desktop UI smoke check failed');
      console.log('DREAMATIC_DESKTOP_SMOKE_OK'); app.quit();
    }
  }).catch(async error => {
    console.error(error);
    if (!smoke) dialog.showErrorBox('Dreamatic · Art could not start', error.message);
    quitting = true;
    try { await service?.stop(); } finally { log?.end(); app.exit(1); }
  });
}
