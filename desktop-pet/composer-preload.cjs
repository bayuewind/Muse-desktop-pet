'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('composer', Object.freeze({
  state: () => ipcRenderer.invoke('composer:state'),
  sessions: () => ipcRenderer.invoke('composer:sessions'),
  refreshSessions: () => ipcRenderer.invoke('composer:refresh-sessions'),
  selectSession: id => ipcRenderer.invoke('composer:select-session', id),
  onSessions: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('composer:sessions', listener); return () => ipcRenderer.removeListener('composer:sessions', listener);
  },
  workspace: () => ipcRenderer.invoke('composer:workspace'),
  refreshWorkspace: () => ipcRenderer.invoke('composer:refresh-workspace'),
  spaces: () => ipcRenderer.invoke('composer:spaces'),
  refreshSpaces: () => ipcRenderer.invoke('composer:refresh-spaces'),
  onSpaces: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('composer:spaces', listener); return () => ipcRenderer.removeListener('composer:spaces', listener);
  },
  preferences: () => ipcRenderer.invoke('composer:preferences'),
  setPreferences: patch => ipcRenderer.invoke('composer:set-preferences', patch),
  officialPage: key => ipcRenderer.invoke('composer:official-page', key),
  onWorkspace: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('composer:workspace', listener); return () => ipcRenderer.removeListener('composer:workspace', listener);
  },
  onView: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('composer:view', listener); return () => ipcRenderer.removeListener('composer:view', listener);
  },
  send: draft => ipcRenderer.invoke('composer:send', draft),
  inputList: () => ipcRenderer.invoke('composer:input-list'),
  inputSelect: () => ipcRenderer.invoke('composer:input-select'),
  inputStage: file => ipcRenderer.invoke('composer:input-stage', file),
  inputRemove: id => ipcRenderer.invoke('composer:input-remove', id),
  inputPreview: id => ipcRenderer.invoke('composer:input-preview', id),
  capture: () => ipcRenderer.invoke('composer:capture'),
  hide: () => ipcRenderer.send('composer:hide'),
  accountMenu: () => ipcRenderer.send('composer:account-menu'),
  transitionDone: id => ipcRenderer.send('composer:transition-done', id),
  onTransition: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('composer:transition', listener); return () => ipcRenderer.removeListener('composer:transition', listener);
  },
  microphone: () => ipcRenderer.invoke('composer:microphone'),
  cancelVoice: () => ipcRenderer.send('composer:cancel-voice'),
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
