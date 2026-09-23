/*
 * The timeline: the ops the script ran, the zoom events the planner built from them, and the
 * zoom curve those events produce.
 *
 * This is the panel that earns the playground its keep. The recorder can tell you it merged two
 * interactions into one pan, or that it dropped a zoom because the take ended too soon after the
 * last click, but it can only tell you in a line of stderr. Here the merge is one bar spanning
 * two ticks, and a dropped zoom is a gap you can see.
 */

import { EASE } from "./planner-source.js";

const ROW_OPS = { y: 6, h: 20 };
const ROW_EVENTS = { y: 34, h: 30 };
const ROW_CURVE = { y: 72, h: 46 };
const AXIS_Y = 126;
export const TIMELINE_HEIGHT = 144;

const OP_COLOUR = {
  navigate: "#6b7280",
  click: "#c7361a",
  type: "#a72b12",
  scroll: "#2f6df6",
  wait: "#9aa1ac",
  mark: "#0f7a4a",
};

function css(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Draw the whole timeline. `t` is the playhead in seconds, `duration` the take's length as the
 * renderer would compute it, including the tail the planner pads on for a late interaction.
 */
export function drawTimeline(ctx, opts) {
  const { sim, plan, duration, t, w, host } = opts;
  const text = css(host, "--text", "#0f0f10");
  const muted = css(host, "--text-muted", "#5a5a57");
  const faint = css(host, "--text-faint", "#8a8a85");
  const border = css(host, "--border", "#dfdfdb");
  const accent = css(host, "--accent", "#c7361a");
  const surface = css(host, "--surface", "#ffffff");

  const pad = 8;
  const inner = Math.max(w - pad * 2, 10);
  const x = (time) => pad + (Math.max(0, Math.min(time, duration)) / duration) * inner;

  ctx.clearRect(0, 0, w, TIMELINE_HEIGHT);
  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, w, TIMELINE_HEIGHT);

  // Seconds, and a label every second or every five when they would collide.
  const tickStep = inner / duration < 26 ? 5 : 1;
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.fillStyle = faint;
  for (let s = 0; s <= duration; s += tickStep) {
    const px = Math.round(x(s)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(px, ROW_OPS.y);
    ctx.lineTo(px, AXIS_Y);
    ctx.globalAlpha = 0.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(`${s}s`, px + 3, AXIS_Y + 12);
  }

  // Row 1: the ops, each a segment from when it started to when it handed over.
  for (const step of sim.steps) {
    const x0 = x(step.t0);
    const x1 = Math.max(x(step.t1), x0 + 2);
    ctx.fillStyle = OP_COLOUR[step.op] || muted;
    ctx.globalAlpha = step.estimated ? 0.45 : 0.85;
    ctx.fillRect(x0, ROW_OPS.y, x1 - x0, ROW_OPS.h);
    ctx.globalAlpha = 1;
    const label = `${step.op}${step.label ? " " + step.label : ""}`;
    if (x1 - x0 > 44) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0 + 4, ROW_OPS.y, x1 - x0 - 8, ROW_OPS.h);
      ctx.clip();
      ctx.fillStyle = "#ffffff";
      ctx.font = `11px ${'ui-sans-serif, system-ui, sans-serif'}`;
      ctx.textBaseline = "middle";
      ctx.fillText(label, x0 + 6, ROW_OPS.y + ROW_OPS.h / 2);
      ctx.textBaseline = "alphabetic";
      ctx.restore();
    }
  }

  // Row 2: the zoom events. The eased shoulders are drawn lighter than the hold, because the
  // difference between "moving" and "parked" is the thing a reader is looking for.
  for (const ev of plan.events) {
    const x0 = x(ev.t);
    const x1 = x(ev.end);
    const xi = x(Math.min(ev.t + EASE, ev.end));
    const xo = x(Math.max(ev.end - EASE, ev.t));
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.22;
    ctx.fillRect(x0, ROW_EVENTS.y, Math.max(x1 - x0, 2), ROW_EVENTS.h);
    ctx.globalAlpha = 0.55;
    ctx.fillRect(xi, ROW_EVENTS.y, Math.max(xo - xi, 1), ROW_EVENTS.h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x0) + 0.5, ROW_EVENTS.y + 0.5, Math.max(Math.round(x1 - x0), 2), ROW_EVENTS.h - 1);

    for (const p of ev.path) {
      const px = x(p[0]);
      ctx.beginPath();
      ctx.arc(px, ROW_EVENTS.y + ROW_EVENTS.h - 7, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
    }
    if (x1 - x0 > 52) {
      ctx.fillStyle = text;
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.textBaseline = "middle";
      const note = ev.path.length ? `z ${ev.z.toFixed(2)} · pan ${ev.path.length}` : `z ${ev.z.toFixed(2)}`;
      ctx.fillText(note, x0 + 6, ROW_EVENTS.y + 10);
      ctx.textBaseline = "alphabetic";
    }
  }

  // Row 3: the zoom curve itself, sampled at the frame rate the render uses.
  drawCurve(ctx, { plan, duration, x, accent, border });

  // Anything the planner refused to do, marked where it happened.
  for (const wref of plan.warnings) {
    const px = x(wref.t);
    ctx.strokeStyle = "#b45309";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, ROW_EVENTS.y - 5);
    ctx.lineTo(px, ROW_EVENTS.y + ROW_EVENTS.h + 5);
    ctx.stroke();
  }

  // The playhead, last, so nothing is drawn over it.
  const px = Math.round(x(t)) + 0.5;
  ctx.strokeStyle = text;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px, 2);
  ctx.lineTo(px, AXIS_Y);
  ctx.stroke();
  ctx.fillStyle = text;
  ctx.beginPath();
  ctx.moveTo(px - 4, 2);
  ctx.lineTo(px + 4, 2);
  ctx.lineTo(px, 8);
  ctx.closePath();
  ctx.fill();
}

function drawCurve(ctx, { plan, duration, x, accent, border }) {
  const maxZ = plan.events.reduce((m, e) => Math.max(m, e.z), 1.05);
  const top = ROW_CURVE.y;
  const bottom = ROW_CURVE.y + ROW_CURVE.h;
  const yFor = (z) => bottom - ((z - 1) / (maxZ - 1)) * (ROW_CURVE.h - 4);

  ctx.strokeStyle = border;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(x(0), bottom + 0.5);
  ctx.lineTo(x(duration), bottom + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);

  // Sampled rather than derived from the event list, so what is drawn is what the sampler says
  // and a disagreement between the two shows up here instead of only in the playback.
  const n = Math.max(2, Math.min(Math.round(duration * 30), 2000));
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * duration;
    const ev = plan.events.find((e) => t >= e.t && t <= e.end);
    let z = 1;
    if (ev) {
      const p =
        t < ev.t + EASE
          ? (t - ev.t) / EASE
          : t > ev.end - EASE
            ? 1 - (t - (ev.end - EASE)) / EASE
            : 1;
      const c = Math.max(0, Math.min(p, 1));
      z = 1 + (ev.z - 1) * (c * c * (3 - 2 * c));
    }
    const px = x(t);
    const py = yFor(z);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.lineTo(x(duration), bottom);
  ctx.lineTo(x(0), bottom);
  ctx.closePath();
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.1;
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.fillStyle = accent;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.fillText(`z ${maxZ.toFixed(2)}`, x(0) + 2, top + 10);
}

/** Which time a click at `px` in the timeline canvas means. */
export function timeAtX(px, w, duration) {
  const pad = 8;
  const inner = Math.max(w - pad * 2, 10);
  return Math.max(0, Math.min(((px - pad) / inner) * duration, duration));
}
