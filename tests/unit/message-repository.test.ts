/**
 * 会话消息仓储单测（`apps/server/src/db/repositories/message-repository.ts`）。
 *
 * 重点覆盖新增的游标分页 `listMessagesPage`：升序返回、`hasMore` 与 `nextBefore` 正确、
 * 越权返回空页、`limit` 归一化。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "@videoforge/shared";
import { createDatabase, migrateDatabase } from "../../apps/server/src/db";
import { createProject } from "../../apps/server/src/db/repositories/project-repository";
import { createSession } from "../../apps/server/src/db/repositories/session-repository";
import {
  appendMessage,
  listMessages,
  listMessagesPage,
} from "../../apps/server/src/db/repositories/message-repository";

let directory: string;
let database: ReturnType<typeof createDatabase>;
let sessionId: string;

const userA: Actor = { userId: "user-a", role: "user" };
const userB: Actor = { userId: "user-b", role: "user" };

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "videoforge-messages-"));
  const filename = join(directory, "videoforge.db");
  migrateDatabase(filename);
  database = createDatabase(filename);
  const project = createProject(database.db, userA, {
    capabilityId: "video-generation",
    name: "message-project",
    topic: "黑洞",
    profile: "landscape-1080p",
  });
  const session = createSession(database.db, userA, { projectId: project.id, title: "会话" });
  sessionId = session.id;
});

afterEach(async () => {
  database.sqlite.close();
  await rm(directory, { recursive: true, force: true });
});

/**
 * 追加若干条消息，并保证 `created_at` 严格递增（同毫秒会导致游标歧义）。
 * @param count 条数
 */
async function seed(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    appendMessage(database.db, userA, {
      sessionId,
      role: "user",
      payload: { role: "user", content: [{ type: "text", text: `m${index}` }] },
    });
    // 仓储使用毫秒级 ISO 时间，等待 2ms 保证顺序稳定
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("listMessagesPage", () => {
  test("按时间升序返回，且 hasMore 反映是否还有更早消息", async () => {
    await seed(5);
    const first = listMessagesPage(database.db, userA, sessionId, { limit: 3 });
    expect(first.messages).toHaveLength(3);
    expect(first.hasMore).toBe(true);
    expect(first.nextBefore).toBe(first.messages[0]!.created_at);

    const second = listMessagesPage(database.db, userA, sessionId, {
      limit: 3,
      before: first.nextBefore ?? undefined,
    });
    expect(second.messages).toHaveLength(2);
    expect(second.hasMore).toBe(false);
    expect(second.nextBefore).toBeNull();

    // 前端「加载更早」语义：第二页在前、第一页在后，合起来等于全量升序
    const all = listMessages(database.db, userA, sessionId).map((item) => item.id);
    expect([...second.messages, ...first.messages].map((item) => item.id)).toEqual(all);
  });

  test("limit 归一化到 1..200", async () => {
    await seed(3);
    expect(listMessagesPage(database.db, userA, sessionId, { limit: 0 }).messages).toHaveLength(1);
    expect(listMessagesPage(database.db, userA, sessionId, { limit: 999 })).toMatchObject({
      messages: expect.any(Array),
      hasMore: false,
    });
  });

  test("越权会话返回空页", async () => {
    await seed(1);
    const page = listMessagesPage(database.db, userB, sessionId, { limit: 10 });
    expect(page).toEqual({ messages: [], hasMore: false, nextBefore: null });
  });

  test("payload 反序列化后原样返回", async () => {
    appendMessage(database.db, userA, {
      sessionId,
      role: "assistant",
      payload: { role: "assistant", content: [{ type: "text", text: "你好" }] },
    });
    const page = listMessagesPage(database.db, userA, sessionId);
    expect(page.messages[0]?.payload).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "你好" }],
    });
  });
});
