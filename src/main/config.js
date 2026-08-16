import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { TAB_INDEXES, SIDE_INDEXES, STOP_INDEX } from './device.js'

const RESERVED = new Set([...TAB_INDEXES, ...SIDE_INDEXES, STOP_INDEX])

/** Strip bindings on keys that are reserved for tabs or are output-only. */
const usableKeys = (keys = {}) =>
  Object.fromEntries(Object.entries(keys).filter(([i]) => !RESERVED.has(Number(i))))

export const CONFIG_DIR = join(homedir(), '.config', 'gk150')
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

const defaults = () => ({
  device: { brightness: 60 },
  activeTab: 0,
  tabs: [
    { name: 'Effects', keys: {} },
    { name: 'Background', keys: {} },
    { name: 'Fight', keys: {} },
  ],
})

/** Bring older single-page configs forward into the tabbed shape. */
function migrate(parsed) {
  if (Array.isArray(parsed.tabs)) {
    // Which indexes are reserved has changed over time; re-sanitise on load so
    // stale bindings on tab or output-only keys cannot linger invisibly.
    for (const tab of parsed.tabs) tab.keys = usableKeys(tab.keys)
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
    return migrate(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')))
  } catch (err) {
    console.error(`config unreadable, using defaults: ${err.message}`)
    return defaults()
  }
}

export function save(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}
