const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('excalidrawBridge', {
  getContext: () => ipcRenderer.invoke('excalidraw-get-context'),
  submitPng: (payload) => ipcRenderer.invoke('excalidraw-submit-png', payload),
  cancel: () => ipcRenderer.invoke('excalidraw-cancel'),
  onAddLibrary: (callback) => {
    const handler = (_e, data) => {
      try { callback(data); } catch (_) {}
    };
    ipcRenderer.on('excalidraw-add-library', handler);
    return () => ipcRenderer.removeListener('excalidraw-add-library', handler);
  }
});
