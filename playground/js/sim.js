/*
 * Script text to a timeline: validation, the marks the planner consumes, and the beats the
 * canvas plays back.
 *
 * This is a simulation of the recorder's clock, not a measurement of one. Every number in
 * TIMING below is lifted from the sleeps in the recorder's src/ops.rs, so the shape of a take is
 * right and the merge window, the tail padding and the dropped-zoom warnings all trigger where
 * they really would. Two of them cannot be lifted, because they depend on a page that is not
 * here: how long a navigation takes, and how long a selector takes to appear. Those are marked
 * `estimate` and surfaced as such in the UI, because a visitor who thinks the playground
 * measured their site's load time has been misled by us.
 *
 * The validation rules are the recorder's, taken from ops.rs, plus the two extra refusals the
 * hosted service documents in docs/API.md. Where the service is stricter than the recorder that
 * is a note rather than an error, so a script that is perfectly valid locally does not get
 * marked wrong in a playground whose whole point is to run it locally.
 */

import { buildScene, findNode, isEditable, cursorKindFor, fieldTextOrigin } from "./scene.js";

export const TIMING = {
  /* Lifted from ops.rs. */
  startRecording: 0.2,
  navigateSettle: 0.35,
  resolveSettle: 0.12,
  cursorGlide: 0.5,
  clickSettle: 0.25,
  typeClickSettle: 0.15,
  scrollSmooth: 0.8,
  scrollInstant: 0.12,
  typewriterMs: 18,
  caretSample: 0.12,
  /* Not in ops.rs, because only the page knows. */
  navigateLoadEstimate: 0.6,
  waitSelectorEstimate: 0.4,
};

const OPS = new Set([
  "navigate",
  "click",
  "type",
  "scroll",
  "wait",
  "mark",
  "start_recording",
  "stop_recording",
]);

const KNOWN_FIELDS = {
  navigate: ["op", "url", "timeout_ms"],
  click: ["op", "selector", "x", "y"],
  type: ["op", "selector", "text", "typewriter_ms"],
  scroll: ["op", "y", "smooth"],
  wait: ["op", "ms", "selector", "timeout_ms", "visible"],
  mark: ["op", "label"],
  start_recording: ["op", "path"],
  stop_recording: ["op"],
};

/** Parse NDJSON, keeping each op's source line so an error can point at it. */
export function parseScript(text) {
  const out = [];
  const errors = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) return;
    try {
      const value = JSON.parse(line);
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        errors.push({ line: i + 1, message: "each line must be a JSON object" });
        return;
      }
      out.push({ line: i + 1, value });
    } catch (e) {
      errors.push({ line: i + 1, message: `not valid JSON: ${e.message}` });
    }
  });
  return { ops: out, errors };
}

function duration(op, field, dflt) {
  const v = op[field];
  if (v === undefined || v === null) return { value: dflt };
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    return {
      error: `${field} must be a non-negative number of milliseconds, got ${JSON.stringify(v)}`,
    };
  }
  return { value: v };
}

/**
 * Run a script against the fixture.
 *
 * Returns everything the rest of the page needs: the errors to show in the gutter, the marks to
 * hand the planner, the beats to animate, and the duration the render would come out at.
 */
export function simulate(scriptText, options, measureText) {
  const scene = buildScene(options.viewportW);
  const viewportH = options.viewportH;
  const maxScroll = Math.max(0, scene.docHeight - viewportH);

  const { ops, errors } = parseScript(scriptText);
  const notes = [];
  const marks = [];
  const beats = [];
  const steps = [];

  let t = 0;
  let scrollY = 0;
  let focus = null;
  const typed = {};
  let cursor = { x: options.viewportW * 0.5, y: viewportH * 0.72, shape: "arrow" };
  let fatal = null;

  const fail = (line, message) => {
    errors.push({ line, message });
    fatal = message;
  };

  const mark = (kind, label, bbox) => {
    marks.push({ t, kind, label, bbox: bbox || null });
  };

  // The service wraps every script in a recording, and so does the recorder in record mode when
  // the script does not start one itself.
  if (!ops.some((o) => o.value.op === "start_recording")) {
    t += TIMING.startRecording;
  }

  for (let index = 0; index < ops.length && !fatal; index++) {
    const { line, value: op } = ops[index];
    const kind = op.op;
    const t0 = t;

    if (typeof kind !== "string") {
      fail(line, 'missing "op" field');
      break;
    }
    if (!OPS.has(kind)) {
      fail(line, `unknown op: ${kind}`);
      break;
    }
    const unknown = Object.keys(op).filter((k) => !KNOWN_FIELDS[kind].includes(k));
    if (unknown.length) {
      notes.push({
        line,
        message: `${kind} does not use ${unknown.join(", ")}; the recorder ignores extra fields`,
      });
    }

    switch (kind) {
      case "start_recording": {
        t += TIMING.startRecording;
        break;
      }
      case "stop_recording": {
        // The render happens after the last frame, so it costs the take no time.
        break;
      }
      case "navigate": {
        if (typeof op.url !== "string" || !op.url) {
          fail(line, "navigate needs url");
          break;
        }
        if (!/^https?:\/\//i.test(op.url)) {
          notes.push({
            line,
            message:
              "the hosted service accepts only absolute http or https URLs; the recorder would " +
              "also take a local path",
          });
        }
        const d = duration(op, "timeout_ms", 25000);
        if (d.error) {
          fail(line, d.error);
          break;
        }
        // The fixture is the only page the playground has, so a navigate resets it rather than
        // fetching anything. The clock still advances, with an estimate that is labelled.
        scrollY = 0;
        focus = null;
        for (const k of Object.keys(typed)) delete typed[k];
        beats.push({ kind: "reset", t: t + TIMING.navigateLoadEstimate });
        t += TIMING.navigateLoadEstimate + TIMING.navigateSettle;
        mark("navigate", op.url, null);
        steps.push({ index, line, op: kind, label: op.url, t0, t1: t, estimated: true });
        continue;
      }
      case "click": {
        let node = null;
        let point;
        let bbox;
        if (typeof op.selector === "string") {
          node = findNode(scene, op.selector);
          if (!node) {
            fail(line, `selector not found: ${op.selector}`);
            break;
          }
          // resolve_box scrolls the target to the middle of the viewport before measuring it.
          scrollY = Math.max(0, Math.min(node.y + node.h / 2 - viewportH / 2, maxScroll));
          beats.push({ kind: "scroll-to", t, y: scrollY });
          t += TIMING.resolveSettle;
          bbox = [node.x, node.y - scrollY, node.w, node.h];
          point = [node.x + node.w / 2, node.y - scrollY + node.h / 2];
        } else if (typeof op.x === "number" && typeof op.y === "number") {
          point = [op.x, op.y];
          bbox = [op.x - 10, op.y - 10, 20, 20];
        } else {
          fail(line, "click needs selector or x/y");
          break;
        }
        const shape = cursorKindFor(node);
        beats.push({
          kind: "cursor",
          t0: t,
          t1: t + TIMING.cursorGlide,
          from: { ...cursor },
          to: { x: point[0], y: point[1], shape },
        });
        t += TIMING.cursorGlide;
        cursor = { x: point[0], y: point[1], shape };
        mark("click", op.selector || "point", bbox);
        beats.push({ kind: "ripple", t, x: point[0], y: point[1] });
        if (node) beats.push({ kind: "press", t0: t, t1: t + 0.16, sel: node.sel });
        focus = node && isEditable(node) ? node.sel : null;
        beats.push({ kind: "focus", t, sel: focus });
        t += TIMING.clickSettle;
        steps.push({ index, line, op: kind, label: op.selector || "point", t0, t1: t });
        continue;
      }
      case "type": {
        if (typeof op.text !== "string") {
          fail(line, "type needs text");
          break;
        }
        const per = duration(op, "typewriter_ms", TIMING.typewriterMs);
        if (per.error) {
          fail(line, per.error);
          break;
        }
        let node = null;
        let bbox = null;
        if (typeof op.selector === "string") {
          node = findNode(scene, op.selector);
          if (!node) {
            fail(line, `selector not found: ${op.selector}`);
            break;
          }
          if (!isEditable(node)) {
            notes.push({
              line,
              message:
                `${op.selector} is not a text field on the fixture, so the characters would go ` +
                "nowhere; the camera still frames it",
            });
          }
          scrollY = Math.max(0, Math.min(node.y + node.h / 2 - viewportH / 2, maxScroll));
          beats.push({ kind: "scroll-to", t, y: scrollY });
          t += TIMING.resolveSettle;
          const point = [node.x + node.w / 2, node.y - scrollY + node.h / 2];
          beats.push({
            kind: "cursor",
            t0: t,
            t1: t + TIMING.cursorGlide,
            from: { ...cursor },
            to: { x: point[0], y: point[1], shape: cursorKindFor(node) },
          });
          t += TIMING.cursorGlide;
          cursor = { x: point[0], y: point[1], shape: cursorKindFor(node) };
          beats.push({ kind: "ripple", t, x: point[0], y: point[1] });
          focus = isEditable(node) ? node.sel : null;
          beats.push({ kind: "focus", t, sel: focus });
          t += TIMING.typeClickSettle;
          bbox = [node.x, node.y - scrollY, node.w, node.h];
        } else {
          // type without a selector goes to document.activeElement, and the recorder refuses it
          // outright when nothing editable holds focus rather than typing into the void.
          if (!focus) {
            fail(
              line,
              "type without a selector needs a focused editable element; click one first, " +
                "or pass a selector"
            );
            break;
          }
        }

        // Whichever spelling of the op this was, the text lands in whatever holds focus.
        const target = focus ? findNode(scene, focus) : null;
        const before = target ? typed[target.sel] || "" : "";
        const after = before + op.text;
        const tStart = t;
        const span = (op.text.length * per.value) / 1000;
        t += span;
        beats.push({
          kind: "type",
          t0: tStart,
          t1: t,
          sel: target ? target.sel : null,
          before,
          text: op.text,
        });
        // The op's own mark carries the field's box. The caret samples that follow carry a
        // sliver at the caret, which is what the camera actually pans along.
        marks.push({ t: tStart, kind: "type", label: op.selector || "", bbox });
        if (target && isEditable(target)) {
          typed[target.sel] = after;
          const origin = fieldTextOrigin(target);
          const x0 = origin.x + measureText(before);
          const x1 = origin.x + measureText(after);
          /*
           * The caret's box comes from the op's own bbox, and a type without a selector has
           * none: ops.rs falls back to y = 0 and h = 24 there, so the pan runs along the top of
           * the viewport rather than along the field. That is a quirk rather than a decision,
           * but reproducing it is the point of this file, and a playground that quietly did the
           * nicer thing would hide a real difference between the two spellings of the op.
           */
          const fieldY = bbox ? bbox[1] : 0;
          const fieldH = bbox ? bbox[3] : 24;
          if (span > 0.2 && Math.abs(x1 - x0) > 1) {
            const n = Math.min(Math.max(Math.round(span / TIMING.caretSample), 2), 40);
            for (let k = 1; k <= n; k++) {
              const f = k / n;
              marks.push({
                t: tStart + span * f,
                kind: "type",
                label: target.sel,
                bbox: [x0 + (x1 - x0) * f, fieldY, 2, fieldH],
              });
            }
          }
        }
        steps.push({ index, line, op: kind, label: op.selector || "(focused)", t0, t1: t });
        continue;
      }
      case "scroll": {
        if (typeof op.y !== "number" || !Number.isFinite(op.y) || op.y < 0) {
          fail(
            line,
            "scroll needs y: a finite, non-negative number of CSS pixels, absolute from the " +
              "top of the document"
          );
          break;
        }
        const smooth = op.smooth !== false;
        const to = Math.min(op.y, maxScroll);
        if (op.y > maxScroll) {
          notes.push({
            line,
            message: `the fixture is ${scene.docHeight}px tall, so y=${op.y} lands at its bottom`,
          });
        }
        beats.push({
          kind: "scroll",
          t0: t,
          t1: t + (smooth ? TIMING.scrollSmooth : TIMING.scrollInstant),
          from: scrollY,
          to,
          smooth,
        });
        t += smooth ? TIMING.scrollSmooth : TIMING.scrollInstant;
        scrollY = to;
        mark("scroll", `y=${op.y}`, null);
        steps.push({ index, line, op: kind, label: `y=${op.y}`, t0, t1: t });
        continue;
      }
      case "wait": {
        const hasMs = op.ms !== undefined && op.ms !== null;
        const hasSel = op.selector !== undefined && op.selector !== null;
        if (hasMs && hasSel) {
          fail(
            line,
            "wait takes ms or selector, not both; use timeout_ms to bound a selector wait"
          );
          break;
        }
        if (hasMs) {
          const d = duration(op, "ms", 0);
          if (d.error) {
            fail(line, d.error);
            break;
          }
          t += d.value / 1000;
          mark("wait", `${d.value}ms`, null);
          steps.push({ index, line, op: kind, label: `${d.value}ms`, t0, t1: t });
          continue;
        }
        if (hasSel) {
          if (typeof op.selector !== "string") {
            fail(line, "wait selector must be a CSS selector string");
            break;
          }
          if (!findNode(scene, op.selector)) {
            fail(
              line,
              `wait: ${op.selector} is not on the fixture, so this wait would time out`
            );
            break;
          }
          const d = duration(op, "timeout_ms", 20000);
          if (d.error) {
            fail(line, d.error);
            break;
          }
          t += TIMING.waitSelectorEstimate;
          mark("wait", op.selector, null);
          steps.push({
            index,
            line,
            op: kind,
            label: op.selector,
            t0,
            t1: t,
            estimated: true,
          });
          continue;
        }
        fail(line, "wait needs ms or selector");
        break;
      }
      case "mark": {
        mark("mark", typeof op.label === "string" ? op.label : "", null);
        steps.push({ index, line, op: kind, label: op.label || "", t0, t1: t });
        continue;
      }
      default:
        break;
    }
    if (fatal) break;
  }

  return {
    scene,
    ops,
    steps,
    marks,
    beats,
    errors,
    notes,
    scriptEnd: t,
    fatal,
    maxScroll,
  };
}

/* The CSS transition the recorder puts on its injected cursor, so the pointer in the playback
   accelerates and settles the way it does in a real take. */
function cursorEase(p) {
  // cubic-bezier(.22, .61, .36, 1), solved by bisection on x. Cheap at 30fps and exact enough
  // that nobody could see the difference from a closed form.
  const cx = 3 * 0.22;
  const bx = 3 * (0.36 - 0.22) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * 0.61;
  const by = 3 * (1 - 0.61) - cy;
  const ay = 1 - cy - by;
  let lo = 0;
  let hi = 1;
  let tt = p;
  for (let i = 0; i < 16; i++) {
    const x = ((ax * tt + bx) * tt + cx) * tt;
    if (x < p) lo = tt;
    else hi = tt;
    tt = (lo + hi) / 2;
  }
  return ((ay * tt + by) * tt + cy) * tt;
}

const smoothstep = (p) => {
  const c = p < 0 ? 0 : p > 1 ? 1 : p;
  return c * c * (3 - 2 * c);
};

/**
 * Replay the beats up to `t` into the page state the renderer draws.
 *
 * Walking the whole list every frame rather than keeping a cursor into it is what makes
 * scrubbing backwards work without any rewind logic, and a take has tens of beats, not
 * thousands.
 */
export function stateAt(sim, t) {
  const state = {
    scrollY: 0,
    typed: {},
    focus: null,
    pressed: null,
    cursor: { x: sim.scene.viewportW * 0.5, y: 0, shape: "arrow" },
    ripples: [],
    caretOn: Math.floor(t * 1.6) % 2 === 0,
  };
  // The pointer starts below the fold of the frame, the way it does in a take that has not
  // clicked anything yet.
  state.cursor.y = sim.scene.docHeight > 0 ? 10000 : 0;

  for (const b of sim.beats) {
    switch (b.kind) {
      case "reset":
        if (t >= b.t) {
          state.scrollY = 0;
          state.typed = {};
          state.focus = null;
        }
        break;
      case "scroll-to":
        if (t >= b.t) state.scrollY = b.y;
        break;
      case "scroll":
        if (t >= b.t1) state.scrollY = b.to;
        else if (t > b.t0) {
          const p = (t - b.t0) / (b.t1 - b.t0);
          state.scrollY = b.from + (b.to - b.from) * (b.smooth ? smoothstep(p) : p);
        }
        break;
      case "focus":
        if (t >= b.t) state.focus = b.sel;
        break;
      case "press":
        if (t >= b.t0 && t < b.t1) state.pressed = b.sel;
        break;
      case "cursor":
        if (t >= b.t1) state.cursor = { ...b.to };
        else if (t > b.t0) {
          const p = cursorEase((t - b.t0) / (b.t1 - b.t0));
          state.cursor = {
            x: b.from.x + (b.to.x - b.from.x) * p,
            y: b.from.y + (b.to.y - b.from.y) * p,
            // The shape flips at the start of the move, as it does in the page, because the
            // recorder passes the new shape into the same call that starts the transition.
            shape: b.to.shape,
          };
        }
        break;
      case "ripple":
        if (t >= b.t && t < b.t + 0.5) state.ripples.push({ x: b.x, y: b.y, p: (t - b.t) / 0.5 });
        break;
      case "type": {
        if (!b.sel) break;
        if (t >= b.t1) state.typed[b.sel] = b.before + b.text;
        else if (t > b.t0) {
          const p = (t - b.t0) / (b.t1 - b.t0);
          const n = Math.floor(p * b.text.length);
          state.typed[b.sel] = b.before + b.text.slice(0, n);
        } else state.typed[b.sel] = b.before;
        break;
      }
      default:
        break;
    }
  }
  return state;
}
