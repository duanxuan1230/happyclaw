/**
 * A rendered Markdown table as plain cells, for copying into a spreadsheet
 * (tab-separated) or saving as CSV.
 */

/** A cell's text with `<br>` as a line break and whitespace runs collapsed. */
function cellText(cell: Element): string {
  let text = '';
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) text += child.textContent ?? '';
      else if (child instanceof Element) {
        if (child.tagName === 'BR') text += '\n';
        else walk(child);
      }
    }
  };
  walk(cell);
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .trim();
}

/** Header and body rows, each cell as text. */
export function readTable(table: HTMLTableElement): string[][] {
  return Array.from(table.querySelectorAll('tr'), (row) =>
    Array.from(row.querySelectorAll('th, td'), cellText),
  ).filter((row) => row.length > 0);
}

/**
 * Tab-separated rows: Excel, Numbers, Google Sheets and Feishu sheets split
 * a paste of these into cells. A line break in a cell would start a new row
 * there, so it becomes a space.
 */
export function toTsv(rows: readonly (readonly string[])[]): string {
  return rows
    .map((row) => row.map((cell) => cell.replace(/[\t\n]+/g, ' ')).join('\t'))
    .join('\n');
}

/**
 * CSV (RFC 4180, CRLF) with a byte-order mark so Excel reads it as UTF-8.
 * A cell that a spreadsheet would run as a formula (`=…`, `@…`, `+`/`-`
 * not followed by a number) is kept as text with a leading apostrophe.
 */
export function toCsv(rows: readonly (readonly string[])[]): string {
  const field = (cell: string) => {
    const safe = /^(=|@|[+-](?![\d.]))/.test(cell) ? `'${cell}` : cell;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return '﻿' + rows.map((row) => row.map(field).join(',')).join('\r\n');
}

/** `表格-20261030-1542.csv`, in local time. */
export function csvFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `表格-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.csv`;
}
