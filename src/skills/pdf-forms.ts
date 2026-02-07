import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname, basename, extname } from "node:path";
import type { ToolDefinition } from "../providers/types.js";
import { matchFieldToVault, loadVault } from "./form-filler.js";

interface ToolResult {
  success: boolean;
  output: string;
}

// ---------------------------------------------------------------------------
// Lazy-load pdf-lib (optional dependency)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pdfLibMod: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getPdfLib(): Promise<any> {
  if (!pdfLibMod) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = await (Function('return import("pdf-lib")')() as Promise<any>);
      pdfLibMod = mod.default ?? mod;
    } catch {
      throw new Error("pdf-lib is not installed. Run: pnpm add pdf-lib");
    }
  }
  return pdfLibMod;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const pdfFormToolDefinitions: ToolDefinition[] = [
  {
    name: "parse_pdf_form",
    description:
      "Open a PDF file and extract all fillable form field names, types, and current values. " +
      "Use this to see what fields a PDF form has before filling it.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path to the PDF file to parse",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "fill_pdf_form",
    description:
      "Fill a PDF form using the personal data vault (auto-matching field names) plus optional explicit overrides. " +
      "Saves the filled PDF as {original-name}-filled.pdf. Returns a status report showing which fields were filled " +
      "and which still need manual input.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path to the PDF file to fill",
        },
        overrides: {
          type: "object",
          description:
            "Optional explicit field values to set, as { fieldName: value } pairs. " +
            "These override any vault-matched values. Use for dropdowns, checkboxes, and fields not in the vault.",
          additionalProperties: { type: "string" },
        },
        output_path: {
          type: "string",
          description:
            "Optional output path for the filled PDF. Defaults to {original-name}-filled.pdf in the same directory.",
        },
      },
      required: ["path"],
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getFieldTypeLabel(field: any): { typeLabel: string; currentValue: string } {
  const typeName = field.constructor.name as string;
  let typeLabel = "unknown";
  let currentValue = "";

  try {
    if (typeName.includes("Text")) {
      typeLabel = "text";
      currentValue = field.getText() ?? "";
    } else if (typeName.includes("Dropdown")) {
      typeLabel = "dropdown";
      try {
        const options = field.getOptions() as string[];
        typeLabel = `dropdown: ${options.join(", ")}`;
        const selected = field.getSelected();
        currentValue = Array.isArray(selected) ? selected.join(", ") : (selected ?? "");
      } catch { /* empty */ }
    } else if (typeName.includes("CheckBox")) {
      typeLabel = "checkbox";
      currentValue = field.isChecked() ? "checked" : "unchecked";
    } else if (typeName.includes("Radio")) {
      typeLabel = "radio";
      try {
        const options = field.getOptions() as string[];
        typeLabel = `radio: ${options.join(", ")}`;
        currentValue = field.getSelected() ?? "";
      } catch { /* empty */ }
    } else if (typeName.includes("OptionList")) {
      typeLabel = "option_list";
      try {
        const options = field.getOptions() as string[];
        typeLabel = `option_list: ${options.join(", ")}`;
      } catch { /* empty */ }
    }
  } catch {
    // Some fields may not support these methods
  }

  return { typeLabel, currentValue };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleParsePdfForm(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const filePath = resolve(input.path as string);
  const pdfLib = await getPdfLib();

  let pdfBytes: Buffer;
  try {
    pdfBytes = await readFile(filePath);
  } catch {
    return { success: false, output: `Cannot read file: ${filePath}` };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pdfDoc: any;
  try {
    pdfDoc = await pdfLib.PDFDocument.load(pdfBytes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Cannot parse PDF: ${msg}` };
  }

  const form = pdfDoc.getForm();
  const fields = form.getFields();

  if (fields.length === 0) {
    return {
      success: true,
      output: `PDF "${basename(filePath)}" has no fillable form fields.`,
    };
  }

  const lines: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const field = fields[i] as any;
    const name = field.getName() as string;
    const { typeLabel, currentValue } = getFieldTypeLabel(field);
    const valuePart = currentValue ? ` [current: "${currentValue}"]` : "";
    lines.push(`Field ${i + 1}: "${name}" (${typeLabel})${valuePart}`);
  }

  return {
    success: true,
    output:
      `PDF "${basename(filePath)}" — ${fields.length} form field(s):\n\n` +
      lines.join("\n"),
  };
}

export async function handleFillPdfForm(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const filePath = resolve(input.path as string);
  const overrides = (input.overrides as Record<string, string>) ?? {};
  const outputPath = input.output_path
    ? resolve(input.output_path as string)
    : resolve(
        dirname(filePath),
        `${basename(filePath, extname(filePath))}-filled${extname(filePath)}`
      );

  const pdfLib = await getPdfLib();
  const vault = await loadVault();

  let pdfBytes: Buffer;
  try {
    pdfBytes = await readFile(filePath);
  } catch {
    return { success: false, output: `Cannot read file: ${filePath}` };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pdfDoc: any;
  try {
    pdfDoc = await pdfLib.PDFDocument.load(pdfBytes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Cannot parse PDF: ${msg}` };
  }

  const form = pdfDoc.getForm();
  const fields = form.getFields();

  if (fields.length === 0) {
    return {
      success: false,
      output: `PDF "${basename(filePath)}" has no fillable form fields.`,
    };
  }

  let filledCount = 0;
  let skippedCount = 0;
  const report: string[] = [];
  const unfilled: string[] = [];

  for (const rawField of fields) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const field = rawField as any;
    const fieldName = field.getName() as string;
    const typeName = field.constructor.name as string;

    const isTextField = typeName.includes("Text");
    const isDropdown = typeName.includes("Dropdown");
    const isCheckBox = typeName.includes("CheckBox");

    // 1. Check explicit overrides first (these win for any field type)
    if (overrides[fieldName] !== undefined) {
      try {
        if (isTextField) {
          field.setText(overrides[fieldName]);
        } else if (isDropdown) {
          field.select(overrides[fieldName]);
        } else if (isCheckBox) {
          if (overrides[fieldName] === "true" || overrides[fieldName] === "checked") {
            field.check();
          } else {
            field.uncheck();
          }
        }
        report.push(`  "${fieldName}" <- "${overrides[fieldName]}" (override)`);
        filledCount++;
        continue;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        report.push(`  "${fieldName}" <- override FAILED: ${msg}`);
        skippedCount++;
        continue;
      }
    }

    // 2. Try vault fuzzy match for text fields
    if (isTextField) {
      const match = matchFieldToVault(fieldName);
      if (match) {
        const vaultValue = vault[match.category]?.[match.field];
        if (vaultValue) {
          try {
            field.setText(vaultValue.value);
            report.push(
              `  "${fieldName}" <- "${vaultValue.value}" (vault: ${match.category}.${match.field})`
            );
            filledCount++;
            continue;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            report.push(`  "${fieldName}" <- vault match FAILED: ${msg}`);
          }
        } else {
          report.push(
            `  "${fieldName}" -> matched ${match.category}.${match.field} but no value in vault`
          );
        }
      }
    }

    // Field was not filled
    unfilled.push(fieldName);
    skippedCount++;
  }

  // Save the filled PDF
  const filledPdfBytes = await pdfDoc.save();
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.from(filledPdfBytes));

  const formName = basename(filePath, extname(filePath));
  const summary =
    `${formName} filled — ${filledCount} of ${fields.length} fields complete.` +
    (unfilled.length > 0
      ? ` Still need: ${unfilled.join(", ")}.`
      : " All fields filled!");

  let output = `${summary}\n\nSaved to: ${outputPath}\n\nDetails:\n${report.join("\n")}`;

  if (unfilled.length > 0) {
    output +=
      `\n\nUnfilled fields:\n${unfilled.map((f) => `  - ${f}`).join("\n")}` +
      `\n\nTip: Use fill_pdf_form with overrides: { "${unfilled[0]}": "value" } to fill remaining fields.`;
  }

  return { success: true, output };
}
