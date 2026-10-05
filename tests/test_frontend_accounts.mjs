// 隔离浏览器状态和网络，检查合并个人中心后账号、历史与便签仍使用正式接口。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const settingsSource = readFileSync(new URL("../settings.js", import.meta.url), "utf8").replace(/^export /gm, "");
const authSource = readFileSync(new URL("../auth.js", import.meta.url), "utf8")
  .replace(/^import \{[\s\S]*?\} from "\.\/settings\.js(?:\?[^"\n]*)?";\n/, "")
  .replace(/^export /gm, "");

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

class Control {
  listeners = new Map();
  classList = { toggle() {} };
  isConnected = true;
  value = "";
  textContent = "";
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  emit(name, fields = {}) { return this.listeners.get(name)?.({ currentTarget: this, preventDefault() {}, ...fields }); }
  focus() {}
}

const defaultDocument = { querySelector() { return null; }, dispatchEvent() {}, addEventListener() {} };
const profile = (id, isActive = true) => ({ id, nickname: id, age: "", gender: "", zodiac: "", focusAreas: [], currentStatus: "", isActive });
const success = (payload) => ({ ok: true, status: 200, async json() { return payload; } });
async function flush() { for (let i = 0; i < 24; i++) await Promise.resolve(); }

function settings(overrides = {}) {
  return runInNewContext(settingsSource + `\n({
    getUserInfo, getUserProfiles, loadAllHistoryRecords, settingsHome, bindPersonalContext,
    bindUserProfileEditor, bindProfileNotes, normalizeAvatarDataURL,
    setProfiles(value) { userProfiles = value; },
    setEditing(id) { editingUserId = id; },
    setAccount(id) { cloudAccountId = id; },
  })`, {
    localStorage: storage(), document: defaultDocument, window: { addEventListener() {} },
    crypto: { randomUUID: () => "new-profile" }, AbortController, console,
    ...overrides,
  });
}

function auth(overrides = {}) {
  return runInNewContext(authSource + `\n({
    updateAccountAvatar, saveCloudReading, renderCloudHistory, getCurrentUser,
    setUser(user) { authUser = user; },
  })`, {
    localStorage: storage(), document: defaultDocument, window: { addEventListener() {} },
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    normalizeAvatarDataURL: settings().normalizeAvatarDataURL, getGuestAvatar: () => "",
    getUserProfiles: () => [], disconnectAccountSettings() {}, console,
    ...overrides,
  });
}

test("本地历史包含旧档案记录，保留完整解读并可找到原存储位置", () => {
  const record = (id, createdAt) => ({ id, createdAt, timestamp: "今天", spread: 1, spreadLabel: "单牌", question: "近况", summary: "总结", fullReading: "完整解读", cards: [{ id: "fool", chinese: "愚者", reversed: false }] });
  const api = settings({ localStorage: storage({
    "arcana_history_active": JSON.stringify([record("new", Date.now())]),
    "arcana_history_old": JSON.stringify([record("old", Date.now() - 1000)]),
  }) });
  api.setProfiles([profile("active")]);
  const records = api.loadAllHistoryRecords();
  assert.deepEqual(Array.from(records, (item) => item.id), ["new", "old"]);
  assert.equal(records[1].originUserId, "old");
  assert.equal(records[1].fullReading, "完整解读");
});

test("账号历史显示旧档案及无档案标记记录，保留详情而无需筛选", () => {
  const count = new Control();
  const list = new Control();
  const overlay = { querySelector: (selector) => selector === ".history-heading p" ? count : list, querySelectorAll: () => [] };
  const records = [
    { id: 1, created_at: "2026-10-05T12:00:00", question: "旧档案", summary: "总结", spread_type: "单牌", profile_id: "old", cards: [], full_reading: "完整解读" },
    { id: 2, created_at: "2026-10-05T12:00:00", question: "无档案记录", summary: "总结", spread_type: "单牌", profile_id: null, cards: [] },
  ];
  auth().renderCloudHistory(overlay, records);
  assert.equal(count.textContent, "2 条记录");
  assert.match(list.innerHTML, /旧档案/);
  assert.match(list.innerHTML, /无档案记录/);
  assert.match(list.innerHTML, /查看完整解读/);
  assert.doesNotMatch(list.innerHTML, /<select/);
});

test("旧档案可以切换启用，关闭信息后请求不再携带个人资料", () => {
  const api = settings();
  api.setProfiles([profile("first"), profile("second", false)]);
  assert.match(api.settingsHome(), /id="personal-context-profile"/);
  const toggle = new Control();
  toggle.dataset = { profileToggle: "second" };
  const picker = new Control();
  const overlay = { querySelector: (selector) => selector === "[data-profile-toggle]" ? toggle : selector === "#personal-context-profile" ? picker : null };
  api.bindPersonalContext(overlay);
  picker.value = "second";
  picker.emit("change");
  assert.equal(api.getUserInfo().id, "second");
  toggle.checked = false;
  toggle.emit("change");
  assert.equal(api.getUserInfo().enabled, false);
  assert.equal(api.getUserProfiles().length, 2);
});

test("新版个人信息保存保留隐藏星座及关闭状态", () => {
  const localStorage = storage();
  const api = settings({ localStorage });
  api.setProfiles([{ ...profile("old", false), zodiac: "双鱼座" }]);
  api.setEditing("old");
  const form = new Control();
  form.elements = Object.fromEntries(Object.entries({ nickname: "新昵称", age: "30", gender: "女", focusAreas: "工作、工作、成长", currentStatus: " 新近况 " }).map(([key, value]) => [key, Object.assign(new Control(), { value })]));
  const overlay = { querySelector: (selector) => selector === "#user-profile-form" ? form : null };
  api.bindUserProfileEditor(overlay);
  form.emit("submit");
  const saved = JSON.parse(localStorage.getItem("arcana.user-profiles.v2"))[0];
  assert.equal(saved.zodiac, "双鱼座");
  assert.equal(saved.isActive, false);
  assert.equal(saved.nickname, "新昵称");
  assert.deepEqual(Array.from(saved.focusAreas), ["工作", "成长"]);
});

function notesPanel() {
  const clear = new Control();
  const feedback = new Control();
  const capacity = new Control();
  const list = new Control();
  list.rows = [];
  Object.defineProperty(list, "innerHTML", {
    set(value) {
      this.html = value;
      this.rows = [...value.matchAll(/data-note-id="([^"]+)"/g)].map((match) => {
        const row = new Control();
        row.dataset = { noteId: match[1] };
        row.controls = Object.fromEntries(["[data-note-edit]", "[data-note-delete]", "textarea", ".profile-note-topic-editor input", "[data-note-count]", "[data-note-cancel]", "[data-note-save]"].map((name) => [name, new Control()]));
        row.querySelector = (selector) => row.controls[selector];
        return row;
      });
    },
    get() { return this.html; },
  });
  list.querySelectorAll = () => list.rows;
  const nodes = { ".profile-notes-list": list, ".profile-notes-clear": clear, ".profile-notes-feedback": feedback, ".profile-notes-capacity": capacity };
  const panel = Object.assign(new Control(), { dataset: { notesProfile: "person" }, querySelector: (selector) => nodes[selector], querySelectorAll: () => [] });
  return { panel, list, feedback, overlay: { querySelector: () => panel } };
}

test("便签编辑请求带正式账号凭证及档案ID，保存后重新读取服务器", async () => {
  const calls = [];
  let notes = [{ id: 7, topic: "工作", text: "原便签", user_edited: false }];
  const api = settings({ fetch: async (url, options) => {
    calls.push({ url, ...options });
    if (options.method === "PATCH") notes = [{ ...notes[0], ...JSON.parse(options.body), user_edited: true }];
    return success({ notes });
  } });
  api.setProfiles([profile("person")]);
  api.setAccount("5");
  const { list, feedback, overlay } = notesPanel();
  api.bindProfileNotes(overlay);
  await flush();
  const row = list.rows[0];
  row.controls["[data-note-edit]"].emit("click");
  row.controls["textarea"].value = "手动修改后继续保留";
  row.controls[".profile-note-topic-editor input"].value = "近况";
  row.controls["[data-note-save]"].emit("click");
  await flush();
  assert.equal(calls[0].url, "/api/profile-notes?profile_id=person");
  assert.equal(calls[0].credentials, "same-origin");
  const update = calls.find((call) => call.method === "PATCH");
  assert.equal(update.url, "/api/profile-notes/7");
  assert.deepEqual(JSON.parse(update.body), { profile_id: "person", topic: "近况", text: "手动修改后继续保留" });
  assert.equal(calls.at(-1).method, "GET");
  assert.match(list.innerHTML, /手动修改后继续保留/);
  assert.equal(feedback.textContent, "便签已更新。");
});

test("读取便签期间更换账号，旧账号响应不会覆盖页面", async () => {
  let resolve;
  const api = settings({ fetch: () => new Promise((done) => { resolve = done; }) });
  api.setProfiles([profile("person")]);
  api.setAccount("5");
  const { list, overlay } = notesPanel();
  api.bindProfileNotes(overlay);
  await flush();
  api.setAccount("6");
  resolve(success({ notes: [{ id: 7, topic: "工作", text: "旧账号私密便签" }] }));
  await flush();
  assert.equal(list.innerHTML, undefined);
});

test("上传头像使用正式接口，带账号ID并采用服务器规范化返回值", async () => {
  const calls = [];
  const avatar = "data:image/jpeg;base64,/9j/AA==";
  const canonical = "data:image/jpeg;base64,/9j/BB==";
  const api = auth({ fetch: async (url, options) => { calls.push({ url, ...options }); return success({ avatar: canonical }); } });
  api.setUser({ id: 5, nickname: "小欧", avatar: "" });
  let completed = false;
  await api.updateAccountAvatar({ detail: { userId: 5, avatar, complete(error) { assert.equal(error, undefined); completed = true; } } });
  assert.equal(calls[0].url, "/api/avatar");
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[0].credentials, "same-origin");
  assert.deepEqual(JSON.parse(calls[0].body), { avatar, userId: 5 });
  assert.equal(api.getCurrentUser().avatar, canonical);
  assert.equal(completed, true);
});

test("保存历史时旧账号请求返回401，不会退出刚登录的新账号", async () => {
  let resolve;
  let disconnected = false;
  const api = auth({ fetch: () => new Promise((done) => { resolve = done; }), disconnectAccountSettings: () => { disconnected = true; } });
  api.setUser({ id: 5 });
  const pending = api.saveCloudReading({ question: "近况" });
  api.setUser({ id: 6 });
  resolve({ ok: false, status: 401, async json() { return { error: "登录过期" }; } });
  await assert.rejects(pending, /登录过期/);
  assert.equal(api.getCurrentUser().id, 6);
  assert.equal(disconnected, false);
});
