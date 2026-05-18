// ===== First install → open welcome page =====
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  }
});

// ===== Prevent idle termination (MV3 edge case: some Chrome versions terminate
//       workers even with pending message ports; 15s heartbeat covers this) =====
chrome.alarms.create('heartbeat', { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener(() => {});

// ===== Translation cache =====
// Uses storage.session: survives worker restart, not persisted across browser restart.
// This is the right trade-off — browser restart = fresh session, cache can rebuild.
const translationCache = {};

let cacheLoaded = false;
async function ensureCacheLoaded() {
  if (cacheLoaded) return;
  const data = await chrome.storage.session.get('transCache');
  if (data.transCache) Object.assign(translationCache, data.transCache);
  cacheLoaded = true;
}

async function saveCache() {
  // Keep only last 500 entries to bound storage usage
  const keys = Object.keys(translationCache);
  if (keys.length > 500) {
    for (const k of keys.slice(0, keys.length - 500)) {
      delete translationCache[k];
    }
  }
  await chrome.storage.session.set({ transCache: translationCache });
}

function hashKey(text) {
  // Simple fast hash for cache key
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h) + text.charCodeAt(i);
    h |= 0;
  }
  return 'h_' + (h >>> 0).toString(36);
}

// ===== Settings =====
async function getSettings() {
  const data = await chrome.storage.local.get(['apiKey', 'apiBase', 'apiModel']);
  return {
    apiKey: data.apiKey || '',
    apiBase: data.apiBase || 'https://api.deepseek.com/v1',
    apiModel: data.apiModel || 'deepseek-chat'
  };
}

// ===== IndexedDB =====
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('enLearnDB', 3);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const tx = e.target.transaction;
      const store = tx.objectStore('records');

      if (!db.objectStoreNames.contains('records')) {
        // Fresh DB: create store with indexes
        const s = db.createObjectStore('records', { keyPath: 'id' });
        s.createIndex('url', 'url', { unique: false });
        s.createIndex('timestamp', 'timestamp', { unique: false });
        s.createIndex('word', 'word', { unique: false });
      } else {
        // Migrations
        if (e.oldVersion < 2 && !store.indexNames.contains('reviewStatus')) {
          store.createIndex('reviewStatus', 'reviewStatus', { unique: false });
        }
        if (e.oldVersion < 3) {
          // Remove v2 review index
          if (store.indexNames.contains('reviewStatus')) {
            store.deleteIndex('reviewStatus');
          }
          // Add word index
          if (!store.indexNames.contains('word')) {
            store.createIndex('word', 'word', { unique: false });
          }
          // Migrate existing records: add encounter fields, remove review fields
          const req2 = store.openCursor();
          req2.onsuccess = (ev) => {
            const cursor = ev.target.result;
            if (cursor) {
              const r = cursor.value;
              r.encounterCount = r.encounterCount || 1;
              r.firstEncounteredAt = r.firstEncounteredAt || r.timestamp;
              r.contexts = r.contexts || [{ url: r.url, title: r.title, sentence: r.sentence, timestamp: r.timestamp }];
              delete r.reviewStatus;
              delete r.lastReviewedAt;
              delete r.reviewCount;
              cursor.update(r);
              cursor.continue();
            }
          };
        }
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function checkWord(word) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readonly');
    const store = tx.objectStore('records');
    const req = store.getAll();
    req.onsuccess = (e) => {
      const all = e.target.result || [];
      const w = word.toLowerCase();
      const match = all.find(r => (r.word || '').toLowerCase() === w);
      console.log('[checkWord] searching:', JSON.stringify(word), '| total records:', all.length,
        '| words:', all.map(r => r.word), '| found:', !!match);
      resolve(match || null);
    };
    req.onerror = (e) => {
      console.error('[checkWord] error:', e.target.error);
      reject(e.target.error);
    };
  });
}

async function deduplicateAll() {
  const db = await openDB();
  const all = await new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readonly');
    const req = tx.objectStore('records').getAll();
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });

  const groups = {};
  for (const r of all) {
    const key = (r.word || '').toLowerCase();
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }

  let merged = 0;
  for (const [, records] of Object.entries(groups)) {
    if (records.length <= 1) continue;
    records.sort((a, b) => a.timestamp - b.timestamp);
    const primary = records[0];
    const dups = records.slice(1);

    if (!primary.contexts || primary.contexts.length === 0) {
      primary.contexts = [{ url: primary.url, title: primary.title, sentence: primary.sentence, timestamp: primary.timestamp }];
    }

    for (const dup of dups) {
      const dupContexts = dup.contexts && dup.contexts.length > 0
        ? dup.contexts
        : [{ url: dup.url, title: dup.title, sentence: dup.sentence, timestamp: dup.timestamp }];
      primary.contexts.push(...dupContexts);
      primary.encounterCount = (primary.encounterCount || 0) + (dup.encounterCount || 1);
      merged++;
    }

    primary.contexts.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    const tx2 = db.transaction('records', 'readwrite');
    const store2 = tx2.objectStore('records');
    store2.put(primary);
    for (const dup of dups) store2.delete(dup.id);
    await new Promise(r => { tx2.oncomplete = r; });
  }

  return merged;
}

async function saveRecord(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readwrite');
    tx.objectStore('records').put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

async function getRecordsByUrl() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readonly');
    const req = tx.objectStore('records').index('timestamp').openCursor(null, 'prev');
    const records = [];
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        records.push(cursor.value);
        cursor.continue();
      } else {
        // Group by URL
        const groups = {};
        for (const r of records) {
          if (!groups[r.url]) groups[r.url] = { url: r.url, title: r.title, records: [] };
          groups[r.url].records.push(r);
        }
        resolve(Object.values(groups));
      }
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

async function getAllRecords() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readonly');
    const req = tx.objectStore('records').getAll();
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function deleteRecord(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readwrite');
    tx.objectStore('records').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

// ===== AI Translation =====
async function callAI(apiBase, apiKey, apiModel, word, sentence) {
  const prompt = `Translate word "${word}" in sentence context, then translate the whole sentence to Chinese.\nReturn only valid JSON with exactly these keys: {"wordTranslation":"...","sentenceTranslation":"..."}\nDo not add markdown fences or extra explanation.\n\nSentence: ${sentence}`;

  const resp = await fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: apiModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 400
    })
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`API error ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  const content = getMessageText(data.choices?.[0]?.message?.content);
  return parseTranslation(content);
}

function getMessageText(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') {
        return part;
      }
      if (part && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    }).join('\n').trim();
  }

  return '';
}

function stripCodeFence(text) {
  return text.replace(/```json\s*|```\s*/gi, '').trim();
}

function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return '';

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      depth++;
      continue;
    }

    if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return '';
}

function pickTranslationFields(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  const wordTranslation =
    parsed.wordTranslation ||
    parsed.word_translation ||
    parsed.wordMeaning ||
    parsed.word_meaning;
  const sentenceTranslation =
    parsed.sentenceTranslation ||
    parsed.sentence_translation ||
    parsed.sentenceMeaning ||
    parsed.sentence_meaning;

  if (
    typeof wordTranslation === 'string' &&
    wordTranslation.trim() &&
    typeof sentenceTranslation === 'string' &&
    sentenceTranslation.trim()
  ) {
    return {
      wordTranslation: wordTranslation.trim(),
      sentenceTranslation: sentenceTranslation.trim()
    };
  }

  return null;
}

function summarizeContent(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function parseTranslation(content) {
  const raw = typeof content === 'string' ? content : '';
  const candidates = [
    stripCodeFence(raw),
    extractJsonObject(raw)
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const picked = pickTranslationFields(parsed);
      if (picked) {
        return picked;
      }
    } catch (e) {
      // Keep trying the next candidate.
    }
  }

  // Fallback: try to extract with regex from semi-structured text
  const wtMatch = raw.match(/"(wordTranslation|word_translation|wordMeaning|word_meaning)"\s*:\s*"([^"]+)"/);
  const stMatch = raw.match(/"(sentenceTranslation|sentence_translation|sentenceMeaning|sentence_meaning)"\s*:\s*"([^"]+)"/);
  if (wtMatch && stMatch) {
    return { wordTranslation: wtMatch[2], sentenceTranslation: stMatch[2] };
  }

  const summary = summarizeContent(raw);
  throw new Error(`Failed to parse translation response${summary ? `: ${summary}` : ''}`);
}

// ===== Message handling =====
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request, sender).then(sendResponse).catch(err => sendResponse({ error: err.message }));
  return true; // async response
});

async function handleMessage(request, sender) {
  switch (request.action) {
    case 'translate': {
      const { word, sentence } = request;
      const settings = await getSettings();

      if (!settings.apiKey) {
        return { error: '请先在设置页面配置 API Key' };
      }

      // Check cache (lazy load on first call after worker restart)
      await ensureCacheLoaded();
      const key = hashKey(word + '|||' + sentence);
      if (translationCache[key]) {
        return translationCache[key];
      }

      const result = await callAI(settings.apiBase, settings.apiKey, settings.apiModel, word, sentence);

      // Cache result
      translationCache[key] = result;
      saveCache();

      return result;
    }

    case 'saveRecord': {
      const { word, url, title, sentence, wordTranslation, sentenceTranslation } = request.record;
      console.log('[saveRecord] received word:', JSON.stringify(word));
      const existing = await checkWord(word);

      if (existing) {
        console.log('[saveRecord] UPSERT — found existing, encounterCount before:', existing.encounterCount);
        const newContext = { url, title, sentence, timestamp: Date.now() };
        existing.encounterCount = (existing.encounterCount || 0) + 1;
        if (!existing.contexts || existing.contexts.length === 0) {
          existing.contexts = [{ url: existing.url, title: existing.title, sentence: existing.sentence, timestamp: existing.timestamp }];
        }
        existing.contexts.push(newContext);
        await saveRecord(existing);
        console.log('[saveRecord] UPSERT done — encounterCount after:', existing.encounterCount);
        return { success: true, id: existing.id, isRepeat: true, encounterCount: existing.encounterCount };
      }

      console.log('[saveRecord] NEW — creating new record for:', JSON.stringify(word));
      const record = {
        word,
        wordTranslation,
        sentence,
        sentenceTranslation,
        url,
        title,
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        encounterCount: 1,
        firstEncounteredAt: Date.now(),
        contexts: [{ url, title, sentence, timestamp: Date.now() }]
      };
      await saveRecord(record);
      return { success: true, id: record.id, isRepeat: false, encounterCount: 1 };
    }

    case 'checkWord': {
      const record = await checkWord(request.word);
      return record ? { found: true, record } : { found: false };
    }

    case 'getRecordsByUrl': {
      const groups = await getRecordsByUrl();
      return { groups };
    }

    case 'getAllRecords': {
      const records = await getAllRecords();
      return { records };
    }

    case 'deleteRecord': {
      await deleteRecord(request.id);
      return { success: true };
    }

    case 'deduplicate': {
      const merged = await deduplicateAll();
      return { success: true, merged };
    }

    case 'openOptions': {
      chrome.runtime.openOptionsPage();
      return { success: true };
    }

    case 'speak': {
      const { text } = request;
      const hasChinese = /[一-鿿]/.test(text);
      const lang = hasChinese ? 'zh-CN' : 'en-US';
      const voices = await new Promise(resolve => chrome.tts.getVoices(resolve));
      let voiceName;
      if (hasChinese) {
        const zh = voices.find(v => v.lang && v.lang.startsWith('zh'));
        if (zh) voiceName = zh.voiceName;
      } else {
        for (const name of ['Samantha', 'Alex', 'Google US English', 'Microsoft Zira']) {
          const found = voices.find(v => v.voiceName && v.voiceName.includes(name));
          if (found) { voiceName = found.voiceName; break; }
        }
        if (!voiceName) {
          const en = voices.find(v => v.lang && v.lang.startsWith('en'));
          if (en) voiceName = en.voiceName;
        }
      }
      chrome.tts.speak(text, { voiceName, lang, rate: 1.0, pitch: 1.0, volume: 1.0 });
      return { success: true };
    }

    case 'getSettings': {
      return await getSettings();
    }

    default:
      return { error: 'Unknown action' };
  }
}
