// ===== First install → open welcome page =====
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  }
});

// ===== Keep service worker alive (MV3 terminates idle workers after ~30s) =====
chrome.alarms.create('heartbeat', { periodInMinutes: 1 / 60 }); // every 1 second
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'heartbeat') { /* no-op, just keeps worker alive */ }
});

// ===== Translation cache =====
const translationCache = {};

async function loadCache() {
  const data = await chrome.storage.local.get('transCache');
  if (data.transCache) Object.assign(translationCache, data.transCache);
}
loadCache();

async function saveCache() {
  await chrome.storage.local.set({ transCache: translationCache });
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
  const prompt = `Translate word "${word}" in sentence context, then translate the whole sentence to Chinese.\nReturn JSON: {"wordTranslation":"...","sentenceTranslation":"..."}\n\nSentence: ${sentence}`;

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
  const content = data.choices?.[0]?.message?.content || '';
  return parseTranslation(content);
}

function parseTranslation(content) {
  // Try direct JSON parse
  try {
    const cleaned = content.replace(/```json\s*|```\s*/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    // Fallback: try to extract with regex
    const wtMatch = content.match(/"wordTranslation"\s*:\s*"([^"]+)"/);
    const stMatch = content.match(/"sentenceTranslation"\s*:\s*"([^"]+)"/);
    if (wtMatch && stMatch) {
      return { wordTranslation: wtMatch[1], sentenceTranslation: stMatch[1] };
    }
    throw new Error('Failed to parse translation response');
  }
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

      // Check cache
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

    case 'getSettings': {
      return await getSettings();
    }

    default:
      return { error: 'Unknown action' };
  }
}
