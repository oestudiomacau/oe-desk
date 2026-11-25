const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('oeProfile', {
  unlock: password => ipcRenderer.invoke('workbench:unlock-private-profile', password)
});
