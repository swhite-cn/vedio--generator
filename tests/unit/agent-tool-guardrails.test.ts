import { describe, expect, test, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  applyCommandGuardrails,
  withCommandGuardrails,
  type CommandGuardrailRule,
} from "../../apps/server/src/agent/tools/command-guardrails";
import {
  createToolFailureState,
  stableStringify,
  withToolCircuitBreaker,
} from "../../apps/server/src/agent/tools/tool-circuit-breaker";

/**
 * 命令护栏（L1）与重复失败熔断（L3）单测。
 *
 * 两者都不触碰真实磁盘 / 网络：护栏被测函数是纯函数，熔断用一个假 ToolDefinition 就能覆盖。
 * 用例覆盖「真实事故脚本」——模型输出 `where magick 2>nul || where identify 2>nul`
 * 在 bash 下生成名为 nul 的文件，护栏应把它改写为 `/dev/null`。
 */

/** 事故里的真实命令（cmd 风格重定向）。 */
const INCIDENT_COMMAND = "where magick 2>nul || where identify 2>nul || echo none";

/** 与 config/default.yaml 中 `cmd-nul-redirect` 等价的规则。 */
const NUL_RULE: CommandGuardrailRule = {
  id: "cmd-nul-redirect",
  pattern: ">\\s*nul\\b",
  flags: "i",
  action: "rewrite",
  replacement: ">/dev/null",
  hint: "cmd 风格的 >nul 在 bash 下会创建名为 nul 的文件；丢弃 stderr 请用 2>/dev/null。",
};

/** 构造一个仅用于测试包装器的假 ToolDefinition。 */
function fakeDefinition(
  name: string,
  execute: (params: any) => Promise<any>,
): ToolDefinition<any, any> {
  return {
    name,
    label: name,
    description: "",
    parameters: {} as any,
    execute: (_toolCallId: string, params: any) => execute(params),
  } as unknown as ToolDefinition<any, any>;
}

describe("applyCommandGuardrails：按规则处理命令文本", () => {
  test("rewrite 规则把 cmd 风格的 2>nul 改写为 2>/dev/null（保留前面的 fd 数字）", () => {
    const outcome = applyCommandGuardrails(INCIDENT_COMMAND, [NUL_RULE]);
    expect(outcome.blocked).toBeUndefined();
    expect(outcome.rewrittenBy).toEqual(["cmd-nul-redirect"]);
    expect(outcome.command).toBe(
      "where magick 2>/dev/null || where identify 2>/dev/null || echo none",
    );
  });

  test("大小写不敏感：2>NUL / > nul 同样命中", () => {
    expect(applyCommandGuardrails("cmd 2>NUL", [NUL_RULE]).command).toBe("cmd 2>/dev/null");
    expect(applyCommandGuardrails("cmd > nul", [NUL_RULE]).command).toBe("cmd >/dev/null");
  });

  test("不相关命令原样返回（不误伤 `null` 之类的普通词）", () => {
    const outcome = applyCommandGuardrails("echo null > out.txt", [NUL_RULE]);
    expect(outcome.rewrittenBy).toEqual([]);
    expect(outcome.command).toBe("echo null > out.txt");
  });

  test("reject 规则命中即返回 blocked，且不改写命令原文", () => {
    const rejectRule: CommandGuardrailRule = {
      id: "no-where",
      pattern: "\\bwhere\\b",
      action: "reject",
      hint: "bash 下用 command -v 而不是 where。",
    };
    const outcome = applyCommandGuardrails(INCIDENT_COMMAND, [rejectRule]);
    expect(outcome.blocked).toEqual({
      ruleId: "no-where",
      hint: "bash 下用 command -v 而不是 where。",
    });
    expect(outcome.command).toBe(INCIDENT_COMMAND);
  });

  test("空规则集不做任何处理", () => {
    const outcome = applyCommandGuardrails(INCIDENT_COMMAND, []);
    expect(outcome.command).toBe(INCIDENT_COMMAND);
    expect(outcome.rewrittenBy).toEqual([]);
  });
});

describe("withCommandGuardrails：只对 bash 生效", () => {
  test("规则为空时原样返回定义对象（零开销）", () => {
    const def = fakeDefinition("bash", async () => ({}));
    expect(withCommandGuardrails(def, [])).toBe(def);
  });

  test("非 bash 工具即使有规则也不包装", () => {
    const def = fakeDefinition("read", async () => ({}));
    expect(withCommandGuardrails(def, [NUL_RULE])).toBe(def);
  });

  test("命中 rewrite：改写后的命令交给原工具执行", async () => {
    const inner = vi.fn(async (params: any) => ({
      content: [{ type: "text", text: params.command }],
    }));
    const wrapped = withCommandGuardrails(fakeDefinition("bash", inner), [NUL_RULE]);

    await wrapped.execute(
      "c1",
      { command: "where magick 2>nul" } as any,
      undefined,
      undefined,
      undefined as any,
    );

    expect(inner).toHaveBeenCalledWith({ command: "where magick 2>/dev/null" });
  });

  test("命中 reject：抛 TOOL_COMMAND_BLOCKED 且不执行原工具", async () => {
    const inner = vi.fn(async () => ({}));
    const rejectRule: CommandGuardrailRule = {
      id: "no-where",
      pattern: "\\bwhere\\b",
      action: "reject",
      hint: "bash 下用 command -v 而不是 where。",
    };
    const wrapped = withCommandGuardrails(fakeDefinition("bash", inner), [rejectRule]);

    await expect(
      wrapped.execute(
        "c1",
        { command: "where magick" } as any,
        undefined,
        undefined,
        undefined as any,
      ),
    ).rejects.toThrow("TOOL_COMMAND_BLOCKED");
    expect(inner).not.toHaveBeenCalled();
  });
});

describe("stableStringify：参数指纹与键序无关", () => {
  test("键序不同的同一参数得到同一指纹", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  test("嵌套对象同样按键序归一化", () => {
    expect(stableStringify({ x: { d: 1, c: [3, 2] } })).toBe(
      stableStringify({ x: { c: [3, 2], d: 1 } }),
    );
  });
});

describe("withToolCircuitBreaker：相同参数连续失败硬熔断", () => {
  test("threshold<=0 时原样返回定义（关闭熔断）", () => {
    const def = fakeDefinition("grep", async () => ({}));
    expect(withToolCircuitBreaker(def, { threshold: 0, state: createToolFailureState() })).toBe(
      def,
    );
  });

  test("未达阈值前照常执行；达到阈值后不再执行本体", async () => {
    const inner = vi.fn(async () => {
      throw new Error("rg: os error 1");
    });
    const wrapped = withToolCircuitBreaker(fakeDefinition("grep", inner), {
      threshold: 3,
      state: createToolFailureState(),
    });
    const params = { pattern: "fallback|degraded" } as any;

    // 前 3 次都会真实执行并失败（异常原样上抛，不被吞）
    for (let i = 0; i < 3; i += 1) {
      await expect(
        wrapped.execute(`c${i}`, params, undefined, undefined, undefined as any),
      ).rejects.toThrow("rg: os error 1");
    }
    expect(inner).toHaveBeenCalledTimes(3);

    // 第 4 次：相同参数 → 熔断，不再执行本体
    await expect(
      wrapped.execute("c4", params, undefined, undefined, undefined as any),
    ).rejects.toThrow("TOOL_CIRCUIT_OPEN");
    expect(inner).toHaveBeenCalledTimes(3);
  });

  test("参数不同则各算各的签名（不会互相累积）", async () => {
    const inner = vi.fn(async () => {
      throw new Error("boom");
    });
    const wrapped = withToolCircuitBreaker(fakeDefinition("grep", inner), {
      threshold: 2,
      state: createToolFailureState(),
    });

    for (const pattern of ["a", "b", "c"]) {
      await expect(
        wrapped.execute("c", { pattern } as any, undefined, undefined, undefined as any),
      ).rejects.toThrow("boom");
    }
    // 三个不同签名各失败 1 次，均未达阈值
    expect(inner).toHaveBeenCalledTimes(3);
  });

  test("成功一次即清零该签名计数", async () => {
    let fail = true;
    const inner = vi.fn(async () => {
      if (fail) throw new Error("boom");
      return { content: [] };
    });
    const state = createToolFailureState();
    const wrapped = withToolCircuitBreaker(fakeDefinition("grep", inner), {
      threshold: 2,
      state,
    });
    const params = { pattern: "same" } as any;

    await expect(
      wrapped.execute("c1", params, undefined, undefined, undefined as any),
    ).rejects.toThrow("boom");
    fail = false;
    await wrapped.execute("c2", params, undefined, undefined, undefined as any);

    fail = true;
    // 计数已清零：再失败一次不应立刻熔断
    await expect(
      wrapped.execute("c3", params, undefined, undefined, undefined as any),
    ).rejects.toThrow("boom");
    expect(inner).toHaveBeenCalledTimes(3);
  });

  test("返回 isError 结果同样计入失败", async () => {
    const inner = vi.fn(async () => ({ content: [{ type: "text", text: "fail" }], isError: true }));
    const wrapped = withToolCircuitBreaker(fakeDefinition("grep", inner), {
      threshold: 2,
      state: createToolFailureState(),
    });
    const params = { pattern: "same" } as any;

    await wrapped.execute("c1", params, undefined, undefined, undefined as any);
    await wrapped.execute("c2", params, undefined, undefined, undefined as any);
    await expect(
      wrapped.execute("c3", params, undefined, undefined, undefined as any),
    ).rejects.toThrow("TOOL_CIRCUIT_OPEN");
    expect(inner).toHaveBeenCalledTimes(2);
  });
});
