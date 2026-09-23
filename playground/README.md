# playground

The browser playground at play.kaviri.dev. Edit a kaviri script, watch the real zoom planner cut
the camera over a fixture page, and optionally paste an API key to send the same script to the
hosted service for a real render.

No framework, no build step, no dependencies. Canvas and vanilla ES modules. It is a directory of
static files and it is meant to stay one.

## Run it

ES modules do not load from `file://`, so it needs a server. Any of these:

```sh
python3 -m http.server 8099 --directory playground
npx serve -l 8099 playground
wrangler pages dev playground
```

Then open `http://127.0.0.1:8099/`. Append `?selftest` to run the ported assertions from the
recorder's own test modules against whichever planner loaded.

## What is real and what is not

This is the part to get right, and the page says all of it on its face rather than only here.

| | |
|---|---|
| **The planner** | Real. `js/planner.js` is a port of the recorder's `src/zoom.rs`, constant for constant, and `js/planner-source.js` swaps it for the crate compiled to wasm the moment that build is published. The badge in the header says which one is running. |
| **The page being filmed** | A fixture, laid out in `js/scene.js`. A tab cannot drive or measure someone else's site. The fixture's geometry is honest, so the framing is computed from real boxes, but the shop and everything in it is invented. |
| **The clock** | Modelled in `js/sim.js` from the sleeps in the recorder's `src/ops.rs`. Two durations cannot be modelled from source because they depend on a page that is not here, a navigation and a selector wait, and both are labelled as estimates and drawn faded on the timeline. |
| **The backdrop** | Real stops, real `content_box`, real auto picker including the probe, ported in `js/backdrop.js`. The deterministic dither and the three-pass box blur are not ported: the first exists to survive h264 and the second is what a canvas shadow already approximates. |
| **The cursor** | The recorder's own geometry and hot spots, redrawn on canvas in `js/cursor.js`. |
| **The playback resolution** | Better than a render, and the page says so. The fixture is vectors drawn through the crop, so a zoom here never runs out of pixels. A real take crops into captured frames, and how far it can go before it softens is what `--scale` buys. |
| **The recorder** | Not here and cannot be. It drives headless Chromium over CDP and shells out to ffmpeg. |

## Files

```
index.html            the page
styles.css            its styling, tokens only
tokens.css            a copy of the recorder's brand/tokens.css, refreshed by build.sh
build.sh              refreshes that copy, and nothing else
_headers              CSP and caching for a static host
js/planner.js         the port of src/zoom.rs, plus the camera sampler
js/planner-source.js  loads the wasm planner if it exists, falls back to the port
js/sim.js             script text to marks and playback beats, on the recorder's clock
js/scene.js           the fixture page: layout, selectors, drawing
js/cursor.js          the injected pointer and the click ripple
js/backdrop.js        gradients, content box, auto picker
js/stage.js           one frame drawn: crop transform, plate, overview, probe
js/timeline.js        ops, zoom events and the zoom curve
js/api.js             the hosted service client, coded against ../docs/API.md
js/examples.js        the built-in scripts
js/selftest.js        the recorder's assertions, re-run here
js/main.js            wiring
wasm/                 empty until the recorder publishes the planner build
```

`NEEDS-FROM-RECORDER.md` is the coordination document for everything this directory would rather
not be carrying. The recorder repository is not ours to edit, so requests go there.

## What this directory needs from the rest of kaviri-cloud

**CORS on the API, for this origin.** The key panel does `fetch` from `https://play.kaviri.dev`
to `https://api.kaviri.dev`, which is cross-origin. The edge needs to answer the preflight and
allow the `Authorization` and `Content-Type` headers on `POST /v1/jobs`, `GET /v1/jobs/{id}`,
`GET /v1/jobs/{id}/artifact`, `POST /v1/jobs/{id}/cancel` and `GET /v1/usage`, and to expose
`X-Kaviri-Request-Id`, `Retry-After` and the three `X-RateLimit-*` headers to script. Without the
last of those the page cannot honour `Retry-After` and will earn its own `429`.

The client reads the error envelope documented in `docs/API.md` exactly: `error.code`,
`error.message`, `error.detail`, `error.request_id`. It branches on `code`, shows `message`
verbatim, and quotes `request_id` in every failure, so a support request from a playground user
arrives with the thing you need to look it up.

**The artifact fetch uses `?redirect=false`** rather than following the 302, because whether an
engine re-sends an `Authorization` header across a redirect is not a thing to guess about with a
credential. The signed URL it returns is put straight into a `<video>` element.

## Security posture

- The API key lives in memory, and in `sessionStorage` only when the visitor ticks the box.
  `sessionStorage` rather than `localStorage` on purpose: it dies with the tab, which is the
  right lifetime for a credential pasted into a playground. There is a Forget button.
- The key goes into exactly one place: the `Authorization` header on a request to the API base.
  Never a URL, never a query string, never an error message.
- `_headers` pins `connect-src` to `'self'` and the official API. **A self-hosted copy pointed at
  a different API base has to edit that line**, or the browser will block the request and the
  page will report it as unreachable, which is a confusing way to learn about your own CSP.
- `script-src` includes `'wasm-unsafe-eval'`, which is what instantiating a wasm module needs
  and is narrower than `'unsafe-eval'`.

## Adding an example

`js/examples.js`, one object: `id`, `name`, `preset`, `about`, `script`. Write it against the
fixture's selectors, which the page lists under the editor. An example that demonstrates a
failure mode is worth more than one that works, which is why `no-tail` is in there.

## Adding to the fixture

`js/scene.js`. Nodes are laid out in one pass down the page, so a new node goes where its
position in the list puts it. Give it a `sel` if a script should be able to target it, a `kind`
the renderer knows how to draw, and remember that a narrow viewport relays the whole page: check
both `desktop` and `tiktok` before calling it done.

Keep the content fictional. A mock that quotes a real company, a real price or a real person is
how a screenshot of a demo ends up being read as a fact about them.
