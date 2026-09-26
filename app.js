import { DECK, cardFace, cardImageURL } from "./cards.js";
import { getActiveProvider, getUserInfo, initializeProviderSettings } from "./settings.js";
import { initializeAuth, isLoggedIn, saveCloudReading } from "./auth.js";

const app = document.querySelector("#app");
const state = {
  stage: "question",
  question: "",
  spread: 3,
  deck: [],
  selected: [],
  hoveredId: null,
  isOpening: false,
  isSelecting: false,
  isHolding: false,
  cutCount: 0,
  framework: null,
  conversationId: null,
  followUpCount: 0,
  initialProvider: null,
  initialReading: "",
  chatMessages: [],
  conversationClosed: false,
  userInfo: { enabled: false },
};
const labels = {
  1: ["此刻"],
  3: ["第1张", "第2张", "第3张"],
  10: ["现状", "交叉影响", "潜意识", "过去", "意识", "近期", "自我", "环境", "希望与恐惧", "可能走向"],
};
const threeCardFrameworks = {
  timeline: ["过去", "现在", "未来"],
  cause: ["问题", "原因", "建议"],
  outcome: ["现状", "阻碍", "结果"],
  relationship: ["对方想法", "感受", "行动"],
  choice: ["选择A", "选择B", "建议"],
  energy: ["整体能量", "关键影响", "建议"],
};
const timers = new Set();
let shuffleInterval = null;
let cutListeners = null;
let stageListeners = null;
let fanZones = [];
let fanOffset = 0;
let fanMotionFrame = null;
let activeReadingRequest = null;
let activeConversationRequest = null;
const cardImagePromises = new Map();

function later(callback, milliseconds) {
  const id = setTimeout(() => { timers.delete(id); callback(); }, milliseconds);
  timers.add(id);
  return id;
}

function pause(milliseconds) { return new Promise((resolve) => later(resolve, milliseconds)); }

function clearTimers() {
  for (const id of timers) clearTimeout(id);
  timers.clear();
  if (shuffleInterval) clearInterval(shuffleInterval);
  shuffleInterval = null;
  cutListeners?.abort();
  cutListeners = null;
  stageListeners?.abort();
  stageListeners = null;
  if (fanMotionFrame) cancelAnimationFrame(fanMotionFrame);
  fanMotionFrame = null;
  activeReadingRequest?.abort();
  activeReadingRequest = null;
  activeConversationRequest?.abort();
  activeConversationRequest = null;
  fanZones = [];
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function splitReadingSummary(value) {
  const text = String(value || "").trim();
  const match = text.match(/\s*(?:【\s*总结\s*】|总结)\s*[:：]?\s*([\s\S]+)$/);
  if (!match) return { reading: text, summary: "" };
  const rawSummary = match[1].trim();
  const characters = Array.from(rawSummary);
  let summary = rawSummary;
  if (characters.length > 100) {
    const firstHundred = characters.slice(0, 100).join("");
    const sentenceEnd = Math.max(firstHundred.lastIndexOf("。"), firstHundred.lastIndexOf("！"), firstHundred.lastIndexOf("？"));
    summary = sentenceEnd >= 20 ? firstHundred.slice(0, sentenceEnd + 1) : firstHundred;
  }
  return {
    reading: text.slice(0, match.index).trim(),
    summary,
  };
}

async function saveCompletedReading(summary, fullReading) {
  if (!isLoggedIn() || !state.userInfo?.enabled || !state.userInfo?.id) return false;
  const spreadLabel = state.spread === 1 ? "单牌" : state.spread === 3 ? "三牌阵" : "凯尔特十字";
  return saveCloudReading({
    profile_id: state.userInfo.id,
    profile_nickname: state.userInfo.nickname || "未命名用户",
    question: state.question,
    spread_type: spreadLabel,
    summary,
    full_reading: fullReading,
    cards: state.selected.map((card, index) => ({
      id: card.id,
      chinese: card.chinese,
      reversed: card.reversed,
      position: positionLabels()[index],
    })),
  });
}

function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function positionLabels() {
  return state.spread === 3 && state.framework ? threeCardFrameworks[state.framework] : labels[state.spread];
}

function go(stage) {
  clearTimers();
  state.stage = stage;
  document.body.classList.toggle("result-open", stage === "result");
  document.body.classList.toggle("conversation-open", stage === "conversation");
  render();
}

function backArt() {
  return `<span class="back-ornament" aria-hidden="true"><img src="/assets/ui/card-back-cream-magic-v3.png?v=5" width="1024" height="1536" alt="" decoding="async"></span>`;
}

function preloadCardImage(card) {
  if (cardImagePromises.has(card.id)) return cardImagePromises.get(card.id);
  const promise = new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const finish = (loaded) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!loaded) cardImagePromises.delete(card.id);
      resolve(loaded);
    };
    const timeout = setTimeout(() => finish(false), 6000);
    image.onload = () => (image.decode ? image.decode().catch(() => {}) : Promise.resolve()).finally(() => finish(true));
    image.onerror = () => finish(false);
    image.src = cardImageURL(card);
  });
  cardImagePromises.set(card.id, promise);
  return promise;
}

function renderQuestion() {
  app.innerHTML = `<section class="ritual-screen question-screen screen-enter">
    <div class="question-layout">
      <div class="question-inner">
        <span class="question-mark" aria-hidden="true"></span>
        <h1>此刻，你想问什么</h1>
        <form id="question-form" class="ritual-question-form">
          <label class="sr-only" for="question">想问的问题</label>
          <textarea id="question" class="question-center-input" rows="3" maxlength="220" aria-label="想问的问题" required>${escapeHTML(state.question)}</textarea>
          <fieldset class="ritual-spreads"><legend>选择牌阵</legend>
            <button type="button" data-spread="1" class="ritual-spread ${state.spread === 1 ? "active" : ""}" aria-pressed="${state.spread === 1}"><strong>单牌</strong></button>
            <button type="button" data-spread="3" class="ritual-spread ${state.spread === 3 ? "active" : ""}" aria-pressed="${state.spread === 3}"><strong>三牌阵</strong></button>
            <button type="button" data-spread="10" class="ritual-spread ${state.spread === 10 ? "active" : ""}" aria-pressed="${state.spread === 10}"><strong>凯尔特十字</strong></button>
          </fieldset>
          <button class="ritual-primary" type="submit">开始抽牌 <span class="button-spark" aria-hidden="true"></span></button>
        </form>
      </div>
      <div class="question-card-stage" aria-hidden="true">
        <span class="question-orbit orbit-one"></span>
        <span class="question-orbit orbit-two"></span>
        <div class="question-card-preview">${backArt()}</div>
        <span class="question-spark spark-one"></span>
        <span class="question-spark spark-two"></span>
      </div>
    </div>
  </section>`;

  const form = document.querySelector("#question-form");
  const input = document.querySelector("#question");
  document.querySelectorAll("[data-spread]").forEach((button) => button.addEventListener("click", () => {
    state.spread = Number(button.dataset.spread);
    document.querySelectorAll("[data-spread]").forEach((option) => {
      const active = option === button;
      option.classList.toggle("active", active);
      option.setAttribute("aria-pressed", String(active));
    });
  }));
  requestAnimationFrame(() => {
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const question = input.value.trim();
    if (!question) { input.focus(); return; }
    state.question = question;
    state.deck = shuffle(DECK.map((card) => ({ ...card, reversed: false })));
    state.selected = [];
    state.cutCount = 0;
    state.hoveredId = null;
    state.framework = null;
    state.conversationId = null;
    state.followUpCount = 0;
    state.initialProvider = null;
    state.initialReading = "";
    state.chatMessages = [];
    state.conversationClosed = false;
    state.userInfo = getUserInfo();
    go("shuffle");
  });
}

function renderShuffle() {
  state.isHolding = false;
  app.innerHTML = `<section class="ritual-screen shuffle-screen screen-enter">
    <div class="ritual-top"><button class="ritual-back" id="back-question">← 返回提问</button><span>01 / 04 — 洗牌</span></div>
    <div class="ritual-heading shuffle-heading"><h1>洗牌</h1><p class="shuffle-question"><em>“${escapeHTML(state.question)}”</em></p></div>
    <div class="shuffle-surface" id="shuffle-surface">
      <div class="shuffle-glow" aria-hidden="true"></div>
      <div class="shuffle-pile" id="shuffle-pile" tabindex="0" role="button" aria-label="按住牌面洗牌，松开牌面结束">${Array.from({ length: 14 }, (_, index) => `<div class="shuffle-card ${index % 4 === 1 ? "visually-reversed" : ""}" style="--stack-x:${(index - 7) * 1.1}px;--stack-y:${(7 - index) * 1.2}px;--tilt:${(index % 5 - 2) * .5}deg;--shuffle-delay:${-index * 67}ms">${backArt()}</div>`).join("")}</div>
    </div>
    <div class="ritual-instruction" id="shuffle-instruction"><span class="instruction-mark" aria-hidden="true"></span><strong>按住牌面洗牌</strong><small>松开牌面结束</small></div>
  </section>`;
  const screen = document.querySelector(".shuffle-screen");
  const preventSelection = (event) => event.preventDefault();
  screen.addEventListener("selectstart", preventSelection);
  screen.addEventListener("dragstart", preventSelection);
  document.querySelector("#back-question").addEventListener("click", () => go("question"));
  const pile = document.querySelector("#shuffle-pile");
  let holdTimer = null;
  let activePointer = null;
  let keyPending = false;

  function beginShuffle() {
    holdTimer = null;
    if (state.stage !== "shuffle" || state.isHolding) return;
    state.isHolding = true;
    pile.classList.remove("is-pressing");
    pile.classList.add("is-shuffling");
    document.querySelector("#shuffle-instruction").innerHTML = `<span class="instruction-mark" aria-hidden="true"></span><strong>正在洗牌…</strong><small>松开牌面结束</small>`;
    shuffleInterval = setInterval(() => {
      state.deck = shuffle(state.deck);
      const cards = pile.querySelectorAll(".shuffle-card");
      for (let i = 0; i < 3; i += 1) cards[Math.floor(Math.random() * cards.length)].classList.toggle("visually-reversed");
    }, 260);
  }
  function cancelPending() {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      timers.delete(holdTimer);
      holdTimer = null;
    }
    pile.classList.remove("is-pressing");
  }
  function finishShuffle() {
    if (!state.isHolding || state.stage !== "shuffle") return;
    state.isHolding = false;
    if (shuffleInterval) clearInterval(shuffleInterval);
    shuffleInterval = null;
    state.deck = shuffle(state.deck).map((card) => ({ ...card, reversed: Math.random() < .28 }));
    pile.classList.remove("is-shuffling");
    pile.classList.add("is-settling");
    document.querySelector("#shuffle-instruction").innerHTML = `<span class="instruction-mark" aria-hidden="true"></span><strong>洗牌完成</strong><small>牌正在收拢</small>`;
    later(() => go("cut"), 500);
  }
  pile.addEventListener("pointerdown", (event) => {
    if (activePointer || keyPending || state.isHolding || event.button !== 0 || !event.target.closest(".shuffle-card")) return;
    event.preventDefault();
    activePointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    pile.setPointerCapture(event.pointerId);
    pile.classList.add("is-pressing");
    holdTimer = later(beginShuffle, 300);
  });
  pile.addEventListener("pointermove", (event) => {
    if (holdTimer === null || activePointer?.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - activePointer.x, event.clientY - activePointer.y) > 24) cancelPending();
  });
  function releasePointer(event) {
    if (activePointer?.id !== event.pointerId) return;
    activePointer = null;
    if (holdTimer !== null) cancelPending();
    else finishShuffle();
  }
  pile.addEventListener("pointerup", releasePointer);
  pile.addEventListener("pointercancel", releasePointer);
  pile.addEventListener("contextmenu", (event) => event.preventDefault());
  pile.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || event.repeat || keyPending || activePointer || state.isHolding) return;
    event.preventDefault();
    keyPending = true;
    pile.classList.add("is-pressing");
    holdTimer = later(beginShuffle, 300);
  });
  pile.addEventListener("keyup", (event) => {
    if (event.code !== "Space" || !keyPending) return;
    event.preventDefault();
    keyPending = false;
    if (holdTimer !== null) cancelPending();
    else finishShuffle();
  });
}

function renderCut() {
  app.innerHTML = `<section class="ritual-screen cut-screen screen-enter">
    <div class="ritual-top"><button class="ritual-back" id="reshuffle-top">← 重新洗牌</button><span>02 / 04 — 切牌</span></div>
    <div class="ritual-heading"><h1>切牌</h1><p id="cut-description">左右滑动可以切牌，也可以直接完成。</p></div>
    <div class="cut-stage"><div class="cut-halo" aria-hidden="true"></div><div class="cut-pile" id="cut-pile" role="button" tabindex="0" aria-label="向左或向右拖动切牌，键盘可用左右方向键切牌"><div class="cut-half cut-bottom">${backArt()}</div><div class="cut-half cut-top">${backArt()}</div></div></div>
    <div class="cut-actions"><button class="ritual-primary cut-button" type="button" id="cut-done">完成</button><button class="ritual-secondary" type="button" id="reshuffle">重新洗牌</button></div>
    <p class="cut-count" id="cut-count">尚未切牌</p>
  </section>`;
  document.querySelector("#reshuffle-top").addEventListener("click", () => go("shuffle"));
  document.querySelector("#reshuffle").addEventListener("click", () => go("shuffle"));
  const pile = document.querySelector("#cut-pile");
  const done = document.querySelector("#cut-done");
  const controller = new AbortController();
  cutListeners = controller;
  const options = { signal: controller.signal };
  let gesture = null;
  let lastTouch = 0;
  let cutting = false;

  function finishCut(direction, releaseX) {
    if (cutting) return;
    cutting = true;
    const position = 1 + Math.floor(Math.random() * 77);
    state.deck = [...state.deck.slice(position), ...state.deck.slice(0, position)];
    state.cutCount += 1;
    pile.style.setProperty("--release-x", `${releaseX}px`);
    pile.style.setProperty("--cut-x", `${direction * 190}px`);
    pile.style.setProperty("--cut-tilt", `${direction * 4}deg`);
    pile.style.setProperty("--drag-x", "0px");
    pile.classList.add("is-cutting");
    document.querySelector("#cut-count").textContent = `已切 ${state.cutCount} 次`;
    later(() => {
      if (state.stage !== "cut") return;
      pile.classList.remove("is-cutting");
      cutting = false;
      done.hidden = false;
      document.querySelector("#cut-description").textContent = "切牌完成。可以继续滑动，或点击完成开始抽牌。";
    }, 1000);
  }

  function start(x, y, kind, identifier = null) {
    if (cutting || gesture || state.stage !== "cut") return;
    gesture = { x, y, kind, identifier, dx: 0, horizontal: false };
    pile.classList.add("is-dragging");
  }
  function move(x, y) {
    if (!gesture || cutting) return;
    const dx = x - gesture.x;
    const dy = y - gesture.y;
    if (!gesture.horizontal && Math.abs(dy) > Math.abs(dx) + 12) return;
    gesture.horizontal = true;
    gesture.dx = Math.max(-180, Math.min(180, dx));
    pile.style.setProperty("--drag-x", `${gesture.dx}px`);
  }
  function end(cancelled = false) {
    if (!gesture) return;
    const dx = gesture.dx;
    gesture = null;
    pile.classList.remove("is-dragging");
    if (!cancelled && Math.abs(dx) >= 48) {
      finishCut(Math.sign(dx), dx);
    } else {
      pile.style.setProperty("--drag-x", "0px");
    }
  }

  pile.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) return;
    lastTouch = Date.now();
    const touch = event.changedTouches[0];
    start(touch.clientX, touch.clientY, "touch", touch.identifier);
  }, options);
  pile.addEventListener("touchmove", (event) => {
    if (gesture?.kind !== "touch") return;
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === gesture.identifier);
    if (!touch) return;
    if (Math.abs(touch.clientX - gesture.x) > Math.abs(touch.clientY - gesture.y)) event.preventDefault();
    move(touch.clientX, touch.clientY);
  }, { ...options, passive: false });
  pile.addEventListener("touchend", (event) => {
    if (gesture?.kind !== "touch") return;
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === gesture.identifier);
    if (touch) { move(touch.clientX, touch.clientY); end(); }
  }, options);
  pile.addEventListener("touchcancel", () => end(true), options);

  pile.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || Date.now() - lastTouch < 700) return;
    event.preventDefault();
    start(event.clientX, event.clientY, "mouse");
  }, options);
  window.addEventListener("mousemove", (event) => { if (gesture?.kind === "mouse") move(event.clientX, event.clientY); }, options);
  window.addEventListener("mouseup", (event) => {
    if (gesture?.kind !== "mouse") return;
    move(event.clientX, event.clientY);
    end();
  }, options);
  window.addEventListener("blur", () => end(true), options);
  pile.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    finishCut(event.key === "ArrowLeft" ? -1 : 1, 0);
  }, options);
  done.addEventListener("click", () => { if (!cutting) go("fan"); }, options);
}

function fanBack(card) {
  return `<div class="fan-card" data-card-id="${card.id}" aria-hidden="true"><div class="fan-card-inner">${backArt()}</div></div>`;
}

function renderFan() {
  state.isOpening = true;
  state.isSelecting = false;
  state.hoveredId = null;
  fanOffset = 0;
  app.innerHTML = `<section class="ritual-screen fan-screen fan-spread-${state.spread} screen-enter">
    <div class="ritual-top"><span>03 / 04 — 选牌</span><span>ARCANA · ${state.spread === 1 ? "单牌" : state.spread === 3 ? "三牌阵" : "凯尔特十字"}</span></div>
    <div class="selection-tray selection-tray-${state.spread}" id="selection-tray">${positionLabels().map((label, index) => `<div class="tray-item"><div class="tray-slot" id="selection-slot-${index}"><span>${String(index + 1).padStart(2, "0")}</span></div><small>${label}</small></div>`).join("")}</div>
    <div class="fan-status"><strong id="fan-selection-count">左右滑动选牌</strong><span class="sr-only" id="fan-instruction">左右滑动牌堆，点击一张牌</span></div>
    <div class="fan-area" id="fan-area" tabindex="0" role="group" aria-label="横向弧形塔罗牌堆。左右滑动浏览，点击一次让牌浮起，再点击同一张确认选择。键盘可用左右方向键浏览、回车确认。">
      <div class="fan-arc-glow" aria-hidden="true"></div>
      ${state.deck.map(fanBack).join("")}
    </div>
  </section>`;
  const area = document.querySelector("#fan-area");
  requestAnimationFrame(() => requestAnimationFrame(() => layoutFan(true)));
  later(() => {
    if (state.stage !== "fan") return;
    state.isOpening = false;
    area.classList.add("is-ready");
    document.querySelector("#fan-instruction").textContent = "左右滑动 · 点一次亮起 · 再点一次确认";
    area.querySelectorAll(".fan-card").forEach((element) => { element.style.transitionDelay = "0ms"; });
  }, 760);

  function stopMotion() {
    if (fanMotionFrame) cancelAnimationFrame(fanMotionFrame);
    fanMotionFrame = null;
    area.classList.remove("is-coasting");
  }

  function beginCoast(initialVelocity) {
    stopMotion();
    let velocity = initialVelocity;
    let previous = performance.now();
    area.classList.add("is-coasting");
    const tick = (now) => {
      if (state.stage !== "fan" || state.isSelecting) { stopMotion(); return; }
      const elapsed = Math.min(34, now - previous);
      previous = now;
      fanOffset = wrapFanOffset(fanOffset + velocity * elapsed, getRemaining().length);
      velocity *= Math.pow(.94, elapsed / 16.67);
      layoutFan(false);
      if (Math.abs(velocity) < .00045) { stopMotion(); return; }
      fanMotionFrame = requestAnimationFrame(tick);
    };
    fanMotionFrame = requestAnimationFrame(tick);
  }

  let gesture = null;
  area.addEventListener("pointerdown", (event) => {
    if (state.isOpening || state.isSelecting || event.button !== 0) return;
    event.preventDefault();
    stopMotion();
    const now = performance.now();
    const pressedCard = cardAtPoint(event.clientX, event.clientY, true);
    gesture = {
      id: event.pointerId,
      pointerType: event.pointerType,
      pressedCardId: pressedCard?.id || null,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      startOffset: fanOffset,
      lastTime: now,
      velocity: 0,
      moved: false,
    };
    area.setPointerCapture(event.pointerId);
    area.classList.add("is-dragging");
  });
  area.addEventListener("pointermove", (event) => {
    if (!gesture || gesture.id !== event.pointerId || state.isSelecting) return;
    const metrics = fanMetrics();
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    const tapTolerance = gesture.pointerType === "touch" ? 14 : gesture.pointerType === "pen" ? 10 : 6;
    if (!gesture.moved && Math.hypot(dx, dy) < tapTolerance) return;
    gesture.moved = true;
    setHover(null);
    const now = performance.now();
    const elapsed = Math.max(1, now - gesture.lastTime);
    const instantVelocity = -((event.clientX - gesture.lastX) / metrics.pixelsPerCard) / elapsed;
    gesture.velocity = gesture.velocity * .62 + instantVelocity * .38;
    gesture.lastX = event.clientX;
    gesture.lastTime = now;
    fanOffset = wrapFanOffset(gesture.startOffset - dx / metrics.pixelsPerCard, getRemaining().length);
    layoutFan(false);
  });
  area.addEventListener("pointerup", (event) => {
    if (!gesture || gesture.id !== event.pointerId || state.isSelecting) return;
    const completed = gesture;
    gesture = null;
    area.classList.remove("is-dragging");
    if (completed.moved) {
      beginCoast(completed.velocity);
      return;
    }
    // 以按下时命中的牌为准，避免手指在松开时轻微偏移造成第二次点击失效。
    const card = completed.pressedCardId
      ? getRemaining().find((item) => item.id === completed.pressedCardId)
      : cardAtPoint(event.clientX, event.clientY, true);
    if (!card) { setHover(null); return; }
    if (state.hoveredId === card.id) {
      selectCard(card);
    } else {
      setHover(card.id);
      document.querySelector("#fan-instruction").textContent = "再次点击这张牌，确认选择";
    }
  });
  area.addEventListener("pointercancel", (event) => {
    if (!gesture || gesture.id !== event.pointerId) return;
    gesture = null;
    area.classList.remove("is-dragging");
  });
  area.addEventListener("wheel", (event) => {
    if (state.isOpening || state.isSelecting || Math.abs(event.deltaX) < Math.abs(event.deltaY) * .6) return;
    event.preventDefault();
    stopMotion();
    fanOffset = wrapFanOffset(fanOffset + event.deltaX / fanMetrics().pixelsPerCard, getRemaining().length);
    setHover(null);
    layoutFan(false);
  }, { passive: false });
  area.addEventListener("keydown", (event) => {
    if (state.isOpening || state.isSelecting) return;
    const remaining = getRemaining();
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? 1 : -1;
      fanOffset = wrapFanOffset(Math.round(fanOffset) + delta, remaining.length);
      layoutFan(false);
      setHover(remaining[Math.round(fanOffset) % remaining.length].id);
    }
    if ((event.key === "Enter" || event.key === " ") && state.hoveredId) {
      event.preventDefault();
      selectCard(remaining.find((card) => card.id === state.hoveredId));
    }
  });
  window.addEventListener("resize", onFanResize);
}

function onFanResize() { if (state.stage === "fan") layoutFan(false); }
function getRemaining() { const chosen = new Set(state.selected.map((card) => card.id)); return state.deck.filter((card) => !chosen.has(card.id)); }
function wrapFanOffset(value, length) {
  if (!length) return 0;
  return ((value % length) + length) % length;
}

function fanMetrics() {
  const area = document.querySelector("#fan-area");
  const width = area.clientWidth;
  const height = area.clientHeight;
  const compact = width < 560;
  const radius = compact ? Math.max(355, width * 1.02) : Math.max(500, Math.min(700, width * .58));
  const cardWidth = compact ? 132 : 165;
  // 相邻牌只错开 13% 的牌宽，保持约 87% 重叠，彻底压住蝴蝶结碎边。
  const stepAngle = cardWidth * .13 / radius;
  return {
    area,
    width,
    height,
    radius,
    stepAngle,
    // 可见数量随屏幕宽度自然增加，让 87% 重叠的牌扇仍铺满左右两侧。
    maxAngle: compact ? .72 : .78,
    pixelsPerCard: radius * stepAngle,
    cx: width / 2,
    cy: 0,
    // 移动端牌堆仍位于页面下半区，但圆心不能过低，否则卡牌下半截会被视窗裁掉。
    centerY: compact ? Math.max(145, height * .3) : Math.max(195, height * .36),
  };
}

function layoutFan(opening) {
  const remaining = getRemaining();
  if (!remaining.length) return;
  fanOffset = wrapFanOffset(fanOffset, remaining.length);
  const { area, radius, stepAngle, maxAngle, centerY } = fanMetrics();
  fanZones = remaining.map((card, index) => {
    const element = area.querySelector(`[data-card-id="${card.id}"]`);
    let relative = index - fanOffset;
    if (relative > remaining.length / 2) relative -= remaining.length;
    if (relative < -remaining.length / 2) relative += remaining.length;
    const radians = relative * stepAngle;
    const visible = Math.abs(radians) <= maxAngle + stepAngle * 1.5;
    const x = Math.sin(radians) * radius;
    const y = centerY + (1 - Math.cos(radians)) * radius;
    const rotation = radians * 180 / Math.PI + (card.reversed ? 180 : 0);
    element.dataset.rotation = String(rotation);
    element.style.transitionDelay = opening && visible ? `${Math.min(250, Math.abs(relative) * 15)}ms` : "0ms";
    return { card, element, index, relative, visible, radians, rotation, rotationSin: Math.sin(rotation * Math.PI / 180), rotationCos: Math.cos(rotation * Math.PI / 180), baseX: x, baseY: y, width: element.offsetWidth, height: element.offsetHeight };
  });
  applyFanFocus();
}

function cardAtPoint(clientX, clientY, preferHovered = false) {
  if (!fanZones.length) return null;
  const { area, cx } = fanMetrics();
  const bounds = area.getBoundingClientRect();
  const x = clientX - bounds.left - cx;
  const y = clientY - bounds.top;
  let topmost = null;
  let topmostOrder = -Infinity;
  for (const zone of fanZones) {
    if (!zone.visible) continue;
    const dx = x - zone.x;
    const dy = y - zone.y;
    const localX = dx * zone.rotationCos + dy * zone.rotationSin;
    const localY = -dx * zone.rotationSin + dy * zone.rotationCos;
    // 已经凸起的牌扩大少量命中容差，边框和四角也能稳定响应触碰。
    const margin = preferHovered && zone.card.id === state.hoveredId ? 12 : 3;
    if (Math.abs(localX) > zone.width * zone.scale / 2 + margin || Math.abs(localY) > zone.height * zone.scale / 2 + margin) continue;
    if (preferHovered && zone.card.id === state.hoveredId) return zone.card;
    // 多张牌的矩形会重叠；命中视觉层级最高的那张，才等于鼠标点到的可见边缘。
    if (zone.relative > topmostOrder) { topmost = zone.card; topmostOrder = zone.relative; }
  }
  return topmost;
}

function applyFanFocus() {
  const focusLift = fanMetrics().width < 560 ? 30 : 48;
  for (const zone of fanZones) {
    const isFocused = zone.visible && zone.card.id === state.hoveredId;
    zone.x = zone.baseX;
    zone.y = zone.baseY - (isFocused ? focusLift : 0);
    zone.scale = isFocused ? 1.1 : 1;
    zone.element.classList.toggle("is-hovered", isFocused);
    zone.element.style.opacity = zone.visible ? "1" : "0";
    zone.element.style.visibility = zone.visible ? "visible" : "hidden";
    // 牌从左到右依次压住前一张，避免中间牌因为层级最高而完整露出。
    zone.element.style.zIndex = isFocused ? "300" : String(Math.max(1, 120 + Math.round(zone.relative)));
    zone.element.style.transform = `translate(-50%, -50%) translate(${zone.x}px, ${zone.y}px) rotate(${zone.rotation}deg) scale(${zone.scale})`;
  }
}

function setHover(id) {
  if (state.hoveredId === id) return;
  state.hoveredId = id;
  if (id) {
    const card = state.deck.find((item) => item.id === id);
    if (card) preloadCardImage(card);
  }
  applyFanFocus();
}

async function selectCard(card) {
  if (!card || state.isSelecting || state.stage !== "fan") return;
  state.isSelecting = true;
  await preloadCardImage(card);
  if (state.stage !== "fan") return;
  const index = state.selected.length;
  const element = document.querySelector(`[data-card-id="${card.id}"]`);
  const tray = document.querySelector("#selection-tray");
  const slot = document.querySelector(`#selection-slot-${index}`);
  tray.scrollLeft = slot.offsetLeft - tray.clientWidth / 2 + slot.clientWidth / 2;
  await pause(100);
  const source = element.getBoundingClientRect();
  const target = slot.getBoundingClientRect();
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  const startX = source.left + source.width / 2 - width / 2;
  const startY = source.top + source.height / 2 - height / 2;
  const dx = target.left + target.width / 2 - (startX + width / 2);
  const dy = target.top + target.height / 2 - (startY + height / 2);
  const scale = target.width / width;
  const flight = document.createElement("div");
  flight.className = "flight-card";
  flight.style.cssText = `left:${startX}px;top:${startY}px;width:${width}px;height:${height}px;--start-rot:${element.dataset.rotation}deg;--mid-x:${dx * .52}px;--mid-y:${dy * .52 - 72}px;--end-x:${dx}px;--end-y:${dy}px;--target-scale:${scale};`;
  flight.innerHTML = `<div class="flight-inner"><div class="flight-back">${backArt()}</div><div class="flight-face">${cardFace(card)}</div></div>`;
  document.body.append(flight);
  element.style.opacity = "0";
  flight.classList.add("is-lifting");
  await pause(210);
  flight.classList.add("is-flipped");
  await pause(600);
  flight.classList.add("is-flying");
  await pause(680);
  flight.remove();
  state.selected.push(card);
  element.remove();
  slot.classList.add("is-filled");
  slot.innerHTML = `<div class="tray-face" style="transform:rotate(${card.reversed ? 180 : 0}deg)">${cardFace(card)}</div>`;
  state.hoveredId = null;
  layoutFan(false);
  document.querySelector("#fan-selection-count").textContent = `已选 ${state.selected.length} / ${state.spread} 张`;
  document.querySelector("#fan-instruction").textContent = state.selected.length < state.spread ? "左右滑动 · 点一次亮起 · 再点一次确认" : "牌阵正在形成…";
  if (state.selected.length === state.spread) {
    const area = document.querySelector("#fan-area");
    if (fanMotionFrame) cancelAnimationFrame(fanMotionFrame);
    fanMotionFrame = null;
    area.classList.add("fan-dismissing");
    await pause(450);
    window.removeEventListener("resize", onFanResize);
    go("result");
  } else {
    state.isSelecting = false;
  }
}

function resultCard(card, index) {
  const crossed = state.spread === 10 && index === 1;
  const rotation = (card.reversed ? 180 : 0) + (crossed ? 90 : 0);
  return `<article class="result-card result-card-${index + 1}" style="--card-rotation:${rotation}deg;--reveal-delay:${index * 70}ms">
    <div class="result-card-visual">${cardFace(card)}</div>
    <div class="result-card-label"><span>${positionLabels()[index]}</span><strong>${card.chinese}</strong><small>${card.reversed ? "逆位" : "正位"}</small></div>
  </article>`;
}

function createReadingOutput(actions) {
  const output = document.createElement("section");
  output.id = "reading-output";
  output.className = "reading-output";
  output.setAttribute("role", "region");
  output.setAttribute("aria-label", "塔罗解读");
  actions.before(output);
  return output;
}

async function streamToOutput(response, output, onPayload = () => {}, onFirstContent = () => {}, signal = null, hiddenMarker = "") {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `请求失败（${response.status}）。`);
  }
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error("接口没有返回可读取的文字流。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let received = "";
  let rendered = "";
  let scheduledVisible = "";
  let done = false;
  let typing = false;
  let failed = false;
  let hasContent = false;
  const characters = [];
  let resolveTyping;
  let typingResolved = false;
  const typingFinished = new Promise((resolve) => { resolveTyping = resolve; });
  const finishTyping = () => {
    if (typingResolved) return;
    typingResolved = true;
    resolveTyping();
  };
  const stopReading = () => {
    failed = true;
    characters.length = 0;
    reader.cancel().catch(() => {});
    finishTyping();
  };
  signal?.addEventListener("abort", stopReading, { once: true });

  function typeNext() {
    if (failed) return;
    if (characters.length) {
      rendered += characters.shift();
      output.textContent = rendered;
      if (output.classList.contains("reading-output")) output.scrollTop = output.scrollHeight;
      const messages = output.closest(".conversation-messages");
      if (messages) messages.scrollTop = messages.scrollHeight;
      requestAnimationFrame(typeNext);
    } else {
      typing = false;
      if (done) finishTyping();
    }
  }
  function markerPrefixLength(text) {
    if (!hiddenMarker) return 0;
    for (let length = Math.min(hiddenMarker.length - 1, text.length); length > 0; length -= 1) {
      if (text.endsWith(hiddenMarker.slice(0, length))) return length;
    }
    return 0;
  }
  function queueText(text, isFinal = false) {
    received += text;
    let visibleTarget = received;
    if (hiddenMarker) {
      const markerIndex = received.indexOf(hiddenMarker);
      if (markerIndex !== -1) {
        visibleTarget = received.slice(0, markerIndex);
      } else if (!isFinal) {
        visibleTarget = received.slice(0, received.length - markerPrefixLength(received));
      }
    }
    const addition = visibleTarget.slice(scheduledVisible.length);
    scheduledVisible = visibleTarget;
    if (!hasContent && addition) {
      hasContent = true;
      onFirstContent();
    }
    characters.push(...addition);
    if (!typing) {
      typing = true;
      requestAnimationFrame(typeNext);
    }
  }
  function readEvent(frame) {
    const data = frame.split("\n").filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    let payload;
    try { payload = JSON.parse(data); }
    catch { throw new Error("解读流的数据格式不正确。"); }
    if (payload.error) throw new Error(payload.error);
    onPayload(payload);
    if (typeof payload.content === "string") queueText(payload.content);
    if (payload.done === true) {
      queueText("", true);
      done = true;
      if (!typing && !characters.length) finishTyping();
    }
  }
  function consumeBuffer() {
    buffer = buffer.replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      readEvent(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
  }

  try {
    while (true) {
      const { value, done: streamEnded } = await reader.read();
      if (streamEnded) break;
      buffer += decoder.decode(value, { stream: true });
      consumeBuffer();
    }
    buffer += decoder.decode();
    consumeBuffer();
    if (buffer.trim()) readEvent(buffer);
    if (signal?.aborted) throw new DOMException("回应已暂停。", "AbortError");
    if (!done) throw new Error("解读连接提前结束，请重试。");
    await typingFinished;
    return received;
  } catch (error) {
    failed = true;
    characters.length = 0;
    output.textContent = rendered;
    if (signal?.aborted && error?.name !== "AbortError") throw new DOMException("回应已暂停。", "AbortError");
    throw error;
  } finally {
    signal?.removeEventListener("abort", stopReading);
    reader.releaseLock();
  }
}

async function fetchReading(output, onFirstContent, signal) {
  const provider = state.initialProvider;
  const response = await fetch("/api/reading", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: state.question,
      spread: state.spread,
      cards: state.selected.map((card, index) => ({
        id: card.id,
        name: `${card.chinese}（${card.english}）`,
        position: positionLabels()[index],
        reversed: card.reversed,
      })),
      userInfo: state.userInfo,
      recordHistory: isLoggedIn() && Boolean(state.userInfo?.enabled && state.userInfo?.id),
      ...(provider ? { provider } : {}),
    }),
    signal,
  });
  const reading = await streamToOutput(response, output, (payload) => {
    if (payload.conversationId) state.conversationId = payload.conversationId;
    if (payload.framework && state.spread === 3) {
      if (!threeCardFrameworks[payload.framework]) throw new Error("模型返回了无法识别的三牌框架。");
      state.framework = payload.framework;
      document.querySelectorAll(".result-card-label > span").forEach((element, index) => {
        element.textContent = threeCardFrameworks[payload.framework][index];
      });
    }
  }, onFirstContent, signal, isLoggedIn() ? "【总结】" : "");
  if (!state.conversationId) throw new Error("解读服务没有建立对话，请重新解读。");
  return reading;
}

async function fetchFollowUp(message, images, output, signal, onFirstContent) {
  const provider = getActiveProvider();
  let completion = null;
  const response = await fetch("/api/follow-up", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationId: state.conversationId,
      message,
      images,
      ...(provider ? { provider } : {}),
    }),
    signal,
  });
  await streamToOutput(response, output, (payload) => {
    if (payload.done) completion = payload;
  }, onFirstContent, signal);
  if (!completion) throw new Error("追问连接提前结束，请再试一次。");
  state.followUpCount = completion.rounds;
  return completion;
}

function safeLocalImage(value) {
  return typeof value === "string" && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : "";
}

function conversationBubble(message) {
  const user = message.role === "user";
  const errorClass = message.error ? " is-error" : "";
  const stoppedClass = message.stopped ? " is-stopped" : "";
  const attachments = Array.isArray(message.images)
    ? `<div class="chat-attachments">${message.images.map((image) => safeLocalImage(image)).filter(Boolean).map((image) => `<img src="${escapeHTML(image)}" alt="本轮上传的图片">`).join("")}</div>`
    : "";
  const copy = message.loading
    ? `<p class="chat-bubble-copy"><span class="typing-dots" aria-label="塔罗师正在回应"><i></i><i></i><i></i></span></p>`
    : message.text ? `<p class="chat-bubble-copy">${escapeHTML(message.text)}</p>` : "";
  const body = `<div class="chat-message-body"><small>${user ? "你" : "塔罗师"}</small><div class="chat-bubble">${attachments}${copy}</div></div>`;
  return `<article class="conversation-message ${user ? "conversation-user" : "conversation-reader"}${errorClass}${stoppedClass}">${body}</article>`;
}

function drawerCard(card, index) {
  return `<article class="drawer-card">
    <div class="drawer-card-face" style="--drawer-rotation:${card.reversed ? 180 : 0}deg">${cardFace(card)}</div>
    <span>${escapeHTML(positionLabels()[index])}</span><strong>${escapeHTML(card.chinese)}</strong><small>${card.reversed ? "逆位" : "正位"}</small>
  </article>`;
}

function readingDrawerHTML() {
  return `<div class="reading-drawer-backdrop" id="reading-drawer" hidden>
    <aside class="reading-drawer-panel" role="dialog" aria-modal="true" aria-labelledby="reading-drawer-title">
      <header class="reading-drawer-header"><div><h2 id="reading-drawer-title">牌面与解读</h2></div><button id="close-reading-drawer" type="button" aria-label="关闭牌面与解读">关闭</button></header>
      <div class="reading-drawer-content">
        <section class="drawer-question"><small>你的问题</small><p>“${escapeHTML(state.question)}”</p></section>
        <section class="drawer-cards drawer-cards-${state.spread}" aria-label="本次牌面">${state.selected.map(drawerCard).join("")}</section>
        <section class="drawer-reading"><small>完整解读</small><p>${escapeHTML(state.initialReading)}</p></section>
      </div>
    </aside>
  </div>`;
}

function appendConversationMessage(messages, message) {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = conversationBubble(message);
  const element = wrapper.firstElementChild;
  messages.append(element);
  messages.scrollTop = messages.scrollHeight;
  return element.querySelector(".chat-bubble-copy");
}

function blobAsDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("图片读取失败，请重新选择。"));
    reader.readAsDataURL(blob);
  });
}

async function prepareLocalImage(file) {
  const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
  if (!allowed.has(file.type)) throw new Error("只支持 JPG、PNG 或 WebP 图片。");
  if (file.size > 15 * 1024 * 1024) throw new Error("这张图片太大，请选择 15MB 以内的图片。");
  const bitmap = await createImageBitmap(file);
  const maxSide = 1280;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const encode = (quality) => new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  let blob = await encode(.82);
  if (blob?.size > 1150 * 1024) blob = await encode(.6);
  if (!blob || blob.size > 1300 * 1024) throw new Error("压缩后图片仍然太大，请换一张尺寸更小的图片。");
  return blobAsDataURL(blob);
}

function bindConversationForm(screen) {
  const form = screen.querySelector("#follow-up-form");
  const input = form.querySelector("#follow-up-input");
  const button = form.querySelector(".send-follow-up");
  const stopButton = form.querySelector("#stop-follow-up");
  const endButton = form.querySelector("#end-conversation");
  const imageInput = form.querySelector("#follow-up-images");
  const imageButton = form.querySelector(".image-upload-button");
  const imagePreview = form.querySelector("#follow-up-image-preview");
  const status = screen.querySelector("#follow-up-status");
  const messages = screen.querySelector("#conversation-messages");
  let selectedImages = [];

  function renderImagePreview() {
    imagePreview.hidden = !selectedImages.length;
    imagePreview.innerHTML = selectedImages.map((image, index) => `<span><img src="${escapeHTML(image.dataUrl)}" alt="${escapeHTML(image.name)}"><button type="button" data-remove-image="${index}" aria-label="移除${escapeHTML(image.name)}">×</button></span>`).join("");
    imagePreview.querySelectorAll("[data-remove-image]").forEach((remove) => remove.addEventListener("click", () => {
      selectedImages.splice(Number(remove.dataset.removeImage), 1);
      renderImagePreview();
    }));
  }

  imageInput.addEventListener("change", async () => {
    const files = [...imageInput.files];
    imageInput.value = "";
    if (!files.length) return;
    if (selectedImages.length + files.length > 3) {
      status.textContent = "每次最多上传 3 张图片。";
      return;
    }
    imageButton.classList.add("is-processing");
    status.textContent = "正在准备图片…";
    try {
      for (const file of files) {
        selectedImages.push({ name: file.name, dataUrl: await prepareLocalImage(file) });
      }
      renderImagePreview();
      status.textContent = "图片已准备好，会随下一条消息发送。";
    } catch (error) {
      status.textContent = error.message || "图片处理失败，请重新选择。";
    } finally {
      imageButton.classList.remove("is-processing");
    }
  });

  stopButton.addEventListener("click", () => activeConversationRequest?.abort());
  endButton.addEventListener("click", async () => {
    input.disabled = true;
    button.disabled = true;
    endButton.disabled = true;
    imageInput.disabled = true;
    status.textContent = "正在结束这次对话…";
    try {
      await fetch("/api/conversation/end", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: state.conversationId }),
      });
    } catch {
      // Even if the local service is gone, the visible conversation still closes.
    } finally {
      state.conversationId = null;
      state.conversationClosed = true;
      const closing = { role: "assistant", text: "这次牌已经收好。剩下的答案，要交给你接下来的选择。" };
      state.chatMessages.push(closing);
      appendConversationMessage(messages, closing);
      form.classList.add("is-closed");
      input.placeholder = "这次对话已经结束";
      imageInput.disabled = true;
      status.textContent = "这次牌已经收好。想聊新的议题时，可以重新抽牌。";
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = input.value.trim();
    const images = selectedImages.map((image) => image.dataUrl);
    if ((!message && !images.length) || state.followUpCount >= 8 || state.conversationClosed || activeConversationRequest) { input.focus(); return; }
    input.value = "";
    selectedImages = [];
    renderImagePreview();
    input.disabled = true;
    button.disabled = true;
    button.hidden = true;
    stopButton.hidden = false;
    endButton.disabled = true;
    imageInput.disabled = true;
    status.textContent = "塔罗师正在回应...";
    const userRecord = { role: "user", text: message || "发送了图片", images };
    const answerRecord = { role: "assistant", text: "" };
    state.chatMessages.push(userRecord, answerRecord);
    appendConversationMessage(messages, userRecord);
    const answerText = appendConversationMessage(messages, { role: "assistant", text: "", loading: true });
    const controller = new AbortController();
    activeConversationRequest = controller;
    try {
      const completion = await fetchFollowUp(message, images, answerText, controller.signal, () => { answerText.textContent = ""; });
      answerRecord.text = answerText.textContent;
      const remaining = Math.max(0, 8 - state.followUpCount);
      screen.querySelector("#follow-up-count").textContent = remaining ? `还可以追问 ${remaining} 轮` : "本次牌局已完成 8 轮追问";
      if (completion.closed) {
        state.conversationClosed = true;
        input.disabled = true;
        input.placeholder = "这次牌局已经收牌";
        button.disabled = true;
        endButton.disabled = true;
        status.textContent = "这次对话已经完整结束。想问新的议题时，可以重新抽牌。";
        form.classList.add("is-closed");
        return;
      }
      status.textContent = "";
    } catch (error) {
      const bubble = answerText.closest(".conversation-message");
      if (error?.name === "AbortError") {
        answerText.textContent = answerText.textContent.trim() || "回应已暂停。";
        answerRecord.text = answerText.textContent;
        answerRecord.stopped = true;
        bubble.classList.add("is-stopped");
        status.textContent = "已暂停。这轮不会计入次数，你可以重新输入。";
      } else {
        bubble.classList.add("is-error");
        answerText.textContent = error instanceof TypeError ? "暂时无法连接解读服务，请确认 Flask 已启动。" : (error.message || "回应失败，请稍后再试。");
        answerRecord.text = answerText.textContent;
        answerRecord.error = true;
        status.textContent = "这轮没有计入次数，你可以修改后重新发送。";
        input.value = message;
        selectedImages = images.map((dataUrl, index) => ({ name: `图片 ${index + 1}`, dataUrl }));
        renderImagePreview();
      }
    } finally {
      if (activeConversationRequest === controller) activeConversationRequest = null;
      stopButton.hidden = true;
      button.hidden = false;
      if (!state.conversationClosed && state.followUpCount < 8) {
        input.disabled = false;
        button.disabled = false;
        endButton.disabled = false;
        imageInput.disabled = false;
        input.focus();
      }
    }
  });
}

function renderConversation() {
  const remaining = Math.max(0, 8 - state.followUpCount);
  const intro = [
    { role: "user", text: state.question },
    { role: "assistant", text: "这次牌面我已经读完了。你可以继续问我，牌面和完整解读收在右上角。" },
  ];
  app.innerHTML = `<section class="conversation-screen screen-enter">
    <button class="conversation-back conversation-back-floating" id="back-to-reading" type="button">← 回到解读</button>
    <div class="conversation-messages" id="conversation-messages" aria-live="polite">${[...intro, ...state.chatMessages].map(conversationBubble).join("")}</div>
    <form id="follow-up-form" class="conversation-compose ${state.conversationClosed ? "is-closed" : ""}">
      <div id="follow-up-image-preview" class="follow-up-image-preview" hidden></div>
      <div class="conversation-input-row">
        <label class="image-upload-button" aria-label="上传本地图片" title="上传图片"><input id="follow-up-images" type="file" accept="image/jpeg,image/png,image/webp" multiple ${state.conversationClosed ? "disabled" : ""}><span aria-hidden="true">＋</span></label>
        <label class="sr-only" for="follow-up-input">继续追问</label>
        <textarea id="follow-up-input" maxlength="2000" rows="1" placeholder="${state.conversationClosed ? "这次牌局已经收牌" : "把你还没说完的话写在这里……"}" ${state.conversationClosed ? "disabled" : ""}></textarea>
      </div>
      <div class="conversation-compose-actions"><small id="follow-up-count" class="conversation-round-count">${remaining ? `还可以追问 ${remaining} 轮` : "本次牌局已完成 8 轮追问"}</small><p id="follow-up-status" class="follow-up-status" role="status">${state.conversationClosed ? "这次对话已经结束。" : ""}</p><button id="end-conversation" class="end-conversation" type="button" ${state.conversationClosed ? "disabled" : ""}>结束对话</button><button id="stop-follow-up" class="stop-follow-up" type="button" hidden>■ 暂停</button><button class="send-follow-up" type="submit" ${state.conversationClosed ? "disabled" : ""}>发送</button></div>
    </form>
  </section>`;
  const screen = document.querySelector(".conversation-screen");
  const messages = screen.querySelector("#conversation-messages");
  messages.scrollTop = messages.scrollHeight;
  screen.querySelector("#back-to-reading").addEventListener("click", () => go("result"));
  bindConversationForm(screen);
}

function renderResult() {
  app.innerHTML = `<section class="ritual-screen result-screen screen-enter">
    <div class="ritual-top result-top"><button class="ritual-back" id="start-over">← 重新开始</button><span>04 / 04 — 你的牌阵</span></div>
    <div class="result-heading"><h1 class="result-question-title">“${escapeHTML(state.question)}”</h1></div>
    <div class="result-layout result-layout-${state.spread}">${state.selected.map(resultCard).join("")}</div>
    <div class="result-actions"><button class="ritual-primary" id="interpret" type="button">开始解读</button><p>解读会在固定区域内展开，完成后可以继续对话。</p></div>
  </section>`;
  document.querySelector("#start-over").addEventListener("click", () => {
    state.question = "";
    state.conversationId = null;
    state.followUpCount = 0;
    state.initialProvider = null;
    state.initialReading = "";
    state.chatMessages = [];
    state.conversationClosed = false;
    state.userInfo = { enabled: false };
    go("question");
  });
  const button = document.querySelector("#interpret");
  const actions = document.querySelector(".result-actions");
  if (state.initialReading) {
    document.querySelector(".result-screen").classList.add("has-reading");
    const output = createReadingOutput(actions);
    output.textContent = state.initialReading;
    output.scrollTop = 0;
    button.textContent = state.conversationClosed ? "重新开始" : "继续对话";
    button.dataset.action = state.conversationClosed ? "restart" : "conversation";
  }
  button.addEventListener("click", async () => {
    if (button.dataset.action === "conversation") {
      go("conversation");
      return;
    }
    if (button.dataset.action === "restart") {
      state.question = "";
      go("question");
      return;
    }
    if (state.spread === 3) {
      state.framework = null;
      document.querySelectorAll(".result-card-label > span").forEach((element, index) => {
        element.textContent = labels[3][index];
      });
    }
    button.disabled = true;
    button.textContent = "解读中...";
    const screen = document.querySelector(".result-screen");
    const output = document.querySelector("#reading-output") || createReadingOutput(actions);
    const revealReading = () => screen.classList.add("has-reading");
    output.textContent = "";
    const controller = new AbortController();
    activeReadingRequest = controller;
    try {
      state.conversationId = null;
      state.followUpCount = 0;
      state.initialProvider = getActiveProvider();
      state.initialReading = "";
      state.chatMessages = [];
      state.conversationClosed = false;
      const completedReading = await fetchReading(output, revealReading, controller.signal);
      const { reading, summary } = splitReadingSummary(completedReading);
      state.initialReading = reading || completedReading.trim();
      output.textContent = state.initialReading;
      const note = actions.querySelector("p");
      if (isLoggedIn() && state.userInfo?.enabled && state.userInfo?.id) {
        try {
          await saveCompletedReading(summary, state.initialReading);
          note.textContent = `已保存到 ${state.userInfo.nickname || "当前用户"} 名下的云端历史。`;
        } catch (saveError) {
          note.textContent = `解读已完成，但云端保存失败：${saveError.message}`;
        }
      } else if (isLoggedIn()) {
        note.textContent = "启用一位用户后，本次牌阵才会保存到她的名下";
      } else {
        note.textContent = "登录后可保存本次记录";
      }
      button.textContent = "继续对话";
      button.dataset.action = "conversation";
    } catch (error) {
      if (error?.name === "AbortError") return;
      revealReading();
      const message = error instanceof TypeError
        ? "暂时无法连接解读服务，请确认 Flask 已启动。"
        : error.message?.includes("请先设置环境变量")
          ? "还没有可用的模型。点击左上角 ARCANA 添加供应商，或在服务端设置 .env。"
        : (error.message || "解读暂时失败，请稍后重试。");
      output.textContent += `${output.textContent ? "\n\n" : ""}${message}`;
      button.textContent = "重新解读";
    } finally {
      if (activeReadingRequest === controller) activeReadingRequest = null;
      if (document.body.contains(button)) button.disabled = false;
    }
  });
}

function render() {
  if (state.stage === "question") renderQuestion();
  if (state.stage === "shuffle") renderShuffle();
  if (state.stage === "cut") renderCut();
  if (state.stage === "fan") renderFan();
  if (state.stage === "result") renderResult();
  if (state.stage === "conversation") renderConversation();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

initializeProviderSettings(() => {});
initializeAuth(() => {});
render();
