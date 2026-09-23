/*
 * The pointer the recorder draws into the page, drawn again here on a canvas.
 *
 * Headless capture has no OS cursor, so the recorder injects one: a large macOS-style pointer
 * painted twice over the same geometry, a thick white pass and then the black body, so a shape
 * built from overlapping pieces gets one clean outline rather than seams. The geometry, the hot
 * spots, the two-pass paint and the ripple are transcribed from CURSOR_JS in the recorder's
 * src/ops.rs, because a playback with a different pointer would misrepresent how much of the
 * frame the real one covers once a zoom crops into it.
 */

const SHAPES = {
  arrow: {
    vb: [-2, -2, 16, 24],
    ox: 2,
    oy: 2,
    fill: true,
    hw: 3,
    bw: 0,
    parts: [{ path: "M0 0L0 16.8L4.2 12.9L6.3 19.4L9.1 19.7L7 13.25L9.8 13.6Z" }],
  },
  hand: {
    vb: [-2, -1, 22, 27],
    ox: 8,
    oy: 2,
    fill: true,
    hw: 3,
    bw: 0,
    parts: [
      { rect: [4, 1, 4, 13, 2] },
      { rect: [7.6, 8.5, 3.8, 6, 1.9] },
      { rect: [11, 9.6, 3.7, 5.4, 1.85] },
      { rect: [14.3, 10.9, 3.4, 4.9, 1.7] },
      { rect: [0.3, 13.5, 4, 7, 2] },
      { rect: [2.6, 12.8, 15.1, 10.2, 4.5] },
    ],
  },
  text: {
    vb: [-6, -12, 12, 24],
    ox: 6,
    oy: 12,
    fill: false,
    hw: 4.2,
    bw: 1.7,
    parts: [{ path: "M-3.2 -8.8H3.2M0 -8.8V8.8M-3.2 8.8H3.2" }],
  },
};

function pathFor(part) {
  if (part.path) return new Path2D(part.path);
  const [x, y, w, h, r] = part.rect;
  const p = new Path2D();
  if (typeof p.roundRect === "function") {
    p.roundRect(x, y, w, h, r);
    return p;
  }
  // Older engines have Path2D without roundRect. Four arcs is the same shape.
  const rad = Math.min(r, w / 2, h / 2);
  p.moveTo(x + rad, y);
  p.arcTo(x + w, y, x + w, y + h, rad);
  p.arcTo(x + w, y + h, x, y + h, rad);
  p.arcTo(x, y + h, x, y, rad);
  p.arcTo(x, y, x + w, y, rad);
  p.closePath();
  return p;
}

/**
 * Draw the pointer with its hot spot at (x, y) in CSS pixels.
 *
 * `scale` is the recorder's --cursor-scale: a multiplier over a 1x system pointer, which is a
 * 24 CSS px arrow. It is measured in the viewport's own pixels, which is why a vertical preset
 * makes the same number look enormous.
 */
export function drawCursor(ctx, shape, x, y, scale) {
  const s = SHAPES[shape] || SHAPES.arrow;
  ctx.save();
  ctx.translate(x - s.ox * scale, y - s.oy * scale);
  ctx.scale(scale, scale);
  ctx.translate(-s.vb[0], -s.vb[1]);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const paths = s.parts.map(pathFor);

  ctx.shadowColor = "rgba(0, 0, 0, 0.38)";
  ctx.shadowBlur = 1.8;
  ctx.shadowOffsetY = 1.2;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = s.hw;
  for (const p of paths) {
    ctx.stroke(p);
    if (s.fill) {
      ctx.fillStyle = "#ffffff";
      ctx.fill(p);
    }
  }

  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  for (const p of paths) {
    if (s.fill) {
      ctx.fillStyle = "#0b0b0c";
      ctx.fill(p);
    }
    if (s.bw) {
      ctx.strokeStyle = "#0b0b0c";
      ctx.lineWidth = s.bw;
      ctx.stroke(p);
    }
  }
  ctx.restore();
}

/** The click ripple, at progress `p` from 0 to 1 across its half second. */
export function drawRipple(ctx, x, y, p, scale) {
  const base = 18 * Math.max(1, scale * 0.85);
  // The CSS keyframes run scale .4 to 1.7 with opacity 1 to 0, on an ease-out curve.
  const eased = 1 - Math.pow(1 - p, 3);
  const r = base * (0.4 + 1.3 * eased);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(59, 130, 246, ${0.85 * (1 - eased)})`;
  ctx.lineWidth = Math.max(3, 1.7 * scale);
  ctx.stroke();
  ctx.restore();
}
