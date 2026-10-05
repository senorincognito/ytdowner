const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFile: () => ipcRenderer.invoke('open-file'),
  prepareFile: (p) => ipcRenderer.invoke('prepare-file', p),
  pathForFile: (file) => webUtils.getPathForFile(file), // File objects no longer carry a .path
  defaultFolder: () => ipcRenderer.invoke('default-folder'),
  chooseFolder: (current) => ipcRenderer.invoke('choose-folder', current),
  openFolder: (folder) => ipcRenderer.invoke('open-folder', folder),
  download: (opts) => ipcRenderer.invoke('download', opts),
  cancelDownload: () => ipcRenderer.invoke('cancel-download'),
  ytdlpStatus: () => ipcRenderer.invoke('ytdlp-status'),
  ytdlpLatest: () => ipcRenderer.invoke('ytdlp-latest'),
  resolveMedia: (url) => ipcRenderer.invoke('resolve-media', url),
  videoFps: (id) => ipcRenderer.invoke('video-fps', id),
  ytdlpInstall: () => ipcRenderer.invoke('ytdlp-install'),
  onInstallProgress: (cb) => ipcRenderer.on('ytdlp-install-progress', (_e, msg) => cb(msg)),
  onProgress: (cb) => ipcRenderer.on('download-progress', (_e, msg) => cb(msg)),
});
