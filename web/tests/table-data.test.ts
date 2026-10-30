// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import {
  csvFileName,
  readTable,
  toCsv,
  toTsv,
} from '../src/lib/markdown/table-data';

const table = (html: string) => {
  const host = document.createElement('div');
  host.innerHTML = `<table>${html}</table>`;
  return host.querySelector('table')!;
};

describe('table data', () => {
  it('reads header and body cells as text, line breaks kept', () => {
    expect(
      readTable(
        table(
          '<thead><tr><th>方案</th><th>说明</th></tr></thead>' +
            '<tbody><tr><td><strong>窄</strong> selector</td><td>一行<br>两行</td></tr>' +
            '<tr><td>  拆分   store </td><td><a href="#">链接</a></td></tr></tbody>',
        ),
      ),
    ).toEqual([
      ['方案', '说明'],
      ['窄 selector', '一行\n两行'],
      ['拆分 store', '链接'],
    ]);
  });

  it('copies as tab-separated rows, one line per row', () => {
    expect(
      toTsv([
        ['a', 'b\tc'],
        ['一行\n两行', '2'],
      ]),
    ).toBe('a\tb c\n一行 两行\t2');
  });

  it('saves CSV for Excel: BOM, CRLF, quoting, and no formulas', () => {
    expect(
      toCsv([
        ['名称', '金额'],
        ['甲,乙', '-12.5'],
        ['说 "好"', '=SUM(A1)'],
        ['一行\n两行', '+86 138'],
        ['@user', '-x'],
      ]),
    ).toBe(
      '﻿名称,金额\r\n"甲,乙",-12.5\r\n"说 ""好""",\'=SUM(A1)\r\n"一行\n两行",+86 138\r\n\'@user,\'-x',
    );
  });

  it('names the file by the local time', () => {
    expect(csvFileName(new Date(2026, 9, 30, 9, 5))).toBe(
      '表格-20261030-0905.csv',
    );
  });
});
