// Every sentence the built-in tutor says. Kind, simple Hindi; never comments on the
// child's ability. Edit freely — this is the only place tutor wording lives.

// Guardrail: fixed reply for anything that is not math learning.
export const OFF_TOPIC_HI = 'माफ़ कीजिए, मैं अभी आपकी इस समस्या में मदद नहीं कर सकता।';
export const OFF_TOPIC_EN = 'Sorry, I cannot help you with your problem right now.';

export const GREETING_HI =
  'नमस्ते! मैं आपका गणित दोस्त हूँ। यहाँ कोई भी सवाल छोटा या गलत नहीं होता। बताइए, आप किस सवाल पर अटके हैं? आप सवाल पढ़कर भी सुना सकते हैं।';
export const GREETING_EN =
  "Hello! I'm your math friend. No question is too small here. Tell me which problem you're stuck on — you can read it out to me.";

const PRAISE = ['बहुत बढ़िया!', 'शाबाश!', 'एकदम सही!', 'वाह, बिल्कुल सही!', 'बहुत अच्छे!'];
const COMFORT = [
  'कोई बात नहीं, ऐसा सबके साथ होता है।',
  'कोई बात नहीं, गलती से ही हम सीखते हैं।',
  'चिंता मत कीजिए, हम साथ में समझेंगे।',
];

const pick = (list, n) => list[n % list.length];

export const say = {
  askWhichTopic: () =>
    'अच्छा! यह सवाल किस बारे में है? जैसे जोड़, गुणा, भाग, भिन्न, या बीजगणित? आप पूरा सवाल पढ़कर भी सुना सकते हैं।',

  locate: (topic) =>
    `समझ गया, यह ${topic.name_hi} का सवाल है। चिंता मत कीजिए, हम मिलकर करेंगे। इसमें कौन-सा हिस्सा मुश्किल लगा? अगर पता नहीं, तो बस "पता नहीं" बोल दीजिए, हम शुरू से देखेंगे।`,

  startProbe: (topic, q) =>
    `ठीक है। पहले ${topic.name_hi} का एक छोटा-सा सवाल करते हैं। ${q}`,

  correctUp: (turn, from, to, q) =>
    `${pick(PRAISE, turn)} आपको ${from.name_hi} अच्छे से आता है। अब एक कदम ऊपर चलते हैं: ${to.name_hi}। ${to.explain_hi} अब बताइए, ${q}`,

  correctSolved: (turn, target) =>
    `${pick(PRAISE, turn)} अब आप ${target.name_hi} समझ गए हैं। अब अपना असली सवाल फिर से हल करके देखिए। अगर कहीं अटकें, तो मुझे बताइए, या कोई नया सवाल पूछिए।`,

  stayHint: (reason, hint, q) => {
    const opener = {
      near_miss: 'आप बहुत पास हैं! बस थोड़ा-सा फ़र्क है।',
      not_simplified: 'सही दिशा में हैं! बस इसे और छोटा करना है।',
      missing_variable: 'संख्या सही है! बस अक्षर भी साथ में बोलिए।',
      partial: 'अच्छी कोशिश! थोड़ा और सोचते हैं।',
    }[reason] || 'कोई बात नहीं, आराम से सोचिए।';
    return `${opener} एक छोटा-सा इशारा: ${hint} अब बताइए, ${q}`;
  },

  wrongDown: (turn, answer, from, to, q) =>
    `${pick(COMFORT, turn)} इसका जवाब ${spokenAnswer(answer)} है। ${from.name_hi} के लिए पहले ${to.name_hi} पक्का करना ज़रूरी है। चलिए एक कदम पीछे चलते हैं। ${q}`,

  wrongStay: (turn, answer, topic, q) =>
    `${pick(COMFORT, turn)} इसका जवाब ${spokenAnswer(answer)} है। चलिए इसे आसान तरीके से समझते हैं। ${topic.explain_hi} अब यह बताइए, ${q}`,

  stuckAgain: (topic) =>
    `कोई बात नहीं, फिर से कोशिश करते हैं। ${topic.name_hi} में कौन-सा हिस्सा मुश्किल लगा?`,

  goodbye: 'आज आपने बहुत अच्छी मेहनत की! जब भी कोई सवाल हो, फिर आइए। नमस्ते!',
};

function spokenAnswer(a) {
  if (a === 'yes') return 'हाँ';
  if (a === 'no') return 'नहीं';
  return a;
}
