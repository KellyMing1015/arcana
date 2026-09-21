const PROVIDER_STORAGE_KEY = "arcana.providers.v1";
const PROFILE_STORAGE_KEY = "arcana.user-info.v1";
const ZODIACS = ["白羊座", "金牛座", "双子座", "巨蟹座", "狮子座", "处女座", "天秤座", "天蝎座", "射手座", "摩羯座", "水瓶座", "双鱼座"];

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp", "<": "&lt", ">": "&gt", '"': "&quot", "'": "&#39",
  })[character] + ";");
}

function loadSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROVIDER_STORAGE_KEY) || "null");
    if (!parsed || !Array.isArray(parsed.providers)) return { providers: [], activeId: null };
    const providers = parsed.providers.filter((item) =>
      item && ["id", "name", "baseUrl", "apiKey", "model"].every((key) => typeof item[key] === "string")
    );
    return {
      providers,
      activeId: providers.some((item) => item.id === parsed.activeId) ? parsed.activeId : null,
    };
  } catch {
    return { providers: [], activeId: null };
  }
}

function loadUserInfo() {
  const defaults = { enabled: true, nickname: "", age: "", gender: "", zodiac: "", status: "" };
  try {
    const parsed = JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY) || "null");
    if (!parsed || typeof parsed !== "object") return defaults;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : true,
      nickname: typeof parsed.nickname === "string" ? parsed.nickname.slice(0, 80) : "",
      age: typeof parsed.age === "string" ? parsed.age.slice(0, 20) : "",
      gender: ["", "女", "男"].includes(parsed.gender) ? parsed.gender : "",
      zodiac: ["", ...ZODIACS].includes(parsed.zodiac) ? parsed.zodiac : "",
      status: typeof parsed.status === "string" ? parsed.status.slice(0, 1000) : "",
    };
  } catch {
    return defaults;
  }
}

let settings = loadSettings();
let userInfo = loadUserInfo();
let selectedId = settings.activeId || settings.providers[0]?.id || null;
let activeSection = "providers";
let pendingDeleteId = null;
let onChange = () => {};

function persistProviders(next) {
  try {
    localStorage.setItem(PROVIDER_STORAGE_KEY, JSON.stringify(next));
    settings = next;
    onChange();
    return true;
  } catch {
    showFeedback("浏览器没有保存这项配置，请检查是否允许本地存储。", true);
    return false;
  }
}

function persistUserInfo(next) {
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(next));
    userInfo = next;
    onChange();
    return true;
  } catch {
    showFeedback("浏览器没有保存个人信息，请检查是否允许本地存储。", true);
    return false;
  }
}

function showFeedback(message, error = false) {
  const feedback = document.querySelector("#settings-feedback");
  if (!feedback) return;
  feedback.textContent = message;
  feedback.classList.toggle("is-error", error);
}

export function getActiveProvider() {
  const item = settings.providers.find((provider) => provider.id === settings.activeId);
  return item ? { baseUrl: item.baseUrl, apiKey: item.apiKey, model: item.model } : null;
}

export function getActiveProviderLabel() {
  const item = settings.providers.find((provider) => provider.id === settings.activeId);
  return item ? `${item.name} · ${item.model}` : "服务端默认配置";
}

export function getProviderChoices() {
  return [
    { id: "", label: "服务端默认配置", active: !settings.activeId },
    ...settings.providers.map((item) => ({ id: item.id, label: `${item.name} · ${item.model}`, active: item.id === settings.activeId })),
  ];
}

export function setActiveProvider(id) {
  const activeId = id || null;
  if (activeId && !settings.providers.some((item) => item.id === activeId)) return false;
  return persistProviders({ ...settings, activeId });
}

export function getUserInfo() {
  return userInfo.enabled ? { ...userInfo } : { enabled: false };
}

function providerList() {
  if (!settings.providers.length) return `<div class="settings-empty">还没有供应商。先添加第一个。</div>`;
  return settings.providers.map((item) => `<button class="provider-list-item ${selectedId === item.id ? "is-selected" : ""}" type="button" data-provider-id="${escapeHTML(item.id)}">
    <span class="provider-list-head"><strong>${escapeHTML(item.name)}</strong>${settings.activeId === item.id ? "<small>使用中</small>" : ""}</span>
    <span class="provider-list-model">${escapeHTML(item.model)}</span>
  </button>`).join("");
}

function providerEditor() {
  const item = settings.providers.find((provider) => provider.id === selectedId);
  const editing = Boolean(item);
  return `<div class="settings-editor-heading">
    <div><span class="eyebrow">${editing ? "PROVIDER DETAILS" : "NEW PROVIDER"}</span><h2>${editing ? "编辑供应商" : "添加供应商"}</h2></div>
    ${editing && settings.activeId === item.id ? "<span class=\"settings-active-badge\">正在使用</span>" : ""}
  </div>
  <p class="settings-editor-intro">填写中转站提供的地址、API Key 和模型名。Arcana 会按 OpenAI 兼容格式请求 <code>/chat/completions</code>。</p>
  <form id="provider-form" novalidate>
    <div class="settings-form-grid">
      <label class="settings-field"><span>供应商名称</span><input name="name" type="text" maxlength="60" autocomplete="off" placeholder="例如：我的中转站" value="${escapeHTML(item?.name || "")}"></label>
      <label class="settings-field"><span>API Base URL</span><input name="baseUrl" type="url" inputmode="url" autocomplete="url" placeholder="https://example.com/v1" value="${escapeHTML(item?.baseUrl || "")}"><small>填到 /v1 即可，不用填 /chat/completions。</small></label>
      <label class="settings-field"><span>API Key</span><span class="settings-secret"><input id="provider-key" name="apiKey" type="password" autocomplete="off" placeholder="${editing ? "已保存；留空则保持原密钥" : "粘贴你的 API Key"}"><button id="toggle-key" type="button" aria-label="显示 API Key">显示</button></span></label>
      <div class="settings-field"><label for="provider-model">模型名</label><span class="settings-model-row"><input id="provider-model" name="model" type="text" maxlength="200" autocomplete="off" placeholder="先点击获取模型，或手动输入" value="${escapeHTML(item?.model || "")}"><button id="fetch-models" type="button">获取模型</button></span><select id="fetched-models" class="settings-model-select" aria-label="从供应商模型列表选择" hidden><option value="">从列表中选择模型…</option></select><small>列表来自供应商；如果拉取失败，也可以直接填写模型名。</small></div>
    </div>
    <div class="settings-form-actions">
      <button class="settings-save" type="submit">${editing ? "保存并使用" : "添加并使用"} <span aria-hidden="true">↗</span></button>
      ${editing && settings.activeId !== item.id ? "<button class=\"settings-action-secondary\" id=\"activate-provider\" type=\"button\">设为当前供应商</button>" : ""}
      ${editing && pendingDeleteId === item.id
        ? "<button class=\"settings-delete\" id=\"confirm-delete-provider\" type=\"button\">确定删除</button><button class=\"settings-action-secondary\" id=\"cancel-delete-provider\" type=\"button\">取消</button>"
        : editing ? "<button class=\"settings-delete\" id=\"delete-provider\" type=\"button\">删除供应商</button>" : ""}
    </div>
    <p id="settings-feedback" class="settings-feedback" role="status" aria-live="polite"></p>
  </form>
  <p class="settings-storage-note">供应商配置只保存在这个浏览器中；解读时由本机 Flask 转发。</p>`;
}

function userInfoEditor() {
  const disabled = userInfo.enabled ? "" : " disabled";
  const zodiacOptions = ["", ...ZODIACS].map((value) => `<option value="${value}" ${userInfo.zodiac === value ? "selected" : ""}>${value || "请选择星座"}</option>`).join("");
  return `<div class="settings-editor-heading"><div><span class="eyebrow">PERSONAL CONTEXT</span><h2>用户信息</h2></div></div>
  <p class="settings-editor-intro">这些内容都是选填，只用于让塔罗师理解你的语境。关闭后，解读请求不会带上任何个人信息。</p>
  <form id="user-info-form" novalidate>
    <label class="profile-toggle"><span><strong>启用个人信息</strong><small>开启后，只传递你实际填写的内容</small></span><input id="profile-enabled" type="checkbox" ${userInfo.enabled ? "checked" : ""}><i aria-hidden="true"></i></label>
    <fieldset id="profile-fields" class="profile-fields"${disabled}>
      <label class="settings-field"><span>昵称</span><input name="nickname" type="text" maxlength="80" autocomplete="nickname" placeholder="希望塔罗师怎么称呼你" value="${escapeHTML(userInfo.nickname)}"></label>
      <div class="profile-two-columns">
        <label class="settings-field"><span>年龄</span><input name="age" type="text" maxlength="20" inputmode="numeric" placeholder="选填" value="${escapeHTML(userInfo.age)}"></label>
        <label class="settings-field"><span>性别</span><select name="gender"><option value="">请选择</option><option value="女" ${userInfo.gender === "女" ? "selected" : ""}>女</option><option value="男" ${userInfo.gender === "男" ? "selected" : ""}>男</option></select></label>
      </div>
      <label class="settings-field"><span>星座</span><select name="zodiac">${zodiacOptions}</select></label>
      <label class="settings-field"><span>当前状态</span><textarea name="status" maxlength="1000" rows="7" placeholder="例如最近正在经历什么、在意什么，或生活处于什么阶段">${escapeHTML(userInfo.status)}</textarea><small><span id="profile-status-count">${userInfo.status.length}</span> / 1000</small></label>
    </fieldset>
    <div class="settings-form-actions"><button class="settings-save" type="submit">保存个人信息 <span aria-hidden="true">↗</span></button></div>
    <p id="settings-feedback" class="settings-feedback" role="status" aria-live="polite"></p>
  </form>
  <p class="settings-storage-note">个人信息只保存在当前浏览器的 localStorage 中。开启后，填写过的字段会随解读请求发送给你选择的模型供应商。</p>`;
}

function settingsSidebar() {
  return `<aside class="settings-sidebar">
    <span class="eyebrow">ARCANA SETTINGS</span>
    <h1>让每一次解读，<br><em>更像在和你说话。</em></h1>
    <p>在这里选择解读模型，也可以补充愿意告诉塔罗师的个人背景。</p>
    <nav class="settings-section-list" aria-label="设置模块">
      <button class="${activeSection === "providers" ? "is-selected" : ""}" type="button" data-settings-section="providers"><span>供应商</span><small>${settings.providers.length} 个配置</small></button>
      <button class="${activeSection === "profile" ? "is-selected" : ""}" type="button" data-settings-section="profile"><span>用户信息</span><small>${userInfo.enabled ? "已启用" : "已关闭"}</small></button>
    </nav>
    ${activeSection === "providers" ? `<div class="settings-list-heading"><strong>已添加</strong><button id="new-provider" type="button">＋ 添加</button></div><div class="provider-list">${providerList()}</div><p class="settings-sidebar-note">未选择页面供应商时，使用服务端 .env 中的默认配置。</p>${settings.activeId ? "<button id=\"use-server-default\" class=\"settings-server-link\" type=\"button\">改用服务端默认配置 →</button>" : ""}` : ""}
  </aside>`;
}

function renderSettings(message = "") {
  const overlay = document.querySelector("#provider-settings");
  if (!overlay) return;
  overlay.innerHTML = `<div class="settings-page">
    <header class="settings-header"><span class="settings-brand"><span aria-hidden="true"></span> ARCANA <small>/ SETTINGS</small></span><button id="close-settings" type="button">← 返回抽牌</button></header>
    <div class="settings-layout">${settingsSidebar()}<section class="settings-editor" aria-label="${activeSection === "providers" ? "供应商配置" : "用户信息"}">${activeSection === "providers" ? providerEditor() : userInfoEditor()}</section></div>
  </div>`;
  overlay.querySelector("#close-settings").addEventListener("click", closeSettings);
  overlay.querySelectorAll("[data-settings-section]").forEach((button) => button.addEventListener("click", () => {
    activeSection = button.dataset.settingsSection;
    pendingDeleteId = null;
    renderSettings();
  }));
  if (activeSection === "profile") bindUserInfoEditor(overlay);
  else bindProviderEditor(overlay);
  if (message) showFeedback(message);
}

function bindUserInfoEditor(overlay) {
  const enabled = overlay.querySelector("#profile-enabled");
  const fields = overlay.querySelector("#profile-fields");
  const form = overlay.querySelector("#user-info-form");
  const formValue = () => ({
    enabled: enabled.checked,
    nickname: form.elements.nickname.value.trim(),
    age: form.elements.age.value.trim(),
    gender: form.elements.gender.value,
    zodiac: form.elements.zodiac.value,
    status: form.elements.status.value.trim(),
  });
  enabled.addEventListener("change", () => {
    fields.disabled = !enabled.checked;
    if (persistUserInfo(formValue())) {
      const label = overlay.querySelector('[data-settings-section="profile"] small');
      if (label) label.textContent = enabled.checked ? "已启用" : "已关闭";
      showFeedback(enabled.checked ? "个人信息已启用。" : "个人信息已关闭，解读时不会发送这些内容。");
    }
  });
  const status = overlay.querySelector('[name="status"]');
  status.addEventListener("input", () => { overlay.querySelector("#profile-status-count").textContent = status.value.length; });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const next = formValue();
    if (persistUserInfo(next)) renderSettings(next.enabled ? "个人信息已保存，之后的解读会使用已填写内容。" : "个人信息已保存并关闭，解读时不会发送这些内容。");
  });
}

function bindProviderEditor(overlay) {
  overlay.querySelector("#new-provider").addEventListener("click", () => { selectedId = null; pendingDeleteId = null; renderSettings(); });
  overlay.querySelectorAll("[data-provider-id]").forEach((button) => button.addEventListener("click", () => {
    selectedId = button.dataset.providerId;
    pendingDeleteId = null;
    renderSettings();
  }));
  overlay.querySelector("#use-server-default")?.addEventListener("click", () => {
    if (persistProviders({ ...settings, activeId: null })) renderSettings("已切换到服务端默认配置。");
  });
  const keyInput = overlay.querySelector("#provider-key");
  const toggle = overlay.querySelector("#toggle-key");
  toggle.addEventListener("click", () => {
    const visible = keyInput.type === "password";
    keyInput.type = visible ? "text" : "password";
    toggle.textContent = visible ? "隐藏" : "显示";
    toggle.setAttribute("aria-label", visible ? "隐藏 API Key" : "显示 API Key");
  });
  overlay.querySelector("#provider-form").addEventListener("submit", saveProvider);
  overlay.querySelector("#fetch-models").addEventListener("click", fetchModels);
  overlay.querySelector("#fetched-models").addEventListener("change", (event) => {
    if (event.currentTarget.value) overlay.querySelector('[name="model"]').value = event.currentTarget.value;
  });
  overlay.querySelector("#activate-provider")?.addEventListener("click", () => {
    if (persistProviders({ ...settings, activeId: selectedId })) renderSettings("已设为当前供应商。");
  });
  overlay.querySelector("#delete-provider")?.addEventListener("click", () => {
    pendingDeleteId = selectedId;
    renderSettings("再次点击“确定删除”即可移除这个供应商。");
  });
  overlay.querySelector("#confirm-delete-provider")?.addEventListener("click", deleteProvider);
  overlay.querySelector("#cancel-delete-provider")?.addEventListener("click", () => { pendingDeleteId = null; renderSettings(); });
}

async function fetchModels() {
  const overlay = document.querySelector("#provider-settings");
  const form = overlay.querySelector("#provider-form");
  const existing = settings.providers.find((provider) => provider.id === selectedId);
  const baseUrl = form.elements.baseUrl.value.trim().replace(/\/+$/, "");
  const apiKey = form.elements.apiKey.value.trim() || existing?.apiKey || "";
  if (!baseUrl || !apiKey) { showFeedback("先填写 API Base URL 和 API Key，再获取模型。", true); return; }
  const button = overlay.querySelector("#fetch-models");
  button.disabled = true;
  button.textContent = "获取中...";
  showFeedback("正在向供应商获取模型列表…");
  try {
    const response = await fetch("/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: { baseUrl, apiKey } }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "获取模型失败，请稍后重试。");
    const select = overlay.querySelector("#fetched-models");
    select.replaceChildren(new Option("从列表中选择模型…", ""));
    for (const model of payload.models) select.add(new Option(model, model));
    select.hidden = false;
    showFeedback(`已获取 ${payload.models.length} 个模型。选择一个，或继续手动填写。`);
    select.focus();
  } catch (error) {
    showFeedback(error instanceof TypeError ? "无法连接本机解读服务，请确认 Flask 已启动。" : (error.message || "获取模型失败，请手动填写模型名。"), true);
  } finally {
    button.disabled = false;
    button.textContent = "获取模型";
  }
}

function saveProvider(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const existing = settings.providers.find((provider) => provider.id === selectedId);
  const name = String(data.get("name") || "").trim();
  const baseUrl = String(data.get("baseUrl") || "").trim().replace(/\/+$/, "");
  const apiKey = String(data.get("apiKey") || "").trim() || existing?.apiKey || "";
  const model = String(data.get("model") || "").trim();
  if (!name || !baseUrl || !apiKey || !model) { showFeedback("请把供应商名称、地址、API Key 和模型名填完整。", true); return; }
  let url;
  try { url = new URL(baseUrl); }
  catch { showFeedback("请填写完整的 API Base URL，例如 https://example.com/v1。", true); return; }
  if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash || url.username || url.password) { showFeedback("地址需要是完整的 http(s) URL，不能包含账号、密码或查询参数。", true); return; }
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) { showFeedback("远程供应商请使用 https 地址。", true); return; }
  const record = { id: existing?.id || (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`), name, baseUrl, apiKey, model };
  const providers = existing ? settings.providers.map((provider) => provider.id === existing.id ? record : provider) : [...settings.providers, record];
  if (persistProviders({ providers, activeId: record.id })) { selectedId = record.id; renderSettings("已保存，并设为当前解读供应商。"); }
}

function deleteProvider() {
  const item = settings.providers.find((provider) => provider.id === selectedId);
  if (!item || pendingDeleteId !== item.id) return;
  const providers = settings.providers.filter((provider) => provider.id !== item.id);
  const activeId = settings.activeId === item.id ? null : settings.activeId;
  if (persistProviders({ providers, activeId })) {
    pendingDeleteId = null;
    selectedId = providers[0]?.id || null;
    renderSettings("供应商已删除。");
  }
}

function closeSettings() {
  document.querySelector("#provider-settings")?.remove();
  pendingDeleteId = null;
  document.body.classList.remove("settings-open");
  document.querySelector(".site-shell").inert = false;
  document.querySelector(".wordmark")?.focus();
}

export function openSettings(section = "providers") {
  if (document.querySelector("#provider-settings")) return;
  activeSection = section;
  const overlay = document.createElement("div");
  overlay.id = "provider-settings";
  overlay.className = "settings-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Arcana 设置");
  document.body.append(overlay);
  document.body.classList.add("settings-open");
  document.querySelector(".site-shell").inert = true;
  renderSettings();
  overlay.querySelector("#close-settings")?.focus();
}

export function initializeProviderSettings(callback = () => {}) {
  onChange = callback;
  document.querySelector(".wordmark")?.addEventListener("click", (event) => { event.preventDefault(); openSettings(); });
  window.addEventListener("keydown", (event) => { if (event.key === "Escape" && document.querySelector("#provider-settings")) closeSettings(); });
  window.addEventListener("storage", (event) => {
    if (![PROVIDER_STORAGE_KEY, PROFILE_STORAGE_KEY].includes(event.key)) return;
    settings = loadSettings();
    userInfo = loadUserInfo();
    if (!settings.providers.some((item) => item.id === selectedId)) selectedId = settings.activeId || settings.providers[0]?.id || null;
    onChange();
    renderSettings();
  });
  callback();
}
