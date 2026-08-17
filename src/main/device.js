import HID from 'node-hid'
import { EventEmitter } from 'node:events'

export const VID = 0x0c00
export const PID = 0x1000

const PACKET = 512
const MAX_IMAGE_BYTES = 10240

export const COLS = 6
export const ROWS = 3
export const KEY_COUNT = COLS * ROWS
export const KEY_W = 85
export const KEY_H = 85

// Physical layout, verified on the hardware by uploading a labelled image to
// every code and reading the panel:
//
//   0D 0A 07 04 01 | 10
//   0E 0B 08 05 02 | 11
//   0F 0C 09 06 03 | 12
//
// Index is reading order (left to right, top to bottom).
export const CODE_BY_INDEX = [
  0x0d, 0x0a, 0x07, 0x04, 0x01, 0x10,
  0x0e, 0x0b, 0x08, 0x05, 0x02, 0x11,
  0x0f, 0x0c, 0x09, 0x06, 0x03, 0x12,
]

const INDEX_BY_CODE = new Map(CODE_BY_INDEX.map((code, i) => [code, i]))

// The right-hand column (device codes 0x10/0x11/0x12) has screens but reports
// no input — verified on the hardware, pressing them emits nothing. They are
// output-only, so we drive them as an LCD strip: top/mid/bottom show the tab
// above, the active tab, and the tab below.
export const SIDE_INDEXES = [5, 11, 17]

// Last column of the 3x5 input grid (codes 0x01/0x02/0x03), beside the LCD
// strip. Top cycles to the previous tab, bottom to the next, middle stops.
export const TAB_UP_INDEX = 4
export const STOP_INDEX = 10
export const TAB_DOWN_INDEX = 16

// Everything left over carries sounds.
export const SOUND_INDEXES = CODE_BY_INDEX.map((_, i) => i).filter(
  (i) => !SIDE_INDEXES.includes(i) && i !== TAB_UP_INDEX && i !== STOP_INDEX && i !== TAB_DOWN_INDEX,
)

const ascii = (s) => [...s].map((c) => c.charCodeAt(0))

/** Build a 513-byte command packet: report id, "CRT" magic, opcode, zero padding. */
function crt(...bytes) {
  const buf = Buffer.alloc(PACKET + 1, 0)
  Buffer.from([0x43, 0x52, 0x54, 0x00, 0x00, ...bytes]).copy(buf, 1)
  return buf
}

const CMD = {
  wake: () => crt(...ascii('DIS')),
  sleep: () => crt(...ascii('HAN')),
  heartbeat: () => crt(...ascii('CONNECT')),
  stop: () => crt(...ascii('STP')),
  disconnect: () => crt(...ascii('CLE'), 0, 0, 0x44, 0x43),
  brightness: (pct) => crt(...ascii('LIG'), 0, 0, Math.max(0, Math.min(100, Math.round(pct)))),
  clearKey: (code) => crt(...ascii('CLE'), 0, 0, 0, code),
  clearAll: () => crt(...ascii('CLE'), 0, 0, 0, 0xff),
  beginImage: (len, code) =>
    crt(...ascii('BAT'), (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, code),
}

/**
 * The GK150 stream panel.
 *
 * Emits:
 *   'key'       (index)   a physical press; protocol v1 sends no key-up
 *   'status'    ({ connected, message })
 */
export class Panel extends EventEmitter {
  #hid = null
  #heartbeat = null
  #retry = null
  #brightness = 60

  get connected() {
    return this.#hid !== null
  }

  static find() {
    return HID.devices().find(
      (d) => d.vendorId === VID && d.productId === PID && d.usagePage === 0xffa0 && d.usage === 1,
    )
  }

  open() {
    if (this.#hid) return true

    const info = Panel.find()
    if (!info) {
      this.#status(false, 'Panel not found — is it plugged in?')
      this.#scheduleRetry()
      return false
    }

    try {
      this.#hid = new HID.HID(info.path)
    } catch (err) {
      this.#status(false, `Could not open panel: ${err.message}`)
      this.#scheduleRetry()
      return false
    }

    this.#hid.on('data', (data) => this.#onData(data))
    this.#hid.on('error', (err) => this.#onError(err))

    // Startup sequence. The panel stays dark without this.
    this.#write(CMD.wake())
    this.#write(CMD.brightness(0))
    this.#write(CMD.clearAll())
    this.#write(CMD.brightness(this.#brightness))

    // Without a periodic heartbeat the panel blanks itself. This is precisely
    // why the vendor software has to stay running.
    this.#heartbeat = setInterval(() => this.#write(CMD.heartbeat()), 5000)

    this.#status(true, 'Connected')
    return true
  }

  #onData(data) {
    // Reports are framed "ACK" .. "OK"; key code at [9], state at [10].
    // On protocol v1 the state byte is always 0x00 — press only, no release.
    if (data[0] !== 0x41 || data[1] !== 0x43 || data[2] !== 0x4b) return
    const index = INDEX_BY_CODE.get(data[9])
    if (index === undefined) return
    this.emit('key', index)
  }

  #onError(err) {
    this.#teardown()
    this.#status(false, `Panel disconnected: ${err.message}`)
    this.#scheduleRetry()
  }

  #write(buf) {
    if (!this.#hid) return false
    try {
      this.#hid.write([...buf])
      return true
    } catch (err) {
      this.#onError(err)
      return false
    }
  }

  #scheduleRetry() {
    if (this.#retry) return
    this.#retry = setTimeout(() => {
      this.#retry = null
      this.open()
    }, 2000)
  }

  #status(connected, message) {
    this.emit('status', { connected, message })
  }

  setBrightness(pct) {
    this.#brightness = pct
    this.#write(CMD.brightness(pct))
  }

  /** Upload a JPEG to one key. Call flush() once after a batch. */
  setKeyImage(index, jpeg) {
    const code = CODE_BY_INDEX[index]
    if (code === undefined) throw new Error(`bad key index ${index}`)
    if (jpeg.length > MAX_IMAGE_BYTES) {
      throw new Error(`image for key ${index} is ${jpeg.length} bytes, limit is ${MAX_IMAGE_BYTES}`)
    }

    if (!this.#write(CMD.beginImage(jpeg.length, code))) return
    for (let off = 0; off < jpeg.length; off += PACKET) {
      const chunk = Buffer.alloc(PACKET + 1, 0)
      jpeg.copy(chunk, 1, off, Math.min(off + PACKET, jpeg.length))
      if (!this.#write(chunk)) return
    }
  }

  clearKey(index) {
    this.#write(CMD.clearKey(CODE_BY_INDEX[index]))
  }

  /** Commit pending image writes. Batching then flushing once is much faster. */
  flush() {
    this.#write(CMD.stop())
  }

  #teardown() {
    clearInterval(this.#heartbeat)
    this.#heartbeat = null
    if (this.#hid) {
      try {
        this.#hid.close()
      } catch {}
      this.#hid = null
    }
  }

  close() {
    if (this.#retry) {
      clearTimeout(this.#retry)
      this.#retry = null
    }
    if (this.#hid) {
      this.#write(CMD.disconnect())
      this.#write(CMD.sleep())
    }
    this.#teardown()
  }
}
