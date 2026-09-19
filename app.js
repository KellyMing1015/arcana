import { DECK, cardFace } from "./cards.js";
import { getActiveProvider, getActiveProviderLabel, initializeProviderSettings } from "./settings.js";

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
};
const labels = {
  1: ["此刻"],
  3: ["过去", "现在", "未来"],
  10: ["现状", "交叉影响", "潜意识", "过去", "意识", "近期", "自我", "环境", "希望与恐惧", "可能走向"],
};
const timers = new Set();
let shuffleInterval = null;
let cutAutoTimer = null;
let armedAtDown = null;

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
  cutAutoTimer = null;
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function go(stage) {
  clearTimers();
  state.stage = stage;
  render();
}

function backArt() {
  return `<span class="back-ornament" aria-hidden="true"><svg viewBox="0 0 180 270" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="8" y="8" width="164" height="254" rx="5" stroke="currentColor" opacity=".68"/>
    <rect x="17" y="17" width="146" height="236" rx="2" stroke="currentColor" opacity=".25"/>
    <circle cx="90" cy="134" r="47" stroke="currentColor"/><circle cx="90" cy="134" r="30" stroke="currentColor" opacity=".5"/>
    <path d="M90 51V217M31 134H149M48 80L132 188M132 80L48 188" stroke="currentColor" opacity=".34"/>
    <path d="M90 101L99 125L123 134L99 143L90 167L81 143L57 134L81 125L90 101Z" fill="currentColor"/>
    <circle cx="90" cy="134" r="6" fill="#111216"/>
    <path d="M84 38L90 29L96 38M85 234L90 241L95 234" stroke="currentColor"/>
  </svg></span>`;
}

function renderQuestion() {
  app.innerHTML = `<section class="ritual-screen question-screen screen-enter">
    <div class="ritual-ornament ornament-one" aria-hidden="true">✳</div>
    <div class="ritual-ornament ornament-two" aria-hidden="true">✳</div>
    <div class="question-inner">
      <div class="eyebrow"><span class="eyebrow-line"></span> A MOMENT FOR YOUR QUESTION</div>
      <h1>此刻，<br><em>你想问什么？</em></h1>
      <p class="question-lead">不用想一个完美的问题。把心里正在发生的事，写下来就好。</p>
      <form id="question-form" class="ritual-question-form">
        <label class="sr-only" for="question">想问的问题</label>
        <textarea id="question" rows="3" maxlength="220" placeholder="我想聊聊……" required>${escapeHTML(state.question)}</textarea>
        <fieldset class="ritual-spreads"><legend>选择牌阵</legend>
          <button type="button" data-spread="1" class="ritual-spread ${state.spread === 1 ? "active" : ""}" aria-pressed="${state.spread === 1}"><span>01</span><strong>单牌</strong><small>一张牌的提示</small></button>
          <button type="button" data-spread="3" class="ritual-spread ${state.spread === 3 ? "active" : ""}" aria-pressed="${state.spread === 3}"><span>03</span><strong>三牌阵</strong><small>过去 · 现在 · 未来</small></button>
          <button type="button" data-spread="10" class="ritual-spread ${state.spread === 10 ? "active" : ""}" aria-pressed="${state.spread === 10}"><span>10</span><strong>凯尔特十字</strong><small>深入展开议题</small></button>
        </fieldset>
        <button class="ritual-primary" type="submit">开始 <span aria-hidden="true">↗</span></button>
      </form>
      <p class="prototype-note">点击左上角 ARCANA，可以添加和切换解读供应商。</p>
    </div>
    <div class="question-deco" aria-hidden="true"><div class="question-deco-card">${cardFace(DECK[0])}</div></div>
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
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const question = input.value.trim();
    if (!question) { input.focus(); return; }
    state.question = question;
    state.deck = shuffle(DECK.map((card) => ({ ...card, reversed: false })));
    state.selected = [];
    state.cutCount = 0;
    state.hoveredId = null;
    go("shuffle");
  });
}

function renderShuffle() {
  state.isHolding = false;
  app.innerHTML = `<section class="ritual-screen shuffle-screen screen-enter">
    <div class="ritual-top"><button class="ritual-back" id="back-question">← 返回提问</button><span>01 / 04 — 洗牌</span></div>
    <div class="ritual-heading"><span class="eyebrow">THE CARDS ARE IN YOUR HANDS</span><h1>把注意力放在你的问题上。</h1><p>按住牌堆洗牌，松开时停下。你可以按自己的节奏来。</p></div>
    <div class="shuffle-surface" id="shuffle-surface" tabindex="0" role="button" aria-label="按住鼠标或手指持续洗牌，松开后进入切牌">
      <div class="shuffle-glow" aria-hidden="true"></div>
      <div class="shuffle-pile" id="shuffle-pile">${Array.from({ length: 14 }, (_, index) => `<div class="shuffle-card ${index % 4 === 1 ? "visually-reversed" : ""}" style="--stack-x:${(index - 7) * 1.1}px;--stack-y:${(7 - index) * 1.2}px;--tilt:${(index % 5 - 2) * .5}deg;--shuffle-delay:${-index * 67}ms">${backArt()}</div>`).join("")}</div>
    </div>
    <div class="ritual-instruction" id="shuffle-instruction"><span class="instruction-mark">↕</span><strong>按住洗牌</strong><small>按住多久，就洗多久</small></div>
    <p class="ritual-question">“${escapeHTML(state.question)}”</p>
  </section>`;
  document.querySelector("#back-question").addEventListener("click", () => go("question"));
  const surface = document.querySelector("#shuffle-surface");
  const pile = document.querySelector("#shuffle-pile");
  function start(event) {
    if (state.isHolding || state.stage !== "shuffle") return;
    event.preventDefault();
    state.isHolding = true;
    surface.classList.add("is-shuffling");
    pile.classList.add("is-shuffling");
    document.querySelector("#shuffle-instruction").innerHTML = `<span class="instruction-mark">✳</span><strong>正在洗牌…</strong><small>松开手指或鼠标即可停下</small>`;
    if (event.pointerId !== undefined) surface.setPointerCapture(event.pointerId);
    shuffleInterval = setInterval(() => {
      state.deck = shuffle(state.deck);
      const cards = pile.querySelectorAll(".shuffle-card");
      for (let i = 0; i < 3; i += 1) cards[Math.floor(Math.random() * cards.length)].classList.toggle("visually-reversed");
    }, 260);
  }
  function stop(event) {
    if (!state.isHolding || state.stage !== "shuffle") return;
    event.preventDefault();
    state.isHolding = false;
    if (shuffleInterval) clearInterval(shuffleInterval);
    shuffleInterval = null;
    state.deck = shuffle(state.deck).map((card) => ({ ...card, reversed: Math.random() < .28 }));
    surface.classList.remove("is-shuffling");
    pile.classList.remove("is-shuffling");
    pile.classList.add("is-settling");
    document.querySelector("#shuffle-instruction").innerHTML = `<span class="instruction-mark">✳</span><strong>洗牌完成</strong><small>牌正在收拢</small>`;
    later(() => go("cut"), 500);
  }
  surface.addEventListener("pointerdown", start);
  surface.addEventListener("pointerup", stop);
  surface.addEventListener("pointercancel", stop);
  surface.addEventListener("contextmenu", (event) => event.preventDefault());
  surface.addEventListener("keydown", (event) => { if (event.code === "Space") start(event); });
  surface.addEventListener("keyup", (event) => { if (event.code === "Space") stop(event); });
}

function renderCut() {
  app.innerHTML = `<section class="ritual-screen cut-screen screen-enter">
    <div class="ritual-top"><button class="ritual-back" id="reshuffle-top">← 重新洗牌</button><span>02 / 04 — 切牌</span></div>
    <div class="ritual-heading"><span class="eyebrow">A SMALL CHANGE IN THE ORDER</span><h1>轮到你切牌。</h1><p id="cut-description">点击切牌。你可以重复切牌，停下后牌面会自动展开。</p></div>
    <div class="cut-stage"><div class="cut-halo" aria-hidden="true"></div><div class="cut-pile" id="cut-pile"><div class="cut-half cut-bottom">${backArt()}</div><div class="cut-half cut-top">${backArt()}</div></div></div>
    <div class="cut-actions"><button class="ritual-primary cut-button" type="button" id="cut-button">切牌 <span aria-hidden="true">↗</span></button><button class="ritual-secondary" type="button" id="reshuffle">重新洗牌</button></div>
    <p class="cut-count" id="cut-count">尚未切牌</p>
  </section>`;
  document.querySelector("#reshuffle-top").addEventListener("click", () => go("shuffle"));
  document.querySelector("#reshuffle").addEventListener("click", () => go("shuffle"));
  const cutButton = document.querySelector("#cut-button");
  const pile = document.querySelector("#cut-pile");
  cutButton.addEventListener("click", () => {
    if (pile.classList.contains("is-cutting")) return;
    if (cutAutoTimer) { clearTimeout(cutAutoTimer); timers.delete(cutAutoTimer); cutAutoTimer = null; }
    const position = 1 + Math.floor(Math.random() * 77);
    state.deck = [...state.deck.slice(position), ...state.deck.slice(0, position)];
    state.cutCount += 1;
    pile.classList.remove("is-cutting");
    pile.classList.add("is-cutting");
    cutButton.disabled = true;
    cutButton.firstChild.textContent = "正在切牌 ";
    document.querySelector("#cut-count").textContent = `已切 ${state.cutCount} 次`;
    later(() => {
      pile.classList.remove("is-cutting");
      cutButton.disabled = false;
      cutButton.firstChild.textContent = "继续切牌 ";
      document.querySelector("#cut-description").textContent = "想再切一次就点击。停下约两秒，牌面会自动展开。";
      cutAutoTimer = later(() => go("fan"), 2200);
    }, 1000);
  });
}

function fanBack(card) {
  return `<div class="fan-card" data-card-id="${card.id}" aria-hidden="true"><div class="fan-card-inner">${backArt()}</div></div>`;
}

function renderFan() {
  state.isOpening = true;
  state.isSelecting = false;
  state.hoveredId = null;
  app.innerHTML = `<section class="ritual-screen fan-screen screen-enter">
    <div class="ritual-top"><span>03 / 04 — 选牌</span><span>ARCANA · ${state.spread === 1 ? "单牌" : state.spread === 3 ? "三牌阵" : "凯尔特十字"}</span></div>
    <div class="fan-heading"><span class="eyebrow">TRUST YOUR FIRST FEELING</span><h1>选择让你停下<span class="mobile-break"><br></span>目光的牌。</h1><p id="fan-instruction">牌面正在展开…</p></div>
    <div class="selection-tray" id="selection-tray">${labels[state.spread].map((label, index) => `<div class="tray-item"><div class="tray-slot" id="selection-slot-${index}"><span>${String(index + 1).padStart(2, "0")}</span></div><small>${label}</small></div>`).join("")}</div>
    <div class="fan-area" id="fan-area" tabindex="0" role="group" aria-label="78 张塔罗牌扇面。移动指针或手指选择，再点击确认。键盘可用左右方向键选择、回车确认。">
      <div class="fan-center-mark" aria-hidden="true">✳</div>
      ${state.deck.map(fanBack).join("")}
      <div class="fan-gap-info" id="fan-gap-info"><strong>请选择 ${state.spread} 张牌</strong><span>先滑过牌面，再点击确认</span></div>
    </div>
  </section>`;
  const area = document.querySelector("#fan-area");
  requestAnimationFrame(() => requestAnimationFrame(() => layoutFan(true)));
  later(() => {
    if (state.stage !== "fan") return;
    state.isOpening = false;
    area.classList.add("is-ready");
    document.querySelector("#fan-instruction").textContent = "滑过牌面，让一张牌浮起；再点击它，确认选择。";
    area.querySelectorAll(".fan-card").forEach((element) => { element.style.transitionDelay = "0ms"; });
  }, 1200);

  area.addEventListener("pointermove", (event) => {
    if (state.isOpening || state.isSelecting) return;
    const card = cardAtPoint(event.clientX, event.clientY);
    setHover(card?.id ?? null);
  });
  area.addEventListener("pointerdown", (event) => {
    if (state.isOpening || state.isSelecting) return;
    event.preventDefault();
    const card = cardAtPoint(event.clientX, event.clientY);
    armedAtDown = card && state.hoveredId === card.id ? card.id : null;
    setHover(card?.id ?? null);
    area.setPointerCapture(event.pointerId);
  });
  area.addEventListener("pointerup", (event) => {
    if (state.isOpening || state.isSelecting) return;
    const card = cardAtPoint(event.clientX, event.clientY);
    if (card && card.id === armedAtDown && state.hoveredId === card.id) selectCard(card);
    armedAtDown = null;
  });
  area.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse" && !area.hasPointerCapture(event.pointerId)) setHover(null);
  });
  area.addEventListener("pointercancel", () => { armedAtDown = null; });
  area.addEventListener("keydown", (event) => {
    if (state.isOpening || state.isSelecting) return;
    const remaining = getRemaining();
    const current = remaining.findIndex((card) => card.id === state.hoveredId);
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? 1 : -1;
      setHover(remaining[(current + delta + remaining.length) % remaining.length].id);
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
function fanMetrics() {
  const area = document.querySelector("#fan-area");
  const width = area.clientWidth;
  const height = area.clientHeight;
  return { area, radius: Math.min(width * .38, height * .43, 286), cx: width / 2, cy: height * .58 };
}

function layoutFan(opening) {
  const remaining = getRemaining();
  const { area, radius } = fanMetrics();
  remaining.forEach((card, index) => {
    const element = area.querySelector(`[data-card-id="${card.id}"]`);
    if (!element) return;
    const angle = 135 + index / Math.max(remaining.length - 1, 1) * 270;
    const radians = angle * Math.PI / 180;
    const x = Math.cos(radians) * radius;
    const y = Math.sin(radians) * radius;
    const rotation = angle + 90 + (card.reversed ? 180 : 0);
    const base = `translate(-50%, -50%) translate(${x}px, ${y}px) rotate(${rotation}deg)`;
    const hover = `translate(-50%, -50%) translate(${x}px, ${y - 10}px) rotate(${rotation}deg) scale(1.08)`;
    element.dataset.baseTransform = base;
    element.dataset.hoverTransform = hover;
    element.dataset.rotation = String(rotation);
    element.style.transitionDelay = opening ? `${index * 9}ms` : "0ms";
    element.style.zIndex = card.id === state.hoveredId ? "200" : String(index + 1);
    element.style.transform = card.id === state.hoveredId ? hover : base;
    element.style.opacity = "1";
  });
}

function cardAtPoint(clientX, clientY) {
  const remaining = getRemaining();
  if (!remaining.length) return null;
  const { area, radius, cx, cy } = fanMetrics();
  const bounds = area.getBoundingClientRect();
  const dx = clientX - bounds.left - cx;
  const dy = clientY - bounds.top - cy;
  const distance = Math.hypot(dx, dy);
  const tolerance = matchMedia("(max-width: 560px)").matches ? 50 : 66;
  if (distance < radius - tolerance || distance > radius + tolerance) return null;
  let angle = Math.atan2(dy, dx) * 180 / Math.PI;
  if (angle < 0) angle += 360;
  if (angle > 45 && angle < 135) return null;
  if (angle < 135) angle += 360;
  const position = Math.max(0, Math.min(remaining.length - 1, Math.round((angle - 135) / 270 * (remaining.length - 1))));
  return remaining[position];
}

function setHover(id) {
  if (state.hoveredId === id) return;
  const area = document.querySelector("#fan-area");
  const previous = area.querySelector(`[data-card-id="${state.hoveredId}"]`);
  if (previous) {
    previous.classList.remove("is-hovered");
    previous.style.transform = previous.dataset.baseTransform;
    previous.style.zIndex = previous.dataset.originalZ || previous.style.zIndex;
  }
  state.hoveredId = id;
  const next = id ? area.querySelector(`[data-card-id="${id}"]`) : null;
  if (next) {
    next.dataset.originalZ = next.style.zIndex;
    next.classList.add("is-hovered");
    next.style.transform = next.dataset.hoverTransform;
    next.style.zIndex = "200";
  }
}

async function selectCard(card) {
  if (!card || state.isSelecting || state.stage !== "fan") return;
  state.isSelecting = true;
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
  document.querySelector("#fan-gap-info strong").textContent = `已选 ${state.selected.length} / ${state.spread} 张`;
  document.querySelector("#fan-instruction").textContent = state.selected.length < state.spread ? "继续选牌。滑过一张牌，再点击确认。" : "牌阵正在形成…";
  if (state.selected.length === state.spread) {
    const area = document.querySelector("#fan-area");
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
    <div class="result-card-label"><span>${labels[state.spread][index]}</span><strong>${card.chinese}</strong><small>${card.reversed ? "逆位" : "正位"}</small></div>
  </article>`;
}

function createReadingOutput(actions) {
  const output = document.createElement("section");
  output.id = "reading-output";
  output.setAttribute("role", "region");
  output.setAttribute("aria-label", "塔罗解读");
  Object.assign(output.style, {
    width: "min(100% - 44px, 760px)",
    margin: "0 auto 72px",
    padding: "26px clamp(20px, 4vw, 38px)",
    border: "1px solid #dedbd4",
    borderRadius: "3px",
    background: "#fffdfa",
    color: "#33342f",
    fontSize: "15px",
    lineHeight: "1.9",
    textAlign: "left",
    whiteSpace: "pre-wrap",
    minHeight: "110px",
  });
  actions.after(output);
  return output;
}

async function fetchReading(output) {
  const provider = getActiveProvider();
  const response = await fetch("/api/reading", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: state.question,
      spread: state.spread,
      cards: state.selected.map((card, index) => ({
        id: card.id,
        name: `${card.chinese}（${card.english}）`,
        position: labels[state.spread][index],
        reversed: card.reversed,
      })),
      ...(provider ? { provider } : {}),
    }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `解读请求失败（${response.status}）。`);
  }
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error("解读接口没有返回可读取的文字流。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let rendered = "";
  let done = false;
  let typing = false;
  let failed = false;
  const characters = [];
  let resolveTyping;
  const typingFinished = new Promise((resolve) => { resolveTyping = resolve; });

  function typeNext() {
    if (failed) return;
    if (characters.length) {
      rendered += characters.shift();
      output.textContent = rendered;
      requestAnimationFrame(typeNext);
    } else {
      typing = false;
      if (done) resolveTyping();
    }
  }
  function queueText(text) {
    characters.push(...text);
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
    if (typeof payload.content === "string") queueText(payload.content);
    if (payload.done === true) {
      done = true;
      if (!typing && !characters.length) resolveTyping();
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
    if (!done) throw new Error("解读连接提前结束，请重试。");
    await typingFinished;
  } catch (error) {
    failed = true;
    characters.length = 0;
    output.textContent = rendered;
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function renderResult() {
  app.innerHTML = `<section class="ritual-screen result-screen screen-enter">
    <div class="ritual-top"><button class="ritual-back" id="start-over">← 重新开始</button><span>04 / 04 — 你的牌阵</span></div>
    <div class="result-heading"><span class="eyebrow">YOUR CARDS HAVE FOUND THEIR PLACE</span><h1>你的牌，已经来到面前。</h1><p>“${escapeHTML(state.question)}”</p></div>
    <div class="result-layout result-layout-${state.spread}">${state.selected.map(resultCard).join("")}</div>
    <div class="result-actions"><button class="ritual-primary" id="interpret" type="button">开始解读 <span aria-hidden="true">↗</span></button><p>解读会逐字出现。对话与记忆将在下一阶段接入。</p></div>
  </section>`;
  document.querySelector("#start-over").addEventListener("click", () => {
    state.question = "";
    go("question");
  });
  const button = document.querySelector("#interpret");
  const actions = document.querySelector(".result-actions");
  button.addEventListener("click", async () => {
    if (button.dataset.completed === "true") {
      state.question = "";
      go("question");
      return;
    }
    button.disabled = true;
    button.firstChild.textContent = "解读中... ";
    const output = document.querySelector("#reading-output") || createReadingOutput(actions);
    output.textContent = "正在倾听你的问题…";
    output.scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      output.textContent = "";
      await fetchReading(output);
      button.firstChild.textContent = "再来一次 ";
      button.dataset.completed = "true";
    } catch (error) {
      const message = error instanceof TypeError
        ? "暂时无法连接解读服务，请确认 Flask 已启动。"
        : error.message?.includes("请先设置环境变量")
          ? "还没有可用的模型。点击左上角 ARCANA 添加供应商，或在服务端设置 .env。"
        : (error.message || "解读暂时失败，请稍后重试。");
      output.textContent += `${output.textContent ? "\n\n" : ""}${message}`;
      button.firstChild.textContent = "重新解读 ";
    } finally {
      button.disabled = false;
    }
  });
}

function render() {
  if (state.stage === "question") renderQuestion();
  if (state.stage === "shuffle") renderShuffle();
  if (state.stage === "cut") renderCut();
  if (state.stage === "fan") renderFan();
  if (state.stage === "result") renderResult();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

initializeProviderSettings(() => {
  const indicator = document.querySelector("#provider-indicator");
  if (indicator) indicator.textContent = getActiveProviderLabel();
});
render();
