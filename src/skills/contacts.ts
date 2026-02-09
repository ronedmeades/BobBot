import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "../providers/types.js";
import type { Contact } from "../db/stores.js";
import {
  storeInsertContact,
  storeGetContactById,
  storeGetAllContacts,
  storeGetContacts,
  storeUpdateContact,
  storeDeleteContact,
  storeReplaceAllContacts,
} from "../db/stores.js";

// Re-export Contact type and persistence wrappers for gmail.ts and invoices.ts
export type { Contact } from "../db/stores.js";

export async function loadContacts(): Promise<Contact[]> {
  return storeGetAllContacts();
}

export async function saveContacts(contacts: Contact[]): Promise<void> {
  return storeReplaceAllContacts(contacts);
}

interface ToolResult {
  success: boolean;
  output: string;
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

  await storeInsertContact(contact);

  return {
    success: true,
    output: `Contact added: ${formatContact(contact)} (ID: ${contact.id})`,
  };
}

export async function handleSearchContacts(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const query = (input.query as string).toLowerCase();
  const tagFilter = input.tag as string | undefined;
  const relFilter = input.relationship as string | undefined;

  // Get candidates from store (filtered by tag/relationship if given)
  const candidates = await storeGetContacts({ tag: tagFilter, relationship: relFilter, limit: 10000 });

  // Apply fuzzy scoring in JS (same algorithm as before)
  const terms = query.split(/\s+/).filter(Boolean);

  const scored = candidates
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
  const contact = await storeGetContactById(input.id as string);
  if (!contact) {
    return { success: false, output: `Contact not found: ${input.id}` };
  }
  return { success: true, output: formatContact(contact, true) };
}

export async function handleUpdateContact(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const id = input.id as string;
  const fields: Partial<Contact> = {};
  const updatable = ["name", "email", "phone", "company", "role", "relationship", "address", "notes", "tags"];
  for (const key of updatable) {
    if (input[key] !== undefined) {
      (fields as Record<string, unknown>)[key] = input[key];
    }
  }
  fields.updated_at = new Date().toISOString();

  const contact = await storeUpdateContact(id, fields);
  if (!contact) {
    return { success: false, output: `Contact not found: ${id}` };
  }
  return { success: true, output: `Updated: ${formatContact(contact)}` };
}

export async function handleDeleteContact(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const removed = await storeDeleteContact(input.id as string);
  if (!removed) {
    return { success: false, output: `Contact not found: ${input.id}` };
  }
  return { success: true, output: `Deleted contact: ${removed.name}` };
}

export async function handleListContacts(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const tagFilter = input.tag as string | undefined;
  const relFilter = input.relationship as string | undefined;
  const limit = (input.limit as number) ?? 50;

  const filtered = await storeGetContacts({ tag: tagFilter, relationship: relFilter, limit });

  if (filtered.length === 0) {
    return { success: true, output: "No contacts found." };
  }

  const lines = filtered.map((c) => formatContact(c));
  const allContacts = await storeGetContacts({ tag: tagFilter, relationship: relFilter, limit: 10000 });
  const countNote = allContacts.length > limit ? `\n\n(showing ${limit} of ${allContacts.length})` : "";

  return {
    success: true,
    output: `${allContacts.length} contact(s):\n\n${lines.join("\n")}${countNote}`,
  };
}
