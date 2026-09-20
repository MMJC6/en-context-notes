// ===== Edge online neural TTS =====
// Uses the same free read-aloud service as the Microsoft Edge browser
// (speech.platform.bing.com, keyless). English → en-US-AriaNeural (US female),
// Chinese → zh-CN-XiaoxiaoNeural. Runs in an offscreen document because MV3
// service workers have no Audio element / URL.createObjectURL.
//
// Message contract (background → here):
//   { target: 'offscreen', cmd: 'speak', text }  → responds when playback ends
//   { target: 'offscreen', cmd: 'stop' }          → responds immediately

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const WSS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const VOICES = {
  en: 'en-US-AriaNeural',
  zh: 'zh-CN-XiaoxiaoNeural'
};

// Currently active synthesis: { cancel(), finish(resp) }. At most one at a time.
let current = null;

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (!request || request.target !== 'offscreen') return;

  if (request.cmd === 'stop') {
    stopCurrent();
    sendResponse({ success: true, stopped: true });
    return;
  }

  if (request.cmd === 'speak' && request.text) {
    speakViaEdge(request.text).then(
      info => sendResponse({ success: true, ...info }),
      err => sendResponse({ error: err && err.message ? err.message : String(err) })
    );
    return true; // async response
  }
});

function pickVoice(text) {
  return /[一-鿿]/.test(text) ? VOICES.zh : VOICES.en;
}

// Best-effort debug record for diagnosing TTS issues from the service worker
// (chrome.storage may be unavailable in some offscreen contexts — never let it
// affect playback or response delivery).
function recordDebug(key, value) {
  try {
    chrome.storage.session.set({ [key]: { ...value, at: Date.now() } }).catch(() => {});
  } catch (e) { /* noop */ }
}

// Sec-MS-GEC DRM token: SHA-256 of "<windows-epoch-ticks-rounded-to-5min><token>",
// uppercase hex. Tick count comes FIRST in the hashed string.
async function secMsGec() {
  let ticks = Math.floor(Date.now() / 1000) + 11644473600; // unix → windows epoch seconds
  ticks -= ticks % 300;
  ticks *= 10000000; // seconds → 100ns intervals
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(String(ticks) + TRUSTED_CLIENT_TOKEN)
  );
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function escapeSsml(text) {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function stopCurrent() {
  if (!current) return;
  const c = current;
  current = null;
  try { c.cancel(); } catch (e) { /* already gone */ }
  c.finish({ success: true, interrupted: true });
}

async function speakViaEdge(text) {
  stopCurrent();

  const voice = pickVoice(text);
  const connId = crypto.randomUUID().replace(/-/g, '');
  const gec = await secMsGec();
  const ws = new WebSocket(
    `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${gec}`
    + `&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}&ConnectionId=${connId}`
  );
  ws.binaryType = 'arraybuffer';

  const state = {
    audio: null,
    objectUrl: null,
    cancel() {
      try { if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close(); } catch (e) { /* noop */ }
      try { if (this.audio) this.audio.pause(); } catch (e) { /* noop */ }
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    },
    finish() { /* replaced inside the promise below */ }
  };
  current = state;

  const chunks = [];
  return await new Promise((resolve, reject) => {
    state.finish = resolve;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (current === state) current = null;
      try { state.cancel(); } catch (e) { /* noop */ }
      recordDebug('ttsFail', { message: err && err.message ? err.message : String(err), voice });
      reject(err);
    };

    const timer = setTimeout(() => fail(new Error('Edge TTS timeout')), 20000);

    ws.onopen = () => {
      const date = new Date().toString();
      ws.send(
        `X-Timestamp:${date}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
        + JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' },
                outputFormat: 'audio-24khz-48kbitrate-mono-mp3'
              }
            }
          }
        })
      );
      ws.send(
        `X-RequestId:${connId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${date}Z\r\nPath:ssml\r\n\r\n`
        + `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>`
        + `<voice name='${voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeSsml(text)}</prosody>`
        + `</voice></speak>`
      );
    };

    ws.onerror = () => fail(new Error('Edge TTS websocket error (offline or endpoint rejected)'));
    ws.onclose = () => {
      // Normal only after audio finished downloading; otherwise the stream died early.
      if (!settled && !state.audio) fail(new Error('Edge TTS connection closed unexpectedly'));
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        if (ev.data.includes('Path:turn.end')) {
          clearTimeout(timer);
          try { ws.close(); } catch (e) { /* noop */ }

          const blob = new Blob(chunks, { type: 'audio/mpeg' });
          if (blob.size === 0) {
            fail(new Error('Edge TTS returned no audio'));
            return;
          }

          state.objectUrl = URL.createObjectURL(blob);
          const audio = new Audio(state.objectUrl);
          state.audio = audio;

          audio.onended = () => {
            if (settled) return;
            settled = true;
            URL.revokeObjectURL(state.objectUrl);
            if (current === state) current = null;
            resolve({ success: true, voice, bytes: blob.size });
            recordDebug('ttsLast', { voice, bytes: blob.size });
          };
          audio.onerror = () => fail(new Error('Edge TTS audio playback error'));
          audio.play().catch(e => fail(new Error('Edge TTS playback blocked: ' + e.message)));
        }
        return;
      }

      // Binary frame: 2-byte big-endian header length, headers, then audio payload
      const buf = new Uint8Array(ev.data);
      if (buf.length < 3) return;
      const headerLen = (buf[0] << 8) | buf[1];
      if (2 + headerLen > buf.length) return;
      const header = new TextDecoder().decode(buf.subarray(2, 2 + headerLen));
      if (header.includes('Path:audio')) {
        chunks.push(buf.subarray(2 + headerLen));
      }
    };
  });
}
