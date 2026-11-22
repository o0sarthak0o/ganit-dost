// Grades a student's reply to a check question on the -1 / 0 / +1 scale.
//   +1  correct  -> move one step HIGHER on the knowledge tree
//    0  partly right, a near-miss, or no clear answer -> stay on this topic, give a hint
//   -1  wrong, or "I don't know"  -> move one step LOWER (to a prerequisite)
// Works on Hindi or English text as produced by speech recognition.

const DEVANAGARI_DIGITS = '०१२३४५६७८९';

const NUMBER_WORDS = {
  // Hindi
  'शून्य': 0, 'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पाँच': 5, 'पांच': 5, 'छह': 6, 'छः': 6, 'छे': 6, 'छै': 6,
  'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10, 'ग्यारह': 11, 'बारह': 12, 'तेरह': 13, 'चौदह': 14,
  'पंद्रह': 15, 'पन्द्रह': 15, 'सोलह': 16, 'सत्रह': 17, 'अठारह': 18, 'उन्नीस': 19, 'बीस': 20,
  'इक्कीस': 21, 'बाईस': 22, 'तेईस': 23, 'चौबीस': 24, 'पच्चीस': 25, 'छब्बीस': 26, 'सत्ताईस': 27,
  'अट्ठाईस': 28, 'उनतीस': 29, 'तीस': 30, 'छत्तीस': 36, 'चालीस': 40, 'पचास': 50, 'छप्पन': 56,
  'साठ': 60, 'सत्तर': 70, 'अस्सी': 80, 'नब्बे': 90, 'सौ': 100, 'डेढ़': 1.5, 'ढाई': 2.5,
  // English
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100,
};

const TOKEN_MAP = {
  'एक्स': 'x', 'वाई': 'y', 'ज़ेड': 'z', 'जेड': 'z',
  'बटा': '/', 'by': '/', 'upon': '/', 'अनुपात': ':', 'ratio': ':',
  'माइनस': '-', 'ऋण': '-', 'minus': '-', 'negative': '-',
  'प्लस': '+', 'plus': '+',
};

const DONT_KNOW = [
  'पता नहीं', 'नहीं पता', 'नही पता', 'पता नही', 'मालूम नहीं', 'नहीं मालूम', 'नहीं आता', 'नही आता',
  'समझ नहीं', 'समझ नही', 'समझ में नहीं', 'नहीं समझ', 'नहीं समझा', 'नहीं समझी', 'याद नहीं', 'कुछ नहीं आता',
  "don't know", 'dont know', 'do not know', 'no idea', "don't understand", 'dont understand', 'not sure how',
];

const YES = ['हाँ', 'हां', 'हा', 'जी', 'yes', 'yeah', 'haan', 'han', 'है'];
const NO = ['नहीं', 'नही', 'ना', 'no', 'nahi', 'nahin'];

export function normalize(raw) {
  let s = String(raw || '').normalize('NFC').toLowerCase();
  s = s.replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)));
  s = s.replace(/[−–—]/g, '-').replace(/[×✕]/g, '*').replace(/÷/g, '/');
  s = s.replace(/(\d),(\d{3})/g, '$1$2'); // 1,000 -> 1000
  const tokens = s.split(/\s+/).filter(Boolean).map((tok) => {
    const core = tok.replace(/^[^\p{L}\p{N}\-+/:.]+|[।?!,;"'()]+$/gu, '');
    if (core in TOKEN_MAP) return TOKEN_MAP[core];
    if (core in NUMBER_WORDS) return String(NUMBER_WORDS[core]);
    return tok;
  });
  s = tokens.join(' ');
  s = s.replace(/(\d+(?:\.\d+)?) 100\b/g, (_, n) => String(Number(n) * 100)); // "दो सौ" -> 200
  return s.replace(/\s+/g, ' ').trim();
}

/** Numbers in text; a "-" counts as a sign only when it does not follow another number. */
export function extractNumbers(text) {
  const out = [];
  const re = /(?<![\d.)]\s*)-\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?/g;
  for (const m of text.matchAll(re)) out.push(Number(m[0].replace(/\s+/g, '')));
  return out;
}

function extractFractions(text) {
  const out = [];
  for (const m of text.matchAll(/(-?\d+)\s*\/\s*(\d+)/g)) {
    const d = Number(m[2]);
    if (d !== 0) out.push({ n: Number(m[1]), d, value: Number(m[1]) / d, raw: `${m[1]}/${m[2]}` });
  }
  return out;
}

function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; }
const includesAny = (s, list) => list.some((w) => s.includes(w));
const hasWord = (s, list) => s.split(/[\s,।?!.]+/).some((w) => list.includes(w));
const near = (a, b) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.1);

export function saysDontKnow(text) {
  return includesAny(normalize(text), DONT_KNOW);
}

/**
 * @param {string} answerText - what the student said
 * @param {{answer:string,type:string,q_hi?:string}} check - the question that was asked
 * @returns {{grade:-1|0|1, reason:string}}
 */
export function gradeAnswer(answerText, check) {
  const s = normalize(answerText);
  const dontKnow = includesAny(s, DONT_KNOW);
  const expected = check.answer;

  switch (check.type) {
    case 'yesno': {
      if (dontKnow) return { grade: -1, reason: 'dont_know' };
      const no = hasWord(s, NO); // "नहीं है" is a no, so "no" wins over "है"
      const yes = !no && hasWord(s, YES);
      if (!yes && !no) return { grade: 0, reason: 'unclear' };
      return (yes ? 'yes' : 'no') === expected ? { grade: 1, reason: 'correct' } : { grade: -1, reason: 'wrong' };
    }

    case 'fraction': {
      const [en, ed] = expected.split('/').map(Number);
      const target = en / ed;
      const fracs = extractFractions(s);
      if (fracs.length) {
        const last = fracs[fracs.length - 1];
        if (Math.abs(last.value - target) < 1e-9) return { grade: 1, reason: 'correct' };
        return { grade: dontKnow ? -1 : -1, reason: 'wrong' };
      }
      const nums = extractNumbers(s);
      if (nums.length && Math.abs(nums[nums.length - 1] - target) < 1e-9) return { grade: 1, reason: 'correct_decimal' };
      if (includesAny(s, ['आधा', 'half']) && Math.abs(target - 0.5) < 1e-9) return { grade: 1, reason: 'correct_word' };
      if (dontKnow) return { grade: -1, reason: 'dont_know' };
      return nums.length ? { grade: 0, reason: 'partial' } : { grade: 0, reason: 'no_answer' };
    }

    case 'ratio': {
      const [ea, eb] = expected.split(':').map(Number);
      const m = [...s.matchAll(/(\d+)\s*[:/]\s*(\d+)/g)].pop()
        || (() => { const n = extractNumbers(s); return n.length >= 2 ? [null, n.at(-2), n.at(-1)] : null; })();
      if (!m) return dontKnow ? { grade: -1, reason: 'dont_know' } : { grade: 0, reason: 'no_answer' };
      const a = Number(m[1]); const b = Number(m[2]);
      if (a === ea && b === eb) return { grade: 1, reason: 'correct' };
      if (b !== 0 && a / b === ea / eb) return { grade: 0, reason: 'not_simplified' };
      return { grade: -1, reason: 'wrong' };
    }

    case 'expression': {
      const em = expected.match(/^(-?\d*)([a-z])$/);
      const eCoef = em[1] === '' ? 1 : Number(em[1]);
      const terms = [...s.matchAll(/(-?\d*)\s*([a-z])\b/g)];
      if (terms.length) {
        const [, c, v] = terms[terms.length - 1];
        const coef = c === '' || c === '-' ? (c === '-' ? -1 : 1) : Number(c);
        if (v === em[2] && coef === eCoef) return { grade: 1, reason: 'correct' };
        return { grade: -1, reason: 'wrong' };
      }
      const nums = extractNumbers(s);
      if (nums.length && nums[nums.length - 1] === eCoef) return { grade: 0, reason: 'missing_variable' };
      if (dontKnow) return { grade: -1, reason: 'dont_know' };
      return nums.length ? { grade: -1, reason: 'wrong' } : { grade: 0, reason: 'no_answer' };
    }

    case 'number':
    default: {
      const target = Number(expected);
      const nums = extractNumbers(s);
      if (!nums.length) return dontKnow ? { grade: -1, reason: 'dont_know' } : { grade: 0, reason: 'no_answer' };
      const last = nums[nums.length - 1];
      if (last === target) return { grade: 1, reason: 'correct' };
      // Student only repeated the numbers from the question ("6 गुणा 4?") — not an attempt yet.
      const qNums = extractNumbers(normalize(check.q_hi || ''));
      if (nums.length >= 2 && nums.every((n) => qNums.includes(n))) return { grade: 0, reason: 'repeated_question' };
      if (dontKnow) return { grade: -1, reason: 'dont_know' };
      if (near(last, target)) return { grade: 0, reason: 'near_miss' };
      return { grade: -1, reason: 'wrong' };
    }
  }
}
