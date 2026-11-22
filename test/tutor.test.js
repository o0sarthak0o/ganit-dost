import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeGraph } from '../src/knowledgeGraph.js';
import { Tutor } from '../src/tutor.js';
import { gradeAnswer } from '../src/grader.js';
import { OFF_TOPIC_HI } from '../src/messages.js';

const graph = KnowledgeGraph.load();
const ids = (ladder) => ladder.map((n) => n.id);

test('graph: every prerequisite exists and there are no cycles', () => {
  for (const n of graph.data.nodes) {
    for (const p of n.prerequisites) assert.ok(graph.has(p), `${n.id} -> ${p}`);
    assert.ok(!graph.descendants(n.id).includes(n.id), `cycle at ${n.id}`);
    assert.ok(n.checks.length >= 2, `${n.id} needs 2 checks`);
  }
});

test('graph: algebra -> expressions -> four operations -> numbers (the example chain)', () => {
  assert.deepEqual(graph.pathDown('algebra', 'numbers').slice(0, 2), ['algebra', 'expressions_operations']);
  for (const op of ['addition', 'subtraction', 'multiplication', 'division']) {
    assert.ok(graph.prerequisites('expressions_operations').includes(op));
  }
  assert.ok(graph.descendants('addition').includes('numbers'));
});

test('graph: topic detection from Hindi and symbols', () => {
  assert.equal(graph.detectTopic('मेरा भिन्न वाला सवाल'), 'fractions');
  assert.equal(graph.detectTopic('2x + 3x कितना होगा'), 'expressions_operations');
  assert.equal(graph.detectTopic('x + 5 = 9 हल करो'), 'linear_equations');
  assert.equal(graph.detectTopic('मुझे क्रिकेट पसंद है'), null);
});

test('grader: -1 / 0 / +1', () => {
  const q = { answer: '24', type: 'number', q_hi: '6 × 4 कितना होता है?' };
  assert.equal(gradeAnswer('चौबीस', q).grade, 1);
  assert.equal(gradeAnswer('25', q).grade, 0);
  assert.equal(gradeAnswer('पता नहीं', q).grade, -1);
  assert.equal(gradeAnswer('40', q).grade, -1);
  assert.equal(gradeAnswer('6 बटा 10', { answer: '3/5', type: 'fraction' }).grade, 1);
  assert.equal(gradeAnswer('6:3', { answer: '2:1', type: 'ratio' }).grade, 0);
});

test('tutor: off-topic gets the fixed Hindi refusal', async () => {
  const t = new Tutor(graph);
  const s = t.newSession();
  const r = await t.handle(s, 'कोई फ़िल्म का गाना सुनाओ');
  assert.equal(r.reply_hi, OFF_TOPIC_HI);
  assert.equal(r.offTopic, true);
});

test('tutor: wrong answers step down, right answers climb back up to solved', async () => {
  const t = new Tutor(graph);
  const s = t.newSession();

  let r = await t.handle(s, 'बीजगणित का सवाल समझ नहीं आ रहा');
  assert.equal(r.target.id, 'algebra');
  r = await t.handle(s, 'पता नहीं');               // locate -> first check on algebra
  assert.equal(r.phase, 'probe');

  r = await t.handle(s, 'पता नहीं');               // -1 -> down
  assert.equal(r.grade, -1);
  assert.equal(r.move, 'down');
  assert.deepEqual(ids(r.ladder), ['algebra', 'expressions_operations']);

  r = await t.handle(s, '100');                     // wrong again -> further down
  assert.equal(r.move, 'down');
  assert.equal(r.ladder.length, 3);
  const deepest = r.current.id;

  // Answer each question correctly until solved.
  for (let i = 0; i < 6 && s.phase === 'probe'; i++) {
    const check = graph.get(s.currentId).checks[s.currentCheck.idx];
    const answer = check.type === 'yesno' ? 'हाँ' : check.answer;
    r = await t.handle(s, answer);
    assert.equal(r.grade, 1);
  }
  assert.equal(r.move, 'solved');
  assert.equal(r.phase, 'identify');
  assert.ok(r.mastered.some((n) => n.id === deepest));
  assert.ok(r.mastered.some((n) => n.id === 'algebra'));
});

test('tutor: grade 0 keeps the child on the same topic with a hint', async () => {
  const t = new Tutor(graph);
  const s = t.newSession();
  await t.handle(s, 'गुणा का सवाल');
  await t.handle(s, 'पता नहीं');
  const before = s.currentId;
  const check = graph.get(before).checks[s.currentCheck.idx];
  const r = await t.handle(s, String(Number(check.answer) + 1)); // near miss
  assert.equal(r.grade, 0);
  assert.equal(r.current.id, before);
  assert.ok(r.reply_hi.includes(check.hint_hi));
});

test('tutor: replies never judge the child', async () => {
  const banned = ['कमज़ोर', 'कमजोर', 'बेवकूफ़', 'बेवकूफ', 'आसान है', 'आना चाहिए', 'धीमे'];
  const t = new Tutor(graph);
  const s = t.newSession();
  const replies = [];
  for (const msg of ['भाग का सवाल', 'पता नहीं', 'पता नहीं', '0', 'पता नहीं', '3', 'नहीं पता', '1']) {
    replies.push((await t.handle(s, msg)).reply_hi);
  }
  for (const r of replies) for (const b of banned) assert.ok(!r.includes(b), `"${b}" in: ${r}`);
});
