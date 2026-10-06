// Keep one reading in this tab. Provider credentials and hidden prompts are never copied.
export const READING_SESSION_KEY = "arcana.current-reading.v1";
const validImage = (value) => typeof value === "string" && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value);
const frameworks = new Set(["timeline", "cause", "outcome", "relationship", "choice", "energy"]);
const validRequestId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{32,64}$/.test(value);

function messageCopy(message) {
  if (!message || !["user", "assistant"].includes(message.role) || typeof message.text !== "string") return null;
  const result = { role: message.role, text: message.text };
  if (message.role === "user") {
    result.message = typeof message.message === "string" ? message.message : message.text;
    result.images = (Array.isArray(message.images) ? message.images : []).filter(validImage).slice(0, 3);
    if (message.imagesOmitted) result.imagesOmitted = true;
    if (validRequestId(message.requestId)) result.requestId = message.requestId;
  }
  if (message.error) result.error = true;
  if (message.stopped) result.stopped = true;
  return result;
}

export function createReadingSnapshot(state, owner) {
  if (!state.initialReading || ![1, 3, 10].includes(state.spread) || state.selected.length !== state.spread) return null;
  return {
    version: 1, owner, savedAt: Date.now(), readingKey: state.readingKey,
    stage: state.stage === "conversation" ? "conversation" : "result",
    question: state.question, spread: state.spread,
    cards: state.selected.map((card) => ({ id: card.id, reversed: Boolean(card.reversed) })),
    framework: frameworks.has(state.framework) ? state.framework : null,
    conversationId: state.conversationId, rounds: state.followUpCount,
    initialReading: state.initialReading, closed: Boolean(state.conversationClosed),
    messages: state.chatMessages.map(messageCopy).filter(Boolean),
    draft: { text: state.followUpDraft || "", images: (state.followUpImages || []).filter(validImage).slice(0, 3) },
    pending: state.pendingFollowUp ? { requestId: state.pendingFollowUp.requestId, roundsBefore: state.pendingFollowUp.roundsBefore } : null,
    attachmentWarning: Boolean(state.attachmentWarning),
  };
}

export function saveReadingSnapshot(storage, state, owner) {
  const snapshot = createReadingSnapshot(state, owner);
  if (!snapshot) return false;
  try {
    storage.setItem(READING_SESSION_KEY, JSON.stringify(snapshot));
    return true;
  } catch {
    // When images exceed the browser quota, retain the reading and every message's text.
    snapshot.attachmentWarning ||= snapshot.draft.images.length > 0 || Boolean(snapshot.pending && snapshot.messages.at(-2)?.images?.length);
    snapshot.draft.images = [];
    snapshot.messages.forEach((message) => {
      if (message.images?.length) { message.imagesOmitted = true; message.images = []; }
    });
    try {
      storage.setItem(READING_SESSION_KEY, JSON.stringify(snapshot));
      return true;
    } catch { return false; }
  }
}

export function loadReadingSnapshot(storage, owner, cardIds) {
  try {
    const saved = JSON.parse(storage.getItem(READING_SESSION_KEY) || "null");
    if (!saved || saved.version !== 1 || saved.owner !== owner || typeof saved.readingKey !== "string"
        || ![1, 3, 10].includes(saved.spread) || !Array.isArray(saved.cards) || saved.cards.length !== saved.spread
        || new Set(saved.cards.map((card) => card?.id)).size !== saved.spread
        || saved.cards.some((card) => !cardIds.has(card?.id))
        || typeof saved.question !== "string" || typeof saved.initialReading !== "string" || !saved.initialReading
        || !Number.isInteger(saved.rounds) || saved.rounds < 0 || saved.rounds > 8
        || (saved.conversationId !== null && !/^[0-9a-f]{32}$/.test(saved.conversationId))
        || !Array.isArray(saved.messages)) return null;
    return {
      version: 1, owner, savedAt: saved.savedAt, readingKey: saved.readingKey,
      stage: saved.stage === "conversation" ? "conversation" : "result",
      question: saved.question, spread: saved.spread, initialReading: saved.initialReading,
      conversationId: saved.conversationId, rounds: saved.rounds,
      cards: saved.cards.map((card) => ({ id: card.id, reversed: Boolean(card.reversed) })),
      framework: frameworks.has(saved.framework) ? saved.framework : null,
      closed: Boolean(saved.closed), messages: saved.messages.map(messageCopy).filter(Boolean),
      draft: { text: typeof saved.draft?.text === "string" ? saved.draft.text.slice(0, 2000) : "", images: (Array.isArray(saved.draft?.images) ? saved.draft.images : []).filter(validImage).slice(0, 3) },
      pending: validRequestId(saved.pending?.requestId) && Number.isInteger(saved.pending?.roundsBefore) && saved.pending.roundsBefore >= 0 && saved.pending.roundsBefore < 8
        ? { requestId: saved.pending.requestId, roundsBefore: saved.pending.roundsBefore } : null,
      attachmentWarning: Boolean(saved.attachmentWarning),
    };
  } catch { return null; }
}

export function reconcileConversationMessages(local, remote, rounds, pending) {
  const confirmed = remote.map(messageCopy).filter(Boolean);
  const result = [];
  let cursor = 0;
  while (confirmed[cursor]?.role === "assistant") result.push(confirmed[cursor++]);
  for (let index = 0; index < local.length - 1; index += 1) {
    const user = local[index], answer = local[index + 1];
    if (user?.role !== "user" || answer?.role !== "assistant") continue;
    const remoteUser = confirmed[cursor];
    const uncommitted = index === local.length - 2 && pending && rounds <= pending.roundsBefore;
    const completedPending = index === local.length - 2 && pending && rounds > pending.roundsBefore;
    const matched = remoteUser?.role === "user" && (remoteUser.message ?? remoteUser.text) === (user.message ?? user.text)
      && (user.imagesOmitted || JSON.stringify(remoteUser.images || []) === JSON.stringify(user.images || []));
    if (matched && !uncommitted) {
      result.push(...confirmed.slice(cursor, cursor + 2)); cursor += 2;
    } else if (!completedPending && (answer.error || answer.stopped || uncommitted)) {
      result.push(messageCopy(user), messageCopy(answer));
    }
    index += 1;
  }
  return [...result, ...confirmed.slice(cursor)].filter(Boolean);
}

export function confirmReadingAction({ trigger, title, description, confirmLabel }) {
  if (document.querySelector(".reading-confirm-backdrop")) return Promise.resolve(false);
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "reading-confirm-backdrop";
    backdrop.innerHTML = `<section class="reading-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="reading-confirm-title" aria-describedby="reading-confirm-description"><h2 id="reading-confirm-title"></h2><p id="reading-confirm-description"></p><div class="reading-confirm-actions"><button type="button" data-reading-cancel>留下来</button><button type="button" data-reading-confirm></button></div></section>`;
    backdrop.querySelector("h2").textContent = title;
    backdrop.querySelector("p").textContent = description;
    const cancel = backdrop.querySelector("[data-reading-cancel]");
    const confirm = backdrop.querySelector("[data-reading-confirm]");
    confirm.textContent = confirmLabel;
    const shell = document.querySelector(".site-shell");
    const previousInert = shell?.inert;
    if (shell) shell.inert = true;
    document.body.append(backdrop);
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const finish = (confirmed) => {
      controller.abort(); backdrop.remove();
      if (shell) shell.inert = previousInert;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      resolve(confirmed);
    };
    cancel.addEventListener("click", () => finish(false), options);
    confirm.addEventListener("click", () => finish(true), options);
    backdrop.addEventListener("click", (event) => { if (event.target === backdrop) finish(false); }, options);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(false); }
      if (event.key === "Tab" && event.shiftKey && document.activeElement === cancel) { event.preventDefault(); confirm.focus(); }
      else if (event.key === "Tab" && !event.shiftKey && document.activeElement === confirm) { event.preventDefault(); cancel.focus(); }
    }, { ...options, capture: true });
    document.addEventListener("arcana:account-change", () => finish(false), options);
    window.addEventListener("popstate", () => finish(false), options);
    cancel.focus({ preventScroll: true });
  });
}
