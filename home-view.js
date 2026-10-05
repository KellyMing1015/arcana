const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function symbol(spread) {
  const drawings = {
    1: '<path d="M31 8a17 17 0 1 0 10 30A16 16 0 0 1 31 8Z"/><path d="m36 10 1.2 3.8L41 15l-3.8 1.2L36 20l-1.2-3.8L31 15l3.8-1.2Z" stroke-width=".9"/>',
    3: '<path d="M9 28q15-19 30 0M9 28q15 16 30 0" opacity=".45"/><path d="m9 23 1.5 4.5L15 29l-4.5 1.5L9 35l-1.5-4.5L3 29l4.5-1.5Zm15-14 1.7 5.3L31 16l-5.3 1.7L24 23l-1.7-5.3L17 16l5.3-1.7Zm15 14 1.5 4.5L45 29l-4.5 1.5L39 35l-1.5-4.5L33 29l4.5-1.5Z"/>',
    10: '<circle cx="24" cy="24" r="14" opacity=".5"/><path d="M24 4v40M4 24h40" opacity=".7"/><path d="m24 15 2.2 6.8L33 24l-6.8 2.2L24 33l-2.2-6.8L15 24l6.8-2.2Z"/><path d="m11 11 4 4m18 18 4 4m-26 0 4-4m18-18 4-4" opacity=".35"/>',
  };
  return `<svg class="eclipse-spread-symbol" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${drawings[spread]}</svg>`;
}

export function renderHomeMarkup(_backArt, _spreadIcon, state) {
  return `<section class="ritual-screen question-screen eclipse-home screen-enter">
    <div class="eclipse-home-inner">
      <div class="eclipse-hero" aria-hidden="true"><div class="eclipse-observatory-field"><svg class="eclipse-reticle" viewBox="0 0 700 700" fill="none"><circle cx="350" cy="350" r="323"/><circle cx="350" cy="350" r="294" opacity=".38"/><path d="M350 17v18M350 665v18M17 350h18M665 350h18M183.5 61.6l9 15.6M507.5 622.8l9 15.6M61.6 183.5l15.6 9M622.8 507.5l15.6 9M61.6 516.5l15.6-9M622.8 192.5l15.6-9M183.5 638.4l9-15.6M507.5 77.2l9-15.6"/></svg><img class="eclipse-moon-art" src="/assets/ui/observatory-moon.svg" width="600" height="600" alt=""><span class="eclipse-limb"></span></div></div>
      <form id="question-form" class="ritual-question-form eclipse-form">
        <h1>此刻，你想问什么？</h1>
        <label class="sr-only" for="question">想问的问题</label>
        <div class="eclipse-question-line"><textarea id="question" class="question-center-input" rows="1" maxlength="220" aria-label="想问的问题" required>${escapeHTML(state.question)}</textarea><svg class="eclipse-input-sign" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 17-1 4 4-1L19 9l-3-3-11 11Z"/><path d="m14 8 3 3M16 6l2-2a2 2 0 0 1 3 3l-2 2"/></svg></div>
        <fieldset class="ritual-spreads"><legend>选择牌阵</legend>
        ${[[1,'单牌'],[3,'三牌阵'],[10,'凯尔特十字']].map(([n,name])=>`<button type="button" data-spread="${n}" class="ritual-spread ${state.spread===n?'active':''}" aria-pressed="${state.spread===n}">${symbol(n)}<strong>${name}</strong></button>`).join('')}
        </fieldset>
        <button class="ritual-primary home-submit" type="submit">开始抽牌<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5"/></svg></button>
      </form>
    </div>
  </section>`;
}
