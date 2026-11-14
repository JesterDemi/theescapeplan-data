// Small helper for the Claude API, used by the data jobs.
// Needs the ANTHROPIC_API_KEY secret in the repo (Settings > Secrets and variables > Actions).
// With no key, every call returns null and the jobs keep working without the AI extras.

const KEY = process.env.ANTHROPIC_API_KEY;
export const MODELS = {
  check: process.env.CLAUDE_CHECK_MODEL || 'claude-sonnet-5-5', // careful reading: visa guide vs official page
  quick: process.env.CLAUDE_QUICK_MODEL || 'claude-haiku-5-5', // one-line summaries
};

export const hasClaude = () => !!KEY;

/** One request, plain text back. Returns null on any failure so a bad call never breaks a build. */
export async function askClaude({ model, system, prompt, maxTokens = 800 }) {
  if (!KEY) return null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(120000),
      });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, attempt * 15000));
        continue;
      }
      if (!res.ok) {
        console.error(`Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
        return null;
      }
      const data = await res.json();
      return (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim() || null;
    } catch (e) {
      if (attempt === 3) console.error(`Claude API failed: ${e.message}`);
    }
  }
  return null;
}

/** Pull the first JSON object out of a reply. */
export function parseJSON(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/** Readable text from an HTML page: no scripts, styles, nav or tags. */
export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&#\d+;|&\w+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}
