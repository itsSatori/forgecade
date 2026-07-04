import Anthropic from "@anthropic-ai/sdk";

const SYSTEM_PROMPT = `You are the game generator of Forgecade, a self-hosted AI game generator.

Your job: turn a game idea into a complete, playable browser game.

Rules for the generated game:
- One single, self-contained HTML file. All CSS and JavaScript inline.
- Use Babylon.js for 3D games (load it via <script src="https://cdn.babylonjs.com/babylon.js"></script>).
  For simple 2D games, plain <canvas> without any library is fine — pick whatever fits the idea best.
- Single player (multiplayer comes later — do not attempt networking).
- The game must be immediately playable: no build step, no server calls, and no external
  assets — the Babylon.js CDN script tag is the only external resource allowed.
  Generate shapes, colors and sounds procedurally.
- Show the controls on screen (short overlay or footer).
- Include a visible score or win/lose condition so a round has a clear end.
- Keep it fun and polished within these constraints; juice (particles, screen shake, sound via WebAudio) is welcome.

Output format: respond with ONLY the HTML document, starting with <!DOCTYPE html>.
No markdown code fences, no explanation before or after.`;

const client = new Anthropic();

// Strips markdown fences in case the model wraps the document anyway.
function extractHtml(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:html)?\s*\n([\s\S]*?)\n```\s*$/);
  const html = fenced ? fenced[1] : trimmed;
  if (!/^<!doctype html>/i.test(html.trim())) {
    throw new Error("Generator returned no HTML document");
  }
  return html;
}

export async function generateGame(idea, { onProgress } = {}) {
  const stream = client.messages.stream({
    model: "claude-opus-4-8",
    max_tokens: 64000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Game idea: ${idea}`,
      },
    ],
  });

  let chars = 0;
  stream.on("text", (delta) => {
    chars += delta.length;
    onProgress?.(chars);
  });

  const message = await stream.finalMessage();
  if (message.stop_reason === "max_tokens") {
    throw new Error("Generation hit the token limit — game is incomplete");
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return extractHtml(text);
}
