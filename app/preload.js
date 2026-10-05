const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  defaultFolder: () => ipcRenderer.invoke('default-folder'),
  chooseFolder: (current) => ipcRenderer.invoke('choose-folder', current),
  openFolder: (folder) => ipcRenderer.invoke('open-folder', folder),
  download: (opts) => ipcRenderer.invoke('download', opts),
  ytdlpStatus: () => ipcRenderer.invoke('ytdlp-status'),
  ytdlpInstall: () => ipcRenderer.invoke('ytdlp-install'),
  onInstallProgress: (cb) => ipcRenderer.on('ytdlp-install-progress', (_e, msg) => cb(msg)),
  onProgress: (cb) => ipcRenderer.on('download-progress', (_e, msg) => cb(msg)),
});
