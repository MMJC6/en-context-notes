document.addEventListener('DOMContentLoaded', init);

let allRecords = [];

async function init() {
  await loadData();
  bindEvents();
}

async function loadData() {
  try {
    // Deduplicate any duplicate records from before the checkWord fix
    await chrome.runtime.sendMessage({ action: 'deduplicate' });
    const result = await chrome.runtime.sendMessage({ action: 'getAllRecords' });
    if (result.error) {
      document.getElementById('recordList').innerHTML =
        `<div class="empty-state">加载失败: ${result.error}</div>`;
      return;
    }
    allRecords = (result.records || []).sort((a, b) => b.timestamp - a.timestamp);
    renderRecordsTab();
  } catch (e) {
    document.getElementById('recordList').innerHTML =
      `<div class="empty-state">加载失败: ${e.message}</div>`;
  }
}

function bindEvents() {
  document.getElementById('exportBtn').addEventListener('click', exportJSON);
  document.getElementById('searchInput').addEventListener('input', () => {
    clearTimeout(bindEvents._timer);
    bindEvents._timer = setTimeout(renderRecordsTab, 200);
  });

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const targetId = 'tab' + btn.dataset.tab.charAt(0).toUpperCase() + btn.dataset.tab.slice(1);
      document.getElementById(targetId).classList.add('active');
      if (btn.dataset.tab === 'growth') renderGrowthTab();
    });
  });
}

// ===== Records Tab =====
function renderRecordsTab() {
  const query = document.getElementById('searchInput').value.trim().toLowerCase();
  let records = allRecords;
  if (query) {
    records = allRecords.filter(r =>
      r.word.toLowerCase().includes(query) ||
      (r.sentence || '').toLowerCase().includes(query) ||
      (r.wordTranslation || '').toLowerCase().includes(query) ||
      (r.sentenceTranslation || '').toLowerCase().includes(query)
    );
  }

  // Group by date
  const dateMap = new Map();
  for (const r of records) {
    const dateKey = new Date(r.timestamp).toLocaleDateString('zh-CN');
    if (!dateMap.has(dateKey)) dateMap.set(dateKey, []);
    dateMap.get(dateKey).push(r);
  }

  const dateGroups = [...dateMap.entries()];
  const uniqueUrls = new Set(records.map(r => r.url)).size;
  const totalEncounters = records.reduce((sum, r) => sum + (r.encounterCount || 1), 0);
  document.getElementById('totalWords').textContent = `${records.length} 个单词`;
  document.getElementById('totalEncounters').textContent = `${totalEncounters} 次遇见`;
  document.getElementById('totalArticles').textContent = `${uniqueUrls} 篇文章`;

  if (dateGroups.length === 0) {
    document.getElementById('recordList').innerHTML =
      `<div class="empty-state">${query ? '没有匹配的记录' : '暂无记录，去网页上划词翻译吧'}</div>`;
    return;
  }

  document.getElementById('recordList').innerHTML =
    dateGroups.map(([dateKey, dateRecords]) => renderDateGroup(dateKey, dateRecords)).join('');

  bindRecordInteractions();
}

function renderDateGroup(dateKey, dateRecords) {
  const daysAgo = getDaysAgo(dateRecords[0].timestamp);
  const dateDisplay = daysAgo === 0 ? '今天' :
    daysAgo === 1 ? '昨天' :
    daysAgo <= 7 ? `${daysAgo} 天前` :
    daysAgo <= 30 ? `${Math.floor(daysAgo / 7)} 周前` :
    dateKey;

  // Group by URL within date
  const urlMap = new Map();
  for (const r of dateRecords) {
    if (!urlMap.has(r.url)) urlMap.set(r.url, []);
    urlMap.get(r.url).push(r);
  }
  const urlGroups = [...urlMap.entries()];

  const totalEncounters = dateRecords.reduce((sum, r) => sum + (r.encounterCount || 1), 0);

  return `
    <div class="date-group">
      <div class="date-header">
        <span class="date-label">${dateDisplay}</span>
        <span class="date-sub">${dateKey}</span>
        <span class="date-article-count">${urlGroups.length} 篇文章 · ${dateRecords.length} 词 · ${totalEncounters} 次遇见</span>
      </div>
      ${urlGroups.map(([url, urlRecords], i) => renderUrlGroup(url, urlRecords, i)).join('')}
    </div>
  `;
}

function renderUrlGroup(url, urlRecords, index) {
  const title = urlRecords[0].title || url;
  const wordCount = urlRecords.length;
  const firstOpen = index === 0 ? ' open' : '';

  return `
    <div class="url-group${firstOpen}">
      <div class="url-group-header">
        <span class="url-group-arrow">▶</span>
        <a class="url-group-title" href="${escapeAttr(url)}" target="_blank" title="${escapeHtml(url)}">${escapeHtml(title)}</a>
        <span class="url-group-word-count">${wordCount} 词</span>
      </div>
      <div class="url-group-records">
        ${urlRecords.map(r => renderRecordCard(r)).join('')}
      </div>
    </div>
  `;
}

function renderRecordCard(r) {
  const time = new Date(r.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const count = r.encounterCount || 1;
  const contexts = r.contexts || [];

  let freqClass = '';
  let freqIcon = '';
  let freqTitle = '';
  if (count >= 7) {
    freqClass = ' freq-done';
    freqIcon = '🌟';
    freqTitle = '已掌握';
  } else if (count >= 5) {
    freqClass = ' freq-familiar';
    freqIcon = '💚';
    freqTitle = '熟悉';
  } else if (count >= 3) {
    freqClass = ' freq-hot';
    freqIcon = '🔥';
    freqTitle = '高频';
  }

  let encounterHtml = '';
  if (count > 1) {
    const prevContexts = contexts.slice(0, -1).reverse().slice(0, 2);
    const ctxHtml = prevContexts.map(ctx =>
      `<div class="record-context-item">
        <span class="record-context-sentence">${escapeHtml(ctx.sentence || '')}</span>
      </div>`
    ).join('');
    encounterHtml = `
      <div class="record-encounter-info">
        <span class="record-encounter-count">遇见 ${count} 次</span>
        ${ctxHtml}
      </div>`;
  }

  return `
    <div class="record-card${freqClass}">
      <div class="record-word-row">
        <span class="record-word">${escapeHtml(r.word)}</span>
        <span class="record-word-translation">${escapeHtml(r.wordTranslation || '')}</span>
        ${freqIcon ? `<span class="freq-mark" title="${freqTitle}">${freqIcon}</span>` : ''}
      </div>
      <div class="record-sentence">${escapeHtml(r.sentence)}</div>
      <div class="record-sentence-translation">${escapeHtml(r.sentenceTranslation || '')}</div>
      ${encounterHtml}
      <div class="record-footer">
        <span class="record-time">${time}</span>
        <button class="record-speak-btn" data-sentence="${escapeAttr(r.sentence)}" title="朗读">▶</button>
        <button class="record-delete-btn" data-id="${r.id}">✕</button>
      </div>
    </div>
  `;
}

function bindRecordInteractions() {
  // URL title links — stop propagation so they open the page, not toggle the group
  document.querySelectorAll('.url-group-title').forEach(link => {
    link.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  });

  document.querySelectorAll('.url-group-header').forEach(header => {
    header.addEventListener('click', () => {
      header.closest('.url-group').classList.toggle('open');
    });
  });

  document.querySelectorAll('.record-speak-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      speak(btn.dataset.sentence);
    });
  });

  document.querySelectorAll('.record-delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('删除这条记录？')) return;
      await chrome.runtime.sendMessage({ action: 'deleteRecord', id: btn.dataset.id });
      await loadData();
    });
  });
}

// ===== Growth Diary =====
function renderGrowthTab() {
  const el = document.getElementById('tabGrowth');
  const stats = calculateGrowthStats(allRecords);

  el.innerHTML = `
    <div class="growth-section">
      <h2>成长概览</h2>
      <div class="growth-cards">
        <div class="growth-card">
          <div class="growth-card-value">${stats.totalWords}</div>
          <div class="growth-card-label">累计遇见单词</div>
        </div>
        <div class="growth-card">
          <div class="growth-card-value">${stats.repeatWords}</div>
          <div class="growth-card-label">反复遇见的单词</div>
        </div>
        <div class="growth-card">
          <div class="growth-card-value">${stats.totalEncounters}</div>
          <div class="growth-card-label">总遇见次数</div>
        </div>
        <div class="growth-card">
          <div class="growth-card-value">${stats.articlesCount}</div>
          <div class="growth-card-label">阅读文章数</div>
        </div>
      </div>
    </div>

    <div class="growth-section">
      <h2>重复遇见排行榜</h2>
      <div class="growth-top-words">
        ${stats.topRepeatWords.map((w, i) => `
          <div class="growth-word-row ${i < 3 ? 'top-three' : ''}">
            <span class="growth-word-rank">#${i + 1}</span>
            <span class="growth-word-text">${escapeHtml(w.word)}</span>
            <span class="growth-word-count">遇见 ${w.encounterCount} 次</span>
          </div>
        `).join('')}
        ${stats.topRepeatWords.length === 0 ? '<div class="growth-empty">还没有重复遇见的单词</div>' : ''}
      </div>
    </div>

    <div class="growth-section">
      <h2>最近 30 天活动</h2>
      <div class="growth-calendar">
        ${renderActivityCalendar(stats.dailyActivity)}
      </div>
    </div>

    <div class="growth-section">
      <h2>学习洞察</h2>
      <div class="growth-insights">
        <p>${stats.insights}</p>
      </div>
    </div>
  `;
}

function calculateGrowthStats(records) {
  const totalWords = records.length;
  const repeatWords = records.filter(r => (r.encounterCount || 1) > 1).length;
  const totalEncounters = records.reduce((sum, r) => sum + (r.encounterCount || 1), 0);
  const uniqueUrls = new Set(records.map(r => r.url)).size;

  const sorted = [...records].sort((a, b) => (b.encounterCount || 1) - (a.encounterCount || 1));
  const topRepeatWords = sorted.filter(r => (r.encounterCount || 1) > 1).slice(0, 10);

  // Daily activity (last 30 days)
  const dailyActivity = {};
  const now = Date.now();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now - i * 86400000);
    dailyActivity[d.toLocaleDateString('zh-CN')] = 0;
  }
  for (const r of records) {
    const key = new Date(r.timestamp).toLocaleDateString('zh-CN');
    if (dailyActivity[key] !== undefined) dailyActivity[key]++;
  }

  // Insights
  let insights = '';
  if (totalWords === 0) {
    insights = '开始你的第一个划词翻译吧！在阅读英文内容时选中单词，就能看到翻译并自动收录。';
  } else {
    const daysSinceFirst = Math.ceil((now - Math.min(...records.map(r => r.timestamp))) / 86400000) || 1;
    const avgDaily = (totalEncounters / daysSinceFirst).toFixed(1);
    insights = `在 ${daysSinceFirst} 天里，你遇见了 ${totalWords} 个不同的单词，累计 ${totalEncounters} 次。`;
    insights += ` 其中 ${repeatWords} 个单词在不同的文章中重复遇见（${totalWords > 0 ? (repeatWords / totalWords * 100).toFixed(0) : 0}%），说明你正在自然地吸收它们。`;
    insights += ` 平均每天遇见 ${avgDaily} 次。`;
    if (repeatWords > 0) {
      const mostRepeated = sorted[0];
      insights += ` 遇见最多的单词是 "${mostRepeated.word}"，共 ${mostRepeated.encounterCount} 次，在不同的语境中反复出现最能加深记忆。`;
    }
  }

  return { totalWords, repeatWords, totalEncounters, articlesCount: uniqueUrls,
           topRepeatWords, dailyActivity, insights };
}

function renderActivityCalendar(dailyActivity) {
  const entries = Object.entries(dailyActivity);
  const maxVal = Math.max(...entries.map(([, v]) => v), 1);
  return entries.map(([date, count]) => {
    const intensity = count > 0 ? Math.min(Math.floor((count / maxVal) * 4), 4) : 0;
    return `<div class="cal-day cal-level-${intensity}" title="${date}: ${count} 个单词"></div>`;
  }).join('');
}

// ===== TTS =====
function speak(text) {
  chrome.runtime.sendMessage({ action: 'speak', text });
}

// ===== Export =====
async function exportJSON() {
  const blob = new Blob([JSON.stringify(allRecords, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `en-learn-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ===== Helpers =====
function getDaysAgo(ts) {
  const now = Date.now();
  const then = new Date(ts).setHours(0, 0, 0, 0);
  const today = new Date(now).setHours(0, 0, 0, 0);
  return Math.round((today - then) / 86400000);
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
