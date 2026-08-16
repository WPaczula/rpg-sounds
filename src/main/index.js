import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  Panel, KEY_COUNT, COLS, ROWS, KEY_W, KEY_H,
  TAB_INDEXES, SIDE_INDEXES, SOUND_INDEXES, STOP_INDEX,
} from './device.js'
import * as config from './config.js'

const here = dirname(fileURLToPath(import.meta.url))

let win = null
let panel = null
let state = config.load()

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 720,
    title: 'GK150 Soundboard',
    backgroundColor: '#14161a',
    webPreferences: {
      preload: join(here, 'preload.mjs'),
      contextIsolation: true,
      sandbox: false,
    },
  })
  win.loadFile(join(here, '..', 'renderer', 'index.html'))
}

app.whenReady().then(() => {
  createWindow()

  panel = new Panel()
  panel.on('key', (index) => win?.webContents.send('key', index))
  panel.on('status', (s) => win?.webContents.send('status', s))
  panel.setBrightness(state.device?.brightness ?? 60)
  panel.open()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => panel?.close())

ipcMain.handle('get-state', () => ({
  config: state,
  layout: {
    keyCount: KEY_COUNT,
    cols: COLS,
    rows: ROWS,
    keyW: KEY_W,
    keyH: KEY_H,
    tabIndexes: TAB_INDEXES,
    sideIndexes: SIDE_INDEXES,
    soundIndexes: SOUND_INDEXES,
    stopIndex: STOP_INDEX,
  },
  connected: panel?.connected ?? false,
  configPath: config.CONFIG_PATH,
}))

ipcMain.handle('save-config', (_e, next) => {
  state = next
  config.save(state)
})

ipcMain.handle('set-brightness', (_e, pct) => panel?.setBrightness(pct))

ipcMain.handle('pick-sound', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a sound',
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac'] }],
  })
  return res.canceled ? null : res.filePaths[0]
})

// The renderer draws key labels on a canvas and hands us raw JPEG bytes, so we
// need no native image library at all.
ipcMain.handle('push-images', (_e, images) => {
  if (!panel?.connected) return { ok: false, error: 'panel not connected' }
  try {
    for (const { index, jpeg } of images) {
      panel.setKeyImage(index, Buffer.from(jpeg))
    }
    panel.flush()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('read-sound', async (_e, path) => {
  try {
    const buf = await readFile(path)
    return { ok: true, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('open-input-monitoring', () =>
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent'),
)

ipcMain.handle('open-config', () => shell.showItemInFolder(config.CONFIG_PATH))
