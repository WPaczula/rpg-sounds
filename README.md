# GK150 Soundboard

A macOS soundboard for the **Mad Dog Stream Panel GK150**, which ships with Windows-only software
and no macOS driver.

Built for tabletop sessions: one tab of sound effects, one of ambience, one of combat music.

## The device

Despite the name, the GK150 is not a keyboard — it is a Stream Deck-style macro pad. `GK150K` /
`GK150W` is a **colour code** (K = black, W = white); the `W` does not mean wireless.

It turns out to be an **Ajazz AKP153 / Mirabox HSV293S-family** unit, and is recognised by name in
[`4ndv/opendeck-akp153`](https://github.com/4ndv/opendeck-akp153) as `Kind::GK150K`.

| | |
|---|---|
| USB VID:PID | `0x0C00:0x1000` |
| HID usage page | `0xFFA0` (vendor-defined), usages 1 and 2 |
| Report size | 512 bytes in and out |
| Keys | 18, each with its own 85×85 LCD |
| Protocol version | 1 (press events only, no key-up) |

### Protocol notes

Verified against the hardware, cross-checked with
[`companion-surface-mirabox-stream-dock`](https://github.com/bitfocus/companion-surface-mirabox-stream-dock),
[`mirajazz`](https://github.com/4ndv/mirajazz), and the official
[Mirabox SDK](https://github.com/MiraboxSpace/StreamDock-Device-SDK).

- Commands are 513-byte HID writes: a `0x00` report byte, the ASCII magic `CRT`, then an opcode.
- Startup is `DIS` → `LIG 0` → `CLE FF` → `LIG <pct>`.
- **A `CONNECT` heartbeat every ~8 s is mandatory** — without it the panel blanks itself. This is why
  the vendor software has to stay running.
- Key presses arrive framed `ACK` … `OK`, with the key code at byte 9. Protocol v1 never reports
  key-up, so every press is a single edge.
- Key images are JPEG, 85×85, rotated 270°, sent as a `BAT` header plus 512-byte chunks and committed
  with `STP`. Hard limit of 10240 bytes per image.

Physical code layout, confirmed by uploading a labelled image to every key:

```
0D 0A 07 04 01 | 10
0E 0B 08 05 02 | 11
0F 0C 09 06 03 | 12
```

The right-hand column (`0x10`/`0x11`/`0x12`) has screens but **reports no input** — it is output-only,
so this app renders it black and binds nothing to it.

## Layout

```
row 0:   snd  snd  snd  snd   TAB 1  | black
row 1:   snd  snd  snd  snd   TAB 2  | black
row 2:   snd  snd  snd  STOP  TAB 3  | black
```

- **Tabs** — rightmost grid column. Each holds its own set of 11 sound keys. Rename them in the app.
- **STOP** — kills the running loop and every one-shot still sounding.
- **Sound keys** — each has a label, a sound file, and a loop toggle.
  - Loop off: plays once, layering over whatever is already playing.
  - Loop on: press starts it, press again stops it. **Only one loop runs at a time**, across all tabs.

LCD states: normal is dark with white text; a loop-enabled key gets a blue bar; a *playing* loop is
yellow with black text; the active tab is white with black text.

## Running

```bash
npm install
npx electron-rebuild -f -w node-hid
npm start
```

### Input Monitoring is required

macOS gates HID **input** behind TCC Input Monitoring. Writes are ungated, so without the grant the
panel lights up and displays images perfectly while key presses are silently dropped — no error, no
data. If keys do nothing, that is almost always the cause.

Grant it under System Settings → Privacy & Security → Input Monitoring, or via the button in the app.
`spike/hidaccess.c` reports the current state:

```bash
clang -o spike/hidaccess spike/hidaccess.c -framework IOKit -framework CoreFoundation
./spike/hidaccess
```

## Config

`~/.config/gk150/config.json`, written by the app but plain enough to hand-edit. Bindings on keys
reserved for tabs, STOP, or the output-only column are stripped on load, so stale entries cannot
linger invisibly.

## `spike/`

Standalone probes used to reverse-engineer the device, kept because they are the fastest way to debug
it without the Electron layer in the way. `probe3.mjs` is the most useful: it initialises the panel
and dumps raw input reports.
