document.addEventListener('DOMContentLoaded', loadSettings);

document.getElementById('saveBtn').addEventListener('click', saveSettings);

async function loadSettings() {
  try {
    const settings = await chrome.runtime.sendMessage({ action: 'getSettings' });
    if (!settings.error) {
      document.getElementById('apiKey').value = settings.apiKey || '';
      document.getElementById('apiBase').value = settings.apiBase || 'https://api.deepseek.com/v1';
      document.getElementById('apiModel').value = settings.apiModel || 'deepseek-chat';
    }
  } catch (e) {
    // Settings not loaded, use defaults
  }
}

async function saveSettings() {
  const apiKey = document.getElementById('apiKey').value.trim();
  const apiBase = document.getElementById('apiBase').value.trim() || 'https://api.deepseek.com/v1';
  const apiModel = document.getElementById('apiModel').value.trim() || 'deepseek-chat';

  if (!apiKey) {
    showStatus('请输入 API Key', 'error');
    return;
  }

  try {
    await chrome.storage.local.set({ apiKey, apiBase, apiModel });
    showStatus('✓ 设置已保存', 'success');
  } catch (e) {
    showStatus('保存失败: ' + e.message, 'error');
  }
}

function showStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status ' + type;
  if (type === 'success') {
    setTimeout(() => { el.textContent = ''; el.className = 'status'; }, 3000);
  }
}
