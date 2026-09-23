import { defineConfig } from "vitest/config";

// Plain Node tests rather than the Workers pool. Everything worth testing here is either
// a pure function or the router driven through a fake environment, and both run under
// Node with the standard Web Crypto that Workers also provides. Keeping the test run free
// of a workerd download is what lets CI on a clean checkout stay a single npm install.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
