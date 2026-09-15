const { contextBridge, ipcRenderer } = require('electron');

// The local renderer only receives an intentionally small control surface.  It
// cannot access Electron or arbitrary IPC channels directly.
contextBridge.exposeInMainWorld('rcbElectron', {
  isElectron: true,
  openPlatform: (platform = 'xianyu', storeId = platform) => ipcRenderer.invoke('platform:open', { platform, storeId }),
  openXianyu: (storeId = 'default') => ipcRenderer.invoke('xianyu:open', { storeId }),
  hideXianyu: () => ipcRenderer.invoke('xianyu:hide'),
  closeXianyu: () => ipcRenderer.invoke('xianyu:close'),
  layoutXianyu: () => ipcRenderer.invoke('xianyu:layout'),
  refreshXianyu: () => ipcRenderer.invoke('xianyu:refresh'),
  goBackXianyu: () => ipcRenderer.invoke('xianyu:back'),
  goForwardXianyu: () => ipcRenderer.invoke('xianyu:forward'),
  getXianyuSession: () => ipcRenderer.invoke('xianyu:session'),
  onXianyuState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('xianyu:state', listener);
    return () => ipcRenderer.removeListener('xianyu:state', listener);
  }
});
