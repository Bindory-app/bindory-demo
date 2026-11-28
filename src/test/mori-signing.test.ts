import { describe, expect, it } from "vitest";

describe("Collectr task signatures", () => {
  it("signs a task for one collector only", async () => {
    process.env["MORI_MCP_SECRET"] ??= "x".repeat(40);
    const { signTask, isOwnTask } = await import("@/lib/mori-signing.server");
    const sig = signTask("u1", "resp_1", "hsess_1");
    expect(isOwnTask("u1", "resp_1", "hsess_1", sig)).toBe(true);
    expect(isOwnTask("u2", "resp_1", "hsess_1", sig)).toBe(false);
    expect(isOwnTask("u1", "resp_2", "hsess_1", sig)).toBe(false);
  });
});
