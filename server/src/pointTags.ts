import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

// This app's own documented point-tag vocabulary lives in exactly one
// place — the spreadsheet and glossary under src/data/point-tags/ — read
// fresh from disk here rather than mirrored into a hand-maintained
// constant, so the assistant can never see a copy that's drifted out of
// sync with what a person actually edited. src/data/ already ships with
// the deployed build (see package.json's build script), so this works
// the same in dev and in production.
const DATA_DIR = fileURLToPath(new URL("./data/point-tags/", import.meta.url));
const XLSX_PATH = `${DATA_DIR}point-tags.xlsx`;
const GLOSSARY_PATH = `${DATA_DIR}point-tags-glossary.md`;

// The spreadsheet's own layout: one row holds a tag, the row right after
// it holds that tag's values (or format) — see the glossary's intro for
// why. Reads it back into the same "Tag: values" shape it's authored in.
async function readTagValueList(): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(XLSX_PATH);
  const sheet = workbook.worksheets[0];

  const lines: string[] = [];
  let pendingTag: string | null = null;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header row
    const rowType = String(row.getCell(1).value ?? "").trim();
    const content = String(row.getCell(2).value ?? "").trim();
    if (rowType === "Tag") {
      pendingTag = content;
    } else if (rowType === "Values" && pendingTag) {
      lines.push(`- ${pendingTag}: ${content}`);
      pendingTag = null;
    }
  });
  return lines.join("\n");
}

export async function getPointTagReference(): Promise<string> {
  const [tagValueList, glossary] = await Promise.all([readTagValueList(), readFile(GLOSSARY_PATH, "utf8")]);
  return [
    "Point tags — every documented header and its accepted values, straight from point-tags.xlsx:",
    tagValueList,
    "",
    "Full glossary (point-tags-glossary.md) — what each one means and how some combine:",
    glossary,
  ].join("\n");
}
