---
name: hid-key-mapping
description: Reverse-engineer and map the buttons of a vendor-HID device (stream deck, macro pad, LCD keypad) on macOS when no driver exists. Use when a USB device has no macOS support, when identifying which physical key sends which HID code, when key presses produce no input reports, or when the user mentions node-hid, IOHIDDevice, ioreg, Stream Deck, Mirabox, Ajazz, or a vendor usage page like 0xFFA0.
---

# Mapping a vendor-HID device on macOS

For devices that speak a proprietary HID protocol instead of standard keyboard reports.

## Order matters

Identify → check prior art → **check TCC** → talk to it → map keys.
Skipping the TCC check wastes hours: see [the silent-read trap](#the-silent-read-trap).

## 1. Identify the device

```bash
ioreg -c IOHIDDevice -r -l -w 0 | grep -E '"(Product|VendorID|ProductID|PrimaryUsagePage|PrimaryUsage|MaxInputReportSize|MaxOutputReportSize|ReportDescriptor|Transport)"'
```

Record VID, PID, usage page, report sizes, and the raw report descriptor. Then decode the
descriptor by hand — it tells you report sizes and direction before you write any code.

**Usage page is the key fact.** A vendor-defined page (`0xFF00`–`0xFFFF`) means macOS does *not*
treat the device as a keyboard: no `CGEventTap`, no Karabiner, no DriverKit, no device seizing.
`node-hid` opens it directly. A Keyboard page (`0x06`) means a much harder problem.

## 2. Search prior art before writing anything

Search the **exact VID:PID**, then the device family. Cheap clones are almost always rebrands, and
the protocol is often already published. Look for the OEM, not the brand on the box.

Prefer a reference implementation in your target language. For Node, prefer `node-hid` over raw
`libusb` — on macOS the HID interface is already claimed by Apple's driver, so libusb cannot claim it.

## 3. The silent-read trap

**macOS gates HID input behind TCC Input Monitoring; writes are ungated.**

Symptom: writes work perfectly (device lights up, screens update) while reads return **nothing —
no error, no data, no timeout**. This looks exactly like a protocol bug and is not one.

Check it before debugging anything else:

```bash
clang -o hidaccess scripts/hidaccess.c -framework IOKit -framework CoreFoundation && ./hidaccess
```

`UNKNOWN (never prompted)` or `DENIED` means input is blocked. A bare CLI binary cannot raise the
prompt — grant it manually in System Settings → Privacy & Security → Input Monitoring.

TCC attributes to the **responsible parent app**, so grant whichever app hosts the process: Terminal
for scripts, and separately the Electron binary for a dev build. Each app identity needs its own grant.

## 4. Establish a session

Many panels need an init sequence and a **periodic heartbeat**, without which they blank themselves.
A vendor manual insisting "the software must be running" is a strong hint that a heartbeat exists.

Write init, start the heartbeat, and confirm with something visible (brightness, clear screen) before
trusting anything else.

## 5. Map keys by writing, not reading

**The core trick.** Do not guess the layout from a sibling model, and do not wait for input to work:

> Upload a distinct image labelled with its own code to **every candidate key code**, then look at
> the device and read the layout off the hardware.

This maps codes to physical positions using only the output path, so it works even while input is
still broken. It also proves your image pipeline, resolution, and orientation in the same step.

Use an **asymmetric** test image (a letter like `F`) — a symmetric one hides rotation and mirroring errors.

Then capture input reports and confirm the codes match. Note which codes **never appear**: some keys
have screens but report no input, and only pressing every one reveals that.

## 6. Decode input reports

Log raw hex. Look for an ASCII magic prefix, then find the byte that changes with the key and the byte
that changes with press/release. Verify whether release is reported at all — many protocols send a
single edge per press, which makes hold-to-play impossible.

## Reference

- [REFERENCE.md](REFERENCE.md) — the Mirabox/Ajazz "Stream Dock" protocol as a worked example
- [scripts/hidaccess.c](scripts/hidaccess.c) — TCC Input Monitoring checker
- [scripts/probe.mjs](scripts/probe.mjs) — enumerate, init, heartbeat, dump input reports
