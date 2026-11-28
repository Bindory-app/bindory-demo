import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("ships the current live layer in the standalone wireframe", () => {
  expect(
    execFileSync("python3", ["scripts/sync-live-layer.py", "--check"], { encoding: "utf8" }),
  ).toContain("in sync");
});
