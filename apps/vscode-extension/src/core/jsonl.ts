import * as fs from 'node:fs';
import type { Store } from './store';

const CHUNK = 4 * 1024 * 1024;

export interface TailResult {
  linesRead: number;
  bytesRead: number;
  reset: boolean;
}

/**
 * Incremental JSONL reader. Keeps a byte cursor per file in the store and only reads what was
 * appended since last time — it never re-reads a file from the start unless it shrank (rotation).
 * A trailing line without '\n' is left for the next pass (the writer may be mid-line).
 *
 * `prefilter` runs on the raw line before JSON.parse: lines that cannot matter (prompts, tool
 * output) are skipped without being parsed, and their content is never retained.
 */
export async function tailJsonl(
  store: Store,
  file: string,
  prefilter: (line: string) => boolean,
  onRecord: (rec: Record<string, unknown>) => void,
): Promise<TailResult> {
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(file);
  } catch {
    return { linesRead: 0, bytesRead: 0, reset: false };
  }
  const cur = store.getCursor(file);
  let offset = cur?.offset ?? 0;
  let reset = false;
  if (cur && st.size < cur.offset) {
    offset = 0;
    reset = true;
  }
  if (cur && st.size === cur.size && st.mtimeMs === cur.mtimeMs && !reset) {
    return { linesRead: 0, bytesRead: 0, reset: false };
  }
  if (st.size <= offset) {
    store.setCursor(file, offset, st.size, st.mtimeMs);
    return { linesRead: 0, bytesRead: 0, reset };
  }

  const fh = await fs.promises.open(file, 'r');
  let lines = 0;
  let bytes = 0;
  let carry = Buffer.alloc(0);
  let consumed = offset;
  try {
    let pos = offset;
    while (pos < st.size) {
      const len = Math.min(CHUNK, st.size - pos);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      bytes += bytesRead;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      let start = 0;
      let nl = data.indexOf(0x0a, start);
      // One transaction per chunk: thousands of upserts commit once instead of once each.
      store.db.exec('BEGIN IMMEDIATE');
      try {
        while (nl !== -1) {
          const line = data.subarray(start, nl).toString('utf8');
          consumed += nl - start + 1;
          start = nl + 1;
          if (line.trim() && prefilter(line)) {
            try {
              const rec = JSON.parse(line) as unknown;
              if (rec && typeof rec === 'object') {
                onRecord(rec as Record<string, unknown>);
                lines++;
              }
            } catch {
              /* malformed line: skip, never crash the collector */
            }
          }
          nl = data.indexOf(0x0a, start);
        }
        store.db.exec('COMMIT');
      } catch (e) {
        store.db.exec('ROLLBACK');
        throw e;
      }
      carry = Buffer.from(data.subarray(start));
      // Let the extension host breathe between chunks.
      await new Promise((r) => setImmediate(r));
    }
  } finally {
    await fh.close();
  }
  store.setCursor(file, consumed, st.size, st.mtimeMs);
  return { linesRead: lines, bytesRead: bytes, reset };
}
