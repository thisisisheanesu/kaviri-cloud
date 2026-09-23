/*
 * Chooses which planner the page runs: the recorder's own crate compiled to wasm if that build
 * has been published, otherwise the JavaScript port in planner.js.
 *
 * The wasm build does not exist yet. NEEDS-FROM-RECORDER.md specifies the target and the exact
 * ABI this file loads, so the recorder repo can add it without anybody having to guess. Until
 * then the fetch below 404s, the port is used, and the header badge says so rather than letting
 * a visitor assume they are watching the real crate run.
 *
 * Only the planning step is swappable. Sampling the camera between events (cameraAt, cropFor)
 * stays in JavaScript either way, because the render does that inside ffmpeg from generated
 * expression text and there is nothing in the crate to call.
 */

import * as port from "./planner.js";

const WASM_ENTRY = "./wasm/kaviri_planner.js";

/** What the page ended up using, read by the header badge. */
export const source = {
  kind: "js-port",
  label: port.PLANNER_ID.label,
  version: null,
  detail: "the recorder's wasm planner has not been published yet",
};

let planFn = null;

/**
 * Try the wasm planner once, at startup.
 *
 * Every failure path lands on the port deliberately. A playground that refuses to start because
 * an optional optimisation is missing is worse than one that starts and tells the truth about
 * what it is running.
 */
export async function initPlanner() {
  try {
    const mod = await import(/* @vite-ignore */ WASM_ENTRY);
    if (typeof mod.default === "function") await mod.default();
    if (typeof mod.plan !== "function") throw new Error("the module exports no plan()");
    const version = typeof mod.version === "function" ? mod.version() : null;
    planFn = (marks, scale, frameW, frameH, duration) => {
      const out = mod.plan(JSON.stringify(marks), scale, frameW, frameH, duration);
      return typeof out === "string" ? JSON.parse(out) : out;
    };
    source.kind = "wasm";
    source.label = "kaviri::zoom compiled to wasm";
    source.version = version;
    source.detail = version ? `recorder ${version}` : "the recorder crate itself";
  } catch (e) {
    source.detail = `${source.detail} (${e && e.message ? e.message : e})`;
    planFn = null;
  }
  return source;
}

/** Plan a take. Same signature and same return shape whichever implementation answered. */
export function plan(marks, scale, frameW, frameH, duration) {
  if (planFn) {
    const out = planFn(marks, scale, frameW, frameH, duration);
    // A wasm planner that returns no warnings array is tolerated rather than trusted: the
    // warnings are how a visitor finds out a zoom was silently dropped.
    return { events: out.events || [], warnings: out.warnings || [] };
  }
  return port.eventsFromMarks(marks, scale, frameW, frameH, duration);
}

export const { cameraAt, cropFor, durationFor, EASE, FPS, HOLD_AFTER, MAX_TAIL_PAD } = port;
