import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "../providers/types.js";
import type { Expense } from "../db/stores.js";
import {
  storeInsertExpense,
  storeGetExpenses,
  storeDeleteExpense,
  storeGetExpenseSummary,
} from "../db/stores.js";

interface ToolResult {
  success: boolean;
  output: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORIES = [
  "food", "transport", "office", "software", "services",
  "tax", "utilities", "travel", "entertainment", "medical", "other",
];

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const expensesToolDefinitions: ToolDefinition[] = [
  {
    name: "add_expense",
    description: "Log a new expense.",
    input_schema: {
      type: "object" as const,
      properties: {
        amount: { type: "number", description: "Amount spent" },
        description: { type: "string", description: "What the expense was for" },
        category: {
          type: "string",
          enum: CATEGORIES,
          description: "Expense category (default: other)",
        },
        vendor: { type: "string", description: "Who was paid" },
        date: { type: "string", description: "Date of expense (ISO format, default: today)" },
        currency: { type: "string", description: "Currency code (default: USD)" },
        receipt_path: { type: "string", description: "Path to receipt image/file" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for this expense",
        },
      },
      required: ["amount", "description"],
    },
  },
  {
    name: "list_expenses",
    description: "List expenses, optionally filtered by date range and category.",
    input_schema: {
      type: "object" as const,
      properties: {
        from: { type: "string", description: "Start date (ISO format)" },
        to: { type: "string", description: "End date (ISO format)" },
        category: { type: "string", description: "Filter by category" },
        limit: { type: "number", description: "Max entries to return (default: 30)" },
      },
      required: [],
    },
  },
  {
    name: "get_expense_summary",
    description:
      "Get a summary of expenses by category for a time period. " +
      "Shows total spending, breakdown by category, and top vendors.",
    input_schema: {
      type: "object" as const,
      properties: {
        period: {
          type: "string",
          enum: ["month", "quarter", "year"],
          description: "Summary period (default: month)",
        },
        year: { type: "number", description: "Year (default: current)" },
        month: { type: "number", description: "Month 1-12 (default: current, only for 'month' period)" },
      },
      required: [],
    },
  },
  {
    name: "delete_expense",
    description: "Delete an expense by ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Expense ID to delete" },
      },
      required: ["id"],
    },
  },
  {
    name: "export_expenses",
    description: "Export expenses to a CSV or JSON file.",
    input_schema: {
      type: "object" as const,
      properties: {
        from: { type: "string", description: "Start date (ISO format)" },
        to: { type: "string", description: "End date (ISO format)" },
        format: {
          type: "string",
          enum: ["csv", "json"],
          description: "Export format (default: csv)",
        },
      },
      required: [],
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAmount(amount: number, currency: string): string {
  if (currency === "USD") return `$${amount.toFixed(2)}`;
  if (currency === "GBP") return `£${amount.toFixed(2)}`;
  if (currency === "EUR") return `€${amount.toFixed(2)}`;
  return `${amount.toFixed(2)} ${currency}`;
}

function getDateRange(
  period: string,
  year: number,
  month: number
): { from: string; to: string; label: string } {
  if (period === "year") {
    return {
      from: `${year}-01-01`,
      to: `${year + 1}-01-01`,
      label: `${year}`,
    };
  }
  if (period === "quarter") {
    const q = Math.ceil(month / 3);
    const qStart = (q - 1) * 3 + 1;
    const qEnd = qStart + 3;
    const toYear = qEnd > 12 ? year + 1 : year;
    const toMonth = qEnd > 12 ? qEnd - 12 : qEnd;
    return {
      from: `${year}-${String(qStart).padStart(2, "0")}-01`,
      to: `${toYear}-${String(toMonth).padStart(2, "0")}-01`,
      label: `Q${q} ${year}`,
    };
  }
  // month
  const nextMonth = month + 1;
  const toYear = nextMonth > 12 ? year + 1 : year;
  const toMonth = nextMonth > 12 ? 1 : nextMonth;
  return {
    from: `${year}-${String(month).padStart(2, "0")}-01`,
    to: `${toYear}-${String(toMonth).padStart(2, "0")}-01`,
    label: new Date(year, month - 1).toLocaleDateString("en-US", { month: "long", year: "numeric" }),
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleAddExpense(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const expense: Expense = {
    id: randomUUID().slice(0, 8),
    amount: input.amount as number,
    description: input.description as string,
    category: (input.category as string) ?? "other",
    currency: (input.currency as string) ?? "USD",
    vendor: input.vendor as string | undefined,
    date: (input.date as string) ?? new Date().toISOString().split("T")[0]!,
    receipt_path: input.receipt_path as string | undefined,
    tags: input.tags as string[] | undefined,
    created_at: new Date().toISOString(),
  };

  await storeInsertExpense(expense);

  return {
    success: true,
    output: `Expense logged: ${formatAmount(expense.amount, expense.currency)} — ${expense.description} (${expense.category}) [${expense.id}]`,
  };
}

export async function handleListExpenses(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const from = input.from as string | undefined;
  const to = input.to as string | undefined;
  const category = input.category as string | undefined;
  const limit = (input.limit as number) ?? 30;

  const filtered = await storeGetExpenses({ from, to, category, limit });

  if (filtered.length === 0) {
    return { success: true, output: "No expenses found." };
  }

  const lines = filtered.map((e) => {
    const vendor = e.vendor ? ` @ ${e.vendor}` : "";
    return `${e.date}  ${formatAmount(e.amount, e.currency).padEnd(12)} ${e.category.padEnd(14)} ${e.description}${vendor}  [${e.id}]`;
  });

  const total = filtered.reduce((sum, e) => sum + e.amount, 0);
  const allExpenses = await storeGetExpenses({ from, to, category, limit: 10000 });
  const countNote = allExpenses.length > limit ? ` (showing ${limit} of ${allExpenses.length})` : "";

  return {
    success: true,
    output: `${allExpenses.length} expense(s)${countNote}:\n\n${lines.join("\n")}\n\nTotal: ${formatAmount(total, filtered[0]?.currency ?? "USD")}`,
  };
}

export async function handleGetExpenseSummary(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const now = new Date();
  const period = (input.period as string) ?? "month";
  const year = (input.year as number) ?? now.getFullYear();
  const month = (input.month as number) ?? now.getMonth() + 1;

  const { from, to, label } = getDateRange(period, year, month);
  const summary = await storeGetExpenseSummary(from, to);

  if (summary.count === 0) {
    return { success: true, output: `No expenses for ${label}.` };
  }

  const catLines = Object.entries(summary.byCategory)
    .sort(([, a], [, b]) => b - a)
    .map(([cat, amt]) => `  ${cat.padEnd(14)} ${formatAmount(amt, summary.currency).padStart(12)}  (${Math.round((amt / summary.total) * 100)}%)`);

  const topVendors = Object.entries(summary.byVendor)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([vendor, amt]) => `  ${vendor.padEnd(20)} ${formatAmount(amt, summary.currency).padStart(12)}`);

  let output = `Expense Summary — ${label}\n`;
  output += `${"─".repeat(40)}\n`;
  output += `Total: ${formatAmount(summary.total, summary.currency)} (${summary.count} expenses)\n\n`;
  output += `By Category:\n${catLines.join("\n")}`;

  if (topVendors.length > 0) {
    output += `\n\nTop Vendors:\n${topVendors.join("\n")}`;
  }

  return { success: true, output };
}

export async function handleDeleteExpense(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const removed = await storeDeleteExpense(input.id as string);
  if (!removed) {
    return { success: false, output: `Expense not found: ${input.id}` };
  }

  return {
    success: true,
    output: `Deleted: ${formatAmount(removed.amount, removed.currency)} — ${removed.description}`,
  };
}

export async function handleExportExpenses(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const from = input.from as string | undefined;
  const to = input.to as string | undefined;
  const format = (input.format as string) ?? "csv";

  let filtered = await storeGetExpenses({ from, to, limit: 10000 });

  // Sort ascending for export
  filtered.sort((a, b) => a.date.localeCompare(b.date));

  if (filtered.length === 0) {
    return { success: true, output: "No expenses to export." };
  }

  const timestamp = new Date().toISOString().split("T")[0]!;
  const exportDir = resolve("memory/exports");
  await mkdir(exportDir, { recursive: true });

  if (format === "json") {
    const filePath = resolve(exportDir, `expenses-${timestamp}.json`);
    await writeFile(filePath, JSON.stringify(filtered, null, 2), "utf-8");
    return { success: true, output: `Exported ${filtered.length} expenses to ${filePath}` };
  }

  // CSV
  const header = "Date,Amount,Currency,Category,Description,Vendor,Tags";
  const rows = filtered.map((e) => {
    const desc = e.description.includes(",") ? `"${e.description}"` : e.description;
    const vendor = e.vendor ?? "";
    const tags = (e.tags ?? []).join(";");
    return `${e.date},${e.amount},${e.currency},${e.category},${desc},${vendor},${tags}`;
  });

  const filePath = resolve(exportDir, `expenses-${timestamp}.csv`);
  await writeFile(filePath, [header, ...rows].join("\n"), "utf-8");

  return { success: true, output: `Exported ${filtered.length} expenses to ${filePath}` };
}
