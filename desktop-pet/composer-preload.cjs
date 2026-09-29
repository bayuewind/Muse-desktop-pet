'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('composer', Object.freeze({
  state: () => ipcRenderer.invoke('composer:state'),
  send: draft => ipcRenderer.invoke('composer:send', draft),
  hide: () => ipcRenderer.send('composer:hide'),
  microphone: () => ipcRenderer.invoke('composer:microphone'),
  transcribe: audio => ipcRenderer.invoke('composer:transcribe', audio),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('pet:state', listener); return () => ipcRenderer.removeListener('pet:state', listener);
  },
  onHidden: callback => {
    const listener = () => callback();
    ipcRenderer.on('composer:hidden', listener); return () => ipcRenderer.removeListener('composer:hidden', listener);
  },
  onFocus: callback => {
    const listener = () => callback();
    ipcRenderer.on('composer:focus', listener); return () => ipcRenderer.removeListener('composer:focus', listener);
  },
}));
