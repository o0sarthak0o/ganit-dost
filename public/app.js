// Ganit Dost — browser client.
// Two voice modes, chosen by the server when a chat starts (data.voice):
//   'sarvam'  — record the child with MediaRecorder, send the audio to the server, and play
//               the Hindi MP3 that comes back (Sarvam speech-to-text and text-to-speech).
//   'browser' — the browser's own Web Speech API (Chrome: Hindi recognition + Hindi voice).

const $ = (id) => document.getElementById(id);
const els = {
  startView: $('startView'), chatView: $('chatView'), endView: $('endView'),
  startBtn: $('startBtn'), endBtn: $('endBtn'), restartBtn: $('restartBtn'),
  messages: $('messages'), ladder: $('ladder'), status: $('status'), voiceNote: $('voiceNote'),
  micBtn: $('micBtn'), micLabel: $('micLabel'), textForm: $('textForm'), textInput: $('textInput'),
  teacherToggle: $('teacherToggle'), endLine: $('endLine'), masteredBox: $('masteredBox'), masteredList: $('masteredList'),
};

let state = null; // the conversation; the server is stateless, so it travels with every request
let busy = false;
let voiceMode = 'browser';

const splitSentences = (text) => text.match(/[^।?!]+[।?!]?/g)?.map((p) => p.trim()).filter(Boolean) || [text];

// ---------------- voice (Sarvam audio, or the browser's own speech) ----------------
const voice = (() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const synth = window.speechSynthesis;
  let hindiVoice = null;
  let rec = null;
  let player = null; // <audio> playing a Sarvam reply

  function pickVoice() {
    if (!synth) return;
    const vs = synth.getVoices();
    hindiVoice = vs.find((v) => v.lang === 'hi-IN' && /google/i.test(v.name))
      || vs.find((v) => v.lang?.toLowerCase().startsWith('hi')) || null;
  }
  if (synth) { pickVoice(); synth.addEventListener?.('voiceschanged', pickVoice); }

  let speakRun = 0;
  const speechCache = new Map(); // sentence -> Promise<base64 MP3 | null>, so replay is instant
  function fetchSpeech(sentence) {
    if (!speechCache.has(sentence)) {
      speechCache.set(sentence, api('/api/tts', { text: sentence }).then((d) => d.audio || null).catch(() => {
        speechCache.delete(sentence);
        return null;
      }));
    }
    return speechCache.get(sentence);
  }
  function playOnce(b64) {
    return new Promise((resolve, reject) => {
      player = new Audio(`data:audio/mpeg;base64,${b64}`);
      player.onended = () => { player = null; resolve(); };
      player.onerror = () => { player = null; reject(new Error('playback')); };
      player.play().catch(reject);
    });
  }
  function sayOnce(sentence) {
    return new Promise((resolve) => {
      if (!synth) return resolve();
      const u = new SpeechSynthesisUtterance(sentence);
      u.lang = 'hi-IN';
      if (hindiVoice) u.voice = hindiVoice;
      u.onend = resolve; u.onerror = resolve;
      synth.speak(u);
    });
  }

  return {
    canListen: Boolean(SR),
    canSpeak: () => Boolean(synth),
    hasHindiVoice: () => Boolean(hindiVoice),

    /**
     * Speak with Sarvam's voice. Every sentence is requested at once, and each one plays as
     * soon as it (and the ones before it) are ready, so the child hears the first sentence quickly.
     * A sentence whose audio fails is spoken by the browser voice instead.
     */
    async sarvamSpeak(text, { onStart, onEnd } = {}) {
      this.stopSpeaking();
      const run = ++speakRun;
      const parts = splitSentences(text);
      const audios = parts.map(fetchSpeech);
      for (let i = 0; i < parts.length; i++) {
        const b64 = await audios[i];
        if (run !== speakRun) return; // stopped or replaced by newer speech
        if (i === 0) onStart?.();
        if (b64) await playOnce(b64).catch(() => sayOnce(parts[i]));
        else await sayOnce(parts[i]);
        if (run !== speakRun) return;
      }
      onEnd?.();
    },

    /** Speak Hindi text. Long text is split into sentences (Chrome cuts off long utterances). */
    speak(text, { onStart, onEnd } = {}) {
      if (!synth) { onEnd?.(); return; }
      this.stopSpeaking();
      const parts = splitSentences(text);
      parts.forEach((part, i) => {
        const u = new SpeechSynthesisUtterance(part);
        u.lang = 'hi-IN';
        if (hindiVoice) u.voice = hindiVoice;
        u.rate = 0.92;
        if (i === 0) u.onstart = () => onStart?.();
        if (i === parts.length - 1) { u.onend = () => onEnd?.(); u.onerror = () => onEnd?.(); }
        synth.speak(u);
      });
    },
    stopSpeaking() {
      speakRun += 1;
      synth?.cancel();
      if (player) { player.pause(); player = null; }
    },

    /** Listen once in Hindi. Calls onText(finalText) or onError(code). */
    listen({ onInterim, onText, onError, onEnd }) {
      if (!SR) return onError?.('unsupported');
      this.stopSpeaking();
      rec = new SR();
      rec.lang = 'hi-IN';
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;
      let finalText = '';
      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
        }
        onInterim?.(finalText + interim);
      };
      rec.onerror = (e) => onError?.(e.error);
      rec.onend = () => { rec = null; finalText.trim() ? onText?.(finalText.trim()) : onEnd?.(); };
      rec.start();
    },
    stopListening() { rec?.stop(); },
    isListening: () => Boolean(rec),
  };
})();

// ---------------- recorder (Sarvam mode) ----------------
const recorder = (() => {
  const supported = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  const MAX_MS = 25000; // Sarvam speech-to-text takes up to 30 s per request
  let mr = null;
  let timer = null;

  return {
    supported,
    isRecording: () => Boolean(mr),

    /** Record until stop() (or 25 s). Calls onAudio(blob) or onError(code). */
    async start({ onAudio, onError }) {
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch (e) { onError?.(e.name === 'NotAllowedError' ? 'not-allowed' : 'unsupported'); return false; }
      const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
        .find((t) => MediaRecorder.isTypeSupported?.(t));
      mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const chunks = [];
      mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      mr.onstop = () => {
        clearTimeout(timer);
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: mr.mimeType || type || 'audio/webm' });
        mr = null;
        blob.size ? onAudio?.(blob) : onError?.('no-speech');
      };
      mr.start();
      timer = setTimeout(() => this.stop(), MAX_MS);
      return true;
    },
    stop() { if (mr?.state === 'recording') mr.stop(); },
  };
})();

const canListen = () => (voiceMode === 'sarvam' ? recorder.supported : voice.canListen);

// ---------------- API ----------------
/** Recording -> base64 (without the "data:...;base64," prefix). */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'request_failed'), { status: res.status });
  return data;
}

// ---------------- UI helpers ----------------
function show(view) {
  for (const v of [els.startView, els.chatView, els.endView]) v.hidden = v !== view;
  els.endBtn.hidden = view !== els.chatView;
}

function setStatus(text) { els.status.textContent = text || ''; }

function addMessage(role, text, extra = {}) {
  const div = document.createElement('div');
  div.className = `msg ${role}${extra.offTopic ? ' offtopic' : ''}`;
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = role === 'tutor' ? 'गणित दोस्त' : 'आप';
  const body = document.createElement('div');
  body.textContent = text;
  div.append(who, body);

  if (role === 'tutor') {
    const actions = document.createElement('div');
    actions.className = 'actions';
    const replay = document.createElement('button');
    replay.className = 'replay';
    replay.type = 'button';
    replay.textContent = '🔊 फिर से सुनें';
    replay.addEventListener('click', () => speak(text));
    actions.append(replay);
    if (extra.grade !== undefined && extra.grade !== null) {
      const g = document.createElement('span');
      g.className = `grade ${extra.grade === 1 ? 'g1' : extra.grade === 0 ? 'g0' : 'gm1'}`;
      g.textContent = `grade ${extra.grade > 0 ? '+1' : extra.grade} · ${extra.move || ''} · ${extra.engine || ''}`;
      g.title = extra.reply_en || '';
      actions.append(g);
    }
    div.append(actions);
  }
  els.messages.append(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  return div;
}

function addTyping() {
  const div = document.createElement('div');
  div.className = 'msg tutor';
  div.innerHTML = '<span class="typing" aria-label="सोच रहा हूँ"><i></i><i></i><i></i></span>';
  els.messages.append(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  return div;
}

function renderLadder(ladder) {
  els.ladder.innerHTML = '';
  if (!ladder?.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'अपना सवाल बताइए';
    els.ladder.append(li);
    return;
  }
  ladder.forEach((step, i) => {
    const li = document.createElement('li');
    const chip = document.createElement('span');
    chip.className = `chip${i === ladder.length - 1 ? ' now' : ''}`;
    chip.textContent = step.name_hi;
    li.append(chip);
    els.ladder.append(li);
  });
  els.ladder.parentElement.scrollLeft = els.ladder.parentElement.scrollWidth;
}

function speak(text) {
  const handlers = {
    onStart: () => setStatus('🔊 बोल रहा हूँ…'),
    onEnd: () => setStatus(''),
  };
  if (voiceMode === 'sarvam') voice.sarvamSpeak(text, handlers);
  else voice.speak(text, handlers);
}

function setBusy(b) {
  busy = b;
  els.micBtn.disabled = b || !canListen();
  els.textForm.querySelector('button').disabled = b;
}

// ---------------- flow ----------------
async function startChat() {
  els.startBtn.disabled = true;
  try {
    const data = await api('/api/session');
    state = data.state;
    voiceMode = data.voice === 'sarvam' ? 'sarvam' : 'browser';
    els.messages.innerHTML = '';
    renderLadder([]);
    show(els.chatView);
    showVoiceNotes();
    addMessage('tutor', data.reply_hi);
    speak(data.reply_hi); // allowed: we are inside the click handler
  } catch {
    alertInline('सर्वर से जुड़ नहीं पाए। थोड़ी देर बाद फिर कोशिश कीजिए।');
  } finally {
    els.startBtn.disabled = false;
  }
}

function showReply(data) {
  state = data.state;
  addMessage('tutor', data.reply_hi, data);
  renderLadder(data.ladder);
  speak(data.reply_hi);
}

async function send(text) {
  text = text.trim();
  if (!text || busy || !state) return;
  addMessage('student', text);
  setBusy(true);
  setStatus('🤔 सोच रहा हूँ…');
  const typing = addTyping();
  try {
    const data = await api('/api/message', { text, state });
    typing.remove();
    showReply(data);
  } catch (err) {
    typing.remove();
    showError(err);
  } finally {
    setBusy(false);
  }
}

/** Sarvam mode: send the recording; the server returns what it heard plus the reply. */
async function sendAudio(blob) {
  if (busy || !state) return;
  setBusy(true);
  setStatus('👂 सुनकर समझ रहा हूँ…');
  const typing = addTyping();
  try {
    const data = await api('/api/audio', { audio: await blobToBase64(blob), mime: blob.type, state });
    typing.remove();
    if (!data.heard) { setStatus('कुछ सुनाई नहीं दिया। फिर से दबाकर बोलिए।'); return; }
    typing.before(addMessage('student', data.transcript));
    showReply(data);
  } catch (err) {
    typing.remove();
    showError(err);
  } finally {
    setBusy(false);
  }
}

function showError(err) {
  if (err.message === 'bad_state') {
    addMessage('tutor', 'यह बातचीत पुरानी हो गई। चलिए नई बातचीत शुरू करते हैं।');
    state = null;
    setTimeout(() => show(els.startView), 2500);
  } else if (err.status === 429) {
    addMessage('tutor', 'थोड़ा रुकिए, एक मिनट बाद फिर बात करते हैं।');
  } else {
    addMessage('tutor', 'माफ़ कीजिए, कुछ गड़बड़ हो गई। फिर से बोलिए।');
  }
  setStatus('');
}

async function endChat() {
  voice.stopSpeaking();
  voice.stopListening();
  const last = state;
  state = null;
  let data = null;
  try { data = last ? await api('/api/end', { state: last }) : null; } catch { /* show the default goodbye */ }
  els.endLine.textContent = data?.reply_hi || 'जब भी कोई सवाल हो, फिर आइए। नमस्ते!';
  const mastered = data?.summary?.mastered || [];
  els.masteredList.innerHTML = '';
  for (const name of mastered) {
    const li = document.createElement('li');
    li.textContent = name;
    els.masteredList.append(li);
  }
  els.masteredBox.hidden = mastered.length === 0;
  show(els.endView);
  if (data?.reply_hi) speak(data.reply_hi);
}

const MIC_ERRORS = {
  'not-allowed': 'माइक की अनुमति नहीं मिली। ब्राउज़र में माइक चालू कीजिए, या लिखकर भेजिए।',
  'no-speech': 'कुछ सुनाई नहीं दिया। फिर से दबाकर बोलिए।',
  network: 'इंटरनेट धीमा है। फिर कोशिश कीजिए, या लिखकर भेजिए।',
  unsupported: 'इस ब्राउज़र में बोलकर बात नहीं हो सकती। लिखकर भेजिए।',
};

function toggleMic() {
  if (busy) return;
  if (voice.isListening()) { voice.stopListening(); return; }
  if (recorder.isRecording()) { recorder.stop(); return; }
  els.micBtn.classList.add('listening');
  els.micLabel.textContent = 'सुन रहा हूँ… रोकने के लिए दबाएँ';
  setStatus('👂 बोलिए… बोलकर फिर से दबाइए');
  const done = () => {
    els.micBtn.classList.remove('listening');
    els.micLabel.textContent = 'दबाकर बोलिए';
  };

  if (voiceMode === 'sarvam') {
    voice.stopSpeaking();
    recorder.start({
      onAudio: (blob) => { done(); sendAudio(blob); },
      onError: (code) => { done(); setStatus(MIC_ERRORS[code] || 'माइक में दिक्कत आई। फिर से कोशिश कीजिए।'); },
    });
    return;
  }

  setStatus('👂 बोलिए…');
  voice.listen({
    onInterim: (t) => setStatus(`👂 ${t}`),
    onText: (t) => { done(); setStatus(''); send(t); },
    onEnd: () => { done(); setStatus('कुछ सुनाई नहीं दिया। फिर से दबाकर बोलिए।'); },
    onError: (code) => {
      done();
      setStatus(MIC_ERRORS[code] || 'माइक में दिक्कत आई। फिर से कोशिश कीजिए।');
    },
  });
}

function showVoiceNotes() {
  const notes = [];
  els.micBtn.disabled = !canListen();
  if (!canListen()) {
    notes.push(voiceMode === 'sarvam'
      ? 'इस ब्राउज़र में माइक नहीं चल सकता। नीचे लिखकर भेजिए।'
      : 'इस ब्राउज़र में बोलकर बात नहीं हो सकती। Chrome में खोलिए, या नीचे लिखकर भेजिए।');
  }
  // Voices load late on some phones; check again shortly. (Sarvam mode brings its own voice.)
  setTimeout(() => {
    if (voiceMode === 'browser' && voice.canSpeak() && !voice.hasHindiVoice()) {
      notes.push('इस फ़ोन में हिंदी आवाज़ नहीं मिली, इसलिए आवाज़ अलग लग सकती है।');
    }
    els.voiceNote.textContent = notes.join(' ');
    els.voiceNote.hidden = notes.length === 0;
  }, 800);
}

function alertInline(msg) {
  const p = document.createElement('p');
  p.className = 'note';
  p.textContent = msg;
  els.startView.append(p);
  setTimeout(() => p.remove(), 5000);
}

// ---------------- wire up ----------------
els.startBtn.addEventListener('click', startChat);
els.restartBtn.addEventListener('click', startChat);
els.endBtn.addEventListener('click', endChat);
els.micBtn.addEventListener('click', toggleMic);
els.textForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const t = els.textInput.value;
  els.textInput.value = '';
  send(t);
});
els.teacherToggle.addEventListener('change', () => document.body.classList.toggle('teacher', els.teacherToggle.checked));
