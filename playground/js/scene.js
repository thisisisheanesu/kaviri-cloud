/*
 * The page the playground films.
 *
 * The recorder points a real browser at a real URL. A page cannot do that for you: it cannot
 * drive another site, measure its elements or screenshot it, and pretending otherwise with an
 * iframe would produce a demo that breaks on every site with a frame-ancestors header. So the
 * playground ships its own page instead, laid out here in plain numbers, and the script's
 * selectors resolve against it.
 *
 * What that buys is not a picture. It is real geometry: every element has a genuine box in CSS
 * pixels, so the zoom ladder, the left bias and the pan are computed from measurements rather
 * than from something invented to make the demo look good. Swap the preset and the page relays
 * out at the new viewport width exactly as a site would, and the framing changes with it.
 *
 * The content is fictional. Inventing a customer, a rate card or a testimonial for a demo is
 * how a screenshot of a mock ends up quoted as a fact, so the shop below sells one made-up
 * object, carries no figures at all, and says nothing a reader could mistake for a claim
 * about anything real.
 */

const INK = "#16181d";
const MUTED = "#6b7280";
const FAINT = "#9aa1ac";
const LINE = "#e3e5ea";
const PAPER = "#ffffff";
const WASH = "#f5f6f8";
/* One saturated brand colour on an otherwise pale page. The auto backdrop picker aims a third of
   the way round the colour wheel from the content's dominant hue, and a page with no hue at all
   would exercise only half of it. */
const BRAND = "#2f6df6";
const BRAND_DEEP = "#1f4fc4";
const GOOD = "#0f7a4a";

export const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/**
 * Lay the page out for a viewport width.
 *
 * Returns nodes in document coordinates. Turning those into the viewport boxes the recorder
 * reports is the simulator's job, because only it knows where the page has been scrolled to.
 */
export function buildScene(viewportW) {
  const narrow = viewportW < 700;
  const pad = narrow ? 20 : 32;
  const col = viewportW - pad * 2;
  const field = Math.min(narrow ? col : 420, col);
  const nodes = [];
  const add = (n) => {
    nodes.push(n);
    return n;
  };

  const headerH = narrow ? 56 : 64;
  add({ kind: "bar", x: 0, y: 0, w: viewportW, h: headerH });
  add({
    sel: "#logo",
    kind: "logo",
    x: pad,
    y: (headerH - 24) / 2,
    w: 124,
    h: 24,
    text: "demo shop",
  });
  if (!narrow) {
    add({
      sel: "#nav-docs",
      kind: "navlink",
      x: viewportW - pad - 236,
      y: (headerH - 20) / 2,
      w: 42,
      h: 20,
      text: "Docs",
    });
    add({
      sel: "#nav-pricing",
      kind: "navlink",
      x: viewportW - pad - 176,
      y: (headerH - 20) / 2,
      w: 60,
      h: 20,
      text: "Pricing",
    });
  }
  add({
    sel: "#sign-in",
    kind: "button-ghost",
    x: viewportW - pad - 94,
    y: (headerH - 34) / 2,
    w: 94,
    h: 34,
    text: "Sign in",
  });

  let y = headerH + (narrow ? 32 : 56);

  const h1Size = narrow ? 30 : 42;
  const h1 = add({
    sel: "#headline",
    kind: "h1",
    x: pad,
    y,
    w: Math.min(col, narrow ? col : 600),
    h: narrow ? 78 : 104,
    size: h1Size,
    lines: narrow
      ? ["A kettle that", "boils on cue."]
      : ["A kettle that boils", "on cue."],
  });
  y = h1.y + h1.h + 16;

  const sub = add({
    sel: "#subhead",
    kind: "body",
    x: pad,
    y,
    w: Math.min(col, 520),
    h: 48,
    lines: [
      "Nothing here is real. It is a page with honest",
      "geometry, so the camera has something to measure.",
    ],
  });
  y = sub.y + sub.h + 24;

  add({
    sel: "#get-started",
    kind: "button",
    x: pad,
    y,
    w: narrow ? Math.min(col, 220) : 196,
    h: 52,
    text: "Get started",
  });
  if (!narrow) {
    add({
      sel: "#learn-more",
      kind: "button-ghost",
      x: pad + 212,
      y,
      w: 150,
      h: 52,
      text: "How it works",
    });
  }
  y += 52 + (narrow ? 40 : 64);

  add({ sel: "#order-heading", kind: "h2", x: pad, y, w: col, h: 26, text: "Your order" });
  y += 26 + 16;

  const cardH = narrow ? 188 : 132;
  add({
    sel: "#product-kettle",
    kind: "card",
    x: pad,
    y,
    w: col,
    h: cardH,
    title: "Copper kettle, 1.2L",
    blurb: "Made up for this demo. Ships never.",
    // Deliberately not a price. The seam check reads this directory, and a money field in
    // the open repository is exactly what it exists to refuse, even in a fixture nobody
    // buys anything from. The line is here for the geometry, so any third line will do.
    meta: "Not for sale",
  });
  add({
    sel: "#add-to-cart",
    kind: "button",
    x: narrow ? pad + 20 : pad + col - 20 - 156,
    y: narrow ? y + cardH - 20 - 44 : y + (cardH - 44) / 2,
    w: 156,
    h: 44,
    text: "Add to cart",
  });
  y += cardH + (narrow ? 40 : 56);

  add({ sel: "#checkout-heading", kind: "h2", x: pad, y, w: col, h: 26, text: "Checkout" });
  y += 26 + 20;

  const fieldRow = (sel, label, placeholder, h) => {
    add({ kind: "label", x: pad, y, w: field, h: 16, text: label });
    y += 16 + 8;
    const n = add({ sel, kind: h > 60 ? "textarea" : "input", x: pad, y, w: field, h, placeholder });
    y += h + 20;
    return n;
  };
  fieldRow("#email", "Email", "you@example.com", 48);
  fieldRow("#card", "Card number", "4242 4242 4242 4242", 48);
  fieldRow("#notes", "Delivery notes", "Leave it with the neighbour", 104);

  add({ sel: "#place-order", kind: "button", x: pad, y, w: narrow ? col : 210, h: 52, text: "Place order" });
  y += 52 + 40;

  add({
    sel: ".welcome",
    kind: "banner",
    x: pad,
    y,
    w: Math.min(col, 560),
    h: 76,
    title: "Order placed",
    blurb: "A wait on .welcome is what a script would sit on here.",
  });
  y += 76 + 56;

  add({ kind: "rule", x: 0, y, w: viewportW, h: 1 });
  add({
    sel: "#footer",
    kind: "foot",
    x: pad,
    y: y + 22,
    w: col,
    h: 20,
    text: "demo shop is a fixture in the kaviri playground",
  });

  return {
    viewportW,
    docHeight: Math.round(y + 88),
    nodes,
    narrow,
  };
}

/**
 * Resolve a selector the way the recorder's resolve_box does, minus the browser.
 *
 * The recorder answers "selector not found" for a miss and the script stops there. So does this,
 * and the editor reports it against the op's own line, which is the part of the real failure
 * mode worth reproducing.
 */
export function findNode(scene, selector) {
  return scene.nodes.find((n) => n.sel === selector) || null;
}

/** Every selector the fixture offers, for the editor's completion hint. */
export function selectors(scene) {
  return scene.nodes.filter((n) => n.sel).map((n) => n.sel);
}

/**
 * The pointer shape the OS would show over a node, mirroring KIND_FN in the recorder's ops.rs.
 */
export function cursorKindFor(node) {
  if (!node) return "arrow";
  if (node.kind === "input" || node.kind === "textarea") return "text";
  if (node.kind === "button" || node.kind === "button-ghost" || node.kind === "navlink") {
    return "hand";
  }
  if (node.kind === "logo") return "hand";
  return "arrow";
}

/** Whether typing into this node is something the page would accept. */
export function isEditable(node) {
  return !!node && (node.kind === "input" || node.kind === "textarea");
}

/** Text geometry inside a field, shared by the renderer and the caret model. */
export function fieldTextOrigin(node) {
  return { x: node.x + 16, y: node.y + (node.kind === "textarea" ? 18 : node.h / 2) };
}

export const FIELD_FONT = `15px ${FONT_STACK}`;

function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function label(ctx, text, x, y, font, colour, align = "left", baseline = "middle") {
  ctx.font = font;
  ctx.fillStyle = colour;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(text, x, y);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

/**
 * Paint the page into a context already sized to the viewport, scrolled to `scrollY`.
 *
 * `state` carries what the script has done to the page so far: the text typed into each field,
 * which one holds focus, and whether the caret is in its visible half-second. The recorder gets
 * all of that for free because a real browser is doing it.
 */
export function drawScene(ctx, scene, scrollY, viewportW, viewportH, state) {
  ctx.save();
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, viewportW, viewportH);
  ctx.translate(0, -scrollY);

  for (const n of scene.nodes) {
    // Nothing off screen is drawn, which keeps a long page cheap to animate at 30fps.
    if (n.y + n.h < scrollY - 8 || n.y > scrollY + viewportH + 8) continue;
    drawNode(ctx, n, state, scene);
  }

  ctx.restore();
}

function drawNode(ctx, n, state, scene) {
  switch (n.kind) {
    case "bar": {
      ctx.fillStyle = PAPER;
      ctx.fillRect(n.x, n.y, n.w, n.h);
      ctx.fillStyle = LINE;
      ctx.fillRect(n.x, n.y + n.h - 1, n.w, 1);
      break;
    }
    case "rule": {
      ctx.fillStyle = LINE;
      ctx.fillRect(n.x, n.y, n.w, 1);
      break;
    }
    case "logo": {
      ctx.fillStyle = BRAND;
      roundRect(ctx, n.x, n.y + 3, 18, 18, 5);
      ctx.fill();
      label(ctx, n.text, n.x + 26, n.y + n.h / 2, `600 15px ${FONT_STACK}`, INK);
      break;
    }
    case "navlink":
      label(ctx, n.text, n.x, n.y + n.h / 2, `14px ${FONT_STACK}`, MUTED);
      break;
    case "h1": {
      ctx.fillStyle = INK;
      ctx.font = `700 ${n.size}px ${FONT_STACK}`;
      ctx.textBaseline = "top";
      n.lines.forEach((line, i) => ctx.fillText(line, n.x, n.y + i * (n.size * 1.16)));
      ctx.textBaseline = "alphabetic";
      break;
    }
    case "h2":
      label(ctx, n.text, n.x, n.y + n.h / 2, `600 19px ${FONT_STACK}`, INK);
      break;
    case "body": {
      ctx.fillStyle = MUTED;
      ctx.font = `16px ${FONT_STACK}`;
      ctx.textBaseline = "top";
      n.lines.forEach((line, i) => ctx.fillText(line, n.x, n.y + i * 24));
      ctx.textBaseline = "alphabetic";
      break;
    }
    case "label":
      label(ctx, n.text, n.x, n.y + n.h / 2, `500 13px ${FONT_STACK}`, MUTED);
      break;
    case "foot":
      label(ctx, n.text, n.x, n.y + n.h / 2, `13px ${FONT_STACK}`, FAINT);
      break;
    case "button": {
      roundRect(ctx, n.x, n.y, n.w, n.h, 8);
      ctx.fillStyle = state.pressed === n.sel ? BRAND_DEEP : BRAND;
      ctx.fill();
      label(ctx, n.text, n.x + n.w / 2, n.y + n.h / 2, `600 15px ${FONT_STACK}`, "#ffffff", "center");
      break;
    }
    case "button-ghost": {
      roundRect(ctx, n.x, n.y, n.w, n.h, 8);
      ctx.fillStyle = PAPER;
      ctx.fill();
      ctx.strokeStyle = LINE;
      ctx.lineWidth = 1;
      ctx.stroke();
      label(ctx, n.text, n.x + n.w / 2, n.y + n.h / 2, `500 14px ${FONT_STACK}`, INK, "center");
      break;
    }
    case "card": {
      roundRect(ctx, n.x, n.y, n.w, n.h, 12);
      ctx.fillStyle = WASH;
      ctx.fill();
      ctx.strokeStyle = LINE;
      ctx.lineWidth = 1;
      ctx.stroke();
      const thumb = 92;
      roundRect(ctx, n.x + 20, n.y + 20, thumb, thumb, 10);
      ctx.fillStyle = "#d8dee9";
      ctx.fill();
      // A kettle, roughly: a body, a spout and a handle. Enough to read as an object once the
      // camera is zoomed into the card.
      ctx.strokeStyle = "#7c8798";
      ctx.lineWidth = 2.5;
      const cx = n.x + 20 + thumb / 2;
      const cy = n.y + 20 + thumb / 2 + 6;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 22, 18, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + 18, cy - 8);
      ctx.lineTo(cx + 30, cy - 18);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy - 22, 13, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
      const tx = n.x + 20 + thumb + 20;
      label(ctx, n.title, tx, n.y + 42, `600 16px ${FONT_STACK}`, INK);
      label(ctx, n.blurb, tx, n.y + 66, `14px ${FONT_STACK}`, MUTED);
      label(ctx, n.meta, tx, n.y + 92, `600 16px ${FONT_STACK}`, INK);
      break;
    }
    case "input":
    case "textarea": {
      const focused = state.focus === n.sel;
      roundRect(ctx, n.x, n.y, n.w, n.h, 8);
      ctx.fillStyle = PAPER;
      ctx.fill();
      ctx.strokeStyle = focused ? BRAND : LINE;
      ctx.lineWidth = focused ? 2 : 1;
      ctx.stroke();
      const typed = state.typed[n.sel] || "";
      const origin = fieldTextOrigin(n);
      ctx.save();
      roundRect(ctx, n.x + 1, n.y + 1, n.w - 2, n.h - 2, 7);
      ctx.clip();
      ctx.font = FIELD_FONT;
      ctx.textBaseline = n.kind === "textarea" ? "top" : "middle";
      if (typed) {
        ctx.fillStyle = INK;
        ctx.fillText(typed, origin.x, origin.y);
      } else {
        ctx.fillStyle = FAINT;
        ctx.fillText(n.placeholder || "", origin.x, origin.y);
      }
      if (focused && state.caretOn) {
        const w = ctx.measureText(typed).width;
        ctx.fillStyle = INK;
        const ch = n.kind === "textarea" ? 18 : 20;
        const top = n.kind === "textarea" ? origin.y : origin.y - ch / 2;
        ctx.fillRect(origin.x + w, top, 1.6, ch);
      }
      ctx.textBaseline = "alphabetic";
      ctx.restore();
      break;
    }
    case "banner": {
      roundRect(ctx, n.x, n.y, n.w, n.h, 10);
      ctx.fillStyle = "#eaf6f0";
      ctx.fill();
      ctx.strokeStyle = "#c6e5d6";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = GOOD;
      ctx.beginPath();
      ctx.arc(n.x + 30, n.y + n.h / 2, 9, 0, Math.PI * 2);
      ctx.fill();
      label(ctx, n.title, n.x + 50, n.y + 30, `600 15px ${FONT_STACK}`, "#0b5c38");
      label(ctx, n.blurb, n.x + 50, n.y + 52, `13px ${FONT_STACK}`, "#2d6b52");
      break;
    }
    default:
      break;
  }
  void scene;
}
