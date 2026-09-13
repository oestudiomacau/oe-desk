const { contextBridge, ipcRenderer } = require('electron');

// The platform page never receives ipcRenderer. It gets narrow request/input
// functions; the main process validates both before touching the webContents.
contextBridge.exposeInMainWorld('rcbPlatformRequest', payload => ipcRenderer.invoke('xianyu:request', payload));
contextBridge.exposeInMainWorld('rcbPlatformSendInput', payload => ipcRenderer.invoke('xianyu:input', payload));
