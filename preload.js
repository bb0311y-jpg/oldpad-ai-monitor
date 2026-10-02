'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 畫面（renderer）只能透過這個白名單 API 跟主程序溝通
const EVENTS = new Set(['usage:update', 'accounts:changed', 'settings:changed', 'auth:auto', 'lan:changed', 'update:state']);

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),

  beginAuth: (accountId, provider) => ipcRenderer.invoke('auth:begin', { accountId, provider }),
  copyAuthUrl: (authId) => ipcRenderer.invoke('auth:copyUrl', { authId }),
  cancelAuth: (authId) => ipcRenderer.invoke('auth:cancel', { authId }),
  completeAuth: (authId, pastedCode) => ipcRenderer.invoke('auth:complete', { authId, pastedCode }),

  renameAccount: (id, label) => ipcRenderer.invoke('account:rename', { id, label }),
  removeAccount: (id) => ipcRenderer.invoke('account:remove', { id }),
  reorderAccounts: (ids) => ipcRenderer.invoke('account:reorder', { ids }),
  setAccountCollapsed: (id, collapsed) => ipcRenderer.invoke('account:setCollapsed', { id, collapsed }),
  addDemoAccount: () => ipcRenderer.invoke('demo:add'),

  refreshUsage: (accountId) => ipcRenderer.invoke('usage:refresh', { accountId }),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  getLanInfo: () => ipcRenderer.invoke('lan:info'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  copyLanUrl: () => ipcRenderer.invoke('lan:copyUrl'),

  setWindowHeight: (h) => ipcRenderer.invoke('window:setHeight', h),
  resizeDrag: (phase, dx, dy) => ipcRenderer.invoke('window:resizeDrag', { phase, dx, dy }),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  quitApp: () => ipcRenderer.invoke('window:quit'),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),

  on: (channel, callback) => {
    if (!EVENTS.has(channel)) return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
