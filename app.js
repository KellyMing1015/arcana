import { DECK, cardFace, cardImageURL, cardImageSrcSet, CARD_IMAGE_SIZES } from "./cards.js?v=20261006-session";
import { getActiveProvider, getUserInfo, initializeProviderSettings } from "./settings.js?v=20261006-session";
import { getCurrentUser, initializeAuth, isLoggedIn, saveCloudReading } from "./auth.js?v=20261006-session";
import { renderHomeMarkup } from "./home-view.js?v=20261006-session";
import { READING_SESSION_KEY, confirmReadingAction, loadReadingSnapshot, reconcileConversationMessages, saveReadingSnapshot } from "./reading-session.js?v=20261006-session";

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
  readingKey: null,
  followUpDraft: "",
  followUpImages: [],
  pendingFollowUp: null,
  resumeMode: "ready",
  attachmentWarning: false,
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
let activeResponseElement = null;
let snapshotOwner = null;
let authInitialized = false;
let snapshotSaveTimer = null;
let sessionSyncController = null;
let sessionSyncTimer = null;
const cardImageCache = new Map();
const cardsById = new Map(DECK.map((card) => [card.id, card]));
const CARD_IMAGE_RETRY_LIMIT = 2;

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

function go(stage, { historyMode = "push" } = {}) {
  persistCurrentReading();
  clearTimers();
  state.stage = stage;
  if (stage === "question") cardImageCache.clear();
  document.body.classList.toggle("result-open", stage === "result");
  document.body.classList.toggle("conversation-open", stage === "conversation");
  recordReadingNavigation(historyMode);
  render();
  persistCurrentReading();
}

function readingOwner() { return getCurrentUser() ? `account:${getCurrentUser().id}` : "guest"; }

function persistCurrentReading() {
  if (!authInitialized || snapshotOwner !== readingOwner()) return;
  const messages = state.chatMessages.map((message, index) => activeConversationRequest && activeResponseElement && index === state.chatMessages.length - 1
    ? { ...message, text: outputText(activeResponseElement), stopped: true } : message);
  try { saveReadingSnapshot(sessionStorage, { ...state, chatMessages: messages }, snapshotOwner); } catch { /* Storage can be disabled by the browser. */ }
}

function discardReadingSnapshot() { try { sessionStorage.removeItem(READING_SESSION_KEY); } catch { /* The visible reading can still reset. */ } }

function queueReadingSnapshot() {
  clearTimeout(snapshotSaveTimer);
  snapshotSaveTimer = setTimeout(persistCurrentReading, 200);
}

function cancelSessionSync() {
  clearTimeout(sessionSyncTimer);
  sessionSyncTimer = null;
  sessionSyncController?.abort();
  sessionSyncController = null;
}

function recordReadingNavigation(mode) {
  if (mode === "none") return;
  const view = ["result", "conversation"].includes(state.stage) ? state.stage : "question";
  const marker = { ...history.state, arcanaView: view, arcanaReading: state.readingKey };
  if (history.state?.arcanaView === view && history.state?.arcanaReading === state.readingKey) return;
  const method = mode === "replace" || view === "question" ? "replaceState" : "pushState";
  history[method](marker, "", location.href);
}

function resetReadingState() {
  cancelSessionSync();
  clearTimeout(snapshotSaveTimer);
  Object.assign(state, { question: "", selected: [], framework: null, conversationId: null, followUpCount: 0,
    initialProvider: null, initialReading: "", chatMessages: [], conversationClosed: false,
    readingKey: null, followUpDraft: "", followUpImages: [], pendingFollowUp: null,
    resumeMode: "ready", attachmentWarning: false, userInfo: { enabled: false } });
}

async function stopCurrentResponse() {
  const controller = activeConversationRequest || activeReadingRequest;
  if (!controller) return;
  controller.abort();
  await controller.finished;
}

async function restartReading(trigger) {
  const key = state.readingKey;
  if (!await confirmReadingAction({ trigger, title: "要重新抽牌吗？",
    description: "重新开始会结束当前牌局。",
    confirmLabel: "重新抽牌" })) return;
  await stopCurrentResponse();
  if (state.readingKey !== key) return;
  if (state.conversationId && !state.conversationClosed && state.resumeMode !== "expired") {
    try {
      const response = await fetch("/api/conversation/end", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: state.conversationId }) });
      if (!response.ok && response.status !== 404) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "这次牌局暂时无法结束，请稍后重试。");
      }
    } catch (error) {
      const notice = document.querySelector("#follow-up-status, .result-actions p");
      if (notice) notice.textContent = error.message || "暂时无法连接，当前牌局已保留。";
      return;
    }
  }
  if (state.readingKey !== key) return;
  discardReadingSnapshot();
  resetReadingState();
  go("question", { historyMode: "replace" });
}

async function returnToReading(trigger, fromHistory = false) {
  if (activeConversationRequest) {
    const confirmed = await confirmReadingAction({ trigger, title: "先回到解读页？",
      description: "正在生成的回应会暂停，已有对话会保留。之后仍可以回来继续。", confirmLabel: "暂停并返回" });
    if (!confirmed) { if (fromHistory) recordReadingNavigation("push"); return; }
    await stopCurrentResponse();
  }
  if (!fromHistory && history.state?.arcanaView === "conversation" && history.state.arcanaReading === state.readingKey) {
    history.back();
  } else go("result", { historyMode: fromHistory ? "none" : "replace" });
}

function resumeNotice() {
  if (state.resumeMode === "checking" || state.resumeMode === "busy") return "正在找回最新回应…";
  if (state.resumeMode === "expired") return "这次牌局已过期，已有内容仍可查看。要继续请重新抽牌。";
  if (state.resumeMode === "offline") return "暂时连不上服务器，对话已保留。";
  return state.attachmentWarning ? "文字已恢复，未发送的图片请重新选择。" : "";
}

async function syncCurrentConversation() {
  cancelSessionSync();
  if (!state.conversationId || snapshotOwner !== readingOwner()) return;
  const id = state.conversationId;
  const key = state.readingKey;
  const controller = new AbortController();
  sessionSyncController = controller;
  const timeout = setTimeout(() => controller.abort(), 10000);
  const current = () => sessionSyncController === controller && state.readingKey === key && snapshotOwner === readingOwner();
  try {
    const response = await fetch(`/api/conversation/${encodeURIComponent(id)}`, { signal: controller.signal, cache: "no-store" });
    const payload = await response.json();
    if (!current()) return;
    if (response.status === 403 || response.status === 401) {
      discardReadingSnapshot();
      resetReadingState();
      go("question", { historyMode: "replace" });
      return;
    }
    if (response.status === 404) { state.resumeMode = "expired"; return; }
    if (!response.ok || !Array.isArray(payload.messages) || !Number.isInteger(payload.rounds) || payload.rounds < 0 || payload.rounds > 8) throw new Error("对话状态暂时无法确认。");
    const pending = state.pendingFollowUp;
    state.chatMessages = reconcileConversationMessages(state.chatMessages, payload.messages, payload.rounds, pending);
    state.followUpCount = payload.rounds;
    state.conversationClosed = Boolean(payload.closed);
    if (pending && payload.rounds > pending.roundsBefore) {
      const user = state.chatMessages.at(-2);
      if (state.followUpDraft === user?.message && JSON.stringify(state.followUpImages) === JSON.stringify(user.images || [])) {
        state.followUpDraft = ""; state.followUpImages = []; state.attachmentWarning = false;
      }
      state.pendingFollowUp = null;
    } else if (pending && !payload.busy && !payload.closed) {
      const answer = state.chatMessages.at(-1);
      if (answer?.role === "assistant") {
        answer.error = true; delete answer.stopped;
        answer.text ||= "上次的回应没有完成，可以重试这次提问。";
      }
    }
    state.resumeMode = payload.busy ? "busy" : "ready";
    if (payload.busy) sessionSyncTimer = setTimeout(syncCurrentConversation, 2000);
  } catch {
    if (current()) state.resumeMode = "offline";
  } finally {
    clearTimeout(timeout);
    if (current()) {
      sessionSyncController = null;
      if (["result", "conversation"].includes(state.stage)) render();
      persistCurrentReading();
    }
  }
}

function restoreCurrentReading() {
  let saved;
  try { saved = loadReadingSnapshot(sessionStorage, snapshotOwner, new Set(cardsById.keys())); } catch { return false; }
  if (!saved) return false;
  Object.assign(state, { question: saved.question, spread: saved.spread, selected: saved.cards.map((card) => ({ ...cardsById.get(card.id), reversed: card.reversed })),
    framework: saved.framework, conversationId: saved.conversationId, followUpCount: saved.rounds, initialReading: saved.initialReading,
    chatMessages: saved.messages, conversationClosed: saved.closed, readingKey: saved.readingKey,
    followUpDraft: saved.draft.text, followUpImages: saved.draft.images, pendingFollowUp: saved.pending,
    attachmentWarning: Boolean(saved.attachmentWarning), userInfo: getUserInfo(), resumeMode: saved.conversationId ? "checking" : "expired" });
  // A fresh tab needs a safe reading entry below the conversation for the back gesture.
  if (history.state?.arcanaReading !== state.readingKey) {
    history.replaceState({ ...history.state, arcanaView: "question", arcanaReading: state.readingKey }, "", location.href);
    if (saved.stage === "conversation") {
      state.stage = "result";
      recordReadingNavigation("push");
    }
  }
  go(saved.stage, { historyMode: history.state?.arcanaView === saved.stage ? "none" : "push" });
  syncCurrentConversation();
  return true;
}

function backArt() {
  // 卡背由同一个 CSS 图片资源绘制，避免洗牌时同时创建、解码 14 个大图标签。
  return `<span class="back-ornament" aria-hidden="true"><span class="back-half back-half-upper"></span><span class="back-half back-half-lower"></span></span>`;
}

function uiIcon(name) {
  const paths = {
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    back: '<path d="M19 12H5m5-5-5 5 5 5"/>',
    question: '<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.2a2.5 2.5 0 0 1 4.8 1c0 1.8-2.3 2-2.3 3.6"/><path d="M12 17h.01"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 16 5-5 4 4 4-6 5 7"/>',
    pause: '<path d="M9 6v12M15 6v12"/>',
    restart: '<path d="M4 10a8 8 0 1 1 2 8M4 4v6h6"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    cards: '<path d="M8 4h11v16H8zM5 7H3v14h11v-1"/><circle cx="13.5" cy="12" r="3"/>',
  };
  return `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.question}</svg>`;
}

function spreadIcon(spread) {
  const star = (x, y, size) => `<path d="M${x} ${y-size} ${x+size*.28} ${y-size*.28} ${x+size} ${y} ${x+size*.28} ${y+size*.28} ${x} ${y+size} ${x-size*.28} ${y+size*.28} ${x-size} ${y} ${x-size*.28} ${y-size*.28}Z"/>`;
  const drawings = {
    1: `<circle cx="32" cy="32" r="25" opacity=".2"/><path d="M38 13a20 20 0 1 0 12 34A19 19 0 0 1 38 13Z"/><g stroke-width="1.1">${star(47,17,5)}${star(44,33,3)}</g><circle cx="28" cy="7" r="1" fill="currentColor" stroke="none"/><circle cx="43" cy="54" r="1" fill="currentColor" stroke="none"/>`,
    3: `<path d="M12 40q20-31 40 0M12 40l20 10 20-10" opacity=".28"/><g stroke-width="1.35">${star(12,37,7)}${star(32,17,9)}${star(52,37,7)}</g><path d="M32 29v9M28 34h8" opacity=".5"/><circle cx="32" cy="50" r="2"/><circle cx="8" cy="17" r="1" fill="currentColor" stroke="none"/><circle cx="56" cy="17" r="1" fill="currentColor" stroke="none"/>`,
    10: `<circle cx="32" cy="32" r="21" opacity=".5"/><circle cx="32" cy="32" r="15" opacity=".22"/><path d="M32 4v15M32 45v15M4 32h15M45 32h15M13 13l7 7M44 44l7 7M13 51l7-7M44 20l7-7" opacity=".55"/>${star(32,32,11)}<g fill="currentColor" stroke="none"><circle cx="32" cy="8" r="1.6"/><circle cx="56" cy="32" r="1.6"/><circle cx="32" cy="56" r="1.6"/><circle cx="8" cy="32" r="1.6"/><circle cx="15" cy="15" r="1"/><circle cx="49" cy="15" r="1"/><circle cx="15" cy="49" r="1"/><circle cx="49" cy="49" r="1"/></g>`,
  };
  return `<svg class="spread-symbol" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${drawings[spread]}</svg>`;
}

function questionToggle() {
  return `<details class="question-disclosure"><summary aria-label="查看本次问题" title="查看本次问题">${uiIcon("question")}</summary><div class="question-popover"><p>${escapeHTML(state.question)}</p></div></details>`;
}

function loadCardImageAttempt(card, attempt) {
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.loading = "eager";
    image.fetchPriority = "high";
    let settled = false;
    const finish = (loaded) => {
      if (settled) return;
      settled = true;
      image.onload = null;
      image.onerror = null;
      resolve(loaded ? image : null);
    };
    // 慢网下继续复用正在下载的图片，只有明确失败才换地址重试。
    // 进入结果页的等待上限由选牌动画控制，不会被这个预加载阻塞。
    image.onload = async () => {
      if (image.decode) {
        try { await image.decode(); } catch (_error) { /* Safari 偶尔会拒绝重复 decode，naturalWidth 仍可确认图片完整。 */ }
      }
      finish(image.complete && image.naturalWidth > 0);
    };
    image.onerror = () => finish(false);
    image.sizes = CARD_IMAGE_SIZES;
    image.srcset = cardImageSrcSet(card, attempt);
    image.src = cardImageURL(card, attempt);
  });
}

function trimCardImageCache() {
  // 只保留所有已选牌和最近两张候选；未选牌较少时至少保留 4 张，避免滑动时反复解码。
  const limit = Math.max(4, state.selected.length + 2);
  while (cardImageCache.size > limit) {
    const removableId = [...cardImageCache.keys()].find((id) => !state.selected.some((card) => card.id === id));
    if (!removableId) return;
    cardImageCache.delete(removableId);
  }
}

function preloadCardImage(card) {
  const cached = cardImageCache.get(card.id);
  if (cached) {
    // 重新插入以维持最近使用顺序，让频繁滑牌时的图片缓存保持有界。
    cardImageCache.delete(card.id);
    cardImageCache.set(card.id, cached);
    return cached.promise;
  }
  const entry = { image: null, promise: null };
  entry.promise = (async () => {
    for (let attempt = 0; attempt <= CARD_IMAGE_RETRY_LIMIT; attempt += 1) {
      const image = await loadCardImageAttempt(card, attempt);
      if (image) {
        // 保留已解码的 Image 对象，避免页面切换后马上被回收并重新解码。
        entry.image = image;
        return true;
      }
    }
    if (cardImageCache.get(card.id) === entry) cardImageCache.delete(card.id);
    return false;
  })();
  cardImageCache.set(card.id, entry);
  trimCardImageCache();
  return entry.promise;
}

function handleCardImageError(event) {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !image.dataset.cardImage) return;
  const card = cardsById.get(image.dataset.cardImage);
  const attempt = Number(image.dataset.imageRetry || 0);
  if (!card || attempt >= CARD_IMAGE_RETRY_LIMIT) {
    image.classList.add("card-art-load-error");
    return;
  }
  const nextAttempt = attempt + 1;
  image.dataset.imageRetry = String(nextAttempt);
  image.classList.add("card-art-retrying");
  window.setTimeout(() => {
    if (image.isConnected) {
      image.srcset = cardImageSrcSet(card, nextAttempt);
      image.src = cardImageURL(card, nextAttempt);
    }
  }, 120 * nextAttempt);
}

function handleCardImageLoad(event) {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !image.dataset.cardImage) return;
  image.classList.remove("card-art-retrying", "card-art-load-error");
}

document.addEventListener("error", handleCardImageError, true);
document.addEventListener("load", handleCardImageLoad, true);
document.addEventListener("click", (event) => {
  document.querySelectorAll(".question-disclosure[open]").forEach((details) => {
    if (!details.contains(event.target)) details.open = false;
  });
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  document.querySelectorAll(".question-disclosure[open]").forEach((details) => {
    details.open = false;
    details.querySelector("summary")?.focus();
  });
});

function connectionErrorMessage() {
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(location.hostname);
  return local
    ? "暂时无法连接解读服务，请确认本地服务已启动。"
    : "与解读服务的连接中断，请稍后重试。若持续发生，请检查网络或服务器状态。";
}

function renderQuestion() {
  app.innerHTML = renderHomeMarkup(backArt, spreadIcon, state);

  const form = document.querySelector("#question-form");
  const input = document.querySelector("#question");
  const questionController = new AbortController();
  stageListeners = questionController;
  const resizeQuestionInput = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(140, Math.max(44, input.scrollHeight + 1))}px`;
  };
  input.addEventListener("input", resizeQuestionInput);
  window.addEventListener("resize", resizeQuestionInput, { signal: questionController.signal });
  resizeQuestionInput();
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
    state.framework = null;
    state.conversationId = null;
    state.followUpCount = 0;
    state.initialProvider = null;
    state.initialReading = "";
    state.chatMessages = [];
    state.conversationClosed = false;
    state.readingKey = crypto.randomUUID();
    state.followUpDraft = "";
    state.followUpImages = [];
    state.pendingFollowUp = null;
    state.resumeMode = "ready";
    state.attachmentWarning = false;
    state.userInfo = getUserInfo();
    go("shuffle");
  });
}

function renderShuffle() {
  state.isHolding = false;
  app.innerHTML = `<section class="ritual-screen shuffle-screen eclipse-scene screen-enter">
    <div class="ritual-top"><button class="ritual-back" id="back-question">${uiIcon("back")}<span>返回提问</span></button><span class="ritual-step">01 / 04</span>${questionToggle()}</div>
    <div class="eclipse-scene-layout">
    <header class="eclipse-scene-meta"><h1>洗牌</h1><span class="eclipse-scene-rule" aria-hidden="true"></span></header>
    <div class="shuffle-surface eclipse-scene-object" id="shuffle-surface">
      <div class="shuffle-glow" aria-hidden="true"><span class="ritual-orbit-light"></span><span class="ritual-orbit-dot"></span></div>
      <div class="shuffle-pile" id="shuffle-pile" tabindex="0" role="button" aria-label="按住牌面洗牌，松开牌面结束">${Array.from({ length: 14 }, (_, index) => `<div class="shuffle-card ${index % 4 === 1 ? "visually-reversed" : ""}" style="--stack-x:${(index - 7) * 1.1}px;--stack-y:${(7 - index) * 1.2}px;--tilt:${(index % 5 - 2) * .5}deg;--shuffle-delay:${-index * 67}ms">${backArt()}</div>`).join("")}</div>
    </div>
    <div class="ritual-hold-feedback"><div class="ritual-phase-marks" id="shuffle-phases" aria-hidden="true"><i></i><i></i><i></i><i></i></div><div class="ritual-instruction" id="shuffle-instruction" role="status" aria-live="polite"><strong>按住牌面洗牌</strong><small>松开结束</small></div></div>
    </div>
  </section>`;
  const screen = document.querySelector(".shuffle-screen");
  const controller = new AbortController();
  stageListeners = controller;
  const options = { signal: controller.signal };
  const preventSelection = (event) => event.preventDefault();
  screen.addEventListener("selectstart", preventSelection, options);
  screen.addEventListener("dragstart", preventSelection, options);
  document.querySelector("#back-question").addEventListener("click", () => go("question"), options);
  const pile = document.querySelector("#shuffle-pile");
  const cards = pile.querySelectorAll(".shuffle-card");
  const instruction = document.querySelector("#shuffle-instruction");
  const phases = document.querySelector("#shuffle-phases");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let holdTimer = null;
  let activePointer = null;
  let keyPending = false;
  let holdStartedAt = 0;
  let currentPhase = -1;
  let elapsedSeconds = -1;

  function updateHoldFeedback() {
    const elapsed = performance.now() - holdStartedAt;
    const phase = elapsed < 1600 ? 0 : elapsed < 4200 ? 1 : elapsed < 7000 ? 2 : 3;
    screen.style.setProperty("--hold-glow", Math.min(1, elapsed / 6000).toFixed(2));
    const seconds = Math.floor(elapsed / 1000);
    if (seconds !== elapsedSeconds) {
      elapsedSeconds = seconds;
      document.querySelector("#shuffle-elapsed").textContent = `已洗牌 ${seconds} 秒 · 松开后切牌`;
    }
    if (phase !== currentPhase) {
      currentPhase = phase;
      Array.from(phases.children).forEach((mark, index) => mark.classList.toggle("is-active", index <= phase));
    }
  }

  function beginShuffle() {
    holdTimer = null;
    if (state.stage !== "shuffle" || state.isHolding) return;
    state.isHolding = true;
    holdStartedAt = performance.now();
    pile.classList.remove("is-pressing");
    pile.classList.add("is-shuffling");
    screen.classList.remove("ritual-is-pressing");
    screen.classList.add("ritual-is-holding");
    instruction.innerHTML = `<strong>正在洗牌</strong><small id="shuffle-elapsed" aria-live="off"></small>`;
    updateHoldFeedback();
    shuffleInterval = setInterval(() => {
      state.deck = shuffle(state.deck);
      if (!reducedMotion) for (let i = 0; i < 3; i += 1) cards[Math.floor(Math.random() * cards.length)].classList.toggle("visually-reversed");
      updateHoldFeedback();
    }, 260);
  }
  function cancelPending() {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      timers.delete(holdTimer);
      holdTimer = null;
    }
    pile.classList.remove("is-pressing");
    screen.classList.remove("ritual-is-pressing");
  }
  function finishShuffle() {
    if (!state.isHolding || state.stage !== "shuffle") return;
    state.isHolding = false;
    if (shuffleInterval) clearInterval(shuffleInterval);
    shuffleInterval = null;
    state.deck = shuffle(state.deck).map((card) => ({ ...card, reversed: Math.random() < .28 }));
    pile.classList.remove("is-shuffling");
    pile.classList.add("is-settling");
    screen.classList.remove("ritual-is-holding", "ritual-is-pressing");
    screen.classList.add("ritual-is-settling");
    instruction.innerHTML = `<strong>洗牌完成</strong><small>正在收拢牌堆</small>`;
    later(() => go("cut"), reducedMotion ? 180 : 650);
  }
  pile.addEventListener("pointerdown", (event) => {
    if (activePointer || keyPending || state.isHolding || event.button !== 0 || !event.target.closest(".shuffle-card")) return;
    event.preventDefault();
    activePointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    pile.setPointerCapture(event.pointerId);
    pile.classList.add("is-pressing");
    screen.classList.add("ritual-is-pressing");
    holdTimer = later(beginShuffle, 300);
  }, options);
  pile.addEventListener("pointermove", (event) => {
    if (holdTimer === null || activePointer?.id !== event.pointerId) return;
    // 留出手指的自然移动空间；开始洗牌后由松手结束，不因轻微抖动中断。
    if (Math.hypot(event.clientX - activePointer.x, event.clientY - activePointer.y) > 48) cancelPending();
  }, options);
  function releasePointer(event) {
    if (activePointer?.id !== event.pointerId) return;
    activePointer = null;
    if (pile.hasPointerCapture(event.pointerId)) pile.releasePointerCapture(event.pointerId);
    if (holdTimer !== null) cancelPending();
    else finishShuffle();
  }
  pile.addEventListener("pointerup", releasePointer, options);
  pile.addEventListener("pointercancel", releasePointer, options);
  pile.addEventListener("lostpointercapture", releasePointer, options);
  pile.addEventListener("contextmenu", (event) => event.preventDefault(), options);
  pile.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || event.repeat || keyPending || activePointer || state.isHolding) return;
    event.preventDefault();
    keyPending = true;
    pile.classList.add("is-pressing");
    screen.classList.add("ritual-is-pressing");
    holdTimer = later(beginShuffle, 300);
  }, options);
  pile.addEventListener("keyup", (event) => {
    if (event.code !== "Space" || !keyPending) return;
    event.preventDefault();
    keyPending = false;
    if (holdTimer !== null) cancelPending();
    else finishShuffle();
  }, options);
  function releaseFocus() {
    activePointer = null;
    keyPending = false;
    if (holdTimer !== null) cancelPending();
    else finishShuffle();
  }
  pile.addEventListener("blur", releaseFocus, options);
  window.addEventListener("blur", releaseFocus, options);
  document.addEventListener("visibilitychange", () => { if (document.hidden) releaseFocus(); }, options);
  pile.focus({ preventScroll: true });
}

function renderCut() {
  app.innerHTML = `<section class="ritual-screen cut-screen eclipse-scene screen-enter">
    <div class="ritual-top"><button class="ritual-back" id="reshuffle-top">${uiIcon("back")}<span>重新洗牌</span></button><span class="ritual-step">02 / 04</span>${questionToggle()}</div>
    <div class="eclipse-scene-layout">
    <header class="eclipse-scene-meta"><h1>切牌</h1><span class="eclipse-scene-rule" aria-hidden="true"></span></header>
    <div class="cut-stage eclipse-scene-object"><div class="cut-halo" aria-hidden="true"><span class="ritual-orbit-light"></span></div><span class="cut-direction-cue cut-cue-left" aria-hidden="true">${uiIcon("back")}</span><span class="cut-direction-cue cut-cue-right" aria-hidden="true">${uiIcon("arrow")}</span><div class="cut-pile" id="cut-pile" role="button" tabindex="0" aria-label="向左或向右拖动切牌，移动一小段后松手。键盘可用左右方向键切牌"><div class="cut-half cut-bottom">${backArt()}</div><div class="cut-half cut-top">${backArt()}</div></div></div>
    <div class="eclipse-cut-controls">
    <div class="cut-feedback"><div class="cut-gesture-meter" aria-hidden="true"><i></i><span></span></div><p id="cut-feedback" role="status" aria-live="polite">左右滑动牌面进行切牌</p></div>
    <div class="cut-actions"><button class="ritual-primary cut-button" type="button" id="cut-done">去选牌 ${uiIcon("arrow")}</button></div>
    <p class="cut-count" id="cut-count">${state.cutCount ? `已切 ${state.cutCount} 次` : ""}</p>
    </div></div>
  </section>`;
  document.querySelector("#reshuffle-top").addEventListener("click", () => go("shuffle"));
  const pile = document.querySelector("#cut-pile");
  const done = document.querySelector("#cut-done");
  const screen = document.querySelector(".cut-screen");
  const feedback = document.querySelector("#cut-feedback");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
    const cutDistance = Math.min(180, Math.max(80, (screen.clientWidth - 170) / 2));
    pile.style.setProperty("--cut-x", `${direction * cutDistance}px`);
    pile.style.setProperty("--cut-tilt", `${direction * 4}deg`);
    pile.style.setProperty("--drag-x", "0px");
    pile.style.setProperty("--drag-tilt", "0deg");
    pile.classList.add("is-cutting");
    pile.setAttribute("aria-busy", "true");
    done.disabled = true;
    screen.classList.add("ritual-is-cutting");
    screen.classList.remove("cut-ready");
    screen.dataset.cutDirection = direction < 0 ? "left" : "right";
    feedback.textContent = `${direction < 0 ? "向左" : "向右"}切牌，牌正在收拢`;
    document.querySelector("#cut-count").textContent = `已切 ${state.cutCount} 次`;
    later(() => {
      if (state.stage !== "cut") return;
      pile.classList.remove("is-cutting");
      pile.setAttribute("aria-busy", "false");
      screen.classList.remove("ritual-is-cutting");
      screen.style.setProperty("--cut-progress", "0");
      delete screen.dataset.cutDirection;
      cutting = false;
      done.hidden = false;
      done.disabled = false;
      feedback.textContent = "左右滑动牌面进行切牌";
    }, reducedMotion ? 180 : 550);
  }

  function start(x, y, kind, identifier = null) {
    if (cutting || gesture || state.stage !== "cut") return;
    gesture = { x, y, kind, identifier, dx: 0, horizontal: false, direction: "", ready: false };
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
    pile.style.setProperty("--drag-tilt", `${gesture.dx / 40}deg`);
    const direction = gesture.dx < -8 ? "left" : gesture.dx > 8 ? "right" : "";
    const ready = Math.abs(gesture.dx) >= 48;
    screen.style.setProperty("--cut-progress", Math.min(1, Math.abs(gesture.dx) / 48).toFixed(2));
    screen.classList.toggle("cut-ready", ready);
    screen.dataset.cutDirection = direction;
    if (direction !== gesture.direction || ready !== gesture.ready) {
      gesture.direction = direction;
      gesture.ready = ready;
      feedback.textContent = ready ? "现在松手，完成这次切牌" : direction ? `继续${direction === "left" ? "向左" : "向右"}移动一点` : "左右滑动牌面进行切牌";
    }
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
      pile.style.setProperty("--drag-tilt", "0deg");
      screen.style.setProperty("--cut-progress", "0");
      screen.classList.remove("cut-ready");
      delete screen.dataset.cutDirection;
      feedback.textContent = "左右滑动牌面进行切牌";
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
  pile.focus({ preventScroll: true });
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
    <div class="ritual-top"><span class="ritual-fan-label">选牌</span><span class="ritual-step">03 / 04</span>${questionToggle()}</div>
    <div class="fan-draw-layout">
      <div class="fan-selection-panel">
        <div class="selection-tray selection-tray-${state.spread}" id="selection-tray">${positionLabels().map((label, index) => `<div class="tray-item"><div class="tray-slot" id="selection-slot-${index}"><span>${String(index + 1).padStart(2, "0")}</span></div><small>${label === "希望与恐惧" ? "<span>希望与</span><wbr><span>恐惧</span>" : label}</small></div>`).join("")}</div>
        <div class="fan-status"><strong id="fan-selection-count">左右滑动选牌</strong><span class="sr-only" id="fan-instruction">左右滑动牌堆，点击一张牌</span></div>
      </div>
      <div class="fan-area" id="fan-area" tabindex="0" role="group" aria-label="横向弧形塔罗牌堆。左右滑动浏览，点击一次让牌浮起，再点击同一张确认选择。键盘可用左右方向键浏览、回车确认。">
        <div class="fan-arc-glow" aria-hidden="true"></div>
        ${state.deck.map(fanBack).join("")}
      </div>
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
    // 浮起的牌位于最高层，优先采用浏览器实际命中的整张牌；这样牌面边缘、图片和装饰都能确认选择。
    const targetedCardId = event.target.closest?.(".fan-card.is-hovered")?.dataset.cardId;
    const pressedCard = targetedCardId
      ? getRemaining().find((card) => card.id === targetedCardId)
      : cardAtPoint(event.clientX, event.clientY, true);
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
  const cardWidth = area.querySelector(".fan-card").offsetWidth;
  const compact = cardWidth <= 132;
  const radius = compact ? Math.max(355, width * 1.02) : Math.max(500, Math.min(700, width * .58));
  // 露出宽度由原来的 13% 增加 10%，拖动、惯性与命中共用同一个步长。
  // 沿用原来的区域宽度档位，避免中等宽度手机的露出量因实际牌宽而缩小。
  const spacingWidth = width < 560 ? 132 : 165;
  const stepAngle = spacingWidth * .143 / radius;
  return {
    area,
    width,
    height,
    compact,
    radius,
    stepAngle,
    // 弧度与牌尺寸保持，让展开后的牌扇自然铺满左右两侧。
    maxAngle: compact ? .72 : .78,
    pixelsPerCard: radius * stepAngle,
    cx: width / 2,
    cy: 0,
    // 固定上缘余量，使牌扇靠近牌位，并给浮起的整张牌留出空间。
    centerY: compact ? 145 : 195,
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
  const focusLift = fanMetrics().compact ? 30 : 48;
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
  // 第一次点击浮起牌时已开始预载正面；确认选择不能继续等待网络或图片解码。
  preloadCardImage(card);
  const index = state.selected.length;
  const element = document.querySelector(`[data-card-id="${card.id}"]`);
  const tray = document.querySelector("#selection-tray");
  const slot = document.querySelector(`#selection-slot-${index}`);
  tray.scrollLeft = slot.offsetLeft - tray.clientWidth / 2 + slot.clientWidth / 2;
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
  // 强制记录初始位置后，下一次绘制立刻同时开始翻面与飞行。
  flight.getBoundingClientRect();
  flight.classList.add("is-flipped", "is-flying");
  await pause(720);
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
    // 动画继续即时执行，同时给最后一张牌最多 1.4 秒完成加载；其余牌通常已在第一次浮起时完成预载。
    await Promise.all([
      pause(450),
      Promise.race([
        Promise.all(state.selected.map(preloadCardImage)),
        pause(1400),
      ]),
    ]);
    if (state.stage !== "fan") return;
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

function replyParagraphs(text) {
  return String(text).split(/\n[ \t]*\n+/).filter((paragraph) => paragraph.trim());
}

function outputText(output) {
  return output.classList.contains("chat-reply-copy") ? (output.dataset.replyText || "") : output.textContent;
}

function renderOutputText(output, text) {
  if (!output.classList.contains("chat-reply-copy")) {
    output.textContent = text;
    return;
  }
  // The transcript keeps its exact newlines; the bubbles are only a visual view of it.
  output.dataset.replyText = text;
  const paragraphs = replyParagraphs(text);
  const bubbles = [...output.children];
  paragraphs.forEach((paragraph, index) => {
    let bubble = bubbles[index];
    if (!bubble || !bubble.classList.contains("chat-bubble")) {
      bubble = document.createElement("div");
      bubble.className = "chat-bubble";
      const copy = document.createElement("p");
      copy.className = "chat-bubble-copy";
      bubble.append(copy);
      output.append(bubble);
    }
    bubble.querySelector(".chat-bubble-copy").textContent = paragraph;
  });
  [...output.children].slice(paragraphs.length).forEach((bubble) => bubble.remove());
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
  let nextBubbleAt = 0;
  const pacedBubbles = output.classList.contains("chat-reply-copy") && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
    if (performance.now() < nextBubbleAt) {
      requestAnimationFrame(typeNext);
      return;
    }
    if (characters.length) {
      rendered += characters.shift();
      renderOutputText(output, rendered);
      if (pacedBubbles && /\S[^\n]*\n[ \t]*\n$/.test(rendered)) nextBubbleAt = performance.now() + 180;
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
    if (typeof payload.content === "string") {
      // 后端会移除三牌框架标记；这里再兜底，避免任何内部协议文字出现在解读中。
      const publicContent = payload.content.replace(/ARCANA\\?_FRAMEWORK\s*[:：]\s*[a-z_]+/gi, "");
      queueText(publicContent);
    }
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
      // The server's done event is the final confirmation. Waiting for a separate
      // network EOF can turn a complete reply into a false failure on reconnect.
      if (done) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    buffer += decoder.decode();
    consumeBuffer();
    if (buffer.trim()) readEvent(buffer);
    if (signal?.aborted) throw new DOMException("回应已暂停。", "AbortError");
    if (!done) throw new Error("解读连接提前结束，请重试。");
    await typingFinished;
    if (signal?.aborted) throw new DOMException("回应已暂停。", "AbortError");
    return received;
  } catch (error) {
    failed = true;
    characters.length = 0;
    renderOutputText(output, rendered);
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

async function fetchFollowUp(message, images, output, signal, onFirstContent, requestId = undefined) {
  const provider = getActiveProvider();
  let completion = null;
  const response = await fetch("/api/follow-up", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationId: state.conversationId,
      message,
      images,
      userInfo: getUserInfo(),
      ...(requestId ? { requestId } : {}),
      ...(provider ? { provider } : {}),
    }),
    signal,
  });
  try {
    await streamToOutput(response, output, (payload) => {
      if (payload.done) completion = payload;
    }, onFirstContent, signal);
  } catch (error) {
    // A finished server reply may still be revealing characters locally when paused.
    // Respect its confirmed round count rather than leaving the UI behind the server.
    if (completion) {
      state.followUpCount = completion.rounds;
      error.streamCompletion = completion;
    }
    throw error;
  }
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
  const retryAvailable = message.error && message === state.chatMessages.at(-1) && !state.conversationClosed && state.resumeMode === "ready";
  const attachments = Array.isArray(message.images)
    ? `<div class="chat-attachments">${message.images.map((image) => safeLocalImage(image)).filter(Boolean).map((image) => `<img src="${escapeHTML(image)}" alt="本轮上传的图片">`).join("")}</div>`
    : "";
  const copy = message.loading
    ? `<p class="chat-bubble-copy"><span class="typing-dots" aria-label="塔罗师正在回应"><i></i><i></i><i></i></span></p>`
    : message.text ? `<p class="chat-bubble-copy">${escapeHTML(message.text)}</p>` : "";
  const reply = message.loading
    ? `<div class="chat-bubble">${copy}</div>`
    : replyParagraphs(message.text || "").map((paragraph) => `<div class="chat-bubble"><p class="chat-bubble-copy">${escapeHTML(paragraph)}</p></div>`).join("");
  const body = user
    ? `<div class="chat-message-body"><div class="chat-bubble">${attachments}${copy}</div></div>`
    : `<div class="chat-message-body"><div class="chat-reply-copy" data-reply-text="${escapeHTML(message.text || "")}">${reply}</div>${retryAvailable ? `<button class="retry-follow-up" data-retry-follow-up type="button">${uiIcon("restart")}<span>重试这次提问</span></button>` : ""}</div>`;
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
      <div class="reading-drawer-content" tabindex="0" aria-label="牌面与完整解读">
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
  return element.querySelector(".chat-reply-copy") || element.querySelector(".chat-bubble-copy");
}

function replaceFailedFollowUp(messages) {
  const answerRecord = state.chatMessages.at(-1);
  const userRecord = state.chatMessages.at(-2);
  if (!answerRecord?.error || userRecord?.role !== "user") return null;
  // Only the failed turn is replaced; earlier successful replies stay in place.
  state.chatMessages.splice(-2);
  messages.lastElementChild?.remove();
  messages.lastElementChild?.remove();
  return userRecord;
}

function followUpRequestSignature(message, images) {
  return JSON.stringify({ message, images, userInfo: getUserInfo(), provider: getActiveProvider() });
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
  let selectedImages = state.followUpImages.map((dataUrl, index) => ({ name: `图片 ${index + 1}`, dataUrl }));
  input.value = state.followUpDraft;
  input.addEventListener("input", () => { state.followUpDraft = input.value; queueReadingSnapshot(); });
  form.querySelector("[data-reconnect-conversation]")?.addEventListener("click", () => {
    state.resumeMode = "checking"; render(); syncCurrentConversation();
  });

  messages.addEventListener("click", (event) => {
    const retry = event.target.closest("[data-retry-follow-up]");
    if (!retry || activeConversationRequest || state.conversationClosed || state.resumeMode !== "ready") return;
    const failedAnswer = state.chatMessages.at(-1);
    const failedUser = state.chatMessages.at(-2);
    if (!failedAnswer?.error || failedUser?.role !== "user") return;
    input.value = failedUser.message ?? failedUser.text;
    if (failedUser.imagesOmitted && !selectedImages.length) {
      status.textContent = "请重新选择这次提问的图片，再重试。";
      imageInput.click();
      return;
    }
    if (!failedUser.imagesOmitted) selectedImages = (failedUser.images || []).map((dataUrl, index) => ({ name: `图片 ${index + 1}`, dataUrl }));
    renderImagePreview();
    form.requestSubmit();
  });

  function renderImagePreview() {
    state.followUpImages = selectedImages.map((image) => image.dataUrl);
    imagePreview.hidden = !selectedImages.length;
    imagePreview.innerHTML = selectedImages.map((image, index) => `<span><img src="${escapeHTML(image.dataUrl)}" alt="${escapeHTML(image.name)}"><button type="button" data-remove-image="${index}" aria-label="移除${escapeHTML(image.name)}">${uiIcon("close")}</button></span>`).join("");
    imagePreview.querySelectorAll("[data-remove-image]").forEach((remove) => remove.addEventListener("click", () => {
      selectedImages.splice(Number(remove.dataset.removeImage), 1);
      renderImagePreview();
    }));
    queueReadingSnapshot();
  }
  renderImagePreview();

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
    if (state.conversationClosed || activeConversationRequest || state.resumeMode !== "ready") return;
    if (!await confirmReadingAction({ trigger: endButton, title: "结束这次对话？",
      description: "结束后仍可查看。", confirmLabel: "结束对话" })) return;
    const key = state.readingKey;
    input.disabled = true;
    button.disabled = true;
    endButton.disabled = true;
    imageInput.disabled = true;
    status.textContent = "正在结束这次对话…";
    try {
      const response = await fetch("/api/conversation/end", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: state.conversationId }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "暂时无法结束对话，请稍后重试。");
      }
      if (state.readingKey !== key) return;
      state.conversationClosed = true;
      state.pendingFollowUp = null;
      const closing = { role: "assistant", text: "这次牌已经收好。剩下的答案，要交给你接下来的选择。" };
      state.chatMessages.push(closing);
      appendConversationMessage(messages, closing);
      form.classList.add("is-closed");
      input.placeholder = "这次对话已经结束";
      imageInput.disabled = true;
      status.textContent = "这次牌已经收好。想聊新的议题时，可以重新抽牌。";
      persistCurrentReading();
    } catch (error) {
      if (state.readingKey !== key) return;
      input.disabled = false; button.disabled = false; endButton.disabled = false; imageInput.disabled = false;
      status.textContent = error.message || "暂时无法连接，当前对话已保留。";
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = input.value.trim();
    const images = selectedImages.map((image) => image.dataUrl);
    if ((!message && !images.length) || state.followUpCount >= 8 || state.conversationClosed || state.resumeMode !== "ready" || activeConversationRequest) { input.focus(); return; }
    input.value = "";
    state.followUpDraft = "";
    selectedImages = [];
    renderImagePreview();
    input.disabled = true;
    button.disabled = true;
    button.hidden = true;
    stopButton.hidden = false;
    endButton.disabled = true;
    imageInput.disabled = true;
    status.textContent = "";
    const failedUser = replaceFailedFollowUp(messages);
    const requestSignature = followUpRequestSignature(message, images);
    const requestId = failedUser?.requestSignature === requestSignature && failedUser.requestId
      ? failedUser.requestId : crypto.randomUUID();
    const userRecord = { role: "user", text: message || "发送了图片", message, images, requestId, requestSignature };
    const answerRecord = { role: "assistant", text: "" };
    state.pendingFollowUp = { requestId, roundsBefore: state.followUpCount };
    state.chatMessages.push(userRecord, answerRecord);
    appendConversationMessage(messages, userRecord);
    const answerText = appendConversationMessage(messages, { role: "assistant", text: "", loading: true });
    const controller = new AbortController();
    controller.finished = new Promise((resolve) => { controller.finish = resolve; });
    activeConversationRequest = controller;
    activeResponseElement = answerText;
    persistCurrentReading();
    try {
      const completion = await fetchFollowUp(message, images, answerText, controller.signal, () => { renderOutputText(answerText, ""); }, requestId);
      answerRecord.text = outputText(answerText);
      state.pendingFollowUp = null;
      const remaining = Math.max(0, 8 - state.followUpCount);
      screen.querySelector("#follow-up-count").textContent = remaining ? `剩余 ${remaining} 轮追问` : "已完成 8 轮追问";
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
        renderOutputText(answerText, outputText(answerText).trim() || "回应已暂停。");
        answerRecord.text = outputText(answerText);
        answerRecord.stopped = true;
        bubble.classList.add("is-stopped");
        if (error.streamCompletion) {
          state.pendingFollowUp = null;
          const remaining = Math.max(0, 8 - state.followUpCount);
          screen.querySelector("#follow-up-count").textContent = remaining ? `剩余 ${remaining} 轮追问` : "已完成 8 轮追问";
          if (error.streamCompletion.closed) {
            state.conversationClosed = true;
            form.classList.add("is-closed");
            input.placeholder = "这次对话已经结束";
          }
          status.textContent = "已暂停逐字展示。";
        } else {
          status.textContent = "已暂停。这轮不会计入次数，你可以重新输入。";
        }
      } else {
        bubble.classList.add("is-error");
        const partialReply = outputText(answerText).trim();
        const errorMessage = (error instanceof TypeError ? "连接中断，还没有收到完整回应。" : (error.message || "回应失败，请稍后再试。"))
          .replace(/[，,]\s*请(?:稍后)?(?:再试一次|重试|再试)[。.!！]?$/, "。");
        renderOutputText(answerText, `${partialReply}${partialReply ? "\n\n" : ""}${errorMessage}`);
        answerRecord.text = outputText(answerText);
        answerRecord.error = true;
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "retry-follow-up";
        retry.dataset.retryFollowUp = "";
        retry.innerHTML = `${uiIcon("restart")}<span>重试这次提问</span>`;
        bubble.querySelector(".chat-message-body").append(retry);
        status.textContent = "";
        input.value = message;
        state.followUpDraft = message;
        selectedImages = images.map((dataUrl, index) => ({ name: `图片 ${index + 1}`, dataUrl }));
        renderImagePreview();
      }
    } finally {
      if (activeConversationRequest === controller) activeConversationRequest = null;
      if (activeResponseElement === answerText) activeResponseElement = null;
      stopButton.hidden = true;
      button.hidden = false;
      if (!state.conversationClosed && state.followUpCount < 8) {
        input.disabled = false;
        button.disabled = false;
        endButton.disabled = false;
        imageInput.disabled = false;
        input.focus();
      }
      persistCurrentReading();
      controller.finish();
    }
  });
}

function renderConversation() {
  const remaining = Math.max(0, 8 - state.followUpCount);
  const locked = state.conversationClosed || state.resumeMode !== "ready";
  const notice = resumeNotice() || (state.conversationClosed ? "这次对话已经结束，已有内容仍可查看。" : "");
  app.innerHTML = `<section class="conversation-screen eclipse-conversation screen-enter">
    <header class="conversation-toolbar">
      <button class="conversation-back" id="back-to-reading" type="button">${uiIcon("back")}<span>牌面与解读</span></button>
      <span class="conversation-label">继续对话</span>
      <div class="conversation-context-actions"><button class="conversation-context-button" id="open-reading-context" type="button" aria-label="展开牌面与解读" title="查看牌面与解读">${uiIcon("cards")}<span>牌面</span></button>${questionToggle()}</div>
    </header>
    <div class="conversation-messages" id="conversation-messages" aria-live="polite">${state.chatMessages.map(conversationBubble).join("")}</div>
    <form id="follow-up-form" class="conversation-compose ${state.conversationClosed ? "is-closed" : ""}">
      <div id="follow-up-image-preview" class="follow-up-image-preview" hidden></div>
      <div class="conversation-input-row">
        <label class="image-upload-button" aria-label="上传本地图片" title="上传图片"><input id="follow-up-images" type="file" accept="image/jpeg,image/png,image/webp" multiple ${locked ? "disabled" : ""}>${uiIcon("image")}</label>
        <label class="sr-only" for="follow-up-input">继续追问</label>
        <textarea id="follow-up-input" maxlength="2000" rows="1" placeholder="${state.conversationClosed ? "这次对话已经结束" : state.resumeMode === "expired" ? "已有对话仍可查看" : "继续追问…"}" ${locked ? "disabled" : ""}></textarea>
      </div>
      <div class="conversation-compose-actions"><small id="follow-up-count" class="conversation-round-count">${remaining ? `剩余 ${remaining} 轮追问` : "已完成 8 轮追问"}</small><p id="follow-up-status" class="follow-up-status" role="status">${escapeHTML(notice)}${state.resumeMode === "offline" ? ' <button type="button" class="conversation-reconnect" data-reconnect-conversation>重新连接</button>' : ""}</p><button id="end-conversation" class="end-conversation" type="button" ${locked ? "disabled" : ""}>结束对话</button><button id="stop-follow-up" class="stop-follow-up" type="button" aria-label="暂停回应" hidden>${uiIcon("pause")}<span class="sr-only">暂停</span></button><button class="send-follow-up" type="submit" aria-label="发送追问" ${locked ? "disabled" : ""}><span class="sr-only">发送</span>${uiIcon("arrow")}</button></div>
    </form>
    ${readingDrawerHTML()}
  </section>`;
  const screen = document.querySelector(".conversation-screen");
  const messages = screen.querySelector("#conversation-messages");
  messages.scrollTop = messages.scrollHeight;
  screen.querySelector("#back-to-reading").addEventListener("click", (event) => returnToReading(event.currentTarget));
  const drawer = screen.querySelector("#reading-drawer");
  const openDrawer = screen.querySelector("#open-reading-context");
  const closeDrawer = screen.querySelector("#close-reading-drawer");
  const drawerController = new AbortController();
  stageListeners = drawerController;
  const closeReadingContext = () => { drawer.hidden = true; openDrawer.focus(); };
  openDrawer.addEventListener("click", () => { drawer.hidden = false; closeDrawer.focus(); });
  closeDrawer.addEventListener("click", closeReadingContext);
  drawer.addEventListener("click", (event) => { if (event.target === drawer) closeReadingContext(); });
  document.addEventListener("keydown", (event) => {
    if (drawer.hidden) return;
    if (event.key === "Escape") { event.preventDefault(); closeReadingContext(); }
    if (event.key === "Tab") {
      const content = drawer.querySelector(".reading-drawer-content");
      if (event.shiftKey && document.activeElement === closeDrawer) { event.preventDefault(); content.focus(); }
      if (!event.shiftKey && document.activeElement === content) { event.preventDefault(); closeDrawer.focus(); }
    }
  }, { signal: drawerController.signal });
  bindConversationForm(screen);
}

function renderResult() {
  app.innerHTML = `<section class="ritual-screen result-screen eclipse-result eclipse-result-${state.spread} screen-enter">
    <div class="ritual-top result-top"><button class="ritual-back" id="start-over">${uiIcon("back")}<span>重新开始</span></button><span class="ritual-step">04 / 04</span>${questionToggle()}</div>
    <div class="eclipse-result-grid">
    <section class="eclipse-spread-panel" aria-label="本次牌阵"><header class="eclipse-spread-heading"><h1>你的牌阵</h1></header>
    <div class="result-layout result-layout-${state.spread}">${state.selected.map(resultCard).join("")}</div>
    </section>
    <section class="eclipse-reading-panel" aria-label="本次解读"><header class="eclipse-reading-heading"><h2>解读</h2></header>
    <div class="result-actions"><button class="ritual-primary" id="interpret" type="button">开始解读</button><p></p></div>
    </section></div>
  </section>`;
  document.querySelector("#start-over").addEventListener("click", (event) => restartReading(event.currentTarget));
  const button = document.querySelector("#interpret");
  const actions = document.querySelector(".result-actions");
  if (state.initialReading) {
    document.querySelector(".result-screen").classList.add("has-reading");
    const output = createReadingOutput(actions);
    output.textContent = state.initialReading;
    output.scrollTop = 0;
    button.textContent = state.conversationClosed || state.resumeMode === "expired" ? "查看对话" : state.chatMessages.length ? "回到对话" : "继续对话";
    button.dataset.action = "conversation";
  }
  button.addEventListener("click", async () => {
    if (button.dataset.action === "conversation") {
      go("conversation");
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
    controller.finished = new Promise((resolve) => { controller.finish = resolve; });
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
      persistCurrentReading();
      output.textContent = state.initialReading;
      const note = actions.querySelector("p");
      if (isLoggedIn() && state.userInfo?.enabled && state.userInfo?.id) {
        try {
          await saveCompletedReading(summary, state.initialReading);
          note.textContent = "已保存到历史牌阵";
        } catch (saveError) {
          note.textContent = `解读已完成，但记录保存失败：${saveError.message}`;
        }
      } else if (isLoggedIn()) {
        note.textContent = "开启个人信息后，可以保存本次记录";
      } else {
        note.textContent = "登录后可保存本次记录";
      }
      button.textContent = "继续对话";
      button.dataset.action = "conversation";
    } catch (error) {
      if (error?.name === "AbortError") return;
      revealReading();
      const message = error instanceof TypeError
        ? connectionErrorMessage()
        : error.message?.includes("请先设置环境变量")
          ? "还没有可用的模型。点击左上角头像，在个人中心的供应商页面添加模型。"
        : (error.message || "解读暂时失败，请稍后重试。");
      output.textContent += `${output.textContent ? "\n\n" : ""}${message}`;
      button.textContent = "重新解读";
    } finally {
      if (activeReadingRequest === controller) activeReadingRequest = null;
      if (document.body.contains(button)) button.disabled = false;
      controller.finish();
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
initializeAuth(async () => {
  const owner = readingOwner();
  if (!authInitialized) {
    authInitialized = true; snapshotOwner = owner;
    if (!state.initialReading && state.stage === "question") restoreCurrentReading();
    else persistCurrentReading();
    return;
  }
  if (snapshotOwner === owner) return;
  cancelSessionSync();
  await stopCurrentResponse();
  resetReadingState(); snapshotOwner = owner;
  go("question", { historyMode: "replace" });
  restoreCurrentReading();
});
if (!history.state?.arcanaView) history.replaceState({ ...history.state, arcanaView: "question", arcanaReading: null }, "", location.href);
window.addEventListener("pagehide", persistCurrentReading);
document.addEventListener("visibilitychange", () => { if (document.hidden) persistCurrentReading(); });
window.addEventListener("beforeunload", (event) => {
  persistCurrentReading();
  if (activeReadingRequest || activeConversationRequest) { event.preventDefault(); event.returnValue = ""; }
});
window.addEventListener("pageshow", async (event) => {
  if (event.persisted && state.initialReading) {
    await stopCurrentResponse();
    state.resumeMode = "checking"; render(); syncCurrentConversation();
  }
});
window.addEventListener("popstate", async (event) => {
  if (location.hash || document.querySelector("#provider-settings, #account-overlay")) return;
  const view = event.state?.arcanaView;
  if (event.state?.arcanaReading === state.readingKey && state.selected.length) {
    if (view === state.stage) { recordReadingNavigation("replace"); return; }
    if (view === "result") { await returnToReading(document.querySelector("#back-to-reading"), true); return; }
    if (view === "conversation" && state.initialReading) { go("conversation", { historyMode: "none" }); return; }
    if (view === "question" && (state.initialReading || activeReadingRequest)) {
      recordReadingNavigation("push");
      await restartReading(document.querySelector("#start-over"));
      return;
    }
  }
  // Discarded readings must never be reconstructed from an old browser-history marker.
  recordReadingNavigation("replace");
});
render();
