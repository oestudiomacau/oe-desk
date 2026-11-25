const { contextBridge, ipcRenderer } = require('electron');

// The platform page never receives ipcRenderer. It gets narrow request/input
// functions; the main process validates both before touching the webContents.
contextBridge.exposeInMainWorld('rcbPlatformRequest', payload => ipcRenderer.invoke('xianyu:request', payload));
contextBridge.exposeInMainWorld('rcbPlatformSendInput', payload => ipcRenderer.invoke('xianyu:input', payload));
contextBridge.exposeInMainWorld('rcbPlatformBeginDeliveryAttempt', payload => ipcRenderer.invoke('xianyu:delivery-begin', payload));
contextBridge.exposeInMainWorld('rcbPlatformDeliveryEvidence', payload => ipcRenderer.invoke('xianyu:delivery-query', payload));
contextBridge.exposeInMainWorld('rcbPlatformFinishDeliveryAttempt', payload => ipcRenderer.invoke('xianyu:delivery-finish', payload));
if (location.origin === 'https://im.jinritemai.com') {
  contextBridge.exposeInMainWorld('rcbFeigeRequest', payload => ipcRenderer.invoke('feige:request', payload));
}
