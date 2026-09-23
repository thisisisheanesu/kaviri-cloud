/*
 * The stage: one frame of the take, drawn.
 *
 * The recorder captures JPEG frames from the browser and ffmpeg crops into them, so a zoom in a
 * real take is limited by --scale, the supersampling the capture was run at. The playground has
 * the fixture as vectors rather than as pixels, so it draws the page THROUGH the crop transform
 * instead of cropping an image: one pass, no intermediate buffer, and a zoom that stays sharp.
 * That is the one place the playback is nicer than the render rather than equal to it, and the
 * page says so, because someone choosing --scale 1 on the strength of a crisp playground is
 * being misled by a difference we introduced.
 *
 * Everything that decides WHERE the camera is, and what shape the frame is, comes from the
 * ported planner and the ported plate. Only the rasterisation is ours.
 */

import { drawScene, FIELD_FONT } from "./scene.js";
import { drawCursor, drawRipple } from "./cursor.js";
import { contentBox, paintPlate, roundRectPath, measure, choose } from "./backdrop.js";
import { cameraAt, cropFor } from "./planner-source.js";
import { stateAt } from "./sim.js";

/**
 * The largest centred box of the given aspect that fits in the frame, both sides even.
 * Ported from `fit_box` in zoom.rs, which is what a take with --background none is fitted to.
 */
export function fitBox(outW, outH, aspect) {
  const ow = Math.max(outW, 2);
  const oh = Math.max(outH, 2);
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : ow / oh;
  const [cw, ch] = ow / oh > a ? [oh * a, oh] : [ow, ow / a];
  const even = (v, cap) => {
    const n = Math.min(Math.max(Math.round(v), 2), Math.max(cap, 2));
    return n - (n % 2);
  };
  const w = even(cw, outW);
  const h = even(ch, outH);
  return {
    w,
    h,
    x: (Math.max(outW - w, 0) >> 1) & ~1,
    y: (Math.max(outH - h, 0) >> 1) & ~1,
    radius: 0,
  };
}

/** Everything about the frame that follows from the preset and the backdrop choice. */
export function frameGeometry(preset, background) {
  const frameW = preset.css[0] * preset.scale;
  const frameH = preset.css[1] * preset.scale;
  const aspect = frameW / frameH;
  const box = background ? contentBox(preset.out[0], preset.out[1], aspect) : fitBox(preset.out[0], preset.out[1], aspect);
  return { frameW, frameH, aspect, box, outW: preset.out[0], outH: preset.out[1] };
}

/**
 * Draw one frame into a context whose units are the output frame's pixels.
 *
 * `plan.events` are in source pixels, the page is in CSS pixels, and the frame is in output
 * pixels. The transform below is the only place those three meet, so it is worth reading slowly:
 * the crop is converted to CSS pixels by dividing out the capture scale, and then the content
 * box decides how many output pixels one of those CSS pixels is worth.
 */
export function drawFrame(ctx, opts) {
  const { sim, plan, t, preset, background, cursorScale, geometry } = opts;
  const { frameW, frameH, box, outW, outH } = geometry;

  const camera = cameraAt(plan.events, t, frameW, frameH);
  const crop = cropFor(camera, frameW, frameH);
  const state = stateAt(sim, t);

  ctx.save();
  if (background) {
    paintPlate(ctx, background, outW, outH, box);
  } else {
    // With no backdrop the frame is pad black, exactly as a plateless render letterboxes.
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, outW, outH);
  }

  ctx.save();
  roundRectPath(ctx, box.x, box.y, box.w, box.h, box.radius);
  ctx.clip();
  paintContent(ctx, { sim, preset, crop, box, state, cursorScale });
  ctx.restore();
  ctx.restore();

  return { camera, crop, state };
}

function paintContent(ctx, { sim, preset, crop, box, state, cursorScale }) {
  const scale = preset.scale;
  const cssCrop = { x: crop.x / scale, y: crop.y / scale, w: crop.w / scale, h: crop.h / scale };
  const k = box.w / cssCrop.w; // output pixels per CSS pixel at this zoom

  ctx.save();
  ctx.translate(box.x, box.y);
  ctx.scale(k, k);
  ctx.translate(-cssCrop.x, -cssCrop.y);

  drawScene(ctx, sim.scene, state.scrollY, preset.css[0], preset.css[1], state);

  // The pointer and the ripple live in the page in a real take, which is exactly why they scale
  // with the zoom and can never drift away from the click they belong to. Drawing them inside
  // the same transform reproduces that rather than compositing them on top afterwards.
  for (const r of state.ripples) drawRipple(ctx, r.x, r.y, r.p, cursorScale);
  if (cursorScale > 0 && state.cursor.y < preset.css[1] + 200) {
    drawCursor(ctx, state.cursor.shape, state.cursor.x, state.cursor.y, cursorScale);
  }
  ctx.restore();
}

/**
 * The whole viewport with the crop drawn on it, for the small overview panel.
 *
 * Seeing the rectangle travel is what makes the planner legible: the merge window, the left
 * bias and the pan along a caret all become one moving box instead of three paragraphs of
 * documentation.
 */
export function drawOverview(ctx, opts) {
  const { sim, preset, crop, state, w, h, cursorScale } = opts;
  const cssW = preset.css[0];
  const cssH = preset.css[1];
  const k = Math.min(w / cssW, h / cssH);
  const ox = (w - cssW * k) / 2;
  const oy = (h - cssH * k) / 2;

  ctx.save();
  ctx.clearRect(0, 0, w, h);
  ctx.translate(ox, oy);
  ctx.scale(k, k);
  drawScene(ctx, sim.scene, state.scrollY, cssW, cssH, state);
  for (const r of state.ripples) drawRipple(ctx, r.x, r.y, r.p, cursorScale);
  if (state.cursor.y < cssH + 200) {
    drawCursor(ctx, state.cursor.shape, state.cursor.x, state.cursor.y, cursorScale);
  }
  ctx.restore();

  const scale = preset.scale;
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(k, k);
  ctx.strokeStyle = "#ff6b3d";
  ctx.lineWidth = 2 / k;
  ctx.strokeRect(crop.x / scale, crop.y / scale, crop.w / scale, crop.h / scale);
  ctx.fillStyle = "rgba(255, 107, 61, 0.08)";
  ctx.fillRect(crop.x / scale, crop.y / scale, crop.w / scale, crop.h / scale);
  ctx.restore();

  ctx.strokeStyle = "rgba(128, 128, 128, 0.45)";
  ctx.lineWidth = 1;
  ctx.strokeRect(ox + 0.5, oy + 0.5, cssW * k - 1, cssH * k - 1);
}

/**
 * Run the auto backdrop picker over this take.
 *
 * backdrop.rs probes the rendered intermediate with ffmpeg at two frames a second scaled to
 * 12x12. This does the same thing at the same rate against the same content, drawing each
 * sample through the same crop transform, so the answer is the one the render would reach for
 * this script at this preset.
 */
export function probeTake(sim, plan, preset, duration, cursorScale) {
  const size = 12;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const frameW = preset.css[0] * preset.scale;
  const frameH = preset.css[1] * preset.scale;
  const samples = Math.max(1, Math.min(Math.floor(duration * 2), 120));
  const rgb = [];

  for (let i = 0; i < samples; i++) {
    const t = (i + 0.5) / 2;
    if (t > duration) break;
    const camera = cameraAt(plan.events, t, frameW, frameH);
    const crop = cropFor(camera, frameW, frameH);
    const state = stateAt(sim, t);
    ctx.save();
    ctx.clearRect(0, 0, size, size);
    const cssCrop = {
      x: crop.x / preset.scale,
      y: crop.y / preset.scale,
      w: crop.w / preset.scale,
      h: crop.h / preset.scale,
    };
    ctx.scale(size / cssCrop.w, size / cssCrop.h);
    ctx.translate(-cssCrop.x, -cssCrop.y);
    drawScene(ctx, sim.scene, state.scrollY, preset.css[0], preset.css[1], state);
    if (state.cursor.y < preset.css[1] + 200) {
      drawCursor(ctx, state.cursor.shape, state.cursor.x, state.cursor.y, cursorScale);
    }
    ctx.restore();
    const data = ctx.getImageData(0, 0, size, size).data;
    for (let p = 0; p < data.length; p += 4) rgb.push(data[p], data[p + 1], data[p + 2]);
  }

  const probe = measure(rgb, 3);
  return { probe, ...choose(probe) };
}

/** A canvas 2D context for measuring the fixture's field text, made once and reused. */
export function makeTextMeasurer() {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  ctx.font = FIELD_FONT;
  return (text) => ctx.measureText(text).width;
}
