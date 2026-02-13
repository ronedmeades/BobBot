import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseWhen, parseSnoozeDuration, formatReminder } from "../../src/skills/reminders.js";

describe("parseWhen", () => {
  beforeEach(() => {
    // Freeze time at 2026-06-15 12:00:00 UTC (a Monday)
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses ISO date string", () => {
    const result = parseWhen("2026-03-15T10:00:00.000Z");
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe("2026-03-15T10:00:00.000Z");
  });

  it("parses 'in 5 minutes'", () => {
    const result = parseWhen("in 5 minutes");
    expect(result).not.toBeNull();
    const diff = result!.getTime() - Date.now();
    expect(diff).toBeCloseTo(5 * 60 * 1000, -3);
  });

  it("parses 'in 2 hours'", () => {
    const result = parseWhen("in 2 hours");
    expect(result).not.toBeNull();
    const diff = result!.getTime() - Date.now();
    expect(diff).toBeCloseTo(2 * 60 * 60 * 1000, -3);
  });

  it("parses 'in 3 days'", () => {
    const result = parseWhen("in 3 days");
    expect(result).not.toBeNull();
    const diff = result!.getTime() - Date.now();
    expect(diff).toBeCloseTo(3 * 24 * 60 * 60 * 1000, -3);
  });

  it("parses 'in 1 week'", () => {
    const result = parseWhen("in 1 week");
    expect(result).not.toBeNull();
    const diff = result!.getTime() - Date.now();
    expect(diff).toBeCloseTo(7 * 24 * 60 * 60 * 1000, -3);
  });

  it("parses 'tomorrow' as next day at 9am", () => {
    const result = parseWhen("tomorrow");
    expect(result).not.toBeNull();
    expect(result!.getDate()).toBe(16);
    expect(result!.getHours()).toBe(9);
  });

  it("parses 'tomorrow morning' as next day at 9am", () => {
    const result = parseWhen("tomorrow morning");
    expect(result).not.toBeNull();
    expect(result!.getHours()).toBe(9);
  });

  it("parses 'tomorrow evening' as next day at 6pm", () => {
    const result = parseWhen("tomorrow evening");
    expect(result).not.toBeNull();
    expect(result!.getHours()).toBe(18);
  });

  it("parses 'tomorrow afternoon' as next day at 2pm", () => {
    const result = parseWhen("tomorrow afternoon");
    expect(result).not.toBeNull();
    expect(result!.getHours()).toBe(14);
  });

  it("parses 'today evening' as today at 6pm", () => {
    const result = parseWhen("today evening");
    expect(result).not.toBeNull();
    expect(result!.getDate()).toBe(15);
    expect(result!.getHours()).toBe(18);
  });

  it("parses 'today afternoon' as today at 2pm", () => {
    const result = parseWhen("today afternoon");
    expect(result).not.toBeNull();
    expect(result!.getHours()).toBe(14);
  });

  it("parses 'next friday' correctly", () => {
    // Current day is Monday (June 15). Next Friday is June 19.
    const result = parseWhen("next friday");
    expect(result).not.toBeNull();
    expect(result!.getDay()).toBe(5); // Friday
    expect(result!.getHours()).toBe(9);
    expect(result!.getDate()).toBe(19);
  });

  it("parses 'next monday' as 7 days ahead when today is Monday", () => {
    // Current day is Monday. Next Monday should be +7 days.
    const result = parseWhen("next monday");
    expect(result).not.toBeNull();
    expect(result!.getDay()).toBe(1); // Monday
    expect(result!.getDate()).toBe(22);
  });

  it("parses 'in half an hour'", () => {
    const result = parseWhen("in half an hour");
    expect(result).not.toBeNull();
    const diff = result!.getTime() - Date.now();
    expect(diff).toBeCloseTo(30 * 60 * 1000, -3);
  });

  it("parses 'in an hour'", () => {
    const result = parseWhen("in an hour");
    expect(result).not.toBeNull();
    const diff = result!.getTime() - Date.now();
    expect(diff).toBeCloseTo(60 * 60 * 1000, -3);
  });

  it("returns null for unparseable input", () => {
    expect(parseWhen("sometime later")).toBeNull();
  });

  it("parses 'in 1 min' shorthand", () => {
    const result = parseWhen("in 1 min");
    expect(result).not.toBeNull();
    const diff = result!.getTime() - Date.now();
    expect(diff).toBeCloseTo(60 * 1000, -3);
  });

  it("parses 'in 1 hr' shorthand", () => {
    const result = parseWhen("in 1 hr");
    expect(result).not.toBeNull();
    const diff = result!.getTime() - Date.now();
    expect(diff).toBeCloseTo(60 * 60 * 1000, -3);
  });
});

describe("parseSnoozeDuration", () => {
  it("parses '30 minutes'", () => {
    expect(parseSnoozeDuration("30 minutes")).toBe(30 * 60 * 1000);
  });

  it("parses '2 hours'", () => {
    expect(parseSnoozeDuration("2 hours")).toBe(2 * 60 * 60 * 1000);
  });

  it("parses '1 day'", () => {
    expect(parseSnoozeDuration("1 day")).toBe(24 * 60 * 60 * 1000);
  });

  it("parses '5 min' shorthand", () => {
    expect(parseSnoozeDuration("5 min")).toBe(5 * 60 * 1000);
  });

  it("parses '1 hr' shorthand", () => {
    expect(parseSnoozeDuration("1 hr")).toBe(60 * 60 * 1000);
  });

  it("returns default 1 hour for unparseable input", () => {
    expect(parseSnoozeDuration("later")).toBe(60 * 60 * 1000);
  });
});

describe("formatReminder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const baseReminder = {
    id: "abc123",
    message: "Test reminder",
    created_at: "2026-06-15T11:00:00.000Z",
    snooze_count: 0,
    dismissed: false,
  };

  it("shows OVERDUE for past reminders", () => {
    const result = formatReminder({
      ...baseReminder,
      remind_at: "2026-06-15T10:00:00.000Z", // 2 hours ago
    });
    expect(result).toContain("OVERDUE");
    expect(result).toContain("abc123");
    expect(result).toContain("Test reminder");
  });

  it("shows minutes for reminders due within the hour", () => {
    const result = formatReminder({
      ...baseReminder,
      remind_at: "2026-06-15T12:30:00.000Z", // 30 min from now
    });
    expect(result).toContain("in 30 min");
  });

  it("shows hours for reminders due within 24h", () => {
    const result = formatReminder({
      ...baseReminder,
      remind_at: "2026-06-15T17:00:00.000Z", // 5 hours from now
    });
    expect(result).toContain("in 5 hours");
  });

  it("shows snooze count when snoozed", () => {
    const result = formatReminder({
      ...baseReminder,
      remind_at: "2026-06-15T13:00:00.000Z",
      snooze_count: 2,
    });
    expect(result).toContain("(snoozed 2x)");
  });

  it("shows dismissed status", () => {
    const result = formatReminder({
      ...baseReminder,
      remind_at: "2026-06-15T13:00:00.000Z",
      dismissed: true,
    });
    expect(result).toContain("[dismissed]");
  });
});
