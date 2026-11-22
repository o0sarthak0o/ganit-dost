// Sarvam AI: the tutor's brain (chat), its ears (speech to text) and its voice (text to speech).
// Enabled when SARVAM_API_KEY is set. Docs: https://docs.sarvam.ai
//   Chat: POST /v1/chat/completions   model sarvam-105b-conversations, JSON-schema output
//   STT:  POST /speech-to-text         model saaras:v4, mode transcribe, hi-IN  (max 30 s audio)
//   TTS:  POST /text-to-speech         model bulbul:v3, speaker ishita, mp3 out (max 2500 chars)
import { SYSTEM_PROMPT, TURN_SCHEMA, buildTurnMessage } from '../tutorPrompt.js';

const BASE = 'https://api.sarvam.ai';

// Browser recording type -> file name Sarvam can recognise.
const AUDIO_EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };

export class SarvamClient {
  constructor({
    apiKey,
    model = 'sarvam-105b-conversations',
    sttModel = 'saaras:v4',
    ttsModel = 'bulbul:v3',
    speaker = 'ishita',
    timeoutMs = 25000,
  }) {
    this.name = 'sarvam';
    this.apiKey = apiKey;
    Object.assign(this, { model, sttModel, ttsModel, speaker, timeoutMs });
  }

  async post(path, body, headers = {}) {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'api-subscription-key': this.apiKey, ...headers },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Sarvam ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  /** Brain: same contract as ClaudeClient.tutorTurn. */
  async tutorTurn(turn) {
    const data = await this.post('/v1/chat/completions', JSON.stringify({
      model: this.model,
      max_tokens: 800,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildTurnMessage(turn) },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'tutor_turn', schema: TURN_SCHEMA, strict: true } },
    }), { 'content-type': 'application/json' });
    const content = data.choices?.[0]?.message?.content;
    let out;
    try { out = JSON.parse(content); } catch { throw new Error('Sarvam returned invalid JSON'); }
    if (!out?.reply_hi) throw new Error('Sarvam returned no reply_hi');
    return out;
  }

  /** Ears: Hindi speech (a browser recording) -> Hindi text. */
  async speechToText(audio, mimeType = 'audio/webm') {
    const type = String(mimeType).split(';')[0].trim().toLowerCase();
    const form = new FormData();
    form.append('file', new Blob([audio], { type }), `speech.${AUDIO_EXT[type] || 'webm'}`);
    form.append('model', this.sttModel);
    form.append('mode', 'transcribe');
    form.append('language_code', 'hi-IN');
    const data = await this.post('/speech-to-text', form);
    return (data.transcript || '').trim();
  }

  /** Voice: Hindi text -> base64 MP3. */
  async textToSpeech(text) {
    const data = await this.post('/text-to-speech', JSON.stringify({
      text: String(text).slice(0, 2500),
      language_code: 'hi-IN',
      model: this.ttsModel,
      speaker: this.speaker,
      output_audio_codec: 'mp3',
    }), { 'content-type': 'application/json' });
    if (!data.audios?.[0]) throw new Error('Sarvam returned no audio');
    return data.audios[0];
  }
}
