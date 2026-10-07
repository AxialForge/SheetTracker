'use strict';
const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

contextBridge.exposeInMainWorld('api', {
  call: (method, ...args) => ipcRenderer.invoke('api', method, args).then((r) => { if (!r.ok) throw new Error(r.error); return r.value; }),
  main: (name, ...args) => call(name, ...args),
  onUpdate: (cb) => ipcRenderer.on('update:status', (_e, st) => cb(st)),
  onAutoReport: (cb) => ipcRenderer.on('report:auto', (_e, file) => cb(file)),
});
