const PROVIDER_STORAGE_KEY = "arcana.providers.v1";
const INITIAL_PROVIDER_ID = "__arcana_initial_provider__";
const INITIAL_PROVIDER_MODEL = "【CCMAX】claude-opus-5-5";
const PROFILE_STORAGE_KEY = "arcana.user-profiles.v2";
const LEGACY_PROFILE_STORAGE_KEY = "arcana.user-info.v1";
const HISTORY_STORAGE_PREFIX = "arcana_history_";
const ACCOUNT_CACHE_USER_KEY = "arcana.account-cache-user.v1";
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

function makeId() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

function normalizeProfiles(value) {
  if (!Array.isArray(value)) return [];
  let hasActiveProfile = false;
  const usedIds = new Set();
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    let id = typeof item.id === "string" && item.id ? item.id : makeId();
    if (usedIds.has(id)) id = makeId();
    usedIds.add(id);
    const isActive = item.isActive === true && !hasActiveProfile;
    if (isActive) hasActiveProfile = true;
    return [{
      id,
      nickname: typeof item.nickname === "string" ? item.nickname.slice(0, 80) : "",
      age: typeof item.age === "string" ? item.age.slice(0, 20) : "",
      gender: ["", "女", "男"].includes(item.gender) ? item.gender : "",
      zodiac: ["", ...ZODIACS].includes(item.zodiac) ? item.zodiac : "",
      currentStatus: typeof item.currentStatus === "string" ? item.currentStatus.slice(0, 1000) : "",
      focusAreas: Array.isArray(item.focusAreas)
        ? [...new Set(item.focusAreas.filter((area) => typeof area === "string").map((area) => area.trim().slice(0, 40)).filter(Boolean))].slice(0, 12)
        : [],
      isActive,
    }];
  });
}

function loadProfiles() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY) || "null");
    if (Array.isArray(parsed)) return normalizeProfiles(parsed);

    const legacy = JSON.parse(localStorage.getItem(LEGACY_PROFILE_STORAGE_KEY) || "null");
    if (!legacy || typeof legacy !== "object") return [];
    const nickname = typeof legacy.nickname === "string" ? legacy.nickname.slice(0, 80) : "";
    const age = typeof legacy.age === "string" ? legacy.age.slice(0, 20) : "";
    const gender = ["", "女", "男"].includes(legacy.gender) ? legacy.gender : "";
    const zodiac = ["", ...ZODIACS].includes(legacy.zodiac) ? legacy.zodiac : "";
    const currentStatus = typeof legacy.status === "string" ? legacy.status.slice(0, 1000) : "";
    if (![nickname, age, gender, zodiac, currentStatus].some(Boolean)) return [];
    const migrated = normalizeProfiles([{
      id: makeId(), nickname, age, gender, zodiac, currentStatus, focusAreas: [], isActive: legacy.enabled !== false,
    }]);
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(migrated));
    return migrated;
  } catch {
    return [];
  }
}

let settings = loadSettings();
let userProfiles = loadProfiles();
let selectedId = settings.activeId || INITIAL_PROVIDER_ID;
let activeSection = "home";
let editingUserId = null;
let historyUserId = userProfiles.find((profile) => profile.isActive)?.id || userProfiles[0]?.id || null;
let pendingDeleteId = null;
let onChange = () => {};
let cloudAccountId = null;
let cloudSaveChain = Promise.resolve();

async function accountDataRequest(method, body) {
  const response = await fetch("/api/account-data", {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "账号设置同步失败，请稍后重试。");
  return payload;
}

function accountDataSnapshot() {
  return {
    providerSettings: {
      providers: settings.providers.map((provider) => ({ ...provider })),
      activeId: settings.activeId,
    },
    profiles: userProfiles.map((profile) => ({ ...profile, focusAreas: [...profile.focusAreas] })),
  };
}

function applyAccountData(providerSettings, profiles) {
  localStorage.setItem(PROVIDER_STORAGE_KEY, JSON.stringify(providerSettings));
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profiles));
  settings = loadSettings();
  userProfiles = loadProfiles();
  selectedId = settings.activeId || INITIAL_PROVIDER_ID;
  historyUserId = userProfiles.find((profile) => profile.isActive)?.id || userProfiles[0]?.id || null;
  onChange();
  if (document.querySelector("#provider-settings")) renderSettings("云端设置已同步。");
}

function queueCloudSave() {
  if (!cloudAccountId) return;
  const snapshot = accountDataSnapshot();
  cloudSaveChain = cloudSaveChain.then(() => accountDataRequest("PUT", snapshot)).catch((error) => {
    console.warn("Arcana account settings sync failed", error);
    showFeedback("已保存在本机，但云端同步失败，请稍后再试。", true);
  });
}

export async function syncAccountSettings(userId) {
  if (!userId) return;
  const accountId = String(userId);
  const payload = await accountDataRequest("GET");
  const cachedOwner = localStorage.getItem(ACCOUNT_CACHE_USER_KEY);
  if (payload.hasData) {
    applyAccountData(payload.providerSettings, payload.profiles);
  } else if (!cachedOwner || cachedOwner === accountId) {
    await accountDataRequest("PUT", accountDataSnapshot());
  } else {
    applyAccountData({ providers: [], activeId: null }, []);
    await accountDataRequest("PUT", accountDataSnapshot());
  }
  localStorage.setItem(ACCOUNT_CACHE_USER_KEY, accountId);
  cloudAccountId = accountId;
}

export async function flushAccountSettings() {
  await cloudSaveChain;
}

export function disconnectAccountSettings() {
  cloudAccountId = null;
  if (!localStorage.getItem(ACCOUNT_CACHE_USER_KEY)) return;
  localStorage.removeItem(ACCOUNT_CACHE_USER_KEY);
  localStorage.removeItem(PROVIDER_STORAGE_KEY);
  localStorage.removeItem(PROFILE_STORAGE_KEY);
  settings = loadSettings();
  userProfiles = loadProfiles();
  selectedId = INITIAL_PROVIDER_ID;
  historyUserId = null;
  onChange();
  if (document.querySelector("#provider-settings")) renderSettings();
}

function persistProviders(next) {
  try {
    localStorage.setItem(PROVIDER_STORAGE_KEY, JSON.stringify(next));
    settings = next;
    onChange();
    queueCloudSave();
    return true;
  } catch {
    showFeedback("浏览器没有保存这项配置，请检查是否允许本地存储。", true);
    return false;
  }
}

function persistProfiles(next) {
  try {
    const normalized = normalizeProfiles(next);
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(normalized));
    userProfiles = normalized;
    onChange();
    queueCloudSave();
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
  return item ? `${item.name} · ${item.model}` : `初始供应商 · ${INITIAL_PROVIDER_MODEL}`;
}

export function getProviderChoices() {
  return [
    { id: "", label: `初始供应商 · ${INITIAL_PROVIDER_MODEL}`, active: !settings.activeId },
    ...settings.providers.map((item) => ({ id: item.id, label: `${item.name} · ${item.model}`, active: item.id === settings.activeId })),
  ];
}

export function setActiveProvider(id) {
  const activeId = id || null;
  if (activeId && !settings.providers.some((item) => item.id === activeId)) return false;
  return persistProviders({ ...settings, activeId });
}

export function getUserInfo() {
  const active = userProfiles.find((profile) => profile.isActive);
  return active ? { enabled: true, ...active } : { enabled: false };
}

export function getUserProfiles() {
  return userProfiles.map((profile) => ({
    id: profile.id,
    nickname: profile.nickname || "未命名用户",
    isActive: profile.isActive,
  }));
}

function historyKey(userId) { return `${HISTORY_STORAGE_PREFIX}${userId}`; }

function historyCutoff() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 3);
  return cutoff.getTime();
}

function normalizeHistoryRecords(value) {
  if (!Array.isArray(value)) return [];
  const cutoff = historyCutoff();
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || !Number.isFinite(item.createdAt) || item.createdAt < cutoff) return [];
    if (typeof item.question !== "string" || typeof item.summary !== "string" || !Array.isArray(item.cards)) return [];
    const cards = item.cards.flatMap((card) => {
      if (!card || typeof card !== "object" || typeof card.id !== "string" || !/^[a-z0-9-]+$/.test(card.id)) return [];
      return [{
        id: card.id,
        chinese: typeof card.chinese === "string" ? card.chinese.slice(0, 40) : "塔罗牌",
        position: typeof card.position === "string" ? card.position.slice(0, 40) : "",
        reversed: card.reversed === true,
      }];
    });
    if (!cards.length) return [];
    return [{
      id: typeof item.id === "string" && item.id ? item.id : makeId(),
      createdAt: item.createdAt,
      timestamp: typeof item.timestamp === "string" ? item.timestamp.slice(0, 24) : "",
      question: item.question.slice(0, 220),
      spread: [1, 3, 10].includes(item.spread) ? item.spread : cards.length,
      spreadLabel: typeof item.spreadLabel === "string" ? item.spreadLabel.slice(0, 20) : "牌阵",
      // 历史记录以完整表达为先，不再在第 100 个字符处截断句子。
      summary: item.summary.trim(),
      cards,
    }];
  }).sort((a, b) => b.createdAt - a.createdAt);
}

function loadHistoryRecords(userId) {
  if (!userId) return [];
  try {
    const raw = JSON.parse(localStorage.getItem(historyKey(userId)) || "[]");
    const records = normalizeHistoryRecords(raw);
    if (!Array.isArray(raw) || records.length !== raw.length || raw.some((item) => !item?.id)) {
      localStorage.setItem(historyKey(userId), JSON.stringify(records));
    }
    return records;
  } catch {
    return [];
  }
}

function deleteHistoryRecord(userId, recordId) {
  if (!userId || !recordId) return false;
  try {
    const records = loadHistoryRecords(userId);
    const next = records.filter((record) => record.id !== recordId);
    if (next.length === records.length) return false;
    localStorage.setItem(historyKey(userId), JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

export function saveHistoryRecord(userId, record) {
  if (!userId || !record) return false;
  try {
    const records = normalizeHistoryRecords([...loadHistoryRecords(userId), record]);
    localStorage.setItem(historyKey(userId), JSON.stringify(records));
    return true;
  } catch {
    return false;
  }
}

function providerList() {
  const initial = `<button class="provider-list-item ${selectedId === INITIAL_PROVIDER_ID ? "is-selected" : ""}" type="button" data-provider-id="${INITIAL_PROVIDER_ID}">
    <span class="provider-list-head"><strong>初始供应商</strong>${!settings.activeId ? "<small>使用中</small>" : ""}</span>
    <span class="provider-list-model">${INITIAL_PROVIDER_MODEL}</span>
  </button>`;
  return initial + settings.providers.map((item) => `<button class="provider-list-item ${selectedId === item.id ? "is-selected" : ""}" type="button" data-provider-id="${escapeHTML(item.id)}">
    <span class="provider-list-head"><strong>${escapeHTML(item.name)}</strong>${settings.activeId === item.id ? "<small>使用中</small>" : ""}</span>
    <span class="provider-list-model">${escapeHTML(item.model)}</span>
  </button>`).join("");
}

function providerEditor() {
  if (selectedId === INITIAL_PROVIDER_ID) {
    return `<div class="settings-editor-heading">
      <div><span class="eyebrow">BUILT-IN PROVIDER</span><h2>初始供应商</h2></div>
      ${!settings.activeId ? "<span class=\"settings-active-badge\">正在使用</span>" : ""}
    </div>
    <div class="initial-provider-card">
      <span>内置模型</span><strong>${INITIAL_PROVIDER_MODEL}</strong>
      <p>由 Arcana 服务端统一提供，新用户不需要填写地址或 API Key。初始供应商不能编辑或删除。</p>
    </div>
    ${settings.activeId ? "<button class=\"settings-save\" id=\"activate-initial-provider\" type=\"button\">设为当前供应商</button>" : ""}
    <p id="settings-feedback" class="settings-feedback" role="status" aria-live="polite"></p>`;
  }
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
      <button class="settings-save" type="submit">${editing ? "保存并使用" : "添加并使用"}</button>
      ${editing && settings.activeId !== item.id ? "<button class=\"settings-action-secondary\" id=\"activate-provider\" type=\"button\">设为当前供应商</button>" : ""}
      ${editing && pendingDeleteId === item.id
        ? "<button class=\"settings-delete\" id=\"confirm-delete-provider\" type=\"button\">确定删除</button><button class=\"settings-action-secondary\" id=\"cancel-delete-provider\" type=\"button\">取消</button>"
        : editing ? "<button class=\"settings-delete\" id=\"delete-provider\" type=\"button\">删除供应商</button>" : ""}
    </div>
    <p id="settings-feedback" class="settings-feedback" role="status" aria-live="polite"></p>
  </form>
  <p class="settings-storage-note">登录后会加密同步到你的 Arcana 账号；未登录时只保存在当前浏览器。</p>`;
}

function profileMeta(profile) {
  const values = [profile.zodiac, ...profile.focusAreas].filter(Boolean);
  return values.length ? values.join(" · ") : "尚未填写更多信息";
}

function userManager() {
  const active = userProfiles.find((profile) => profile.isActive);
  const rows = userProfiles.length
    ? userProfiles.map((profile) => `<div class="user-profile-row" data-profile-id="${escapeHTML(profile.id)}">
        <div class="user-profile-actions">
          <button type="button" tabindex="-1" data-profile-edit="${escapeHTML(profile.id)}">编辑</button>
          <button class="is-delete" type="button" tabindex="-1" data-profile-delete="${escapeHTML(profile.id)}">删除</button>
        </div>
        <div class="user-profile-surface">
          <span class="user-profile-copy"><strong>${escapeHTML(profile.nickname || "未命名用户")}</strong><small>${escapeHTML(profileMeta(profile))}</small></span>
          <label class="profile-row-toggle" aria-label="${profile.isActive ? "停用" : "启用"}${escapeHTML(profile.nickname || "这个用户")}">
            <input type="checkbox" data-profile-toggle="${escapeHTML(profile.id)}" ${profile.isActive ? "checked" : ""}><i aria-hidden="true"></i>
          </label>
        </div>
      </div>`).join("")
    : `<div class="settings-empty user-profile-empty"><strong>还没有用户</strong><span>添加后，可以在每次解读前选择要使用的个人信息。</span></div>`;
  return `<main class="user-manager">
    <div class="user-manager-heading"><span class="eyebrow">PERSONAL CONTEXT</span><h1>用户信息</h1><p>${active ? `当前解读使用：${escapeHTML(active.nickname || "未命名用户")}` : "当前未使用任何用户信息。打开某位用户右侧的开关即可启用。"}</p></div>
    <section class="user-profile-list" aria-label="用户列表">${rows}</section>
    <p class="user-swipe-hint">向左滑动用户可编辑或删除；任何时候最多启用一位用户。</p>
    <button id="add-user-profile" class="add-user-profile" type="button">＋ 添加用户</button>
    <p id="settings-feedback" class="settings-feedback" role="status" aria-live="polite"></p>
  </main>`;
}

function userProfileEditor() {
  const profile = userProfiles.find((item) => item.id === editingUserId);
  const editing = Boolean(profile);
  const value = profile || { nickname: "", age: "", gender: "", zodiac: "", currentStatus: "", focusAreas: [] };
  const zodiacOptions = ["", ...ZODIACS].map((zodiac) => `<option value="${zodiac}" ${value.zodiac === zodiac ? "selected" : ""}>${zodiac || "请选择星座"}</option>`).join("");
  return `<main class="settings-detail-single"><section class="settings-editor" aria-label="${editing ? "编辑用户" : "添加用户"}">
    <div class="settings-editor-heading"><div><span class="eyebrow">${editing ? "EDIT PROFILE" : "NEW PROFILE"}</span><h2>${editing ? "编辑用户" : "添加用户"}</h2></div></div>
    <p class="settings-editor-intro">这些内容都可以不填。启用该用户后，实际填写的内容会成为塔罗师理解你处境的背景。</p>
    <form id="user-profile-form" novalidate>
      <div class="profile-fields">
        <label class="settings-field"><span>昵称</span><input name="nickname" type="text" maxlength="80" autocomplete="nickname" placeholder="希望塔罗师怎么称呼你" value="${escapeHTML(value.nickname)}"></label>
        <div class="profile-two-columns">
          <label class="settings-field"><span>年龄</span><input name="age" type="text" maxlength="20" inputmode="numeric" placeholder="选填" value="${escapeHTML(value.age || "")}"></label>
          <label class="settings-field"><span>性别</span><select name="gender"><option value="">请选择</option><option value="女" ${value.gender === "女" ? "selected" : ""}>女</option><option value="男" ${value.gender === "男" ? "selected" : ""}>男</option></select></label>
        </div>
        <label class="settings-field"><span>星座</span><select name="zodiac">${zodiacOptions}</select></label>
        <label class="settings-field"><span>关注方向</span><input name="focusAreas" type="text" maxlength="300" autocomplete="off" placeholder="例如：感情、工作、自我成长" value="${escapeHTML(value.focusAreas.join("、"))}"><small>用逗号或顿号分开，最多 12 项。</small></label>
        <label class="settings-field"><span>当前状态</span><textarea name="currentStatus" maxlength="1000" rows="7" placeholder="例如最近正在经历什么、在意什么，或生活处于什么阶段">${escapeHTML(value.currentStatus)}</textarea><small><span id="profile-status-count">${value.currentStatus.length}</span> / 1000</small></label>
      </div>
      <div class="settings-form-actions user-profile-form-actions">
        <button class="settings-save settings-save-plain" type="submit">保存</button>
        ${editing ? "<button class=\"delete-user-profile\" id=\"delete-user-profile\" type=\"button\">删除该用户</button>" : ""}
      </div>
      <p id="settings-feedback" class="settings-feedback" role="status" aria-live="polite"></p>
    </form>
    <p class="settings-storage-note">登录后会同步到你的 Arcana 账号。列表里未启用用户时，解读请求不会携带任何个人信息。</p>
  </section></main>`;
}

function settingsHome() {
  return `<main class="settings-home">
    <div class="settings-home-heading"><span class="eyebrow">ARCANA SETTINGS</span><h1>设置</h1><p>管理解读模型，以及你愿意告诉塔罗师的个人背景。</p></div>
    <section class="settings-home-group" aria-label="设置项目">
      <button type="button" data-settings-section="providers"><span><strong>供应商</strong><small>添加、编辑或切换解读模型</small></span><em>${settings.providers.length + 1} 个配置　›</em></button>
      <button type="button" data-settings-section="profile-list"><span><strong>用户信息</strong><small>管理不同用户的个人背景</small></span><em>${userProfiles.find((profile) => profile.isActive)?.nickname ? `${escapeHTML(userProfiles.find((profile) => profile.isActive).nickname)}　›` : `${userProfiles.length} 位用户　›`}</em></button>
      <button type="button" data-cloud-history><span><strong>历史牌阵</strong><small>查看登录账号的云端记录</small></span><em>查看记录　›</em></button>
    </section>
  </main>`;
}

function historyThumbnails(record) {
  return `<div class="history-card-thumbnails ${record.spread === 10 ? "history-card-thumbnails-10" : ""}" aria-label="本次抽到的牌">${record.cards.map((card) => `<figure class="history-card-thumb"><img src="/assets/cards/${card.id}.webp" alt="${escapeHTML(card.chinese)}${card.reversed ? "逆位" : "正位"}" style="transform:rotate(${card.reversed ? 180 : 0}deg)"><figcaption>${escapeHTML(card.chinese)}</figcaption></figure>`).join("")}</div>`;
}

function historyTimeline(records) {
  if (!records.length) return `<div class="history-empty"><span>◇</span><strong>还没有历史牌阵</strong><p>用这位用户完成一次完整解读后，记录会自动出现在这里。</p></div>`;
  return `<section class="history-timeline" aria-label="历史牌阵列表">${records.map((record) => `<article class="history-entry" data-history-id="${escapeHTML(record.id)}">
    <span class="history-dot" aria-hidden="true"></span>
    <div class="history-swipe-shell">
      <button class="history-delete-button" type="button" tabindex="-1" data-history-delete="${escapeHTML(record.id)}" aria-label="删除这条历史牌阵">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>
        <span>删除</span>
      </button>
      <div class="history-bubble">
        <header><time>${escapeHTML(record.timestamp)}</time><span>${escapeHTML(record.spreadLabel)}</span></header>
        <p class="history-question">Q // ${escapeHTML(record.question)}</p>
        <blockquote>“${escapeHTML(record.summary)}”</blockquote>
        ${historyThumbnails(record)}
      </div>
    </div>
  </article>`).join("")}</section>`;
}

function historyPage() {
  if (!userProfiles.some((profile) => profile.id === historyUserId)) {
    historyUserId = userProfiles.find((profile) => profile.isActive)?.id || userProfiles[0]?.id || null;
  }
  const profile = userProfiles.find((item) => item.id === historyUserId);
  const options = userProfiles.map((item) => `<option value="${escapeHTML(item.id)}" ${item.id === historyUserId ? "selected" : ""}>${escapeHTML(item.nickname || "未命名用户")}</option>`).join("");
  const records = loadHistoryRecords(historyUserId);
  return `<main class="history-page">
    <div class="history-user-picker">
      <label for="history-user-select">选择用户</label>
      <select id="history-user-select" ${userProfiles.length ? "" : "disabled"}>${options || "<option>还没有用户</option>"}</select>
    </div>
    <div class="history-heading"><span class="eyebrow">TAROT ARCHIVE</span><h1>${escapeHTML(profile?.nickname || "历史牌阵")}</h1><p>历史记录</p></div>
    ${userProfiles.length ? historyTimeline(records) : `<div class="history-empty"><span>◇</span><strong>请先添加用户</strong><p>历史记录会按照用户档案分别保存。</p></div>`}
    <p id="settings-feedback" class="settings-feedback" role="status" aria-live="polite"></p>
  </main>`;
}

function providerSidebar() {
  return `<aside class="settings-sidebar">
    <span class="eyebrow">PROVIDERS</span>
    <h1>供应商</h1>
    <p>选择负责解读和继续对话的模型。</p>
    <div class="settings-list-heading"><strong>已添加</strong><button id="new-provider" type="button">＋ 添加</button></div>
    <div class="provider-list">${providerList()}</div>
    <p class="settings-sidebar-note">初始供应商由 Arcana 提供；你也可以添加自己的 OpenAI 兼容供应商。</p>
  </aside>`;
}

function renderSettings(message = "") {
  const overlay = document.querySelector("#provider-settings");
  if (!overlay) return;
  const home = activeSection === "home";
  let content = settingsHome();
  if (activeSection === "providers") content = `<div class="settings-layout">${providerSidebar()}<section class="settings-editor" aria-label="供应商配置">${providerEditor()}</section></div>`;
  if (activeSection === "profile-list") content = userManager();
  if (activeSection === "profile-edit") content = userProfileEditor();
  if (activeSection === "history") content = historyPage();
  overlay.innerHTML = `<div class="settings-page">
    <header class="settings-header"><span class="settings-brand"><span aria-hidden="true"></span> ARCANA <small>/ SETTINGS</small></span><button id="settings-back" type="button">${home ? "← 返回抽牌" : "← 返回设置"}</button></header>
    ${content}
  </div>`;
  overlay.querySelector("#settings-back").addEventListener("click", () => {
    if (home) closeSettings();
    else if (activeSection === "profile-edit") { activeSection = "profile-list"; editingUserId = null; renderSettings(); }
    else { activeSection = "home"; pendingDeleteId = null; renderSettings(); }
  });
  overlay.querySelectorAll("[data-settings-section]").forEach((button) => button.addEventListener("click", () => {
    activeSection = button.dataset.settingsSection;
    pendingDeleteId = null;
    renderSettings();
  }));
  overlay.querySelector("[data-cloud-history]")?.addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("arcana:open-cloud-history"));
  });
  if (activeSection === "profile-list") bindUserManager(overlay);
  if (activeSection === "profile-edit") bindUserProfileEditor(overlay);
  if (activeSection === "providers") bindProviderEditor(overlay);
  if (activeSection === "history") {
    overlay.querySelector("#history-user-select")?.addEventListener("change", (event) => {
      historyUserId = event.currentTarget.value;
      renderSettings();
    });
    bindHistoryTimeline(overlay);
  }
  if (message) showFeedback(message);
}

function bindHistoryTimeline(overlay) {
  let openEntry = null;
  const revealWidth = 86;
  const setEntryOpen = (entry, shouldOpen) => {
    entry.classList.toggle("is-open", shouldOpen);
    const button = entry.querySelector(".history-delete-button");
    if (button) button.tabIndex = shouldOpen ? 0 : -1;
  };
  overlay.querySelectorAll(".history-entry").forEach((entry) => {
    const bubble = entry.querySelector(".history-bubble");
    let startX = 0;
    let startY = 0;
    let offset = 0;
    let dragging = false;
    bubble.addEventListener("pointerdown", (event) => {
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
      const x = Math.max(-revealWidth, Math.min(0, offset + dx));
      bubble.style.transform = `translateX(${x}px)`;
    });
    const finish = (event) => {
      if (!dragging) return;
      dragging = false;
      const moved = event.clientX - startX;
      const shouldOpen = offset + moved < -34;
      bubble.style.transform = "";
      setEntryOpen(entry, shouldOpen);
      openEntry = shouldOpen ? entry : null;
    };
    bubble.addEventListener("pointerup", finish);
    bubble.addEventListener("pointercancel", () => { dragging = false; bubble.style.transform = ""; });
  });
  overlay.querySelectorAll("[data-history-delete]").forEach((button) => button.addEventListener("click", () => {
    if (deleteHistoryRecord(historyUserId, button.dataset.historyDelete)) renderSettings("这条历史牌阵已删除。");
    else showFeedback("没有找到这条记录，请刷新后重试。", true);
  }));
}

function bindUserManager(overlay) {
  overlay.querySelector("#add-user-profile").addEventListener("click", () => {
    editingUserId = null;
    activeSection = "profile-edit";
    renderSettings();
  });
  overlay.querySelectorAll("[data-profile-toggle]").forEach((input) => input.addEventListener("change", () => {
    const id = input.dataset.profileToggle;
    const next = userProfiles.map((profile) => ({ ...profile, isActive: input.checked && profile.id === id }));
    if (persistProfiles(next)) renderSettings(input.checked ? "已启用这位用户的信息。" : "已关闭个人信息，解读时不会发送这些内容。");
  }));
  overlay.querySelectorAll("[data-profile-edit]").forEach((button) => button.addEventListener("click", () => {
    editingUserId = button.dataset.profileEdit;
    activeSection = "profile-edit";
    renderSettings();
  }));
  overlay.querySelectorAll("[data-profile-delete]").forEach((button) => button.addEventListener("click", () => {
    const profile = userProfiles.find((item) => item.id === button.dataset.profileDelete);
    if (!profile) return;
    if (persistProfiles(userProfiles.filter((item) => item.id !== profile.id))) renderSettings(`${profile.nickname || "该用户"}已删除。`);
  }));
  bindProfileSwipe(overlay);
}

function bindProfileSwipe(overlay) {
  let openRow = null;
  const setRowOpen = (row, shouldOpen) => {
    row.classList.toggle("is-open", shouldOpen);
    row.querySelectorAll(".user-profile-actions button").forEach((button) => {
      button.tabIndex = shouldOpen ? 0 : -1;
    });
  };
  overlay.querySelectorAll(".user-profile-row").forEach((row) => {
    const surface = row.querySelector(".user-profile-surface");
    let startX = 0;
    let startY = 0;
    let offset = 0;
    let dragging = false;
    surface.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".profile-row-toggle")) return;
      if (openRow && openRow !== row) setRowOpen(openRow, false);
      startX = event.clientX;
      startY = event.clientY;
      offset = row.classList.contains("is-open") ? -140 : 0;
      dragging = true;
      surface.setPointerCapture(event.pointerId);
    });
    surface.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) { dragging = false; surface.style.transform = ""; return; }
      const x = Math.max(-140, Math.min(0, offset + dx));
      surface.style.transform = `translateX(${x}px)`;
    });
    const finish = (event) => {
      if (!dragging) return;
      dragging = false;
      const moved = event.clientX - startX;
      const shouldOpen = offset + moved < -45;
      surface.style.transform = "";
      setRowOpen(row, shouldOpen);
      openRow = shouldOpen ? row : null;
    };
    surface.addEventListener("pointerup", finish);
    surface.addEventListener("pointercancel", () => { dragging = false; surface.style.transform = ""; });
  });
}

function bindUserProfileEditor(overlay) {
  const form = overlay.querySelector("#user-profile-form");
  const status = form.elements.currentStatus;
  status.addEventListener("input", () => { overlay.querySelector("#profile-status-count").textContent = status.value.length; });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const existing = userProfiles.find((profile) => profile.id === editingUserId);
    const focusAreas = [...new Set(form.elements.focusAreas.value.split(/[，,、]/).map((item) => item.trim().slice(0, 40)).filter(Boolean))].slice(0, 12);
    const record = {
      id: existing?.id || makeId(),
      nickname: form.elements.nickname.value.trim(),
      age: form.elements.age.value.trim(),
      gender: form.elements.gender.value,
      zodiac: form.elements.zodiac.value,
      currentStatus: status.value.trim(),
      focusAreas,
      isActive: existing?.isActive ?? !userProfiles.some((profile) => profile.isActive),
    };
    const next = existing
      ? userProfiles.map((profile) => profile.id === existing.id ? record : profile)
      : [...userProfiles, record];
    if (persistProfiles(next)) {
      editingUserId = null;
      activeSection = "profile-list";
      renderSettings("用户信息已保存。");
    }
  });
  overlay.querySelector("#delete-user-profile")?.addEventListener("click", () => {
    const profile = userProfiles.find((item) => item.id === editingUserId);
    if (!profile) return;
    if (persistProfiles(userProfiles.filter((item) => item.id !== profile.id))) {
      editingUserId = null;
      activeSection = "profile-list";
      renderSettings(`${profile.nickname || "该用户"}已删除。`);
    }
  });
}

function bindProviderEditor(overlay) {
  overlay.querySelector("#new-provider").addEventListener("click", () => { selectedId = null; pendingDeleteId = null; renderSettings(); });
  overlay.querySelectorAll("[data-provider-id]").forEach((button) => button.addEventListener("click", () => {
    selectedId = button.dataset.providerId;
    pendingDeleteId = null;
    renderSettings();
  }));
  overlay.querySelector("#activate-initial-provider")?.addEventListener("click", () => {
    if (persistProviders({ ...settings, activeId: null })) { selectedId = INITIAL_PROVIDER_ID; renderSettings("已切换到初始供应商。"); }
  });
  const keyInput = overlay.querySelector("#provider-key");
  const toggle = overlay.querySelector("#toggle-key");
  if (!keyInput || !toggle) return;
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
    selectedId = providers[0]?.id || INITIAL_PROVIDER_ID;
    renderSettings("供应商已删除。");
  }
}

function closeSettings() {
  document.querySelector("#provider-settings")?.remove();
  pendingDeleteId = null;
  editingUserId = null;
  document.body.classList.remove("settings-open");
  document.querySelector(".site-shell").inert = false;
  document.querySelector(".wordmark")?.focus();
}

export function openSettings(section = "home") {
  if (document.querySelector("#provider-settings")) return;
  activeSection = section === "profile" ? "profile-list" : section;
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
  overlay.querySelector("#settings-back")?.focus();
}

export function initializeProviderSettings(callback = () => {}) {
  onChange = callback;
  document.querySelector(".wordmark")?.addEventListener("click", (event) => { event.preventDefault(); openSettings(); });
  window.addEventListener("keydown", (event) => { if (event.key === "Escape" && document.querySelector("#provider-settings")) closeSettings(); });
  window.addEventListener("storage", (event) => {
    if (![PROVIDER_STORAGE_KEY, PROFILE_STORAGE_KEY, LEGACY_PROFILE_STORAGE_KEY].includes(event.key) && !event.key?.startsWith(HISTORY_STORAGE_PREFIX)) return;
    settings = loadSettings();
    userProfiles = loadProfiles();
    if (selectedId !== null && selectedId !== INITIAL_PROVIDER_ID && !settings.providers.some((item) => item.id === selectedId)) selectedId = settings.activeId || INITIAL_PROVIDER_ID;
    onChange();
    renderSettings();
  });
  callback();
}
