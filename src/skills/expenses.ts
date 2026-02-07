import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "../providers/types.js";

interface ToolResult {
  success: boolean;
  output: string;
}

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

interface Expense {
  id: string;
  amount: number;
  currency: string;
  category: string;
  description: string;
  date: string;
  vendor?: string;
  receipt_path?: string;
  tags?: string[];
  created_at: string;
}

interface ExpenseStore {
  version: number;
  expenses: Expense[];
}

const EXPENSES_PATH = resolve("memory/expenses.json");

const CATEGORIES = [
  "food", "transport", "office", "software", "services",
  "tax", "utilities", "travel", "entertainment", "medical", "other",
];

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function loadExpenses(): Promise<Expense[]> {
  try {
    const raw = await readFile(EXPENSES_PATH, "utf-8");
    const store = JSON.parse(raw) as ExpenseStore;
    return store.expenses ?? [];
  } catch {
    return [];
  }
}

async function saveExpenses(expenses: Expense[]): Promise<void> {
  const store: ExpenseStore = { version: 1, expenses };
  await mkdir(dirname(EXPENSES_PATH), { recursive: true });
  await writeFile(EXPENSES_PATH, JSON.stringify(store, null, 2), "utf-8");
}

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
): { from: Date; to: Date; label: string } {
  if (period === "year") {
    return {
      from: new Date(year, 0, 1),
      to: new Date(year + 1, 0, 1),
      label: `${year}`,
    };
  }
  if (period === "quarter") {
    const q = Math.ceil(month / 3);
    const qStart = (q - 1) * 3;
    return {
      from: new Date(year, qStart, 1),
      to: new Date(year, qStart + 3, 1),
      label: `Q${q} ${year}`,
    };
  }
  // month
  return {
    from: new Date(year, month - 1, 1),
    to: new Date(year, month, 1),
    label: new Date(year, month - 1).toLocaleDateString("en-US", { month: "long", year: "numeric" }),
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleAddExpense(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const expenses = await loadExpenses();

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

  expenses.push(expense);
  await saveExpenses(expenses);

  return {
    success: true,
    output: `Expense logged: ${formatAmount(expense.amount, expense.currency)} — ${expense.description} (${expense.category}) [${expense.id}]`,
  };
}

export async function handleListExpenses(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const expenses = await loadExpenses();
  const from = input.from ? new Date(input.from as string) : null;
  const to = input.to ? new Date(input.to as string) : null;
  const category = input.category as string | undefined;
  const limit = (input.limit as number) ?? 30;

  let filtered = expenses;
  if (from) filtered = filtered.filter((e) => new Date(e.date) >= from);
  if (to) filtered = filtered.filter((e) => new Date(e.date) <= to);
  if (category) filtered = filtered.filter((e) => e.category === category);

  filtered.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  if (filtered.length === 0) {
    return { success: true, output: "No expenses found." };
  }

  const lines = filtered.slice(0, limit).map((e) => {
    const vendor = e.vendor ? ` @ ${e.vendor}` : "";
    return `${e.date}  ${formatAmount(e.amount, e.currency).padEnd(12)} ${e.category.padEnd(14)} ${e.description}${vendor}  [${e.id}]`;
  });

  const total = filtered.reduce((sum, e) => sum + e.amount, 0);
  const countNote = filtered.length > limit ? ` (showing ${limit} of ${filtered.length})` : "";

  return {
    success: true,
    output: `${filtered.length} expense(s)${countNote}:\n\n${lines.join("\n")}\n\nTotal: ${formatAmount(total, filtered[0]?.currency ?? "USD")}`,
  };
}

export async function handleGetExpenseSummary(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const expenses = await loadExpenses();
  const now = new Date();
  const period = (input.period as string) ?? "month";
  const year = (input.year as number) ?? now.getFullYear();
  const month = (input.month as number) ?? now.getMonth() + 1;

  const { from, to, label } = getDateRange(period, year, month);

  const filtered = expenses.filter((e) => {
    const d = new Date(e.date);
    return d >= from && d < to;
  });

  if (filtered.length === 0) {
    return { success: true, output: `No expenses for ${label}.` };
  }

  // Category breakdown
  const byCat: Record<string, number> = {};
  const byVendor: Record<string, number> = {};
  let total = 0;

  for (const e of filtered) {
    byCat[e.category] = (byCat[e.category] ?? 0) + e.amount;
    if (e.vendor) {
      byVendor[e.vendor] = (byVendor[e.vendor] ?? 0) + e.amount;
    }
    total += e.amount;
  }

  const currency = filtered[0]?.currency ?? "USD";

  const catLines = Object.entries(byCat)
    .sort(([, a], [, b]) => b - a)
    .map(([cat, amt]) => `  ${cat.padEnd(14)} ${formatAmount(amt, currency).padStart(12)}  (${Math.round((amt / total) * 100)}%)`);

  const topVendors = Object.entries(byVendor)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([vendor, amt]) => `  ${vendor.padEnd(20)} ${formatAmount(amt, currency).padStart(12)}`);

  let output = `Expense Summary — ${label}\n`;
  output += `${"─".repeat(40)}\n`;
  output += `Total: ${formatAmount(total, currency)} (${filtered.length} expenses)\n\n`;
  output += `By Category:\n${catLines.join("\n")}`;

  if (topVendors.length > 0) {
    output += `\n\nTop Vendors:\n${topVendors.join("\n")}`;
  }

  return { success: true, output };
}

export async function handleDeleteExpense(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const expenses = await loadExpenses();
  const idx = expenses.findIndex((e) => e.id === input.id);
  if (idx === -1) {
    return { success: false, output: `Expense not found: ${input.id}` };
  }

  const [removed] = expenses.splice(idx, 1);
  await saveExpenses(expenses);
  return {
    success: true,
    output: `Deleted: ${formatAmount(removed!.amount, removed!.currency)} — ${removed!.description}`,
  };
}

export async function handleExportExpenses(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const expenses = await loadExpenses();
  const from = input.from ? new Date(input.from as string) : null;
  const to = input.to ? new Date(input.to as string) : null;
  const format = (input.format as string) ?? "csv";

  let filtered = expenses;
  if (from) filtered = filtered.filter((e) => new Date(e.date) >= from);
  if (to) filtered = filtered.filter((e) => new Date(e.date) <= to);

  filtered.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

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
