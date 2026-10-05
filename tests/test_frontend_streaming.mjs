// Exercise the production streaming renderer with fragmented replies, failures and pauses.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInContext, createContext } from "node:vm";
import { test } from "node:test";

const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const rendererSource = source.slice(source.indexOf("function replyParagraphs("), source.indexOf("async function fetchReading("));
const followUpSource = source.slice(source.indexOf("async function fetchFollowUp("), source.indexOf("function safeLocalImage("));
const eventFrame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

class Element {
  constructor(className = "") {
    this.className = className;
    this.children = [];
    this.dataset = {};
    this.parentElement = null;
    this.text = "";
    this.scrollTop = 0;
    this.scrollHeight = 10;
  }
  get classList() { return { contains: (name) => this.className.split(" ").includes(name) }; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map((child) => child.textContent).join(""); }
  append(child) { child.parentElement = this; this.children.push(child); }
  remove() {
    const index = this.parentElement?.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.classList.contains(selector.slice(1))) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
  closest(selector) {
    if (this.classList.contains(selector.slice(1))) return this;
    return this.parentElement?.closest(selector) || null;
  }
}

function setup({ reducedMotion = false } = {}) {
  const clock = {
    time: 0,
    frame: 0,
    callbacks: [],
    waiters: [],
    async tick() {
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
      this.frame += 1;
      this.time += 16;
      const callbacks = this.callbacks.splice(0);
      for (const callback of callbacks) callback(this.time);
      const pending = this.waiters;
      this.waiters = [];
      for (const waiter of pending) {
        if (waiter.frame <= this.frame) waiter.resolve();
        else this.waiters.push(waiter);
      }
    },
    waitFor(frame) {
      return frame <= this.frame ? Promise.resolve() : new Promise((resolve) => this.waiters.push({ frame, resolve }));
    },
  };
  const context = createContext({
    document: { createElement: () => new Element() },
    window: { matchMedia: () => ({ matches: reducedMotion }) },
    performance: { now: () => clock.time },
    TextDecoder,
    DOMException,
    requestAnimationFrame: (callback) => clock.callbacks.push(callback),
    state: { conversationId: "test-conversation", followUpCount: 2 },
    getActiveProvider: () => null,
    getUserInfo: () => ({ enabled: true, id: "test-profile" }),
  });
  runInContext(rendererSource + "\n" + followUpSource, context);
  const response = (steps) => {
    let index = 0;
    let cancelled = false;
    return {
      ok: true,
      headers: { get: () => "text/event-stream" },
      body: {
        getReader: () => ({
          async read() {
            const step = steps[index++];
            if (!step || cancelled) return { done: true };
            if (step.afterFrame) await clock.waitFor(step.afterFrame);
            return cancelled ? { done: true } : { done: false, value: new TextEncoder().encode(step.text) };
          },
          async cancel() {
            cancelled = true;
            for (const waiter of clock.waiters.splice(0)) waiter.resolve();
          },
          releaseLock() {},
        }),
      },
    };
  };
  const settle = async (promise, onFrame = () => {}) => {
    let result;
    let error;
    let finished = false;
    promise.then((value) => { result = value; finished = true; }, (reason) => { error = reason; finished = true; });
    for (let index = 0; !finished && index < 2000; index += 1) {
      await clock.tick();
      onFrame(clock.frame);
    }
    assert.ok(finished, "stream should settle within the simulated frame budget");
    if (error) throw error;
    return result;
  };
  return { context, response, settle, clock };
}

test("fragmented SSE builds paragraph bubbles and preserves the exact transcript", async () => {
  const { context, response, settle } = setup();
  const output = new Element("chat-reply-copy");
  const text = "第一段，先看当下。\n\n第二段，再看选择。\n\n最后一段：<保持清醒>。";
  const frames = eventFrame({ content: text.slice(0, 12) }) + eventFrame({ content: text.slice(12, 18) })
    + eventFrame({ content: text.slice(18) }) + eventFrame({ done: true });
  const received = await settle(context.streamToOutput(response([
    { text: frames.slice(0, 27) }, { text: frames.slice(27, 62) }, { text: frames.slice(62) },
  ]), output));
  assert.equal(received, text);
  assert.equal(context.outputText(output), text);
  assert.equal(output.children.length, 3);
  assert.equal(output.children[2].textContent, "最后一段：<保持清醒>。");
});

test("a summary marker split between chunks stays hidden from the public reading", async () => {
  const { context, response, settle } = setup();
  const output = new Element("reading-output");
  const received = await settle(context.streamToOutput(response([
    { text: eventFrame({ content: "公开正文。\n\n【总" }) },
    { text: eventFrame({ content: "结】只供记录" }) + eventFrame({ done: true }) },
  ]), output, () => {}, () => {}, null, "【总结】"));
  assert.equal(output.textContent, "公开正文。\n\n");
  assert.equal(received, "公开正文。\n\n【总结】只供记录");
});

test("a pause after server completion keeps visible text and rejects local completion", async () => {
  const { context, response, settle } = setup();
  const output = new Element("chat-reply-copy");
  const controller = new AbortController();
  const text = "这是一段还没有展示完的回复。".repeat(20);
  const stream = context.streamToOutput(response([
    { text: eventFrame({ content: text }) + eventFrame({ done: true }) },
  ]), output, () => {}, () => {}, controller.signal);
  await assert.rejects(settle(stream, (frame) => { if (frame === 3) controller.abort(); }), (error) => error.name === "AbortError");
  assert.ok(context.outputText(output).length > 0);
  assert.ok(context.outputText(output).length < text.length);
});

test("an upstream error retains the text already displayed", async () => {
  const { context, response, settle } = setup();
  const output = new Element("chat-reply-copy");
  await assert.rejects(settle(context.streamToOutput(response([
    { text: eventFrame({ content: "已经说出的部分。" }) },
    { afterFrame: 6, text: eventFrame({ error: "连接中断" }) },
  ]), output)), /连接中断/);
  assert.ok(context.outputText(output).length > 0);
});

test("an early connection closure cannot be counted as a completed reply", async () => {
  const { context, response, settle } = setup();
  await assert.rejects(settle(context.streamToOutput(response([
    { text: eventFrame({ content: "不完整的回复" }) },
  ]), new Element("chat-reply-copy"))), /提前结束/);
});

test("pausing a completed follow-up keeps the server round count and closing state", async () => {
  const { context, response, settle } = setup();
  const controller = new AbortController();
  context.fetch = async () => response([
    { text: eventFrame({ content: "回复正在逐字展示。".repeat(20) }) + eventFrame({ done: true, rounds: 8, closed: true }) },
  ]);
  const reply = context.fetchFollowUp("继续", [], new Element("chat-reply-copy"), controller.signal, () => {});
  await assert.rejects(settle(reply, (frame) => { if (frame === 3) controller.abort(); }), (error) => {
    assert.equal(error.name, "AbortError");
    assert.equal(error.streamCompletion.closed, true);
    assert.equal(error.streamCompletion.rounds, 8);
    return true;
  });
  assert.equal(context.state.followUpCount, 8);
});

test("pausing before server completion does not advance the follow-up count", async () => {
  const { context, response, settle } = setup();
  const controller = new AbortController();
  context.fetch = async () => response([
    { text: eventFrame({ content: "回复还在生成中。".repeat(20) }) },
    { afterFrame: 30, text: eventFrame({ done: true, rounds: 3, closed: false }) },
  ]);
  const reply = context.fetchFollowUp("继续", [], new Element("chat-reply-copy"), controller.signal, () => {});
  await assert.rejects(settle(reply, (frame) => { if (frame === 3) controller.abort(); }), (error) => {
    assert.equal(error.name, "AbortError");
    assert.equal(error.streamCompletion, undefined);
    return true;
  });
  assert.equal(context.state.followUpCount, 2);
});

test("follow-up requests read the latest profile and preserve image attachments", async () => {
  const { context, response, settle } = setup({ reducedMotion: true });
  let sent;
  const images = ["data:image/png;base64,AQID"];
  context.fetch = async (url, request) => {
    sent = { url, body: JSON.parse(request.body) };
    return response([{ text: eventFrame({ content: "好。" }) + eventFrame({ done: true, rounds: 3, closed: false }) }]);
  };
  const completion = await settle(context.fetchFollowUp("看这张图片", images, new Element("chat-reply-copy"), new AbortController().signal, () => {}));
  assert.equal(sent.url, "/api/follow-up");
  assert.deepEqual(sent.body.userInfo, { enabled: true, id: "test-profile" });
  assert.deepEqual(sent.body.images, images);
  assert.equal(sent.body.message, "看这张图片");
  assert.equal(completion.rounds, 3);
  assert.equal(context.state.followUpCount, 3);
});
