import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { resolve, extname, basename, join } from "node:path";
import { createHash } from "node:crypto";
import type { ToolDefinition } from "../providers/types.js";

interface ToolResult {
  success: boolean;
  output: string;
}

// ---------------------------------------------------------------------------
// Lazy-load exceljs (optional dependency, same pattern as sharp)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let excelJsMod: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getExcelJs(): Promise<any> {
  if (!excelJsMod) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = await (Function('return import("exceljs")')() as Promise<any>);
      excelJsMod = mod.default ?? mod;
    } catch {
      throw new Error("exceljs is not installed. Run: pnpm add exceljs");
    }
  }
  return excelJsMod;
}

// ---------------------------------------------------------------------------
// Inventory persistence
// ---------------------------------------------------------------------------

const MEMORY_DIR = resolve("memory");
const INVENTORY_FILE = join(MEMORY_DIR, "inventory.json");

interface InventoryItem {
  id: string;
  title: string;
  artist: string;
  category: string;
  image_path: string | null;
  source: "csv" | "scan" | "spreadsheet" | "manual";
  source_file: string;
  metadata: Record<string, string>;
  indexed_at: string;
}

interface InventoryIndex {
  version: number;
  items: InventoryItem[];
  last_indexed: string;
  sources: Array<{ type: string; path: string; item_count: number; indexed_at: string }>;
}

async function loadInventory(): Promise<InventoryIndex> {
  try {
    const raw = await readFile(INVENTORY_FILE, "utf-8");
    return JSON.parse(raw) as InventoryIndex;
  } catch {
    return { version: 1, items: [], last_indexed: "", sources: [] };
  }
}

async function saveInventory(data: InventoryIndex): Promise<void> {
  await mkdir(MEMORY_DIR, { recursive: true });
  await writeFile(INVENTORY_FILE, JSON.stringify(data, null, 2), "utf-8");
}

function itemId(sourceFile: string, key: string): string {
  return createHash("sha256").update(`${sourceFile}:${key}`).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Inline CSV parser (no external dependency)
// ---------------------------------------------------------------------------

function parseCSV(raw: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  // Strip BOM
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(field.trim());
        field = "";
      } else if (ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) {
        if (ch === "\r") i++;
        row.push(field.trim());
        field = "";
        if (row.length > 0) rows.push(row);
        row = [];
      } else if (ch === "\r") {
        // bare \r (old Mac line ending)
        row.push(field.trim());
        field = "";
        if (row.length > 0) rows.push(row);
        row = [];
      } else {
        field += ch;
      }
    }
  }

  // Last field/row
  row.push(field.trim());
  if (row.some((f) => f.length > 0)) rows.push(row);

  return rows;
}

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff"]);

function isImageExt(ext: string): boolean {
  return IMAGE_EXTS.has(ext.toLowerCase());
}

function titleFromFilename(filename: string): string {
  const name = basename(filename, extname(filename));
  return name
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const inventoryToolDefinitions: ToolDefinition[] = [
  {
    name: "show_image",
    description:
      "Display an image inline in the chat. Use this when the user asks to see, show, or look at an image. " +
      "The image will appear as a thumbnail in the dashboard chat. The image must exist as a local file.",
    input_schema: {
      type: "object" as const,
      properties: {
        image_path: {
          type: "string",
          description: "Absolute path to the image file to display",
        },
        caption: {
          type: "string",
          description: "Optional caption to describe the image",
        },
      },
      required: ["image_path"],
    },
  },
  {
    name: "read_csv",
    description:
      "Read and parse a CSV (comma-separated values) file. Returns the contents as a formatted table. " +
      "Handles quoted fields, escaped quotes, and various line endings. " +
      "Useful for inventory lists, database exports, product catalogs.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path to the CSV file",
        },
        max_rows: {
          type: "number",
          description: "Maximum data rows to return (default: 50, use 0 for all)",
        },
        columns: {
          type: "array",
          items: { type: "string" },
          description: "Optional: only return these column names",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "read_spreadsheet",
    description:
      "Read an Excel (.xlsx) spreadsheet file and return its contents as a formatted table. " +
      "Requires exceljs (installed automatically on first use via: pnpm add exceljs). " +
      "Can specify which sheet to read.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path to the Excel spreadsheet file (.xlsx)",
        },
        sheet: {
          type: "string",
          description: "Sheet name to read (default: first sheet)",
        },
        max_rows: {
          type: "number",
          description: "Maximum data rows to return (default: 50, use 0 for all)",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "index_inventory",
    description:
      "Build or update the poster inventory index from a data source. " +
      "Supports: CSV file, Excel spreadsheet, or a folder of images. " +
      "Auto-detects source type from file extension. " +
      "Items are stored in a persistent searchable index.",
    input_schema: {
      type: "object" as const,
      properties: {
        source_path: {
          type: "string",
          description: "Path to CSV file, Excel spreadsheet, or image folder to index",
        },
        source_type: {
          type: "string",
          enum: ["csv", "spreadsheet", "folder"],
          description: "Type of source (auto-detected if omitted)",
        },
        mode: {
          type: "string",
          enum: ["append", "replace"],
          description: "Append new items or replace all items from this source (default: append)",
        },
        column_mapping: {
          type: "object",
          description:
            "For CSV/spreadsheet: map source column names to inventory fields. " +
            'E.g. {"Poster Name": "title", "Artist Name": "artist", "Image File": "image_path"}. ' +
            "Valid target fields: title, artist, category, image_path. Other columns go to metadata.",
          additionalProperties: { type: "string" },
        },
      },
      required: ["source_path"],
    },
  },
  {
    name: "search_inventory",
    description:
      "Search the poster inventory by keyword. Searches across title, artist, category, and metadata. " +
      "Returns matching items with image paths. Use show_image to display results to the user.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g. 'Bjork', 'vintage concert poster', 'art deco')",
        },
        field: {
          type: "string",
          enum: ["all", "title", "artist", "category"],
          description: "Limit search to a specific field (default: all)",
        },
        limit: {
          type: "number",
          description: "Maximum results to return (default: 10)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_inventory_stats",
    description:
      "Get inventory statistics: total items, breakdown by source, top artists, top categories. " +
      "Use this when the user asks about the inventory size or composition.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleShowImage(input: Record<string, unknown>): Promise<ToolResult> {
  const imagePath = resolve(input.image_path as string);
  const caption = (input.caption as string) ?? "";

  // Validate file exists
  try {
    await stat(imagePath);
  } catch {
    return { success: false, output: `Image not found: ${imagePath}` };
  }

  // Validate it's an image
  const ext = extname(imagePath).toLowerCase();
  if (!isImageExt(ext)) {
    return { success: false, output: `Not a supported image format: ${ext}` };
  }

  const fileStat = await stat(imagePath);
  const sizeMB = (fileStat.size / (1024 * 1024)).toFixed(1);
  const encodedPath = encodeURIComponent(imagePath);
  const altText = caption || basename(imagePath);

  // Markdown-style marker that the dashboard will detect and render as <img>
  const marker = `![${altText}](/api/image?path=${encodedPath})`;

  return {
    success: true,
    output: `${marker}\nFile: ${imagePath} (${sizeMB} MB)`,
  };
}

export async function handleReadCsv(input: Record<string, unknown>): Promise<ToolResult> {
  const filePath = resolve(input.path as string);
  const maxRows = (input.max_rows as number) ?? 50;
  const columnFilter = (input.columns as string[]) ?? null;

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return { success: false, output: `Cannot read file: ${filePath}` };
  }

  const rows = parseCSV(raw);
  if (rows.length === 0) {
    return { success: true, output: "CSV file is empty." };
  }

  const headers = rows[0];
  const dataRows = rows.slice(1);

  // Apply column filter
  let displayHeaders = headers;
  let displayRows = dataRows;
  if (columnFilter && columnFilter.length > 0) {
    const indices = columnFilter
      .map((col) => headers.findIndex((h) => h.toLowerCase() === col.toLowerCase()))
      .filter((i) => i !== -1);
    displayHeaders = indices.map((i) => headers[i]);
    displayRows = dataRows.map((row) => indices.map((i) => row[i] ?? ""));
  }

  // Apply row limit
  const totalDataRows = displayRows.length;
  if (maxRows > 0 && displayRows.length > maxRows) {
    displayRows = displayRows.slice(0, maxRows);
  }

  // Format as table
  const colWidths = displayHeaders.map((h, i) => {
    const maxVal = Math.max(
      h.length,
      ...displayRows.map((r) => (r[i] ?? "").length)
    );
    return Math.min(maxVal, 40); // cap column width
  });

  const headerLine = displayHeaders.map((h, i) => h.padEnd(colWidths[i])).join(" | ");
  const separator = colWidths.map((w) => "-".repeat(w)).join("-+-");
  const dataLines = displayRows.map((row) =>
    row.map((val, i) => {
      const s = val ?? "";
      return s.length > 40 ? s.slice(0, 37) + "..." : s.padEnd(colWidths[i]);
    }).join(" | ")
  );

  const truncNote = maxRows > 0 && totalDataRows > maxRows
    ? `\n\n(Showing ${maxRows} of ${totalDataRows} rows. Use max_rows: 0 to see all.)`
    : "";

  return {
    success: true,
    output: `${headers.length} columns, ${totalDataRows} rows\n\n${headerLine}\n${separator}\n${dataLines.join("\n")}${truncNote}`,
  };
}

export async function handleReadSpreadsheet(input: Record<string, unknown>): Promise<ToolResult> {
  const filePath = resolve(input.path as string);
  const sheetName = (input.sheet as string) ?? null;
  const maxRows = (input.max_rows as number) ?? 50;

  const ExcelJS = await getExcelJs();
  const workbook = new ExcelJS.Workbook();

  try {
    await workbook.xlsx.readFile(filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Cannot read spreadsheet: ${msg}` };
  }

  // Get worksheet
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let worksheet: any;
  if (sheetName) {
    worksheet = workbook.getWorksheet(sheetName);
    if (!worksheet) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const names = workbook.worksheets.map((ws: any) => ws.name);
      return { success: false, output: `Sheet "${sheetName}" not found. Available sheets: ${names.join(", ")}` };
    }
  } else {
    worksheet = workbook.worksheets[0];
    if (!worksheet) {
      return { success: false, output: "Workbook has no worksheets." };
    }
  }

  // Read rows
  const rows: string[][] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  worksheet.eachRow((row: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const values = row.values as any[];
    // ExcelJS row.values is 1-based (index 0 is undefined)
    const cells = values.slice(1).map((v) => {
      if (v === null || v === undefined) return "";
      if (v instanceof Date) return v.toISOString().split("T")[0];
      if (typeof v === "object" && v.text) return String(v.text);
      if (typeof v === "object" && v.result !== undefined) return String(v.result);
      return String(v);
    });
    rows.push(cells);
  });

  if (rows.length === 0) {
    return { success: true, output: `Sheet "${worksheet.name}" is empty.` };
  }

  const headers = rows[0];
  const dataRows = rows.slice(1);
  const totalDataRows = dataRows.length;
  const displayRows = maxRows > 0 && dataRows.length > maxRows ? dataRows.slice(0, maxRows) : dataRows;

  // Format as table (same as CSV)
  const colWidths = headers.map((h, i) => {
    const maxVal = Math.max(
      h.length,
      ...displayRows.map((r) => (r[i] ?? "").length)
    );
    return Math.min(maxVal, 40);
  });

  const headerLine = headers.map((h, i) => h.padEnd(colWidths[i])).join(" | ");
  const separator = colWidths.map((w) => "-".repeat(w)).join("-+-");
  const dataLines = displayRows.map((row) =>
    row.map((val, i) => {
      const s = val ?? "";
      return s.length > 40 ? s.slice(0, 37) + "..." : s.padEnd(colWidths[i]);
    }).join(" | ")
  );

  const sheetInfo = `Sheet: ${worksheet.name} | ${headers.length} columns, ${totalDataRows} rows`;
  const truncNote = maxRows > 0 && totalDataRows > maxRows
    ? `\n\n(Showing ${maxRows} of ${totalDataRows} rows. Use max_rows: 0 to see all.)`
    : "";

  return {
    success: true,
    output: `${sheetInfo}\n\n${headerLine}\n${separator}\n${dataLines.join("\n")}${truncNote}`,
  };
}

export async function handleIndexInventory(input: Record<string, unknown>): Promise<ToolResult> {
  const sourcePath = resolve(input.source_path as string);
  const mode = (input.mode as string) ?? "append";
  const columnMapping = (input.column_mapping as Record<string, string>) ?? null;

  // Auto-detect source type
  let sourceType = input.source_type as string | undefined;
  if (!sourceType) {
    try {
      const s = await stat(sourcePath);
      if (s.isDirectory()) {
        sourceType = "folder";
      } else {
        const ext = extname(sourcePath).toLowerCase();
        if (ext === ".csv") sourceType = "csv";
        else if (ext === ".xlsx" || ext === ".xls") sourceType = "spreadsheet";
        else return { success: false, output: `Cannot auto-detect source type for extension: ${ext}. Specify source_type.` };
      }
    } catch {
      return { success: false, output: `Cannot access: ${sourcePath}` };
    }
  }

  const index = await loadInventory();
  const now = new Date().toISOString();
  let newItems: InventoryItem[] = [];

  if (sourceType === "csv") {
    let raw: string;
    try {
      raw = await readFile(sourcePath, "utf-8");
    } catch {
      return { success: false, output: `Cannot read CSV: ${sourcePath}` };
    }

    const rows = parseCSV(raw);
    if (rows.length < 2) {
      return { success: false, output: "CSV has no data rows." };
    }

    const headers = rows[0];
    const dataRows = rows.slice(1);
    newItems = dataRows.map((row, rowIdx) => {
      const rowObj: Record<string, string> = {};
      headers.forEach((h, i) => {
        rowObj[h] = row[i] ?? "";
      });

      return csvRowToItem(rowObj, headers, columnMapping, sourcePath, rowIdx, now);
    });
  } else if (sourceType === "spreadsheet") {
    const ExcelJS = await getExcelJs();
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.readFile(sourcePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: `Cannot read spreadsheet: ${msg}` };
    }

    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      return { success: false, output: "Workbook has no worksheets." };
    }

    const rows: string[][] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    worksheet.eachRow((row: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const values = row.values as any[];
      const cells = values.slice(1).map((v) => {
        if (v === null || v === undefined) return "";
        if (v instanceof Date) return v.toISOString().split("T")[0];
        if (typeof v === "object" && v.text) return String(v.text);
        if (typeof v === "object" && v.result !== undefined) return String(v.result);
        return String(v);
      });
      rows.push(cells);
    });

    if (rows.length < 2) {
      return { success: false, output: "Spreadsheet has no data rows." };
    }

    const headers = rows[0];
    const dataRows = rows.slice(1);
    newItems = dataRows.map((row, rowIdx) => {
      const rowObj: Record<string, string> = {};
      headers.forEach((h, i) => {
        rowObj[h] = row[i] ?? "";
      });
      return csvRowToItem(rowObj, headers, columnMapping, sourcePath, rowIdx, now);
    });
  } else if (sourceType === "folder") {
    let entries: string[];
    try {
      entries = await readdir(sourcePath);
    } catch {
      return { success: false, output: `Cannot read directory: ${sourcePath}` };
    }

    const imageFiles = entries.filter((e) => isImageExt(extname(e).toLowerCase()));
    if (imageFiles.length === 0) {
      return { success: false, output: `No image files found in: ${sourcePath}` };
    }

    newItems = imageFiles.map((filename) => ({
      id: itemId(sourcePath, filename),
      title: titleFromFilename(filename),
      artist: "",
      category: "",
      image_path: join(sourcePath, filename),
      source: "scan" as const,
      source_file: sourcePath,
      metadata: { filename },
      indexed_at: now,
    }));
  }

  // Apply mode
  if (mode === "replace") {
    index.items = index.items.filter((item) => item.source_file !== sourcePath);
    index.sources = index.sources.filter((s) => s.path !== sourcePath);
  }

  // Deduplicate by id (new items win)
  const existingIds = new Set(newItems.map((i) => i.id));
  index.items = index.items.filter((i) => !existingIds.has(i.id));
  index.items.push(...newItems);

  // Update sources
  index.sources.push({
    type: sourceType,
    path: sourcePath,
    item_count: newItems.length,
    indexed_at: now,
  });
  index.last_indexed = now;

  await saveInventory(index);

  return {
    success: true,
    output: `Indexed ${newItems.length} items from ${basename(sourcePath)} (${sourceType}). Total inventory: ${index.items.length} items.`,
  };
}

function csvRowToItem(
  rowObj: Record<string, string>,
  headers: string[],
  columnMapping: Record<string, string> | null,
  sourcePath: string,
  rowIdx: number,
  now: string
): InventoryItem {
  const INVENTORY_FIELDS = new Set(["title", "artist", "category", "image_path"]);

  // Build field map: source column → inventory field
  const fieldMap: Record<string, string> = {};
  if (columnMapping) {
    for (const [srcCol, targetField] of Object.entries(columnMapping)) {
      fieldMap[srcCol.toLowerCase()] = targetField;
    }
  } else {
    // Auto-detect common column names
    for (const h of headers) {
      const lower = h.toLowerCase();
      if (lower === "title" || lower === "name" || lower === "poster name" || lower === "poster_name") {
        fieldMap[lower] = "title";
      } else if (lower === "artist" || lower === "artist name" || lower === "artist_name" || lower === "band") {
        fieldMap[lower] = "artist";
      } else if (lower === "category" || lower === "genre" || lower === "type") {
        fieldMap[lower] = "category";
      } else if (lower === "image" || lower === "image_path" || lower === "image file" || lower === "filename" || lower === "photo") {
        fieldMap[lower] = "image_path";
      }
    }
  }

  const item: InventoryItem = {
    id: itemId(sourcePath, String(rowIdx)),
    title: "",
    artist: "",
    category: "",
    image_path: null,
    source: sourcePath.endsWith(".csv") ? "csv" : "spreadsheet",
    source_file: sourcePath,
    metadata: {},
    indexed_at: now,
  };

  for (const h of headers) {
    const val = rowObj[h] ?? "";
    if (!val) continue;

    const target = fieldMap[h.toLowerCase()];
    if (target && INVENTORY_FIELDS.has(target)) {
      (item as unknown as Record<string, unknown>)[target] = val;
    } else {
      item.metadata[h] = val;
    }
  }

  // Fallback title from first non-empty field
  if (!item.title) {
    const firstVal = headers.map((h) => rowObj[h]).find((v) => v && v.length > 0);
    item.title = firstVal ?? `Row ${rowIdx + 1}`;
  }

  return item;
}

export async function handleSearchInventory(input: Record<string, unknown>): Promise<ToolResult> {
  const query = (input.query as string).toLowerCase();
  const field = (input.field as string) ?? "all";
  const limit = (input.limit as number) ?? 10;

  const index = await loadInventory();
  if (index.items.length === 0) {
    return { success: false, output: "Inventory is empty. Use index_inventory to add items first." };
  }

  const terms = query.split(/\s+/).filter((t) => t.length > 0);

  const scored = index.items
    .map((item) => {
      let searchable: string;
      if (field === "all") {
        searchable = [
          item.title,
          item.artist,
          item.category,
          ...Object.values(item.metadata),
        ]
          .join(" ")
          .toLowerCase();
      } else {
        searchable = ((item as unknown as Record<string, string>)[field] ?? "").toLowerCase();
      }

      let score = 0;
      for (const term of terms) {
        if (searchable.includes(term)) score++;
      }
      // Bonus for exact phrase match
      if (searchable.includes(query)) score += terms.length;

      return { item, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (scored.length === 0) {
    return {
      success: true,
      output: `No items matching "${query}" found in inventory (${index.items.length} total items).`,
    };
  }

  const lines = scored.map((s, i) => {
    const item = s.item;
    const img = item.image_path ? `\n  Image: ${item.image_path}` : "\n  Image: (none)";
    const metaEntries = Object.entries(item.metadata).filter(([k]) => k !== "filename");
    const meta = metaEntries.length > 0
      ? "\n  " + metaEntries.map(([k, v]) => `${k}: ${v}`).join(", ")
      : "";
    return `${i + 1}. ${item.title}${item.artist ? `\n  Artist: ${item.artist}` : ""}${item.category ? `\n  Category: ${item.category}` : ""}${img}${meta}`;
  });

  return {
    success: true,
    output: `Found ${scored.length} result(s) for "${query}":\n\n${lines.join("\n\n")}`,
  };
}

export async function handleGetInventoryStats(): Promise<ToolResult> {
  const index = await loadInventory();

  if (index.items.length === 0) {
    return { success: true, output: "Inventory is empty. Use index_inventory to add items." };
  }

  // Count by source
  const bySrc: Record<string, number> = {};
  for (const item of index.items) {
    bySrc[item.source] = (bySrc[item.source] ?? 0) + 1;
  }

  // Count by artist (top 10)
  const byArtist: Record<string, number> = {};
  for (const item of index.items) {
    if (item.artist) {
      byArtist[item.artist] = (byArtist[item.artist] ?? 0) + 1;
    }
  }
  const topArtists = Object.entries(byArtist)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Count by category (top 10)
  const byCat: Record<string, number> = {};
  for (const item of index.items) {
    if (item.category) {
      byCat[item.category] = (byCat[item.category] ?? 0) + 1;
    }
  }
  const topCategories = Object.entries(byCat)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Items with images
  const withImages = index.items.filter((i) => i.image_path).length;

  let output = `Inventory: ${index.items.length} total items (${withImages} with images)\n`;
  output += `Last indexed: ${index.last_indexed || "never"}\n\n`;

  output += "By source:\n";
  for (const [src, count] of Object.entries(bySrc)) {
    output += `  ${src}: ${count}\n`;
  }

  if (topArtists.length > 0) {
    output += "\nTop artists:\n";
    for (const [artist, count] of topArtists) {
      output += `  ${artist}: ${count}\n`;
    }
  }

  if (topCategories.length > 0) {
    output += "\nTop categories:\n";
    for (const [cat, count] of topCategories) {
      output += `  ${cat}: ${count}\n`;
    }
  }

  if (index.sources.length > 0) {
    output += "\nIndexed sources:\n";
    for (const src of index.sources) {
      output += `  ${src.type}: ${src.path} (${src.item_count} items, ${src.indexed_at})\n`;
    }
  }

  return { success: true, output };
}
