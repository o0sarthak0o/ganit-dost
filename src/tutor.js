// The tutoring engine. Keeps per-session state and walks the knowledge graph:
//   identify -> what problem is the child stuck on (sets the TARGET topic)
//   locate   -> which part of it is hard (may jump straight to a lower topic)
//   probe    -> ask a check question, grade the reply -1/0/+1, then
//                 -1: step DOWN to a prerequisite
//                  0: stay on this topic with a hint
//                 +1: step back UP towards the target; at the target -> solved
// Two "brains" share this state machine: an AI brain (Sarvam or Claude, set up in server.js)
// writes natural replies; otherwise a built-in rule-based tutor uses the graph's questions.
import { randomUUID } from 'node:crypto';
import { gradeAnswer, normalize, extractNumbers } from './grader.js';
import { OFF_TOPIC_HI, OFF_TOPIC_EN, GREETING_HI, GREETING_EN, say } from './messages.js';

const NON_MATH = [
  'क्रिकेट', 'cricket', 'फ़िल्म', 'फिल्म', 'movie', 'film', 'गाना', 'गाने', 'song', 'गेम', 'game', 'खेल',
  'विज्ञान', 'science', 'इतिहास', 'history', 'भूगोल', 'geography', 'physics', 'chemistry', 'biology',
  'रसायन', 'भौतिक', 'जीव विज्ञान', 'english', 'अंग्रेज़ी', 'अंग्रेजी', 'grammar', 'व्याकरण', 'मौसम', 'weather',
  'खबर', 'news', 'राजनीति', 'politics', 'youtube', 'यूट्यूब', 'instagram', 'चुटकुला', 'joke', 'कहानी सुनाओ',
  'story', 'हीरो', 'हीरोइन', 'actor', 'फ़ोन', 'mobile',
];
const MATH_GENERIC = [
  'गणित', 'math', 'maths', 'सवाल', 'प्रश्न', 'question', 'हल', 'solve', 'उत्तर', 'answer', 'होमवर्क',
  'homework', 'अटक', 'stuck', 'problem', 'समस्या', 'sum', 'चैप्टर', 'chapter', 'अध्याय',
];
const STUCK_AGAIN = ['फिर अटक', 'फिर से अटक', 'अभी भी', 'नहीं हुआ', 'नहीं बना', 'still stuck', 'again'];

const has = (s, list) => list.some((w) => s.includes(w));

export class Tutor {
  /** @param {import('./knowledgeGraph.js').KnowledgeGraph} graph @param {{brain?:{name:string,tutorTurn:Function}}} opts */
  constructor(graph, { brain = null } = {}) {
    this.graph = graph;
    this.brain = brain;
  }

  newSession() {
    return {
      id: randomUUID(),
      createdAt: Date.now(),
      lastActive: Date.now(),
      phase: 'identify',
      problemText: '',
      targetId: null,
      currentId: null,
      stack: [],            // topics above current, starting at the target
      mastered: new Set(),
      checkIdx: {},         // topic id -> index of the check question last asked
      currentCheck: null,   // { nodeId, idx }
      zeroStreak: 0,
      lastTargetId: null,
      turn: 0,
      history: [{ role: 'tutor', text: GREETING_HI }],
      gradeLog: [],         // [{ turn, topic, grade, reason }]
    };
  }

  greeting() { return { reply_hi: GREETING_HI, reply_en: GREETING_EN }; }

  async handle(session, rawText) {
    const text = String(rawText || '').trim().slice(0, 500);
    session.lastActive = Date.now();
    session.turn += 1;
    session.history.push({ role: 'student', text });

    let out = null;
    // Guardrail first: clearly non-math topics always get the fixed reply, whichever brain runs.
    if (this.brain && this.isOffTopic(text)) out = { ...this.offTopic(), engine: 'guardrail' };
    if (this.brain && !out) {
      try { out = await this.brainTurn(session, text); out.engine = this.brain.name; }
      catch (err) { console.warn(`[tutor] ${this.brain.name} failed, using built-in tutor:`, err.message); }
    }
    if (!out) { out = this.rulesTurn(session, text); out.engine = 'rules'; }

    session.history.push({ role: 'tutor', text: out.reply_hi });
    if (out.grade !== null && out.grade !== undefined) {
      session.gradeLog.push({ turn: session.turn, topic: out.gradedTopic, grade: out.grade, reason: out.reason });
    }
    return { ...out, ...this.view(session) };
  }

  summary(session) {
    return {
      turns: session.turn,
      mastered: [...session.mastered].map((id) => this.graph.get(id).name_hi),
      gradeLog: session.gradeLog,
    };
  }

  // ---------- shared state transitions ----------

  view(s) {
    const node = (id) => (id ? { id, name_hi: this.graph.get(id).name_hi, name_en: this.graph.get(id).name_en } : null);
    return {
      phase: s.phase,
      target: node(s.targetId),
      current: node(s.currentId),
      ladder: s.currentId ? [...s.stack, s.currentId].map(node) : [],
      mastered: [...s.mastered].map(node),
    };
  }

  setTarget(s, id, problemText) {
    s.targetId = id; s.currentId = id; s.stack = []; s.problemText = problemText;
    s.phase = 'locate'; s.zeroStreak = 0;
  }

  /** Jump from the target straight down to a sub-topic the child says is hard. */
  locateAt(s, id) {
    const chain = id && id !== s.targetId ? this.graph.pathDown(s.targetId, id) : null;
    if (chain) { s.stack = chain.slice(0, -1); s.currentId = id; }
    s.phase = 'probe';
  }

  /** Unmastered prerequisites of a topic; `prefer` (a check's focus) goes first. */
  downOptions(id, s, prefer) {
    const opts = this.graph.prerequisites(id).filter((p) => !s.mastered.has(p));
    if (prefer && opts.includes(prefer)) return [prefer, ...opts.filter((p) => p !== prefer)];
    return opts;
  }

  /** Apply a grade. Returns the move made: down / stay / up / solved. */
  applyGrade(s, grade, downChoice) {
    const from = s.currentId;
    if (grade === 1) {
      s.zeroStreak = 0;
      s.mastered.add(from);
      if (s.stack.length) { s.currentId = s.stack.pop(); return { move: 'up', from, to: s.currentId }; }
      s.lastTargetId = s.targetId;
      s.phase = 'identify'; s.currentId = null; s.targetId = null; s.currentCheck = null;
      return { move: 'solved', from, to: null };
    }
    if (grade === -1) {
      s.zeroStreak = 0;
      if (downChoice) { s.stack.push(from); s.currentId = downChoice; return { move: 'down', from, to: downChoice }; }
      return { move: 'stay', from, to: from };
    }
    s.zeroStreak += 1;
    return { move: 'stay', from, to: from };
  }

  nextCheck(s, id) {
    const node = this.graph.get(id);
    const idx = ((s.checkIdx[id] ?? -1) + 1) % node.checks.length;
    s.checkIdx[id] = idx;
    s.currentCheck = { nodeId: id, idx };
    return node.checks[idx];
  }

  isOffTopic(text) {
    const t = `${text.toLowerCase()} ${normalize(text)}`;
    return has(t, NON_MATH) && !this.graph.detectTopic(t);
  }

  offTopic() {
    return { reply_hi: OFF_TOPIC_HI, reply_en: OFF_TOPIC_EN, offTopic: true, grade: null };
  }

  // ---------- built-in rule-based tutor ----------

  rulesTurn(s, text) {
    const norm = normalize(text);
    const both = `${text.toLowerCase()} ${norm}`;
    const g = this.graph;

    if (s.phase === 'identify') {
      const topic = g.detectTopic(both);
      if (topic) {
        this.setTarget(s, topic, text);
        return { reply_hi: say.locate(g.get(topic)), grade: null };
      }
      if (s.lastTargetId && has(both, STUCK_AGAIN)) {
        this.setTarget(s, s.lastTargetId, s.problemText);
        return { reply_hi: say.stuckAgain(g.get(s.targetId)), grade: null };
      }
      if (has(both, NON_MATH)) return this.offTopic();
      if (has(both, MATH_GENERIC) || extractNumbers(norm).length || /[+\-*/=]/.test(norm)) {
        return { reply_hi: say.askWhichTopic(), grade: null };
      }
      return this.offTopic();
    }

    if (s.phase === 'locate') {
      if (this.isOffTopic(text)) return this.offTopic();
      const within = [s.targetId, ...g.descendants(s.targetId)];
      this.locateAt(s, g.detectTopic(both, { within }));
      const check = this.nextCheck(s, s.currentId);
      return { reply_hi: say.startProbe(g.get(s.currentId), check.q_hi), grade: null };
    }

    // probe
    const node = g.get(s.currentId);
    const check = node.checks[s.currentCheck?.idx ?? 0];
    const { grade, reason } = gradeAnswer(text, check);
    if (reason === 'no_answer' && this.isOffTopic(text)) return this.offTopic();

    const gradedTopic = s.currentId;
    const down = grade === -1 ? this.downOptions(s.currentId, s, check.focus)[0] : null;
    const move = this.applyGrade(s, grade, down);
    let reply;
    if (move.move === 'up') {
      reply = say.correctUp(s.turn, g.get(move.from), g.get(move.to), this.nextCheck(s, move.to).q_hi);
    } else if (move.move === 'solved') {
      reply = say.correctSolved(s.turn, g.get(move.from));
    } else if (move.move === 'down') {
      reply = say.wrongDown(s.turn, check.answer, g.get(move.from), g.get(move.to), this.nextCheck(s, move.to).q_hi);
    } else if (grade === -1) {
      reply = say.wrongStay(s.turn, check.answer, node, this.nextCheck(s, node.id).q_hi);
    } else if (s.zeroStreak >= 3) {
      s.zeroStreak = 0;
      reply = say.wrongStay(s.turn, check.answer, node, this.nextCheck(s, node.id).q_hi);
    } else {
      reply = say.stayHint(reason, check.hint_hi, check.q_hi);
    }
    return { reply_hi: reply, grade, reason, gradedTopic, move: move.move };
  }

  // ---------- AI-brain tutor (Sarvam or Claude) ----------

  async brainTurn(s, text) {
    const g = this.graph;
    const brief = (id) => {
      const n = g.get(id);
      return { id, name_en: n.name_en, name_hi: n.name_hi, explain_en: n.explain_en, example_questions: n.checks.map((c) => `${c.q_en} (answer: ${c.answer})`) };
    };
    const ctx = {
      phase: s.phase,
      original_problem: s.problemText || null,
      target_topic: s.targetId ? brief(s.targetId) : null,
      current_topic: s.currentId ? brief(s.currentId) : null,
      ladder_from_target_to_current: s.currentId ? [...s.stack, s.currentId] : [],
      mastered_topics: [...s.mastered],
    };
    if (s.phase === 'identify') ctx.all_topics = g.summary();
    if (s.phase === 'locate') ctx.subtopics_of_target = [s.targetId, ...g.descendants(s.targetId)].map((id) => ({ id, name_en: g.get(id).name_en }));
    if (s.phase === 'probe') {
      const down = this.downOptions(s.currentId, s);
      ctx.if_grade_minus_1 = down.length
        ? { move: 'down', choose_next_topic_id_from: down.map(brief) }
        : { move: 'stay', note: 'No simpler topic left: explain this one very simply with an everyday example and ask an easier question.' };
      ctx.if_grade_0 = { move: 'stay', note: 'Give a small hint and ask again.' };
      ctx.if_grade_plus_1 = s.stack.length
        ? { move: 'up', next_topic: brief(s.stack[s.stack.length - 1]), note: 'Briefly teach this higher topic, then ask one question on it.' }
        : { move: 'solved', note: 'The child is ready: guide them to try their original problem, step by step.' };
    }

    const r = await this.brain.tutorTurn({ context: ctx, history: s.history.slice(-14), studentText: text });
    if (!r.on_topic) return this.offTopic();

    if (s.phase === 'identify') {
      if (r.topic_id && g.has(r.topic_id)) this.setTarget(s, r.topic_id, text);
      return { reply_hi: r.reply_hi, reply_en: r.reply_en, grade: null };
    }
    if (s.phase === 'locate') {
      const within = [s.targetId, ...g.descendants(s.targetId)];
      this.locateAt(s, within.includes(r.topic_id) ? r.topic_id : null);
      return { reply_hi: r.reply_hi, reply_en: r.reply_en, grade: null };
    }
    const grade = [-1, 0, 1].includes(r.grade) ? r.grade : 0;
    const options = this.downOptions(s.currentId, s);
    const down = grade === -1 ? (options.includes(r.next_topic_id) ? r.next_topic_id : options[0]) : null;
    const gradedTopic = s.currentId;
    const move = this.applyGrade(s, grade, down);
    return { reply_hi: r.reply_hi, reply_en: r.reply_en, grade, reason: this.brain.name, gradedTopic, move: move.move };
  }
}
