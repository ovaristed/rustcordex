const { contextBridge, ipcRenderer } = require('electron');

// Мост используется страницей подключения (data: URL)
if (location.protocol === 'data:') {
  contextBridge.exposeInMainWorld('rustcordStatus', {
    onState: (cb) => ipcRenderer.on('status-state', (_event, payload) => cb(payload)),
    retry: (url) => ipcRenderer.send('retry-connection', String(url || '')),
    openExternal: (url) => ipcRenderer.send('open-external-url', String(url || ''))
  });
}


// Native bridges are exposed only inside Electron's isolated preload context.
if (location.protocol === 'https:' || location.hostname === '127.0.0.1' || location.hostname === 'localhost') {
  contextBridge.exposeInMainWorld('rustcordDesktop', {
    getVersion: () => ipcRenderer.invoke('auralis:update-version'),
    checkForUpdates: () => ipcRenderer.invoke('auralis:update-check'),
    downloadUpdate: () => ipcRenderer.invoke('auralis:update-download'),
    installUpdate: () => ipcRenderer.send('auralis:update-install'),
    onUpdateState: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('auralis:update-state', listener);
      return () => ipcRenderer.removeListener('auralis:update-state', listener);
    },
    notify: (payload) => ipcRenderer.send('rustcord:notify', {
      title: String(payload && payload.title || 'Rustcord').slice(0, 100),
      body: String(payload && payload.body || '').slice(0, 220),
      tag: String(payload && payload.tag || 'rustcord').slice(0, 120)
    })
  });
}
