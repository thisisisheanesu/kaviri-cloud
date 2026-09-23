import { defineConfig } from "vitest/config";

// Plain Node, not workerd. Every module in src/ is written against web standards that
// Node has had since 18: Request, Response, ReadableStream, crypto.subtle and Headers.
// The bucket is the only Cloudflare-specific thing the Worker touches, and it is reached
// through a narrow interface that a stub satisfies in a few lines. Keeping it that way is
// worth more than the fidelity of running in the real runtime, because it means the
// Range and signature edge cases get tested on every commit instead of being checked by
// hand against a deployed URL.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
