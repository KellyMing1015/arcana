// 不请求真实图片：模拟慢网与失败，确认预加载不会重复下载仍在途中的牌图。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const preloadSource = source.slice(source.indexOf("function loadCardImageAttempt("), source.indexOf("function handleCardImageError("));

function setup() {
  const images = [];
  const timers = new Map();
  let nextTimer = 0;
  class Image {
    constructor() { images.push(this); }
    async decode() {}
    load() {
      this.complete = true;
      this.naturalWidth = 960;
      this.onload?.();
    }
    fail() { this.onerror?.(); }
  }
  const preload = runInNewContext(preloadSource + "\npreloadCardImage", {
    Image,
    cardImageURL: (card, attempt = 0) => `/assets/cards/${card.id}.webp?v=2${attempt ? `&retry=${attempt}` : ""}`,
    cardImageCache: new Map(),
    state: { selected: [] },
    CARD_IMAGE_RETRY_LIMIT: 2,
    setTimeout: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  return { preload, images, timers };
}

async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

test("慢图四秒后仍只有一次下载，再次预加载复用同一任务", async () => {
  const { preload, images, timers } = setup();
  const card = { id: "fool" };
  const result = preload(card);
  for (const { callback, delay } of [...timers.values()]) if (delay <= 4000) callback();
  await flush();
  assert.equal(images.length, 1);
  assert.equal(preload(card), result);
  images[0].load();
  assert.equal(await result, true);
  assert.equal(preload(card), result);
});

test("明确下载失败后重试，成功后复用解码结果", async () => {
  const { preload, images } = setup();
  const card = { id: "moon" };
  const result = preload(card);
  images[0].fail();
  await flush();
  assert.equal(images.length, 2);
  assert.equal(images[1].src, "/assets/cards/moon.webp?v=2&retry=1");
  images[1].load();
  assert.equal(await result, true);
  assert.equal(preload(card), result);
});

test("持续失败最多下载三次，失败缓存允许之后重新请求", async () => {
  const { preload, images } = setup();
  const card = { id: "star" };
  const result = preload(card);
  for (let attempt = 0; attempt < 3; attempt++) {
    images[attempt].fail();
    await flush();
  }
  assert.equal(await result, false);
  assert.equal(images.length, 3);
  const retry = preload(card);
  assert.equal(images.length, 4);
  images[3].load();
  assert.equal(await retry, true);
});
