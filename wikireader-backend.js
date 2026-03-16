(function () {
  'use strict';

  let paragraphs       = [];
  let japaneseVoices   = [];
  let currentParaIndex = -1;
  let isPlaying        = false;
  let baseSpeed        = 1.0;
  let utterance        = null;
  let articleTitle     = '';
  let currentMode      = 'random'; // 'random' | 'category' | 'search'
  let activeCategory   = '';
  let pendingTitle     = '';
//  let countdownTimer   = null;
  let cdSec            = 0;
  let userHasInteracted = false;

  const root = () => document.querySelector('.wikireader');
  const $    = (id) => document.getElementById(id);

  /* ---------- 音声 ---------- */
  function initVoices() {
    const all = speechSynthesis.getVoices();
    japaneseVoices = all.filter(v => v.lang.startsWith('ja'));
    if (!japaneseVoices.length) japaneseVoices = all;
    const nameEl = $('wr-voice-name');
    if (nameEl) {
      nameEl.textContent = japaneseVoices.length
        ? `${japaneseVoices.length}個の日本語音声を利用します`
        : 'システム音声を利用します';
    }
  }

  function rndVoice() {
    return Math.floor(Math.random() * Math.max(japaneseVoices.length, 1));
  }

  /* ---------- モード切替 ---------- */
  function setMode(mode) {
    currentMode = mode;
    ['random', 'category', 'search'].forEach(m => {
      $(`wr-tab-${m}`).classList.toggle('active', m === mode);
      $(`wr-row-${m}`).classList.toggle('visible', m === mode);
    });
    const btnNew  = $('wr-btn-new');
    const isSearch = mode === 'search';
    if (btnNew) {
      if (mode === 'random')   { btnNew.textContent = '新しい記事';     btnNew.style.display = ''; }
      if (mode === 'category') { btnNew.textContent = 'カテゴリから取得'; btnNew.style.display = ''; }
      if (mode === 'search')   { btnNew.style.display = 'none'; }
    }
    const note = $('wr-auto-note');
    if (note) note.textContent = mode === 'search' ? '※ 「記事を検索」モードでは自動再生できません' : '';
  }

  /* ---------- カテゴリ ---------- */
  let catTimer = null;

  function onCategoryInput() {
    clearTimeout(catTimer);
    const q = $('wr-category-input').value.trim();
    if (!q) { $('wr-cat-results').classList.remove('visible'); return; }
    catTimer = setTimeout(async () => {
      try {
        const r = await fetch(
          `https://ja.wikipedia.org/w/api.php?action=query&list=allcategories&acprefix=${encodeURIComponent(q)}&aclimit=8&format=json&origin=*`
        );
        const d = await r.json();
        const cats = (d.query?.allcategories || []).map(c => c['*']);
        const el = $('wr-cat-results');
        if (!cats.length) { el.classList.remove('visible'); return; }
        el.innerHTML = cats.map(c =>
          `<div class="wr-search-result-item" onclick="WR.selectCatResult('${c.replace(/'/g, "\\'")}')">
             ${c}
           </div>`
        ).join('');
        el.classList.add('visible');
      } catch (_) {}
    }, 350);
  }

  function selectCatResult(cat) {
    $('wr-category-input').value = cat;
    $('wr-cat-results').classList.remove('visible');
    applyCategory();
  }

  function applyCategory() {
    const val = $('wr-category-input').value.trim();
    if (!val) return;
    activeCategory = val;
    const lbl = $('wr-cat-active-label');
    if (lbl) { lbl.textContent = `カテゴリを適用中: ${val}`; lbl.style.removeProperty('display'); lbl.classList.add('visible'); }
    $('wr-cat-results').classList.remove('visible');
    setMode('category');
  }

  async function fetchTitleFromCategory(cat) {
    const r = await fetch(
      `https://ja.wikipedia.org/w/api.php?action=query&list=categorymembers&cmtitle=Category:${encodeURIComponent(cat)}&cmnamespace=0&cmlimit=50&format=json&origin=*`
    );
    const d = await r.json();
    const members = d.query?.categorymembers || [];
    if (!members.length) throw new Error(`カテゴリ「${cat}」に記事が見つかりませんでした`);
    return members[Math.floor(Math.random() * members.length)].title;
  }

  /* ---------- 記事検索 ---------- */
//  let artTimer = null;

  function onArticleSearch() {
    clearTimeout(artTimer);
    const q = $('wr-article-search-input').value.trim();
    if (!q) { $('wr-article-results').classList.remove('visible'); return; }
    artTimer = setTimeout(async () => {
      try {
        const r = await fetch(
          `https://ja.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=8&namespace=0&format=json&origin=*`
        );
        const d = await r.json();
        const titles = d[1] || [];
        const el = $('wr-article-results');
        if (!titles.length) { el.classList.remove('visible'); return; }
        el.innerHTML = titles.map(t =>
          `<div class="wr-search-result-item" onclick="WR.selectArticleResult('${t.replace(/'/g, "\\'")}')">
             ${t}
           </div>`
        ).join('');
        el.classList.add('visible');
      } catch (_) {}
    }, 300);
  }

  function selectArticleResult(title) {
    $('wr-article-search-input').value = title;
    $('wr-article-results').classList.remove('visible');
    pendingTitle = title;
  }

  async function doArticleSearch() {
    const q = $('wr-article-search-input').value.trim();
    if (!q) return;
    pendingTitle = q;
    $('wr-article-results').classList.remove('visible');
    setMode('search');
    await loadArticle();
  }

  /* ---------- 記事読み込み ---------- */
  async function loadArticle(autoplay = false) {
    stopSpeech();
    setStatus('記事を取得中...', true);

    const titleEl = $('wr-article-title');
    if (titleEl) { titleEl.classList.add('loading'); titleEl.textContent = '読み込み中...'; }
    const playBtn = $('wr-btn-play');
    if (playBtn) playBtn.disabled = true;

    const area = $('wr-content-area');
    if (area) area.innerHTML =
      '<div class="wr-empty-state"><div>記事を取得しています...</div></div>';

    try {
      let pageTitle = '', tagClass = 'tag-random', tagText = 'ランダム';

      if (currentMode === 'category' && activeCategory) {
        pageTitle = await fetchTitleFromCategory(activeCategory);
        tagClass  = 'tag-category';
        tagText   = `${activeCategory}`;
      } else if (currentMode === 'search') {
        pageTitle = pendingTitle || $('wr-article-search-input').value.trim();
        if (!pageTitle) throw new Error('記事名を入力してください');
        tagClass = 'tag-search'; tagText = '検索';
      } else {
        const r = await fetch(
          'https://ja.wikipedia.org/w/api.php?action=query&list=random&rnnamespace=0&rnlimit=1&format=json&origin=*'
        );
        const d = await r.json();
        pageTitle = d.query.random[0].title;
      }

      const cr = await fetch(
        `https://ja.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(pageTitle)}&prop=extracts&explaintext=true&exsectionformat=plain&format=json&origin=*`
      );
      const cd   = await cr.json();
      const page = Object.values(cd.query.pages)[0];

      articleTitle = page.title;
      buildParagraphs(articleTitle, page.extract || '');

      if (titleEl) { titleEl.classList.remove('loading'); titleEl.textContent = articleTitle; }

      const tag = $('wr-source-tag');
      if (tag) { tag.className = `wr-source-tag ${tagClass}`; tag.textContent = tagText; }

      if (playBtn) playBtn.disabled = false;
      setStatus(`${paragraphs.length}段落を読み込みました`);
      renderParagraphs();

      // Wikipedia リンクを更新
      const linkEl = $('wr-article-link');
      if (linkEl) {
        linkEl.href = `https://ja.wikipedia.org/wiki/${encodeURIComponent(articleTitle)}`;
        linkEl.classList.remove('hidden');
      }

      if (autoplay && userHasInteracted) {
        setTimeout(() => { currentParaIndex = 0; speakFrom(0); }, 300);
      }

    } catch (e) {
      setStatus('エラー: ' + e.message);
      if (titleEl) { titleEl.textContent = '取得に失敗しました'; titleEl.classList.remove('loading'); }
    }
  }

  /* ---------- 段落生成 ---------- */
  function buildParagraphs(title, raw) {
    paragraphs = [];
    paragraphs.push({ text: `「${title}」について。`, type: 'intro', voiceIndex: rndVoice() });

    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;

      let type = 'normal';
      if (t.startsWith('>') || t.startsWith('「') || t.startsWith('『')) type = 'quote';
      if (t.includes('`') || /^[A-Za-z0-9_\-.]+\(/.test(t)) type = 'code';

      const c = t
        .replace(/\[\d+\]/g, '')
        .replace(/\[.*?\]/g, '')
        .replace(/https?:\/\/\S+/g, '')
        .trim();

      if (c.length < 3) continue;

      paragraphs.push({ text: c, type, voiceIndex: rndVoice() });
      if (paragraphs.length > 1024) break;
    }
  }

  function renderParagraphs() {
    const area = $('wr-content-area');
    if (!area) return;
    if (!paragraphs.length) {
      area.innerHTML = '<div class="wr-empty-state"><div>テキストが見つかりませんでした</div></div>';
      return;
    }
    area.innerHTML = paragraphs.map((p, i) => {
      let badge = '';
      if (p.type === 'quote') badge = '<span class="wr-para-badge badge-quote">引用</span>';
      if (p.type === 'code')  badge = '<span class="wr-para-badge badge-code">コード</span>';
      const sc = (p.type === 'quote' || p.type === 'code') ? ' slow' : '';
      return `<div class="wr-paragraph-item${sc}" id="wr-para-${i}" onclick="WR.jumpTo(${i})">${badge}${p.text}</div>`;
    }).join('');
  }

  /* ---------- 再生制御 ---------- */
  function togglePlay() {
    userHasInteracted = true;
    if (isPlaying) { pauseSpeech(); }
    else {
      if (currentParaIndex < 0 || currentParaIndex >= paragraphs.length) currentParaIndex = 0;
      speakFrom(currentParaIndex);
    }
  }

  function speakFrom(idx) {
    if (idx >= paragraphs.length) { finishSpeech(); return; }
    isPlaying        = true;
    currentParaIndex = idx;
    updatePlayBtn(true);

    const stopBtn = $('wr-btn-stop');
    if (stopBtn) stopBtn.disabled = false;

    highlightPara(idx);
    updateProgress(idx);

    const p    = paragraphs[idx];
    const slow = p.type === 'quote' || p.type === 'code';

    utterance           = new SpeechSynthesisUtterance(p.text);
    utterance.lang      = 'ja-JP';
    utterance.rate      = slow ? baseSpeed * 0.65 : baseSpeed;
    utterance.pitch     = 1.0;

    if (japaneseVoices.length) {
      const v = japaneseVoices[p.voiceIndex % japaneseVoices.length];
      utterance.voice = v;
      const nameEl = $('wr-voice-name');
      if (nameEl) nameEl.textContent = v.name;
      const dot = $('wr-voice-dot');
      if (dot) dot.classList.add('active');
    }

    setStatus(`段落 ${idx + 1} / ${paragraphs.length}${slow ? ' (ゆっくり)' : ''}`);

    utterance.onend = () => {
      const dot = $('wr-voice-dot');
      if (dot) dot.classList.remove('active');
      if (isPlaying) speakFrom(idx + 1);
    };

    utterance.onerror = e => {
      if (e.error !== 'interrupted') {
        setStatus('音声エラー: ' + e.error);
        isPlaying = false;
        updatePlayBtn(false);
      }
    };

    speechSynthesis.cancel();
    setTimeout(() => speechSynthesis.speak(utterance), 80);
  }

  function pauseSpeech() {
    isPlaying = false;
    speechSynthesis.cancel();
    updatePlayBtn(false);
    setStatus('一時停止中');
    const dot = $('wr-voice-dot');
    if (dot) dot.classList.remove('active');
  }

  function stopSpeech() {
    isPlaying        = false;
    currentParaIndex = -1;
    speechSynthesis.cancel();
    updatePlayBtn(false);

    const stopBtn = $('wr-btn-stop');
    if (stopBtn) stopBtn.disabled = true;

    const fill = $('wr-progress-fill');
    if (fill) fill.style.width = '0%';

    const dot = $('wr-voice-dot');
    if (dot) dot.classList.remove('active');

    clearHighlight();
    setStatus('停止');
  }

  function finishSpeech() {
    isPlaying        = false;
    currentParaIndex = -1;
    updatePlayBtn(false);

    const stopBtn = $('wr-btn-stop');
    if (stopBtn) stopBtn.disabled = true;

    const fill = $('wr-progress-fill');
    if (fill) fill.style.width = '100%';

    const dot = $('wr-voice-dot');
    if (dot) dot.classList.remove('active');

    clearHighlight();

    const chk = $('wr-chk-auto');
    if (chk && chk.checked && currentMode !== 'search') {
      setStatus('次の記事を読み込んでいます...');
      loadArticle(true);
    } else {
      setStatus('読み上げ完了');
    }
  }

  /* ---------- 自動再生チェックボックス ---------- */
  function onAutoChange() {
    const on    = $('wr-chk-auto').checked;
    const label = $('wr-auto-label');
    const badge = $('wr-auto-badge');
    if (label) label.classList.toggle('is-active', on);
    if (badge) badge.classList.toggle('on', on);
  }

  /* ---------- ジャンプ / スピード ---------- */
  function jumpTo(idx) {
    currentParaIndex = idx;
    if (isPlaying) { speechSynthesis.cancel(); speakFrom(idx); }
    else { highlightPara(idx); updateProgress(idx); }
  }

  function changeSpeed(d) {
    baseSpeed = Math.round(Math.max(0.5, Math.min(2.0, baseSpeed + d)) * 10) / 10;
    const el = $('wr-speed-display');
    if (el) el.textContent = baseSpeed.toFixed(1) + '×';
    if (isPlaying) { speechSynthesis.cancel(); speakFrom(currentParaIndex); }
  }

  /* ---------- UI ヘルパー ---------- */
  function updatePlayBtn(playing) {
    const btn = $('wr-btn-play');
    if (!btn) return;
    btn.textContent = playing ? '⏸一時停止' : '▶ 読み上げ開始';
    btn.classList.toggle('playing', playing);
  }

  function highlightPara(idx) {
    clearHighlight();
    const el = $(`wr-para-${idx}`);
    if (el) { el.classList.add('active'); el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  }

  function clearHighlight() {
    document.querySelectorAll('.wr-paragraph-item.active').forEach(e => e.classList.remove('active'));
  }

  function updateProgress(idx) {
    const fill = $('wr-progress-fill');
    if (!fill) return;
    fill.style.width = (paragraphs.length > 1 ? (idx / (paragraphs.length - 1)) * 100 : 0) + '%';
  }

  function setStatus(msg, loading = false) {
    const el = $('wr-status-text');
    if (el) el.textContent = msg;
    const sp = $('wr-spinner');
    if (sp) sp.classList.toggle('active', loading);
  }

  /* ---------- 初期化 ---------- */
  function init() {
    initVoices();
    speechSynthesis.onvoiceschanged = initVoices;
    setMode('random');
    setTimeout(() => loadArticle(false), 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ---------- 公開 API ---------- */
  window.WR = {
    loadArticle,
    togglePlay,
    stopSpeech,
    changeSpeed,
    jumpTo,
    setMode,
    onCategoryInput,
    selectCatResult,
    applyCategory,
    onArticleSearch,
    selectArticleResult,
    doArticleSearch,
    onAutoChange,
  };

})();
