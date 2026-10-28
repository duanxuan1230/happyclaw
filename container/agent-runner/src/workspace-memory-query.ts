/**
 * What a turn recalls memory by: the words its senders wrote, not the
 * envelope around them. A turn's text is one or more of the host's
 * `<messages>` blocks (src/message-prompt.ts formatMessages; a cold start
 * appends the inputs drained after it), possibly after injected history or
 * checkpoints, which escape their own text. Quoted and forwarded material is
 * someone else's text, and attributes, history and host notes are not what
 * the user is asking about.
 */

/** Only this much of a turn's own text goes to recall. */
export const MAX_MEMORY_RECALL_QUERY_CHARS = 2_000;

const MESSAGE = /<message ([^>]*)>([\s\S]*?)<\/message>/g;
const REFERENCED_BLOCK =
  /<referenced_messages>[\s\S]*?<\/referenced_messages>/g;
const HOST_BLOCKS =
  /<(channel_context|workspace_memory_snapshot|workspace_memory_index)\b[^>]*>[\s\S]*?<\/\1>/g;
/** The preamble the Runner puts before an isolated scheduled task's prompt. */
const SCHEDULED_PREAMBLE_START = '[定时任务 - ';
const SCHEDULED_PREAMBLE_LAST_LINE = '\n此外：';

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#64;/g, '@')
    .replace(/&amp;/g, '&');
}

function withoutScheduledPreamble(text: string): string {
  if (!text.startsWith(SCHEDULED_PREAMBLE_START)) return text;
  const lastLine = text.indexOf(SCHEDULED_PREAMBLE_LAST_LINE);
  const end = text.indexOf(
    '\n\n',
    lastLine >= 0 ? lastLine + SCHEDULED_PREAMBLE_LAST_LINE.length : 0,
  );
  return end >= 0 ? text.slice(end + 2) : text;
}

export function memoryRecallQuery(turnText: string): string {
  const start = turnText.indexOf('<messages>\n');
  const bodies: string[] = [];
  if (start >= 0) {
    for (const [, attributes, body] of turnText
      .slice(start)
      .matchAll(MESSAGE)) {
      // A forward's text, and the request HappyClaw adds for one, are not
      // the sender's own words.
      if (/\brelation="forwarded_material"/.test(attributes)) continue;
      if (/\bid="[^"]*:default-request"/.test(attributes)) continue;
      const own = unescapeXml(body.replace(REFERENCED_BLOCK, '')).trim();
      if (own) bodies.push(own);
    }
  }
  const text =
    start >= 0
      ? bodies.join('\n')
      : withoutScheduledPreamble(turnText).replace(HOST_BLOCKS, '').trim();
  return text.slice(0, MAX_MEMORY_RECALL_QUERY_CHARS);
}
