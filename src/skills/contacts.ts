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

export interface Contact {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  role?: string;
  relationship?: string;
  address?: string;
  notes?: string;
  tags?: string[];
  created_at: string;
  updated_at: string;
}

interface ContactStore {
  version: number;
  contacts: Contact[];
}

const CONTACTS_PATH = resolve("memory/contacts.json");

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function loadContacts(): Promise<Contact[]> {
  try {
    const raw = await readFile(CONTACTS_PATH, "utf-8");
    const store = JSON.parse(raw) as ContactStore;
    return store.contacts ?? [];
  } catch {
    return [];
  }
}

export async function saveContacts(contacts: Contact[]): Promise<void> {
  const store: ContactStore = { version: 1, contacts };
  await mkdir(dirname(CONTACTS_PATH), { recursive: true });
  await writeFile(CONTACTS_PATH, JSON.stringify(store, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const contactsToolDefinitions: ToolDefinition[] = [
  {
    name: "add_contact",
    description: "Add a new contact to the address book.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Contact's full name" },
        email: { type: "string", description: "Email address" },
        phone: { type: "string", description: "Phone number" },
        company: { type: "string", description: "Company or organization" },
        role: { type: "string", description: "Job title or role" },
        relationship: {
          type: "string",
          description: "Relationship type (e.g. client, vendor, friend, accountant, lawyer)",
        },
        address: { type: "string", description: "Mailing address" },
        notes: { type: "string", description: "Free-form notes about this contact" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for categorization",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "search_contacts",
    description:
      "Search contacts by name, company, email, or tag. Returns matching contacts ranked by relevance.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
        tag: { type: "string", description: "Filter by tag" },
        relationship: { type: "string", description: "Filter by relationship type" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_contact",
    description: "Get full details of a specific contact by ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Contact ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "update_contact",
    description: "Update an existing contact. Only provided fields are changed.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Contact ID to update" },
        name: { type: "string", description: "New name" },
        email: { type: "string", description: "New email" },
        phone: { type: "string", description: "New phone" },
        company: { type: "string", description: "New company" },
        role: { type: "string", description: "New role" },
        relationship: { type: "string", description: "New relationship type" },
        address: { type: "string", description: "New address" },
        notes: { type: "string", description: "New notes" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "New tags (replaces existing)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_contact",
    description: "Delete a contact by ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Contact ID to delete" },
      },
      required: ["id"],
    },
  },
  {
    name: "list_contacts",
    description: "List all contacts, optionally filtered by tag or relationship.",
    input_schema: {
      type: "object" as const,
      properties: {
        tag: { type: "string", description: "Filter by tag" },
        relationship: { type: "string", description: "Filter by relationship type" },
        limit: { type: "number", description: "Max contacts to return (default: 50)" },
      },
      required: [],
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatContact(c: Contact, detailed = false): string {
  const parts = [c.name];
  if (c.company) parts.push(`@ ${c.company}`);
  if (c.role) parts.push(`(${c.role})`);

  let line = parts.join(" ");
  if (detailed) {
    if (c.email) line += `\n  Email: ${c.email}`;
    if (c.phone) line += `\n  Phone: ${c.phone}`;
    if (c.address) line += `\n  Address: ${c.address}`;
    if (c.relationship) line += `\n  Relationship: ${c.relationship}`;
    if (c.tags && c.tags.length > 0) line += `\n  Tags: ${c.tags.join(", ")}`;
    if (c.notes) line += `\n  Notes: ${c.notes}`;
    line += `\n  ID: ${c.id}`;
  } else {
    const extras: string[] = [];
    if (c.email) extras.push(c.email);
    if (c.phone) extras.push(c.phone);
    if (c.relationship) extras.push(c.relationship);
    if (extras.length > 0) line += ` — ${extras.join(", ")}`;
  }
  return line;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleAddContact(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const contacts = await loadContacts();
  const now = new Date().toISOString();

  const contact: Contact = {
    id: randomUUID().slice(0, 8),
    name: input.name as string,
    email: input.email as string | undefined,
    phone: input.phone as string | undefined,
    company: input.company as string | undefined,
    role: input.role as string | undefined,
    relationship: input.relationship as string | undefined,
    address: input.address as string | undefined,
    notes: input.notes as string | undefined,
    tags: input.tags as string[] | undefined,
    created_at: now,
    updated_at: now,
  };

  contacts.push(contact);
  await saveContacts(contacts);

  return {
    success: true,
    output: `Contact added: ${formatContact(contact)} (ID: ${contact.id})`,
  };
}

export async function handleSearchContacts(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const contacts = await loadContacts();
  const query = (input.query as string).toLowerCase();
  const tagFilter = input.tag as string | undefined;
  const relFilter = input.relationship as string | undefined;

  const terms = query.split(/\s+/).filter(Boolean);

  const scored = contacts
    .filter((c) => {
      if (tagFilter && (!c.tags || !c.tags.some((t) => t.toLowerCase() === tagFilter.toLowerCase()))) {
        return false;
      }
      if (relFilter && c.relationship?.toLowerCase() !== relFilter.toLowerCase()) {
        return false;
      }
      return true;
    })
    .map((c) => {
      const searchable = [
        c.name, c.email, c.phone, c.company, c.role,
        c.relationship, c.notes, ...(c.tags ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      let score = 0;
      for (const term of terms) {
        if (searchable.includes(term)) score++;
      }
      // Exact name match bonus
      if (c.name.toLowerCase().includes(query)) score += 3;
      return { contact: c, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { success: true, output: `No contacts found matching "${input.query}".` };
  }

  const lines = scored.slice(0, 20).map((s) => formatContact(s.contact, true));
  return {
    success: true,
    output: `Found ${scored.length} contact(s):\n\n${lines.join("\n\n")}`,
  };
}

export async function handleGetContact(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const contacts = await loadContacts();
  const contact = contacts.find((c) => c.id === input.id);
  if (!contact) {
    return { success: false, output: `Contact not found: ${input.id}` };
  }
  return { success: true, output: formatContact(contact, true) };
}

export async function handleUpdateContact(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const contacts = await loadContacts();
  const idx = contacts.findIndex((c) => c.id === input.id);
  if (idx === -1) {
    return { success: false, output: `Contact not found: ${input.id}` };
  }

  const contact = contacts[idx]!;
  const updatable = ["name", "email", "phone", "company", "role", "relationship", "address", "notes", "tags"];
  for (const key of updatable) {
    if (input[key] !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (contact as any)[key] = input[key];
    }
  }
  contact.updated_at = new Date().toISOString();

  await saveContacts(contacts);
  return { success: true, output: `Updated: ${formatContact(contact)}` };
}

export async function handleDeleteContact(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const contacts = await loadContacts();
  const idx = contacts.findIndex((c) => c.id === input.id);
  if (idx === -1) {
    return { success: false, output: `Contact not found: ${input.id}` };
  }

  const [removed] = contacts.splice(idx, 1);
  await saveContacts(contacts);
  return { success: true, output: `Deleted contact: ${removed!.name}` };
}

export async function handleListContacts(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const contacts = await loadContacts();
  const tagFilter = input.tag as string | undefined;
  const relFilter = input.relationship as string | undefined;
  const limit = (input.limit as number) ?? 50;

  let filtered = contacts;
  if (tagFilter) {
    filtered = filtered.filter(
      (c) => c.tags && c.tags.some((t) => t.toLowerCase() === tagFilter.toLowerCase())
    );
  }
  if (relFilter) {
    filtered = filtered.filter(
      (c) => c.relationship?.toLowerCase() === relFilter.toLowerCase()
    );
  }

  if (filtered.length === 0) {
    return { success: true, output: "No contacts found." };
  }

  const sorted = filtered.sort((a, b) => a.name.localeCompare(b.name));
  const lines = sorted.slice(0, limit).map((c) => formatContact(c));
  const countNote = sorted.length > limit ? `\n\n(showing ${limit} of ${sorted.length})` : "";

  return {
    success: true,
    output: `${sorted.length} contact(s):\n\n${lines.join("\n")}${countNote}`,
  };
}
