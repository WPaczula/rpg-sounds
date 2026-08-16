import HID from 'node-hid'

const VID = 0x0c00
const PID = 0x1000

const all = HID.devices()
const ours = all.filter((d) => d.vendorId === VID && d.productId === PID)

console.log(`total HID devices: ${all.length}`)
console.log(`matching ${VID.toString(16)}:${PID.toString(16)}: ${ours.length}\n`)

for (const d of ours) {
  console.log({
    path: d.path,
    usagePage: '0x' + (d.usagePage ?? 0).toString(16),
    usage: d.usage,
    manufacturer: d.manufacturer,
    product: d.product,
    serialNumber: d.serialNumber,
    interface: d.interface,
    release: d.release,
  })
}
