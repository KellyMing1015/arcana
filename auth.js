import {
  confirmHistoryDeletion,
  disconnectAccountSettings,
  getGuestAvatar,
  getUserProfiles,
  normalizeAvatarDataURL,
  openSettings,
  personalRail,
  syncAccountSettings,
} from "./settings.js?v=20261006-bubbles";
import { cardImageURL, cardImageSrcSet } from "./cards.js?v=20261006-bubbles";

const LOCAL_HISTORY_PREFIX = "arcana_history_";

let authUser = null;
let onAuthChange = () => {};

function accountIcon(name, className = "personal-icon") {
  const paths = {
    back: '<path d="m14 6-6 6 6 6M8 12h12"/>',
    profile: '<circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
    sigil: '<path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z"/>',
    history: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  };
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.profile}</svg>`;
}

function openPersonalCenter() {
  document.dispatchEvent(new CustomEvent("arcana:open-personal-center"));
}

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
  const personalCenter = document.querySelector("#provider-settings");
  if (personalCenter) personalCenter.inert = false;
  if (shell) shell.inert = Boolean(personalCenter);
  if (["#login", "#register", "#history"].includes(location.hash)) history.replaceState(null, "", location.pathname + location.search + (personalCenter ? "#personal-center" : ""));
  (personalCenter?.querySelector("#settings-back") || document.querySelector("#account-button"))?.focus();
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
  const personalCenter = document.querySelector("#provider-settings");
  if (personalCenter) personalCenter.inert = true;
  return overlay;
}

function authPage(mode) {
  const register = mode === "register";
  if (!document.querySelector("#provider-settings")) openPersonalCenter();
  const overlay = createOverlay(register ? "注册 Arcana" : "登录 Arcana");
  location.hash = register ? "register" : "login";
  overlay.innerHTML = `<main class="auth-page">
    <button class="auth-close" type="button">${accountIcon("back")}返回个人中心</button>
    <div class="auth-frame">
    <section class="auth-introduction"><div class="auth-eclipse" aria-hidden="true"></div><h1>${register ? "创建你的 Arcana 账号" : "欢迎回来"}</h1>${register ? `<p class="auth-intro">资料与牌阵随账号保存。</p>` : ""}</section>
    <section class="auth-card">
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
    </div>
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
    <span class="auth-sigil" aria-hidden="true">${accountIcon("sigil")}</span>
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
  return `<div class="history-card-thumbnails ${record.cards.length === 10 ? "history-card-thumbnails-10" : ""}">${record.cards.map((card) => `<figure class="history-card-thumb"><img class="card-art" data-card-image="${escapeHTML(card.id)}" data-image-retry="0" src="${escapeHTML(cardImageURL(card))}" srcset="${escapeHTML(cardImageSrcSet(card))}" sizes="80px" alt="${escapeHTML(card.chinese || "塔罗牌")}" loading="lazy" decoding="async" style="transform:rotate(${card.reversed ? 180 : 0}deg)"><figcaption>${escapeHTML(card.chinese || "塔罗牌")}</figcaption></figure>`).join("")}</div>`;
}

function historyContent(records) {
  if (!records.length) return `<div class="history-empty">${accountIcon("history")}<strong>还没有历史牌阵</strong><p>完成一次解读后，它会自动保存在这里。</p></div>`;
  return `<section class="history-timeline" aria-label="历史牌阵列表">${records.map((record) => `<article class="history-entry cloud-history-entry" data-history-id="${record.id}">
    <span class="history-dot" aria-hidden="true"></span>
    <div class="history-swipe-shell">
      <div class="history-bubble">
        <header><time>${escapeHTML(formatCloudTime(record.created_at))}</time><span>${escapeHTML(record.spread_type)}</span></header>
        <p class="history-question">${escapeHTML(record.question)}</p>
        <blockquote>“${record.summary ? escapeHTML(record.summary) : "这条旧记录没有独立总结。"}”</blockquote>
        <div class="history-card-row">
          ${cloudCards(record)}
          <button class="history-delete-button history-delete-corner" type="button" data-cloud-history-delete="${record.id}" aria-label="删除这条历史牌阵" title="删除记录">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>
          </button>
        </div>
        ${record.full_reading ? `<details class="cloud-reading-details"><summary>查看完整解读</summary><p>${escapeHTML(record.full_reading)}</p></details>` : ""}
      </div>
    </div>
  </article>`).join("")}</section>`;
}

function bindCloudHistory(overlay, onDeleted = () => {}) {
  overlay.querySelectorAll("[data-cloud-history-delete]").forEach((button) => button.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (!await confirmHistoryDeletion(button)) return;
    const entry = button.closest(".history-entry");
    button.disabled = true;
    try {
      await requestJSON(`/api/readings/${button.dataset.cloudHistoryDelete}`, { method: "DELETE" });
      onDeleted(Number(button.dataset.cloudHistoryDelete));
      entry.remove();
      const remaining = overlay.querySelectorAll(".cloud-history-entry").length;
      overlay.querySelector(".history-heading p").textContent = `${remaining} 条记录`;
      if (!remaining) {
        overlay.querySelector("#cloud-history-list").innerHTML = historyContent([]);
      }
    } catch (error) {
      button.disabled = false;
      window.alert(error.message);
    }
  }));
}

function renderCloudHistory(overlay, records) {
  // 账号下的旧档案与未标记档案的记录都保留在同一条时间轴中。
  overlay.querySelector(".history-heading p").textContent = `${records.length} 条记录`;
  overlay.querySelector("#cloud-history-list").innerHTML = historyContent(records);
  bindCloudHistory(overlay, (deletedId) => {
    const index = records.findIndex((record) => record.id === deletedId);
    if (index !== -1) records.splice(index, 1);
  });
}

function bindAccountRail(overlay) {
  overlay.querySelectorAll("[data-settings-section]").forEach((button) => button.addEventListener("click", () => {
    const section = button.dataset.settingsSection;
    closeOverlay();
    openSettings(section);
  }));
}

async function openHistory() {
  if (!document.querySelector("#provider-settings")) openPersonalCenter();
  const overlay = createOverlay("历史牌阵");
  location.hash = "history";
  overlay.innerHTML = `<div class="settings-page cloud-history-shell"><header class="settings-header"><span class="settings-brand"><span aria-hidden="true"></span>ARCANA</span><button class="auth-close" type="button">${accountIcon("back")}返回个人中心</button></header><div class="personal-workspace">${personalRail("history")}<div class="personal-workspace-content"><main class="cloud-history-page"><div class="history-toolbar"><div class="history-heading"><h1>历史牌阵</h1><p>${authUser ? "正在读取记录…" : "0 条记录"}</p></div></div><div id="cloud-history-list">${authUser ? "" : `<div class="history-empty">${accountIcon("history")}<strong>还没有历史牌阵</strong><p>登录后，完成的解读会自动保存在这里。</p><button class="history-login-button" type="button">登录 Arcana</button></div>`}</div></main></div></div></div>`;
  bindAccountRail(overlay);
  overlay.querySelector(".auth-close").addEventListener("click", closeOverlay);
  if (!authUser) {
    overlay.querySelector(".history-login-button").addEventListener("click", () => authPage("login"));
    return;
  }
  const accountId = authUser.id;
  try {
    const payload = await requestJSON("/api/readings");
    if (!overlay.isConnected || authUser?.id !== accountId) return;
    renderCloudHistory(overlay, payload.readings);
  } catch (error) {
    if (!overlay.isConnected || authUser?.id !== accountId) return;
    if (error.status === 401) {
      authUser = null;
      disconnectAccountSettings();
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
  const avatar = authUser ? normalizeAvatarDataURL(authUser.avatar || "") : getGuestAvatar();
  if (host) {
    host.innerHTML = `<button id="account-button" class="account-button${authUser ? " is-logged-in" : ""}${avatar ? " has-avatar" : ""}" type="button" aria-label="打开个人中心${authUser ? `，${escapeHTML(authUser.nickname)}` : ""}" aria-haspopup="dialog" title="个人中心">${avatar ? `<img class="account-avatar-image" src="${escapeHTML(avatar)}" alt="" width="40" height="40">` : accountIcon("profile", "account-avatar-icon")}</button>`;
    host.querySelector("#account-button").addEventListener("click", openPersonalCenter);
  }
  document.dispatchEvent(new CustomEvent("arcana:account-change", { detail: { user: authUser ? { id: authUser.id, nickname: authUser.nickname, email: authUser.email || "", avatar } : null } }));
}

async function updateAccountAvatar(event) {
  const detail = event.detail || {};
  const complete = typeof detail.complete === "function" ? detail.complete : () => {};
  const accountId = authUser?.id;
  if (!accountId || accountId !== detail.userId) { complete(new Error("账号状态发生变化，请重新选择头像。")); return; }
  const avatar = detail.avatar;
  if (typeof avatar !== "string" || (avatar && !normalizeAvatarDataURL(avatar))) { complete(new Error("头像图片无法保存，请重新选择。")); return; }
  try {
    const payload = await requestJSON("/api/avatar", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ avatar, userId: accountId }),
    });
    if (authUser?.id !== accountId) { complete(new Error("账号状态发生变化，请重新选择头像。")); return; }
    const savedAvatar = normalizeAvatarDataURL(payload.avatar);
    if (avatar && !savedAvatar) throw new Error("头像暂时没有保存成功，请稍后重试。");
    authUser = { ...authUser, avatar: savedAvatar };
    updateAccountHeader();
    complete();
  } catch (error) {
    if (error.status === 401 && authUser?.id === accountId) {
      authUser = null;
      disconnectAccountSettings();
      updateAccountHeader();
      onAuthChange(null);
    }
    complete(error);
  }
}

async function logoutAccount() {
  await requestJSON("/api/logout", { method: "POST" }).catch(() => {});
  authUser = null;
  disconnectAccountSettings();
  closeOverlay();
  updateAccountHeader();
  onAuthChange(null);
}

export async function saveCloudReading(record) {
  if (!authUser) return false;
  const accountId = authUser.id;
  try {
    await requestJSON("/api/readings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
    return true;
  } catch (error) {
    if (error.status === 401 && authUser?.id === accountId) {
      authUser = null;
      disconnectAccountSettings();
      updateAccountHeader();
      onAuthChange(null);
    }
    throw error;
  }
}

export function openLogin() { authPage("login"); }
export function openCloudHistory() { return openHistory(); }

function syncOverlayRoute() {
  const hash = location.hash;
  const overlay = document.querySelector("#account-overlay");
  if (!hash) {
    if (overlay) closeOverlay();
    if (document.querySelector("#provider-settings")) document.dispatchEvent(new CustomEvent("arcana:close-personal-center"));
    return;
  }
  if (["#personal-center", "#settings"].includes(hash)) {
    if (overlay) closeOverlay();
    if (!document.querySelector("#provider-settings")) openPersonalCenter();
    return;
  }
  if (hash === "#login" || hash === "#register") {
    const register = hash === "#register";
    if (overlay?.getAttribute("aria-label") !== (register ? "注册 Arcana" : "登录 Arcana")) authPage(register ? "register" : "login");
  }
  if (hash === "#history" && overlay?.getAttribute("aria-label") !== "历史牌阵") openHistory();
}

export async function initializeAuth(callback = () => {}) {
  onAuthChange = callback;
  document.addEventListener("arcana:open-cloud-history", openHistory);
  document.addEventListener("arcana:open-login", () => authPage("login"));
  document.addEventListener("arcana:logout", logoutAccount);
  document.addEventListener("arcana:update-account-avatar", updateAccountAvatar);
  document.addEventListener("arcana:guest-avatar-change", () => { if (!authUser) updateAccountHeader(); });
  window.addEventListener("hashchange", syncOverlayRoute);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.querySelector("#account-overlay")) closeOverlay();
  });
  updateAccountHeader();
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
