const { app, BrowserWindow, session } = require('electron');

const SERVER_URL = 'https://rustcord-server.onrender.com';

function createWindow() {
  const win = new BrowserWindow({
    width: 1140,
    height: 780,
    minWidth: 680,
    minHeight: 520,
    title: 'Rustcord',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (
      permission === 'media' ||
      permission === 'display-capture' ||
      permission === 'microphone' ||
      permission === 'camera'
    ) {
      return callback(true);
    }
    return callback(false);
  });

  win.loadURL(SERVER_URL);
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
