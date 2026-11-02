import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { VideoForgeError } from "@videoforge/shared";
import type { Static, TSchema } from "typebox";

/**
 * bash 命令预检护栏（L1，见设计文档 §14.6）。
 *
 * 定位：**不写死任何具体坏写法**，而是把「哪些命令写法要拦」做成配置里的规则数据
 * （`agent.command_guardrails`）。典型场景是模型在 Windows 上按 cmd.exe 习惯写命令，
 * 例如 `where magick 2>nul`——在 bash 下会把 stderr 重定向到名为 `nul` 的文件，
 * 落盘后连带让 grep / find 等遍历型工具持续失败。
 *
 * 为什么不做成代码里的黑名单：黑名单只覆盖已知变体（`2>NUL` / `2> nul` / `1>nul` …），
 * 后期每发现一个新变体都要改代码发版。配置化后，新增防护只是往 YAML 追加一条规则。
 */

/** 需要做命令预检的工具名（当前仅 bash）。 */
const BASH_TOOL_NAME = "bash";

/** 单条护栏规则（与配置 `agent.command_guardrails` 的元素同构）。 */
export interface CommandGuardrailRule {
  /** 规则标识（报错与留痕定位用）。 */
  id: string;
  /** 对 bash 命令原文匹配的 ECMAScript 正则。 */
  pattern: string;
  /** 正则标志（g i m s u y 的组合）；缺省区分大小写。 */
  flags?: string;
  /** 命中动作：`rewrite` 替换后继续执行；`reject` 拒绝执行。 */
  action: "rewrite" | "reject";
  /** `rewrite` 时的替换字面量（替换「整段匹配」）。 */
  replacement?: string;
  /** 命中原因与正确做法。 */
  hint: string;
}

/** 护栏处理结果。 */
export interface GuardrailOutcome {
  /** 处理后的命令；被拒绝时等于原命令。 */
  command: string;
  /** 生效的改写规则 id 列表（按应用顺序）。 */
  rewrittenBy: string[];
  /** 拒绝信息；非空表示应阻止执行。 */
  blocked?: { ruleId: string; hint: string };
}

/**
 * 按规则集处理一条 bash 命令：
 * - `reject` 规则先命中即返回 `blocked`（不做任何改写，避免"半拦半改"的歧义）；
 * - `rewrite` 规则对**整段匹配**做字面量替换（用函数式替换，规避 `$1` 之类的捕获组歧义）。
 * 非法正则被视为无效规则跳过（配置加载期已拦截，此处仅防御）。
 * @param command bash 命令原文
 * @param rules 护栏规则集
 * @returns 处理结果
 */
export function applyCommandGuardrails(
  command: string,
  rules: readonly CommandGuardrailRule[],
): GuardrailOutcome {
  let current = command;
  const rewrittenBy: string[] = [];

  for (const rule of rules) {
    const baseFlags = (rule.flags ?? "").replace("g", "");
    let testRegex: RegExp;
    try {
      testRegex = new RegExp(rule.pattern, baseFlags);
    } catch {
      continue;
    }
    if (!testRegex.test(current)) continue;

    if (rule.action === "reject") {
      return { command, rewrittenBy, blocked: { ruleId: rule.id, hint: rule.hint } };
    }

    const replacement = rule.replacement ?? "";
    // 函数式替换：replacement 一律作为字面量，避免 `$&` / `$1` 被当作捕获组引用
    current = current.replace(new RegExp(rule.pattern, `${baseFlags}g`), () => replacement);
    rewrittenBy.push(rule.id);
  }

  return { command: current, rewrittenBy };
}

/**
 * 给 `bash` 工具挂一层命令预检：命中 `reject` 规则时抛 `TOOL_COMMAND_BLOCKED`，
 * 命中 `rewrite` 规则时把改写后的命令交给原工具执行。
 *
 * 只对 `bash` 生效；规则集为空、或工具不是 bash 时**原样返回定义**（零开销）。
 * @param definition 被包装的工具定义
 * @param rules 护栏规则集
 * @returns 包装后的工具定义（保留原全部字段）
 */
export function withCommandGuardrails<TParams extends TSchema, TDetails>(
  definition: ToolDefinition<TParams, TDetails>,
  rules: readonly CommandGuardrailRule[],
): ToolDefinition<TParams, TDetails> {
  if (definition.name !== BASH_TOOL_NAME || rules.length === 0) return definition;

  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>> {
      const record = params as { command?: unknown };
      const command = typeof record.command === "string" ? record.command : undefined;
      // 无 command 字段（或非字符串）时不介入，交回原工具自行报参数错误
      if (command === undefined) {
        return definition.execute(toolCallId, params, signal, onUpdate, ctx);
      }

      const outcome = applyCommandGuardrails(command, rules);
      if (outcome.blocked) {
        throw new VideoForgeError(
          "TOOL_COMMAND_BLOCKED",
          `bash 命令被护栏规则 ${outcome.blocked.ruleId} 拒绝：${outcome.blocked.hint}`,
        );
      }
      if (outcome.rewrittenBy.length === 0) {
        return definition.execute(toolCallId, params, signal, onUpdate, ctx);
      }

      console.warn(
        `[command-guardrails] 已按规则 ${outcome.rewrittenBy.join(",")} 改写 bash 命令：${command} → ${outcome.command}`,
      );
      const rewrittenParams = {
        ...(params as Record<string, unknown>),
        command: outcome.command,
      } as unknown as Static<TParams>;
      return definition.execute(toolCallId, rewrittenParams, signal, onUpdate, ctx);
    },
  };
}
