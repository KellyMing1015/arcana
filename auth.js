import {
  disconnectAccountSettings,
  flushAccountSettings,
  getUserProfiles,
  syncAccountSettings,
} from "./settings.js";

const LOCAL_HISTORY_PREFIX = "arcana_history_";

let authUser = null;
let onAuthChange = () => {};
let cloudHistoryProfileId = null;

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

async function requestJSON(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "请求没有成功，请稍后重试。");
    error.status = response.status;
    throw error;
  }
  return payload;
}

export function getCurrentUser() { return authUser; }
export function isLoggedIn() { return Boolean(authUser); }

function localHistoryEntries() {
  const entries = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(LOCAL_HISTORY_PREFIX)) continue;
    try {
      const records = JSON.parse(localStorage.getItem(key) || "[]");
      if (Array.isArray(records)) entries.push({ key, records });
    } catch {
      // 损坏的旧数据保留在本机，不参与迁移。
    }
  }
  return entries;
}

function migrationRecords(entries) {
  const names = new Map(getUserProfiles().map((profile) => [profile.id, profile.nickname]));
  return entries.flatMap(({ key, records }) => {
    const profileId = key.slice(LOCAL_HISTORY_PREFIX.length);
    const profileNickname = names.get(profileId) || "未命名用户";
    return records.map((record) => ({ record, profileId, profileNickname }));
  }).flatMap(({ record, profileId, profileNickname }) => {
    if (!record || typeof record !== "object" || !Array.isArray(record.cards)) return [];
    return [{
      profile_id: profileId,
      profile_nickname: profileNickname,
      createdAt: record.createdAt,
      question: record.question || "",
      spread: record.spread,
      spread_type: record.spreadLabel,
      cards: record.cards,
      summary: record.summary || "",
      full_reading: record.fullReading || "",
    }];
  });
}

function closeOverlay() {
  document.querySelector("#account-overlay")?.remove();
  document.body.classList.remove("account-open");
  const shell = document.querySelector(".site-shell");
  if (shell) shell.inert = Boolean(document.querySelector("#provider-settings"));
  if (["#login", "#register", "#history"].includes(location.hash)) history.replaceState(null, "", location.pathname + location.search);
  document.querySelector("#account-button")?.focus();
}

function createOverlay(label) {
  document.querySelector("#account-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "account-overlay";
  overlay.className = "account-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", label);
  document.body.append(overlay);
  document.body.classList.add("account-open");
  document.querySelector(".site-shell").inert = true;
  return overlay;
}

function authPage(mode) {
  const register = mode === "register";
  const overlay = createOverlay(register ? "注册 Arcana" : "登录 Arcana");
  location.hash = register ? "register" : "login";
  overlay.innerHTML = `<main class="auth-page">
    <button class="auth-close" type="button" aria-label="返回抽牌">← 返回</button>
    <section class="auth-card">
      <span class="auth-sigil" aria-hidden="true">✦</span>
      <p class="eyebrow">ARCANA ACCOUNT</p>
      <h1>${register ? "创建你的 Arcana 账号" : "欢迎回来"}</h1>
      ${register ? `<p class="auth-intro">登录后，牌阵记录会安全地保存在你的云端账号中。</p>` : ""}
      <form id="auth-form" novalidate>
        ${register ? `<label><span>昵称</span><input name="nickname" type="text" maxlength="80" autocomplete="nickname" placeholder="希望 Arcana 怎么称呼你" required></label>` : ""}
        <label><span>邮箱</span><input name="email" type="email" maxlength="254" autocomplete="email" placeholder="name@example.com" required></label>
        <label><span>密码</span><input name="password" type="password" minlength="8" maxlength="72" autocomplete="${register ? "new-password" : "current-password"}" placeholder="至少 8 位" required></label>
        ${register ? `<label><span>确认密码</span><input name="confirmPassword" type="password" minlength="8" maxlength="72" autocomplete="new-password" placeholder="再次输入密码" required></label>` : ""}
        <button class="auth-submit" type="submit">${register ? "注册并登录" : "登录"}</button>
        <p id="auth-feedback" class="auth-feedback" role="status" aria-live="polite"></p>
      </form>
      <button class="auth-switch" type="button">${register ? "已经有账号？直接登录" : "还没有账号？创建一个"}</button>
    </section>
  </main>`;
  overlay.querySelector(".auth-close").addEventListener("click", closeOverlay);
  overlay.querySelector(".auth-switch").addEventListener("click", () => authPage(register ? "login" : "register"));
  overlay.querySelector("#auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const feedback = overlay.querySelector("#auth-feedback");
    const submit = form.querySelector(".auth-submit");
    const body = {
      email: form.elements.email.value.trim(),
      password: form.elements.password.value,
      ...(register ? { nickname: form.elements.nickname.value.trim() } : {}),
    };
    if (register && !body.nickname) { feedback.textContent = "请填写昵称。"; return; }
    if (!body.email || !body.password) { feedback.textContent = "请把邮箱和密码填写完整。"; return; }
    if (register && form.elements.confirmPassword.value !== body.password) { feedback.textContent = "两次输入的密码不一致。"; return; }
    submit.disabled = true;
    submit.textContent = register ? "正在创建账号…" : "正在登录…";
    feedback.textContent = "";
    try {
      const payload = await requestJSON(register ? "/api/register" : "/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      authUser = payload.user;
      let syncError = null;
      try {
        await syncAccountSettings(authUser.id, authUser.nickname);
      } catch (error) {
        syncError = error;
        console.warn("Arcana account settings sync failed", error);
      }
      closeOverlay();
      updateAccountHeader();
      onAuthChange(authUser);
      if (syncError) window.alert(`账号已登录，但用户信息和供应商同步失败：${syncError.message}`);
      await offerHistoryMigration();
    } catch (error) {
      feedback.textContent = error.message;
      feedback.classList.add("is-error");
    } finally {
      submit.disabled = false;
      submit.textContent = register ? "注册并登录" : "登录";
    }
  });
  overlay.querySelector("input")?.focus();
}

async function offerHistoryMigration() {
  const entries = localHistoryEntries();
  const records = migrationRecords(entries);
  if (!authUser || !records.length) return;
  const overlay = createOverlay("同步本地历史记录");
  overlay.innerHTML = `<section class="migration-dialog">
    <span class="auth-sigil" aria-hidden="true">✦</span>
    <h2>检测到本地历史记录</h2>
    <p>发现 ${records.length} 条保存在这个浏览器里的牌阵。是否同步到云端账号？</p>
    <div><button class="migration-later" type="button">暂不同步</button><button class="migration-confirm" type="button">同步到云端</button></div>
    <p class="auth-feedback" role="status" aria-live="polite"></p>
  </section>`;
  overlay.querySelector(".migration-later").addEventListener("click", closeOverlay);
  overlay.querySelector(".migration-confirm").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const feedback = overlay.querySelector(".auth-feedback");
    button.disabled = true;
    button.textContent = "正在同步…";
    try {
      await requestJSON("/api/readings/migrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ readings: records }),
      });
      entries.forEach(({ key }) => localStorage.removeItem(key));
      feedback.textContent = `已同步 ${records.length} 条记录。`;
      setTimeout(closeOverlay, 700);
    } catch (error) {
      feedback.textContent = error.message;
      feedback.classList.add("is-error");
      button.disabled = false;
      button.textContent = "重新同步";
    }
  });
}

function formatCloudTime(value) {
  if (!value) return "";
  const parsed = new Date(String(value).replace(" ", "T") + (String(value).includes("Z") ? "" : "Z"));
  if (Number.isNaN(parsed.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(parsed);
}

function cloudCards(record) {
  return `<div class="history-card-thumbnails ${record.cards.length === 10 ? "history-card-thumbnails-10" : ""}">${record.cards.map((card) => `<figure class="history-card-thumb"><img src="/assets/cards/${escapeHTML(card.id)}.webp" alt="${escapeHTML(card.chinese || "塔罗牌")}" style="transform:rotate(${card.reversed ? 180 : 0}deg)"><figcaption>${escapeHTML(card.chinese || "塔罗牌")}</figcaption></figure>`).join("")}</div>`;
}

function historyContent(records) {
  if (!records.length) return `<div class="history-empty"><span>◇</span><strong>还没有历史牌阵</strong><p>完成一次解读后，它会自动保存在这里。</p></div>`;
  return `<section class="history-timeline" aria-label="历史牌阵列表">${records.map((record) => `<article class="history-entry cloud-history-entry" data-history-id="${record.id}">
    <span class="history-dot" aria-hidden="true"></span>
    <div class="history-swipe-shell">
      <button class="history-delete-button" type="button" tabindex="-1" data-cloud-history-delete="${record.id}" aria-label="删除这条历史牌阵">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>
        <span>删除</span>
      </button>
      <div class="history-bubble">
        <header><time>${escapeHTML(formatCloudTime(record.created_at))}</time><span>${escapeHTML(record.spread_type)}</span></header>
        <p class="history-question">Q // ${escapeHTML(record.question)}</p>
        <blockquote>“${record.summary ? escapeHTML(record.summary) : "这条旧记录没有独立总结。"}”</blockquote>
        ${cloudCards(record)}
        ${record.full_reading ? `<details class="cloud-reading-details"><summary>查看完整解读</summary><p>${escapeHTML(record.full_reading)}</p></details>` : ""}
      </div>
    </div>
  </article>`).join("")}</section>`;
}

function bindCloudHistory(overlay, onDeleted = () => {}) {
  let openEntry = null;
  const revealWidth = 86;
  const setEntryOpen = (entry, shouldOpen) => {
    entry.classList.toggle("is-open", shouldOpen);
    const button = entry.querySelector(".history-delete-button");
    if (button) button.tabIndex = shouldOpen ? 0 : -1;
  };
  overlay.querySelectorAll(".cloud-history-entry").forEach((entry) => {
    const bubble = entry.querySelector(".history-bubble");
    let startX = 0;
    let startY = 0;
    let offset = 0;
    let dragging = false;
    bubble.addEventListener("pointerdown", (event) => {
      if (event.target.closest("details")) return;
      if (openEntry && openEntry !== entry) setEntryOpen(openEntry, false);
      startX = event.clientX;
      startY = event.clientY;
      offset = entry.classList.contains("is-open") ? -revealWidth : 0;
      dragging = true;
      bubble.setPointerCapture(event.pointerId);
    });
    bubble.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) {
        dragging = false;
        bubble.style.transform = "";
        return;
      }
      bubble.style.transform = `translateX(${Math.max(-revealWidth, Math.min(0, offset + dx))}px)`;
    });
    const finish = (event) => {
      if (!dragging) return;
      dragging = false;
      const shouldOpen = offset + event.clientX - startX < -34;
      bubble.style.transform = "";
      setEntryOpen(entry, shouldOpen);
      openEntry = shouldOpen ? entry : null;
    };
    bubble.addEventListener("pointerup", finish);
    bubble.addEventListener("pointercancel", () => { dragging = false; bubble.style.transform = ""; });
  });
  overlay.querySelectorAll("[data-cloud-history-delete]").forEach((button) => button.addEventListener("click", async () => {
    const entry = button.closest(".history-entry");
    button.disabled = true;
    try {
      await requestJSON(`/api/readings/${button.dataset.cloudHistoryDelete}`, { method: "DELETE" });
      onDeleted(Number(button.dataset.cloudHistoryDelete));
      entry.remove();
      const remaining = overlay.querySelectorAll(".cloud-history-entry").length;
      overlay.querySelector(".history-heading p").textContent = `${remaining} 条云端记录`;
      if (!remaining) overlay.querySelector("#cloud-history-list").innerHTML = historyContent([]);
    } catch (error) {
      button.disabled = false;
      window.alert(error.message);
    }
  }));
}

function cloudHistoryProfiles(records) {
  const choices = new Map(getUserProfiles().map((profile) => [profile.id, profile.nickname]));
  records.forEach((record) => {
    if (record.profile_id && !choices.has(record.profile_id)) {
      choices.set(record.profile_id, record.profile_nickname || "未命名用户");
    }
  });
  return [...choices].map(([id, nickname]) => ({ id, nickname }));
}

function renderCloudHistory(overlay, records) {
  const choices = cloudHistoryProfiles(records);
  const activeProfile = getUserProfiles().find((profile) => profile.isActive);
  if (!choices.some((profile) => profile.id === cloudHistoryProfileId)) {
    cloudHistoryProfileId = choices.some((profile) => profile.id === activeProfile?.id)
      ? activeProfile.id
      : choices[0]?.id || null;
  }
  const picker = overlay.querySelector("#cloud-history-picker");
  picker.innerHTML = choices.length
    ? `<label class="history-user-picker cloud-history-user-picker"><span>选择用户</span><select aria-label="选择要查看的用户">${choices.map((profile) => `<option value="${escapeHTML(profile.id)}" ${profile.id === cloudHistoryProfileId ? "selected" : ""}>${escapeHTML(profile.nickname)}</option>`).join("")}</select></label>`
    : `<span>${escapeHTML(authUser?.nickname || "已登录")}</span>`;
  const visible = records.filter((record) => record.profile_id && record.profile_id === cloudHistoryProfileId);
  overlay.querySelector(".history-heading p").textContent = `${visible.length} 条云端记录`;
  overlay.querySelector("#cloud-history-list").innerHTML = historyContent(visible);
  bindCloudHistory(overlay, (deletedId) => {
    const index = records.findIndex((record) => record.id === deletedId);
    if (index !== -1) records.splice(index, 1);
  });
  picker.querySelector("select")?.addEventListener("change", (event) => {
    cloudHistoryProfileId = event.currentTarget.value;
    renderCloudHistory(overlay, records);
  });
}

async function openHistory() {
  const overlay = createOverlay("历史牌阵");
  location.hash = "history";
  overlay.innerHTML = `<main class="cloud-history-page"><header><button class="auth-close" type="button">← 返回设置</button><div id="cloud-history-picker"><span>${authUser ? escapeHTML(authUser.nickname) : "未登录"}</span></div></header><div class="history-heading"><span class="eyebrow">TAROT ARCHIVE</span><h1>历史牌阵</h1><p>${authUser ? "正在读取云端记录…" : "0 条云端记录"}</p></div><div id="cloud-history-list">${authUser ? "" : `<div class="history-empty"><span>◇</span><strong>还没有历史牌阵</strong><p>登录后，完成的解读会自动保存在这里。</p><button class="history-login-button" type="button">登录 Arcana</button></div>`}</div></main>`;
  overlay.querySelector(".auth-close").addEventListener("click", closeOverlay);
  if (!authUser) {
    overlay.querySelector(".history-login-button").addEventListener("click", () => authPage("login"));
    return;
  }
  try {
    const payload = await requestJSON("/api/readings");
    renderCloudHistory(overlay, payload.readings);
  } catch (error) {
    if (error.status === 401) {
      authUser = null;
      updateAccountHeader();
      closeOverlay();
      authPage("login");
      return;
    }
    overlay.querySelector("#cloud-history-list").innerHTML = `<div class="history-empty"><strong>读取失败</strong><p>${escapeHTML(error.message)}</p></div>`;
  }
}

function updateAccountHeader() {
  const host = document.querySelector("#account-area");
  if (!host) return;
  host.innerHTML = authUser
    ? `<button id="account-button" class="account-button is-logged-in" type="button" aria-haspopup="menu" aria-expanded="false"><strong>${escapeHTML(authUser.nickname)}</strong></button><div class="account-menu" id="account-menu" role="menu" hidden><button type="button" data-account-action="history" role="menuitem">历史牌阵</button><button type="button" data-account-action="logout" role="menuitem">退出登录</button></div>`
    : `<button id="account-button" class="account-button" type="button"><strong>未登录</strong></button>`;
  const button = host.querySelector("#account-button");
  if (!authUser) {
    button.addEventListener("click", () => authPage("login"));
    return;
  }
  const menu = host.querySelector("#account-menu");
  button.addEventListener("click", () => {
    menu.hidden = !menu.hidden;
    button.setAttribute("aria-expanded", String(!menu.hidden));
  });
  menu.querySelector('[data-account-action="history"]').addEventListener("click", openHistory);
  menu.querySelector('[data-account-action="logout"]').addEventListener("click", async () => {
    await flushAccountSettings();
    await requestJSON("/api/logout", { method: "POST" }).catch(() => {});
    authUser = null;
    disconnectAccountSettings();
    updateAccountHeader();
    onAuthChange(null);
  });
}

export async function saveCloudReading(record) {
  if (!authUser) return false;
  try {
    await requestJSON("/api/readings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
    return true;
  } catch (error) {
    if (error.status === 401) {
      authUser = null;
      updateAccountHeader();
      onAuthChange(null);
    }
    throw error;
  }
}

export function openLogin() { authPage("login"); }
export function openCloudHistory() { return openHistory(); }

export async function initializeAuth(callback = () => {}) {
  onAuthChange = callback;
  document.addEventListener("arcana:open-cloud-history", openHistory);
  try {
    authUser = (await requestJSON("/api/me")).user;
    try {
      await syncAccountSettings(authUser.id, authUser.nickname);
    } catch (error) {
      console.warn("Arcana account settings sync failed", error);
    }
  } catch (error) {
    if (error.status !== 401) console.warn("Arcana account check failed", error);
    authUser = null;
    if (error.status === 401) disconnectAccountSettings();
  }
  updateAccountHeader();
  const initialHash = location.hash;
  if (initialHash === "#login") authPage("login");
  if (initialHash === "#register") authPage("register");
  if (initialHash === "#history") openHistory();
  callback(authUser);
}
