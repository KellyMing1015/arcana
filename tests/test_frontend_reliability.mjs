// 不请求真实图片：模拟慢网与失败，确认预加载不会重复下载仍在途中的牌图。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const preloadSource = source.slice(source.indexOf("function loadCardImageAttempt("), source.indexOf("function handleCardImageError("));
const imageHelpers = runInNewContext(readFileSync(new URL("../cards.js", import.meta.url), "utf8").replace(/^export /gm, "") + "\n({cardImageURL, cardImageSrcSet, CARD_IMAGE_SIZES, cardFace})");

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
    ...imageHelpers,
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

test("候选预载与显示牌面使用相同响应尺寸，历史可选择较小图片", () => {
  const { preload, images } = setup();
  const card = { id: "fool", chinese: "愚者" };
  preload(card);
  const markup = imageHelpers.cardFace(card);
  assert.ok(markup.includes(`src="${images[0].src}"`));
  assert.ok(markup.includes(`srcset="${images[0].srcset}"`));
  assert.ok(markup.includes(`sizes="${images[0].sizes}"`));
  assert.match(images[0].srcset, /w=320 320w/);
  assert.match(images[0].srcset, /w=480 480w/);
  assert.match(images[0].srcset, /w=960 960w/);
  assert.equal(imageHelpers.cardImageURL({ id: '"<bad>' }, 0, 320), '/assets/cards/%22%3Cbad%3E.webp?v=3&w=320');
});

test("明确下载失败后重试，成功后复用解码结果", async () => {
  const { preload, images } = setup();
  const card = { id: "moon" };
  const result = preload(card);
  images[0].fail();
  await flush();
  assert.equal(images.length, 2);
  assert.equal(images[1].src, "/assets/cards/moon.webp?v=3&w=640&retry=1");
  assert.equal(images[1].srcset, imageHelpers.cardImageSrcSet(card, 1));
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
