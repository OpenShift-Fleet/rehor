/**
 * Minimal RFC 4180 CSV reader for the `obsint-mintmaker-prs` preflight —
 * the port of the Python `csv.DictReader` the daily open-PRs report was
 * parsed with. Handles quoted fields (embedded commas, quotes, and
 * newlines), CRLF and LF row separators, and a missing final newline; blank
 * lines are skipped like `DictReader` skips empty rows.
 */

/** Parse CSV text into rows of raw field strings. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      index += 1;
      continue;
    }
    if (char === "\r") {
      index += 1;
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Parse CSV text into records keyed by the header row — the Python
 * `csv.DictReader` shape. Missing trailing columns read as empty strings.
 */
export function parseCsvRecords(text: string): Record<string, string>[] {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];
  const header = rows[0];
  const records: Record<string, string>[] = [];
  for (const row of rows.slice(1)) {
    if (row.length === 1 && row[0] === "") continue; // blank line
    const record: Record<string, string> = {};
    for (let index = 0; index < header.length; index += 1) {
      record[header[index]] = row[index] ?? "";
    }
    records.push(record);
  }
  return records;
}
