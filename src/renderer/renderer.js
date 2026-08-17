const api = window.gk150

let cfg = null
let layout = null
let tabUpIdx = -1 // panel index of the "previous tab" arrow key
let tabDownIdx = -1 // panel index of the "next tab" arrow key
let sideIdx = [] // output-only LCD strip: [above, active, below] tab names
let stopIdx = -1 // panel index of the stop-everything key
let selected = null // { kind: 'key' | 'tab', index, tab }

const grid = document.getElementById('grid')
const editor = document.getElementById('editor')
const editorTitle = document.getElementById('editorTitle')
const keyFields = document.getElementById('keyFields')
const tabFields = document.getElementById('tabFields')
const labelInput = document.getElementById('labelInput')
const tabNameInput = document.getElementById('tabNameInput')
const loopToggle = document.getElementById('loopToggle')
const sndPath = document.getElementById('sndPath')
const statusEl = document.getElementById('status')
const brightness = document.getElementById('brightness')
const brightnessVal = document.getElementById('brightnessVal')

const isTabUp = (i) => i === tabUpIdx
const isTabDown = (i) => i === tabDownIdx
const isSide = (i) => sideIdx.includes(i)
const isStop = (i) => i === stopIdx
const prevTab = () => (cfg.activeTab - 1 + cfg.tabs.length) % cfg.tabs.length
const nextTab = () => (cfg.activeTab + 1) % cfg.tabs.length
const activeTab = () => cfg.tabs[cfg.activeTab]
const keyCfg = (i, tab = cfg.activeTab) => cfg.tabs[tab]?.keys?.[i]

const save = () => api.saveConfig(cfg)

// ---------------------------------------------------------------- audio ----

// Sounds stream from disk through media elements rather than being decoded
// into AudioBuffers. That is not a style choice: an hour of ambience decodes to
// ~1.3 GB of PCM, so preloading one tab of them was allocating ~16 GB and
// killing the renderer outright — which blanks the window and the panel with it.
const missing = new Set() // paths that would not play

// Any number of loops can run at once, across any tabs.
const loops = new Map() // "tab:index" -> { tab, index, el }

// One-shots are fire-and-forget, but the stop key has to be able to cut them,
// so keep the live ones until they end on their own.
const oneShots = new Set()

const loopKey = (tab, index) => `${tab}:${index}`
const isLooping = (index, tab = cfg.activeTab) => loops.has(loopKey(tab, index))

// Sound names carry spaces, ampersands and fullwidth bars, so every segment has
// to be escaped before it can go in a URL.
const fileUrl = (path) => `file://${path.split('/').map(encodeURIComponent).join('/')}`

function setMissing(path, gone) {
  if (missing.has(path) === gone) return
  if (gone) missing.add(path)
  else missing.delete(path)
  render()
}

function play(path, { loop }) {
  const el = new Audio(fileUrl(path))
  el.loop = loop
  const failed = (reason) => {
    // Tearing an element down raises an error too; only a live one means trouble.
    if (el.dataset.disposed) return
    console.warn(`cannot play ${path}: ${reason}`)
    setMissing(path, true)
  }
  el.addEventListener('error', () => failed(el.error?.message ?? 'unknown error'))
  // Clear a stale "missing" mark only once sound is genuinely coming out, so a
  // key that still can't play never flickers back to looking healthy.
  el.addEventListener('playing', () => setMissing(path, false))
  el.play().catch((err) => failed(err.message))
  return el
}

/** Stops an element and lets go of its buffers instead of waiting on the GC. */
function dispose(el) {
  el.dataset.disposed = '1'
  el.pause()
  el.removeAttribute('src')
  el.load()
}

/** Stops one loop by tab/index. Returns the key it was on, if any. */
function stopLoop(tab, index) {
  const key = loopKey(tab, index)
  const entry = loops.get(key)
  if (!entry) return null
  dispose(entry.el)
  loops.delete(key)
  return { tab, index }
}

function startLoop(tab, index, path) {
  loops.set(loopKey(tab, index), { tab, index, el: play(path, { loop: true }) })
}

/** One-shots layer on top; a loop key toggles just that loop on and off. */
async function trigger(index) {
  const k = keyCfg(index)
  if (!k?.sound) return

  if (k.loop) {
    const tab = cfg.activeTab
    if (isLooping(index, tab)) stopLoop(tab, index)
    else startLoop(tab, index, k.sound)

    render()
    await pushKeys([index])
    return
  }

  const el = play(k.sound, { loop: false })
  el.addEventListener('ended', () => {
    oneShots.delete(el)
    dispose(el)
  })
  oneShots.add(el)
}

/** Everything off: every running loop and every one-shot still sounding. */
async function stopEverything() {
  const stoppedOnActiveTab = []
  for (const { tab, index, el } of loops.values()) {
    dispose(el)
    if (tab === cfg.activeTab) stoppedOnActiveTab.push(index)
  }
  loops.clear()
  for (const el of oneShots) dispose(el)
  oneShots.clear()
  render()
  if (stoppedOnActiveTab.length) await pushKeys(stoppedOnActiveTab)
}

/** Streaming needs no preload, so a tab only has to be checked for gaps. */
async function checkTab(tab) {
  const paths = new Set()
  for (const k of Object.values(cfg.tabs[tab]?.keys ?? {})) if (k.sound) paths.add(k.sound)
  const checked = await Promise.all([...paths].map(async (p) => [p, await api.soundExists(p)]))
  for (const [path, ok] of checked) {
    if (ok) missing.delete(path)
    else missing.add(path)
  }
}

// ---------------------------------------------------------------- images ---

const STYLE = {
  idle: { bg: '#101820', fg: '#ffffff' },
  loop: { bg: '#101820', fg: '#ffffff', bar: '#5b8cff' },
  playing: { bg: '#f2c318', fg: '#000000' },
  arrow: { bg: '#101820', fg: '#8b929e' },
  lcdSide: { bg: '#0b0d10', fg: '#5a616d' },
  lcdActive: { bg: '#0b0d10', fg: '#ffffff' },
  // The panel is always backlit, so a fully black image is as close to "off"
  // as the hardware allows.
  off: { bg: '#000000', fg: '#000000' },
  // Kept dark and neutral rather than red — a hard red stop key reads as an
  // alarm, which is the wrong tone for muting a soundboard.
  stop: { bg: '#101820', fg: '#ffffff' },
}

// The panel expects each key image rotated 270 degrees clockwise. Verified on
// the hardware: sharp's rotate(90)+flip+flop is equivalent, and rendered upright.
function renderKeyJpeg(text, style) {
  const { keyW, keyH } = layout
  const c = document.createElement('canvas')
  c.width = keyW
  c.height = keyH
  const g = c.getContext('2d')

  g.translate(keyW / 2, keyH / 2)
  g.rotate((270 * Math.PI) / 180)
  g.translate(-keyW / 2, -keyH / 2)

  g.fillStyle = style.bg
  g.fillRect(0, 0, keyW, keyH)

  if (text) {
    g.fillStyle = style.fg
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    for (let size = 22; size >= 9; size--) {
      g.font = `600 ${size}px -apple-system, Helvetica, Arial, sans-serif`
      const lines = wrap(g, text, keyW - 8, 3)
      if (!lines) continue
      const lh = size * 1.15
      const start = keyH / 2 - ((lines.length - 1) * lh) / 2
      lines.forEach((line, i) => g.fillText(line, keyW / 2, start + i * lh))
      break
    }
  }

  if (style.bar) {
    g.fillStyle = style.bar
    g.fillRect(6, keyH - 10, keyW - 12, 4)
  }

  const b64 = c.toDataURL('image/jpeg', 0.9).split(',')[1]
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function wrap(g, text, maxW, maxLines) {
  const words = text.split(/\s+/)
  const lines = []
  let line = ''
  for (const w of words) {
    const probe = line ? `${line} ${w}` : w
    if (g.measureText(probe).width <= maxW) {
      line = probe
    } else {
      if (line) lines.push(line)
      if (g.measureText(w).width > maxW) return null
      line = w
    }
    if (lines.length >= maxLines) return null
  }
  if (line) lines.push(line)
  return lines.length <= maxLines ? lines : null
}

function styleFor(i) {
  if (isSide(i)) return sideIdx.indexOf(i) === 1 ? STYLE.lcdActive : STYLE.lcdSide
  if (isStop(i)) return STYLE.stop
  if (isTabUp(i) || isTabDown(i)) return STYLE.arrow
  const k = keyCfg(i)
  if (!k) return STYLE.idle
  if (k.loop && isLooping(i)) return STYLE.playing
  if (k.loop) return STYLE.loop
  return STYLE.idle
}

function textFor(i) {
  if (isSide(i)) {
    const slot = sideIdx.indexOf(i)
    if (slot === 0) return cfg.tabs[prevTab()]?.name ?? ''
    if (slot === 2) return cfg.tabs[nextTab()]?.name ?? ''
    return activeTab()?.name ?? ''
  }
  if (isStop(i)) return '⏹️'
  if (isTabUp(i)) return '⬆️'
  if (isTabDown(i)) return '⬇️'
  return keyCfg(i)?.label ?? ''
}

async function pushKeys(indexes) {
  const res = await api.pushImages(
    indexes.map((i) => ({ index: i, jpeg: renderKeyJpeg(textFor(i), styleFor(i)) })),
  )
  if (!res.ok) console.warn(`image push failed: ${res.error}`)
}

const pushAll = () => pushKeys([...Array(layout.keyCount).keys()])
const refreshKey = (i) => pushKeys([i])

// ------------------------------------------------------------------- ui ----

function render() {
  grid.innerHTML = ''
  for (let i = 0; i < layout.keyCount; i++) {
    const cell = document.createElement('div')
    cell.className = 'cell'
    cell.dataset.index = i

    if (selected?.index === i) cell.classList.add('selected')

    if (isSide(i)) {
      const slot = sideIdx.indexOf(i)
      cell.classList.add('lcd')
      if (slot === 1) cell.classList.add('active')
      const name = document.createElement('div')
      name.className = 'label'
      name.textContent = slot === 0 ? cfg.tabs[prevTab()]?.name ?? '' : slot === 2 ? cfg.tabs[nextTab()]?.name ?? '' : activeTab()?.name ?? ''
      cell.appendChild(name)
      const sub = document.createElement('div')
      sub.className = 'idx'
      sub.textContent = slot === 0 ? 'tab above' : slot === 2 ? 'tab below' : 'current tab'
      cell.appendChild(sub)
      if (slot === 1) cell.addEventListener('click', () => select(i))
      else cell.addEventListener('click', () => switchTab(slot === 0 ? prevTab() : nextTab()))
      grid.appendChild(cell)
      continue
    }

    if (isStop(i)) {
      cell.classList.add('stopkey')
      const name = document.createElement('div')
      name.className = 'label'
      name.textContent = '⏹️'
      cell.appendChild(name)
      const sub = document.createElement('div')
      sub.className = 'idx'
      sub.textContent = 'stop all'
      cell.appendChild(sub)
      cell.addEventListener('click', () => stopEverything())
      grid.appendChild(cell)
      continue
    }

    if (isTabUp(i) || isTabDown(i)) {
      cell.classList.add('arrow')
      const name = document.createElement('div')
      name.className = 'label'
      name.textContent = isTabUp(i) ? '⬆️' : '⬇️'
      cell.appendChild(name)
      const sub = document.createElement('div')
      sub.className = 'idx'
      sub.textContent = isTabUp(i) ? 'prev tab' : 'next tab'
      cell.appendChild(sub)
      cell.addEventListener('click', () => switchTab(isTabUp(i) ? prevTab() : nextTab()))
      grid.appendChild(cell)
      continue
    }

    const k = keyCfg(i)
    if (k?.loop) cell.classList.add('loop')
    if (k?.loop && isLooping(i)) cell.classList.add('playing')
    if (k?.sound && missing.has(k.sound)) cell.classList.add('missing')

    const label = document.createElement('div')
    label.className = 'label'
    label.textContent = k?.label ?? ''
    cell.appendChild(label)

    if (k?.sound) {
      const snd = document.createElement('div')
      snd.className = 'snd'
      snd.textContent = k.sound.split('/').pop()
      cell.appendChild(snd)
    }

    const idx = document.createElement('div')
    idx.className = 'idx'
    idx.textContent = k?.loop ? 'loop' : ''
    cell.appendChild(idx)

    cell.addEventListener('click', () => select(i))
    grid.appendChild(cell)
  }
}

function select(i) {
  if (isStop(i)) return
  editor.classList.remove('hidden')
  if (isSide(i)) {
    // Only the middle LCD cell (the active tab) is selectable; it opens the
    // rename field for whichever tab is currently active.
    selected = { kind: 'tab', index: i, tab: cfg.activeTab }
    editorTitle.textContent = `Tab ${cfg.activeTab + 1}`
    keyFields.classList.add('hidden')
    tabFields.classList.remove('hidden')
    tabNameInput.value = activeTab()?.name ?? ''
  } else {
    selected = { kind: 'key', index: i, tab: cfg.activeTab }
    const k = keyCfg(i) ?? {}
    editorTitle.textContent = `${activeTab().name} — key ${i}`
    tabFields.classList.add('hidden')
    keyFields.classList.remove('hidden')
    labelInput.value = k.label ?? ''
    loopToggle.checked = !!k.loop
    sndPath.textContent = k.sound ?? 'No sound assigned'
  }
  render()
}

function flash(i) {
  const cell = grid.querySelector(`[data-index="${i}"]`)
  if (!cell) return
  cell.classList.add('flash')
  setTimeout(() => cell.classList.remove('flash'), 120)
}

async function switchTab(tab) {
  if (tab === cfg.activeTab) return
  cfg.activeTab = tab
  save()
  await checkTab(tab)
  // Loops keep running across tab switches, so ambience survives a hop to
  // another tab; their key lights up again when you come back.
  if (selected?.kind === 'key') selected = null
  editor.classList.add('hidden')
  render()
  await pushAll()
}

function patchKey(patch) {
  const keys = activeTab().keys
  const next = { ...(keys[selected.index] ?? {}), ...patch }
  for (const [k, v] of Object.entries(next)) {
    if (v === null || v === '' || v === false) delete next[k]
  }
  if (Object.keys(next).length === 0) delete keys[selected.index]
  else keys[selected.index] = next
  save()
}

// --------------------------------------------------------------- events ----

labelInput.addEventListener('change', () => {
  if (selected?.kind !== 'key') return
  patchKey({ label: labelInput.value.trim() })
  render()
  refreshKey(selected.index)
})

tabNameInput.addEventListener('change', () => {
  if (selected?.kind !== 'tab') return
  cfg.tabs[selected.tab].name = tabNameInput.value.trim() || `Tab ${selected.tab + 1}`
  save()
  render()
  refreshKey(selected.index)
})

loopToggle.addEventListener('change', () => {
  if (selected?.kind !== 'key') return
  if (!loopToggle.checked && isLooping(selected.index)) stopLoop(cfg.activeTab, selected.index)
  patchKey({ loop: loopToggle.checked })
  render()
  refreshKey(selected.index)
})

document.getElementById('pickBtn').addEventListener('click', async () => {
  if (selected?.kind !== 'key') return
  const path = await api.pickSound()
  if (!path) return
  if (isLooping(selected.index)) stopLoop(cfg.activeTab, selected.index)
  patchKey({ sound: path })
  missing.delete(path)
  sndPath.textContent = path
  render()
})

document.getElementById('testBtn').addEventListener('click', () => {
  if (selected?.kind === 'key') trigger(selected.index)
})

document.getElementById('clearBtn').addEventListener('click', () => {
  if (selected?.kind !== 'key') return
  if (isLooping(selected.index)) stopLoop(cfg.activeTab, selected.index)
  delete activeTab().keys[selected.index]
  save()
  labelInput.value = ''
  loopToggle.checked = false
  sndPath.textContent = 'No sound assigned'
  render()
  refreshKey(selected.index)
})

document.getElementById('stopAllBtn').addEventListener('click', () => stopEverything())

brightness.addEventListener('input', () => {
  brightnessVal.textContent = brightness.value
  api.setBrightness(Number(brightness.value))
  cfg.device = { ...cfg.device, brightness: Number(brightness.value) }
  save()
})

document.getElementById('cfgBtn').addEventListener('click', () => api.openConfig())

api.onKey((index) => {
  if (isSide(index)) return
  flash(index)
  if (isStop(index)) stopEverything()
  else if (isTabUp(index)) switchTab(prevTab())
  else if (isTabDown(index)) switchTab(nextTab())
  else trigger(index)
})

api.onStatus(({ connected, message }) => {
  setStatus(connected, message)
  // The panel wakes and clears itself on every (re)connect, so whatever we
  // pushed before that moment is gone — repaint once it's back.
  if (connected && cfg) pushAll()
})

function setStatus(connected, message) {
  statusEl.className = connected ? 'good' : 'bad'
  statusEl.textContent = message
  if (connected) {
    const hint = document.createElement('span')
    hint.style.color = '#8b929e'
    hint.textContent = '  — if key presses do nothing, grant Input Monitoring to this app.'
    statusEl.appendChild(hint)
    const btn = document.createElement('button')
    btn.textContent = 'Open settings'
    btn.onclick = () => api.openInputMonitoring()
    statusEl.appendChild(btn)
  }
}

// ----------------------------------------------------------------- init ----

const state = await api.getState()
cfg = state.config
layout = state.layout
tabUpIdx = layout.tabUpIndex
tabDownIdx = layout.tabDownIndex
sideIdx = layout.sideIndexes
stopIdx = layout.stopIndex
brightness.value = cfg.device?.brightness ?? 60
brightnessVal.textContent = brightness.value
setStatus(state.connected, state.connected ? 'Connected' : 'Panel not found')
render()
await checkTab(cfg.activeTab)
render()
await pushAll()
