import HID from 'node-hid'

const VID = 0x0c00
const PID = 0x1000
const PACKET = 512
const t0 = Date.now()
const ts = () => `[${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(5)}s]`

const ascii = (s) => [...s].map((c) => c.charCodeAt(0))
function crt(...bytes) {
  const buf = Buffer.alloc(PACKET + 1, 0)
  Buffer.from([0x43, 0x52, 0x54, 0x00, 0x00, ...bytes]).copy(buf, 1)
  return buf
}
const CMD = {
  wake: () => crt(...ascii('DIS')),
  brightness: (p) => crt(...ascii('LIG'), 0, 0, p),
  clearAll: () => crt(...ascii('CLE'), 0, 0, 0, 0xff),
  heartbeat: () => crt(...ascii('CONNECT')),
}

const find = () =>
  HID.devices().filter((d) => d.vendorId === VID && d.productId === PID)

const info = find().find((d) => d.usagePage === 0xffa0 && d.usage === 1)
if (!info) {
  console.error('not found')
  process.exit(1)
}
console.log(`${ts()} opening ${info.path}`)

const dev = await HID.HIDAsync.open(info.path)
console.log(`${ts()} opened (HIDAsync)`)

let reports = 0
dev.on('data', (data) => {
  reports++
  console.log(`${ts()} DATA len=${data.length} ${data.subarray(0, 16).toString('hex')}`)
})
dev.on('error', (e) => console.log(`${ts()} ERROR ${e.message}`))

await dev.write([...CMD.wake()])
await dev.write([...CMD.brightness(0)])
await dev.write([...CMD.clearAll()])
await dev.write([...CMD.brightness(60)])
console.log(`${ts()} init done. PRESS BUTTONS NOW.`)

const hb = setInterval(() => {
  dev.write([...CMD.heartbeat()]).catch((e) => console.log(`${ts()} hb fail ${e.message}`))
}, 8000)

// Detect re-enumeration: does the device vanish/reappear when a key is pressed?
let lastCount = find().length
const watch = setInterval(() => {
  const now = find()
  if (now.length !== lastCount) {
    console.log(`${ts()} ENUM CHANGE: ${lastCount} -> ${now.length} entries`)
    lastCount = now.length
  }
}, 300)

setTimeout(async () => {
  clearInterval(hb)
  clearInterval(watch)
  console.log(`\n${ts()} total input reports: ${reports}`)
  await dev.close()
  process.exit(0)
}, 40000)
