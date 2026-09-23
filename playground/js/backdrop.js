/*
 * The plate the take is composited onto, ported from the recorder's src/backdrop.rs.
 *
 * The recorder renders this as one RGBA PNG and hands it to ffmpeg as a second input: opaque
 * everywhere except the rounded window the content shows through, so a single overlay gives
 * background, drop shadow and rounded corners in one pass. A canvas does the same job with a
 * clip and a shadow, so this file carries the parts that decide what you see rather than how it
 * is muxed: the gradient stops, the content box arithmetic, and the auto picker.
 *
 * The auto picker is ported in full, probe included, because "which backdrop will auto choose
 * for my page" is a question a playground can actually answer and a README cannot. Two things
 * are deliberately not ported: the deterministic dither, which exists to stop a smooth wash
 * banding once h264 has had its way with it and has no job on a canvas, and the three-pass box
 * blur behind the shadow, which a canvas shadow approximates closely enough that nobody could
 * pick the two apart at playback size.
 */

const PAD_FRAC = 0.055;
const RADIUS_FRAC = 0.035;
const RADIUS_MIN = 10;
const RADIUS_MAX = 56;
const SHADOW_BLUR_FRAC = 0.03;
const SHADOW_DY = 0.55;
const SHADOW_SPREAD = 0.1;
const SHADOW_ALPHA = 0.42;

const linear = (angle, stops) => ({ type: "linear", angle, stops });
const solid = (rgb) => ({ type: "solid", rgb });
const mesh = (base, blobs) => ({ type: "mesh", base, blobs });

/** The built-in set, in declaration order, which is also the auto picker's final tie break. */
export const BACKGROUNDS = [
  {
    name: "dusk",
    about: "indigo to violet to magenta wash (the fallback if auto cannot probe)",
    fill: linear(115, [
      [0.0, [26, 22, 58]],
      [0.45, [72, 45, 120]],
      [0.78, [142, 68, 145]],
      [1.0, [196, 104, 120]],
    ]),
  },
  {
    name: "dawn",
    about: "peach to rose to lilac, light and warm",
    fill: linear(120, [
      [0.0, [255, 214, 190]],
      [0.4, [249, 178, 176]],
      [0.75, [214, 160, 208]],
      [1.0, [176, 157, 224]],
    ]),
  },
  {
    name: "tide",
    about: "deep teal to blue to cyan",
    fill: linear(110, [
      [0.0, [6, 48, 74]],
      [0.42, [10, 92, 120]],
      [0.75, [24, 120, 150]],
      [1.0, [66, 166, 178]],
    ]),
  },
  {
    name: "moss",
    about: "forest to olive to sand",
    fill: linear(115, [
      [0.0, [24, 48, 40]],
      [0.45, [54, 94, 64]],
      [0.8, [104, 140, 84]],
      [1.0, [168, 180, 120]],
    ]),
  },
  {
    name: "ember",
    about: "oxblood to orange to amber",
    fill: linear(115, [
      [0.0, [64, 18, 26]],
      [0.4, [150, 48, 38]],
      [0.72, [214, 102, 44]],
      [1.0, [242, 170, 96]],
    ]),
  },
  { name: "slate", about: "solid muted blue-grey", fill: solid([58, 66, 80]) },
  { name: "linen", about: "solid warm off-white", fill: solid([232, 226, 214]) },
  {
    name: "mesh-cool",
    about: "dark mesh gradient, blue and violet blobs",
    fill: mesh([18, 24, 52], [
      [0.18, 0.15, 0.55, [52, 96, 220]],
      [0.85, 0.28, 0.5, [132, 72, 214]],
      [0.55, 0.9, 0.6, [26, 146, 178]],
      [0.08, 0.85, 0.45, [64, 40, 160]],
    ]),
  },
  {
    name: "mesh-warm",
    about: "light mesh gradient, rose and amber blobs",
    fill: mesh([244, 232, 224], [
      [0.15, 0.2, 0.55, [255, 190, 170]],
      [0.88, 0.18, 0.5, [248, 170, 206]],
      [0.6, 0.92, 0.6, [214, 196, 255]],
      [0.05, 0.9, 0.5, [255, 214, 160]],
    ]),
  },
];

export const backgroundByName = (name) => BACKGROUNDS.find((b) => b.name === name) || null;

const rgb01 = (c) => [c[0] / 255, c[1] / 255, c[2] / 255];

function sampleStops(stops, t) {
  if (!stops.length) return [0, 0, 0];
  const last = stops.length - 1;
  if (t <= stops[0][0]) return rgb01(stops[0][1]);
  for (let i = 0; i < last; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (t <= t1) {
      const p = Math.abs(t1 - t0) < 1e-9 ? 0 : (t - t0) / (t1 - t0);
      const s = p * p * (3 - 2 * p); // the same ease the zoom uses
      const a = rgb01(c0);
      const b = rgb01(c1);
      return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
    }
  }
  return rgb01(stops[last][1]);
}

/** Colour at a point of the unit square, 0..1 per channel. `ar` keeps mesh blobs round. */
export function sampleFill(fill, u, v, ar) {
  if (fill.type === "solid") return rgb01(fill.rgb);
  if (fill.type === "linear") {
    const rad = (fill.angle * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    const lo = Math.min(dx, 0) + Math.min(dy, 0);
    const hi = Math.max(dx, 0) + Math.max(dy, 0);
    const t = Math.abs(hi - lo) < 1e-9 ? 0 : (u * dx + v * dy - lo) / (hi - lo);
    return sampleStops(fill.stops, Math.max(0, Math.min(1, t)));
  }
  const c = rgb01(fill.base);
  const sx = ar >= 1 ? ar : 1;
  const sy = ar >= 1 ? 1 : 1 / ar;
  for (const [bx, by, r, col] of fill.blobs) {
    const dx = (u - bx) * sx;
    const dy = (v - by) * sy;
    const d = Math.hypot(dx, dy) / r;
    if (d >= 1) continue;
    const w = Math.pow(1 - d * d, 2);
    const target = rgb01(col);
    for (let k = 0; k < 3; k++) c[k] += (target[k] - c[k]) * w;
  }
  return c;
}

function hueChromaLum(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const c = max - min;
  const l = (max + min) / 2;
  if (c <= 1e-9) return [0, 0, l];
  let h;
  if (max === r) h = 60 * (((g - b) / c + 6) % 6);
  else if (max === g) h = 60 * ((b - r) / c + 2);
  else h = 60 * ((r - g) / c + 4);
  return [(h + 360) % 360, c, l];
}

function hueDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Saturation-weighted mean hue and mean lightness of a backdrop, measured rather than declared. */
export function backgroundKey(bg) {
  let sx = 0;
  let sy = 0;
  let lum = 0;
  let n = 0;
  for (let i = 0; i < 9; i++) {
    for (let j = 0; j < 9; j++) {
      const c = sampleFill(bg.fill, (i + 0.5) / 9, (j + 0.5) / 9, 1);
      const [h, ch, l] = hueChromaLum(c[0], c[1], c[2]);
      const w = ch * ch;
      sx += w * Math.cos((h * Math.PI) / 180);
      sy += w * Math.sin((h * Math.PI) / 180);
      lum += l;
      n += 1;
    }
  }
  return {
    hue: ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360,
    lum: lum / n,
  };
}

/**
 * Aggregate raw RGB samples into a probe, exactly as backdrop.rs's `measure` does.
 *
 * Hue is accumulated as chroma-weighted unit vectors, so a white page with one brand colour
 * resolves to the brand colour rather than to white, and a page with no colour at all resolves
 * to nothing rather than to noise.
 */
export function measure(rgb, stride = 3) {
  let sx = 0;
  let sy = 0;
  let wsum = 0;
  let lum = 0;
  let n = 0;
  for (let i = 0; i + 2 < rgb.length; i += stride) {
    const [h, c, l] = hueChromaLum(rgb[i] / 255, rgb[i + 1] / 255, rgb[i + 2] / 255);
    const w = c * c;
    sx += w * Math.cos((h * Math.PI) / 180);
    sy += w * Math.sin((h * Math.PI) / 180);
    wsum += w;
    lum += l;
    n += 1;
  }
  if (n === 0) return { hue: null, lum: 0 };
  const rmsChroma = Math.sqrt(wsum / n);
  return {
    hue: rmsChroma < 0.06 ? null : ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360,
    lum: lum / n,
  };
}

/**
 * Pick a backdrop for a take: aim a third of the way round the colour wheel from the content's
 * dominant hue, and prefer a backdrop whose lightness is far from the content's. Returns the
 * winner along with every score, because the score table is the interesting part in a
 * playground and it costs nothing to keep.
 */
export function choose(probe) {
  if (!probe) return { background: BACKGROUNDS[0], scores: [], reason: "no probe: the default" };
  const scores = BACKGROUNDS.map((bg) => {
    const key = backgroundKey(bg);
    const hueTerm = probe.hue === null ? 0 : hueDist(key.hue, (probe.hue + 150) % 360) / 180;
    const lumTerm = Math.max(0.35 - Math.abs(key.lum - probe.lum), 0) / 0.35;
    const solidTerm = bg.fill.type === "solid" ? 0.05 : 0;
    return { bg, key, score: 0.6 * hueTerm + 0.4 * lumTerm + solidTerm };
  });
  let best = scores[0];
  for (const s of scores) if (s.score < best.score - 1e-9) best = s;
  return {
    background: best.bg,
    scores,
    reason:
      probe.hue === null
        ? `colourless content, lightness ${probe.lum.toFixed(2)}`
        : `content hue ${probe.hue.toFixed(0)} degrees, lightness ${probe.lum.toFixed(2)}`,
  };
}

/**
 * Fit the content inside the frame with an even inset, centred. Ported from `content_box`,
 * evenness included: the recorder needs it because yuv420p rejects an odd pad offset, and
 * keeping it here means the playground reports the same numbers the render will.
 */
export function contentBox(outW, outH, aspect) {
  const even = (v) => {
    const n = Math.max(Math.round(v), 2);
    return n - (n % 2);
  };
  const evenFloor = (v) => Math.max(v - (v % 2), 2);
  const pad = Math.max(Math.min(outW, outH) * PAD_FRAC, 12);
  const availW = Math.max(outW - 2 * pad, 16);
  const availH = Math.max(outH - 2 * pad, 16);
  const a = Number.isFinite(aspect) && aspect >= 0.01 && aspect <= 100 ? aspect : availW / availH;
  let cw;
  let ch;
  if (availW / availH > a) {
    cw = availH * a;
    ch = availH;
  } else {
    cw = availW;
    ch = availW / a;
  }
  cw = Math.min(even(cw), evenFloor(outW));
  ch = Math.min(even(ch), evenFloor(outH));
  const slackX = Math.max(outW - cw, 0);
  const slackY = Math.max(outH - ch, 0);
  return {
    w: cw,
    h: ch,
    x: Math.min(even(slackX / 2), slackX),
    y: Math.min(even(slackY / 2), slackY),
    radius: Math.max(Math.min(Math.min(cw, ch) * RADIUS_FRAC, RADIUS_MAX), RADIUS_MIN),
  };
}

/* Rendering a wash per pixel at output size would cost more than the rest of the frame put
   together, and a gradient has no detail to lose, so it is drawn small once and scaled up. */
const plateCache = new Map();

function fillCanvas(fill, w, h, ar) {
  const small = document.createElement("canvas");
  const sw = Math.max(2, Math.min(w, 220));
  const sh = Math.max(2, Math.round((sw * h) / w));
  small.width = sw;
  small.height = sh;
  const sctx = small.getContext("2d");
  const img = sctx.createImageData(sw, sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const c = sampleFill(fill, (x + 0.5) / sw, (y + 0.5) / sh, ar);
      const i = (y * sw + x) * 4;
      img.data[i] = Math.round(c[0] * 255);
      img.data[i + 1] = Math.round(c[1] * 255);
      img.data[i + 2] = Math.round(c[2] * 255);
      img.data[i + 3] = 255;
    }
  }
  sctx.putImageData(img, 0, 0);
  return small;
}

/**
 * Paint the wallpaper and the drop shadow, then hand back the rounded window the content is
 * drawn into. The caller clips to that path, draws the crop, and the plate is complete.
 */
export function paintPlate(ctx, bg, outW, outH, box) {
  const key = `${bg.name}:${outW}x${outH}`;
  let plate = plateCache.get(key);
  if (!plate) {
    plate = fillCanvas(bg.fill, outW, outH, outW / outH);
    plateCache.set(key, plate);
    // The cache is per background and per frame size, and a session touches a handful of each.
    if (plateCache.size > 24) plateCache.delete(plateCache.keys().next().value);
  }
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(plate, 0, 0, outW, outH);

  const blur = Math.max(Math.min(outW, outH) * SHADOW_BLUR_FRAC, 6);
  ctx.shadowColor = `rgba(5, 5, 10, ${SHADOW_ALPHA})`;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetY = blur * SHADOW_DY;
  ctx.fillStyle = "rgba(0, 0, 0, 1)";
  const spread = blur * SHADOW_SPREAD;
  roundRectPath(ctx, box.x - spread, box.y - spread, box.w + 2 * spread, box.h + 2 * spread, box.radius + spread);
  ctx.fill();
  ctx.restore();
}

export function roundRectPath(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}
