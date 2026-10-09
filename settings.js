import { cardImageURL, cardImageSrcSet } from "./cards.js?v=20261010-notes";

const PROVIDER_STORAGE_KEY = "arcana.providers.v1";
const INITIAL_PROVIDER_ID = "__arcana_initial_provider__";
const PROFILE_STORAGE_KEY = "arcana.user-profiles.v2";
const LEGACY_PROFILE_STORAGE_KEY = "arcana.user-info.v1";
const HISTORY_STORAGE_PREFIX = "arcana_history_";
const ACCOUNT_CACHE_USER_KEY = "arcana.account-cache-user.v1";
const GUEST_AVATAR_STORAGE_KEY = "arcana.guest-avatar.v1";
const MAX_AVATAR_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_AVATAR_BYTES = 64 * 1024;
const AVATAR_EDGE = 256;
const MAX_PROFILE_NOTES = 20;
const MAX_PROFILE_NOTE_LENGTH = 300;
const MAX_PROFILE_NOTES_TOTAL_LENGTH = 6000;
const MIN_PROFILE_NOTE_TOPIC_LENGTH = 2;
const MAX_PROFILE_NOTE_TOPIC_LENGTH = 4;
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
let personalProfileId = null;
let historyUserId = userProfiles.find((profile) => profile.isActive)?.id || userProfiles[0]?.id || null;
let pendingDeleteId = null;
let onChange = () => {};
let cloudAccountId = null;
let cloudSaveChain = Promise.resolve();
let accountSettingsSyncVersion = 0;
let profileNotesViewVersion = 0;
let profileNotesController = null;
let profileNoteDetailsCleanup = null;
let accountContext = null;
let avatarUploadVersion = 0;
let avatarUploadBusy = false;

export function normalizeAvatarDataURL(value) {
  if (typeof value !== "string" || value.length > 23 + Math.ceil(MAX_AVATAR_BYTES / 3) * 4) return "";
  return /^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(value) && (value.length - 23) % 4 === 0 ? value : "";
}

export function getGuestAvatar() {
  try { return normalizeAvatarDataURL(localStorage.getItem(GUEST_AVATAR_STORAGE_KEY) || ""); }
  catch { return ""; }
}

function currentAvatar() {
  return accountContext ? normalizeAvatarDataURL(accountContext.avatar || "") : getGuestAvatar();
}

function saveGuestAvatar(avatar) {
  try {
    if (avatar) localStorage.setItem(GUEST_AVATAR_STORAGE_KEY, avatar);
    else localStorage.removeItem(GUEST_AVATAR_STORAGE_KEY);
  } catch {
    throw new Error("浏览器没有保存头像，请检查是否允许本地存储。");
  }
  document.dispatchEvent(new CustomEvent("arcana:guest-avatar-change"));
}

async function compressAvatar(file) {
  if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("请选择 JPG、PNG 或 WebP 图片。");
  if (!file.size || file.size > MAX_AVATAR_INPUT_BYTES) throw new Error("请选择 8 MB 以内的图片。");
  const source = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const picture = new Image();
      picture.onload = () => resolve(picture);
      picture.onerror = () => reject(new Error("这张图片无法打开，请换一张图片。"));
      picture.src = source;
    });
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height || width * height > 32_000_000 || Math.max(width, height) > 12_000) throw new Error("图片尺寸过大，请换一张较小的图片。");
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_EDGE;
    canvas.height = AVATAR_EDGE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("暂时无法处理图片，请重新打开页面后再试。");
    context.fillStyle = "#ece6db";
    context.fillRect(0, 0, AVATAR_EDGE, AVATAR_EDGE);
    const crop = Math.min(width, height);
    context.drawImage(image, (width - crop) / 2, (height - crop) / 2, crop, crop, 0, 0, AVATAR_EDGE, AVATAR_EDGE);
    for (const quality of [.86, .74, .62, .5]) {
      const avatar = normalizeAvatarDataURL(canvas.toDataURL("image/jpeg", quality));
      if (avatar) return avatar;
    }
    throw new Error("这张图片无法处理成头像，请换一张图片。");
  } finally {
    URL.revokeObjectURL(source);
  }
}

function personalIcon(name, className = "personal-icon") {
  const paths = {
    back: '<path d="m14 6-6 6 6 6M8 12h12"/>',
    next: '<path d="m9 5 7 7-7 7"/>',
    profile: '<circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
    notes: '<path d="M6 3h12v18H6zM9 8h6M9 12h6M9 16h4"/>',
    history: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
    provider: '<circle cx="8" cy="6" r="2"/><circle cx="16" cy="18" r="2"/><path d="M10 6h10M4 6h2M4 18h10M18 18h2M4 12h16"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="m7 7 10 10M17 7 7 17"/>',
  };
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.next}</svg>`;
}

function cancelProfileNotesView() {
  profileNoteDetailsCleanup?.();
  profileNotesViewVersion += 1;
  profileNotesController?.abort();
  profileNotesController = null;
}

async function accountDataRequest(method, body) {
  const response = await fetch("/api/account-data", {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "账号资料同步失败，请稍后重试。");
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

function defaultProfile(nickname) {
  return {
    id: makeId(),
    nickname: String(nickname || "").trim().slice(0, 80),
    age: "",
    gender: "",
    zodiac: "",
    currentStatus: "",
    focusAreas: [],
    isActive: true,
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
  if (document.querySelector("#provider-settings")) renderSettings("云端资料已同步。");
}

function queueCloudSave() {
  if (!cloudAccountId) return;
  const accountId = cloudAccountId;
  const snapshot = accountDataSnapshot();
  cloudSaveChain = cloudSaveChain.then(() => {
    if (accountId !== cloudAccountId) return;
    return accountDataRequest("PUT", snapshot);
  }).catch((error) => {
    if (accountId !== cloudAccountId) return;
    console.warn("Arcana account settings sync failed", error);
    showFeedback("已保存在本机，但云端同步失败，请稍后再试。", true);
  });
}

export async function syncAccountSettings(userId, nickname = "") {
  if (!userId) return;
  const syncVersion = ++accountSettingsSyncVersion;
  cancelProfileNotesView();
  cloudAccountId = null;
  const accountId = String(userId);
  const localSnapshot = accountDataSnapshot();
  const payload = await accountDataRequest("GET");
  if (syncVersion !== accountSettingsSyncVersion) return;
  const cachedOwner = localStorage.getItem(ACCOUNT_CACHE_USER_KEY);
  if (payload.hasData) {
    const shouldCarryGuestProviders = !cachedOwner
      && payload.providerSettings.providers.length === 0
      && localSnapshot.providerSettings.providers.length > 0;
    const providerSettings = shouldCarryGuestProviders
      ? localSnapshot.providerSettings
      : payload.providerSettings;
    applyAccountData(providerSettings, payload.profiles);
    if (shouldCarryGuestProviders) await accountDataRequest("PUT", accountDataSnapshot());
  } else if (!cachedOwner || cachedOwner === accountId) {
    if (!localSnapshot.profiles.length && String(nickname || "").trim()) {
      applyAccountData(localSnapshot.providerSettings, [defaultProfile(nickname)]);
    }
    await accountDataRequest("PUT", accountDataSnapshot());
  } else {
    applyAccountData({ providers: [], activeId: null }, [defaultProfile(nickname)]);
    await accountDataRequest("PUT", accountDataSnapshot());
  }
  if (syncVersion !== accountSettingsSyncVersion) return;
  localStorage.setItem(ACCOUNT_CACHE_USER_KEY, accountId);
  cloudAccountId = accountId;
  if (document.querySelector("#provider-settings")) renderSettings();
}

export function disconnectAccountSettings() {
  accountSettingsSyncVersion += 1;
  cancelProfileNotesView();
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
  return item ? `${item.name} · ${item.model}` : "初始供应商";
}

export function getProviderChoices() {
  return [
    { id: "", label: "初始供应商", active: !settings.activeId },
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
      fullReading: typeof item.fullReading === "string" ? item.fullReading : "",
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
  </button>`;
  return initial + settings.providers.map((item) => `<button class="provider-list-item ${selectedId === item.id ? "is-selected" : ""}" type="button" data-provider-id="${escapeHTML(item.id)}">
    <span class="provider-list-head"><strong>${escapeHTML(item.name)}</strong>${settings.activeId === item.id ? "<small>使用中</small>" : ""}</span>
    <span class="provider-list-model">${escapeHTML(item.model)}</span>
  </button>`).join("");
}

function providerEditor() {
  if (selectedId === INITIAL_PROVIDER_ID) {
    return `<div class="settings-editor-heading">
      <div><h2>初始供应商</h2></div>
      ${!settings.activeId ? "<span class=\"settings-active-badge\">正在使用</span>" : ""}
    </div>
    <p class="settings-editor-intro">由 Arcana 服务端统一提供，新用户不需要填写地址或 API Key。初始供应商不能编辑或删除。</p>
    ${settings.activeId ? "<button class=\"settings-save\" id=\"activate-initial-provider\" type=\"button\">设为当前供应商</button>" : ""}
    <p id="settings-feedback" class="settings-feedback" role="status" aria-live="polite"></p>`;
  }
  const item = settings.providers.find((provider) => provider.id === selectedId);
  const editing = Boolean(item);
  return `<div class="settings-editor-heading">
    <div><h2>${editing ? "编辑供应商" : "添加供应商"}</h2></div>
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
  const values = [...profile.focusAreas].filter(Boolean);
  return values.length ? values.join(" · ") : "尚未填写更多信息";
}

function primaryPersonalProfile() {
  return userProfiles.find((profile) => profile.isActive)
    || userProfiles.find((profile) => profile.id === personalProfileId)
    || userProfiles[0]
    || null;
}

function preparePersonalProfileEditor() {
  editingUserId = primaryPersonalProfile()?.id || null;
  activeSection = "profile-edit";
}

// 现在一个账号对应一个人，不再添加新用户。
// 旧账号里已有的多位用户可以删，但最后一位不能删，否则就没人了。
function canDeleteProfile() {
  return userProfiles.length > 1;
}

function userManager() {
  const active = userProfiles.find((profile) => profile.isActive);
  const deletable = canDeleteProfile();
  const rows = userProfiles.length
    ? userProfiles.map((profile) => `<div class="user-profile-row${deletable ? "" : " is-single-action"}" data-profile-id="${escapeHTML(profile.id)}">
        <div class="user-profile-actions">
          <button type="button" tabindex="-1" data-profile-edit="${escapeHTML(profile.id)}">编辑</button>
          ${deletable ? `<button class="is-delete" type="button" tabindex="-1" data-profile-delete="${escapeHTML(profile.id)}">删除</button>` : ""}
        </div>
        <div class="user-profile-surface">
          <span class="user-profile-copy"><strong>${escapeHTML(profile.nickname || "未命名用户")}</strong><small>${escapeHTML(profileMeta(profile))}</small></span>
          <button class="personal-profile-edit" type="button" data-profile-edit="${escapeHTML(profile.id)}">编辑</button>
        </div>
      </div>`).join("")
    : `<div class="settings-empty user-profile-empty"><strong>还没有用户</strong><span>添加后，可以在每次解读前选择要使用的个人信息。</span></div>`;
  return `<main class="user-manager">
    <div class="user-manager-heading"><h1>旧档案管理</h1><p>${active ? `当前解读使用：${escapeHTML(active.nickname || "未命名用户")}` : "个人信息已关闭，可回到个人中心启用。"}</p></div>
    <section class="user-profile-list" aria-label="用户列表">${rows}</section>
    <p class="user-swipe-hint">${deletable ? "向左滑动可删除旧档案，最后一位用户不能删除。" : "最后一位用户不能删除。"}</p>
    ${userProfiles.length ? "" : `<button id="add-user-profile" class="add-user-profile" type="button">${personalIcon("plus")} 填写我的信息</button>`}
    <p id="settings-feedback" class="settings-feedback" role="status" aria-live="polite"></p>
  </main>`;
}

function userProfileEditor(inline = false) {
  const profile = userProfiles.find((item) => item.id === editingUserId);
  const editing = Boolean(profile);
  const value = profile || { nickname: "", age: "", gender: "", zodiac: "", currentStatus: "", focusAreas: [] };
  return `${inline ? '' : '<main class="personal-profile-page settings-detail-single">'}<section class="settings-editor personal-information" aria-label="个人信息">
    <div class="settings-editor-heading"><div><h2>${personalIcon("profile")}个人信息</h2></div><span class="profile-optional">选填</span></div>
    ${userProfiles.length > 1 ? `<label class="settings-field personal-legacy-picker"><span>选择旧档案</span><select id="personal-profile-select">${userProfiles.map((item) => `<option value="${escapeHTML(item.id)}" ${item.id === editingUserId ? "selected" : ""}>${escapeHTML(item.nickname || "未命名用户")}${item.isActive ? " · 当前使用" : ""}</option>`).join("")}</select></label>` : ""}
    <form id="user-profile-form" novalidate>
      <div class="profile-fields">
        <div class="profile-basics">
        <label class="settings-field"><span>昵称</span><input name="nickname" type="text" maxlength="80" autocomplete="nickname" value="${escapeHTML(value.nickname)}"></label>
        <div class="profile-two-columns">
          <label class="settings-field"><span>年龄</span><input name="age" type="text" maxlength="20" inputmode="numeric" value="${escapeHTML(value.age || "")}"></label>
          <label class="settings-field"><span>性别</span><select name="gender"><option value="">请选择</option><option value="女" ${value.gender === "女" ? "selected" : ""}>女</option><option value="男" ${value.gender === "男" ? "selected" : ""}>男</option></select></label>
        </div>
        </div><div class="profile-context-fields">
        <label class="settings-field"><span>关注方向</span><input name="focusAreas" type="text" maxlength="300" autocomplete="off" placeholder="例如：感情、工作、自我成长" value="${escapeHTML(value.focusAreas.join("、"))}"><small>用逗号或顿号分开，最多 12 项。</small></label>
        <label class="settings-field"><span>当前状态</span><textarea name="currentStatus" maxlength="1000" rows="4">${escapeHTML(value.currentStatus)}</textarea><small><span id="profile-status-count">${value.currentStatus.length}</span> / 1000</small></label>
        </div>
      </div>
      <div class="settings-form-actions user-profile-form-actions">
        <button class="settings-save settings-save-plain" type="submit">保存</button>
        ${editing && canDeleteProfile() ? "<button class=\"delete-user-profile\" id=\"delete-user-profile\" type=\"button\">删除该用户</button>" : ""}
      </div>
      <p id="settings-feedback" class="settings-feedback" role="status" aria-live="polite"></p>
    </form>
    ${userProfiles.length > 1 ? '<button class="personal-legacy-link" type="button" data-settings-section="legacy-profiles">管理旧档案</button>' : ""}
    <p class="settings-storage-note">登录后同步到你的账号；未登录时保存在当前浏览器。</p>
  </section>${inline ? '' : '</main>'}`;
}

function profileNotesPanel(profile) {
  let status = "正在读取便签…";
  const enabled = Boolean(profile?.isActive);
  const available = Boolean(enabled && cloudAccountId);
  if (!profile) status = userProfiles.length ? "本次未启用个人信息，便签也不会被读取或整理。" : "保存并启用个人信息后，塔罗师的便签会出现在这里。";
  else if (!enabled) status = "这位用户的个人信息已关闭，便签不会被读取或整理。";
  else if (!cloudAccountId) status = "登录后，便签会保存在你的账号里，下次聊天也能用上。";
  return `<section class="profile-notes-panel${available ? "" : " is-unavailable"}" aria-label="塔罗师的便签" data-notes-profile="${available ? escapeHTML(profile.id) : ""}">
    <div class="profile-notes-heading"><h3>塔罗师的便签</h3><button type="button" class="profile-notes-clear" disabled>全部清空</button></div>

    <small class="profile-notes-capacity" hidden></small>
    <div class="profile-notes-list"><p class="profile-notes-empty">${status}</p></div>
    <p class="profile-notes-feedback" role="status" aria-live="polite"></p>
  </section>`;
}

function profileNotesPage() {
  const profile = userProfiles.find((item) => item.isActive);
  return `<main class="personal-notes-page user-manager">
    <div class="user-manager-heading"><h1>塔罗师的便签</h1></div>
    ${profileNotesPanel(profile)}
    ${!profile ? '<button class="personal-context-link" type="button" data-settings-section="profile-list">查看个人信息</button>' : ""}
    ${!accountContext ? '<button class="personal-context-link" type="button" data-personal-login>登录并保存便签</button>' : ""}
  </main>`;
}

function profileNoteDate(value) {
  if (!value) return "";
  const calendarDate = typeof value === "string" && value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (calendarDate) {
    const [, year, month, day] = calendarDate;
    const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (parsed.toISOString().slice(0, 10) !== value) return "";
    return `${Number(year)}年${Number(month)}月${Number(day)}日`;
  }
  const sqliteDate = typeof value === "string" && value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/);
  const normalized = sqliteDate
    ? `${sqliteDate[1]}T${sqliteDate[2]}${sqliteDate[3] ? `.${sqliteDate[3].padEnd(3, "0").slice(0, 3)}` : ""}Z`
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

function profileNoteTopic(note) {
  const value = Array.from(String(note.topic || note.category || "").trim()).slice(0, MAX_PROFILE_NOTE_TOPIC_LENGTH).join("");
  return Array.from(value).length >= MIN_PROFILE_NOTE_TOPIC_LENGTH ? value : "近况";
}

function profileNotesTextLength(notes) {
  return notes.reduce((total, note) => total + Array.from(profileNoteText(note)).length, 0);
}

function profileNoteHeadline(note) {
  return typeof note.headline === "string" && note.headline.trim() ? note.headline : String(note.text || "");
}

function profileNoteDetails(note) {
  return Array.isArray(note.details) ? note.details.filter((detail) => typeof detail === "string" && detail.trim()).slice(0, 5) : [];
}

function profileNoteText(note, headline = profileNoteHeadline(note), details = profileNoteDetails(note)) {
  return [headline, ...details].join("\n");
}

function bindProfileNotes(overlay) {
  const panel = overlay.querySelector(".profile-notes-panel");
  const profileId = panel?.dataset.notesProfile;
  if (!panel || !profileId || !cloudAccountId) return;
  const version = profileNotesViewVersion;
  const accountId = cloudAccountId;
  const controller = new AbortController();
  profileNotesController = controller;
  const list = panel.querySelector(".profile-notes-list");
  const clearButton = panel.querySelector(".profile-notes-clear");
  const feedback = panel.querySelector(".profile-notes-feedback");
  const capacity = panel.querySelector(".profile-notes-capacity");
  let notes = [];
  let busy = false;
  let detailsModal = null;
  let editingNoteId = null;
  const isCurrent = () => version === profileNotesViewVersion
    && accountId === cloudAccountId
    && panel.isConnected
    && userProfiles.some((profile) => profile.id === profileId && profile.isActive);
  const setFeedback = (message = "", error = false) => {
    if (!isCurrent()) return;
    feedback.textContent = message;
    feedback.classList.toggle("is-error", error);
  };
  const request = async (url, method = "GET", body) => {
    const response = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "便签暂时没有保存成功，请稍后重试。");
    return payload;
  };
  const focusNoteAction = (noteId, selector = "[data-note-edit]") => {
    const row = [...list.querySelectorAll(".profile-note")].find((item) => item.dataset.noteId === String(noteId));
    row?.querySelector(selector)?.focus({ preventScroll: true });
  };
  const canLeaveSummaryEditor = () => {
    if (editingNoteId == null) return true;
    setFeedback("请先保存或取消正在编辑的摘要。", true);
    focusNoteAction(editingNoteId, "textarea");
    return false;
  };
  const renderNotes = () => {
    if (!isCurrent()) return;
    editingNoteId = null;
    list.innerHTML = notes.length ? notes.map((note) => {
      const confirmed = profileNoteDate(note.last_evidence_at);
      return `<article class="profile-note" data-note-id="${escapeHTML(note.id)}">
        <div class="profile-note-heading"><strong>${escapeHTML(profileNoteTopic(note))}</strong><div class="profile-note-heading-actions">${note.user_edited ? '<span class="profile-note-edited">你编辑过</span>' : ""}<button type="button" class="profile-note-details-button" data-note-details aria-haspopup="dialog" aria-label="查看${escapeHTML(profileNoteTopic(note))}便签详情">详情${personalIcon("next")}</button></div></div>
        <p class="profile-note-text">${escapeHTML(profileNoteHeadline(note))}</p>
        <small class="profile-note-date">${confirmed ? `最近提及于 ${escapeHTML(confirmed)}` : "尚无近期确认"}</small>
        <div class="profile-note-actions"><button type="button" data-note-edit>编辑摘要</button><button type="button" data-note-delete>删除</button></div>
      </article>`;
    }).join("") : `<p class="profile-notes-empty">还没有便签。慢慢聊，塔罗师会记下你愿意告诉她的事情。</p>`;
    capacity.hidden = !notes.length;
    capacity.textContent = `${notes.length} / ${MAX_PROFILE_NOTES} 条 · ${profileNotesTextLength(notes)} / ${MAX_PROFILE_NOTES_TOTAL_LENGTH} 字`;
    clearButton.disabled = !notes.length || busy;
    list.querySelectorAll(".profile-note").forEach((row) => {
      const note = notes.find((item) => String(item.id) === row.dataset.noteId);
      row.querySelector("[data-note-edit]").addEventListener("click", () => editNote(row, note));
      row.querySelector("[data-note-details]").addEventListener("click", (event) => openDetails(note, event.currentTarget));
      row.querySelector("[data-note-delete]").addEventListener("click", () => {
        if (!canLeaveSummaryEditor()) return;
        mutateNote(`/api/profile-notes/${encodeURIComponent(note.id)}`, "DELETE", { profile_id: profileId }, "便签已删除，以后整理时会记得你的选择。");
      });
    });
  };
  const loadNotes = async () => {
    const payload = await request(`/api/profile-notes?profile_id=${encodeURIComponent(profileId)}`);
    if (!isCurrent()) return;
    notes = Array.isArray(payload.notes) ? payload.notes.filter((note) => note && (typeof note.headline === "string" || typeof note.text === "string") && note.id != null).slice(0, MAX_PROFILE_NOTES) : [];
    renderNotes();
  };
  const setControlsBusy = (disabled) => {
    panel.querySelectorAll("button, input, textarea").forEach((element) => { element.disabled = disabled; });
    detailsModal?.element.querySelectorAll("[data-detail-edit], [data-detail-remove], [data-detail-save], [data-detail-cancel], textarea").forEach((element) => { element.disabled = disabled; });
    if (!disabled && detailsModal?.element.querySelector("textarea")) {
      detailsModal.element.querySelectorAll("[data-detail-edit], [data-detail-remove]").forEach((element) => { element.disabled = true; });
    }
  };
  const mutateNote = async (url, method, body, message, detailFeedback = false, focusAfter = null) => {
    if (busy || !isCurrent()) return;
    busy = true;
    setControlsBusy(true);
    const report = (text, error = false) => {
      if (detailFeedback && detailsModal) detailsModal.setFeedback(text, error);
      else setFeedback(text, error);
    };
    report("正在保存…");
    try {
      await request(url, method, body);
      if (!isCurrent()) return;
      await loadNotes();
      if (!isCurrent()) return;
      if (detailsModal) {
        const updated = notes.find((note) => String(note.id) === String(detailsModal.noteId));
        if (updated) {
          detailsModal.render(updated);
          detailsModal.element.querySelector("[data-detail-close]").focus();
        }
        else detailsModal.close();
      }
      report(message);
      if (!detailsModal) focusAfter?.();
    } catch (error) {
      if (error.name !== "AbortError") report(error.message, true);
    } finally {
      busy = false;
      if (isCurrent()) {
        setControlsBusy(false);
        clearButton.disabled = !notes.length;
      }
    }
  };
  const editNote = (row, note) => {
    if (busy || !note || !isCurrent() || !canLeaveSummaryEditor()) return;
    editingNoteId = note.id;
    setFeedback();
    const topic = profileNoteTopic(note);
    const headline = profileNoteHeadline(note);
    row.innerHTML = `<label class="profile-note-topic-editor"><span>主题</span><input type="text" value="${escapeHTML(topic)}" placeholder="2–4 个字"><small>2–4 个字</small></label>
      <label class="profile-note-editor"><span>核心摘要</span><textarea rows="4">${escapeHTML(headline)}</textarea></label>
      <div class="profile-note-edit-footer"><small>摘要与详情共 <span data-note-count>${Array.from(profileNoteText(note)).length}</span> / ${MAX_PROFILE_NOTE_LENGTH} 字</small><div class="profile-note-actions"><button type="button" data-note-cancel>取消</button><button class="profile-note-save" type="button" data-note-save>保存</button></div></div>`;
    const input = row.querySelector("textarea");
    const topicInput = row.querySelector(".profile-note-topic-editor input");
    const updateTextCount = (event) => {
      if (event.isComposing) return;
      row.querySelector("[data-note-count]").textContent = Array.from(profileNoteText(note, input.value)).length;
    };
    input.addEventListener("input", updateTextCount);
    input.addEventListener("compositionend", updateTextCount);
    const finishEditing = () => { renderNotes(); focusNoteAction(note.id); };
    row.querySelector("[data-note-cancel]").addEventListener("click", finishEditing);
    row.querySelector("[data-note-save]").addEventListener("click", () => {
      const editedHeadline = input.value.trim();
      const editedTopic = topicInput.value.trim();
      const topicLength = Array.from(editedTopic).length;
      if (topicLength < MIN_PROFILE_NOTE_TOPIC_LENGTH || topicLength > MAX_PROFILE_NOTE_TOPIC_LENGTH) { setFeedback("主题请写 2–4 个字，例如工作、感情或近况。", true); topicInput.focus(); return; }
      if (!editedHeadline) { setFeedback("核心摘要不能为空。想去掉这一条，可以点删除。", true); input.focus(); return; }
      if (!validateNoteLength(note, editedHeadline, profileNoteDetails(note), setFeedback)) { input.focus(); return; }
      if (editedHeadline === headline && editedTopic === topic) { finishEditing(); return; }
      const changes = { profile_id: profileId };
      if (editedTopic !== topic) changes.topic = editedTopic;
      if (editedHeadline !== headline) changes.headline = editedHeadline;
      mutateNote(`/api/profile-notes/${encodeURIComponent(note.id)}`, "PATCH", changes, "便签已更新。", false, () => focusNoteAction(note.id));
    });
    input.focus();
  };
  const validateNoteLength = (note, headline, details, report) => {
    const length = Array.from(profileNoteText(note, headline, details)).length;
    if (length > MAX_PROFILE_NOTE_LENGTH) {
      report("每条便签的摘要与详情合计最多 300 字，请删减后再保存。", true);
      return false;
    }
    const otherLength = profileNotesTextLength(notes.filter((item) => String(item.id) !== String(note.id)));
    if (otherLength + length > MAX_PROFILE_NOTES_TOTAL_LENGTH) {
      report("全部便签合计最多 6000 字，请先删减一些内容再保存。", true);
      return false;
    }
    return true;
  };
  const openDetails = (initialNote, trigger) => {
    if (busy || !isCurrent() || detailsModal || !canLeaveSummaryEditor()) return;
    const backdrop = document.createElement("div");
    backdrop.className = "profile-note-details-backdrop";
    backdrop.innerHTML = `<section class="profile-note-details-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-note-details-title" tabindex="-1">
      <header class="profile-note-details-header"><div><small data-detail-topic></small><h2 id="profile-note-details-title">补充事实</h2></div><button type="button" class="profile-note-details-close" data-detail-close aria-label="关闭详情">${personalIcon("close")}</button></header>
      <div class="profile-note-details-body" data-detail-list></div>
      <p class="profile-note-details-feedback" data-detail-feedback role="status" aria-live="polite"></p>
      <footer class="profile-note-details-footer"><button type="button" data-detail-back>${personalIcon("back")}返回便签</button></footer>
    </section>`;
    const background = [...overlay.children].map((element) => ({ element, inert: element.inert }));
    background.forEach(({ element }) => { element.inert = true; });
    overlay.append(backdrop);
    const modalController = new AbortController();
    const options = { signal: modalController.signal };
    const dialog = backdrop.querySelector(".profile-note-details-dialog");
    const detailList = backdrop.querySelector("[data-detail-list]");
    const detailFeedback = backdrop.querySelector("[data-detail-feedback]");
    const setDetailFeedback = (message = "", error = false) => {
      if (!isCurrent() || !detailsModal) return;
      detailFeedback.textContent = message;
      detailFeedback.classList.toggle("is-error", error);
    };
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      modalController.abort();
      backdrop.remove();
      background.forEach(({ element, inert }) => { element.inert = inert; });
      detailsModal = null;
      if (profileNoteDetailsCleanup === close) profileNoteDetailsCleanup = null;
      const currentRow = [...list.querySelectorAll(".profile-note")].find((row) => row.dataset.noteId === String(initialNote.id));
      const returnTarget = trigger.isConnected ? trigger : currentRow?.querySelector("[data-note-details]");
      returnTarget?.focus({ preventScroll: true });
    };
    const render = (note) => {
      if (!isCurrent() || closed) return;
      backdrop.querySelector("[data-detail-topic]").textContent = profileNoteTopic(note);
      const details = profileNoteDetails(note);
      detailList.innerHTML = details.length ? details.map((detail, index) => `<article class="profile-note-detail" data-detail-index="${index}"><p>${escapeHTML(detail)}</p><div class="profile-note-actions"><button type="button" data-detail-edit aria-label="编辑第 ${index + 1} 条补充事实">编辑</button><button type="button" data-detail-remove aria-label="移除第 ${index + 1} 条补充事实">移除</button></div></article>`).join("") : '<p class="profile-note-details-empty">这条便签暂时没有补充事实。</p>';
      detailList.querySelectorAll("[data-detail-index]").forEach((row) => {
        const index = Number(row.dataset.detailIndex);
        row.querySelector("[data-detail-edit]").addEventListener("click", () => {
          if (busy || !isCurrent()) return;
          setDetailFeedback();
          detailList.querySelectorAll("[data-detail-edit], [data-detail-remove]").forEach((element) => { element.disabled = true; });
          row.innerHTML = `<label class="profile-note-detail-editor"><span class="sr-only">编辑第 ${index + 1} 条补充事实</span><textarea rows="3">${escapeHTML(details[index])}</textarea></label><div class="profile-note-edit-footer"><small>摘要与详情共 <span data-detail-count>${Array.from(profileNoteText(note)).length}</span> / ${MAX_PROFILE_NOTE_LENGTH} 字</small><div class="profile-note-actions"><button type="button" data-detail-cancel>取消</button><button type="button" class="profile-note-save" data-detail-save>保存</button></div></div>`;
          const input = row.querySelector("textarea");
          const editedDetails = () => details.map((detail, itemIndex) => itemIndex === index ? input.value.trim() : detail);
          const updateCount = () => { row.querySelector("[data-detail-count]").textContent = Array.from(profileNoteText(note, profileNoteHeadline(note), editedDetails())).length; };
          input.addEventListener("input", updateCount);
          const finishEditing = () => {
            render(note);
            setDetailFeedback();
            detailList.querySelectorAll("[data-detail-index]")[index]?.querySelector("[data-detail-edit]")?.focus();
          };
          row.querySelector("[data-detail-cancel]").addEventListener("click", finishEditing);
          row.querySelector("[data-detail-save]").addEventListener("click", () => {
            if (!input.value.trim()) { setDetailFeedback("补充事实不能为空。想去掉这一条，可以点移除。", true); input.focus(); return; }
            const nextDetails = editedDetails();
            if (!validateNoteLength(note, profileNoteHeadline(note), nextDetails, setDetailFeedback)) { input.focus(); return; }
            if (nextDetails[index] === details[index]) { finishEditing(); return; }
            mutateNote(`/api/profile-notes/${encodeURIComponent(note.id)}`, "PATCH", { profile_id: profileId, details: nextDetails }, "补充事实已更新。", true);
          });
          input.focus();
        });
        row.querySelector("[data-detail-remove]").addEventListener("click", () => {
          if (busy || !isCurrent()) return;
          const nextDetails = details.filter((_, itemIndex) => itemIndex !== index);
          mutateNote(`/api/profile-notes/${encodeURIComponent(note.id)}`, "PATCH", { profile_id: profileId, details: nextDetails }, "这条补充事实已移除。", true);
        });
      });
    };
    detailsModal = { element: backdrop, noteId: initialNote.id, render, close, setFeedback: setDetailFeedback };
    profileNoteDetailsCleanup = close;
    backdrop.querySelector("[data-detail-close]").addEventListener("click", close, options);
    backdrop.querySelector("[data-detail-back]").addEventListener("click", close, options);
    backdrop.addEventListener("click", (event) => {
      event.stopPropagation();
      if (event.target === backdrop) close();
    }, options);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === "Tab") {
        const focusable = [...backdrop.querySelectorAll("button:not(:disabled), textarea:not(:disabled)")];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first) { event.preventDefault(); dialog.focus(); }
        else if (event.shiftKey && (document.activeElement === first || !backdrop.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !backdrop.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    }, { ...options, capture: true });
    render(initialNote);
    backdrop.querySelector("[data-detail-close]").focus();
  };
  clearButton.addEventListener("click", () => {
    if (busy || !notes.length || !isCurrent() || !canLeaveSummaryEditor()) return;
    if (!window.confirm("清空这位用户的全部塔罗师便签？删除过的内容会被记住，除非你再次亲口提起，否则不会自动写回。")) return;
    mutateNote("/api/profile-notes", "DELETE", { profile_id: profileId }, "全部便签已清空。");
  });
  (async () => {
    try {
      await cloudSaveChain;
      if (isCurrent()) await loadNotes();
    } catch (error) {
      if (!isCurrent() || error.name === "AbortError") return;
      list.innerHTML = `<p class="profile-notes-empty">便签暂时读取失败，请返回后重新打开。</p>`;
      setFeedback(error.message, true);
    }
  })();
}

export function personalRail(selected = "") {
  const profile = primaryPersonalProfile();
  const nickname = accountContext?.nickname || profile?.nickname || "来访者";
  const avatar = currentAvatar();
  const selectedAttribute = (key) => selected === key ? 'class="is-current" aria-current="page"' : "";
  return `<aside class="personal-rail" aria-label="个人中心导航">
    <button class="personal-rail-account" type="button" data-settings-section="home"><span class="personal-rail-avatar">${avatar ? `<img src="${escapeHTML(avatar)}" alt="" width="48" height="48">` : personalIcon("profile")}</span><strong>${escapeHTML(nickname)}</strong></button>
    <nav class="personal-rail-navigation">
      <button type="button" data-settings-section="home" ${selectedAttribute("home")}>个人中心</button>
      <button type="button" data-settings-section="profile-list" ${selectedAttribute("profile")}>${personalIcon("profile")}个人信息</button>
      <button type="button" data-settings-section="notes" ${selectedAttribute("notes")}>${personalIcon("notes")}塔罗师的便签</button>
      <button type="button" data-cloud-history ${selectedAttribute("history")}>${personalIcon("history")}历史牌阵</button>
    </nav>
    <button class="personal-rail-provider" type="button" data-settings-section="providers" ${selectedAttribute("providers")}>${personalIcon("provider")}供应商</button>
  </aside>`;
}

function settingsHome() {
  const active = userProfiles.find((profile) => profile.isActive);
  const profile = primaryPersonalProfile();
  const nickname = accountContext?.nickname || profile?.nickname || "来访者";
  const avatar = currentAvatar();
  return `<main class="settings-home personal-home-layout">
    <aside class="personal-home-rail">
    <section class="personal-identity" aria-label="当前账号">
      <div class="personal-avatar-area">
        <button class="personal-avatar personal-avatar-button" type="button" data-avatar-control data-avatar-change aria-label="${avatar ? "更换头像" : "上传头像"}" ${avatarUploadBusy ? "disabled" : ""}>${avatar ? `<img src="${escapeHTML(avatar)}" alt="当前头像" width="80" height="80">` : personalIcon("profile")}</button>
      </div>
      <input id="personal-avatar-file" type="file" accept="image/jpeg,image/png,image/webp" aria-label="选择头像图片" hidden>
      <div class="personal-identity-copy"><strong>${escapeHTML(nickname)}</strong>${accountContext ? `<small>${escapeHTML(accountContext.email || "")}</small>` : '<button class="personal-login" type="button" data-personal-login>登录 / 注册</button>'}</div>
    </section>
    <p id="avatar-feedback" class="avatar-feedback" role="status" aria-live="polite">${avatarUploadBusy ? "正在处理头像…" : ""}</p>
    <section class="personal-context-control" aria-label="个人信息使用方式">
      ${userProfiles.length > 1 ? `<label class="settings-field personal-legacy-picker"><span>使用的旧档案</span><select id="personal-context-profile">${userProfiles.map((item) => `<option value="${escapeHTML(item.id)}" ${item.id === profile?.id ? "selected" : ""}>${escapeHTML(item.nickname || "未命名用户")}</option>`).join("")}</select></label>` : ""}
      <label class="personal-context-toggle">
        <span class="profile-row-toggle"><input type="checkbox" data-profile-toggle="${escapeHTML(profile?.id || "")}" aria-describedby="personal-context-help" ${active ? "checked" : ""} ${profile ? "" : "disabled"}><i aria-hidden="true"></i></span>
        <span>使用个人信息</span>
      </label>
      <p id="personal-context-help">${profile ? "开启后使用资料与便签，并保存历史牌阵。关闭后不使用，也不记录。" : "保存个人信息后，可开启资料使用与历史记录。"}</p>
    </section>
    </aside>
    <section class="personal-home-content">
    <header class="personal-home-heading"><h1>个人中心</h1></header>
    <section class="personal-entry-grid" aria-label="个人中心入口">
      <button class="personal-entry personal-entry-profile" type="button" data-settings-section="profile-list"><span class="personal-entry-symbol">${personalIcon("profile")}</span><strong>个人信息</strong>${personalIcon("next", "personal-chevron")}</button>
      <button class="personal-entry" type="button" data-settings-section="notes"><span class="personal-entry-symbol">${personalIcon("notes")}</span><strong>塔罗师的便签</strong>${personalIcon("next", "personal-chevron")}</button>
      <button class="personal-entry" type="button" data-cloud-history><span class="personal-entry-symbol">${personalIcon("history")}</span><strong>历史牌阵</strong>${personalIcon("next", "personal-chevron")}</button>
    </section>
    <div class="personal-secondary">
      <button type="button" data-settings-section="providers">${personalIcon("provider")}<span>供应商</span><small>${escapeHTML(getActiveProviderLabel())}</small>${personalIcon("next", "personal-chevron")}</button>
      ${accountContext ? '<button class="personal-logout" type="button" data-personal-logout>退出账号</button>' : ""}
    </div>
    <p id="settings-feedback" class="settings-feedback" role="status" aria-live="polite"></p>
    </section>
  </main>`;
}

function historyThumbnails(record) {
  return `<div class="history-card-thumbnails ${record.spread === 10 ? "history-card-thumbnails-10" : ""}" aria-label="本次抽到的牌">${record.cards.map((card) => `<figure class="history-card-thumb"><img class="card-art" data-card-image="${escapeHTML(card.id)}" data-image-retry="0" src="${escapeHTML(cardImageURL(card))}" srcset="${escapeHTML(cardImageSrcSet(card))}" sizes="80px" alt="${escapeHTML(card.chinese)}${card.reversed ? "逆位" : "正位"}" loading="lazy" decoding="async" style="transform:rotate(${card.reversed ? 180 : 0}deg)"><figcaption>${escapeHTML(card.chinese)}</figcaption></figure>`).join("")}</div>`;
}

function loadAllHistoryRecords() {
  const profileIds = new Set(userProfiles.map((profile) => profile.id));
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(HISTORY_STORAGE_PREFIX)) {
      const profileId = key.slice(HISTORY_STORAGE_PREFIX.length);
      if (profileId) profileIds.add(profileId);
    }
  }
  return [...profileIds].flatMap((profileId) => loadHistoryRecords(profileId).map((record) => ({
    ...record,
    originUserId: profileId,
  }))).sort((a, b) => b.createdAt - a.createdAt);
}

function historyTimeline(records) {
  if (!records.length) return `<div class="history-empty">${personalIcon("history")}<strong>还没有历史牌阵</strong><p>完成的解读会保存在你的账号里。</p><button class="history-login-button" type="button" data-personal-login>登录 Arcana</button></div>`;
  return `<section class="history-timeline" aria-label="历史牌阵列表">${records.map((record) => `<article class="history-entry" data-history-id="${escapeHTML(record.id)}" data-history-profile-id="${escapeHTML(record.originUserId)}">
    <span class="history-dot" aria-hidden="true"></span>
    <div class="history-swipe-shell">
      <div class="history-bubble">
        <header><time>${escapeHTML(record.timestamp)}</time><span>${escapeHTML(record.spreadLabel)}</span></header>
        <p class="history-question">${escapeHTML(record.question)}</p>
        <blockquote>“${escapeHTML(record.summary)}”</blockquote>
        <div class="history-card-row">
          ${historyThumbnails(record)}
          <button class="history-delete-button history-delete-corner" type="button" data-history-delete="${escapeHTML(record.id)}" aria-label="删除这条历史牌阵" title="删除记录">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>
          </button>
        </div>
        ${record.fullReading ? `<details class="cloud-reading-details"><summary>查看完整解读</summary><p>${escapeHTML(record.fullReading)}</p></details>` : ""}
      </div>
    </div>
  </article>`).join("")}</section>`;
}

function historyPage() {
  const records = loadAllHistoryRecords();
  return `<main class="history-page">
    <div class="history-toolbar"><div class="history-heading"><h1>历史牌阵</h1><p>${records.length} 条记录</p></div></div>
    ${historyTimeline(records)}
    <p id="settings-feedback" class="settings-feedback" role="status" aria-live="polite"></p>
  </main>`;
}

function providerSidebar() {
  return `<header class="provider-workspace-heading"><h1>供应商</h1><button id="new-provider" type="button">${personalIcon("plus")}添加</button></header>
    <section class="provider-choice-strip" aria-label="选择供应商">${providerList()}</section>`;
}

function renderSettings(message = "", preserveDraft = false) {
  const overlay = document.querySelector("#provider-settings");
  if (!overlay) return;
  const previousForm = preserveDraft && activeSection === "home" ? overlay.querySelector("#user-profile-form") : null;
  const draft = previousForm ? Object.fromEntries(["nickname", "age", "gender", "focusAreas", "currentStatus"].map((name) => [name, previousForm.elements[name].value])) : null;
  if (["profile", "profile-list"].includes(activeSection)) preparePersonalProfileEditor();
  cancelProfileNotesView();
  const home = activeSection === "home";
  let content = home ? settingsHome() : "";
  if (activeSection === "providers") content = `<main class="provider-workspace">${providerSidebar()}<section class="settings-editor provider-config" aria-label="供应商配置">${providerEditor()}</section></main>`;
  if (activeSection === "legacy-profiles") content = userManager();
  if (activeSection === "profile-edit") content = userProfileEditor();
  if (activeSection === "notes") content = profileNotesPage();
  if (activeSection === "history") content = historyPage();
  overlay.innerHTML = `<div class="settings-page">
    <header class="settings-header"><span class="settings-brand"><span aria-hidden="true"></span> ARCANA</span><button id="settings-back" type="button">${personalIcon("back")}${home ? "返回抽牌" : "返回个人中心"}</button></header>
    ${home ? content : `<div class="personal-workspace">${personalRail(["profile-edit", "legacy-profiles"].includes(activeSection) ? "profile" : activeSection)}<div class="personal-workspace-content">${content}</div></div>`}
  </div>`;
  overlay.querySelector("#settings-back").addEventListener("click", () => {
    if (home) closeSettings();
    else { activeSection = "home"; editingUserId = null; pendingDeleteId = null; renderSettings(); }
    overlay.scrollTop = 0;
  });
  overlay.querySelectorAll("[data-settings-section]").forEach((button) => button.addEventListener("click", () => {
    activeSection = button.dataset.settingsSection;
    pendingDeleteId = null;
    renderSettings();
    overlay.scrollTop = 0;
  }));
  overlay.querySelectorAll("[data-cloud-history]").forEach((button) => button.addEventListener("click", () => {
    if (accountContext) document.dispatchEvent(new CustomEvent("arcana:open-cloud-history"));
    else { activeSection = "history"; renderSettings(); overlay.scrollTop = 0; }
  }));
  overlay.querySelectorAll("[data-personal-login]").forEach((button) => button.addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("arcana:open-login"));
  }));
  overlay.querySelector("[data-personal-logout]")?.addEventListener("click", (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "正在退出…";
    document.dispatchEvent(new CustomEvent("arcana:logout"));
  });
  if (home) { bindPersonalContext(overlay); bindAvatarUpload(overlay); }
  if (activeSection === "legacy-profiles") bindUserManager(overlay);
  if (activeSection === "profile-edit") bindUserProfileEditor(overlay);
  if (activeSection === "notes") bindProfileNotes(overlay);
  if (activeSection === "providers") bindProviderEditor(overlay);
  if (activeSection === "history") {
    bindHistoryTimeline(overlay);
  }
  if (draft && home) {
    const form = overlay.querySelector("#user-profile-form");
    Object.entries(draft).forEach(([name, value]) => { form.elements[name].value = value; });
    overlay.querySelector("#profile-status-count").textContent = draft.currentStatus.length;
  }
  if (message) showFeedback(message);
}

export function confirmHistoryDeletion(trigger) {
  if (document.querySelector(".history-confirm-backdrop")) return Promise.resolve(false);
  return new Promise((resolve) => {
    const host = trigger.closest("#provider-settings, #account-overlay") || document.body;
    const backdrop = document.createElement("div");
    backdrop.className = "history-confirm-backdrop";
    backdrop.innerHTML = `<section class="history-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="history-confirm-message">
      <p id="history-confirm-message">删除这条记录？删除后无法恢复。</p>
      <div class="history-confirm-actions"><button type="button" data-history-confirm-cancel>取消</button><button type="button" class="history-confirm-delete" data-history-confirm-delete>删除</button></div>
    </section>`;
    const background = [...host.children].map((element) => ({ element, inert: element.inert }));
    background.forEach(({ element }) => { element.inert = true; });
    host.append(backdrop);
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const cancel = backdrop.querySelector("[data-history-confirm-cancel]");
    const remove = backdrop.querySelector("[data-history-confirm-delete]");
    let settled = false;
    const finish = (confirmed) => {
      if (settled) return;
      settled = true;
      controller.abort();
      backdrop.remove();
      background.forEach(({ element, inert }) => { element.inert = inert; });
      if (trigger.isConnected) trigger.focus({ preventScroll: true });
      resolve(confirmed);
    };
    cancel.addEventListener("click", () => finish(false), options);
    remove.addEventListener("click", () => finish(true), options);
    backdrop.addEventListener("click", (event) => {
      event.stopPropagation();
      if (event.target === backdrop) finish(false);
    }, options);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      } else if (event.key === "Tab") {
        if (event.shiftKey && document.activeElement === cancel) {
          event.preventDefault();
          remove.focus();
        } else if (!event.shiftKey && document.activeElement === remove) {
          event.preventDefault();
          cancel.focus();
        }
      }
    }, { ...options, capture: true });
    document.addEventListener("arcana:account-change", () => finish(false), { ...options, capture: true });
    window.addEventListener("hashchange", () => finish(false), options);
    cancel.focus({ preventScroll: true });
  });
}

function bindHistoryTimeline(overlay) {
  overlay.querySelectorAll("[data-history-delete]").forEach((button) => button.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (!await confirmHistoryDeletion(button)) return;
    const profileId = button.closest(".history-entry")?.dataset.historyProfileId;
    if (deleteHistoryRecord(profileId, button.dataset.historyDelete)) renderSettings("这条历史牌阵已删除。");
    else showFeedback("没有找到这条记录，请刷新后重试。", true);
  }));
}

function bindAvatarUpload(overlay) {
  const input = overlay.querySelector("#personal-avatar-file");
  if (!input) return;
  const setFeedback = (message, error = false) => {
    const feedback = document.querySelector("#avatar-feedback");
    if (!feedback) return;
    feedback.textContent = message;
    feedback.classList.toggle("is-error", error);
  };
  const applyAvatar = async (file) => {
    if (avatarUploadBusy) return;
    const version = ++avatarUploadVersion;
    const ownerId = accountContext?.id || null;
    const isCurrent = () => version === avatarUploadVersion && ownerId === (accountContext?.id || null);
    avatarUploadBusy = true;
    overlay.querySelectorAll("[data-avatar-control]").forEach((button) => { button.disabled = true; });
    setFeedback(file ? "正在处理头像…" : "正在移除头像…");
    let message = "";
    let failure = false;
    try {
      const avatar = file ? await compressAvatar(file) : "";
      if (!isCurrent()) return;
      if (ownerId) {
        setFeedback("正在保存头像…");
        await new Promise((resolve, reject) => {
          document.dispatchEvent(new CustomEvent("arcana:update-account-avatar", {
            detail: { avatar, userId: ownerId, complete: (error) => error ? reject(error) : resolve() },
          }));
        });
      } else {
        saveGuestAvatar(avatar);
      }
    } catch (error) {
      failure = true;
      message = error.message || "头像暂时没有保存成功，请稍后重试。";
    } finally {
      if (isCurrent()) {
        avatarUploadBusy = false;
        if (activeSection === "home" && document.querySelector("#provider-settings")) renderSettings("", true);
        setFeedback(message, failure);
      }
    }
  };
  overlay.querySelectorAll("[data-avatar-change]").forEach((button) => button.addEventListener("click", () => input.click()));
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = "";
    if (file) applyAvatar(file);
  });
}

function bindPersonalContext(overlay) {
  overlay.querySelector("[data-profile-toggle]")?.addEventListener("change", (event) => {
    const input = event.currentTarget;
    const id = input.dataset.profileToggle;
    if (!userProfiles.some((profile) => profile.id === id)) return;
    const enabled = input.checked;
    const next = userProfiles.map((profile) => ({ ...profile, isActive: enabled && profile.id === id }));
    if (persistProfiles(next)) renderSettings(enabled ? "已启用个人信息。" : "已关闭个人信息。解读不再使用资料与便签，也不保存历史。", true);
    else input.checked = Boolean(userProfiles.find((profile) => profile.id === id)?.isActive);
  });
  overlay.querySelector("#personal-context-profile")?.addEventListener("change", (event) => {
    const id = event.currentTarget.value;
    if (!userProfiles.some((profile) => profile.id === id)) return;
    personalProfileId = id;
    if (userProfiles.some((profile) => profile.isActive)) {
      const next = userProfiles.map((profile) => ({ ...profile, isActive: profile.id === id }));
      if (persistProfiles(next)) renderSettings("已切换使用的个人档案。");
    } else renderSettings();
  });
}

function bindUserManager(overlay) {
  // 只有一个用户都没有时才会出现这个按钮
  overlay.querySelector("#add-user-profile")?.addEventListener("click", () => {
    editingUserId = null;
    activeSection = "profile-edit";
    renderSettings();
    overlay.scrollTop = 0;
  });
  overlay.querySelectorAll("[data-profile-edit]").forEach((button) => button.addEventListener("click", () => {
    editingUserId = button.dataset.profileEdit;
    activeSection = "profile-edit";
    renderSettings();
    overlay.scrollTop = 0;
  }));
  overlay.querySelectorAll("[data-profile-delete]").forEach((button) => button.addEventListener("click", () => {
    const profile = userProfiles.find((item) => item.id === button.dataset.profileDelete);
    if (!profile || !canDeleteProfile()) return;
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
    // 只剩“编辑”一个按钮时，滑开的距离减半
    const maxOffset = row.classList.contains("is-single-action") ? 70 : 140;
    let startX = 0;
    let startY = 0;
    let offset = 0;
    let dragging = false;
    surface.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".profile-row-toggle, button")) return;
      if (openRow && openRow !== row) setRowOpen(openRow, false);
      startX = event.clientX;
      startY = event.clientY;
      offset = row.classList.contains("is-open") ? -maxOffset : 0;
      dragging = true;
      surface.setPointerCapture(event.pointerId);
    });
    surface.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) { dragging = false; surface.style.transform = ""; return; }
      const x = Math.max(-maxOffset, Math.min(0, offset + dx));
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
  overlay.querySelector("#personal-profile-select")?.addEventListener("change", (event) => {
    editingUserId = event.currentTarget.value;
    personalProfileId = editingUserId;
    renderSettings();
  });
  status.addEventListener("input", () => { overlay.querySelector("#profile-status-count").textContent = status.value.length; });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const existing = userProfiles.find((profile) => profile.id === editingUserId);
    const focusAreas = [...new Set(form.elements.focusAreas.value.split(/[，,、]/).map((item) => item.trim().slice(0, 40)).filter(Boolean))].slice(0, 12);
    const record = {
      ...existing,
      id: existing?.id || makeId(),
      nickname: form.elements.nickname.value.trim(),
      age: form.elements.age.value.trim(),
      gender: form.elements.gender.value,
      // 星座字段不再展示，旧资料里的值保留，避免界面调整清空历史背景。
      zodiac: existing?.zodiac || "",
      currentStatus: status.value.trim(),
      focusAreas,
      isActive: existing?.isActive ?? !userProfiles.some((profile) => profile.isActive),
    };
    const next = existing
      ? userProfiles.map((profile) => profile.id === existing.id ? record : profile)
      : [...userProfiles, record];
    if (persistProfiles(next)) {
      personalProfileId = record.id;
      editingUserId = null;
      activeSection = "home";
      renderSettings("个人信息已保存。");
      overlay.scrollTop = 0;
    }
  });
  overlay.querySelector("#delete-user-profile")?.addEventListener("click", () => {
    const profile = userProfiles.find((item) => item.id === editingUserId);
    if (!profile || !canDeleteProfile()) return;
    if (persistProfiles(userProfiles.filter((item) => item.id !== profile.id))) {
      editingUserId = null;
      activeSection = "home";
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
  cancelProfileNotesView();
  document.querySelector("#provider-settings")?.remove();
  pendingDeleteId = null;
  editingUserId = null;
  document.body.classList.remove("settings-open");
  document.querySelector(".site-shell").inert = Boolean(document.querySelector("#account-overlay"));
  if (location.hash === "#personal-center") history.replaceState(null, "", location.pathname + location.search);
  document.querySelector("#account-button")?.focus();
}

export function openSettings(section = "home") {
  activeSection = section === "profile" ? "profile-list" : section;
  const existing = document.querySelector("#provider-settings");
  if (existing) { renderSettings(); existing.scrollTop = 0; return; }
  const overlay = document.createElement("div");
  overlay.id = "provider-settings";
  overlay.className = "settings-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Arcana 个人中心");
  document.body.append(overlay);
  document.body.classList.add("settings-open");
  document.querySelector(".site-shell").inert = true;
  location.hash = "personal-center";
  renderSettings();
  overlay.querySelector("#settings-back")?.focus();
}

export function initializeProviderSettings(callback = () => {}) {
  onChange = callback;
  document.addEventListener("arcana:open-personal-center", () => openSettings());
  document.addEventListener("arcana:close-personal-center", closeSettings);
  document.addEventListener("arcana:account-change", (event) => {
    const previousAccountId = accountContext?.id || null;
    accountContext = event.detail?.user || null;
    const ownerChanged = previousAccountId !== (accountContext?.id || null);
    if (ownerChanged) {
      avatarUploadVersion += 1;
      avatarUploadBusy = false;
      if (!accountContext) activeSection = "home";
    }
    if (ownerChanged || activeSection === "home") renderSettings("", !ownerChanged);
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.querySelector("#provider-settings") && !document.querySelector("#account-overlay") && !document.querySelector(".profile-note-details-backdrop")) closeSettings();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === GUEST_AVATAR_STORAGE_KEY) {
      document.dispatchEvent(new CustomEvent("arcana:guest-avatar-change"));
      if (!accountContext && activeSection === "home") renderSettings("", true);
      return;
    }
    if (![PROVIDER_STORAGE_KEY, PROFILE_STORAGE_KEY, LEGACY_PROFILE_STORAGE_KEY].includes(event.key) && !event.key?.startsWith(HISTORY_STORAGE_PREFIX)) return;
    settings = loadSettings();
    userProfiles = loadProfiles();
    if (selectedId !== null && selectedId !== INITIAL_PROVIDER_ID && !settings.providers.some((item) => item.id === selectedId)) selectedId = settings.activeId || INITIAL_PROVIDER_ID;
    onChange();
    renderSettings();
  });
  if (["#personal-center", "#settings"].includes(location.hash)) openSettings();
  callback();
}
