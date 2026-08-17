import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TAB_UP_INDEX, TAB_DOWN_INDEX, SIDE_INDEXES, STOP_INDEX, SOUND_INDEXES } from './device.js'

const RESERVED = new Set([TAB_UP_INDEX, TAB_DOWN_INDEX, ...SIDE_INDEXES, STOP_INDEX])

/** Strip bindings on keys that are reserved for tabs or are output-only. */
const usableKeys = (keys = {}) =>
  Object.fromEntries(Object.entries(keys).filter(([i]) => !RESERVED.has(Number(i))))

export const CONFIG_DIR = join(homedir(), '.config', 'gk150')
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

// The sounds/ folder is the source of truth for tab content: every
// subfolder becomes a tab (or several, if it holds more sounds than there
// are sound keys), rebuilt from disk on every launch.
export const SOUNDS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sounds')
const AUDIO_EXTS = new Set(['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.aac'])

/** "01 - Large City ｜ D&D／TTRPG Music ｜ 1 Hour.mp3" -> "Large City" */
function labelFor(filename) {
  const stem = filename.slice(0, filename.length - extname(filename).length)
  return stem.split('｜')[0].replace(/^\d+\s*-\s*/, '').trim() || stem
}

function audioFilesIn(dirPath) {
  let entries
  try {
    entries = readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isFile() && AUDIO_EXTS.has(extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort()
}

/** One tab per sounds/ subfolder, chunked so no tab exceeds the usable key count. */
function buildFolderTabs() {
  let folders
  try {
    folders = readdirSync(SOUNDS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }

  const perTab = SOUND_INDEXES.length
  const tabs = []
  for (const folder of folders) {
    const files = audioFilesIn(join(SOUNDS_DIR, folder))
    if (files.length === 0) continue
    const chunks = []
    for (let i = 0; i < files.length; i += perTab) chunks.push(files.slice(i, i + perTab))
    chunks.forEach((chunk, ci) => {
      const keys = {}
      chunk.forEach((file, i) => {
        keys[SOUND_INDEXES[i]] = { label: labelFor(file), sound: join(SOUNDS_DIR, folder, file), loop: true }
      })
      tabs.push({ name: chunks.length > 1 ? `${folder} ${ci + 1}` : folder, keys, generated: true })
    })
  }
  return tabs
}

/** Drop stale generated tabs and replace them with a fresh scan of sounds/. */
const withGeneratedTabs = (tabs) => [...tabs.filter((t) => !t.generated), ...buildFolderTabs()]

const defaults = () => ({
  device: { brightness: 60 },
  activeTab: 0,
  tabs: withGeneratedTabs([
    { name: 'Effects', keys: {} },
    { name: 'Fight', keys: {} },
  ]),
})

/** Bring older single-page configs forward into the tabbed shape. */
function migrate(parsed) {
  if (Array.isArray(parsed.tabs)) {
    // Which indexes are reserved has changed over time; re-sanitise on load so
    // stale bindings on tab or output-only keys cannot linger invisibly.
    for (const tab of parsed.tabs) tab.keys = usableKeys(tab.keys)
    // "Background" was a static default tab; folder-derived tabs (Ambience,
    // etc.) supersede it, so drop any leftover copy from older configs.
    parsed.tabs = parsed.tabs.filter((t) => t.generated || t.name !== 'Background')
    return parsed
  }
  const next = defaults()
  next.device = parsed.device ?? next.device
  if (parsed.keys && typeof parsed.keys === 'object') {
    next.tabs[0].keys = usableKeys(parsed.keys)
  }
  return next
}

export function load() {
  if (!existsSync(CONFIG_PATH)) {
    const fresh = defaults()
    save(fresh)
    return fresh
  }
  try {
    const parsed = migrate(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')))
    parsed.tabs = withGeneratedTabs(parsed.tabs)
    if (!(parsed.activeTab >= 0 && parsed.activeTab < parsed.tabs.length)) parsed.activeTab = 0
    return parsed
  } catch (err) {
    console.error(`config unreadable, using defaults: ${err.message}`)
    return defaults()
  }
}

export function save(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}
