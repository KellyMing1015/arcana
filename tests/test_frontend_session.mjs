// Refresh, account switching and interrupted network recovery for one active reading.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../reading-session.js", import.meta.url), "utf8");
const {
  READING_SESSION_KEY,
  createReadingSnapshot,
  saveReadingSnapshot,
  loadReadingSnapshot,
  reconcileConversationMessages,
} = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

const OWNER = "account:alice";
const REQUEST_ID = "c5e148f6-73ad-44ee-84df-f3e34540a421";
const CONVERSATION_ID = "0123456789abcdef0123456789abcdef";
const IMAGE = "data:image/jpeg;base64,AQID";
const CARD_IDS = new Set(["fool", "magician", "priestess", "empress", "emperor", "hierophant", "lovers", "chariot", "strength", "hermit"]);
const initialReading = "最初完整的牌面解读。";
const previous = [
  { role: "user", text: "已经问过的问题。", message: "已经问过的问题。", images: [] },
  { role: "assistant", text: "已经完成的回答。" },
];

function state(overrides = {}) {
  return {
    stage: "conversation", question: "接下来该如何安排？", spread: 3,
    selected: [{ id: "fool", reversed: false }, { id: "magician", reversed: true }, { id: "priestess", reversed: false }],
    framework: "timeline", conversationId: CONVERSATION_ID, followUpCount: 1,
    initialReading, conversationClosed: false, readingKey: "reading-20261006-alice",
    chatMessages: structuredClone(previous), followUpDraft: "还没有发出的想法。", followUpImages: [],
    pendingFollowUp: null, attachmentWarning: false,
    ...overrides,
  };
}

function storage(initial = null) {
  const values = new Map(initial === null ? [] : [[READING_SESSION_KEY, typeof initial === "string" ? initial : JSON.stringify(initial)]]);
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    values,
  };
}

function saved(overrides = {}) {
  return { ...createReadingSnapshot(state(), OWNER), ...overrides };
}

test("refresh restores the current cards, reading, messages, round count and unsent text", () => {
  const cache = storage();
  const original = state({ followUpImages: [IMAGE], conversationClosed: false });
  assert.equal(saveReadingSnapshot(cache, original, OWNER), true);
  const restored = loadReadingSnapshot(cache, OWNER, CARD_IDS);
  assert.equal(restored.readingKey, original.readingKey);
  assert.equal(restored.stage, "conversation");
  assert.deepEqual(restored.cards, original.selected);
  assert.equal(restored.question, original.question);
  assert.equal(restored.initialReading, original.initialReading);
  assert.equal(restored.rounds, 1);
  assert.deepEqual(restored.messages, original.chatMessages);
  assert.deepEqual(restored.draft, { text: original.followUpDraft, images: [IMAGE] });
});

test("the refresh cache contains only reading fields, never provider credentials or hidden instructions", () => {
  const sensitive = state({
    provider: { apiKey: "SECRET_API_TOKEN", baseUrl: "SECRET_PROVIDER_URL", model: "SECRET_MODEL" },
    initialProvider: { apiKey: "SECRET_API_TOKEN" },
    hiddenPrompt: "SECRET_SYSTEM_INSTRUCTIONS", systemPrompt: "SECRET_SYSTEM_INSTRUCTIONS",
    chatMessages: [...previous, { role: "user", text: "新的问题。", message: "新的问题。", images: [IMAGE], requestId: REQUEST_ID,
      requestSignature: "SECRET_REQUEST_SIGNATURE", provider: { apiKey: "SECRET_API_TOKEN" }, systemPrompt: "SECRET_SYSTEM_INSTRUCTIONS" }],
    selected: state().selected.map((card) => ({ ...card, prompt: "SECRET_CARD_PROMPT" })),
  });
  const cache = storage();
  assert.equal(saveReadingSnapshot(cache, sensitive, OWNER), true);
  const raw = cache.getItem(READING_SESSION_KEY);
  for (const secret of ["SECRET_API_TOKEN", "SECRET_PROVIDER_URL", "SECRET_MODEL", "SECRET_SYSTEM_INSTRUCTIONS", "SECRET_REQUEST_SIGNATURE", "SECRET_CARD_PROMPT"]) {
    assert.equal(raw.includes(secret), false, `${secret} must not be persisted`);
  }
  assert.equal(JSON.parse(raw).messages.at(-1).requestId, REQUEST_ID, "safe retry identity survives a refresh");
});

test("unknown or injected cache fields do not enter the restored application state", () => {
  const raw = saved({ apiKey: "SECRET_API_TOKEN", provider: { apiKey: "SECRET_API_TOKEN" }, hiddenPrompt: "SECRET_SYSTEM_INSTRUCTIONS", requestSignature: "SECRET_REQUEST_SIGNATURE" });
  raw.messages[0].systemPrompt = "SECRET_SYSTEM_INSTRUCTIONS";
  raw.cards[0].prompt = "SECRET_CARD_PROMPT";
  const restored = loadReadingSnapshot(storage(raw), OWNER, CARD_IDS);
  assert.ok(restored);
  for (const key of ["apiKey", "provider", "hiddenPrompt", "requestSignature"]) assert.equal(Object.hasOwn(restored, key), false);
  assert.equal(JSON.stringify(restored).includes("SECRET_"), false);
});

test("switching accounts or becoming a guest cannot show the previous owner's reading", () => {
  const cache = storage(saved());
  for (const differentOwner of ["account:bob", "guest", null, undefined]) {
    assert.equal(loadReadingSnapshot(cache, differentOwner, CARD_IDS), null);
  }
  assert.equal(loadReadingSnapshot(cache, OWNER, CARD_IDS).question, state().question);
});

test("guest readings are also isolated from a later signed-in account", () => {
  const cache = storage();
  assert.equal(saveReadingSnapshot(cache, state(), "guest"), true);
  assert.equal(loadReadingSnapshot(cache, OWNER, CARD_IDS), null);
  assert.ok(loadReadingSnapshot(cache, "guest", CARD_IDS));
});

test("a saved reading accepts the three real spread sizes and all valid round boundaries", () => {
  for (const spread of [1, 3, 10]) {
    const selected = [...CARD_IDS].slice(0, spread).map((id) => ({ id, reversed: false }));
    for (const rounds of [0, 1, 7, 8]) {
      const cache = storage();
      assert.equal(saveReadingSnapshot(cache, state({ spread, selected, followUpCount: rounds }), OWNER), true);
      const restored = loadReadingSnapshot(cache, OWNER, CARD_IDS);
      assert.ok(restored);
      assert.equal(restored.cards.length, spread);
      assert.equal(restored.rounds, rounds);
    }
  }
});

test("missing, duplicate or unknown cards and impossible rounds cannot restore a reading", () => {
  const malformed = [
    { spread: 2 }, { cards: [] }, { cards: null },
    { cards: [{ id: "fool" }, { id: "fool" }, { id: "priestess" }] },
    { cards: [{ id: "fool" }, { id: "magician" }, { id: "deleted-card" }] },
    { cards: [{ id: "fool" }, null, { id: "priestess" }] },
    ...[-1, 9, 1.5, "1", null].map((rounds) => ({ rounds })),
    { conversationId: "not-a-session" }, { initialReading: "" }, { question: null }, { messages: {} },
  ];
  for (const change of malformed) {
    assert.equal(loadReadingSnapshot(storage(saved(change)), OWNER, CARD_IDS), null, JSON.stringify(change));
  }
});

test("broken browser storage, an old schema or invalid JSON is safely ignored", () => {
  for (const raw of [null, "{broken", "null", "[]", JSON.stringify({ version: 0 }), JSON.stringify(saved({ version: 2 }))]) {
    assert.equal(loadReadingSnapshot(storage(raw), OWNER, CARD_IDS), null);
  }
  assert.equal(loadReadingSnapshot({ getItem() { throw new Error("storage denied"); } }, OWNER, CARD_IDS), null);
});

test("unknown layouts fall back to a normal result without injecting unsafe message roles or attachments", () => {
  const raw = saved({ stage: "<script>", framework: "unknown" });
  raw.messages.push({ role: "system", text: "hidden instructions" }, { role: "user", text: "图片问题", images: ["https://example.test/track", "data:text/html;base64,AQID", IMAGE] });
  const restored = loadReadingSnapshot(storage(raw), OWNER, CARD_IDS);
  assert.equal(restored.stage, "result");
  assert.equal(restored.framework, null);
  assert.ok(restored.messages.every((message) => ["user", "assistant"].includes(message.role)));
  assert.deepEqual(restored.messages.at(-1).images, [IMAGE]);
});

test("corrupt retry identifiers cannot be restored as active server requests", () => {
  for (const requestId of ["too-short", "!".repeat(32), "a".repeat(65), undefined, { value: REQUEST_ID }]) {
    const raw = saved({ pending: { requestId, roundsBefore: 1 } });
    raw.messages.push({ role: "user", text: "要重试的问题。", message: "要重试的问题。", requestId });
    const restored = loadReadingSnapshot(storage(raw), OWNER, CARD_IDS);
    assert.ok(restored, "a bad retry identifier should not discard the reading text");
    assert.equal(restored.pending, null, `invalid pending identifier: ${JSON.stringify(requestId)}`);
    assert.equal(Object.hasOwn(restored.messages.at(-1), "requestId"), false);
  }
});

test("image storage quota failure keeps every message and the unsent draft text", () => {
  const original = state({ followUpImages: [IMAGE], chatMessages: [...previous, { role: "user", text: "附图问过的问题。", message: "附图问过的问题。", images: [IMAGE] }, { role: "assistant", text: "完整文字回应。" }] });
  const expectedText = original.chatMessages.map((message) => message.text);
  const cache = storage();
  const normalWrite = cache.setItem;
  let writes = 0;
  cache.setItem = (key, value) => {
    writes += 1;
    if (value.includes("data:image")) throw new Error("QuotaExceededError");
    normalWrite(key, value);
  };
  assert.equal(saveReadingSnapshot(cache, original, OWNER), true);
  const restored = loadReadingSnapshot(cache, OWNER, CARD_IDS);
  assert.equal(writes, 2);
  assert.deepEqual(restored.messages.map((message) => message.text), expectedText);
  assert.equal(restored.draft.text, original.followUpDraft);
  assert.deepEqual(restored.draft.images, []);
  assert.equal(restored.attachmentWarning, true, "unsent attachments require a visible restore warning");
  assert.equal(restored.messages.at(-2).imagesOmitted, true, "omitted image records can still match a completed server turn");
  assert.equal(Object.hasOwn(restored.messages[0], "imagesOmitted"), false, "image-free messages must not ignore future attachment differences");
  assert.deepEqual(original.followUpImages, [IMAGE], "quota fallback must not mutate the live draft");
  assert.deepEqual(original.chatMessages.at(-2).images, [IMAGE]);
});

test("a pending image-only attempt gets a missing attachment warning even without a draft", () => {
  const original = state({
    followUpDraft: "", chatMessages: [...previous, { role: "user", text: "[图片]", message: "", images: [IMAGE], requestId: REQUEST_ID }, { role: "assistant", text: "", stopped: true }],
    pendingFollowUp: { requestId: REQUEST_ID, roundsBefore: 1 },
  });
  const cache = storage();
  const normalWrite = cache.setItem;
  cache.setItem = (key, value) => { if (value.includes("data:image")) throw new Error("QuotaExceededError"); normalWrite(key, value); };
  assert.equal(saveReadingSnapshot(cache, original, OWNER), true);
  const restored = loadReadingSnapshot(cache, OWNER, CARD_IDS);
  assert.equal(restored.attachmentWarning, true);
  assert.equal(restored.messages.at(-2).message, "");
  assert.equal(restored.messages.at(-2).text, "[图片]");
  assert.equal(restored.pending.requestId, REQUEST_ID);
});

test("if storage is completely unavailable the current reading is not erased or mutated", () => {
  const original = state({ followUpImages: [IMAGE] });
  const before = structuredClone(original);
  assert.equal(saveReadingSnapshot({ setItem() { throw new Error("storage unavailable"); } }, original, OWNER), false);
  assert.deepEqual(original, before);
});

test("a complete server answer replaces a local partial answer after refresh without adding a second turn", () => {
  const question = { role: "user", text: "新的追问。", message: "新的追问。", images: [], requestId: REQUEST_ID };
  const local = [...previous, question, { role: "assistant", text: "只收到前半段", stopped: true }];
  const server = [...previous, { role: "user", text: question.message, images: [] }, { role: "assistant", text: "服务器已经完成的完整回答。" }];
  const restored = reconcileConversationMessages(local, server, 2, { requestId: REQUEST_ID, roundsBefore: 1 });
  assert.deepEqual(restored.map((message) => [message.role, message.text]), server.map((message) => [message.role, message.text]));
  assert.equal(restored.filter((message) => message.text === question.text).length, 1);
  assert.ok(restored.every((message) => !message.stopped && !message.error));
});

test("a truly uncommitted last attempt remains available to retry after the server is checked", () => {
  const question = { role: "user", text: "尚未完成的追问。", message: "尚未完成的追问。", images: [IMAGE], requestId: REQUEST_ID };
  const partial = { role: "assistant", text: "一部分文字。", stopped: true };
  const local = [...previous, question, partial];
  const before = structuredClone(local);
  const restored = reconcileConversationMessages(local, previous, 1, { requestId: REQUEST_ID, roundsBefore: 1 });
  assert.equal(restored.length, previous.length + 2);
  assert.equal(restored.at(-2).requestId, REQUEST_ID);
  assert.deepEqual(restored.at(-2).images, [IMAGE]);
  assert.equal(restored.at(-1).text, partial.text);
  assert.equal(restored.at(-1).stopped, true);
  assert.deepEqual(local, before, "checking the server must not mutate the local snapshot");
});

test("an unsaved error without a pending stream marker is still retryable", () => {
  const local = [...previous, { role: "user", text: "新问题。", message: "新问题。", images: [], requestId: REQUEST_ID }, { role: "assistant", text: "连接中断。", error: true }];
  const restored = reconcileConversationMessages(local, previous, 1, null);
  assert.equal(restored.at(-1).error, true);
  assert.equal(restored.at(-2).requestId, REQUEST_ID);
  assert.equal(restored.length, previous.length + 2);
});

test("repeating the same question after a successful turn does not erase a newer uncommitted error", () => {
  const priorQuestion = previous.at(-2).text;
  const failedQuestion = { role: "user", text: priorQuestion, message: priorQuestion, images: [IMAGE], requestId: REQUEST_ID };
  const local = [...previous, failedQuestion, { role: "assistant", text: "这次带图的问题尚未完成。", error: true }];
  const restored = reconcileConversationMessages(local, previous, 1, null);
  assert.equal(restored.length, previous.length + 2);
  assert.equal(restored.at(-2).requestId, REQUEST_ID);
  assert.deepEqual(restored.at(-2).images, [IMAGE]);
  assert.equal(restored.at(-1).text, "这次带图的问题尚未完成。");
});

test("recovery uses the server's successful history rather than reviving stale local successes", () => {
  const local = [...previous, { role: "user", text: "本地旧记录。", message: "本地旧记录。", images: [] }, { role: "assistant", text: "旧答案。" }];
  const server = [...previous, { role: "user", text: "服务器的新记录。", images: [] }, { role: "assistant", text: "新的完整答案。" }];
  const restored = reconcileConversationMessages(local, server, 2, null);
  assert.deepEqual(restored.map((message) => message.text), server.map((message) => message.text));
  assert.equal(restored.some((message) => message.text === "旧答案。"), false);
});

test("a completed image response paused during display is recovered once after quota removed local images", () => {
  for (const message of ["看看这张图片。", ""]) {
    const question = { role: "user", text: message || "[图片]", message, images: [IMAGE], requestId: REQUEST_ID };
    const original = state({
      chatMessages: [question, { role: "assistant", text: "屏幕上只显示了开头。", stopped: true }],
      followUpDraft: "", followUpImages: [], pendingFollowUp: null,
    });
    const cache = storage();
    const normalWrite = cache.setItem;
    cache.setItem = (key, value) => { if (value.includes("data:image")) throw new Error("QuotaExceededError"); normalWrite(key, value); };
    assert.equal(saveReadingSnapshot(cache, original, OWNER), true);
    const savedReading = loadReadingSnapshot(cache, OWNER, CARD_IDS);
    assert.equal(savedReading.pending, null, "done was already received before display was paused");
    assert.equal(savedReading.messages[0].imagesOmitted, true);
    assert.deepEqual(savedReading.messages[0].images, []);

    const server = [{ role: "user", text: message, images: [IMAGE] }, { role: "assistant", text: "服务器确认完成的全部文字。" }];
    const restored = reconcileConversationMessages(savedReading.messages, server, 1, null);
    assert.equal(restored.length, 2, "the paused local pair must not duplicate its confirmed server pair");
    assert.equal(restored[0].message, message);
    assert.deepEqual(restored[0].images, [IMAGE], "the server also restores the original image attachment");
    assert.equal(restored[1].text, "服务器确认完成的全部文字。");
    assert.equal(Object.hasOwn(restored[1], "stopped"), false);
    assert.equal(Object.hasOwn(restored[0], "imagesOmitted"), false, "a fully recovered attachment no longer needs an omission marker");
    assert.equal(savedReading.messages[1].stopped, true, "reconciliation must not mutate the cached paused pair");
  }
});

test("historical uncommitted pauses remain in order while a later confirmed response replaces its partial copy", () => {
  const olderPaused = [
    { role: "user", text: "第一次被我暂停的问题。", message: "第一次被我暂停的问题。", images: [] },
    { role: "assistant", text: "第一次暂停前收到的片段。", stopped: true },
  ];
  const currentQuestion = { role: "user", text: "最后的新问题。", message: "最后的新问题。", images: [], requestId: REQUEST_ID };
  const local = [...olderPaused, ...previous, currentQuestion, { role: "assistant", text: "最后回应的开头。", stopped: true }];
  const server = [...previous, { role: "user", text: currentQuestion.message }, { role: "assistant", text: "最后的完整回应。" }];
  const expected = [...olderPaused.map((message) => message.text), ...previous.map((message) => message.text), currentQuestion.text, "最后的完整回应。"];
  const restored = reconcileConversationMessages(local, server, 2, { requestId: REQUEST_ID, roundsBefore: 1 });
  assert.deepEqual(restored.map((message) => message.text), expected);
  assert.equal(restored[1].stopped, true, "earlier genuinely incomplete text remains visible");
  assert.equal(Object.hasOwn(restored.at(-1), "stopped"), false);
  assert.equal(restored.filter((message) => message.text === currentQuestion.text).length, 1);

  const checkedAgain = reconcileConversationMessages(restored, server, 2, null);
  assert.deepEqual(checkedAgain.map((message) => message.text), expected, "repeated server checks cannot move or duplicate paused history");
});
