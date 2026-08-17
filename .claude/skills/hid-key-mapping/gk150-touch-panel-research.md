# Is the GK150's right column a real touch panel?

Research task: does the Mad Dog GK150's right-hand column (device codes `0x10`/`0x11`/`0x12`,
grid indexes 5/11/17) have real touch/gesture input, or is it confirmed output-only? Feeds the
decision of whether to chase a "tappable tabs" UI via new HID code, or accept physical key presses
(current design) as final.

## Verdict

**Not a touchscreen. Confirmed output-only: 3 discrete LCD "softbuttons," at most simple
press-or-nothing switches, never a capacitive touch/gesture surface — across every source
checked.** High confidence. No source, vendor or community, describes this column as touch-capable
in the sense of coordinates, taps, or swipes. The one piece of ambiguity is whether the *switches*
under those 3 LCDs are physically present but silent on this exact unit, or absent entirely — not
whether it's "touch."

## 1. Real touch screen or 3 discrete output-only LCD keys?

**Vendor manuals (both PDFs in the repo root) never use the word "touch."**

- `Instrukcja-MAD-DOG-GK150-21-01-2025.pdf`, p.4/p.8 ("OPIS I FUNKCJE" / "DESCRIPTION AND
  FUNCTIONS"): item 3 is labelled **"Dodatkowy ekran" / "Additional screen"** — singular, generic,
  no "dotykowy" (Polish for "touch/touchscreen"). The line-drawing depicts it as one continuous
  strip, but the photograph on the same page and on the software manual's cover shows it as a
  narrow display showing a single weather glyph, consistent with 3 small screens flush together
  rather than one sensor.
- `MAD DOG-Stream panel-oprogramowanie-GK150_A5_kor1.pdf` (the Windows software manual) never
  mentions touch, gestures, or calibration anywhere in its "WIDOK OGÓLNY" (general view),
  "PRZYPISANIE KLAWISZY" (key bindings), or "USTAWIENIA" (settings) sections.
- **Stronger signal**: the software's own "Urządzenie" (Device) panel (p.5/p.12) shows a key-grid
  icon for binding functions to buttons, and the bindable grid is **3×5 = 15 squares** — it does
  not include the right column at all. The vendor's own configuration UI treats the 15 main keys as
  the only assignable input surface; the "Additional screen" is not in that grid. That lines up
  exactly with this repo's 15 assignable keys (`SOUND_INDEXES` + `TAB_INDEXES` + `STOP_INDEX` = 15,
  `src/main/device.js:24-47`) and with `SIDE_INDEXES` (5/11/17) being excluded.

**Official Mirabox SDK confirms this is family-wide, not a Mad Dog-specific cut-down.** In
`MiraboxSpace/StreamDock-Device-SDK`, `Python-SDK/src/StreamDock/Devices/StreamDock293s.py` is the
device class for the HSV293S/AKP153 base family (18 hardware keys — 15 regular + 3 "secondary
screen" keys, `KEY_COUNT = 18`, exactly this device's shape):

```python
class StreamDock293s(StreamDock):
    """StreamDock293s device class - supports 15 keys and 3 secondary screen keys"""
    ...
    def decode_input_event(self, hardware_code: int, state: int) -> InputEvent:
        """
        Decode hardware event codes into a unified InputEvent
        The 293s device supports only regular buttons; hardware code range 1-18
        """
```

All 18 hardware codes decode to `EventType.BUTTON` — there is no `TOUCH_POINT` event type for this
class. `TOUCH_POINT` (with real `x`/`y` fields) exists only on `StreamDockN4Pro.py` and is wired
through `registerTouchBarCallback` in the C++ SDK's `StreamDockN4Pro` class — a structurally
different, larger product line with an actual continuous touch strip. `StreamDock293s` also exposes
a confusingly-named `set_touchscreen_image()` / `touchscreen_image_format()` (854×480) — but that
is a full-panel *background image drawn behind the semi-transparent key bezels*, unrelated to any
touch sensor; it is a naming artifact, not evidence of touch input. Distinct from it is
`secondscreen_image_format()` (80×80), which is what actually drives the 3 right-column LCDs.

**Conclusion for §1**: the entire HSV293S/AKP153/GK150 family, per its own manufacturer's SDK and
manual, has 3 small output screens on the right ("secondary screen keys" / "Dodatkowy ekran"), and
the vendor's own driver code models them as ordinary buttons at best, never as a touch/gesture
surface.

## 2. Second HID usage (usage 2 on page 0xFFA0) — is it used for touch/gesture anywhere?

**No.** Checked `4ndv/mirajazz` (the shared low-level Rust library), `4ndv/opendeck-akp153` (which
explicitly recognizes `Kind::GK150K` by name), and `bitfocus/companion-surface-mirabox-stream-dock`
(Node/node-hid). None of them open a second HID interface/usage for this device family, and none
implement a touch/coordinate report parser at all.

- `opendeck-akp153/src/mappings.rs:72`: `// Map all queries to usage page 65440 and usage id 1 for
  now` (65440 = `0xFFA0`). Every `DeviceQuery` in the file — including
  `GK150K_QUERY = DeviceQuery::new(65440, 1, MADDOG_VID, GK150K_PID)` — is pinned to usage id `1`.
  The comment ("for now") shows the author is aware usage 2 exists but has never had reason to open
  it.
- `mirajazz/src/device.rs` defines `DeviceQuery::new(usage_page, usage_id, vendor_id, product_id)`
  and a single-device-open model; there is no code path anywhere in the crate for a secondary
  interface handle.
- `companion-surface-mirabox-stream-dock/src/main.ts:33`: `if (device.interface !== 0) return null`
  — it explicitly filters to interface 0 and ignores any other interface/usage the OS enumerates.
- `companion-surface-mirabox-stream-dock/src/streamdock.ts` (lines ~44-79) reads all input off one
  `HIDAsync` handle: `data[9]` = function id, `data[10]` = parameter — the same byte layout already
  documented in this repo's `REFERENCE.md`. Right-column codes 0x10/0x11/0x12 are modelled as
  `type: 'push'` inputs (see `HSV-293S-2.ts`, `HSV-293S-3.ts`, `HSV-293S.ts`, all under
  `src/models/`) that flow through this exact same single-report path, emitting a plain `push`
  event with no coordinate data — i.e., even on sibling hardware where these keys allegedly work,
  they are ordinary discrete key-code reports, not a distinct touch report type.

**Conclusion for §2**: usage 2 is very likely a duplicate top-level HID collection artifact of the
descriptor (the same pattern noted in this repo's `REFERENCE.md` macOS-enumeration-quirk section),
not a live secondary input/report channel. No implementation in the entire family — including the
one that explicitly names GK150K — has ever needed it.

## 3. How a real touch strip's protocol differs in shape (Stream Deck+ as the comparison point)

Elgato's Stream Deck+ is the canonical "button grid + separate touch strip" device, and its
protocol is structurally unlike anything in the GK150/Ajazz/Mirabox family. From
`abcminiuser/python-elgato-streamdeck`,
`src/StreamDeck/Devices/StreamDeckPlus.py:342-390` (`_read_control_states`):

```python
if states[0] == 0x00: # Key Event
    new_key_states = [bool(s) for s in states[3:11]]
    return {ControlType.KEY: new_key_states}
elif states[0] == 0x02: # Touchscreen Event
    if states[3] == 1:   event_type = TouchscreenEventType.SHORT
    elif states[3] == 2: event_type = TouchscreenEventType.LONG
    elif states[3] == 3: event_type = TouchscreenEventType.DRAG
    value = {
        'x': (states[6] << 8) + states[5],
        'y': (states[8] << 8) + states[7],
    }
    if event_type == TouchscreenEventType.DRAG:
        value["x_out"] = (states[10] << 8) + states[9]
        value["y_out"] = (states[12] << 8) + states[11]
    return {ControlType.TOUCHSCREEN: (event_type, value)}
elif states[0] == 0x03: # Dial Event
    ...
```

Key structural differences from GK150's protocol:

- A **distinct event-type discriminant byte** (`0x00` key / `0x02` touchscreen / `0x03` dial) at a
  fixed offset — the device tells you *which kind* of control produced the report before you
  interpret the rest of it.
- Real **little-endian X/Y pixel coordinates**, and for drags, *both* a start and an end coordinate
  pair — this is what makes tap-vs-long-press-vs-drag distinguishable at all.
- Elgato's own HID API docs (docs.elgato.com/streamdeck/hid/stream-deck-plus) confirm this same
  shape: button reports carry a flat per-key state array; touchscreen reports carry a `0x02`
  command byte, a gesture-type byte at offset `+0x04`, and coordinate fields whose width and count
  depend on the gesture (10 bytes for tap/press, 14 bytes for flick/drag).

The GK150 (and every device in `companion-surface-mirabox-stream-dock`'s and
`opendeck-akp153`'s model set) has none of this: one report shape for every control, one `id` byte,
one `state` byte, no coordinates, no gesture discriminant. Even in the hypothetical best case where
the right column's switches are live on some sibling unit, the protocol has no mechanism to report
anything but "this key code was pressed" — never a coordinate, drag, or tap-vs-hold distinction.
This rules out "real touch" even as a design intent for this whole hardware family, not just for
the Mad Dog rebrand.

## 4. Concrete conclusion

Combining the vendor manuals (§1), the total absence of touch/second-interface handling across
three independent open-source implementations of this exact device family including the one that
names `GK150K` specifically (§2), the official manufacturer SDK's own class for this family
explicitly stating "supports only regular buttons" with no touch event type (§1), and the
categorical protocol-shape difference from an actual touch device (§3) — there is no touch
capability here in any sense, real or planned. This is on top of, and fully consistent with, this
repo's own hardware finding in `REFERENCE.md`: uploading a labelled image to every code and then
pressing every physical key showed codes `0x10`/`0x11`/`0x12` **never appear** in input reports.
That finding was previously flagged as contested ("sources disagreed on this point") — this research
resolves the disagreement: no primary source actually claims *touch*; the disagreement in the wild
is only about whether the discrete switch under each of those 3 keys is wired/reported at all
(companion's and opendeck-akp153's generic models assume yes; this specific Mad Dog unit says no).
Either way, the right column was never going to support tap/drag/swipe.

## 5. Next steps for this codebase

**Usage 2 is a low-value experiment, but cheap enough to run once for certainty.** No spike script
in `spike/` currently opens it explicitly — `spike/probe3.mjs` and `spike/probe4.mjs` both use
`new HID.HID(VID, PID)`, which on macOS with two enumerated entries for the same VID/PID opens
whichever one `node-hid`/IOKit happens to resolve first, not deterministically usage 2. To rule it
out definitively:

1. Copy `spike/probe3.mjs`, replace the device-open call with the same filter
   `src/main/device.js:88-92` (`Panel.find()`) uses but for `usage === 2` instead of `usage === 1`,
   opened by `HID.devices().find(...).path`.
2. Run it, hold/tap the right column for the full poll window, and confirm `got === 0` (no reports
   at all, since usage 2 is very likely an output-only or unused duplicate collection). If it
   throws on open (`could not open device` / permission-looking errors distinct from the TCC ones
   already documented in `SKILL.md`), that alone is enough to close this out — usage 2 has no
   readable input path.
3. If (surprisingly) usage 2 *does* produce reports, dump raw hex the same way `REFERENCE.md`'s
   `probe4.mjs` does, and only then would `src/main/device.js` need a second `HID.HID` handle
   alongside the existing usage-1 one, with its own `#onData`-equivalent parser. Given §2's
   evidence, do not expect this.

**For the "tappable tabs" idea, the practical path is the one already built, not a new one.**

- Keep the rightmost grid column (`TAB_INDEXES` in `src/main/device.js:39`, rendered via
  `TAB_INDEXES`/`SOUND_INDEXES` in `src/main/index.js`) as the tab-switch control. This isn't a
  workaround forced by a broken touch panel — it matches the vendor software's own design: in the
  Windows driver, page/scene switching (`Idź do strony` / "Go to page", `Przełącz konfigurację` /
  "Switch configuration") is itself just a function you assign to one of the 15 ordinary grid
  buttons (`MAD DOG-Stream panel-oprogramowanie-GK150_A5_kor1.pdf`, p.5/p.12). A physical
  button-per-tab is the intended interaction model for this hardware, not a compromise.
- The 3 right-column LCDs (`SIDE_INDEXES` = `[5, 11, 17]`) can still be driven as **passive tab
  indicators** — they accept images fine (`Panel.setKeyImage`, `src/main/device.js:173-186`), they
  just can't be tapped. Rendering the active tab's icon/color there (one image per row, refreshed
  whenever the active tab changes) would visually echo the current `TAB_INDEXES` selection without
  requiring any new input handling — a small addition to the existing image-push flow in
  `src/main/index.js`'s `push-images` handler and whatever renderer code currently decides what to
  draw on `SIDE_INDEXES` (rendered black today per `README.md`'s Layout section). This is a
  presentation change only; no protocol or `device.js` input-path work is needed.
