import { describe, it, expect, beforeEach } from "vitest";
import {
  getIsBusy,
  setIsBusy,
  getActiveContext,
  requestPreempt,
  isPreemptRequested,
  clearPreempt,
} from "../../src/tasks/busy-state.js";

describe("busy-state", () => {
  beforeEach(() => {
    setIsBusy(false);
    clearPreempt();
  });

  describe("getIsBusy / setIsBusy", () => {
    it("defaults to not busy", () => {
      expect(getIsBusy()).toBe(false);
    });

    it("sets busy to true", () => {
      setIsBusy(true, "chat");
      expect(getIsBusy()).toBe(true);
    });

    it("clears busy state", () => {
      setIsBusy(true, "chat");
      setIsBusy(false);
      expect(getIsBusy()).toBe(false);
    });
  });

  describe("getActiveContext", () => {
    it("defaults to null", () => {
      expect(getActiveContext()).toBeNull();
    });

    it("returns chat when set to chat", () => {
      setIsBusy(true, "chat");
      expect(getActiveContext()).toBe("chat");
    });

    it("returns worker when set to worker", () => {
      setIsBusy(true, "worker");
      expect(getActiveContext()).toBe("worker");
    });

    it("resets to null when busy cleared", () => {
      setIsBusy(true, "chat");
      setIsBusy(false);
      expect(getActiveContext()).toBeNull();
    });

    it("returns null when busy set without context", () => {
      setIsBusy(true);
      expect(getActiveContext()).toBeNull();
    });
  });

  describe("preemption", () => {
    it("defaults to no preemption requested", () => {
      expect(isPreemptRequested()).toBe(false);
    });

    it("requestPreempt sets the flag", () => {
      requestPreempt();
      expect(isPreemptRequested()).toBe(true);
    });

    it("clearPreempt resets the flag", () => {
      requestPreempt();
      clearPreempt();
      expect(isPreemptRequested()).toBe(false);
    });

    it("double requestPreempt is idempotent", () => {
      requestPreempt();
      requestPreempt();
      expect(isPreemptRequested()).toBe(true);
    });
  });
});
