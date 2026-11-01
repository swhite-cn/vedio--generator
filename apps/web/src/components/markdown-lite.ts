/**
 * 受限 Markdown 渲染（Web 专题 §5.4.2）：仅支持段落、无序 / 有序列表、代码块与加粗。
 *
 * 安全约束：**先对整段文本做 HTML 实体转义，再套用受控标签**，因此输入中的任何
 * `<script>` / 属性注入都会被还原为纯文本，不存在 XSS 面。渲染结果为 HTML 字符串，
 * 由组件以 `v-html` 挂载（内容已转义，安全）。
 */

/**
 * 转义 HTML 特殊字符。
 * @param text 原始文本
 * @returns 转义后的文本
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 渲染行内加粗（`**文本**`）；仅在已转义文本上作业。
 * @param text 已转义的单行文本
 * @returns 含 `<strong>` 的行内 HTML
 */
function renderInline(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

/**
 * 把受限 Markdown 文本渲染为 HTML。
 * @param source 原始文本（用户或 agent 回复）
 * @returns 已转义并套用受控标签的 HTML 字符串
 */
export function renderMarkdownLite(source: string): string {
  const escaped = escapeHtml(source ?? "");
  const lines = escaped.split(/\r?\n/);
  const html: string[] = [];
  let inCode = false;
  let codeBuffer: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let paragraph: string[] = [];

  /** 输出当前累积的段落。 */
  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      html.push(`<p>${renderInline(paragraph.join("<br>"))}</p>`);
      paragraph = [];
    }
  };
  /** 闭合当前列表。 */
  const closeList = (): void => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const line of lines) {
    // 代码块围栏（```），内部不做任何解析
    if (line.startsWith("```")) {
      flushParagraph();
      closeList();
      if (inCode) {
        html.push(`<pre><code>${codeBuffer.join("\n")}</code></pre>`);
        codeBuffer = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuffer.push(line);
      continue;
    }

    const unordered = /^\s*[-*]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (unordered) {
      flushParagraph();
      if (listType !== "ul") {
        closeList();
        html.push("<ul>");
        listType = "ul";
      }
      html.push(`<li>${renderInline(unordered[1])}</li>`);
      continue;
    }
    if (ordered) {
      flushParagraph();
      if (listType !== "ol") {
        closeList();
        html.push("<ol>");
        listType = "ol";
      }
      html.push(`<li>${renderInline(ordered[1])}</li>`);
      continue;
    }
    if (line.trim().length === 0) {
      flushParagraph();
      closeList();
      continue;
    }
    closeList();
    paragraph.push(line);
  }

  // 未闭合的代码块按普通代码块收尾，避免内容丢失
  if (inCode) {
    html.push(`<pre><code>${codeBuffer.join("\n")}</code></pre>`);
  }
  flushParagraph();
  closeList();
  return html.join("");
}
