/*
 * The zoom planner, ported to JavaScript from the recorder's src/zoom.rs.
 *
 * This file exists because the planner is the one part of kaviri that is pure arithmetic and so
 * the one part that can honestly run in a browser tab. The recorder itself drives headless
 * Chromium over CDP and shells out to ffmpeg, and neither of those can happen inside a page.
 *
 * It is a port, not the original, and a port silently drifting away from the thing it copies is
 * worse than no port at all. Two defences: planner-source.js prefers the recorder's own crate
 * compiled to wasm whenever that build is published, and selftest.js re-runs the assertions from
 * zoom.rs's Rust test module against whichever implementation is live. If you change a constant
 * here without changing it there, the self test is what is supposed to catch you.
 *
 * Every constant below is copied from zoom.rs. The comments explaining WHY each one has the
 * value it has live in zoom.rs, next to the code that is authoritative; repeating them here
 * would give two places to edit and one of them would go stale.
 */

export const EASE = 0.7;
export const FPS = 30;
export const HOLD_AFTER = 2.1;
export const LEAD_IN = 0.45;
export const TAIL_MARGIN = 0.05;
export const MAX_TAIL_PAD = HOLD_AFTER + EASE;

const LEFT_BIAS_TYPE = 0.18;
const LEFT_BIAS_CLICK = 0.12;
const KEEP_IN_FRAME = 0.06;
const FIT_MARGIN = 1.15;
const MERGE_GAP = 1.3;
const WAYPOINT_MIN_GAP = 0.04;
const PATH_BUDGET = 16;
const PATH_BUDGET_TOTAL = 192;

/** The kinds of mark that carry a bounding box and therefore earn a zoom. */
const ZOOMABLE = new Set(["click", "type"]);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Build the zoom timeline from interaction marks.
 *
 * `marks` are {t, kind, label, bbox: [x, y, w, h] | null} in CSS pixels, exactly the shape the
 * recorder's telemetry sidecar writes. `scale` converts CSS pixels to source video pixels;
 * `frameW` and `frameH` are the capture size in source pixels. Coordinates out are source pixels.
 *
 * The Rust version writes its two warnings to stderr, where a CLI user sees them. A page has no
 * stderr, so they are collected and returned instead: the playground shows them next to the
 * timeline, which is the whole reason someone would open the playground rather than guess.
 */
export function eventsFromMarks(marks, scale, frameW, frameH, duration) {
  const warnings = [];
  const targets = [];

  for (const m of marks) {
    if (!ZOOMABLE.has(m.kind) || !m.bbox) continue;
    const [x, y, w, h] = m.bbox;
    const cy = (y + h / 2) * scale;
    // Bigger targets get gentler zoom.
    const ladder = h * scale > frameH * 0.45 ? 1.5 : h * scale > frameH * 0.25 ? 1.7 : 1.85;
    // Bound the zoom by whichever axis runs out first, so a wide short element such as a nav bar
    // does not hang off both sides of the crop.
    const fitW = frameW / (w * scale * FIT_MARGIN);
    const fitH = frameH / (h * scale * FIT_MARGIN);
    const z = Math.max(Math.min(ladder, fitW, fitH), 1);
    const cropW = frameW / z;
    const want = m.kind === "type" ? LEFT_BIAS_TYPE : LEFT_BIAS_CLICK;
    const room = 0.5 - (w * scale) / 2 / cropW - KEEP_IN_FRAME;
    const bias = Math.min(want, Math.max(room, 0));
    const cx = (x + w / 2) * scale - cropW * bias;
    targets.push({
      t: m.t,
      cx: clamp(cx, 0, frameW),
      cy: clamp(cy, 0, frameH),
      z,
    });
  }

  const events = [];
  let i = 0;
  while (i < targets.length) {
    const first = targets[i];
    const ev = {
      t: Math.max(first.t - LEAD_IN, 0),
      end: first.t + HOLD_AFTER,
      cx: first.cx,
      cy: first.cy,
      z: first.z,
      path: [],
    };
    let j = i + 1;
    while (j < targets.length && targets[j].t < ev.end + MERGE_GAP) {
      const next = targets[j];
      const dist = Math.hypot(next.cx - ev.cx, next.cy - ev.cy);
      const lastWpT = ev.path.length ? ev.path[ev.path.length - 1][0] : ev.t + EASE;
      const wpT = Math.max(next.t, lastWpT + WAYPOINT_MIN_GAP);
      if (dist > 6) ev.path.push([wpT, next.cx, next.cy]);
      ev.end = wpT + HOLD_AFTER;
      ev.z = Math.min(ev.z, next.z); // never tighter than the loosest merged target
      j += 1;
    }
    ev.end = Math.min(ev.end, duration - TAIL_MARGIN);
    const before = ev.path.length;
    ev.path = ev.path.filter((p) => p[0] > ev.t + EASE && p[0] < ev.end - EASE);
    if (ev.path.length < before) {
      warnings.push({
        t: first.t,
        text:
          `${before - ev.path.length} pan waypoint(s) of the interaction at ` +
          `${first.t.toFixed(1)}s fall outside the zoom window and were dropped`,
      });
    }
    if (ev.end - ev.t >= 2 * EASE + 0.15) {
      events.push(ev);
    } else {
      warnings.push({
        t: first.t,
        text:
          `the interaction at ${first.t.toFixed(1)}s is too close to the end of the ` +
          `${duration.toFixed(1)}s take to be zoomed; add a trailing wait before stop_recording`,
      });
    }
    i = j;
  }

  thinPaths(events);
  return { events, warnings };
}

/** Reduce each event's waypoints to a budget, keeping the ones that carry the shape. */
function thinPaths(events) {
  const wanted = events.reduce((n, e) => n + Math.min(e.path.length, PATH_BUDGET), 0);
  const squeeze = wanted > PATH_BUDGET_TOTAL ? PATH_BUDGET_TOTAL / wanted : 1;
  const budget = Math.max(Math.floor(PATH_BUDGET * squeeze), 2);
  for (const ev of events) {
    if (ev.path.length > budget) ev.path = thinPath(ev.path, budget);
  }
}

/**
 * Ramer-Douglas-Peucker with a point budget: repeatedly keep whichever remaining waypoint is
 * furthest from the straight line the pan would otherwise take through its neighbours. Dropping
 * points uniformly instead would flatten exactly the corners a viewer notices.
 */
export function thinPath(path, budget) {
  if (path.length <= budget) return path.slice();
  const keep = [0, path.length - 1];
  while (keep.length < budget) {
    let best = null;
    for (let w = 0; w < keep.length - 1; w++) {
      const a = keep[w];
      const b = keep[w + 1];
      if (b <= a + 1) continue;
      const span = path[b][0] - path[a][0];
      let err = 0;
      let at = a;
      for (let i = a + 1; i < b; i++) {
        const p = path[i];
        const f = span > 1e-9 ? (p[0] - path[a][0]) / span : 0;
        const ex = path[a][1] + (path[b][1] - path[a][1]) * f - p[1];
        const ey = path[a][2] + (path[b][2] - path[a][2]) * f - p[2];
        const d = Math.hypot(ex, ey);
        if (d > err) {
          err = d;
          at = i;
        }
      }
      if (at > a && (best === null || err > best.err)) best = { err, pos: w + 1, idx: at };
    }
    // Below a pixel of error the waypoint is not describing a move anyone can see.
    if (best && best.err > 1) keep.splice(best.pos, 0, best.idx);
    else break;
  }
  return keep.map((i) => path[i]);
}

const smoothstep = (p) => {
  const c = clamp(p, 0, 1);
  return c * c * (3 - 2 * c);
};

/**
 * Where the camera is at time `t`, in source pixels.
 *
 * zoom.rs does not have this function: it emits ffmpeg expression text and ffmpeg evaluates it.
 * This is that evaluation, written out, and it has to agree with `build_expr` exactly or the
 * playback lies about what the render will do. Three details carry that agreement:
 *
 * - `build_expr` sorts events by descending t and nests each one outside the previous, so the
 *   EARLIEST event is tested first and wins any overlap. Hence the ascending scan and the first
 *   match, rather than the last.
 * - The pan's first waypoint is clocked at t0 + EASE, where the ease-in delivers its value, not
 *   at t0. Clocking it at t0 teleports the camera at the handover.
 * - Segments between waypoints are straight lines, not a smoothstep each. The ease belongs at
 *   the two ends of the whole move.
 */
export function cameraAt(events, t, frameW, frameH) {
  const wide = { z: 1, cx: frameW / 2, cy: frameH / 2 };
  const ordered = events.slice().sort((a, b) => a.t - b.t);
  const ev = ordered.find((e) => t >= e.t && t <= e.end);
  if (!ev) return wide;

  const easeInEnd = ev.t + EASE;
  const easeOutStart = ev.end - EASE;

  const axis = (base, value, points) => {
    if (t < easeInEnd) {
      const first = points ? points[0][1] : value;
      return base + (first - base) * smoothstep((t - ev.t) / EASE);
    }
    if (t < easeOutStart) {
      if (!points) return value;
      for (let k = 0; k < points.length - 1; k++) {
        const [ta, va] = points[k];
        const [tb, vb] = points[k + 1];
        if (t < tb) return va + (vb - va) * clamp((t - ta) / Math.max(tb - ta, 0.001), 0, 1);
      }
      return points[points.length - 1][1];
    }
    const last = points ? points[points.length - 1][1] : value;
    return last + (base - last) * smoothstep((t - easeOutStart) / EASE);
  };

  const ptsFor = (index) =>
    ev.path.length
      ? [[easeInEnd, index === 1 ? ev.cx : ev.cy], ...ev.path.map((p) => [p[0], p[index]])]
      : null;

  return {
    // z takes the simple branch even on an event with waypoints: the camera pans while zoomed,
    // it does not change zoom while panning.
    z: axis(1, ev.z, null),
    cx: axis(frameW / 2, ev.cx, ptsFor(1)),
    cy: axis(frameH / 2, ev.cy, ptsFor(2)),
  };
}

/**
 * The source rectangle ffmpeg's zoompan crops, for a camera and a frame size.
 *
 * A direct transcription of the x and y expressions in render_zoom, clamp included: without the
 * clamp the crop would run off the frame near an edge, and the playback would show content that
 * the render cannot.
 */
export function cropFor(camera, frameW, frameH) {
  const w = frameW / camera.z;
  const h = frameH / camera.z;
  return {
    x: clamp(camera.cx - w / 2, 0, frameW - w),
    y: clamp(camera.cy - h / 2, 0, frameH - h),
    w,
    h,
  };
}

/**
 * How much the tail of a take is stretched so the last interaction still gets its zoom, and the
 * take duration that follows from it. Ported from tail_pad_for and render_cfr in zoom.rs, where
 * the 0.4s is the pad render_cfr adds past the final captured frame.
 */
export function durationFor(marks, scriptEnd) {
  const rawEnd = scriptEnd + 0.4;
  let last = -Infinity;
  for (const m of marks) {
    if (m.bbox && ZOOMABLE.has(m.kind)) last = Math.max(last, m.t);
  }
  const pad = Number.isFinite(last)
    ? clamp(last + HOLD_AFTER + TAIL_MARGIN - rawEnd, 0, MAX_TAIL_PAD)
    : 0;
  return rawEnd + pad;
}

/** What this implementation calls itself, for the badge in the header. */
export const PLANNER_ID = {
  kind: "js-port",
  label: "JS port of src/zoom.rs",
};
