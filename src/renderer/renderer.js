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
const presetFields = document.getElementById('presetFields')
const presetNameInput = document.getElementById('presetNameInput')
const presetMembers = document.getElementById('presetMembers')
const presetLibrary = document.getElementById('presetLibrary')
const presetSearch = document.getElementById('presetSearch')
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

// Any number of loops can run at once, across any tabs. They are keyed by
// sound path rather than by key: a preset and the key it borrowed a sound from
// then share one playing loop, so the same file can never stack over itself and
// both keys light up together.
const loops = new Map() // sound path -> element

// One-shots are fire-and-forget, but the stop key has to be able to cut them,
// so keep the live ones until they end on their own.
const oneShots = new Set()

const isLooping = (index, tab = cfg.activeTab) => {
  const sound = keyCfg(index, tab)?.sound
  return !!sound && loops.has(sound)
}

// Sound names carry spaces, ampersands and fullwidth bars, so every segment has
// to be escaped before it can go in a URL.
const fileUrl = (path) => `file://${path.split('/').map(encodeURIComponent).join('/')}`

function setMissing(path, gone) {
  if (missing.has(path) === gone) return
  if (gone) missing.add(path)
  else missing.delete(path)
  render()
}

function play(path, { loop, volume = 1 }) {
  const el = new Audio(fileUrl(path))
  el.loop = loop
  el.volume = clampVol(volume)
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

const clampVol = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 1))

/**
 * Starts a looping sound unless it is already running. A path already playing
 * still takes the new volume, so re-pressing a preset re-asserts its mix.
 */
function startPath(path, volume = 1) {
  const running = loops.get(path)
  if (running) {
    running.volume = clampVol(volume)
    return false
  }
  loops.set(path, play(path, { loop: true, volume }))
  return true
}

/** Live volume change for a sound that may or may not be playing right now. */
function setPathVolume(path, volume) {
  const el = loops.get(path)
  if (el) el.volume = clampVol(volume)
}

function stopPath(path) {
  const el = loops.get(path)
  if (!el) return false
  dispose(el)
  loops.delete(path)
  return true
}

const stopKeyLoop = (index, tab = cfg.activeTab) => {
  const sound = keyCfg(index, tab)?.sound
  if (sound) stopPath(sound)
}

/**
 * Keys on the active tab whose appearance depends on any of these paths —
 * the key that owns the sound, and every preset that layers it.
 */
function dirtyKeys(paths) {
  const changed = new Set(paths)
  const dirty = []
  for (const [i, k] of Object.entries(activeTab()?.keys ?? {})) {
    const touched =
      (k.sound && changed.has(k.sound)) || (k.preset ?? []).some((m) => changed.has(m.sound))
    if (touched) dirty.push(Number(i))
  }
  return dirty
}

/** One-shots layer on top; a loop key toggles just that loop on and off. */
async function trigger(index) {
  const k = keyCfg(index)
  if (isPresetTab() ? !presetLayers(k).length : !k?.sound) return

  if (isPresetTab()) {
    await togglePreset(k)
    return
  }

  if (k.loop) {
    if (loops.has(k.sound)) stopPath(k.sound)
    else startPath(k.sound)

    render()
    await pushKeys(dirtyKeys([k.sound]))
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
  const stopped = [...loops.keys()]
  for (const el of loops.values()) dispose(el)
  loops.clear()
  for (const el of oneShots) dispose(el)
  oneShots.clear()
  render()
  if (stopped.length) await pushKeys(dirtyKeys(stopped))
}

// -------------------------------------------------------------- presets ----

const isPresetTab = (tab = cfg.activeTab) => !!cfg.tabs[tab]?.presets
const presetLayers = (k) => k?.preset ?? []

// Layers written before per-layer volume existed carry none; those play full.
const layerVol = (m) => clampVol(m.volume ?? 1)

/** A preset reads as "on" only once every layer it names is sounding. */
const presetActive = (k) => {
  const layers = presetLayers(k)
  return layers.length > 0 && layers.every((m) => loops.has(m.sound))
}

/**
 * Presets add to whatever is already playing rather than replacing it, so two
 * scenes can be stacked (rain over a tavern) and peeled off one at a time.
 */
async function togglePreset(k) {
  const layers = presetLayers(k)
  if (!layers.length) return
  const on = !presetActive(k)
  const changed = []
  for (const m of layers) {
    if (on ? startPath(m.sound, layerVol(m)) : stopPath(m.sound)) changed.push(m.sound)
  }
  render()
  if (changed.length) await pushKeys(dirtyKeys(changed))
}

/** Every sound bound to a key on a normal tab, as preset-building material. */
function library() {
  const out = []
  for (const tab of cfg.tabs) {
    if (tab.presets) continue
    for (const [i, k] of Object.entries(tab.keys ?? {})) {
      if (k.sound) out.push({ tab: tab.name, label: k.label || `key ${i}`, sound: k.sound })
    }
  }
  return out
}

const layerLabel = (path) =>
  library().find((e) => e.sound === path)?.label ?? path.split('/').pop()

/** Streaming needs no preload, so a tab only has to be checked for gaps. */
async function checkTab(tab) {
  const paths = new Set()
  for (const k of Object.values(cfg.tabs[tab]?.keys ?? {})) {
    if (k.sound) paths.add(k.sound)
    for (const m of k.preset ?? []) paths.add(m.sound)
  }
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
  // A violet bar marks a scene, so presets read differently from plain loops
  // at a glance without changing the panel's palette.
  preset: { bg: '#101820', fg: '#ffffff', bar: '#9a6bff' },
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
  if (isPresetTab()) {
    if (!presetLayers(k).length) return STYLE.idle
    return presetActive(k) ? STYLE.playing : STYLE.preset
  }
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
    const layers = isPresetTab() ? presetLayers(k) : []

    if (isPresetTab()) {
      if (layers.length) cell.classList.add('preset')
      if (presetActive(k)) cell.classList.add('playing')
      if (layers.some((m) => missing.has(m.sound))) cell.classList.add('missing')
    } else {
      if (k?.loop) cell.classList.add('loop')
      if (k?.loop && isLooping(i)) cell.classList.add('playing')
      if (k?.sound && missing.has(k.sound)) cell.classList.add('missing')
    }

    const label = document.createElement('div')
    label.className = 'label'
    label.textContent = k?.label ?? ''
    cell.appendChild(label)

    if (isPresetTab()) {
      if (layers.length) {
        const snd = document.createElement('div')
        snd.className = 'snd'
        snd.textContent = layers.map((m) => layerLabel(m.sound)).join(' + ')
        cell.appendChild(snd)
      }
    } else if (k?.sound) {
      const snd = document.createElement('div')
      snd.className = 'snd'
      snd.textContent = k.sound.split('/').pop()
      cell.appendChild(snd)
    }

    const idx = document.createElement('div')
    idx.className = 'idx'
    idx.textContent = isPresetTab()
      ? layers.length
        ? `${layers.length} layer${layers.length > 1 ? 's' : ''}`
        : 'empty preset'
      : k?.loop
        ? 'loop'
        : ''
    cell.appendChild(idx)

    cell.addEventListener('click', () => select(i))
    grid.appendChild(cell)
  }

  // The builder shows which layers are sounding, so it follows the grid.
  if (selected?.kind === 'preset') renderPreset()
}

function select(i) {
  if (isStop(i)) return
  editor.classList.remove('hidden')
  tabFields.classList.add('hidden')
  keyFields.classList.add('hidden')
  presetFields.classList.add('hidden')

  if (isSide(i)) {
    // Only the middle LCD cell (the active tab) is selectable; it opens the
    // rename field for whichever tab is currently active.
    selected = { kind: 'tab', index: i, tab: cfg.activeTab }
    editorTitle.textContent = `Tab ${cfg.activeTab + 1}`
    tabFields.classList.remove('hidden')
    tabNameInput.value = activeTab()?.name ?? ''
  } else if (isPresetTab()) {
    selected = { kind: 'preset', index: i, tab: cfg.activeTab }
    editorTitle.textContent = `${activeTab().name} — preset ${i}`
    presetFields.classList.remove('hidden')
    presetNameInput.value = keyCfg(i)?.label ?? ''
    renderPreset()
  } else {
    selected = { kind: 'key', index: i, tab: cfg.activeTab }
    const k = keyCfg(i) ?? {}
    editorTitle.textContent = `${activeTab().name} — key ${i}`
    keyFields.classList.remove('hidden')
    labelInput.value = k.label ?? ''
    loopToggle.checked = !!k.loop
    sndPath.textContent = k.sound ?? 'No sound assigned'
  }
  render()
}

// ------------------------------------------------------- preset builder ----

/** Rewrites the selected preset's layers and repaints everything that shows them. */
function setLayers(layers) {
  patchKey({ preset: layers.length ? layers : null })
  render()
  refreshKey(selected.index)
}

function renderPreset() {
  if (selected?.kind !== 'preset') return
  const layers = presetLayers(keyCfg(selected.index))
  const chosen = new Set(layers.map((m) => m.sound))

  presetMembers.innerHTML = ''
  if (!layers.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = 'No layers yet — tick sounds below, or play a mix and capture it.'
    presetMembers.appendChild(empty)
  }
  for (const m of layers) {
    const chip = document.createElement('div')
    chip.className = `chip${loops.has(m.sound) ? ' on' : ''}${missing.has(m.sound) ? ' gone' : ''}`

    const name = document.createElement('span')
    name.className = 'chipName'
    name.textContent = layerLabel(m.sound)
    chip.appendChild(name)

    const vol = document.createElement('input')
    vol.type = 'range'
    vol.min = 0
    vol.max = 100
    vol.value = Math.round(layerVol(m) * 100)
    vol.title = 'Layer volume'
    const readout = document.createElement('span')
    readout.className = 'chipVol'
    readout.textContent = `${vol.value}%`
    // Dragging is audible immediately; the config is only rewritten on release
    // so a slow drag doesn't rewrite the file on every pixel.
    vol.oninput = () => {
      readout.textContent = `${vol.value}%`
      setPathVolume(m.sound, vol.value / 100)
    }
    vol.onchange = () => {
      const current = presetLayers(keyCfg(selected.index))
      setLayers(
        current.map((x) => (x.sound === m.sound ? { ...x, volume: vol.value / 100 } : x)),
      )
    }
    chip.appendChild(vol)
    chip.appendChild(readout)

    const drop = document.createElement('button')
    drop.textContent = '×'
    drop.title = 'Remove layer'
    drop.onclick = () => setLayers(layers.filter((x) => x.sound !== m.sound))
    chip.appendChild(drop)
    presetMembers.appendChild(chip)
  }

  const needle = presetSearch.value.trim().toLowerCase()
  presetLibrary.innerHTML = ''
  let shown = 0
  for (const entry of library()) {
    const hay = `${entry.tab} ${entry.label}`.toLowerCase()
    // A layer already in the preset stays listed even when filtered out, so
    // ticking a box never makes the row you just clicked vanish.
    if (needle && !hay.includes(needle) && !chosen.has(entry.sound)) continue
    if (++shown > 400) break

    const row = document.createElement('label')
    row.className = 'libRow'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = chosen.has(entry.sound)
    box.onchange = () => {
      const current = presetLayers(keyCfg(selected.index))
      setLayers(
        box.checked
          ? [...current, { sound: entry.sound }]
          : current.filter((x) => x.sound !== entry.sound),
      )
    }
    row.appendChild(box)
    const name = document.createElement('span')
    name.textContent = entry.label
    row.appendChild(name)
    const from = document.createElement('span')
    from.className = 'libTab'
    from.textContent = entry.tab
    row.appendChild(from)
    presetLibrary.appendChild(row)
  }
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
  if (selected?.kind === 'key' || selected?.kind === 'preset') selected = null
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
  if (!loopToggle.checked) stopKeyLoop(selected.index)
  patchKey({ loop: loopToggle.checked })
  render()
  refreshKey(selected.index)
})

document.getElementById('pickBtn').addEventListener('click', async () => {
  if (selected?.kind !== 'key') return
  const path = await api.pickSound()
  if (!path) return
  stopKeyLoop(selected.index)
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
  stopKeyLoop(selected.index)
  delete activeTab().keys[selected.index]
  save()
  labelInput.value = ''
  loopToggle.checked = false
  sndPath.textContent = 'No sound assigned'
  render()
  refreshKey(selected.index)
})

// -------------------------------------------------------- preset events ----

presetNameInput.addEventListener('change', () => {
  if (selected?.kind !== 'preset') return
  patchKey({ label: presetNameInput.value.trim() })
  render()
  refreshKey(selected.index)
})

presetSearch.addEventListener('input', () => renderPreset())

// Building by ear: layer sounds live from their own tabs, balance them, then
// freeze the mix — volumes included — onto one key.
document.getElementById('captureBtn').addEventListener('click', () => {
  if (selected?.kind !== 'preset') return
  setLayers([...loops.entries()].map(([sound, el]) => ({ sound, volume: el.volume })))
})

document.getElementById('testPresetBtn').addEventListener('click', () => {
  if (selected?.kind === 'preset') trigger(selected.index)
})

document.getElementById('clearPresetBtn').addEventListener('click', () => {
  if (selected?.kind !== 'preset') return
  delete activeTab().keys[selected.index]
  save()
  presetNameInput.value = ''
  renderPreset()
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
