import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "../providers/types.js";
import { loadVault } from "./form-filler.js";
import { loadContacts } from "./contacts.js";

interface ToolResult {
  success: boolean;
  output: string;
}

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

interface InvoiceItem {
  description: string;
  quantity: number;
  unit_price: number;
}

interface Invoice {
  id: string;
  invoice_number: string;
  client_name: string;
  client_address?: string;
  client_email?: string;
  items: InvoiceItem[];
  subtotal: number;
  tax_rate: number;
  tax_amount: number;
  total: number;
  notes?: string;
  due_date?: string;
  created_at: string;
  output_path: string;
}

interface InvoiceStore {
  version: number;
  invoices: Invoice[];
  next_number: number;
}

const INVOICES_PATH = resolve("memory/invoices.json");
const INVOICES_DIR = resolve("memory/invoices");

// ---------------------------------------------------------------------------
// Lazy-load pdf-lib
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
// Persistence
// ---------------------------------------------------------------------------

async function loadInvoiceStore(): Promise<InvoiceStore> {
  try {
    const raw = await readFile(INVOICES_PATH, "utf-8");
    return JSON.parse(raw) as InvoiceStore;
  } catch {
    return { version: 1, invoices: [], next_number: 1001 };
  }
}

async function saveInvoiceStore(store: InvoiceStore): Promise<void> {
  await mkdir(dirname(INVOICES_PATH), { recursive: true });
  await writeFile(INVOICES_PATH, JSON.stringify(store, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const invoiceToolDefinitions: ToolDefinition[] = [
  {
    name: "create_invoice",
    description:
      "Generate a PDF invoice. Pulls sender info from the personal data vault and can look up " +
      "client details from contacts. Returns the path to the generated PDF.",
    input_schema: {
      type: "object" as const,
      properties: {
        client_name: {
          type: "string",
          description: "Client/recipient name (will also search contacts for address/email)",
        },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              quantity: { type: "number" },
              unit_price: { type: "number" },
            },
            required: ["description", "quantity", "unit_price"],
          },
          description: "Line items: [{description, quantity, unit_price}]",
        },
        invoice_number: {
          type: "string",
          description: "Custom invoice number (auto-generated if omitted)",
        },
        tax_rate: {
          type: "number",
          description: "Tax rate as percentage (e.g. 8.25 for 8.25%). Default: 0.",
        },
        notes: {
          type: "string",
          description: "Notes to include on the invoice (payment terms, etc.)",
        },
        due_date: {
          type: "string",
          description: "Payment due date (ISO format)",
        },
        output_path: {
          type: "string",
          description: "Where to save the PDF. Default: memory/invoices/INV-XXXX.pdf",
        },
      },
      required: ["client_name", "items"],
    },
  },
  {
    name: "list_invoices",
    description: "List all previously generated invoices.",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max invoices to show (default: 20)" },
      },
      required: [],
    },
  },
  {
    name: "get_invoice",
    description: "Get details of a specific invoice by ID or invoice number.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Invoice ID or invoice number" },
      },
      required: ["id"],
    },
  },
];

// ---------------------------------------------------------------------------
// PDF generation
// ---------------------------------------------------------------------------

async function generateInvoicePdf(
  invoice: Invoice,
  senderName: string,
  senderAddress: string,
  senderEmail: string,
  outputPath: string
): Promise<void> {
  const pdfLib = await getPdfLib();
  const { PDFDocument, rgb, StandardFonts } = pdfLib;

  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]); // A4
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontSize = 10;
  const gray = rgb(0.4, 0.4, 0.4);
  const black = rgb(0, 0, 0);

  let y = 790;
  const leftMargin = 50;
  const rightCol = 350;

  // Header — INVOICE
  page.drawText("INVOICE", { x: leftMargin, y, font: fontBold, size: 24, color: black });
  y -= 30;

  // Invoice number + date
  page.drawText(`Invoice #: ${invoice.invoice_number}`, { x: leftMargin, y, font, size: fontSize, color: gray });
  page.drawText(`Date: ${invoice.created_at.split("T")[0]}`, { x: rightCol, y, font, size: fontSize, color: gray });
  y -= 15;
  if (invoice.due_date) {
    page.drawText(`Due: ${invoice.due_date}`, { x: rightCol, y, font, size: fontSize, color: gray });
  }
  y -= 30;

  // From
  page.drawText("FROM:", { x: leftMargin, y, font: fontBold, size: 9, color: gray });
  page.drawText("TO:", { x: rightCol, y, font: fontBold, size: 9, color: gray });
  y -= 15;

  page.drawText(senderName, { x: leftMargin, y, font: fontBold, size: fontSize, color: black });
  page.drawText(invoice.client_name, { x: rightCol, y, font: fontBold, size: fontSize, color: black });
  y -= 14;

  if (senderAddress) {
    for (const line of senderAddress.split(",").map((s) => s.trim())) {
      page.drawText(line, { x: leftMargin, y, font, size: 9, color: gray });
      y -= 12;
    }
  }

  // Reset y for client address on right side
  let clientY = y + (senderAddress ? senderAddress.split(",").length * 12 : 0) - 14;
  if (invoice.client_address) {
    for (const line of invoice.client_address.split(",").map((s) => s.trim())) {
      clientY -= 12;
      page.drawText(line, { x: rightCol, y: clientY, font, size: 9, color: gray });
    }
  }
  if (invoice.client_email) {
    clientY -= 12;
    page.drawText(invoice.client_email, { x: rightCol, y: clientY, font, size: 9, color: gray });
  }

  if (senderEmail) {
    page.drawText(senderEmail, { x: leftMargin, y, font, size: 9, color: gray });
    y -= 12;
  }

  y = Math.min(y, clientY) - 30;

  // Line items header
  const colDesc = leftMargin;
  const colQty = 340;
  const colPrice = 410;
  const colTotal = 490;

  page.drawText("Description", { x: colDesc, y, font: fontBold, size: 9, color: gray });
  page.drawText("Qty", { x: colQty, y, font: fontBold, size: 9, color: gray });
  page.drawText("Price", { x: colPrice, y, font: fontBold, size: 9, color: gray });
  page.drawText("Total", { x: colTotal, y, font: fontBold, size: 9, color: gray });
  y -= 5;

  // Divider
  page.drawLine({ start: { x: leftMargin, y }, end: { x: 545, y }, thickness: 0.5, color: gray });
  y -= 15;

  // Line items
  for (const item of invoice.items) {
    const lineTotal = item.quantity * item.unit_price;
    page.drawText(item.description.slice(0, 50), { x: colDesc, y, font, size: fontSize, color: black });
    page.drawText(String(item.quantity), { x: colQty, y, font, size: fontSize, color: black });
    page.drawText(`$${item.unit_price.toFixed(2)}`, { x: colPrice, y, font, size: fontSize, color: black });
    page.drawText(`$${lineTotal.toFixed(2)}`, { x: colTotal, y, font, size: fontSize, color: black });
    y -= 18;
  }

  // Divider
  y -= 5;
  page.drawLine({ start: { x: colPrice, y }, end: { x: 545, y }, thickness: 0.5, color: gray });
  y -= 18;

  // Subtotal / Tax / Total
  page.drawText("Subtotal:", { x: colPrice, y, font, size: fontSize, color: gray });
  page.drawText(`$${invoice.subtotal.toFixed(2)}`, { x: colTotal, y, font, size: fontSize, color: black });
  y -= 16;

  if (invoice.tax_rate > 0) {
    page.drawText(`Tax (${invoice.tax_rate}%):`, { x: colPrice, y, font, size: fontSize, color: gray });
    page.drawText(`$${invoice.tax_amount.toFixed(2)}`, { x: colTotal, y, font, size: fontSize, color: black });
    y -= 16;
  }

  page.drawText("Total:", { x: colPrice, y, font: fontBold, size: 12, color: black });
  page.drawText(`$${invoice.total.toFixed(2)}`, { x: colTotal, y, font: fontBold, size: 12, color: black });
  y -= 30;

  // Notes
  if (invoice.notes) {
    page.drawText("Notes:", { x: leftMargin, y, font: fontBold, size: 9, color: gray });
    y -= 14;
    for (const line of invoice.notes.split("\n")) {
      page.drawText(line.slice(0, 80), { x: leftMargin, y, font, size: 9, color: gray });
      y -= 12;
    }
  }

  const pdfBytes = await doc.save();
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.from(pdfBytes));
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleCreateInvoice(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const clientName = input.client_name as string;
  const items = input.items as InvoiceItem[];
  const taxRate = (input.tax_rate as number) ?? 0;
  const notes = input.notes as string | undefined;
  const dueDate = input.due_date as string | undefined;

  if (!items || items.length === 0) {
    return { success: false, output: "At least one line item is required." };
  }

  // Calculate totals
  const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
  const taxAmount = subtotal * (taxRate / 100);
  const total = subtotal + taxAmount;

  // Load store for auto-numbering
  const store = await loadInvoiceStore();
  const invoiceNumber = (input.invoice_number as string) ?? `INV-${store.next_number}`;

  // Look up client in contacts
  let clientAddress: string | undefined;
  let clientEmail: string | undefined;
  try {
    const contacts = await loadContacts();
    const match = contacts.find(
      (c) => c.name.toLowerCase() === clientName.toLowerCase()
    );
    if (match) {
      clientAddress = match.address;
      clientEmail = match.email;
    }
  } catch {
    // Contacts not available, continue without
  }

  // Get sender info from vault
  let senderName = "Your Company";
  let senderAddress = "";
  let senderEmail = "";
  try {
    const vault = await loadVault();
    const personal = vault.personal;
    const business = vault.business;
    if (business?.company_name?.value) senderName = business.company_name.value;
    else if (personal?.full_name?.value) senderName = personal.full_name.value;
    if (business?.address?.value) senderAddress = business.address.value;
    else if (personal?.address?.value) senderAddress = personal.address.value;
    if (business?.email?.value) senderEmail = business.email.value;
    else if (personal?.email?.value) senderEmail = personal.email.value;
  } catch {
    // Vault not available, use defaults
  }

  const outputPath = input.output_path
    ? resolve(input.output_path as string)
    : resolve(INVOICES_DIR, `${invoiceNumber}.pdf`);

  const invoice: Invoice = {
    id: randomUUID().slice(0, 8),
    invoice_number: invoiceNumber,
    client_name: clientName,
    client_address: clientAddress,
    client_email: clientEmail,
    items,
    subtotal,
    tax_rate: taxRate,
    tax_amount: taxAmount,
    total,
    notes,
    due_date: dueDate,
    created_at: new Date().toISOString(),
    output_path: outputPath,
  };

  try {
    await generateInvoicePdf(invoice, senderName, senderAddress, senderEmail, outputPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Failed to generate PDF: ${msg}` };
  }

  // Save to store
  store.invoices.push(invoice);
  if (!input.invoice_number) store.next_number++;
  await saveInvoiceStore(store);

  return {
    success: true,
    output:
      `Invoice ${invoiceNumber} created for ${clientName}\n` +
      `  Items: ${items.length}\n` +
      `  Subtotal: $${subtotal.toFixed(2)}\n` +
      (taxRate > 0 ? `  Tax (${taxRate}%): $${taxAmount.toFixed(2)}\n` : "") +
      `  Total: $${total.toFixed(2)}\n` +
      `  Saved to: ${outputPath}`,
  };
}

export async function handleListInvoices(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const store = await loadInvoiceStore();
  const limit = (input.limit as number) ?? 20;

  if (store.invoices.length === 0) {
    return { success: true, output: "No invoices generated yet." };
  }

  const sorted = [...store.invoices].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  const lines = sorted.slice(0, limit).map((inv) => {
    const date = inv.created_at.split("T")[0];
    return `${inv.invoice_number.padEnd(12)} ${date}  ${inv.client_name.padEnd(25)} $${inv.total.toFixed(2).padStart(10)}  [${inv.id}]`;
  });

  return {
    success: true,
    output: `${store.invoices.length} invoice(s):\n\n${lines.join("\n")}`,
  };
}

export async function handleGetInvoice(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const store = await loadInvoiceStore();
  const searchId = input.id as string;

  const invoice = store.invoices.find(
    (inv) => inv.id === searchId || inv.invoice_number === searchId
  );

  if (!invoice) {
    return { success: false, output: `Invoice not found: ${searchId}` };
  }

  const itemLines = invoice.items.map(
    (item) => `  ${item.description.padEnd(40)} ${item.quantity} x $${item.unit_price.toFixed(2)} = $${(item.quantity * item.unit_price).toFixed(2)}`
  );

  return {
    success: true,
    output:
      `Invoice ${invoice.invoice_number}\n` +
      `${"─".repeat(50)}\n` +
      `Client: ${invoice.client_name}\n` +
      (invoice.client_address ? `Address: ${invoice.client_address}\n` : "") +
      (invoice.client_email ? `Email: ${invoice.client_email}\n` : "") +
      `Date: ${invoice.created_at.split("T")[0]}\n` +
      (invoice.due_date ? `Due: ${invoice.due_date}\n` : "") +
      `\nItems:\n${itemLines.join("\n")}\n\n` +
      `Subtotal: $${invoice.subtotal.toFixed(2)}\n` +
      (invoice.tax_rate > 0 ? `Tax (${invoice.tax_rate}%): $${invoice.tax_amount.toFixed(2)}\n` : "") +
      `Total: $${invoice.total.toFixed(2)}\n` +
      (invoice.notes ? `\nNotes: ${invoice.notes}\n` : "") +
      `\nPDF: ${invoice.output_path}`,
  };
}
