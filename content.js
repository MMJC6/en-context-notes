// ===== State =====
let popup = null;
let hideTimer = null;
let debounceTimer = null;
let isSpeaking = false;
let currentRecordId = null;
const EXTENSION_RELOAD_MSG = '扩展刚刚更新，当前页面仍在使用旧脚本。请刷新页面后重试。';

// ===== Chinese page detection =====
function isChinesePage() {
  const text = document.body.textContent || '';
  const sample = text.substring(0, 5000);
  const chineseChars = (sample.match(/[一-鿿]/g) || []).length;
  return chineseChars / Math.max(sample.length, 1) > 0.3;
}

document.addEventListener('mouseup', onMouseUp, { passive: true });
document.addEventListener('mousedown', onMouseDown, { passive: true });

// ===== Mouse handlers =====
function onMouseDown(e) {
  // Don't hide if clicking inside our popup
  if (popup && popup.contains(e.target)) return;
  clearTimeout(debounceTimer);
  scheduleHide(600);
}

function onMouseUp(e) {
  // Skip if clicking inside our popup
  if (popup && popup.contains(e.target)) return;

  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => handleSelection(e), 250);
}

function handleSelection(e) {
  const selection = window.getSelection();
  const selectedText = selection.toString().trim();

  // Validate selection
  if (!selectedText || selectedText.length < 2) return;
  if (selectedText.length > 200) return; // Too long, probably not a word
  if (/[一-鿿]/.test(selectedText)) return; // Chinese text — skip
  if (!/[a-zA-Z]/.test(selectedText)) return;

  // Double-check not on Chinese page (page content could change)
  if (isChinesePage()) return;

  const sentence = getFullSentence(selection);
  if (!sentence || sentence.length < 3) return;

  showPopup(e.clientX, e.clientY, selectedText, sentence);
}

// ===== Full sentence extraction =====
function getFullSentence(selection) {
  try {
    const range = selection.getRangeAt(0);
    if (!range || range.collapsed) return '';

    const selectedText = selection.toString();

    // Find the containing element with significant text
    let container = range.commonAncestorContainer;
    if (container.nodeType === Node.TEXT_NODE) {
      container = container.parentNode;
    }

    // Walk up to find a reasonable text block (paragraph, div, article section)
    let block = container;
    while (block && block !== document.body && block !== document.documentElement) {
      const textLen = (block.textContent || '').length;
      // Stop at a block that has enough text but isn't the whole page
      if (textLen >= selectedText.length && textLen <= 5000) break;
      // If parent has way more text, stop here
      const parentLen = (block.parentNode?.textContent || '').length;
      if (parentLen > textLen * 3 && textLen > 0) break;
      block = block.parentNode;
    }

    const fullText = block.textContent || '';
    if (!fullText) return selectedText;

    // Find selected text offset within the block's text
    const selStart = findTextOffset(block, range.startContainer, range.startOffset);
    const selEnd = findTextOffset(block, range.endContainer, range.endOffset);

    if (selStart < 0 || selEnd < 0) return selectedText;

    // Find sentence boundaries
    const before = fullText.substring(0, selStart);
    const after = fullText.substring(selEnd);

    // Sentence-ending punctuation
    const sentEndRe = /[.!?。！？](?=\s+|$)/g;

    // Find sentence start: last sentence-ending punctuation before selection
    let sentenceStart = 0;
    let match;
    sentEndRe.lastIndex = 0;
    while ((match = sentEndRe.exec(before)) !== null) {
      sentenceStart = match.index + match[0].length;
    }
    // Also break at newline boundaries
    const lastNewline = before.lastIndexOf('\n');
    if (lastNewline > sentenceStart) sentenceStart = lastNewline + 1;

    // Find sentence end: first sentence-ending punctuation after selection
    const endMatch = sentEndRe.exec(after);
    const sentenceEnd = endMatch
      ? selEnd + endMatch.index + endMatch[0].length
      : fullText.length;

    let extracted = fullText.substring(sentenceStart, sentenceEnd).trim();

    // If extraction failed or is too short, return just the selection
    if (extracted.length < selectedText.length) return selectedText;

    // Cap at reasonable length
    if (extracted.length > 500) {
      // Try to keep it reasonable
      extracted = extracted.substring(0, 500);
      const lastPunct = Math.max(
        extracted.lastIndexOf('.'),
        extracted.lastIndexOf('!'),
        extracted.lastIndexOf('?')
      );
      if (lastPunct > selectedText.length) {
        extracted = extracted.substring(0, lastPunct + 1);
      }
    }

    return extracted;
  } catch (e) {
    return selection.toString().trim();
  }
}

function findTextOffset(root, targetNode, targetOffset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
  let offset = 0;
  let node;
  while ((node = walker.nextNode())) {
    if (node === targetNode) {
      return offset + targetOffset;
    }
    offset += node.textContent.length;
  }
  return -1;
}

// ===== Popup UI =====
function createPopup() {
  popup = document.createElement('div');
  popup.className = 'en-trans-popup';
  popup.innerHTML = `
    <div class="en-trans-original"></div>
    <div class="en-trans-word-box" style="display:none">
      <div class="en-trans-word-result"></div>
    </div>
    <div class="en-trans-sentence-box" style="display:none">
      <div class="en-trans-sentence-label">整句翻译</div>
      <div class="en-trans-sentence-result"></div>
    </div>
    <div class="en-trans-encounter" style="display:none">
      <div class="en-trans-encounter-label"></div>
      <div class="en-trans-encounter-previous" style="display:none">
        <div class="en-trans-encounter-prev-list"></div>
      </div>
    </div>
    <div class="en-trans-loading">
      <div class="en-trans-spinner"></div>
      <span>翻译中...</span>
    </div>
    <div class="en-trans-actions">
      <button class="en-trans-btn speak" title="朗读原句">▶</button>
      <span class="en-trans-status"></span>
    </div>
  `;

  popup.addEventListener('mouseenter', () => {
    clearTimeout(hideTimer);
  });

  popup.addEventListener('mouseleave', () => {
    scheduleHide(800);
  });

  // Speak button
  popup.querySelector('.en-trans-btn.speak').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSpeak();
  });

  document.body.appendChild(popup);
}

function showPopup(x, y, word, sentence) {
  if (!popup) createPopup();

  // Reset state
  isSpeaking = false;
  currentRecordId = null;

  // Highlight word in sentence display
  const originalEl = popup.querySelector('.en-trans-original');
  const parts = sentence.split(new RegExp('(' + escapeRegex(word) + ')', 'gi'));
  originalEl.innerHTML = parts.map((part, i) => {
    if (part.toLowerCase() === word.toLowerCase()) {
      return '<span class="en-trans-word-highlight">' + escapeHtml(part) + '</span>';
    }
    return escapeHtml(part);
  }).join('');

  // Reset sections
  popup.querySelector('.en-trans-word-box').style.display = 'none';
  popup.querySelector('.en-trans-sentence-box').style.display = 'none';
  popup.querySelector('.en-trans-loading').style.display = 'flex';
  popup.querySelector('.en-trans-status').textContent = '';

  // Position — show at approximate spot first, measure, then adjust
  popup.style.left = (x + 12) + 'px';
  popup.style.top = (y + 12) + 'px';
  popup.style.display = 'block';
  popup.offsetHeight; // force layout

  const popupRect = popup.getBoundingClientRect();
  let px = x + 12;
  let py = y + 12;

  if (px + popupRect.width > window.innerWidth) px = window.innerWidth - popupRect.width - 8;
  if (py + popupRect.height > window.innerHeight) py = y - popupRect.height - 12;
  if (px < 4) px = 4;
  if (py < 4) py = 4;

  popup.style.left = px + 'px';
  popup.style.top = py + 'px';
  requestAnimationFrame(() => popup.classList.add('visible'));

  // Reset hide timer
  clearTimeout(hideTimer);

  // Trigger translation
  translateAndUpdate(word, sentence, document.title, location.href);
}

function scheduleHide(ms) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (popup) {
      popup.classList.remove('visible');
      setTimeout(() => {
        if (popup && !popup.matches(':hover')) {
          popup.style.display = 'none';
        }
      }, 200);
    }
  }, ms);
}

function canUseRuntime() {
  return !!(globalThis.chrome && chrome.runtime && typeof chrome.runtime.sendMessage === 'function');
}

async function sendRuntimeMessage(message) {
  if (!canUseRuntime()) {
    throw new Error(EXTENSION_RELOAD_MSG);
  }

  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    const messageText = error && error.message ? error.message : String(error || '');
    if (
      messageText.includes('Extension context invalidated') ||
      messageText.includes('Receiving end does not exist') ||
      messageText.includes('Cannot read properties of undefined')
    ) {
      throw new Error(EXTENSION_RELOAD_MSG);
    }
    throw error;
  }
}

async function translateAndUpdate(word, sentence, title, url) {
  try {
    // Step 1: Check if word was seen before (runs in parallel with translate)
    const checkPromise = sendRuntimeMessage({ action: 'checkWord', word });

    // Step 2: Translate
    const result = await sendRuntimeMessage({ action: 'translate', word, sentence });

    if (!result) {
      showError('翻译服务无响应，请刷新页面后重试');
      return;
    }

    if (result.error) {
      console.error('[content] translate error:', result.error);
      if (typeof result.error === 'string' && result.error.includes('API Key')) {
        showOnboarding();
      } else {
        showError(typeof result.error === 'string' ? result.error : '翻译失败');
      }
      return;
    }

    // Show translation results
    popup.querySelector('.en-trans-loading').style.display = 'none';

    const wordBox = popup.querySelector('.en-trans-word-box');
    wordBox.style.display = 'block';
    wordBox.querySelector('.en-trans-word-result').textContent = result.wordTranslation;

    const sentBox = popup.querySelector('.en-trans-sentence-box');
    sentBox.style.display = 'block';
    sentBox.querySelector('.en-trans-sentence-result').textContent = result.sentenceTranslation;

    // Step 3: Wait for word check, then save (upsert)
    const checkResult = await checkPromise;

    const saveResult = await sendRuntimeMessage({
      action: 'saveRecord',
      record: {
        word,
        wordTranslation: result.wordTranslation,
        sentence,
        sentenceTranslation: result.sentenceTranslation,
        url,
        title
      }
    });

    if (saveResult.success) {
      currentRecordId = saveResult.id;

      if (saveResult.isRepeat) {
        const encounterEl = popup.querySelector('.en-trans-encounter');
        encounterEl.style.display = 'block';
        encounterEl.querySelector('.en-trans-encounter-label').textContent =
          `✨ 第 ${saveResult.encounterCount} 次遇见这个单词`;

        // Show previous contexts
        const prevList = (checkResult.record?.contexts || []).slice(0, -1).reverse();
        if (prevList.length > 0) {
          const prevEl = encounterEl.querySelector('.en-trans-encounter-previous');
          prevEl.style.display = 'block';
          prevEl.querySelector('.en-trans-encounter-prev-list').innerHTML = prevList.slice(0, 3).map(ctx =>
            `<div class="en-trans-encounter-item">
              <span class="en-trans-encounter-sentence">${escapeHtml(ctx.sentence)}</span>
              <span class="en-trans-encounter-meta">${escapeHtml((ctx.title || ctx.url))}</span>
            </div>`
          ).join('');
        }

        popup.querySelector('.en-trans-status').textContent =
          `已记录 · 第 ${saveResult.encounterCount} 次`;
      } else {
        popup.querySelector('.en-trans-status').textContent = '✓ 已保存';
      }
    } else if (saveResult.error) {
      popup.querySelector('.en-trans-status').textContent = '⚠ 保存失败';
    }
  } catch (e) {
    showError(e.message || '翻译失败');
  }
}

function showOnboarding() {
  popup.querySelector('.en-trans-loading').style.display = 'none';
  const wordBox = popup.querySelector('.en-trans-word-box');
  wordBox.style.display = 'block';
  wordBox.querySelector('.en-trans-word-label') && (wordBox.querySelector('.en-trans-word-label').textContent = '');
  wordBox.querySelector('.en-trans-word-result').innerHTML =
    '<div style="text-align:center;padding:12px 0;">' +
    '<div style="font-size:14px;margin-bottom:8px;">👋 首次使用</div>' +
    '<div style="font-size:12px;color:#a6adc8;margin-bottom:10px;">请先配置 API Key 以启用翻译</div>' +
    '<button id="en-onboarding-btn" style="' +
    'background:#89b4fa;color:#1e1e2e;border:none;padding:6px 20px;border-radius:6px;' +
    'font-size:12px;font-weight:600;cursor:pointer;">前往设置 →</button>' +
    '</div>';

  document.getElementById('en-onboarding-btn').addEventListener('click', () => {
    sendRuntimeMessage({ action: 'openOptions' }).catch((e) => showError(e.message || EXTENSION_RELOAD_MSG));
  });
}

function showError(msg) {
  popup.querySelector('.en-trans-loading').style.display = 'none';
  const wordBox = popup.querySelector('.en-trans-word-box');
  wordBox.style.display = 'block';
  wordBox.querySelector('.en-trans-word-result').textContent = msg;
  wordBox.querySelector('.en-trans-word-result').style.color = '#f38ba8';
}

// ===== TTS =====
function toggleSpeak() {
  const sentence = popup.querySelector('.en-trans-original').textContent;
  if (!sentence) return;

  const btn = popup.querySelector('.en-trans-btn.speak');

  if (isSpeaking) {
    sendRuntimeMessage({ action: 'speak', text: '' }).catch(() => {}); // empty = stop
    isSpeaking = false;
    btn.classList.remove('playing');
    btn.textContent = '▶';
    return;
  }

  isSpeaking = true;
  btn.classList.add('playing');
  btn.textContent = '⏹';

  sendRuntimeMessage({ action: 'speak', text: sentence }).then(() => {
    isSpeaking = false;
    btn.classList.remove('playing');
    btn.textContent = '▶';
  }).catch(() => {
    isSpeaking = false;
    btn.classList.remove('playing');
    btn.textContent = '▶';
  });
}

// ===== Utilities =====
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
