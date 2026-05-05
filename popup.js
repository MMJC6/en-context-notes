document.addEventListener('DOMContentLoaded', loadRecords);

document.getElementById('exportBtn').addEventListener('click', exportJSON);
document.getElementById('openFullBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
});

async function loadRecords() {
  const list = document.getElementById('recordList');
  try {
    const result = await chrome.runtime.sendMessage({ action: 'getRecordsByUrl' });
    if (result.error) {
      list.innerHTML = `<div class="empty-state">加载失败: ${result.error}</div>`;
      return;
    }

    const groups = result.groups || [];
    if (groups.length === 0) {
      list.innerHTML = '<div class="empty-state">暂无记录，去网页上划词翻译吧</div>';
      return;
    }

    list.innerHTML = groups.map((group, gi) => renderGroup(group, gi)).join('');

    // Bind click handlers
    list.querySelectorAll('.url-group-title').forEach(link => {
      link.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    });

    list.querySelectorAll('.url-group-header').forEach(header => {
      header.addEventListener('click', () => {
        header.parentElement.classList.toggle('open');
      });
    });

    list.querySelectorAll('.record-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        await chrome.runtime.sendMessage({ action: 'deleteRecord', id });
        loadRecords();
      });
    });
  } catch (e) {
    list.innerHTML = `<div class="empty-state">加载失败: ${e.message}</div>`;
  }
}

function renderGroup(group, index) {
  const recordCount = group.records.length;
  const firstOpen = index === 0 ? ' open' : ''; // Auto-expand first group

  return `
    <div class="url-group${firstOpen}">
      <div class="url-group-header">
        <div>
          <a class="url-group-title" href="${escapeAttr(group.url)}" target="_blank">${escapeHtml(group.title || '未知页面')}</a>
          <div class="url-group-url">${escapeHtml(group.url)}</div>
        </div>
        <div style="display:flex;align-items:center;">
          <span class="url-group-count">${recordCount} 词</span>
          <span class="url-group-arrow">▶</span>
        </div>
      </div>
      <div class="url-group-records">
        ${group.records.map(r => renderRecord(r)).join('')}
      </div>
    </div>
  `;
}

function renderRecord(r) {
  const time = new Date(r.timestamp).toLocaleString('zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  const encounterBadge = (r.encounterCount || 1) > 1
    ? `<span class="encounter-badge">×${r.encounterCount}</span>`
    : '';

  return `
    <div class="record-item">
      <button class="record-delete" data-id="${r.id}">✕</button>
      <div class="record-word">
        <span class="record-word-text">${escapeHtml(r.word)}</span>
        ${encounterBadge}
        <span class="record-word-arrow">→</span>
        <span class="record-word-translation">${escapeHtml(r.wordTranslation || '')}</span>
      </div>
      <div class="record-sentence">${escapeHtml(r.sentence)}</div>
      <div class="record-sentence-translation">${escapeHtml(r.sentenceTranslation || '')}</div>
      <div class="record-time">${time}</div>
    </div>
  `;
}

async function exportJSON() {
  try {
    const result = await chrome.runtime.sendMessage({ action: 'getAllRecords' });
    if (result.error) {
      alert('导出失败: ' + result.error);
      return;
    }

    const blob = new Blob([JSON.stringify(result.records, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `en-learn-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('导出失败: ' + e.message);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function escapeAttr(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
