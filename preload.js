const { contextBridge, ipcRenderer } = require('electron');

// Мост используется страницей подключения (data: URL)
if (location.protocol === 'data:') {
  contextBridge.exposeInMainWorld('rustcordStatus', {
    onState: (cb) => ipcRenderer.on('status-state', (_event, payload) => cb(payload)),
    retry: (url) => ipcRenderer.send('retry-connection', String(url || '')),
    openExternal: (url) => ipcRenderer.send('open-external-url', String(url || ''))
  });
}
