# Worked example: Mirabox / Ajazz "Stream Dock" family

A concrete instance of the process in [SKILL.md](SKILL.md), reverse-engineered against a Mad Dog
Stream Panel GK150 on macOS 26 (Apple Silicon).

## Identification

`ioreg` reported:

| Field | Value |
|---|---|
| VID:PID | `0x0C00:0x1000` |
| Serial | `355499441494` |
| Usage page | `0xFFA0` vendor-defined, usages 1 and 2 |
| Report size | 512 bytes in and out |
| Bound driver | generic `AppleUserHIDDevice` |

Descriptor decoded to a 512-byte INPUT and a 512-byte OUTPUT on a vendor page — no Report ID.

The serial turned out to be a **hardcoded protocol-v1 marker** shared across the family, not a unique
unit id. Worth checking: a suspiciously round or shared serial often encodes a protocol variant.

### Family VID:PIDs

| Device | VID:PID |
|---|---|
| Mirabox 293 | `5500:1001` |
| Mirabox N3 | `6602:1000`, `6602:1002`, `6603:1002`, `6603:1003` |
| Ajazz AKP03E / AKP03R rev2 | `0300:3002` / `0300:3003` |
| Ajazz AKP153E / rev2 / AKP153R rev2 | `0300:1010` / `0300:3010` / `0300:3011` |
| Mad Dog GK150K | `0C00:1000` |

Useful sources: [`bitfocus/companion-surface-mirabox-stream-dock`](https://github.com/bitfocus/companion-surface-mirabox-stream-dock)
(Node + node-hid), [`4ndv/mirajazz`](https://github.com/4ndv/mirajazz) (Rust),
[`4ndv/opendeck-akp153`](https://github.com/4ndv/opendeck-akp153),
[`MiraboxSpace/StreamDock-Device-SDK`](https://github.com/MiraboxSpace/StreamDock-Device-SDK) (official, MIT).

## macOS enumeration quirk

The device exposes usages 1 and 2 on page `0xFFA0`, so `HID.devices()` returns **two entries** for the
same physical device. Filter on `usagePage === 0xFFA0 && usage === 1`.

## Framing

Writes are 513 bytes: a leading `0x00` report byte (HIDAPI requires it; the OS strips it since the
descriptor declares no Report ID), then 512 bytes zero-padded.

Commands carry ASCII `CRT`:

```
[0]      0x00                 report number
[1..5]   43 52 54 00 00       "CRT" 00 00
[6..]    opcode + args, zero-padded to 513
```

| Command | Bytes from offset 6 | Purpose |
|---|---|---|
| `DIS` | `44 49 53` | wake screen / init |
| `LIG` | `4C 49 47 00 00 <pct>` | brightness 0–100 |
| `CONNECT` | `43 4F 4E 4E 45 43 54` | heartbeat |
| `BAT` | `42 41 54 <s3 s2 s1 s0> <key>` | begin image, 4-byte big-endian length |
| `STP` | `53 54 50` | commit / refresh |
| `CLE` | `43 4C 45 00 00 00 <key>` | clear key (`0xFF` = all) |
| `CLE`+`DC` | `43 4C 45 00 00 44 43` | disconnect |
| `HAN` | `48 41 4E` | sleep screen |

## Startup and heartbeat

```
DIS
LIG 0
CLE FF
LIG <pct>
then CONNECT every ~8 s, first at ~1 s
on exit: CLE 00 00 "DC", then HAN
```

**The heartbeat is mandatory.** Without it the panel blanks itself — which is why the vendor manual
insists its software stays running.

## Input reports

512 bytes, no report ID:

```
[0..2]  41 43 4B    "ACK"   ignore the report without this prefix
[5..6]  4F 4B       "OK"
[9]     key code, 1-based
[10]    state
```

On protocol v1, `data[10]` is **always `0x00`** — press only, no release. Hold-to-play is impossible.
Later protocol versions do report both states.

## Key images

JPEG, 85×85, **rotated 270°** (equivalently rotate 90° then mirror both axes), quality 90.
Hard limit **10240 bytes** per image; 85×85 at q90 lands around 1 KB.

```
1. OUT  00 | "CRT" 00 00 | "BAT" | s3 s2 s1 s0 | <key> | 00…    header
2. OUT  00 | <512 raw JPEG bytes>                                repeat, NO "CRT" prefix
       final chunk zero-padded to 513
3. OUT  00 | "CRT" 00 00 | "STP" | 00…                           commit
```

Batch every key's `BAT`+data and send **one** `STP` at the end — much faster than committing per key.

An `sharp` pipeline of `resize(85,85) → rotate(90) → flip() → flop() → jpeg(90)` rendered upright.
In a browser/Electron renderer, a `<canvas>` rotated 270° then `toDataURL('image/jpeg')` is equivalent
and avoids a native image dependency entirely.

## Layout discovered by the labelled-image trick

Uploading each code's own hex to every key gave, read straight off the panel:

```
0D 0A 07 04 01 | 10
0E 0B 08 05 02 | 11
0F 0C 09 06 03 | 12
```

Pressing every key then showed codes `0x10`/`0x11`/`0x12` **never appear** — that column has screens
but no input. Sources disagreed on this point; only the hardware settled it.
