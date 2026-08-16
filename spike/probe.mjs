import HID from 'node-hid'

const VID = 0x0c00
const PID = 0x1000
const PACKET = 512

const ascii = (s) => [...s].map((c) => c.charCodeAt(0))

// Every command packet: [0x00 report num]["CRT" 0x00 0x00][opcode + args], padded to 513.
function crt(...bytes) {
  const buf = Buffer.alloc(PACKET + 1, 0)
  buf[0] = 0x00
  Buffer.from([0x43, 0x52, 0x54, 0x00, 0x00, ...bytes]).copy(buf, 1)
  return buf
}

const CMD = {
  wake: () => crt(...ascii('DIS')),
  brightness: (pct) => crt(...ascii('LIG'), 0x00, 0x00, Math.max(0, Math.min(100, pct))),
  clearAll: () => crt(...ascii('CLE'), 0x00, 0x00, 0x00, 0xff),
  heartbeat: () => crt(...ascii('CONNECT')),
  sleep: () => crt(...ascii('HAN')),
  disconnect: () => crt(...ascii('CLE'), 0x00, 0x00, 0x44, 0x43),
}

const info = HID.devices().find(
  (d) => d.vendorId === VID && d.productId === PID && d.usagePage === 0xffa0 && d.usage === 1,
)
if (!info) {
  console.error('GK150 not found')
  process.exit(1)
}

console.log(`opening ${info.path} (serial ${info.serialNumber})`)
const dev = new HID.HID(info.path)

const seen = new Map() // raw code -> { count, states:Set }

dev.on('data', (data) => {
  const isAck = data[0] === 0x41 && data[1] === 0x43 && data[2] === 0x4b
  if (!isAck) {
    console.log('non-ACK report:', data.subarray(0, 16).toString('hex'))
    return
  }
  const code = data[9]
  const state = data[10]
  const rec = seen.get(code) ?? { count: 0, states: new Set() }
  rec.count++
  rec.states.add(state)
  seen.set(code, rec)

  console.log(
    `key raw=0x${code.toString(16).padStart(2, '0')} state=0x${state
      .toString(16)
      .padStart(2, '0')}  head=${data.subarray(0, 12).toString('hex')}`,
  )
})

dev.on('error', (err) => console.error('HID error:', err.message))

// --- startup sequence ---
dev.write([...CMD.wake()])
dev.write([...CMD.brightness(0)])
dev.write([...CMD.clearAll()])
dev.write([...CMD.brightness(60)])
console.log('init sent (DIS, LIG 0, CLE FF, LIG 60). Panel should be lit and blank.')
console.log('Press every physical button, including any side buttons. Ctrl-C when done.\n')

const hb = setInterval(() => {
  try {
    dev.write([...CMD.heartbeat()])
  } catch (e) {
    console.error('heartbeat failed:', e.message)
  }
}, 5000)
setTimeout(() => dev.write([...CMD.heartbeat()]), 1000)

function shutdown() {
  clearInterval(hb)
  console.log('\n--- summary: distinct input codes ---')
  const codes = [...seen.entries()].sort((a, b) => a[0] - b[0])
  for (const [code, rec] of codes) {
    console.log(
      `  0x${code.toString(16).padStart(2, '0')}  presses=${rec.count}  states=${[...rec.states]
        .map((s) => '0x' + s.toString(16).padStart(2, '0'))
        .join(',')}`,
    )
  }
  console.log(`total distinct inputs: ${codes.length}`)
  try {
    dev.write([...CMD.disconnect()])
    dev.write([...CMD.sleep()])
    dev.close()
  } catch {}
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
