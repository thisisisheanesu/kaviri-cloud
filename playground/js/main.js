/*
 * Wiring. Everything interesting happens in the modules this file pulls together; what is left
 * here is reading the controls, recomputing when they change, and driving one animation frame
 * loop.
 *
 * One rule this file keeps: nothing is recomputed inside the draw loop. The simulation and the
 * plan are pure functions of the script and the preset, so they run when those change and the
 * loop only samples them. A planner that ran at 30Hz would be a planner nobody could profile.
 */

import { EXAMPLES, DEFAULT_EXAMPLE } from "./examples.js";
import { simulate, stateAt } from "./sim.js";
import { selectors } from "./scene.js";
import { BACKGROUNDS, backgroundByName } from "./backdrop.js";
import { drawFrame, drawOverview, frameGeometry, probeTake, makeTextMeasurer } from "./stage.js";
import { drawTimeline, timeAtX, TIMELINE_HEIGHT } from "./timeline.js";
import { initPlanner, plan as runPlanner, durationFor, source as plannerSource, FPS } from "./planner-source.js";
import * as api from "./api.js";
import { runSelfTest } from "./selftest.js";

/* The recorder's preset table, from src/main.rs. Viewport, capture scale and output size are
   three separate numbers on purpose: a vertical take wants a phone-width viewport so the site
   lays out like a phone, a high capture so zooms crop into real pixels, and a 1080x1920 file. */
const PRESETS = [
  { name: "desktop", css: [1470, 830], scale: 2.0, out: [1470, 830], about: "a laptop window" },
  { name: "tiktok", css: [432, 768], scale: 2.5, out: [1080, 1920], about: "9:16 vertical" },
  { name: "reels", css: [432, 768], scale: 2.5, out: [1080, 1920], about: "same as tiktok" },
  { name: "shorts", css: [432, 768], scale: 2.5, out: [1080, 1920], about: "same as tiktok" },
  { name: "square", css: [540, 540], scale: 2.0, out: [1080, 1080], about: "1:1 feed post" },
  { name: "landscape", css: [960, 540], scale: 2.0, out: [1920, 1080], about: "16:9 1080p" },
  { name: "readme", css: [1100, 620], scale: 2.0, out: [1100, 620], about: "sits in a README" },
  { name: "phone", css: [390, 844], scale: 3.0, out: [1170, 2532], about: "a device mock" },
];

const $ = (id) => document.getElementById(id);
const measureText = makeTextMeasurer();

const state = {
  t: 0,
  playing: false,
  speed: 1,
  loop: true,
  preset: PRESETS[0],
  backgroundName: "auto",
  cursorScale: 1.75,
  sim: null,
  plan: { events: [], warnings: [] },
  duration: 1,
  autoPick: null,
  lastFrameAt: 0,
};

/* ------------------------------------------------------------------ setup */

function fillSelects() {
  $("examples").innerHTML = EXAMPLES.map((e) => `<option value="${e.id}">${e.name}</option>`).join("");
  $("preset").innerHTML = PRESETS.map(
    (p) => `<option value="${p.name}">${p.name} · ${p.out[0]}x${p.out[1]}</option>`
  ).join("");
  $("background").innerHTML =
    `<option value="auto">auto</option><option value="none">none</option>` +
    BACKGROUNDS.map((b) => `<option value="${b.name}">${b.name}</option>`).join("");
}

function loadExample(id) {
  const ex = EXAMPLES.find((e) => e.id === id) || DEFAULT_EXAMPLE;
  $("script").value = ex.script;
  $("example-about").textContent = ex.about;
  const preset = PRESETS.find((p) => p.name === ex.preset);
  if (preset) {
    state.preset = preset;
    $("preset").value = preset.name;
  }
  state.t = 0;
  recompute();
}

function applyTheme(next) {
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem("kaviri-playground-theme", next);
  } catch {
    // A blocked storage is not a reason to refuse to change theme; it just will not be
    // remembered, which is a smaller loss than the exception would be.
  }
}

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem("kaviri-playground-theme");
  } catch {
    saved = null;
  }
  if (saved === "dark" || saved === "light") applyTheme(saved);
  $("theme-toggle").addEventListener("click", () => {
    const now =
      document.documentElement.getAttribute("data-theme") ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    applyTheme(now === "dark" ? "light" : "dark");
  });
}

/* ------------------------------------------------------- recompute the take */

function recompute() {
  const preset = state.preset;
  state.sim = simulate(
    $("script").value,
    { viewportW: preset.css[0], viewportH: preset.css[1] },
    measureText
  );
  const sim = state.sim;
  state.duration = Math.max(durationFor(sim.marks, sim.scriptEnd), 0.4);
  const frameW = preset.css[0] * preset.scale;
  const frameH = preset.css[1] * preset.scale;
  state.plan = runPlanner(sim.marks, preset.scale, frameW, frameH, state.duration);

  state.autoPick =
    state.backgroundName === "auto"
      ? probeTake(sim, state.plan, preset, state.duration, state.cursorScale)
      : null;

  $("scrub").max = String(state.duration);
  if (state.t > state.duration) state.t = 0;

  renderGutter();
  renderDiagnostics();
  renderWarnings();
  renderSelectorChips();
}

function currentBackground() {
  if (state.backgroundName === "none") return null;
  if (state.backgroundName === "auto") {
    return state.autoPick ? state.autoPick.background : BACKGROUNDS[0];
  }
  return backgroundByName(state.backgroundName);
}

/* ------------------------------------------------------------- the editor */

function renderGutter() {
  const lines = $("script").value.split("\n");
  const bad = new Set(state.sim.errors.map((e) => e.line));
  $("gutter").innerHTML = lines
    .map((_, i) => `<span class="${bad.has(i + 1) ? "bad" : ""}">${i + 1}</span>`)
    .join("");
}

function renderDiagnostics() {
  const { errors, notes, steps, marks } = state.sim;
  const rows = [];
  for (const e of errors) {
    rows.push({ level: "error", where: `line ${e.line}`, text: e.message });
  }
  for (const n of notes) {
    rows.push({ level: "note", where: `line ${n.line}`, text: n.message });
  }
  if (!errors.length) {
    const zoomable = marks.filter((m) => m.bbox).length;
    rows.unshift({
      level: "ok",
      where: "ok",
      text:
        `${steps.length} op${steps.length === 1 ? "" : "s"}, ${marks.length} marks ` +
        `(${zoomable} with a box), ${state.plan.events.length} zoom event` +
        `${state.plan.events.length === 1 ? "" : "s"}`,
    });
  }
  $("diagnostics").innerHTML = rows
    .map(
      (r) =>
        `<div class="diag" data-level="${r.level}"><span class="where">${escapeHtml(
          r.where
        )}</span><span>${escapeHtml(r.text)}</span></div>`
    )
    .join("");
}

function renderWarnings() {
  const items = state.plan.warnings.map((w) => `<div class="warn">${escapeHtml(w.text)}</div>`);
  $("planner-warnings").innerHTML = items.join("");
}

function renderSelectorChips() {
  const list = selectors(state.sim.scene);
  $("selector-list").innerHTML = list
    .map((s) => `<button type="button" data-sel="${escapeHtml(s)}">${escapeHtml(s)}</button>`)
    .join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

/* ------------------------------------------------------------- the drawing */

const dprNow = () => Math.min(window.devicePixelRatio || 1, 2);

/** Size a canvas we position ourselves: both CSS dimensions are ours to set. */
function sizeCanvas(canvas, cssW, cssH) {
  const dpr = dprNow();
  const w = Math.max(1, Math.round(cssW));
  const h = Math.max(1, Math.round(cssH));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  return { dpr, w, h };
}

/**
 * Size a canvas whose width the stylesheet owns.
 *
 * Measuring the parent instead would be wrong wherever the parent has padding, which is every
 * pane on this page: the canvas would be laid out two gutters narrower than the backing store it
 * was given and everything drawn in it would be stretched. `clientWidth` on the canvas itself is
 * the width it actually got, so only the height and the backing store are set here.
 */
function sizeCanvasToCss(canvas, cssH) {
  const dpr = dprNow();
  const w = Math.max(1, Math.round(canvas.clientWidth || canvas.parentElement.clientWidth || 640));
  const h = Math.max(1, Math.round(cssH));
  canvas.style.height = `${h}px`;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  return { dpr, w, h };
}

function draw() {
  const sim = state.sim;
  const geometry = frameGeometry(state.preset, currentBackground());
  const empty = $("stage-empty");

  if (sim.fatal) {
    empty.hidden = false;
    empty.textContent = `The script stops here: ${sim.fatal}`;
  } else if (!sim.marks.length) {
    empty.hidden = false;
    empty.textContent = "Nothing to film yet. Add an op.";
  } else {
    empty.hidden = true;
  }

  // The stage keeps the output's aspect and fills the width it is given, up to a height that
  // leaves the timeline on screen at the same time.
  const canvas = $("stage");
  const avail = canvas.parentElement.clientWidth || 640;
  const maxH = 540;
  let cssW = avail;
  let cssH = (cssW * geometry.outH) / geometry.outW;
  if (cssH > maxH) {
    cssH = maxH;
    cssW = (cssH * geometry.outW) / geometry.outH;
  }
  sizeCanvas(canvas, cssW, cssH);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Straight off the backing store rather than off the CSS size, so the rounding sizeCanvas did
  // cannot leave the drawing a fraction of a pixel wider than the canvas it lands on.
  ctx.scale(canvas.width / geometry.outW, canvas.height / geometry.outH);

  const frame = drawFrame(ctx, {
    sim,
    plan: state.plan,
    t: state.t,
    preset: state.preset,
    background: currentBackground(),
    cursorScale: state.cursorScale,
    geometry,
  });

  const ov = $("overview");
  const ovW = ov.clientWidth || 200;
  const ovH = Math.round((ovW * state.preset.css[1]) / state.preset.css[0]);
  const ovSize = sizeCanvasToCss(ov, Math.min(ovH, 260));
  const octx = ov.getContext("2d");
  octx.setTransform(ovSize.dpr, 0, 0, ovSize.dpr, 0, 0);
  drawOverview(octx, {
    sim,
    preset: state.preset,
    crop: frame.crop,
    state: frame.state,
    w: ovSize.w,
    h: ovSize.h,
    cursorScale: state.cursorScale,
  });

  const tl = $("timeline");
  const tlSize = sizeCanvasToCss(tl, TIMELINE_HEIGHT);
  const tctx = tl.getContext("2d");
  tctx.setTransform(tlSize.dpr, 0, 0, tlSize.dpr, 0, 0);
  drawTimeline(tctx, {
    sim,
    plan: state.plan,
    duration: state.duration,
    t: state.t,
    w: tlSize.w,
    host: document.body,
  });

  renderReadout(frame, geometry);
  $("time").textContent = `${state.t.toFixed(2)} / ${state.duration.toFixed(2)}s`;
  if (document.activeElement !== $("scrub")) $("scrub").value = String(state.t);
}

function renderReadout(frame, geometry) {
  const p = state.preset;
  const bg = currentBackground();
  const waypoints = state.plan.events.reduce((n, e) => n + e.path.length, 0);
  // render_cfr pads 0.4s past the last captured frame before any tail padding, so the tail the
  // planner asked for is whatever is left over that.
  const tailPad = Math.max(state.duration - (state.sim.scriptEnd + 0.4), 0);
  const rows = [
    ["preset", `${p.name}`],
    ["viewport", `${p.css[0]}x${p.css[1]} css`],
    ["capture", `${geometry.frameW}x${geometry.frameH} at ${p.scale}x`],
    ["output", `${geometry.outW}x${geometry.outH}`],
    ["content box", `${geometry.box.w}x${geometry.box.h} at ${geometry.box.x},${geometry.box.y}`],
    ["duration", `${state.duration.toFixed(2)}s · ${Math.round(state.duration * FPS)} frames`],
    // The recorder holds the last captured frame rather than lose the zoom on the thing the
    // take was demonstrating. That is honest, because nothing happened after it either way, but
    // it means a script with no trailing wait ends on a still, and only this number says so.
    [
      "tail pad",
      tailPad > 0.01
        ? `${tailPad.toFixed(2)}s of held final frame; add a trailing wait to fill it`
        : "none, the script films its own ending",
    ],
    ["zoom events", `${state.plan.events.length} · ${waypoints} waypoints`],
    ["camera", `z ${frame.camera.z.toFixed(3)}  cx ${frame.camera.cx.toFixed(0)}  cy ${frame.camera.cy.toFixed(0)}`],
    ["crop", `${Math.round(frame.crop.w)}x${Math.round(frame.crop.h)} at ${Math.round(frame.crop.x)},${Math.round(frame.crop.y)}`],
    [
      "backdrop",
      bg
        ? state.backgroundName === "auto" && state.autoPick
          ? `${bg.name} (auto: ${state.autoPick.reason})`
          : bg.name
        : "none, full frame",
    ],
    ["planner", plannerSource.label],
  ];
  $("readout").innerHTML = rows
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
    .join("");
}

function loop(now) {
  if (state.playing) {
    const dt = state.lastFrameAt ? Math.min((now - state.lastFrameAt) / 1000, 0.25) : 0;
    state.t += dt * state.speed;
    if (state.t >= state.duration) {
      if (state.loop) state.t = 0;
      else {
        state.t = state.duration;
        setPlaying(false);
      }
    }
  }
  state.lastFrameAt = now;
  draw();
  requestAnimationFrame(loop);
}

function setPlaying(on) {
  state.playing = on;
  $("play").textContent = on ? "Pause" : "Play";
}

/* ------------------------------------------------------------- the service */

const apiState = { inFlight: false, jobId: null, abort: null };

function apiBase() {
  return ($("api-base").value || api.DEFAULT_BASE).replace(/\/+$/, "");
}

function showApiStatus(level, title, detail, meta, progress) {
  const el = $("api-status");
  el.hidden = false;
  el.dataset.level = level;
  el.innerHTML =
    `<div class="title">${escapeHtml(title)}</div>` +
    (detail ? `<div>${escapeHtml(detail)}</div>` : "") +
    (meta ? `<div class="meta">${escapeHtml(meta)}</div>` : "") +
    (progress !== undefined ? `<div class="progress"><i></i></div>` : "");
  // Set through the CSSOM rather than as a style attribute in that markup. The page's
  // Content-Security-Policy does not carry unsafe-inline, which blocks a style attribute parsed
  // out of HTML but not a property assignment, so the bar would otherwise always read zero.
  if (progress !== undefined) {
    const bar = el.querySelector(".progress > i");
    if (bar) bar.style.width = `${Math.round(Math.max(0, Math.min(progress, 1)) * 100)}%`;
  }
}

function scriptAsArray() {
  return state.sim.ops.map((o) => o.value);
}

async function submitTake() {
  if (apiState.inFlight) return;
  const key = $("api-key").value.trim();
  const shape = api.checkKeyShape(key);
  if (!shape.ok) {
    showApiStatus("error", "That key will not work", shape.message);
    return;
  }
  if (state.sim.errors.length) {
    showApiStatus(
      "error",
      "Fix the script first",
      "The service validates every op before it queues a job, so this would come straight back as a 422."
    );
    return;
  }
  const project = $("api-project").value.trim();
  if (!/^[a-z0-9-]{1,40}$/.test(project)) {
    showApiStatus("error", "Project slug", "Lowercase letters, digits and hyphens, 1 to 40 characters.");
    return;
  }

  const options = {
    preset: state.preset.name,
    background: state.backgroundName,
    scale: state.preset.scale,
  };
  if (state.cursorScale === 0) options.cursor = "none";
  else options.cursor_scale = Number(state.cursorScale.toFixed(2));

  apiState.inFlight = true;
  $("api-send").disabled = true;
  $("api-result").hidden = true;
  showApiStatus("info", "Submitting", `${scriptAsArray().length} ops to ${apiBase()}`);

  try {
    const { status, body } = await api.submitJob(apiBase(), key, {
      project,
      script: scriptAsArray(),
      options,
      source: { client: "playground" },
    });
    apiState.jobId = body.id;
    $("api-cancel").hidden = false;
    showApiStatus(
      "info",
      status === 200 ? "An earlier job matched" : "Queued",
      `job ${body.id}`,
      `status ${body.status}`,
      0
    );
    const finished = await api.pollToEnd(apiBase(), key, body.id, (job) => {
      const meta = [
        `status ${job.status}`,
        job.attempt ? `attempt ${job.attempt} of ${job.max_attempts}` : null,
        job.queue_position !== undefined ? `queue position ${job.queue_position}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      showApiStatus("info", job.message || job.status, `job ${job.id}`, meta, job.progress || 0);
    });
    await presentResult(finished, key);
  } catch (e) {
    const d = api.describeError(e);
    showApiStatus("error", d.title, d.detail, d.meta);
  } finally {
    apiState.inFlight = false;
    $("api-send").disabled = false;
    $("api-cancel").hidden = true;
  }
}

async function presentResult(job, key) {
  if (!job) return;
  const box = $("api-result");
  if (job.status === "failed") {
    const err = job.error || {};
    showApiStatus(
      "error",
      `Failed: ${err.code || "unknown"}`,
      err.message || "",
      err.retryable === false ? "not retryable" : ""
    );
  } else if (job.status !== "done") {
    showApiStatus("info", job.status, `job ${job.id}`);
  } else {
    showApiStatus("info", "Done", `job ${job.id}`, `${job.render_seconds || 0}s of render`, 1);
  }

  const video = (job.artifacts || []).find((a) => a.kind === "video");
  if (!video) {
    box.hidden = true;
    return;
  }
  try {
    const signed = await api.artifactUrl(apiBase(), key, job.id, "video");
    box.hidden = false;
    box.innerHTML =
      `<div>${video.partial ? "A partial take, up to the op that failed." : "Your take."} ` +
      `${video.bytes ? `${(video.bytes / 1048576).toFixed(1)} MB` : ""}` +
      `${video.width ? ` · ${video.width}x${video.height}` : ""}</div>` +
      `<video controls playsinline src="${escapeHtml(signed.url)}"></video>` +
      `<p class="hint">The link is signed and short lived; download it rather than bookmarking it.</p>`;
  } catch (e) {
    const d = api.describeError(e);
    showApiStatus("error", d.title, d.detail, d.meta);
  }
}

async function checkUsage() {
  const key = $("api-key").value.trim();
  const shape = api.checkKeyShape(key);
  if (!shape.ok) {
    showApiStatus("error", "That key will not work", shape.message);
    return;
  }
  try {
    const usage = await api.getUsage(apiBase(), key);
    const u = usage.usage || {};
    const l = usage.limits || {};
    const limit = (v) => (v === null || v === undefined ? "unlimited" : v);
    showApiStatus(
      "info",
      `Usage for ${usage.period_month}`,
      `${u.jobs_submitted || 0} submitted, ${u.jobs_completed || 0} completed, ` +
        `${Math.round(u.render_seconds || 0)}s rendered`,
      `plan ${l.plan_code} · concurrent ${limit(l.max_concurrent_renders)} · ` +
        `jobs ${limit(l.max_jobs_per_month)} · retention ${limit(l.artifact_retention_days)} days`
    );
  } catch (e) {
    const d = api.describeError(e);
    showApiStatus("error", d.title, d.detail, d.meta);
  }
}

function rememberKey() {
  if (!$("api-remember").checked) return;
  try {
    sessionStorage.setItem("kaviri-playground-key", $("api-key").value.trim());
  } catch {
    // Storage can be blocked outright. The key still works for this page load.
  }
}

function forgetKey() {
  $("api-key").value = "";
  $("api-remember").checked = false;
  try {
    sessionStorage.removeItem("kaviri-playground-key");
  } catch {
    // Nothing to do: if it cannot be removed it was never written.
  }
  showApiStatus("info", "Key cleared", "It is gone from this tab.");
}

/* -------------------------------------------------------------- self test */

function maybeSelfTest() {
  if (!new URLSearchParams(location.search).has("selftest")) return;
  const section = $("selftest");
  section.hidden = false;
  const results = runSelfTest();
  $("selftest-results").innerHTML = results
    .map(
      (r) =>
        `<li class="${r.ok ? "" : "bad"}">${escapeHtml(r.name)}` +
        (r.ok ? "" : `<span class="why">${escapeHtml(r.message)}</span>`) +
        `</li>`
    )
    .join("");
}

/* ------------------------------------------------------------------ events */

function wire() {
  let debounce = null;
  $("script").addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(recompute, 140);
    renderGutter();
  });
  $("script").addEventListener("scroll", () => {
    $("gutter").scrollTop = $("script").scrollTop;
  });
  $("examples").addEventListener("change", (e) => loadExample(e.target.value));
  $("preset").addEventListener("change", (e) => {
    state.preset = PRESETS.find((p) => p.name === e.target.value) || PRESETS[0];
    recompute();
  });
  $("background").addEventListener("change", (e) => {
    state.backgroundName = e.target.value;
    recompute();
  });
  $("cursor-scale").addEventListener("input", (e) => {
    state.cursorScale = Number(e.target.value);
    // The pointer is part of the page, so it is inside the probe the auto picker measures.
    if (state.backgroundName === "auto") recompute();
  });
  $("play").addEventListener("click", () => {
    if (!state.playing && state.t >= state.duration) state.t = 0;
    setPlaying(!state.playing);
  });
  $("step-back").addEventListener("click", () => {
    setPlaying(false);
    state.t = Math.max(0, state.t - 1 / FPS);
  });
  $("step-fwd").addEventListener("click", () => {
    setPlaying(false);
    state.t = Math.min(state.duration, state.t + 1 / FPS);
  });
  $("scrub").addEventListener("input", (e) => {
    setPlaying(false);
    state.t = Number(e.target.value);
  });
  $("speed").addEventListener("change", (e) => {
    state.speed = Number(e.target.value);
  });
  $("loop").addEventListener("change", (e) => {
    state.loop = e.target.checked;
  });
  $("timeline").addEventListener("pointerdown", (e) => {
    const move = (ev) => {
      const rect = $("timeline").getBoundingClientRect();
      setPlaying(false);
      state.t = timeAtX(ev.clientX - rect.left, rect.width, state.duration);
    };
    move(e);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
  $("selector-list").addEventListener("click", (e) => {
    const sel = e.target && e.target.dataset ? e.target.dataset.sel : null;
    if (!sel) return;
    navigator.clipboard && navigator.clipboard.writeText(sel);
    e.target.textContent = "copied";
    setTimeout(() => {
      e.target.textContent = sel;
    }, 900);
  });
  document.addEventListener("keydown", (e) => {
    if (e.target && ["TEXTAREA", "INPUT", "SELECT"].includes(e.target.tagName)) return;
    if (e.code === "Space") {
      e.preventDefault();
      setPlaying(!state.playing);
    }
  });

  $("api-send").addEventListener("click", submitTake);
  $("api-usage-btn").addEventListener("click", checkUsage);
  $("api-forget").addEventListener("click", forgetKey);
  $("api-key").addEventListener("change", rememberKey);
  $("api-remember").addEventListener("change", rememberKey);
  $("api-cancel").addEventListener("click", async () => {
    if (!apiState.jobId) return;
    try {
      await api.cancelJob(apiBase(), $("api-key").value.trim(), apiState.jobId);
      showApiStatus("info", "Cancellation requested", "It takes effect within one heartbeat.");
    } catch (e) {
      const d = api.describeError(e);
      showApiStatus("error", d.title, d.detail, d.meta);
    }
  });
}

/* --------------------------------------------------------------- start up */

function start() {
  initTheme();
  fillSelects();
  $("api-base").value = api.DEFAULT_BASE;
  try {
    const saved = sessionStorage.getItem("kaviri-playground-key");
    if (saved) {
      $("api-key").value = saved;
      $("api-remember").checked = true;
    }
  } catch {
    // No session storage: the key field simply starts empty.
  }
  wire();
  loadExample(DEFAULT_EXAMPLE.id);
  maybeSelfTest();
  requestAnimationFrame(loop);

  initPlanner().then((src) => {
    const badge = $("planner-badge");
    badge.textContent = `planner: ${src.kind === "wasm" ? "wasm" : "js port"}`;
    badge.dataset.kind = src.kind;
    badge.title = `${src.label} (${src.detail})`;
    // A wasm planner may disagree with the port, so the take is replanned rather than left
    // showing whatever the port produced during the first paint, and the self test is re-run
    // against whichever implementation actually won.
    recompute();
    maybeSelfTest();
  });
}

start();

// Exposed for the console and for anyone poking at the page, which is a reasonable thing to do
// in a playground. Nothing here is load bearing.
window.kaviriPlayground = { state, PRESETS, stateAt, recompute };
