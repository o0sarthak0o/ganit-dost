// Knowledge graph: a web of math topics linked by prerequisites.
// "Lower" on the tree = a prerequisite (more basic). "Higher" = a topic that builds on it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const GRAPH_PATH = path.join(here, '..', 'data', 'knowledge-graph.json');

export class KnowledgeGraph {
  constructor(data) {
    this.data = data;
    this.nodes = new Map(data.nodes.map((n) => [n.id, n]));
    // Reverse edges: which topics build on this one.
    this.dependents = new Map(data.nodes.map((n) => [n.id, []]));
    for (const n of data.nodes) {
      for (const p of n.prerequisites) this.dependents.get(p).push(n.id);
    }
    this.compiled = data.nodes.map((n) => ({
      id: n.id,
      level: n.level,
      keywords: n.keywords.map((k) => k.toLowerCase()),
      patterns: (n.patterns || []).map((p) => new RegExp(p, 'i')),
    }));
  }

  static load(file = GRAPH_PATH) {
    return new KnowledgeGraph(JSON.parse(readFileSync(file, 'utf8')));
  }

  get(id) { return this.nodes.get(id); }
  has(id) { return this.nodes.has(id); }
  prerequisites(id) { return this.get(id)?.prerequisites ?? []; }
  dependentsOf(id) { return this.dependents.get(id) ?? []; }

  /** Every topic below `id` (transitively), nearest first. */
  descendants(id) {
    const seen = new Set();
    const queue = [...this.prerequisites(id)];
    while (queue.length) {
      const cur = queue.shift();
      if (seen.has(cur)) continue;
      seen.add(cur);
      queue.push(...this.prerequisites(cur));
    }
    return [...seen];
  }

  /** Shortest chain of prerequisite steps from `fromId` down to `toId`, inclusive. Null if unrelated. */
  pathDown(fromId, toId) {
    const prev = new Map([[fromId, null]]);
    const queue = [fromId];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === toId) {
        const chain = [];
        for (let c = cur; c !== null; c = prev.get(c)) chain.unshift(c);
        return chain;
      }
      for (const p of this.prerequisites(cur)) {
        if (!prev.has(p)) { prev.set(p, cur); queue.push(p); }
      }
    }
    return null;
  }

  /**
   * Guess which topic a piece of student text is about.
   * Returns the best-scoring node id or null. Ties go to the more advanced topic,
   * because a student describing an algebra problem will also mention "+" etc.
   */
  detectTopic(text, { within } = {}) {
    const t = ` ${text.toLowerCase()} `;
    let best = null;
    for (const c of this.compiled) {
      if (within && !within.includes(c.id)) continue;
      let score = 0;
      for (const k of c.keywords) if (t.includes(k)) score += k.length > 2 ? 2 : 1;
      for (const re of c.patterns) if (re.test(t)) score += 3;
      if (score === 0) continue;
      if (!best || score > best.score || (score === best.score && c.level > best.level)) {
        best = { id: c.id, score, level: c.level };
      }
    }
    return best?.id ?? null;
  }

  /** Compact view used in prompts and the graph page. */
  summary() {
    return this.data.nodes.map((n) => ({
      id: n.id, level: n.level, name_en: n.name_en, name_hi: n.name_hi, prerequisites: n.prerequisites,
    }));
  }
}
