/*
 * The scripts the playground opens with.
 *
 * Each one exists to show a different thing the planner does, because the planner's behaviour is
 * the only thing here worth a visitor's time. They are written against the fixture's selectors,
 * they are short enough to read in one screen, and the last one is deliberately wrong: a take
 * that ends on a click loses the zoom on the very thing it was demonstrating, and seeing that
 * happen once is worth more than the paragraph in the README that says so.
 */

export const EXAMPLES = [
  {
    id: "checkout",
    name: "Checkout",
    preset: "desktop",
    about: "The ordinary case: clicks, two typed fields, and a tail so the last click gets its zoom.",
    script: `{"op":"navigate","url":"https://demo.example/checkout"}
{"op":"wait","ms":600}
{"op":"click","selector":"#get-started"}
{"op":"click","selector":"#add-to-cart"}
{"op":"type","selector":"#email","text":"ada@example.com"}
{"op":"type","selector":"#card","text":"4242 4242 4242 4242"}
{"op":"click","selector":"#place-order"}
{"op":"wait","selector":".welcome","timeout_ms":20000}
{"op":"wait","ms":1500}
`,
  },
  {
    id: "typing-pan",
    name: "The typing pan",
    preset: "desktop",
    about:
      "A long line typed slowly. The camera follows the caret, not the pointer, which is the " +
      "one thing kaviri does differently from a screen recorder.",
    script: `{"op":"navigate","url":"https://demo.example/checkout"}
{"op":"type","selector":"#notes","text":"Leave it with the neighbour at number 14, the one with the blue door","typewriter_ms":45}
{"op":"wait","ms":1800}
`,
  },
  {
    id: "vertical",
    name: "Vertical",
    preset: "tiktok",
    about:
      "The same page at a phone viewport. Scroll rather than pan, keep every beat short, and " +
      "open on the most legible thing.",
    script: `{"op":"navigate","url":"https://demo.example/checkout"}
{"op":"wait","ms":500}
{"op":"click","selector":"#get-started"}
{"op":"scroll","y":520,"smooth":true}
{"op":"click","selector":"#add-to-cart"}
{"op":"type","selector":"#email","text":"ada@example.com","typewriter_ms":30}
{"op":"click","selector":"#place-order"}
{"op":"wait","ms":1600}
`,
  },
  {
    id: "merge",
    name: "Two clicks, one move",
    preset: "desktop",
    about:
      "Interactions close together in time merge into a single event with pan waypoints, so the " +
      "camera travels between them instead of zooming out and back in.",
    script: `{"op":"navigate","url":"https://demo.example/checkout"}
{"op":"click","selector":"#nav-docs"}
{"op":"click","selector":"#sign-in"}
{"op":"wait","ms":300}
{"op":"click","selector":"#get-started"}
{"op":"wait","ms":2000}
`,
  },
  {
    id: "no-tail",
    name: "Ending on a click",
    preset: "desktop",
    about:
      "No trailing wait. A zoom needs about 2.1 seconds after the mark to hold and ease out, " +
      "so rather than lose it the recorder holds the final frame for as long as the zoom needs. " +
      "Watch the tail pad in the readout, and watch the last second and a half of the take be a " +
      "still. A trailing wait buys you real footage there instead.",
    script: `{"op":"navigate","url":"https://demo.example/checkout"}
{"op":"click","selector":"#get-started"}
{"op":"click","selector":"#place-order"}
`,
  },
];

export const DEFAULT_EXAMPLE = EXAMPLES[0];
