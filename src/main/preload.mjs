import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('gk150', {
  getState: () => ipcRenderer.invoke('get-state'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  setBrightness: (pct) => ipcRenderer.invoke('set-brightness', pct),
  pickSound: () => ipcRenderer.invoke('pick-sound'),
  pushImages: (images) => ipcRenderer.invoke('push-images', images),
  soundExists: (path) => ipcRenderer.invoke('sound-exists', path),
  openInputMonitoring: () => ipcRenderer.invoke('open-input-monitoring'),
  openConfig: () => ipcRenderer.invoke('open-config'),

  onKey: (fn) => ipcRenderer.on('key', (_e, index) => fn(index)),
  onStatus: (fn) => ipcRenderer.on('status', (_e, s) => fn(s)),
})
