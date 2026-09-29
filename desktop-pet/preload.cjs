'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', Object.freeze({
  openMuse: () => ipcRenderer.send('pet:open-muse'),
  hide: () => ipcRenderer.send('pet:hide'),
  getState: () => ipcRenderer.invoke('pet:get-state'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('pet:state', listener);
    return () => ipcRenderer.removeListener('pet:state', listener);
  },
}));
