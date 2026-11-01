import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

test("系统配置模板和双输出 Profile 存在", () => {
  for (const path of [
    "config/default.yaml",
    "config/system.local.example.yaml",
    "config/profiles/landscape-1080p.yaml",
    "config/profiles/portrait-1080p.yaml",
  ]) {
    expect(existsSync(resolve(process.cwd(), path))).toBe(true);
  }
});

test(".pi/settings.json 声明技能发现路径为 .trae/skills", () => {
  const settingsPath = resolve(process.cwd(), ".pi/settings.json");
  expect(existsSync(settingsPath)).toBe(true);
  const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  // 技能路径相对 .pi 目录解析，指向仓库 .trae/skills（见 docs/notes/pi-sdk-api.md §7.2）
  expect(settings.skills).toEqual(["../.trae/skills"]);
});
