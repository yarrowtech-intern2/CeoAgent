import ExcelJS from "exceljs";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

const MAX_CHARS = 50_000;
const MAX_ROWS_PER_SHEET = 2000;

export interface ParsedAttachment {
  text: string;
  truncated: boolean;
}

// Anything that's already readable as-is — source code counts too, an agent
// reads that natively.
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "json", "log", "yml", "yaml", "xml",
  "html", "htm", "css", "js", "jsx", "ts", "tsx", "py", "java", "c", "cpp",
  "h", "cs", "go", "rb", "php", "sh", "sql", "ini", "toml", "env",
]);

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic"]);

function escapeCsvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function parseXlsx(buffer: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  // exceljs's Buffer type param is pinned to ArrayBuffer while @types/node's
  // Buffer is generic over ArrayBufferLike — a real Node Buffer satisfies
  // this at runtime, the mismatch is purely a type-defs version friction.
  await workbook.xlsx.load(buffer as never);
  const sections: string[] = [];
  for (const sheet of workbook.worksheets) {
    const lines: string[] = [`## Sheet: ${sheet.name}`];
    let rowCount = 0;
    sheet.eachRow((row) => {
      if (rowCount >= MAX_ROWS_PER_SHEET) return;
      const cells = (row.values as unknown[]).slice(1); // index 0 is unused by exceljs
      lines.push(cells.map(escapeCsvCell).join(","));
      rowCount++;
    });
    if (sheet.rowCount > MAX_ROWS_PER_SHEET) {
      lines.push(`... (${sheet.rowCount - MAX_ROWS_PER_SHEET} more rows omitted)`);
    }
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}

async function parsePdf(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

async function parseDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

/**
 * Converts an uploaded file straight to plain text, in memory only —
 * nothing is written to disk, and the result is meant to be inlined into an
 * agent's prompt text rather than handed over as a file path. That sidesteps
 * two problems at once: the model can't read most binary formats anyway
 * (.xlsx, .pdf, .docx are all binary containers), and file writes made on
 * behalf of a CEO-delegated subagent have a known silent-failure mode
 * outside WORKSPACE_DIR (see workspace.ts) — parsing in-memory and
 * returning plain text avoids that class of bug entirely.
 */
export async function parseAttachment(buffer: Buffer, filename: string): Promise<ParsedAttachment> {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  let raw: string;

  if (ext === "xlsx") {
    raw = await parseXlsx(buffer);
  } else if (ext === "pdf") {
    raw = await parsePdf(buffer);
  } else if (ext === "docx") {
    raw = await parseDocx(buffer);
  } else if (TEXT_EXTENSIONS.has(ext)) {
    raw = buffer.toString("utf-8");
  } else if (IMAGE_EXTENSIONS.has(ext)) {
    throw new Error(
      `Images aren't supported yet — this attaches extracted text, and there's no text to extract from a .${ext}. Image understanding would need a separate feature.`,
    );
  } else {
    throw new Error(`Unsupported file type ".${ext}" — try a document (.pdf, .docx, .txt, .md), spreadsheet (.xlsx, .csv), or code/data file.`);
  }

  const truncated = raw.length > MAX_CHARS;
  const text = truncated ? raw.slice(0, MAX_CHARS) + "\n... (truncated, file is larger than fits here)" : raw;
  return { text, truncated };
}
