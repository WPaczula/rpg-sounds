import HID from 'node-hid'
import sharp from 'sharp'

const VID = 0x0c00
const PID = 0x1000
const PACKET = 512

const ascii = (s) => [...s].map((c) => c.charCodeAt(0))
function crt(...b) {
  const buf = Buffer.alloc(PACKET + 1, 0)
  Buffer.from([0x43, 0x52, 0x54, 0x00, 0x00, ...b]).copy(buf, 1)
  return buf
}
const CMD = {
  wake: () => crt(...ascii('DIS')),
  brightness: (p) => crt(...ascii('LIG'), 0, 0, p),
  clearAll: () => crt(...ascii('CLE'), 0, 0, 0, 0xff),
  heartbeat: () => crt(...ascii('CONNECT')),
  stop: () => crt(...ascii('STP')),
  bat: (len, key) =>
    crt(...ascii('BAT'), (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, key),
}

// 85x85 JPEG, big label, per the pv1 pipeline: rotate90 then mirror both axes.
async function label(text) {
  const svg = `<svg width="85" height="85" xmlns="http://www.w3.org/2000/svg">
    <rect width="85" height="85" fill="#101820"/>
    <text x="42.5" y="42.5" font-family="Helvetica,Arial,sans-serif" font-size="34"
          font-weight="bold" fill="#ffffff" text-anchor="middle" dominant-baseline="central">${text}</text>
  </svg>`
  return sharp(Buffer.from(svg))
    .resize(85, 85, { fit: 'fill' })
    .rotate(90)
    .flip()
    .flop()
    .jpeg({ quality: 90 })
    .toBuffer()
}

const dev = new HID.HID(VID, PID)
console.log('opened')

dev.write([...CMD.wake()])
dev.write([...CMD.brightness(0)])
dev.write([...CMD.clearAll()])
dev.write([...CMD.brightness(70)])

// Send a distinct image to every candidate key code, labelled with that code.
const codes = []
for (let c = 0x01; c <= 0x12; c++) codes.push(c)

for (const c of codes) {
  const jpeg = await label(c.toString(16).toUpperCase().padStart(2, '0'))
  if (jpeg.length > 10240) throw new Error(`image too big for key ${c}: ${jpeg.length}`)

  dev.write([...CMD.bat(jpeg.length, c)])
  for (let off = 0; off < jpeg.length; off += PACKET) {
    const chunk = Buffer.alloc(PACKET + 1, 0)
    jpeg.copy(chunk, 1, off, Math.min(off + PACKET, jpeg.length))
    dev.write([...chunk])
  }
  console.log(`sent key 0x${c.toString(16).padStart(2, '0')} (${jpeg.length} bytes)`)
}

dev.write([...CMD.stop()])
console.log('\nSTP sent. Look at the panel: each key should show its own hex code.')
console.log('Now polling for input for 35s -- PRESS BUTTONS.')

let got = 0
let lastHb = Date.now()
const deadline = Date.now() + 35000
while (Date.now() < deadline) {
  if (Date.now() - lastHb > 6000) {
    dev.write([...CMD.heartbeat()])
    lastHb = Date.now()
  }
  const data = dev.readTimeout(400)
  if (data && data.length) {
    got++
    console.log(`DATA ${Buffer.from(data).subarray(0, 16).toString('hex')}`)
  }
}
console.log(`total reports: ${got}`)
dev.close()
