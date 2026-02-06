// WARNING: This module stores sensitive PII (SSN, EIN, bank account numbers, etc.) locally
// in local/vault/vault.json. Users should ensure their disk is encrypted (BitLocker, FileVault,
// LUKS) and that the local/ directory is never committed to version control (it is gitignored).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

interface ToolResult {
  success: boolean;
  output: string;
}

// --- Vault Types ---

interface VaultField {
  value: string;
  label?: string;
}

interface VaultData {
  [category: string]: {
    [field: string]: VaultField;
  };
}

// --- Vault File Path ---

function getVaultPath(): string {
  return resolve(process.cwd(), "local", "vault", "vault.json");
}

// --- Vault I/O ---

async function loadVault(): Promise<VaultData> {
  const vaultPath = getVaultPath();
  try {
    const raw = await readFile(vaultPath, "utf-8");
    return JSON.parse(raw) as VaultData;
  } catch {
    return {};
  }
}

async function saveVault(vault: VaultData): Promise<void> {
  const vaultPath = getVaultPath();
  await mkdir(dirname(vaultPath), { recursive: true });
  await writeFile(vaultPath, JSON.stringify(vault, null, 2), "utf-8");
}

// --- Fuzzy Matching ---

const FIELD_ALIASES: Array<{ patterns: string[]; category: string; field: string }> = [
  // Personal — Name
  { patterns: ["legal name", "full name", "name", "your name", "applicant name", "owner name"], category: "personal", field: "legal_name" },
  { patterns: ["first name", "given name", "fname"], category: "personal", field: "first_name" },
  { patterns: ["last name", "surname", "family name", "lname"], category: "personal", field: "last_name" },
  { patterns: ["ssn", "social security", "social security number", "social"], category: "personal", field: "ssn" },
  { patterns: ["date of birth", "dob", "birth date", "birthday"], category: "personal", field: "date_of_birth" },
  { patterns: ["phone", "phone number", "telephone", "mobile", "cell", "contact number"], category: "personal", field: "phone" },
  { patterns: ["email", "email address", "e-mail", "contact email"], category: "personal", field: "email" },
  { patterns: ["address", "street", "address line 1", "street address", "mailing address", "home address", "residential address"], category: "personal", field: "address_line1" },
  { patterns: ["address line 2", "apt", "suite", "unit", "apartment"], category: "personal", field: "address_line2" },
  { patterns: ["city", "town"], category: "personal", field: "city" },
  { patterns: ["state", "province", "state/province"], category: "personal", field: "state" },
  { patterns: ["zip", "zip code", "postal code", "zipcode", "zip/postal"], category: "personal", field: "zip" },
  { patterns: ["country", "nation"], category: "personal", field: "country" },
  // Business
  { patterns: ["business name", "company name", "company", "organization", "org name", "entity name"], category: "business", field: "business_name" },
  { patterns: ["ein", "employer id", "employer identification number", "tax id", "tin", "federal tax id", "fein", "employer id number"], category: "business", field: "ein" },
  { patterns: ["business type", "entity type", "organization type", "business structure", "legal structure"], category: "business", field: "business_type" },
  { patterns: ["business address", "company address", "office address", "principal address"], category: "business", field: "business_address" },
  { patterns: ["business phone", "company phone", "office phone", "work phone"], category: "business", field: "business_phone" },
  { patterns: ["business email", "company email", "work email", "office email"], category: "business", field: "business_email" },
  { patterns: ["state tax id", "state id", "state tax number", "state ein"], category: "business", field: "state_tax_id" },
  { patterns: ["dba", "dba name", "doing business as", "trade name", "fictitious name"], category: "business", field: "dba_name" },
  // Banking
  { patterns: ["bank name", "bank", "financial institution", "depository"], category: "banking", field: "bank_name" },
  { patterns: ["routing number", "routing", "aba number", "aba routing", "transit number"], category: "banking", field: "routing_number" },
  { patterns: ["account number", "account no", "account #", "bank account", "acct number", "acct no"], category: "banking", field: "account_number" },
  { patterns: ["account type", "acct type", "checking or savings", "type of account"], category: "banking", field: "account_type" },
  // Tax
  { patterns: ["filing status", "tax filing status", "federal filing status"], category: "tax", field: "filing_status" },
  { patterns: ["tax year", "fiscal year", "reporting year"], category: "tax", field: "tax_year" },
  { patterns: ["prior year agi", "previous year agi", "last year agi", "adjusted gross income", "agi"], category: "tax", field: "prior_year_agi" },
];

function normalize(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[_\-./\\#]+/g, " ")
    .replace(/\s+/g, " ");
}

interface FieldMatch {
  category: string;
  field: string;
}

function matchFieldToVault(formLabel: string): FieldMatch | null {
  const normalized = normalize(formLabel);
  // Pass 1: Exact match against patterns
  for (const entry of FIELD_ALIASES) {
    for (const pattern of entry.patterns) {
      if (normalized === pattern) {
        return { category: entry.category, field: entry.field };
      }
    }
  }
  // Pass 2: Substring match
  for (const entry of FIELD_ALIASES) {
    for (const pattern of entry.patterns) {
      if (normalized.includes(pattern) || pattern.includes(normalized)) {
        return { category: entry.category, field: entry.field };
      }
    }
  }
  // Pass 3: Field name match
  const asFieldName = normalized.replace(/\s+/g, "_");
  for (const entry of FIELD_ALIASES) {
    if (entry.field === asFieldName) {
      return { category: entry.category, field: entry.field };
    }
  }
  return null;
}

// --- Tool Definitions ---

export const formFillerToolDefinitions: Anthropic.Tool[] = [
  {
    name: "save_personal_data",
    description:
      "Save a field to the personal data vault for form auto-filling. Stores data locally in local/vault/vault.json. Categories: personal, business, banking, tax.",
    input_schema: {
      type: "object" as const,
      properties: {
        category: { type: "string", description: "Data category (e.g. personal, business, banking, tax)" },
        field: { type: "string", description: "Field name using snake_case (e.g. legal_name, ssn, ein)" },
        value: { type: "string", description: "The value to store" },
        label: { type: "string", description: "Optional human-friendly label (e.g. Social Security Number)" },
      },
      required: ["category", "field", "value"],
    },
  },
  {
    name: "load_personal_data",
    description: "Load data from the personal data vault. Can load a specific field, all fields in a category, or the entire vault.",
    input_schema: {
      type: "object" as const,
      properties: {
        category: { type: "string", description: "Category to load from. Omit to load all categories." },
        field: { type: "string", description: "Specific field to load. Omit to load all fields in the category." },
      },
      required: [],
    },
  },
  {
    name: "list_personal_data",
    description: "List all stored categories and field names in the vault. Returns field names only, NOT values, for security.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "delete_personal_data",
    description: "Delete a specific field from the personal data vault.",
    input_schema: {
      type: "object" as const,
      properties: {
        category: { type: "string", description: "Category containing the field to delete" },
        field: { type: "string", description: "Field name to delete" },
      },
      required: ["category", "field"],
    },
  },
  {
    name: "fill_form_fields",
    description: "Given a list of form field names/labels, match them to vault data and return values. Uses fuzzy matching.",
    input_schema: {
      type: "object" as const,
      properties: {
        fields: { type: "array", items: { type: "string" }, description: "List of form field names/labels to fill" },
      },
      required: ["fields"],
    },
  },
  {
    name: "suggest_form_mapping",
    description: "Analyze form field names and suggest vault mappings without revealing stored values.",
    input_schema: {
      type: "object" as const,
      properties: {
        fields: { type: "array", items: { type: "string" }, description: "List of form field names/labels to analyze" },
      },
      required: ["fields"],
    },
  },
];

// --- Tool Handlers ---

export async function handleSavePersonalData(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const category = input.category as string;
  const field = input.field as string;
  const value = input.value as string;
  const label = input.label as string | undefined;
  if (!category || !field || value === undefined) {
    return { success: false, output: "Missing required parameters: category, field, and value." };
  }
  const vault = await loadVault();
  if (!vault[category]) vault[category] = {};
  const entry: VaultField = { value };
  if (label) entry.label = label;
  vault[category][field] = entry;
  await saveVault(vault);
  const displayLabel = label ? ` (${label})` : "";
  return { success: true, output: `Saved ${category}.${field}${displayLabel} to vault.` };
}

export async function handleLoadPersonalData(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const category = input.category as string | undefined;
  const field = input.field as string | undefined;
  const vault = await loadVault();

  if (category && field) {
    const value = vault[category]?.[field];
    if (!value) {
      return { success: false, output: `No data found for ${category}.${field}` };
    }
    return { success: true, output: `${category}.${field}: ${value.value}` };
  }

  if (category) {
    const cat = vault[category];
    if (!cat || Object.keys(cat).length === 0) {
      return { success: false, output: `No data found in category "${category}"` };
    }
    const lines = Object.entries(cat).map(
      ([k, v]) => `${k}: ${v.value}${v.label ? ` (${v.label})` : ""}`
    );
    return { success: true, output: `${category}:\n${lines.join("\n")}` };
  }

  // Load everything
  const categories = Object.keys(vault);
  if (categories.length === 0) {
    return { success: true, output: "Vault is empty. Use save_personal_data to add entries." };
  }

  const sections: string[] = [];
  for (const cat of categories) {
    const lines = Object.entries(vault[cat]).map(
      ([k, v]) => `  ${k}: ${v.value}${v.label ? ` (${v.label})` : ""}`
    );
    sections.push(`[${cat}]\n${lines.join("\n")}`);
  }
  return { success: true, output: sections.join("\n\n") };
}

export async function handleListPersonalData(): Promise<ToolResult> {
  const vault = await loadVault();
  const categories = Object.keys(vault);

  if (categories.length === 0) {
    return { success: true, output: "Vault is empty." };
  }

  const sections: string[] = [];
  for (const cat of categories) {
    const fields = Object.entries(vault[cat]).map(
      ([k, v]) => `  - ${k}${v.label ? ` (${v.label})` : ""}`
    );
    sections.push(`${cat}:\n${fields.join("\n")}`);
  }
  return {
    success: true,
    output: `Stored fields (values hidden):\n\n${sections.join("\n\n")}`,
  };
}

export async function handleDeletePersonalData(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const category = input.category as string;
  const field = input.field as string;

  if (!category || !field) {
    return { success: false, output: "Both category and field are required." };
  }

  const vault = await loadVault();
  if (!vault[category]?.[field]) {
    return { success: false, output: `No entry found for ${category}.${field}` };
  }

  delete vault[category][field];
  if (Object.keys(vault[category]).length === 0) {
    delete vault[category];
  }
  await saveVault(vault);

  return { success: true, output: `Deleted ${category}.${field} from vault.` };
}

export async function handleFillFormFields(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const fields = input.fields as string[];
  if (!fields || fields.length === 0) {
    return { success: false, output: "Provide a list of form field names/labels to fill." };
  }

  const vault = await loadVault();
  const results: string[] = [];
  let matched = 0;

  for (const formLabel of fields) {
    const match = matchFieldToVault(formLabel);
    if (match) {
      const value = vault[match.category]?.[match.field];
      if (value) {
        results.push(`"${formLabel}" -> ${value.value}`);
        matched++;
      } else {
        results.push(`"${formLabel}" -> matched ${match.category}.${match.field} but no value stored`);
      }
    } else {
      results.push(`"${formLabel}" -> no match found`);
    }
  }

  return {
    success: true,
    output:
      `Matched ${matched}/${fields.length} fields:\n\n${results.join("\n")}` +
      (matched < fields.length
        ? `\n\nTip: Use save_personal_data to add missing values.`
        : ""),
  };
}

export async function handleSuggestFormMapping(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const fields = input.fields as string[];
  if (!fields || fields.length === 0) {
    return { success: false, output: "Provide a list of form field names/labels to analyze." };
  }

  const vault = await loadVault();
  const results: string[] = [];

  for (const formLabel of fields) {
    const match = matchFieldToVault(formLabel);
    if (match) {
      const hasValue = !!vault[match.category]?.[match.field];
      const status = hasValue ? "ready" : "needs value";
      results.push(`"${formLabel}" -> ${match.category}.${match.field} [${status}]`);
    } else {
      results.push(`"${formLabel}" -> no automatic match`);
    }
  }

  return {
    success: true,
    output: `Field mapping suggestions:\n\n${results.join("\n")}`,
  };
}
