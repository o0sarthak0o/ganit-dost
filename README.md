# गणित दोस्त — Ganit Dost

A voice-first math tutor for kids who think in Hindi but study in English. The child taps one button, says which problem they're stuck on, and the tutor works **top-down** through a knowledge graph of math topics to find the missing basic. Then it walks the child back up to the original problem.

No login, no database, no memory between chats. Free for anyone to open.

## Run it

Needs Node.js 18 or newer. There are no packages to install.

```bash
cp .env.example .env     # optional
npm start                # http://localhost:3000
npm test                 # 8 tests
```

Put a Sarvam key in `.env` (`SARVAM_API_KEY=`) to use Sarvam for the tutor's brain and voice. Without it, the app still runs: the built-in tutor answers and the browser does the voice.

Open the page in **Chrome** (desktop or Android). With Sarvam, any modern browser with a microphone works. Without Sarvam, voice needs Chrome's built-in Hindi speech recognition, and other browsers can type instead. Microphones only work on `localhost` or over HTTPS, so a phone opening `http://<your-pc-ip>:3000` can type but not speak.

## How it works

With Sarvam (`SARVAM_API_KEY` set):

```
child speaks Hindi ──► browser records audio ──► POST /api/session/:id/audio
                                                     │  Sarvam speech-to-text (saaras:v4, hi-IN)
                                                     ▼
                                      tutor engine (src/tutor.js)
                                      ├─ off-topic guardrail (word list, checked first)
                                      ├─ knowledge graph (data/knowledge-graph.json)
                                      ├─ grade reply −1 / 0 / +1
                                      └─ Sarvam chat (sarvam-105b-conversations), or built-in tutor if it fails
                                                     │
reply text shows at once ◄───────────────────────────┘
child hears Hindi ◄── POST /api/tts, one call per sentence, played in order (Sarvam bulbul:v3)
```

Without Sarvam, the browser does the speech-to-text and the voice, and Claude (if `ANTHROPIC_API_KEY` is set) or the built-in tutor is the brain. The browser sends the recognised text to `POST /api/session/:id/message`.

**Conversation phases**

1. **identify**: "Which problem are you stuck on?" The problem's topic becomes the *target* (e.g. linear equations).
2. **locate**: "Which part felt hard?" If the child names a sub-skill ("भाग करना"), the tutor jumps straight to that topic.
3. **probe**: the tutor asks a short check question and grades the answer:

| Grade | Meaning | Move on the tree |
|---|---|---|
| **+1** | correct | one step **up** toward the target; at the target the problem is "solved" and the child is told to retry the original problem |
| **0** | near-miss, partly right, or no real attempt | **stay** on the topic, give a hint, ask again (after 3 tries: explain and ask a different question) |
| **−1** | wrong, or "पता नहीं" | one step **down** to an unmastered prerequisite; at the bottom, re-explain simply |

The "आज की सीढ़ी" (today's ladder) bar shows the path from the target down to the current topic. Tick **शिक्षक व्यू** to see each grade.

**Guardrail.** Anything that isn't math learning (cricket, films, other subjects) gets exactly one fixed reply: *"माफ़ कीजिए, मैं अभी आपकी इस समस्या में मदद नहीं कर सकता।"* (Sorry, I can't help you with this problem right now.)

**Kindness.** All built-in wording lives in `src/messages.js`. It never comments on the child's ability, and a test checks for judging words. The AI brain's instructions (`src/tutorPrompt.js`) have the same rule.

## Knowledge graph

`data/knowledge-graph.json` has 23 topics, from *Numbers* up to *Algebra*, plus fractions, decimals, percentage, ratio, exponents and geometry. Each topic has:

- `prerequisites`: topics one step lower. The first one listed is the usual gap.
- `name_hi`, `explain_hi`: a short Hindi explanation with an everyday example.
- `checks`: two diagnostic questions, each with an answer, a hint, and a `focus` (which prerequisite a wrong answer points to).
- `keywords` / `patterns`: used to work out the topic from what the child says.

The example chain from the spec holds: *Algebra → Expressions & operations → addition / subtraction / multiplication / division → Numbers*. See it at **/graph.html**. To add a topic, add a node to the JSON. `npm test` checks that every link exists and that there are no loops.

## Tutor "brains"

The server picks one when it starts:

1. **Sarvam**, if `SARVAM_API_KEY` is set. `src/providers/sarvam.js` calls `/v1/chat/completions` with `sarvam-105b-conversations` and a JSON schema, so every reply comes back with `on_topic`, `grade`, `topic_id`, `next_topic_id`, `reply_hi` and `reply_en`.
2. **Claude**, if only `ANTHROPIC_API_KEY` is set (`src/claude.js`).
3. **Built-in rules** otherwise. No API key is needed. It uses the graph's questions and a grader that understands Hindi number words ("चौबीस"), Devanagari digits, "3 बटा 5", "माइनस 3", "6 एक्स" and so on.

Sarvam and Claude get the same instructions from `src/tutorPrompt.js`. Whichever brain runs, the server still controls the moves through the graph, checks the off-topic word list first, and falls back to the built-in tutor if a call fails.

## Sarvam voice

When `SARVAM_API_KEY` is set, Sarvam is also the voice (`src/providers/sarvam.js`):

- **Listening:** the browser records with `MediaRecorder` (tap to start, tap again to stop, 25 s at most) and posts the audio to `/api/session/:id/audio`. Sarvam `saaras:v4` turns it into Hindi text (`mode=transcribe`, `hi-IN`), which goes to the tutor.
- **Speaking:** the reply text appears straight away. The browser then asks `POST /api/tts` for every sentence at once and plays each one as soon as it is ready, so the first sentence is heard within a second or two. A sentence that fails is spoken by the browser voice. The server caches the last 50 sentences, so the greeting and fixed replies are made only once.

Change the voice with `SARVAM_TTS_MODEL` and `SARVAM_SPEAKER` in `.env`.

`sarvam_test.py` is a one-off check that your key works: `.venv/bin/python sarvam_test.py`.

## API

The server keeps nothing between requests. The browser holds the conversation `state` (about 1 KB of JSON) and sends it back with every turn; the server checks it (`Tutor.restore`) and returns the updated one. This is what lets it run on Vercel, where each request can reach a different instance.

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/session` | none | greeting, `engine`, `voice` (`sarvam` or `browser`), `state` |
| POST | `/api/message` | `{ "text": "...", "state": {...} }` | `reply_hi`, `reply_en`, `grade`, `move`, `ladder`, `mastered`, `phase`, new `state` |
| POST | `/api/audio` | `{ "audio": "<base64>", "mime": "audio/webm", "state": {...} }` (Sarvam only) | `transcript`, `heard`, plus everything `/api/message` returns |
| POST | `/api/tts` | `{ "text": "one sentence" }` (Sarvam only) | `audio` (base64 MP3) |
| POST | `/api/end` | `{ "state": {...} }` | `reply_hi`, `summary` |
| GET | `/api/graph` | none | all topics |
| GET | `/api/health` | none | which tutor is active |

Sessions live in memory and are forgotten after 1 hour idle. There is a light per-IP rate limit: 60 messages per 5 minutes.

## Deploying to Vercel

`vercel.json` serves `public/` as static pages and routes every `/api/*` request to one function, `api/index.js`, which uses the same code as the local server (`src/app.js`). Set `SARVAM_API_KEY` in the Vercel project's Environment Variables, then redeploy. The per-IP rate limits are kept in memory, so on Vercel each instance counts on its own. Treat them as a soft limit, and use Vercel's Firewall if the public URL gets abused.
