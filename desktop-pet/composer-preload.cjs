'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('composer', Object.freeze({
  state: () => ipcRenderer.invoke('composer:state'),
  send: draft => ipcRenderer.invoke('composer:send', draft),
  hide: () => ipcRenderer.send('composer:hide'),
  accountMenu: () => ipcRenderer.send('composer:account-menu'),
  microphone: () => ipcRenderer.invoke('composer:microphone'),
  transcribe: audio => ipcRenderer.invoke('composer:transcribe', audio),
  replies: () => ipcRenderer.invoke('composer:replies'),
  refreshReplies: () => ipcRenderer.invoke('composer:refresh-replies'),
  markRead: () => ipcRenderer.send('composer:read-replies'),
  attachment: (messageId, assetId) => ipcRenderer.invoke('composer:attachment', { messageId, assetId }),
  saveAttachment: (messageId, assetId) => ipcRenderer.invoke('composer:save-attachment', { messageId, assetId }),
  copyCode: (messageId, index) => ipcRenderer.invoke('composer:copy-code', { messageId, index }),
  onReplies: callback => {
    const listener = (_event, replies) => callback(replies);
    ipcRenderer.on('composer:replies', listener); return () => ipcRenderer.removeListener('composer:replies', listener);
  },
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
