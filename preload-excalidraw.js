const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('excalidrawBridge', {
  getContext: () => ipcRenderer.invoke('excalidraw-get-context'),
  submitPng: (payload) => ipcRenderer.invoke('excalidraw-submit-png', payload),
  cancel: () => ipcRenderer.invoke('excalidraw-cancel')
});
