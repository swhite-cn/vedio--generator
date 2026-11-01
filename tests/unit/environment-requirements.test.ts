import { expect, test } from "vitest";
import { validateEnvironment } from "../../scripts/verify-windows-environment.mjs";

test("Node 18 被环境校验拒绝", async () => {
  const results = await validateEnvironment({
    nodeVersion: "18.20.8",
    pnpmVersion: "10.0.0",
    pythonVersion: "Python 3.12.10",
    commandVersions: { ffmpeg: "ffmpeg version 7", ffprobe: "ffprobe version 7" },
  });

  expect(results).toContainEqual(expect.objectContaining({ name: "node", status: "FAIL" }));
});
