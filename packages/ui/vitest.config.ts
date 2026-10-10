import { defineConfig } from "vitest/config";

// Unit tests cover the UI's pure logic (layout, keys, links, selection) and need no DOM, so they
// run in Node without the Solid plugin (which would ask for jsdom).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
