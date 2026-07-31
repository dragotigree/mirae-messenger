const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toastApi', {
  activate: () => ipcRenderer.send('message-toast-activate')
});
