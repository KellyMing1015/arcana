// Exercise the production streaming renderer with fragmented replies, failures and pauses.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInContext, createContext } from "node:vm";
import { test } from "node:test";

const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const rendererSource = source.slice(source.indexOf("function replyParagraphs("), source.indexOf("async function fetchReading("));
const followUpSource = source.slice(source.indexOf("async function fetchFollowUp("), source.indexOf("function safeLocalImage("));
const conversationSource = source.slice(source.indexOf("function safeLocalImage("), source.indexOf("function drawerCard("));
const escapeSource = source.slice(source.indexOf("function escapeHTML("), source.indexOf("function splitReadingSummary("));
const eventFrame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const visibleCharacters = (text) => text.replace(/\s/g, "");
const screenshotReply = "倒也不全是靠情谊在那儿硬撑。逆位宝剑五的意思是，她主观上就没想在这件事上跟你“决一死战”。她可能看出了你现在的局促——就是逆位星币五那种还在摸爬滚打的状态，所以她会自动调低预期。\n\n比起为了照顾你面子撒谎，她更多的是觉得“没必要挑刺”。她可能会说点客观存在的问题，但语气是卸了劲的，不会让你难堪。不过，既然宝剑十逆位了，说明她在使用的时候真的差点被某个Bug气到，最后忍住了没发作。你之后问她反馈的时候，可以试着多问一句：刚才是不是哪儿卡了一下？她要是点头了，那你得赶紧去修。";

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
    timers: new Map(),
    nextTimer: 0,
    async tick() {
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
      this.frame += 1;
      this.time += 16;
      for (const [id, timer] of this.timers) {
        if (timer.at <= this.time) { this.timers.delete(id); timer.callback(); }
      }
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
    TypeError,
    AbortController,
    Date: { now: () => clock.time },
    setTimeout: (callback, milliseconds) => {
      const id = ++clock.nextTimer;
      clock.timers.set(id, { at: clock.time + milliseconds, callback });
      return id;
    },
    clearTimeout: (id) => clock.timers.delete(id),
    requestAnimationFrame: (callback) => clock.callbacks.push(callback),
    state: { conversationId: "test-conversation", followUpCount: 2 },
    getActiveProvider: () => null,
    getUserInfo: () => ({ enabled: true, id: "test-profile" }),
    readingOwner: () => "account:test",
  });
  runInContext(rendererSource + "\n" + followUpSource + "\n" + escapeSource + "\n" + conversationSource, context);
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
            if (step.error) throw step.error;
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

test("the actual long production reply becomes natural bubbles with varied lengths", () => {
  const { context } = setup();
  const bubbles = Array.from(context.replyParagraphs(screenshotReply));
  const lengths = bubbles.map((bubble) => Array.from(bubble).length);
  assert.ok(bubbles.length > 2, "long paragraphs should no longer produce two large slabs");
  assert.ok(Math.max(...lengths) > Math.min(...lengths) * 2, "natural short and long phrases should keep different lengths");
  assert.equal(visibleCharacters(bubbles.join("")), visibleCharacters(screenshotReply));
  assert.ok(bubbles.every((bubble) => bubble.length > 0 && bubble === bubble.trim()));
  assert.ok(bubbles.every((bubble) => !/^[。！？!?，；：”’」』）]/.test(bubble)), "punctuation and closing quotes belong with the preceding text");
});

test("short answers stay short while a mixed reply retains its natural rhythm", () => {
  const { context } = setup();
  assert.deepEqual(Array.from(context.replyParagraphs("对呀。")), ["对呀。"]);
  const text = "先等等。她可能会说点客观存在的问题，但语气是卸了劲的，不会让你难堪。你可以直接问：刚才是不是哪儿卡了一下？别急。";
  const bubbles = Array.from(context.replyParagraphs(text));
  assert.ok(bubbles.includes("先等等。"));
  assert.ok(bubbles.includes("别急。"));
  assert.ok(bubbles.some((bubble) => bubble.length > 20), "longer thoughts should not be padded or forced into equal lengths");
  assert.equal(bubbles.join(""), text);
});

test("every incremental prefix has no empty bubbles and preserves all visible characters", () => {
  const { context } = setup();
  const output = new Element("chat-reply-copy");
  const text = "\r\n\t　 \r\n先等等。\r\n\r\n　她说：“别急！”\r\n\t\r\n\r\n" + screenshotReply + "\r\n　\t";
  for (let length = 0; length <= text.length; length += 1) {
    const prefix = text.slice(0, length);
    context.renderOutputText(output, prefix);
    assert.equal(context.outputText(output), prefix, `raw text changed at prefix ${length}`);
    assert.ok(output.children.every((bubble) => bubble.textContent.trim().length > 0), `empty bubble at prefix ${length}`);
    assert.equal(visibleCharacters(output.textContent), visibleCharacters(prefix), `visible text changed at prefix ${length}`);
  }
  const finalBubbles = output.children.map((bubble) => bubble.textContent);
  assert.deepEqual(finalBubbles, Array.from(context.replyParagraphs(text)), "stream completion and restored text must use the same segmentation");
  context.renderOutputText(output, "\r\n　 \t\n\n");
  assert.equal(output.children.length, 0, "whitespace-only output must remove stale bubbles");
});

test("whitespace-only streamed messages do not leave a visible empty row", () => {
  const { context } = setup();
  const message = new Element("conversation-message conversation-reader");
  const output = new Element("chat-reply-copy");
  message.append(output);
  context.renderOutputText(output, "\r\n　 \t\n\n");
  assert.equal(message.hidden, true, "an empty assistant wrapper must not add a blank chat row");
  assert.equal(output.children.length, 0);
  context.renderOutputText(output, "好。");
  assert.equal(message.hidden, false, "the first meaningful text must reveal the message again");
  assert.equal(output.children[0].textContent, "好。");
});

test("an overlong sentence can use natural comma pauses without losing its text", () => {
  const { context } = setup();
  const text = "她可能看出了你现在还在不断尝试和调整产品细节的局促状态，所以即使她真的遇到了几个不太顺手的小问题也不会马上把话说得太重，而是会等你愿意听取具体反馈的时候再把实际卡住的步骤说清楚，让你可以一个一个地把它们修好。";
  const bubbles = Array.from(context.replyParagraphs(text));
  assert.ok(bubbles.length > 1, "a long sentence should not remain a tall single bubble");
  assert.equal(bubbles.join(""), text);
  assert.ok(bubbles.slice(0, -1).every((bubble) => bubble.endsWith("，")), "natural clause punctuation should form each visual boundary");
});

test("fragmented streaming around whitespace and punctuation never leaves empty bubbles", async () => {
  const { context, response, settle } = setup();
  const output = new Element("chat-reply-copy");
  const text = "\r\n　\r\n先等等。\n\n" + screenshotReply + "\n\n　";
  const fragments = [];
  for (let index = 0; index < text.length; index += 7) fragments.push(eventFrame({ content: text.slice(index, index + 7) }));
  const frames = fragments.join("") + eventFrame({ done: true });
  const steps = [];
  for (let index = 0; index < frames.length; index += 19) steps.push({ text: frames.slice(index, index + 19) });
  const received = await settle(context.streamToOutput(response(steps), output), () => {
    assert.ok(output.children.every((bubble) => bubble.textContent.trim()), "streaming must not create whitespace bubbles");
  });
  assert.equal(received, text);
  assert.equal(context.outputText(output), text);
  assert.equal(visibleCharacters(output.textContent), visibleCharacters(text));
  assert.deepEqual(output.children.map((bubble) => bubble.textContent), Array.from(context.replyParagraphs(text)));
});

test("restored assistant bubbles match the completed stream without altering the saved transcript", () => {
  const { context } = setup();
  const text = "\n\n　" + screenshotReply + "\r\n\r\n　";
  const output = new Element("chat-reply-copy");
  context.renderOutputText(output, text);
  const restored = context.conversationBubble({ role: "assistant", text });
  const expectedBubbles = output.children.map((bubble) => `<div class="chat-bubble"><p class="chat-bubble-copy">${context.escapeHTML(bubble.textContent)}</p></div>`).join("");
  assert.ok(restored.includes(expectedBubbles), "reopening the conversation should retain the same natural bubble layout");
  const expectedTranscriptAttribute = context.escapeHTML(text).replace(/\r/g, "&#13;");
  assert.ok(restored.includes(`data-reply-text="${expectedTranscriptAttribute}"`), "saved transcript must retain CRLF through HTML parsing");
  assert.ok(!restored.includes('<p class="chat-bubble-copy"></p>'));
});

test("restored CR entities preserve literal entity text without allowing HTML injection", () => {
  const { context } = setup();
  const text = '第一行\r\n&#13;" data-forged="yes"><script>oops</script>';
  const restored = context.conversationBubble({ role: "assistant", text });
  const attribute = restored.match(/data-reply-text="([^"]*)"/)?.[1];
  assert.equal(attribute, "第一行&#13;\n&amp;#13;&quot; data-forged=&quot;yes&quot;&gt;&lt;script&gt;oops&lt;/script&gt;");
  assert.ok(!/[\r"<>]/.test(attribute), "raw CR, quotes and tags must not enter the transcript attribute");
  assert.ok(!restored.includes('<script>'));
  assert.ok(!restored.includes(' data-forged="yes"'), "reply text cannot create an additional HTML attribute");
});

test("inline links, decimals and quotation punctuation survive visual segmentation", () => {
  const { context } = setup();
  const text = "OpenRouter 使用 https://openrouter.ai/api/v1。模型温度是 0.7，版本为 Gemini 3.0。**重点**：她说“先等等，别急！”好。";
  const bubbles = Array.from(context.replyParagraphs(text));
  assert.equal(bubbles.join(""), text);
  assert.ok(bubbles.some((bubble) => bubble.includes("https://openrouter.ai/api/v1")), "a URL should remain in one bubble");
  assert.ok(bubbles.some((bubble) => bubble.includes("0.7")), "decimal points must not be mistaken for sentence boundaries");
  assert.ok(bubbles.some((bubble) => bubble.includes("Gemini 3.0")));
});

test("a URL cannot swallow the following Chinese sentence boundaries", () => {
  const { context } = setup();
  const text = "可以打开 https://openrouter.ai/api/v1。然后再看这一句。最后检查网络。";
  const bubbles = Array.from(context.replyParagraphs(text));
  assert.deepEqual(bubbles, ["可以打开 https://openrouter.ai/api/v1。", "然后再看这一句。", "最后检查网络。"]);
  assert.equal(bubbles.join(""), text);
});

test("deliberate code and list lines are preserved as structured blocks", () => {
  const { context } = setup();
  const blocks = ["- 第一步：先等等。\n- 第二步：再看看。", "```js\nconst message = '先等等。别急！';\n```"];
  for (const block of blocks) {
    assert.deepEqual(Array.from(context.replyParagraphs(block)), [block]);
  }
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

test("a confirmed completion does not wait for a later broken network EOF", async () => {
  const { context, response, settle } = setup();
  const output = new Element("chat-reply-copy");
  const text = "完整回应，已经由服务器确认。";
  context.fetch = async () => response([
    { text: eventFrame({ content: text }) + eventFrame({ done: true, rounds: 3, closed: false }) },
    { error: new TypeError("network connection reset after done") },
  ]);
  const completion = await settle(context.fetchFollowUp("继续", [], output, new AbortController().signal, () => {}, "fixed-request-id"));
  assert.equal(completion.rounds, 3);
  assert.equal(context.outputText(output), text);
  assert.equal(context.state.followUpCount, 3);
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

const recoveryId = "d77e039f-e165-407b-b521-33c203cb8acb";
function conversationStatus(overrides = {}) {
  return {
    conversationId: "test-conversation", rounds: 2, busy: false, closed: false,
    lastCompletedRequestId: "previous-request-id", messages: [], ...overrides,
  };
}
const statusResponse = (snapshot) => ({ ok: true, async json() { return snapshot; } });
const completedStatus = (text = "完整回应。", overrides = {}) => conversationStatus({
  rounds: 3, lastCompletedRequestId: recoveryId,
  messages: [{ role: "user", text: "继续" }, { role: "assistant", text }], ...overrides,
});

test("a network failure before content reconnects once with the frozen original request", async () => {
  const { context, response, settle } = setup();
  const requests = [];
  let profileReads = 0, providerReads = 0, firstContentCalls = 0;
  context.getUserInfo = () => { profileReads += 1; return { enabled: true, id: "original-profile" }; };
  context.getActiveProvider = () => { providerReads += 1; return { model: "original-model", apiKey: "fake-test-key" }; };
  context.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.startsWith("/api/conversation/")) return statusResponse(conversationStatus());
    if (requests.filter((request) => request.url === "/api/follow-up").length === 1) {
      context.getUserInfo = () => { profileReads += 1; return { enabled: false }; };
      context.getActiveProvider = () => { providerReads += 1; return { model: "changed-model" }; };
      throw new TypeError("network unavailable before headers");
    }
    return response([{ text: eventFrame({ content: "重新连上后的回应。" }) + eventFrame({ done: true, rounds: 3, closed: false }) }]);
  };
  const output = new Element("chat-reply-copy");
  const completion = await settle(context.fetchFollowUp("继续", [], output, new AbortController().signal, () => { firstContentCalls += 1; }, recoveryId));
  const posts = requests.filter((request) => request.url === "/api/follow-up");
  assert.equal(posts.length, 2); assert.equal(posts[0].options.body, posts[1].options.body);
  assert.equal(JSON.parse(posts[1].options.body).requestId, recoveryId);
  assert.equal(profileReads, 1); assert.equal(providerReads, 1); assert.equal(firstContentCalls, 1);
  assert.equal(completion.rounds, 3); assert.equal(context.state.followUpCount, 3);
  assert.equal(context.outputText(output), "重新连上后的回应。");
  assert.equal(requests.find((request) => request.url.startsWith("/api/conversation/")).options.cache, "no-store");
});

test("a saved answer replaces a partial broken stream without posting the question again", async () => {
  const { context, response, settle } = setup();
  let posts = 0, firstContentCalls = 0;
  context.fetch = async (url) => {
    if (url === "/api/follow-up") {
      posts += 1;
      return response([{ text: eventFrame({ content: "原来的半截。" }) }, { afterFrame: 6, error: new TypeError("broken network read") }]);
    }
    return statusResponse(completedStatus("已经保存的完整回答。"));
  };
  const output = new Element("chat-reply-copy");
  const completion = await settle(context.fetchFollowUp("继续", [], output, new AbortController().signal, () => { firstContentCalls += 1; }, recoveryId));
  assert.equal(posts, 1); assert.equal(firstContentCalls, 1);
  assert.equal(context.outputText(output), "已经保存的完整回答。");
  assert.equal(completion.rounds, 3); assert.equal(context.state.followUpCount, 3);
});

test("a busy server is checked until this request completes without another model request", async () => {
  const { context, settle } = setup();
  let posts = 0, checks = 0;
  context.fetch = async (url) => {
    if (url === "/api/follow-up") { posts += 1; throw new TypeError("lost request connection"); }
    checks += 1;
    return statusResponse(checks === 1 ? conversationStatus({ busy: true }) : completedStatus());
  };
  const output = new Element("chat-reply-copy");
  await settle(context.fetchFollowUp("继续", [], output, new AbortController().signal, () => {}, recoveryId));
  assert.equal(posts, 1); assert.equal(checks, 2);
  assert.equal(context.outputText(output), "完整回应。"); assert.equal(context.state.followUpCount, 3);
});

test("received content prevents resending even before queued characters are visible", async () => {
  for (const waitForBusy of [false, true]) {
    const { context, response, settle } = setup();
    let posts = 0, checks = 0;
    context.fetch = async (url) => {
      if (url === "/api/follow-up") {
        posts += 1;
        return response([{ text: eventFrame({ content: "已收到的正文。" }) }, { error: new TypeError("immediate reset") }]);
      }
      checks += 1;
      return statusResponse(conversationStatus({ busy: waitForBusy && checks === 1 }));
    };
    await assert.rejects(settle(context.fetchFollowUp("继续", [], new Element("chat-reply-copy"), new AbortController().signal, () => {}, recoveryId)), /immediate reset/);
    assert.equal(posts, 1); assert.equal(checks, waitForBusy ? 2 : 1); assert.equal(context.state.followUpCount, 2);
  }
});

test("unknown states, other requests and unavailable status never allow an automatic post", async () => {
  const cases = [
    async () => { throw new TypeError("status connection failed"); },
    ...[401, 403, 404].map((status) => async () => ({ ok: false, status })),
    async () => statusResponse(completedStatus("相同文字的另一次回应。", { lastCompletedRequestId: "different-request" })),
    async () => statusResponse(completedStatus("回答。", { messages: [{ role: "user", text: "不同问题" }, { role: "assistant", text: "回答。" }] })),
    async () => statusResponse(completedStatus("回答。", { messages: [{ role: "user", text: "继续", images: ["data:image/png;base64,AQID"] }, { role: "assistant", text: "回答。" }] })),
    async () => statusResponse(conversationStatus({ lastCompletedRequestId: undefined })),
    async () => statusResponse(conversationStatus({ closed: true })),
  ];
  for (const status of cases) {
    const { context, settle } = setup();
    let posts = 0;
    context.fetch = async (url) => {
      if (url === "/api/follow-up") { posts += 1; throw new TypeError("first request reset"); }
      return status();
    };
    await assert.rejects(settle(context.fetchFollowUp("继续", [], new Element("chat-reply-copy"), new AbortController().signal, () => {}, recoveryId)), /first request reset/);
    assert.equal(posts, 1); assert.equal(context.state.followUpCount, 2);
  }
});

test("a second disconnection stops recovery without an endless reconnect loop", async () => {
  const { context, settle } = setup();
  let posts = 0, checks = 0;
  context.fetch = async (url) => {
    if (url === "/api/follow-up") { posts += 1; throw new TypeError("persistent reset"); }
    checks += 1; return statusResponse(conversationStatus());
  };
  await assert.rejects(settle(context.fetchFollowUp("继续", [], new Element("chat-reply-copy"), new AbortController().signal, () => {}, recoveryId)), /persistent reset/);
  assert.equal(posts, 2); assert.equal(checks, 2); assert.equal(context.state.followUpCount, 2);
});

test("a continuously busy server has a bounded recovery wait", async () => {
  const { context, settle, clock } = setup();
  let posts = 0, checks = 0;
  context.fetch = async (url) => {
    if (url === "/api/follow-up") { posts += 1; throw new TypeError("busy reset"); }
    checks += 1; return statusResponse(conversationStatus({ busy: true }));
  };
  await assert.rejects(settle(context.fetchFollowUp("继续", [], new Element("chat-reply-copy"), new AbortController().signal, () => {}, recoveryId)), /busy reset/);
  assert.equal(posts, 1); assert.equal(checks, 8); assert.ok(clock.time < 20000); assert.equal(clock.timers.size, 0);
});

test("pause cancels the recovery wait and the status request", async () => {
  for (const waitOnRequest of [false, true]) {
    const { context, settle } = setup();
    const controller = new AbortController();
    let posts = 0, statusSignal;
    context.fetch = async (url, options) => {
      if (url === "/api/follow-up") { posts += 1; throw new TypeError("reset before pause"); }
      statusSignal = options.signal;
      if (!waitOnRequest) return statusResponse(conversationStatus({ busy: true }));
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    };
    await assert.rejects(settle(context.fetchFollowUp("继续", [], new Element("chat-reply-copy"), controller.signal, () => {}, recoveryId), (frame) => {
      if (frame === 3) controller.abort();
    }), (error) => error.name === "AbortError");
    assert.equal(posts, 1); assert.equal(context.state.followUpCount, 2);
    if (waitOnRequest) assert.equal(statusSignal.aborted, true);
  }
});

test("changing account or reading during recovery cannot update the new state", async () => {
  for (const change of [
    (context) => { context.readingOwner = () => "account:another"; },
    (context) => { context.state.readingKey = "another-reading"; context.state.followUpCount = 0; },
    (context) => { context.state.conversationId = "another-conversation"; context.state.followUpCount = 0; },
  ]) {
    const { context, settle } = setup();
    const output = new Element("chat-reply-copy");
    let posts = 0;
    context.fetch = async (url) => {
      if (url === "/api/follow-up") { posts += 1; throw new TypeError("connection reset"); }
      change(context); return statusResponse(completedStatus());
    };
    await assert.rejects(settle(context.fetchFollowUp("继续", [], output, new AbortController().signal, () => {}, recoveryId)), (error) => error.name === "AbortError");
    assert.equal(posts, 1); assert.equal(context.outputText(output), ""); assert.notEqual(context.state.followUpCount, 3);
  }
});

test("explicit model errors and local rendering TypeErrors never trigger a reconnect", async () => {
  for (const localError of [false, true]) {
    const { context, response, settle } = setup();
    let requests = 0;
    context.fetch = async () => {
      requests += 1;
      return response([{ text: eventFrame(localError ? { content: "正文。" } : { error: "所选模型暂不可用。" }) }]);
    };
    if (localError) context.renderOutputText = () => { throw new TypeError("local DOM failure"); };
    await assert.rejects(settle(context.fetchFollowUp("继续", [], new Element("chat-reply-copy"), new AbortController().signal, () => {}, recoveryId)), localError ? /local DOM failure/ : /模型暂不可用/);
    assert.equal(requests, 1); assert.equal(context.state.followUpCount, 2);
  }
});

test("a cancelled fetch reported as TypeError still keeps pause semantics", async () => {
  const { context, settle } = setup();
  const controller = new AbortController();
  let requests = 0;
  context.fetch = async () => {
    requests += 1; controller.abort(); throw new TypeError("cancelled fetch");
  };
  await assert.rejects(settle(context.fetchFollowUp("继续", [], new Element("chat-reply-copy"), controller.signal, () => {}, recoveryId)), (error) => error.name === "AbortError");
  assert.equal(requests, 1); assert.equal(context.state.followUpCount, 2);
});
