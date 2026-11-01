import { describe, expect, it } from "vitest";
import { renderMinimalScene } from "../../packages/template-sdk/src/minimal-scene";
import { getProfile } from "../../packages/template-sdk/src/contracts";

const profile = getProfile("LANDSCAPE_1080P");

describe("最小场景模板", () => {
  it("无图片时不渲染 img 标签", () => {
    const html = renderMinimalScene({
      scene: { sceneId: "s1", title: "标题", narration: "旁白" },
      profile,
      timeMs: 0,
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("标题");
  });

  it("有图片时渲染 img 且 src 为 file URL", () => {
    const html = renderMinimalScene({
      scene: {
        sceneId: "s1",
        title: "标题",
        narration: "旁白",
        imagePath: "D:\\data\\图片 1.png",
      },
      profile,
      timeMs: 0,
    });
    expect(html).toContain("<img");
    expect(html).toMatch(/src="file:\/\/\/D:.*%E5%9B%BE%E7%89%87/);
  });

  it("标题与旁白仍然 HTML 转义", () => {
    const html = renderMinimalScene({
      scene: { sceneId: "s1", title: "<b>x</b>", narration: "a&b" },
      profile,
      timeMs: 0,
    });
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("a&amp;b");
    expect(html).not.toContain("<b>x</b>");
  });
});
