'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', Object.freeze({
  openMuse: () => ipcRenderer.send('pet:open-muse'),
  hide: () => ipcRenderer.send('pet:hide'),
  compose: () => ipcRenderer.send('pet:compose'),
  onUnread: callback => {
    const listener = (_event, count) => callback(count);
    ipcRenderer.on('pet:unread', listener); return () => ipcRenderer.removeListener('pet:unread', listener);
  },
  getState: () => ipcRenderer.invoke('pet:get-state'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('pet:state', listener);
    return () => ipcRenderer.removeListener('pet:state', listener);
  },
}));
