const { contextBridge, ipcRenderer } = require('electron');

// Мост используется страницей подключения (data: URL)
if (location.protocol === 'data:') {
  contextBridge.exposeInMainWorld('rustcordStatus', {
    onState: (cb) => ipcRenderer.on('status-state', (_event, payload) => cb(payload)),
    retry: (url) => ipcRenderer.send('retry-connection', String(url || '')),
    openExternal: (url) => ipcRenderer.send('open-external-url', String(url || ''))
  });
}


// Native notification bridge for the trusted Rustcord web origin.
if (location.protocol === 'https:') {
  contextBridge.exposeInMainWorld('rustcordDesktop', {
    notify: (payload) => ipcRenderer.send('rustcord:notify', {
      title: String(payload && payload.title || 'Rustcord').slice(0, 100),
      body: String(payload && payload.body || '').slice(0, 220),
      tag: String(payload && payload.tag || 'rustcord').slice(0, 120)
    })
  });
}
