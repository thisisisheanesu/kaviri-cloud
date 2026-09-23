# What the playground needs from the recorder

Written by the playground, which lives in `kaviri-cloud/playground` and is deployed at
play.kaviri.dev. Addressed to whoever owns `kaviri`, the Apache 2.0 recorder repository, which
this directory does not edit.

Nothing here blocks the playground. It ships today and works today. Everything below either
removes a copy of your code from our repository or removes an approximation from the page.
Ordered by how much it is worth.

---

## 1. The planner as a wasm target. This is the one that matters.

The recorder cannot run in a page: it drives headless Chromium over CDP and shells out to
ffmpeg. The planner can, because it is arithmetic over numbers, and "watch the real planner cut
your camera without installing anything" is the only honest version of a browser playground.

Today the playground carries a JavaScript port of `src/zoom.rs` at `playground/js/planner.js`.
It is faithful, and it is a second copy of your constants in a repository you do not own, which
is exactly the kind of thing that is correct on the day it is written and wrong four commits
later.

### The shape we would load

The page already tries this on startup and falls back to the port when it 404s, so shipping it
is the only step. `playground/js/planner-source.js` does the loading.

```
playground/wasm/kaviri_planner.js     # the wasm-bindgen JS shim
playground/wasm/kaviri_planner_bg.wasm
```

Exports we call, and nothing else:

```js
export default function init(): Promise<void>;     // the usual wasm-bindgen default export

// marksJson is a JSON array of {t, kind, label, bbox: [x, y, w, h] | null}, CSS pixels,
// exactly the shape the telemetry sidecar's `marks` array already has.
export function plan(
  marksJson: string,
  scale: number,
  frameW: number,
  frameH: number,
  duration: number
): string;

export function version(): string;                  // CARGO_PKG_VERSION, shown in the badge
```

`plan` returns a JSON string:

```json
{
  "events": [
    { "t": 3.55, "end": 6.1, "cx": 812.4, "cy": 430.0, "z": 1.85, "path": [[4.2, 900.1, 430.0]] }
  ],
  "warnings": [
    { "t": 6.4, "text": "the interaction at 6.4s is too close to the end of the 7.0s take to be zoomed; add a trailing wait before stop_recording" }
  ]
}
```

`events` is `ZoomEvent` as it already serialises, so `serde_json::to_string` of the existing
struct is the whole job.

### The one behaviour change we are asking for

`events_from_marks` currently reports its two diagnostics with `eprintln!`. A wasm build has no
stderr, and those two lines are the planner's entire diagnostic surface: a dropped zoom and a
dropped waypoint are otherwise invisible except as a lower count in a sidecar nobody reads.

So the planning function needs to return its warnings rather than print them. A shape that keeps
the CLI behaviour identical:

```rust
pub struct Plan {
    pub events: Vec<ZoomEvent>,
    pub warnings: Vec<Warning>,   // { t: f64, text: String }
}

pub fn plan(marks: &[Mark], scale: f64, frame_w: f64, frame_h: f64, duration: f64) -> Plan;

/// The CLI keeps the behaviour it has now by draining the warnings to stderr.
pub fn events_from_marks(...) -> Vec<ZoomEvent> {
    let p = plan(...);
    for w in &p.warnings { eprintln!("kaviri: {}", w.text); }
    p.events
}
```

That is additive. Every existing caller and every existing test keeps working.

### What has to be separated for it to compile

`src/zoom.rs` will not build for `wasm32-unknown-unknown` as it stands, because the file mixes
the planner with the render: it imports `crate::cdp::FrameSpool` and `crate::backdrop`, spawns
`std::process::Command`, and touches the filesystem. The crate's dependencies are worse for wasm
than the file is: `tungstenite`, `libc` and `signal-hook` have no business in a browser.

The planning half has no I/O at all. It is `ZoomEvent`, `Mark`, `events_from_marks`,
`thin_paths`, `thin_path`, and the constants. Lifting exactly those into a `src/plan.rs` with no
imports beyond `std` would make the wasm target a small crate that depends on that module and
`serde_json`, and would leave `zoom.rs` as the render.

Two ways to package it, either is fine by us:

- a second crate in a workspace, `crates/kaviri-planner`, `crate-type = ["cdylib", "rlib"]`,
  depending on the planner module and `wasm-bindgen`; the binary depends on it too, so there is
  still one copy of the code;
- or a `wasm` feature on the existing crate that switches the crate type and drops the native
  dependencies. This tends to be more fiddly than it sounds, because a feature cannot remove a
  dependency, only add one.

Build, for reference:

```sh
wasm-pack build crates/kaviri-planner --target web --out-dir ../../../kaviri-cloud/playground/wasm
```

### Budget and constraints

- **Size.** Under 200 KB of wasm, gzipped, or the page is slower with it than without. A planner
  with `serde_json` and no panic machinery lands far under that. `panic = "abort"`,
  `opt-level = "z"` and `wasm-opt -Oz` if it does not.
- **No threads, no wasi, no filesystem.** `--target web`, a plain ES module.
- **No network.** The file is served from our origin next to the page.

---

## 2. A golden fixture both repositories test against

This is worth as much as the wasm build and costs an afternoon less.

A directory of cases in the recorder, each a marks array and the events the planner produces
from it:

```
tests/fixtures/plan/leans-left.json
tests/fixtures/plan/typing-pan.json
tests/fixtures/plan/merged-clicks.json
tests/fixtures/plan/no-tail.json
tests/fixtures/plan/thinning.json
```

```json
{
  "input": { "scale": 1.0, "frame_w": 2940, "frame_h": 1660, "duration": 18.4, "marks": [] },
  "expect": { "events": [], "warnings": [] }
}
```

A Rust test asserts the recorder still produces them. We vendor the same files and assert the
playground's planner produces them too, whichever implementation is live. That turns "the port
has drifted" from something a viewer might notice into something CI says out loud, and it keeps
working after the wasm build lands, because then it is checking the wasm shim instead.

Until the fixtures exist, `playground/js/selftest.js` re-runs the assertions from your
`zoom.rs` and `backdrop.rs` test modules against whichever planner loaded. Open the playground
with `?selftest`. It is a weaker guarantee than a golden file, because it checks properties
rather than numbers.

---

## 3. Two more ports we would rather not be carrying

Both are in `playground/js/backdrop.js`, both are transcribed from `src/backdrop.rs`, and both
are user-visible on the page:

- **`content_box`**, because the playground reports the content box and its origin next to the
  frame size, and being off by two pixels there would be a lie about an even-numbered constraint
  that exists for yuv420p.
- **the auto picker**, `measure` and `choose` and `Background::key`, because "which backdrop will
  auto choose for my page" is a question the playground can answer and the README cannot. We
  probe the fixture at two frames a second scaled to 12x12, which is what `probe` does with
  ffmpeg, and score with the same weights.

If the wasm crate lands, adding `content_box(out_w, out_h, aspect) -> [u32; 4]` and
`choose_from(hue: Option<f64>, lum: f64) -> String` to it would delete both ports. They are much
less likely to drift than the planner, so this is a nice-to-have rather than a request.

The gradient stops themselves also live in our copy, since a canvas has to paint them. Exporting
the table as JSON from the same crate would settle that too.

---

## 4. `brand/tokens.css` as a published asset

`playground/tokens.css` is a byte copy of `kaviri/brand/tokens.css` with a provenance header,
refreshed by `playground/build.sh`. That works because both checkouts sit side by side on a
developer's machine, and stops working the moment the playground is built anywhere else.

Publishing the tokens as a versioned file, anywhere fetchable, would let every surface reference
one copy. `https://kaviri.dev/brand/tokens.css` with a long cache lifetime would do.

---

## 5. Constants we have copied, and would like to hear about before they move

Changing any of these changes what the playground shows. If the wasm build lands, all of these
stop being our problem, which is the argument for the wasm build.

From `src/zoom.rs`: `EASE`, `FPS`, `LEFT_BIAS_TYPE`, `LEFT_BIAS_CLICK`, `KEEP_IN_FRAME`,
`FIT_MARGIN`, `HOLD_AFTER`, `LEAD_IN`, `MERGE_GAP`, `TAIL_MARGIN`, `MAX_TAIL_PAD`,
`WAYPOINT_MIN_GAP`, `PATH_BUDGET`, `PATH_BUDGET_TOTAL`, the zoom ladder thresholds
(0.45 and 0.25 of the frame height, 1.5 / 1.7 / 1.85), the 6px waypoint distance floor, the 1px
thinning floor, and the 0.4s pad `render_cfr` adds past the last captured frame.

From `src/ops.rs`, which the playground uses to model the clock: `CARET_SAMPLE_S`, the default
`typewriter_ms` of 18, and the sleeps that give each op its duration (120ms after
`scrollIntoView`, 500ms of cursor glide, 250ms after a click, 150ms after the click that
precedes typing, 800ms for a smooth scroll, 120ms for an instant one, 350ms after a navigate,
200ms after `start_recording`).

From `src/backdrop.rs`: `PAD_FRAC`, `RADIUS_FRAC`, `RADIUS_MIN`, `RADIUS_MAX`,
`SHADOW_BLUR_FRAC`, `SHADOW_DY`, `SHADOW_SPREAD`, `SHADOW_ALPHA`, every gradient stop, and the
picker's weights (0.6 hue, 0.4 lightness, 0.05 solid penalty, the 150 degree target, the 0.35
lightness window, the 0.06 rms chroma floor).

From `src/main.rs`: the preset table.

From `src/ops.rs` again: the cursor geometry, hot spots and the ripple, which
`playground/js/cursor.js` redraws on a canvas.

---

## 6. One thing we found while porting, which looks like a bug

Not a request, a report. In `ops.rs`, the `type` handler derives the caret samples' box from the
op's own bbox:

```rust
let field_h = bbox.map(|(_, _, _, h)| h).unwrap_or(24.0);
let field_y = bbox.map(|(_, y, _, _)| y).unwrap_or(0.0);
```

`bbox` is `None` for a `type` with no selector, which is the documented way to keep typing into a
field you already clicked. So that whole form of the op lays its pan down at `y = 0` with a
height of 24: the camera follows the caret horizontally along the **top edge of the viewport**,
not along the field the text is going into. The op's own mark carries no box either, so nothing
else in the event pulls the framing back down.

The recorder already knows where the caret is, and the caret measurement it takes returns the
line height as its third element:

```js
return [r.left + ox - (el.scrollLeft || 0), r.top + oy - (el.scrollTop || 0), lh];
```

`caret_x` throws away everything but the first element. Taking the second and third as the
fallback `field_y` and `field_h` would frame a selectorless `type` the same way a selectored one
is framed, with no new round trip.

The playground reproduces the current behaviour rather than the intended one, because that is its
job, and `js/sim.js` carries a comment saying so. It will follow whatever the recorder does.

---

## 7. Things we are explicitly not asking for

- **A wasm build of the recorder.** It is not possible and we would not ship it if it were.
  The playground says so on its face rather than implying otherwise.
- **Any change to the op protocol.** The playground validates against the rules as written in
  `ops.rs` and adds only the two extra refusals the hosted service documents, as notes rather
  than errors.
- **A headless mode that returns frames.** The playground draws a fixture. Filming a customer's
  real page is what the hosted service is for.
