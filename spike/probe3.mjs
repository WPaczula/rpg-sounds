import HID from 'node-hid'

const VID = 0x0c00
const PID = 0x1000
const PACKET = 512
const t0 = Date.now()
const ts = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`

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
  mod: (m) => crt(...ascii('MOD'), 0, 0, 0x30 + m),
}

// Open via the vid/pid constructor (synchronous API) rather than by path.
const dev = new HID.HID(VID, PID)
console.log(`${ts()} opened via vid/pid constructor`)

dev.write([...CMD.wake()])
dev.write([...CMD.brightness(0)])
dev.write([...CMD.clearAll()])
dev.write([...CMD.brightness(60)])
console.log(`${ts()} init done`)

const MODE = process.argv[2]
if (MODE !== undefined) {
  const m = Number(MODE)
  dev.write([...CMD.mod(m)])
  console.log(`${ts()} sent MOD ${m}`)
}

console.log(`${ts()} polling with readTimeout for 35s -- PRESS BUTTONS NOW`)

let got = 0
let lastHb = Date.now()
const deadline = Date.now() + 35000

while (Date.now() < deadline) {
  if (Date.now() - lastHb > 6000) {
    dev.write([...CMD.heartbeat()])
    lastHb = Date.now()
  }
  let data
  try {
    data = dev.readTimeout(400)
  } catch (e) {
    console.log(`${ts()} read error: ${e.message}`)
    break
  }
  if (data && data.length) {
    got++
    console.log(`${ts()} DATA len=${data.length} ${Buffer.from(data).subarray(0, 16).toString('hex')}`)
  }
}

console.log(`\n${ts()} total reports: ${got}`)
dev.close()
