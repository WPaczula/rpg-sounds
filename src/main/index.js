import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  Panel, KEY_COUNT, COLS, ROWS, KEY_W, KEY_H,
  TAB_UP_INDEX, TAB_DOWN_INDEX, SIDE_INDEXES, SOUND_INDEXES, STOP_INDEX,
} from './device.js'
import * as config from './config.js'

const here = dirname(fileURLToPath(import.meta.url))

let win = null
let panel = null
let state = config.load()

// The panel keeps emitting key and status events on its own timers, so they
// land whenever they land — including while the window is reloading, quitting
// or recovering from a crash, when the render frame is already gone. Sending
// then is not catchable: Electron logs "Render frame was disposed" from inside
// webContents.send and swallows it, so the only way to stay quiet is to know
// whether the renderer can receive before calling.
let rendererReady = false

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

  const wc = win.webContents
  wc.on('did-start-loading', () => { rendererReady = false })
  wc.on('render-process-gone', () => { rendererReady = false })
  win.on('closed', () => {
    win = null
    rendererReady = false
  })

  win.loadFile(join(here, '..', 'renderer', 'index.html'))
}

function send(channel, ...args) {
  if (!rendererReady || !win || win.isDestroyed()) return
  const wc = win.webContents
  if (wc.isDestroyed() || wc.isCrashed()) return
  // A renderer can die a few events before render-process-gone arrives, so the
  // flags above still read healthy for a moment; ask the frame itself as well.
  let frame
  try {
    frame = wc.mainFrame
  } catch {
    return
  }
  if (!frame || frame.isDestroyed()) return
  frame.send(channel, ...args)
}

app.whenReady().then(() => {
  createWindow()

  panel = new Panel()
  panel.on('key', (index) => send('key', index))
  panel.on('status', (s) => send('status', s))
  panel.setBrightness(state.device?.brightness ?? 60)
  panel.open()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => panel?.close())

// The renderer subscribes to key and status events before it asks for state, so
// this request is exactly the moment it becomes reachable — and it carries the
// current connection state, so nothing missed while it was away needs replaying.
ipcMain.handle('get-state', () => {
  rendererReady = true
  return {
    config: state,
    layout: {
      keyCount: KEY_COUNT,
      cols: COLS,
      rows: ROWS,
      keyW: KEY_W,
      keyH: KEY_H,
      tabUpIndex: TAB_UP_INDEX,
      tabDownIndex: TAB_DOWN_INDEX,
      sideIndexes: SIDE_INDEXES,
      soundIndexes: SOUND_INDEXES,
      stopIndex: STOP_INDEX,
    },
    connected: panel?.connected ?? false,
    configPath: config.CONFIG_PATH,
  }
})

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

// The renderer streams audio straight off disk, so it never asks us for bytes —
// only for whether a file is still there, so it can grey out a dead key.
ipcMain.handle('sound-exists', async (_e, path) => {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
})

ipcMain.handle('open-input-monitoring', () =>
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent'),
)

ipcMain.handle('open-config', () => shell.showItemInFolder(config.CONFIG_PATH))
