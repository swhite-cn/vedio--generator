import { describe, expect, it } from "vitest";
import {
  assertSceneCodeSafe,
  buildFallbackSceneCode,
  sceneCodeSchema,
  wrapSceneDocument,
  type SceneCode,
} from "../../packages/template-sdk/src/index";

/** 构造一份合法的场景代码（可覆盖局部字段） */
function makeCode(overrides: Partial<SceneCode> = {}): SceneCode {
  return {
    html: '<img class="bg" src="../images/s1.png"><h1 class="t">标题</h1>',
    css: ".t{font-size:72px;color:#fff}",
    js: 'tl.from(".t", { opacity: 0, duration: 1 });',
    ...overrides,
  };
}

describe("场景代码契约", () => {
  it("schema 接受合法输入且 css 缺省为空串", () => {
    const parsed = sceneCodeSchema.parse({ html: "<h1>t</h1>", js: "tl.to('.t',{opacity:1});" });
    expect(parsed.css).toBe("");
  });

  it("schema 拒绝空 html 或空 js", () => {
    expect(sceneCodeSchema.safeParse({ html: "", js: "x" }).success).toBe(false);
    expect(sceneCodeSchema.safeParse({ html: "x", js: "" }).success).toBe(false);
  });

  it("合法代码通过安全校验", () => {
    expect(() => assertSceneCodeSafe(makeCode())).not.toThrow();
  });

  it("安全校验拒绝外部 URL", () => {
    expect(() =>
      assertSceneCodeSafe(makeCode({ html: '<img src="https://x/y.png">' })),
    ).toThrowError(/ADAPTER_PROTOCOL_INVALID/);
  });

  it("安全校验拒绝闭合标签截断", () => {
    expect(() => assertSceneCodeSafe(makeCode({ js: "const s = '</script>';" }))).toThrowError(
      /ADAPTER_PROTOCOL_INVALID/,
    );
    expect(() => assertSceneCodeSafe(makeCode({ css: "/* </style> */" }))).toThrowError(
      /ADAPTER_PROTOCOL_INVALID/,
    );
  });

  it("安全校验拒绝定时器与 rAF", () => {
    expect(() => assertSceneCodeSafe(makeCode({ js: "setTimeout(() => {}, 100);" }))).toThrowError(
      /ADAPTER_PROTOCOL_INVALID/,
    );
    expect(() =>
      assertSceneCodeSafe(makeCode({ js: "requestAnimationFrame(loop);" })),
    ).toThrowError(/ADAPTER_PROTOCOL_INVALID/);
  });

  it("安全校验拒绝真实时钟、随机数与网络请求", () => {
    expect(() => assertSceneCodeSafe(makeCode({ js: "const t = Date.now();" }))).toThrowError(
      /ADAPTER_PROTOCOL_INVALID/,
    );
    expect(() => assertSceneCodeSafe(makeCode({ js: "const r = Math.random();" }))).toThrowError(
      /ADAPTER_PROTOCOL_INVALID/,
    );
    expect(() => assertSceneCodeSafe(makeCode({ js: "fetch('/api');" }))).toThrowError(
      /ADAPTER_PROTOCOL_INVALID/,
    );
  });

  it("包装文档注入本地 GSAP 并注册暂停时间轴", () => {
    const doc = wrapSceneDocument(makeCode(), { width: 1920, height: 1080 });
    expect(doc).toContain("../vendor/gsap.min.js");
    expect(doc).toContain("gsap.timeline({ paused: true })");
    expect(doc).toContain("window.__videoforgeTimeline = tl;");
    expect(doc).toContain(makeCode().js);
    expect(doc).toContain("1920px");
  });

  it("降级动画模板通过安全校验并转义文本", () => {
    const code = buildFallbackSceneCode(
      { sceneId: "s1", title: "<b>标题</b>", narration: "口播 & 内容" },
      "../images/s1.png",
    );
    expect(() => assertSceneCodeSafe(code)).not.toThrow();
    expect(code.html).toContain("&lt;b&gt;标题&lt;/b&gt;");
    expect(code.html).toContain("口播 &amp; 内容");
    expect(code.html).toContain('<img class="bg" src="../images/s1.png"');
    expect(code.js).toContain("tl.");
  });

  it("降级模板无图时使用渐变背景", () => {
    const code = buildFallbackSceneCode({ sceneId: "s2", title: "t", narration: "n" }, undefined);
    expect(code.html).toContain("gradient");
    expect(code.html).not.toContain("<img");
  });
});
