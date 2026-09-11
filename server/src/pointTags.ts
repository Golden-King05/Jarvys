import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

// This app's own documented point-tag vocabulary lives in exactly one
// place — the spreadsheet and glossary under src/data/point-tags/ — read
// fresh from disk here rather than mirrored into a hand-maintained
// constant, so neither the assistant nor the app's own tag-editing UI can
// ever see a copy that's drifted out of sync with what a person actually
// edited. src/data/ already ships with the deployed build (see
// package.json's build script), so this works the same in dev and in
// production.
const DATA_DIR = fileURLToPath(new URL("./data/point-tags/", import.meta.url));
const XLSX_PATH = `${DATA_DIR}point-tags.xlsx`;
const GLOSSARY_PATH = `${DATA_DIR}point-tags-glossary.md`;

interface TagRow {
  tag: string;
  // "Values" (a closed set to pick from, or a free-text description
  // starting with "(") or "Format" (example patterns for free-typed
  // input, not literal options) — see the glossary's intro.
  rowType: "Values" | "Format";
  content: string;
}

// The spreadsheet's own layout: one row holds a tag, the row right after
// it holds that tag's values/format. Shared by both readers below so
// there's exactly one place that understands this row-pairing.
async function readTagRows(): Promise<TagRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(XLSX_PATH);
  const sheet = workbook.worksheets[0];

  const rows: TagRow[] = [];
  let pendingTag: string | null = null;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header row
    const rowType = String(row.getCell(1).value ?? "").trim();
    const content = String(row.getCell(2).value ?? "").trim();
    if (rowType === "Tag") {
      pendingTag = content;
    } else if ((rowType === "Values" || rowType === "Format") && pendingTag) {
      rows.push({ tag: pendingTag, rowType, content });
      pendingTag = null;
    }
  });
  return rows;
}

export async function getPointTagReference(): Promise<string> {
  const [rows, glossary] = await Promise.all([readTagRows(), readFile(GLOSSARY_PATH, "utf8")]);
  const tagValueList = rows.map((r) => `- ${r.tag}: ${r.content}`).join("\n");
  return [
    "Point tags — every documented header and its accepted values, straight from point-tags.xlsx:",
    tagValueList,
    "",
    "Full glossary (point-tags-glossary.md) — what each one means and how some combine:",
    glossary,
  ].join("\n");
}

export type TagValueKind = "enum" | "format" | "freeText";

export interface TagDefinition {
  key: string;
  kind: TagValueKind;
  // Set only for "enum" — the closed set of selectable values.
  values?: string[];
  // Set only for "format"/"freeText" — a short hint to show as a
  // placeholder (a format example, or the free-text description).
  hint?: string;
}

// The structured counterpart to getPointTagReference — same source rows,
// shaped for the app's own tag-editing UI (autocomplete headers, a value
// picker for enum tags, a hint placeholder otherwise) instead of prose for
// the assistant to read.
export async function getPointTagDefinitions(): Promise<TagDefinition[]> {
  const rows = await readTagRows();
  return rows.map(({ tag, rowType, content }): TagDefinition => {
    if (rowType === "Format") {
      return { key: tag, kind: "format", hint: content.split(";").join(" or ") };
    }
    if (content.startsWith("(")) {
      return { key: tag, kind: "freeText", hint: content.replace(/^\(|\)$/g, "") };
    }
    return { key: tag, kind: "enum", values: content.split(";") };
  });
}
