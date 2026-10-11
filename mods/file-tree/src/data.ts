/** CSV/TSV and JSON preview helpers for the file tree. Pure functions: no ctx access. */

/** Rows shown in a CSV/TSV preview. The rest are counted but not rendered. */
export const TABLE_ROW_LIMIT = 200;

/**
 * RFC 4180 parser: quoted fields, doubled quotes, and line breaks inside quotes. Accepts LF, CRLF and CR.
 * A leading BOM is dropped. Blank lines are skipped.
 */
export function parseCsv(input: string, delimiter: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
      i += 1;
    } else if (ch === "\r" || ch === "\n") {
      row.push(field);
      if (!(row.length === 1 && row[0] === "")) rows.push(row);
      row = [];
      field = "";
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
  }
  return rows;
}

export interface TableData {
  /** First row of the file. */
  header: string[];
  /** Data rows, at most TABLE_ROW_LIMIT. */
  body: string[][];
  /** Number of data rows in the whole file (header excluded). */
  total: number;
  /** Number of columns (the widest row). */
  columns: number;
}

export function tableData(text: string, delimiter: string): TableData {
  const rows = parseCsv(text, delimiter);
  const header = rows[0] ?? [];
  const data = rows.slice(1);
  let columns = header.length;
  for (const row of data.slice(0, TABLE_ROW_LIMIT)) columns = Math.max(columns, row.length);
  return { header, body: data.slice(0, TABLE_ROW_LIMIT), total: data.length, columns };
}

export type JsonView = { ok: true; text: string } | { ok: false; message: string };

/** Pretty-prints JSON. On a parse error returns the message; the caller then shows the raw text. */
export function prettyJson(text: string): JsonView {
  try {
    return { ok: true, text: JSON.stringify(JSON.parse(text), null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
