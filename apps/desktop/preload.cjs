const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dreamaticDesktop', {
  copyPublicationLink: (url) => ipcRenderer.invoke('dreamatic-copy-publication-link', url),
});
