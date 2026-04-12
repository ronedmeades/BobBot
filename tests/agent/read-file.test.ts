import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeTool } from "../../src/agent/tool-executor.js";

const testDir = join(tmpdir(), "bob-read-file-test-" + Date.now());

beforeAll(async () => {
  await mkdir(testDir, { recursive: true });
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("read_file smart handling", () => {
  describe("small files", () => {
    it("reads entire file when under 100KB", async () => {
      const filePath = join(testDir, "small.txt");
      const content = "line 1\nline 2\nline 3\n";
      await writeFile(filePath, content, "utf-8");

      const result = await executeTool("read_file", { path: filePath });
      expect(result.success).toBe(true);
      expect(result.output).toBe(content);
    });

    it("returns full content without line numbers for small files", async () => {
      const filePath = join(testDir, "no-numbers.txt");
      await writeFile(filePath, "hello world", "utf-8");

      const result = await executeTool("read_file", { path: filePath });
      expect(result.output).toBe("hello world");
      expect(result.output).not.toContain("[LARGE FILE");
    });
  });

  describe("large files", () => {
    const largePath = join(testDir, "large.txt");

    beforeAll(async () => {
      // Create a file > 100KB with numbered lines
      const lines = Array.from({ length: 5000 }, (_, i) => `Line ${i + 1}: ${"x".repeat(30)}`);
      await writeFile(largePath, lines.join("\n"), "utf-8");
    });

    it("returns preview with metadata for files over 100KB", async () => {
      const result = await executeTool("read_file", { path: largePath });
      expect(result.success).toBe(true);
      expect(result.output).toContain("[LARGE FILE");
      expect(result.output).toContain("5000 lines");
      expect(result.output).toContain("--- HEAD ---");
      expect(result.output).toContain("--- TAIL ---");
      expect(result.output).toContain("lines omitted");
    });

    it("shows first 50 lines in head section", async () => {
      const result = await executeTool("read_file", { path: largePath });
      expect(result.output).toContain("1: Line 1:");
      expect(result.output).toContain("50: Line 50:");
    });

    it("shows last 20 lines in tail section", async () => {
      const result = await executeTool("read_file", { path: largePath });
      expect(result.output).toContain("4981: Line 4981:");
      expect(result.output).toContain("5000: Line 5000:");
    });

    it("includes chunking instructions", async () => {
      const result = await executeTool("read_file", { path: largePath });
      expect(result.output).toContain("offset");
      expect(result.output).toContain("limit");
    });
  });

  describe("chunked reading with offset/limit", () => {
    const chunkedPath = join(testDir, "chunked.txt");

    beforeAll(async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
      await writeFile(chunkedPath, lines.join("\n"), "utf-8");
    });

    it("returns specific line range", async () => {
      const result = await executeTool("read_file", { path: chunkedPath, offset: 10, limit: 5 });
      expect(result.success).toBe(true);
      expect(result.output).toContain("[Lines 10-14 of 100");
      expect(result.output).toContain("10: Line 10");
      expect(result.output).toContain("14: Line 14");
      expect(result.output).not.toContain("15: Line 15");
    });

    it("defaults to 200 lines when only offset provided", async () => {
      const result = await executeTool("read_file", { path: chunkedPath, offset: 1 });
      expect(result.success).toBe(true);
      expect(result.output).toContain("[Lines 1-100 of 100");
    });

    it("clamps offset to 1 minimum", async () => {
      const result = await executeTool("read_file", { path: chunkedPath, offset: 0, limit: 5 });
      expect(result.success).toBe(true);
      expect(result.output).toContain("1: Line 1");
    });

    it("clamps to end of file when offset+limit exceeds total", async () => {
      const result = await executeTool("read_file", { path: chunkedPath, offset: 95, limit: 50 });
      expect(result.success).toBe(true);
      expect(result.output).toContain("[Lines 95-100 of 100");
      expect(result.output).toContain("100: Line 100");
    });
  });

  describe("output capping", () => {
    it("truncates output at 50000 chars with a message", async () => {
      const filePath = join(testDir, "borderline.txt");
      // Create a file under 100KB but with output > 50K chars
      const lines = Array.from({ length: 2000 }, (_, i) => `${"data".repeat(10)}-${i}`);
      await writeFile(filePath, lines.join("\n"), "utf-8");

      const result = await executeTool("read_file", { path: filePath });
      expect(result.success).toBe(true);
      if (result.output.length > 50100) {
        // Should have been truncated
        expect(result.output).toContain("truncated");
        expect(result.output).toContain("offset/limit");
      }
    });
  });

  describe("signal propagation", () => {
    it("returns cancelled when signal is already aborted", async () => {
      const filePath = join(testDir, "signal-test.txt");
      await writeFile(filePath, "test content", "utf-8");

      const controller = new AbortController();
      controller.abort();

      const result = await executeTool("read_file", { path: filePath }, { userId: "test", signal: controller.signal });
      expect(result.success).toBe(false);
      expect(result.output).toContain("Cancelled by user");
    });
  });

  describe("blocked paths", () => {
    it("blocks .env files", async () => {
      const result = await executeTool("read_file", { path: "/home/user/.env" });
      expect(result.success).toBe(false);
      expect(result.output).toContain("credential files");
    });
  });

  describe("missing files", () => {
    it("returns file not found for nonexistent paths", async () => {
      const result = await executeTool("read_file", { path: join(testDir, "nonexistent.txt") });
      expect(result.success).toBe(false);
      expect(result.output).toContain("File not found");
    });
  });
});
