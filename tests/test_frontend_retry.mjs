// Verify retries replace only the failed turn and keep earlier conversation history.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const retrySource = source.slice(source.indexOf("function replaceFailedFollowUp("), source.indexOf("function blobAsDataURL("));
const fetchSource = source.slice(source.indexOf("async function fetchFollowUp("), source.indexOf("function safeLocalImage("));

function fixture(records) {
  const state = { chatMessages: [...records], conversationId: "retry-conversation", followUpCount: 2 };
  const rows = records.map((record) => ({ record, remove() { rows.splice(rows.indexOf(this), 1); } }));
  const messages = { get lastElementChild() { return rows.at(-1); } };
  let profile = { enabled: true, id: "profile-a", nickname: "测试账号" };
  let provider = { baseUrl: "https://provider.example/v1", model: "mock-model", apiKey: "mock-key" };
  const helpers = runInNewContext(retrySource + "\n({replaceFailedFollowUp,followUpRequestSignature})", {
    state,
    getUserInfo: () => profile,
    getActiveProvider: () => provider,
  });
  return { state, rows, messages, ...helpers, setProfile(value) { profile = value; }, setProvider(value) { provider = value; } };
}
const history = [
  { role: "assistant", text: "第一段已经完成的解读。" },
  { role: "user", text: "之前的提问。" },
  { role: "assistant", text: "之前完整成功的回应。" },
];

function failedTurn(id = "same-request") {
  return [
    { role: "user", text: "这次的提问。", message: "这次的提问。", requestId: id, requestSignature: "same-payload" },
    { role: "assistant", text: "已经显示的部分。连接中断。", error: true },
  ];
}

test("retry removes the failed user and response together while preserving all earlier successes", () => {
  const [question, error] = failedTurn();
  const f = fixture([...history, question, error]);
  assert.equal(f.replaceFailedFollowUp(f.messages), question);
  assert.deepEqual(f.state.chatMessages, history);
  assert.deepEqual(f.rows.map((row) => row.record), history);
  assert.equal(f.state.followUpCount, 2);
});

test("repeated retries keep the message count stable and retain the original request metadata", () => {
  const f = fixture(history);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const [question, error] = failedTurn();
    f.state.chatMessages.push(question, error);
    for (const record of [question, error]) f.rows.push({ record, remove() { f.rows.splice(f.rows.indexOf(this), 1); } });
    const removed = f.replaceFailedFollowUp(f.messages);
    assert.equal(removed.requestId, "same-request");
    assert.equal(removed.requestSignature, "same-payload");
    assert.equal(f.state.chatMessages.length, history.length);
    assert.equal(f.rows.length, history.length);
    assert.deepEqual(f.state.chatMessages, history);
  }
});

test("successful and paused responses are never removed as failed turns", () => {
  for (const answer of [{ role: "assistant", text: "成功的回应。" }, { role: "assistant", text: "已经显示的部分。", stopped: true }]) {
    const records = [...history, { role: "user", text: "新的提问。" }, answer];
    const f = fixture(records);
    assert.equal(f.replaceFailedFollowUp(f.messages), null);
    assert.deepEqual(f.state.chatMessages, records);
    assert.deepEqual(f.rows.map((row) => row.record), records);
  }
});

test("only the latest failed pair is replaced; historical errors remain part of earlier history", () => {
  const older = [...history, ...failedTurn("older-request"), { role: "user", text: "后来成功的问题。" }, { role: "assistant", text: "后来成功的回应。" }];
  const f = fixture([...older, ...failedTurn("latest-request")]);
  assert.equal(f.replaceFailedFollowUp(f.messages).requestId, "latest-request");
  assert.deepEqual(f.state.chatMessages, older);
  assert.deepEqual(f.rows.map((row) => row.record), older);
});

test("retry payload identity changes with text, attachments, active profile or provider", () => {
  const f = fixture(history);
  const image = "data:image/jpeg;base64,AQID";
  const original = f.followUpRequestSignature("原问题", [image]);
  assert.equal(f.followUpRequestSignature("原问题", [image]), original);
  assert.notEqual(f.followUpRequestSignature("修改后的问题", [image]), original);
  assert.notEqual(f.followUpRequestSignature("原问题", []), original);
  assert.notEqual(f.followUpRequestSignature("原问题", ["data:image/jpeg;base64,BAUG"]), original);
  f.setProfile({ enabled: false });
  assert.notEqual(f.followUpRequestSignature("原问题", [image]), original);
  f.setProfile({ enabled: true, id: "profile-a", nickname: "测试账号" });
  f.setProvider({ baseUrl: "https://other.example/v1", model: "other-model", apiKey: "mock-key" });
  assert.notEqual(f.followUpRequestSignature("原问题", [image]), original);
});

test("follow-up API receives the original request ID and successful retries advance the round once", async () => {
  const state = { conversationId: "retry-conversation", followUpCount: 2 };
  const requests = [];
  const fetchFollowUp = runInNewContext(fetchSource + "\nfetchFollowUp", {
    state,
    getUserInfo: () => ({ enabled: false }),
    getActiveProvider: () => null,
    readingOwner: () => "guest",
    fetch: async (url, options) => { requests.push({ url, payload: JSON.parse(options.body) }); return {}; },
    streamToOutput: async (_response, _output, onPayload) => onPayload({ done: true, rounds: 3, closed: false }),
  });
  const attachment = "data:image/jpeg;base64,AQID";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const completion = await fetchFollowUp("同一个问题", [attachment], {}, new AbortController().signal, () => {}, "same-request-id");
    assert.equal(completion.rounds, 3);
    assert.equal(state.followUpCount, 3);
  }
  assert.ok(requests.every((request) => request.url === "/api/follow-up" && request.payload.requestId === "same-request-id"));
  assert.ok(requests.every((request) => request.payload.images[0] === attachment));
});
