// Optional brain: Claude writes the tutor's replies and grades the child's answers.
// Used only when ANTHROPIC_API_KEY is set and SARVAM_API_KEY is not. Uses the Messages
// API with a forced tool call so the reply always comes back as structured JSON.
import { SYSTEM_PROMPT, TURN_SCHEMA, buildTurnMessage } from './tutorPrompt.js';

const TOOL = {
  name: 'tutor_turn',
  description: 'Return the graded result and the next thing the tutor says.',
  input_schema: TURN_SCHEMA,
};

export class ClaudeClient {
  constructor({ apiKey, model = 'claude-sonnet-5-5', timeoutMs = 25000 }) {
    this.name = 'claude';
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async tutorTurn(turn) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 800,
        system: SYSTEM_PROMPT,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: TOOL.name },
        messages: [{ role: 'user', content: buildTurnMessage(turn) }],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const call = data.content?.find((c) => c.type === 'tool_use');
    if (!call?.input?.reply_hi) throw new Error('Claude returned no tutor_turn');
    return call.input;
  }
}
