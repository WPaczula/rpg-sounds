// Probe a vendor-HID panel: enumerate, init, heartbeat, dump input reports, and
// optionally run the labelled-image key-mapping trick.
//
//   npm i node-hid          # required
//   npm i sharp             # optional, enables --map
//
//   node probe.mjs          # init + listen for key presses
//   node probe.mjs --map    # also upload each code's own hex to every key
//
// Defaults target the Mirabox/Ajazz "Stream Dock" family. Edit CONFIG for others.

import HID from 'node-hid'

const CONFIG = {
  vid: 0x0c00,
  pid: 0x1000,
  usagePage: 0xffa0,
  usage: 1,
  packet: 512, // 1024 on protocol v2/v3 devices
  keyCodes: Array.from({ length: 0x12 }, (_, i) => i + 1),
  keyPx: 85,
  brightness: 60,
  heartbeatMs: 5000,
  listenMs: 35000,
}

const ascii = (s) => [...s].map((c) => c.charCodeAt(0))
const t0 = Date.now()
const ts = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`

/** 513-byte command: report byte, "CRT" magic, opcode, zero padding. */
function crt(...bytes) {
  const buf = Buffer.alloc(CONFIG.packet + 1, 0)
  Buffer.from([0x43, 0x52, 0x54, 0x00, 0x00, ...bytes]).copy(buf, 1)
  return buf
}

const CMD = {
  wake: () => crt(...ascii('DIS')),
  sleep: () => crt(...ascii('HAN')),
  heartbeat: () => crt(...ascii('CONNECT')),
  stop: () => crt(...ascii('STP')),
  disconnect: () => crt(...ascii('CLE'), 0, 0, 0x44, 0x43),
  brightness: (p) => crt(...ascii('LIG'), 0, 0, Math.max(0, Math.min(100, p))),
  clearAll: () => crt(...ascii('CLE'), 0, 0, 0, 0xff),
  beginImage: (len, key) =>
    crt(...ascii('BAT'), (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, key),
}

const matches = HID.devices().filter((d) => d.vendorId === CONFIG.vid && d.productId === CONFIG.pid)
console.log(`${ts()} ${matches.length} HID entries for ${CONFIG.vid.toString(16)}:${CONFIG.pid.toString(16)}`)
for (const d of matches) console.log(`         usagePage=0x${(d.usagePage ?? 0).toString(16)} usage=${d.usage}`)

// macOS lists one entry per usage; pick the one the protocol lives on.
const info = matches.find((d) => d.usagePage === CONFIG.usagePage && d.usage === CONFIG.usage)
if (!info) {
  console.error('device not found — check CONFIG, and that it is plugged in')
  process.exit(1)
}

const dev = new HID.HID(info.path)
console.log(`${ts()} opened ${info.path} (serial ${info.serialNumber})`)

dev.write([...CMD.wake()])
dev.write([...CMD.brightness(0)])
dev.write([...CMD.clearAll()])
dev.write([...CMD.brightness(CONFIG.brightness)])
console.log(`${ts()} init sent — panel should be lit and blank`)

// The labelled-image trick: give every candidate code an image of its own hex,
// then read the physical layout straight off the device. Works even when input
// is still broken, and proves the image pipeline at the same time.
if (process.argv.includes('--map')) {
  let sharp
  try {
    sharp = (await import('sharp')).default
  } catch {
    console.error('--map needs sharp: npm i sharp')
    process.exit(1)
  }

  const { keyPx } = CONFIG
  for (const code of CONFIG.keyCodes) {
    const text = code.toString(16).toUpperCase().padStart(2, '0')
    const svg = `<svg width="${keyPx}" height="${keyPx}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${keyPx}" height="${keyPx}" fill="#101820"/>
      <text x="${keyPx / 2}" y="${keyPx / 2}" font-family="Helvetica" font-size="${keyPx * 0.4}"
            font-weight="bold" fill="#fff" text-anchor="middle" dominant-baseline="central">${text}</text>
    </svg>`

    // rotate90 + mirror both axes == rotate 270. Use an asymmetric test glyph
    // if you need to distinguish these.
    const jpeg = await sharp(Buffer.from(svg))
      .resize(keyPx, keyPx, { fit: 'fill' })
      .rotate(90)
      .flip()
      .flop()
      .jpeg({ quality: 90 })
      .toBuffer()

    if (jpeg.length > 10240) throw new Error(`image for 0x${text} is ${jpeg.length} bytes, limit 10240`)

    dev.write([...CMD.beginImage(jpeg.length, code)])
    for (let off = 0; off < jpeg.length; off += CONFIG.packet) {
      const chunk = Buffer.alloc(CONFIG.packet + 1, 0)
      jpeg.copy(chunk, 1, off, Math.min(off + CONFIG.packet, jpeg.length))
      dev.write([...chunk])
    }
    console.log(`${ts()} key 0x${text} <- ${jpeg.length} bytes`)
  }
  dev.write([...CMD.stop()]) // one commit for the whole batch
  console.log(`${ts()} committed — read the layout off the panel now`)
}

console.log(`${ts()} listening ${CONFIG.listenMs / 1000}s — PRESS EVERY KEY, including any side buttons\n`)

const seen = new Map()
let lastHb = 0
const deadline = Date.now() + CONFIG.listenMs

while (Date.now() < deadline) {
  if (Date.now() - lastHb > CONFIG.heartbeatMs) {
    dev.write([...CMD.heartbeat()])
    lastHb = Date.now()
  }
  const data = dev.readTimeout(400)
  if (!data?.length) continue

  const buf = Buffer.from(data)
  const isAck = buf[0] === 0x41 && buf[1] === 0x43 && buf[2] === 0x4b
  if (!isAck) {
    console.log(`${ts()} non-ACK: ${buf.subarray(0, 16).toString('hex')}`)
    continue
  }
  const code = buf[9]
  const rec = seen.get(code) ?? { count: 0, states: new Set() }
  rec.count++
  rec.states.add(buf[10])
  seen.set(code, rec)
  console.log(`${ts()} key=0x${code.toString(16).padStart(2, '0')} state=0x${buf[10].toString(16).padStart(2, '0')} raw=${buf.subarray(0, 12).toString('hex')}`)
}

console.log('\n--- distinct input codes ---')
for (const [code, rec] of [...seen].sort((a, b) => a[0] - b[0])) {
  const states = [...rec.states].map((s) => '0x' + s.toString(16).padStart(2, '0')).join(',')
  console.log(`  0x${code.toString(16).padStart(2, '0')}  presses=${rec.count}  states=${states}`)
}
console.log(`total: ${seen.size} inputs`)

const silent = CONFIG.keyCodes.filter((c) => !seen.has(c))
if (silent.length) {
  console.log(`never reported: ${silent.map((c) => '0x' + c.toString(16).padStart(2, '0')).join(' ')}`)
  console.log('(keys that show images but never report are output-only)')
}
if ([...seen.values()].every((r) => r.states.size === 1)) {
  console.log('only one state value seen — this device likely reports press only, no key-up')
}

dev.write([...CMD.disconnect()])
dev.write([...CMD.sleep()])
dev.close()
