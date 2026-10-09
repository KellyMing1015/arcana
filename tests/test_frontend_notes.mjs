// 便签结构升级的可见内容、编辑边界、失败恢复和弹窗键盘流程。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const source = readFileSync(new URL("../settings.js", import.meta.url), "utf8")
  .replace(/^import \{[\s\S]*?\} from "\.\/[^"\n]+";\n/gm, "").replace(/^export /gm, "");
const decode = (value) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const success = (payload) => ({ ok: true, async json() { return payload; } });
const failure = (error) => ({ ok: false, async json() { return { error }; } });
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }

function environment(fetch, initialNotes) {
  const document = { activeElement: null, listeners: [], querySelector() { return null; }, dispatchEvent() {},
    addEventListener(name, callback, options = {}) { this.listeners.push({ name, callback, options }); },
    key(key, extra = {}) {
      const event = { key, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
      this.listeners.filter((item) => item.name === "keydown" && !item.options.signal?.aborted).forEach((item) => item.callback(event));
      return event;
    },
  };
  class Element {
    constructor() { this.controls = {}; this.rows = []; this.listeners = new Map(); this.children = []; this.dataset = {}; this.isConnected = true; this.value = ""; this.textContent = ""; this.classes = new Set(); this.classList = { toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name) }; }
    addEventListener(name, callback, options = {}) { this.listeners.set(name, { callback, options }); }
    emit(name, extra = {}) {
      const item = this.listeners.get(name);
      if (!this.disabled && item && !item.options.signal?.aborted) return item.callback({ currentTarget: this, target: this, preventDefault() {}, stopPropagation() {}, ...extra });
    }
    focus() { document.activeElement = this; }
    append(element) { element.parent = this; this.children.push(element); }
    remove() { this.parent.children = this.parent.children.filter((child) => child !== this); this.disconnect(); }
    disconnect() { this.isConnected = false; this.rows.forEach((row) => row.disconnect()); Object.values(this.controls).forEach((item) => item.disconnect()); this.children.forEach((item) => item.disconnect()); }
    contains(element) { return element === this || this.all().includes(element); }
    all() { return [...Object.values(this.controls), ...this.rows, ...this.children].flatMap((item) => [item, ...item.all()]); }
    querySelector(selector) {
      if (selector === "textarea") return this.controls.textarea || this.rows.flatMap((row) => row.querySelector("textarea") || []).at(0) || null;
      return this.controls[selector] || null;
    }
    querySelectorAll(selector) {
      if (selector === ".profile-note" || selector === "[data-detail-index]") return this.rows;
      if (selector.includes("button:not(:disabled)")) {
        const order = this.controls["[data-detail-back]"]
          ? [this.controls["[data-detail-close]"], ...this.controls["[data-detail-list]"].all(), this.controls["[data-detail-back]"]]
          : this.all();
        return order.filter((item) => ["button", "textarea"].includes(item.tag) && !item.disabled);
      }
      if (selector === "button, input, textarea") return this.all().filter((item) => ["button", "input", "textarea"].includes(item.tag));
      return selector.split(/,\s*/).flatMap((part) => this.all().filter((item) => item.selector === part || part === "textarea" && item.tag === "textarea"));
    }
    set innerHTML(html) {
      this.rows.forEach((row) => row.disconnect());
      Object.values(this.controls).forEach((item) => item.disconnect());
      this.html = html; this.rows = []; this.controls = {};
      const articles = [...html.matchAll(/<article class="(profile-note|profile-note-detail)" ([^>]+)>([\s\S]*?)<\/article>/g)];
      if (articles.length) {
        this.rows = articles.map(([, , attrs, content]) => {
          const row = new Element();
          const id = attrs.match(/data-note-id="([^"]+)"/);
          const index = attrs.match(/data-detail-index="([^"]+)"/);
          row.dataset = id ? { noteId: id[1] } : { detailIndex: index[1] };
          row.innerHTML = content;
          return row;
        });
        return;
      }
      for (const match of html.matchAll(/<(button|input|textarea)\b([^>]*)(?:>([\s\S]*?)<\/\1>|\/?>)/g)) {
        const [, tag, attrs, content = ""] = match;
        const control = new Element(); control.tag = tag;
        const attribute = attrs.match(/\b(data-[\w-]+)(?:="[^"]*")?/);
        if (attribute) { control.selector = `[${attribute[1]}]`; this.controls[control.selector] = control; }
        else if (tag === "textarea") { control.selector = "textarea"; this.controls.textarea = control; }
        else if (tag === "input") { control.selector = ".profile-note-topic-editor input"; this.controls[control.selector] = control; }
        control.value = decode(tag === "textarea" ? content : attrs.match(/value="([^"]*)"/)?.[1] || "");
      }
      for (const selector of ["[data-note-count]", "[data-detail-count]"]) {
        const found = html.match(new RegExp(`<span ${selector.slice(1, -1)}>([^<]*)`));
        if (found) { this.controls[selector] = new Element(); this.controls[selector].textContent = found[1]; }
      }
      if (html.includes("profile-note-details-dialog")) {
        for (const selector of [".profile-note-details-dialog", "[data-detail-topic]", "[data-detail-list]", "[data-detail-feedback]"]) this.controls[selector] = new Element();
      }
    }
    get innerHTML() { return this.html; }
  }
  document.createElement = () => new Element();
  const panel = new Element(); panel.dataset.notesProfile = "person";
  const list = new Element(); const feedback = new Element(); const capacity = new Element(); const clear = new Element(); clear.tag = "button";
  panel.controls = { ".profile-notes-list": list, ".profile-notes-feedback": feedback, ".profile-notes-capacity": capacity, ".profile-notes-clear": clear };
  const overlay = new Element(); overlay.children = [panel]; overlay.querySelector = () => panel;
  const calls = [];
  let saved = initialNotes;
  const api = runInNewContext(source + `\n({ bindProfileNotes, cancelProfileNotesView, profileNoteDate, profileNotesTextLength,
    initialize() { userProfiles = [{ id: "person", isActive: true }]; cloudAccountId = "account"; },
    changeAccount() { cloudAccountId = "other"; cancelProfileNotesView(); },
  })`, {
    localStorage: { getItem() { return null; } }, document, window: { confirm: () => true, addEventListener() {} },
    crypto: { randomUUID: () => "id" }, AbortController, console,
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      if (fetch) return fetch(url, options, saved, (next) => { saved = next; });
      if (options.method === "PATCH") {
        const patch = JSON.parse(options.body);
        saved = saved.map((note) => ({ ...note, ...patch, user_edited: true }));
      }
      return success({ notes: saved });
    },
  });
  api.initialize(); api.bindProfileNotes(overlay);
  return { api, list, feedback, capacity, overlay, panel, calls, document, get modal() { return overlay.children.find((item) => item.className === "profile-note-details-backdrop"); } };
}

const note = { id: 7, topic: "转行", headline: "你准备从直播转向 AI 产品。", details: ["仍未离职。", "计划10月15日前投简历。"], importance: 3, last_evidence_at: "2026-10-06", user_edited: true };

test("卡片只显示摘要，日期不受用户时区影响，详情与内部权重不泄露", async () => {
  const env = environment(null, [note, { id: 8, topic: "近况", text: "旧版便签仍能显示。" }]); await flush();
  assert.match(env.list.innerHTML, /你准备从直播转向 AI 产品。/);
  assert.match(env.list.innerHTML, /最近提及于 2026年10月6日/);
  assert.match(env.list.innerHTML, /你编辑过/);
  assert.match(env.list.innerHTML, /旧版便签仍能显示。/);
  assert.match(env.list.innerHTML, /尚无近期确认/);
  assert.doesNotMatch(env.list.innerHTML, /仍未离职|10月15日|importance|stale|最后更新/);
  assert.equal(env.api.profileNoteDate("2026-10-06"), "2026年10月6日");
  assert.equal(env.api.profileNoteDate("2026-02-30"), "");
  assert.equal(env.api.profileNotesTextLength([{ headline: "🌟", details: ["🌙"] }]), 3);
});

test("摘要编辑仅修改摘要和主题，保留详情，超限输入不会被悄悄截掉", async () => {
  const env = environment(null, [note]); await flush();
  const row = env.list.rows[0]; row.querySelector("[data-note-edit]").emit("click");
  const input = row.querySelector("textarea");
  input.value = "🌟".repeat(300); input.emit("input");
  assert.equal(input.value, "🌟".repeat(300));
  row.querySelector("[data-note-save]").emit("click");
  assert.match(env.feedback.textContent, /摘要与详情合计最多 300 字/);
  assert.equal(env.calls.filter((call) => call.method === "PATCH").length, 0);
  input.value = "你正在准备 AI 产品方向的简历。";
  row.querySelector(".profile-note-topic-editor input").value = "求职";
  row.querySelector("[data-note-save]").emit("click"); await flush();
  const patch = env.calls.find((call) => call.method === "PATCH");
  assert.deepEqual(JSON.parse(patch.body), { profile_id: "person", topic: "求职", headline: input.value });
  assert.equal(patch.credentials, "same-origin");
  assert.match(env.list.innerHTML, /AI 产品方向的简历/);
  assert.equal(env.document.activeElement, env.list.rows[0].querySelector("[data-note-edit]"));
});

test("摘要保存失败保留原输入，其他便签操作不能丢掉未保存的修改", async () => {
  const env = environment((url, options, saved) => options.method === "PATCH" ? failure("暂时保存失败。") : success({ notes: saved }), [note, { ...note, id: 8, topic: "工作" }]); await flush();
  const row = env.list.rows[0]; row.querySelector("[data-note-edit]").emit("click");
  const input = row.querySelector("textarea"); input.value = "这份修改先保留。";
  env.list.rows[1].querySelector("[data-note-delete]").emit("click");
  assert.match(env.feedback.textContent, /先保存或取消/); assert.equal(env.calls.length, 1);
  row.querySelector("[data-note-save]").emit("click"); await flush();
  assert.match(env.feedback.textContent, /暂时保存失败/); assert.equal(input.value, "这份修改先保留。"); assert.equal(input.disabled, false);
  row.querySelector("[data-note-cancel]").emit("click");
  assert.equal(env.document.activeElement, env.list.rows[0].querySelector("[data-note-edit]"));
});

test("详情可逐条修改和移除，每次保存后重新读取，摘要仍保留", async () => {
  const env = environment(null, [note]); await flush();
  env.list.rows[0].querySelector("[data-note-details]").emit("click");
  const modal = env.modal;
  assert.equal(env.panel.inert, true);
  const detailList = modal.querySelector("[data-detail-list]");
  assert.match(detailList.innerHTML, /仍未离职/);
  const row = detailList.rows[1]; row.querySelector("[data-detail-edit]").emit("click");
  row.querySelector("textarea").value = "计划10月18日前投简历。";
  row.querySelector("[data-detail-save]").emit("click"); await flush();
  assert.deepEqual(JSON.parse(env.calls.find((call) => call.method === "PATCH").body), { profile_id: "person", details: ["仍未离职。", "计划10月18日前投简历。"] });
  assert.equal(env.calls.at(-1).method, "GET");
  assert.equal(env.modal, modal);
  assert.match(detailList.innerHTML, /10月18日/);
  detailList.rows[0].querySelector("[data-detail-remove]").emit("click"); await flush();
  assert.deepEqual(JSON.parse(env.calls.filter((call) => call.method === "PATCH").at(-1).body), { profile_id: "person", details: ["计划10月18日前投简历。"] });
  assert.match(env.list.innerHTML, /你准备从直播转向 AI 产品。/);
  modal.querySelector("[data-detail-back]").emit("click");
  assert.equal(env.modal, undefined); assert.equal(env.panel.inert, undefined);
  assert.equal(env.document.activeElement, env.list.rows[0].querySelector("[data-note-details]"));
});

test("详情保存失败保留浮窗和输入，可重试，空白内容不保存", async () => {
  let attempts = 0;
  const env = environment((url, options, saved, update) => {
    if (options.method === "PATCH") {
      if (++attempts === 1) return failure("网络忙，请重试。");
      update(saved.map((item) => ({ ...item, ...JSON.parse(options.body) })));
      return success({});
    }
    return success({ notes: saved });
  }, [note]); await flush();
  env.list.rows[0].querySelector("[data-note-details]").emit("click");
  const modal = env.modal; const row = modal.querySelector("[data-detail-list]").rows[0];
  row.querySelector("[data-detail-edit]").emit("click");
  const input = row.querySelector("textarea"); input.value = "   ";
  row.querySelector("[data-detail-save]").emit("click");
  assert.equal(attempts, 0);
  input.value = "已经正式离职。";
  row.querySelector("[data-detail-save]").emit("click"); await flush();
  assert.equal(env.modal, modal); assert.equal(input.value, "已经正式离职。"); assert.equal(input.disabled, false);
  assert.match(modal.querySelector("[data-detail-feedback]").textContent, /网络忙/);
  row.querySelector("[data-detail-save]").emit("click"); await flush();
  assert.equal(attempts, 2); assert.match(modal.querySelector("[data-detail-list]").innerHTML, /已经正式离职/);
});

test("浮窗支持 Escape、焦点循环，账号切换会清理浮窗并取消旧请求", async () => {
  const env = environment(null, [note]); await flush();
  const trigger = env.list.rows[0].querySelector("[data-note-details]"); trigger.emit("click");
  const modal = env.modal; const close = modal.querySelector("[data-detail-close]"); const back = modal.querySelector("[data-detail-back]");
  assert.equal(env.document.activeElement, close);
  assert.equal(env.document.key("Tab", { shiftKey: true }).prevented, true); assert.equal(env.document.activeElement, back);
  assert.equal(env.document.key("Tab").prevented, true); assert.equal(env.document.activeElement, close);
  const escape = env.document.key("Escape");
  assert.equal(escape.prevented, true); assert.equal(escape.stopped, true); assert.equal(env.modal, undefined); assert.equal(env.document.activeElement, trigger);
  trigger.emit("click"); env.api.changeAccount();
  assert.equal(env.modal, undefined); assert.equal(env.calls[0].signal.aborted, true);
});

test("保存详情期间切换账号，旧账号响应不会重新打开浮窗或触发旧档案读取", async () => {
  let resolvePatch;
  const env = environment((url, options, saved) => options.method === "PATCH" ? new Promise((resolve) => { resolvePatch = resolve; }) : success({ notes: saved }), [note]); await flush();
  env.list.rows[0].querySelector("[data-note-details]").emit("click");
  env.modal.querySelector("[data-detail-list]").rows[0].querySelector("[data-detail-remove]").emit("click");
  env.api.changeAccount(); resolvePatch(success({})); await flush();
  assert.equal(env.modal, undefined);
  assert.equal(env.calls.filter((call) => call.method === "GET").length, 1);
  assert.doesNotMatch(env.feedback.textContent, /已移除/);
});
