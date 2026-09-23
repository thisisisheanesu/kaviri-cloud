/*
 * The recorder's own tests, re-run in the browser against whichever planner is live.
 *
 * A port that nothing checks is a rumour. src/zoom.rs and src/backdrop.rs each carry a test
 * module, and the properties those tests assert are the ones a drift in this port would break:
 * the left bias, the pan handover, the return to wide, the waypoint budget, the content box
 * arithmetic, the auto picker. So they are ported too, and the page runs them.
 *
 * Where the Rust test inspects generated ffmpeg text, the port asserts the same property against
 * the sampled camera instead, because the expression is what the recorder emits and the camera
 * is what this page has. The property is the same in both: the pan does not stop at every
 * waypoint, and it does not teleport at the handover.
 *
 * Open the playground with ?selftest to see the results.
 */

import { cameraAt, EASE } from "./planner-source.js";
import { plan as runPlanner } from "./planner-source.js";
import { thinPath } from "./planner.js";
import { fitBox } from "./stage.js";
import { contentBox, measure, choose, backgroundKey, BACKGROUNDS } from "./backdrop.js";

const mark = (kind, t, bbox) => ({ t, kind, label: "", bbox });

function suite() {
  const tests = [];
  const test = (name, fn) => tests.push({ name, fn });

  test("the crop leans left of an interaction", () => {
    const [fw, fh, dur] = [1000, 800, 20];
    const bbox = [600, 300, 300, 60];
    const typed = runPlanner([mark("type", 3, bbox)], 1, fw, fh, dur).events;
    const clicked = runPlanner([mark("click", 3, bbox)], 1, fw, fh, dur).events;
    assert(typed.length === 1 && clicked.length === 1, "one event each");
    const centre = bbox[0] + bbox[2] / 2;
    assert(typed[0].cx < clicked[0].cx, "typing leans further left than a click");
    assert(clicked[0].cx < centre, "even a click sits left of dead centre");
    for (const ev of [typed[0], clicked[0]]) {
      const cropW = fw / ev.z;
      const l = ev.cx - cropW / 2;
      const r = ev.cx + cropW / 2;
      assert(bbox[0] >= l && bbox[0] + bbox[2] <= r, "the target stays inside the crop");
    }
  });

  test("a pan moves at a constant rate between waypoints", () => {
    const marks = [];
    for (let k = 0; k < 6; k++) marks.push(mark("type", 3 + k * 0.12, [200 + k * 40, 300, 2, 40]));
    const { events } = runPlanner(marks, 1, 1000, 800, 20);
    assert(events.length === 1, "close samples merge into one move");
    assert(events[0].path.length >= 3, "and keep their waypoints");
    const ev = events[0];
    // Between the first and the last waypoint the camera is panning. If each segment were eased
    // separately the speed would fall to zero at every one of them, which is the stepping this
    // guards against.
    const t0 = ev.path[0][0];
    const t1 = ev.path[ev.path.length - 1][0];
    const dt = 1 / 120;
    let min = Infinity;
    let sum = 0;
    let n = 0;
    for (let t = t0 + dt; t < t1; t += dt) {
      const a = cameraAt([ev], t - dt, 1000, 800).cx;
      const b = cameraAt([ev], t, 1000, 800).cx;
      const v = Math.abs(b - a) / dt;
      min = Math.min(min, v);
      sum += v;
      n += 1;
    }
    const meanSpeed = sum / n;
    assert(min > meanSpeed * 0.3, `the pan never nearly stops (min ${min.toFixed(1)} of mean ${meanSpeed.toFixed(1)})`);
  });

  test("the pan starts exactly where the ease-in lands", () => {
    const [fw, fh] = [2200, 1240];
    const marks = [];
    for (let k = 0; k < 8; k++) marks.push(mark("type", 4.4 + k * 0.35, [1400 - k * 60, 300, 4, 40]));
    const { events } = runPlanner(marks, 1, fw, fh, 30);
    assert(events.length === 1, "one event");
    assert(events[0].path.length > 0, "the move has waypoints");
    const boundary = events[0].t + EASE;
    for (const axis of ["cx", "cy"]) {
      const before = cameraAt(events, boundary - 1e-4, fw, fh)[axis];
      const after = cameraAt(events, boundary + 1e-4, fw, fh)[axis];
      assert(Math.abs(before - after) < 1, `${axis} does not teleport at the handover`);
    }
    let prev = cameraAt(events, events[0].t, fw, fh).cx;
    let worst = 0;
    for (let t = events[0].t; t < events[0].end; t += 1 / 30) {
      const v = cameraAt(events, t, fw, fh).cx;
      worst = Math.max(worst, Math.abs(v - prev));
      prev = v;
    }
    assert(worst < 80, `no whip anywhere in the move (worst ${worst.toFixed(1)}px per frame)`);
  });

  test("the view returns to wide after an interaction", () => {
    const { events } = runPlanner([mark("click", 4, [100, 100, 80, 40])], 1, 1000, 800, 20);
    assert(events.length === 1, "one event");
    assert(events[0].end < 20, "the event ends inside the recording");
    const after = cameraAt(events, events[0].end + 0.01, 1000, 800);
    assert(after.z === 1, "z falls back to 1 outside the window");
    assert(after.cx === 500 && after.cy === 400, "and the crop is centred again");
  });

  test("a wide target is not cropped off at the sides", () => {
    const [fw, fh] = [2200, 1240];
    const bbox = [100, 80, 2000, 40];
    const { events } = runPlanner([mark("click", 4, bbox)], 1, fw, fh, 20);
    assert(events.length === 1, "one event");
    assert(events[0].z === 1, "a target as wide as the frame gets no zoom at all");
    const narrow = runPlanner([mark("click", 4, [100, 80, 120, 40])], 1, fw, fh, 20).events;
    assert(narrow[0].z > 1.5, "a small target of the same height still zooms");
  });

  test("a typing pan keeps up with the typing", () => {
    const n = 30;
    const marks = [];
    for (let k = 0; k < n; k++) marks.push(mark("type", 5 + k * 0.12, [300 + k * 12, 400, 2, 40]));
    const lastTyped = 5 + (n - 1) * 0.12;
    const { events } = runPlanner(marks, 1, 1600, 900, 40);
    assert(events.length === 1, "one event");
    const lastWp = events[0].path[events[0].path.length - 1][0];
    assert(lastWp <= lastTyped + 0.2, `the pan finishes with the typing (${(lastWp - lastTyped).toFixed(2)}s late)`);
  });

  test("a long take cannot grow the waypoint list without bound", () => {
    const marks = [];
    for (let k = 0; k < 1200; k++) {
      marks.push(mark("type", 1 + k * 0.12, [200 + (k % 40) * 25, 300, 2, 40]));
    }
    const { events } = runPlanner(marks, 1, 1600, 900, 200);
    const waypoints = events.reduce((s, e) => s + e.path.length, 0);
    assert(waypoints <= 192, `${waypoints} waypoints survived thinning`);
  });

  test("thinning keeps the shape of a pan", () => {
    const path = [];
    for (let k = 0; k < 20; k++) path.push([k * 0.1, k * 10, 0]);
    for (let k = 1; k < 20; k++) path.push([2 + k * 0.1, 190, k * 10]);
    const thin = thinPath(path, 4);
    assert(thin.length <= 4, "within budget");
    assert(thin[0] === path[0], "the first waypoint is always kept");
    assert(thin[thin.length - 1] === path[path.length - 1], "and so is the last");
    assert(
      thin.some((p) => Math.abs(p[1] - 190) < 1 && p[2] < 20),
      "the corner survived"
    );
  });

  test("a plateless render keeps the capture aspect", () => {
    const eq = (a, b) => a.w === b[0] && a.h === b[1];
    assert(eq(fitBox(1080, 1920, 1250 / 1920), [1080, 1658]), "a tall capture into a tall frame");
    assert(eq(fitBox(1920, 1080, 16 / 9), [1920, 1080]), "an exact match fills the frame");
    assert(eq(fitBox(1080, 1080, 2), [1080, 540]), "a wide capture is limited by width");
    assert(eq(fitBox(640, 480, NaN), [640, 480]), "a nonsense aspect fills rather than divides by zero");
  });

  test("the content box is inset, even, and keeps aspect", () => {
    for (const [w, h] of [[1080, 1920], [1470, 830], [1080, 1080], [1920, 1080]]) {
      const aspect = w / h;
      const b = contentBox(w, h, aspect);
      assert(b.w % 2 === 0 && b.h % 2 === 0 && b.x % 2 === 0 && b.y % 2 === 0, `${w}x${h} is even`);
      assert(b.w < w && b.h < h, `${w}x${h} is inset`);
      assert(b.x + b.w <= w && b.y + b.h <= h, `${w}x${h} stays on frame`);
      assert(Math.abs(b.w / b.h - aspect) / aspect < 0.01, `${w}x${h} keeps its aspect`);
    }
  });

  test("auto pick is complementary and deterministic", () => {
    const green = { hue: 140, lum: 0.85 };
    const a = choose(green);
    const b = choose(green);
    assert(a.background.name === b.background.name, "the same probe always picks the same backdrop");
    const key = backgroundKey(a.background);
    assert(key.lum < 0.6, `a light page wants a deep backdrop, got ${key.lum.toFixed(2)}`);
    const plain = choose({ hue: null, lum: 0.93 });
    assert(backgroundKey(plain.background).lum < 0.5, "a white page still gets a dark backdrop");
    assert(choose(null).background.name === BACKGROUNDS[0].name, "no probe falls back to the first");
  });

  test("the probe reads raw rgb the way ffmpeg hands it over", () => {
    const buf = new Array(300).fill(250);
    for (let i = 0; i < 20; i++) {
      buf[i * 3] = 20;
      buf[i * 3 + 1] = 60;
      buf[i * 3 + 2] = 220;
    }
    const p = measure(buf, 3);
    assert(p.lum > 0.5, "mostly white");
    assert(p.hue !== null && p.hue >= 200 && p.hue <= 260, `the blue registers, got ${p.hue}`);
    assert(measure(new Array(300).fill(128), 3).hue === null, "pure grey has no hue");
  });

  return tests;
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** Run everything and report. Never throws: a failing assertion is a result, not a crash. */
export function runSelfTest() {
  return suite().map(({ name, fn }) => {
    try {
      fn();
      return { name, ok: true };
    } catch (e) {
      return { name, ok: false, message: e && e.message ? e.message : String(e) };
    }
  });
}
