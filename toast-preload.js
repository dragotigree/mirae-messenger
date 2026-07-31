const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toastApi', {
  open: () => ipcRenderer.send('message-toast-open'),
  close: () => ipcRenderer.send('message-toast-close'),
  // 하위 호환
  activate: () => ipcRenderer.send('message-toast-open')
});
