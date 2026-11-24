const { app, BrowserWindow, ipcMain, shell, desktopCapturer, session, Menu, Notification, Tray, nativeImage, dialog } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const { startLocalPreview } = require('./local-preview');
const { autoUpdater } = require('electron-updater');
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
let updateCheckPromise = null;

app.setName('Auralis');
if (process.platform === 'win32') app.setAppUserModelId('com.ovarist.auralis');

const DEFAULT_SERVER_URL = process.env.AURALIS_SERVER_URL || process.env.RUSTCORD_SERVER_URL || 'http://127.0.0.1:4173';
const REQUEST_TIMEOUT_MS = 12000;

let mainWindow = null;
let currentServerUrl = DEFAULT_SERVER_URL;
let connectionAttempt = 0;
let tray = null;
let isQuitting = false;

function normalizeUrl(rawUrl) {
  let cleaned = String(rawUrl || '').trim();
  if (!cleaned) return DEFAULT_SERVER_URL;
  if (!/^https?:\/\//i.test(cleaned)) {
    cleaned = 'https://' + cleaned;
  }
  return cleaned.replace(/\/+$/, '');
}

function checkServerReachable(targetUrl, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      resolve({ ok: false, reason: 'Некорректный формат адреса сервера.' });
      return;
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(
      parsed.toString(),
      {
        headers: {
          'User-Agent': 'Auralis-Desktop/1.0',
          'Accept': 'text/html,*/*'
        }
      },
      (res) => {
        res.resume();
        const status = res.statusCode || 0;
        if (status >= 200 && status < 500) {
          resolve({ ok: true, status });
        } else {
          resolve({
            ok: false,
            reason: `Сервер вернул статус ${status} (возможно, идёт перезапуск или перегрузка).`
          });
        }
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({
        ok: false,
        reason: 'Превышено время ожидания ответа от сервера (таймаут). Сервер просыпается или соединение заблокировано.'
      });
    });

    req.on('error', (err) => {
      resolve({
        ok: false,
        reason: `Не удалось подключиться к серверу (${err.code || err.message || 'ошибка сети'}).`
      });
    });
  });
}

function getStatusHtml() {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Auralis — Подключение</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #07090f;
      color: #f3f6ff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      user-select: none;
    }
    .card {
      width: 100%;
      max-width: 440px;
      background: #0e1320;
      border: 1px solid rgba(114, 137, 218, 0.25);
      border-radius: 16px;
      padding: 28px;
      text-align: center;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
    }
    .badge {
      width: 56px;
      height: 56px;
      margin: 0 auto 16px;
      border-radius: 16px;
      background: linear-gradient(135deg, #4f46e5, #06b6d4);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
      font-weight: 800;
      color: #fff;
    }
    h1 { font-size: 20px; margin-bottom: 8px; }
    p.desc {
      font-size: 14px;
      line-height: 1.45;
      color: #9aa6c4;
      margin-bottom: 18px;
      word-break: break-word;
    }
    .spinner {
      width: 34px;
      height: 34px;
      margin: 0 auto 16px;
      border: 3px solid rgba(255, 255, 255, 0.14);
      border-top-color: #22d3ee;
      border-radius: 50%;
      animation: spin 0.85s linear infinite;
    }
    .hidden { display: none !important; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .url-box {
      width: 100%;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.15);
      background: #07090f;
      color: #f3f6ff;
      font-size: 13px;
      margin-bottom: 14px;
      outline: none;
    }
    .url-box:focus { border-color: #22d3ee; }
    .actions {
      display: flex;
      gap: 10px;
      justify-content: center;
      flex-wrap: wrap;
    }
    button {
      border: 0;
      border-radius: 10px;
      padding: 10px 18px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-primary {
      background: linear-gradient(135deg, #4f46e5, #06b6d4);
      color: #fff;
    }
    .btn-secondary {
      background: #1a2236;
      color: #d6dff5;
    }
    .hint {
      margin-top: 16px;
      font-size: 12px;
      color: #6f7c9c;
      line-height: 1.4;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">R</div>
    <h1 id="title">Подключаемся к Auralis...</h1>
    <div id="spinner" class="spinner"></div>
    <p id="message" class="desc">Загружаем Auralis.</p>

    <div id="controls" class="hidden">
      <input id="serverInput" class="url-box" type="text" placeholder="https://..." />
      <div class="actions">
        <button id="retryBtn" class="btn-primary">Повторить</button>
        <button id="browserBtn" class="btn-secondary">Открыть в браузере</button>
      </div>
    </div>

    <div class="hint">
      Совет: если сервер на бесплатном хостинге спал, первая загрузка может занять около минуты.
    </div>
  </div>

  <script>
    const bridge = window.rustcordStatus;
    const titleEl = document.getElementById('title');
    const messageEl = document.getElementById('message');
    const spinnerEl = document.getElementById('spinner');
    const controlsEl = document.getElementById('controls');
    const serverInput = document.getElementById('serverInput');
    const retryBtn = document.getElementById('retryBtn');
    const browserBtn = document.getElementById('browserBtn');

    if (bridge && typeof bridge.onState === 'function') {
      bridge.onState((payload) => {
        if (payload.serverUrl && document.activeElement !== serverInput) {
          serverInput.value = payload.serverUrl;
        }

        if (payload.mode === 'loading') {
          titleEl.textContent = payload.title || 'Подключаемся к Auralis...';
          messageEl.textContent = payload.message || 'Проверяем соединение с сервером...';
          spinnerEl.classList.remove('hidden');
          controlsEl.classList.add('hidden');
        } else {
          titleEl.textContent = payload.title || 'Не удалось подключиться';
          messageEl.textContent = payload.message || 'Сервер не отвечает.';
          spinnerEl.classList.add('hidden');
          controlsEl.classList.remove('hidden');
        }
      });

      retryBtn.addEventListener('click', () => {
        bridge.retry(serverInput.value);
      });

      serverInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          bridge.retry(serverInput.value);
        }
      });

      browserBtn.addEventListener('click', () => {
        bridge.openExternal(serverInput.value);
      });
    }
  </script>
</body>
</html>`;
}

function sendStatus(state) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('status-state', {
    serverUrl: currentServerUrl,
    ...state
  });
}

async function connectToServer(rawUrl) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const attempt = ++connectionAttempt;
  currentServerUrl = normalizeUrl(rawUrl || currentServerUrl);

  const statusDataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(getStatusHtml());
  if (!mainWindow.webContents.getURL().startsWith('data:text/html')) {
    await mainWindow.loadURL(statusDataUrl);
  }

  sendStatus({
    mode: 'loading',
    title: 'Подключаемся к Auralis...',
    message: `Проверяем доступность ${currentServerUrl}...`
  });

  const result = await checkServerReachable(currentServerUrl);
  if (attempt !== connectionAttempt || !mainWindow || mainWindow.isDestroyed()) return;
  if (!result.ok) {
    sendStatus({
      mode: 'error',
      title: 'Сервер недоступен',
      message: result.reason
    });
    return;
  }

  sendStatus({
    mode: 'loading',
    title: 'Загружаем интерфейс...',
    message: 'Сервер ответил, открываем чат.'
  });

  try {
    await mainWindow.loadURL(currentServerUrl);
  } catch (err) {
    await showConnectionError(`Не удалось открыть интерфейс (${err.message || 'ошибка загрузки'}).`);
  }
}

async function showConnectionError(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const statusUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(getStatusHtml());
  try { if (!mainWindow.webContents.getURL().startsWith('data:text/html')) await mainWindow.loadURL(statusUrl); } catch {}
  sendStatus({ mode: 'error', title: 'Не удалось открыть Auralis', message });
}

function isOurOrigin(url) {
  try {
    return new URL(url).origin === new URL(currentServerUrl).origin;
  } catch {
    return false;
  }
}

function setupMediaPermissions() {
  if (!session || !session.defaultSession) return;
  const ses = session.defaultSession;
  const alwaysAllowed = new Set(['display-capture', 'fullscreen', 'clipboard-sanitized-write']);
  const mediaPermissionCache = new Map();
  const pendingPermissionPrompts = new Map();

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
    if (!isOurOrigin(url)) return callback(false);
    if (alwaysAllowed.has(permission)) return callback(true);
    if (!['media', 'microphone', 'camera'].includes(permission)) return callback(false);

    const key = permission + ':' + new URL(url).origin;
    if (mediaPermissionCache.has(key)) return callback(mediaPermissionCache.get(key));
    if (pendingPermissionPrompts.has(key)) {
      pendingPermissionPrompts.get(key).then(callback).catch(() => callback(false));
      return;
    }

    const mediaTypes = details && Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    const wantsAudio = permission === 'microphone' || mediaTypes.includes('audio');
    const wantsVideo = permission === 'camera' || mediaTypes.includes('video');
    const deviceName = wantsAudio && wantsVideo ? 'микрофон и камеру' : wantsVideo ? 'камеру' : 'микрофон';
    const prompt = dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
      type: 'question',
      title: 'Разрешение Auralis',
      message: 'Разрешить Auralis использовать ' + deviceName + '?',
      detail: 'Доступ нужен для голосовых звонков' + (wantsVideo ? ' и видеосвязи' : '') + '. Разрешение можно изменить в настройках Windows.',
      buttons: ['Разрешить', 'Запретить'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    }).then((result) => {
      const granted = result.response === 0;
      if (granted) mediaPermissionCache.set(key, true);
      return granted;
    }).catch((err) => {
      console.error('[Auralis] Media permission prompt failed:', err);
      return false;
    }).finally(() => pendingPermissionPrompts.delete(key));

    pendingPermissionPrompts.set(key, prompt);
    prompt.then(callback);
  });

  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    const url = requestingOrigin || (wc && wc.getURL()) || '';
    if (!isOurOrigin(url)) return false;
    if (alwaysAllowed.has(permission)) return true;
    if (['media', 'microphone', 'camera'].includes(permission)) {
      const key = permission + ':' + new URL(url).origin;
      return mediaPermissionCache.get(key) === true;
    }
    return false;
  });

  // Выбор экрана/окна для демонстрации экрана (Screen Share)
  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    let settled = false;
    const deny = () => {
      try { callback({}); } catch {
        try { callback(); } catch {}
      }
    };
    const finish = (source) => {
      if (settled) return;
      settled = true;
      try {
        if (source) callback({ video: source });
        else deny();
      } catch (err) {
        console.error('Display media callback error:', err);
      }
    };

    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 160, height: 90 },
        fetchWindowIcons: false
      });
      if (!sources.length) return finish(null);

      const screens = sources.filter((s) => s.id.startsWith('screen:'));
      if (sources.length === 1) return finish(sources[0]);

      const toItem = (s) => ({
        label: (s.id.startsWith('screen:') ? 'Экран: ' : 'Окно: ') + String(s.name || '').slice(0, 60),
        icon: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.resize({ width: 48, height: 27 }) : undefined,
        click: () => finish(s)
      });

      const template = [
        { label: 'Что показывать?', enabled: false },
        { type: 'separator' },
        ...screens.map(toItem),
        ...(screens.length && sources.length > screens.length ? [{ type: 'separator' }] : []),
        ...sources.filter((s) => !s.id.startsWith('screen:')).map(toItem),
        { type: 'separator' },
        { label: 'Отмена', click: () => finish(null) }
      ];

      Menu.buildFromTemplate(template).popup({
        window: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
        callback: () => setTimeout(() => finish(null), 150)
      });
    } catch (err) {
      console.error('Display media error:', err);
      finish(null);
    }
  }, { useSystemPicker: true });
}

function isStatusSender(event) {
  const url = (event.senderFrame && event.senderFrame.url) || '';
  return url.startsWith('data:text/html');
}

function setupIpc() {
  const isTrustedAppSender = (event) => isOurOrigin((event.senderFrame && event.senderFrame.url) || '');
  ipcMain.handle('auralis:update-version', (event) => {
    if (!isTrustedAppSender(event)) throw new Error('Недоверенный источник');
    return app.getVersion();
  });
  ipcMain.handle('auralis:update-check', async (event) => {
    if (!isTrustedAppSender(event)) throw new Error('Недоверенный источник');
    if (process.platform !== 'win32') return { supported: false, reason: 'Автообновление доступно только в Windows-версии.' };
    if (updateCheckPromise) return updateCheckPromise;
    updateCheckPromise = autoUpdater.checkForUpdates().finally(() => { updateCheckPromise = null; });
    const result = await updateCheckPromise;
    const availableVersion = result && result.updateInfo ? result.updateInfo.version : null;
    const currentParts = app.getVersion().split('.').map((part) => Number(part) || 0);
    const availableParts = String(availableVersion || '').split('.').map((part) => Number(part) || 0);
    let comparison = 0;
    for (let i = 0; i < Math.max(currentParts.length, availableParts.length); i += 1) {
      const difference = (availableParts[i] || 0) - (currentParts[i] || 0);
      if (difference !== 0) { comparison = difference; break; }
    }
    return { supported: true, version: app.getVersion(), updateAvailable: comparison > 0, availableVersion };
  });
  ipcMain.handle('auralis:update-download', async (event) => {
    if (!isTrustedAppSender(event)) throw new Error('Недоверенный источник');
    if (process.platform !== 'win32') throw new Error('Обновление поддерживается только в Windows.');
    await autoUpdater.downloadUpdate();
    return { started: true };
  });
  ipcMain.on('auralis:update-install', (event) => {
    if (!isTrustedAppSender(event)) return;
    autoUpdater.quitAndInstall(false, true);
  });
  autoUpdater.on('checking-for-update', () => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('auralis:update-state', { state: 'checking' }));
  autoUpdater.on('update-available', (info) => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('auralis:update-state', { state: 'available', version: info.version }));
  autoUpdater.on('update-not-available', (info) => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('auralis:update-state', { state: 'current', version: info.version }));
  autoUpdater.on('download-progress', (progress) => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('auralis:update-state', { state: 'downloading', percent: Math.round(progress.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('auralis:update-state', { state: 'downloaded', version: info.version }));
  autoUpdater.on('error', (error) => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('auralis:update-state', { state: 'error', message: String(error && error.message || 'Ошибка обновления').slice(0, 240) }));
  ipcMain.on('rustcord:notify', (event, payload) => {
    if (!isOurOrigin((event.senderFrame && event.senderFrame.url) || '')) return;
    if (!Notification.isSupported()) return;
    const title = String(payload && payload.title || 'Auralis').slice(0, 100);
    const body = String(payload && payload.body || '').slice(0, 220);
    const notification = new Notification({ title, body, silent: true, urgency: 'normal' });
    notification.on('click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
    notification.show();
  });
  ipcMain.on('retry-connection', (event, url) => {
    if (!isStatusSender(event)) return;
    connectToServer(url);
  });
  ipcMain.on('open-external-url', (event, url) => {
    if (!isStatusSender(event)) return;
    shell.openExternal(normalizeUrl(url)).catch(() => {});
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, 'build', 'icon.png.jpg');
  let icon = nativeImage.createFromPath(iconPath);
  if (!icon || icon.isEmpty()) icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Auralis');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть Auralis', click: showMainWindow },
    { type: 'separator' },
    { label: 'Выйти из Auralis', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 780,
    minHeight: 560,
    title: 'Auralis',
    backgroundColor: '#07090f',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, validatedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    if (String(validatedUrl || '').startsWith('data:')) return;
    showConnectionError(`Не удалось открыть интерфейс (${desc || code}).`);
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  connectToServer(currentServerUrl);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    setupMediaPermissions();
    setupIpc();
    // Start local Auralis UI/API/WebSocket bridge automatically with the desktop app.
    // Reuse an already running preview server if the user launched it manually.
    try {
      await startLocalPreview();
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        const existing = await checkServerReachable(DEFAULT_SERVER_URL);
        if (!existing.ok) console.error('[Auralis] Local preview port is occupied but not responding:', existing.reason);
      } else {
        console.error('[Auralis] Could not start local preview:', err);
      }
    }
    createTray();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => { /* Auralis remains available in the system tray. */ });
  app.on('before-quit', () => { isQuitting = true; });
}
