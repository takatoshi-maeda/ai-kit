import { describe, it, expect, vi } from "vitest";
import { ProgressTrackerImpl } from "../../src/agent/progress.js";

describe("ProgressTrackerImpl", () => {
  it("starts with no goals", () => {
    const tracker = new ProgressTrackerImpl();
    expect(tracker.goals).toEqual([]);
  });

  describe("addGoal", () => {
    it("adds a goal with pending status", () => {
      const tracker = new ProgressTrackerImpl();
      const goal = tracker.addGoal("Research", "thinking");

      expect(goal.title).toBe("Research");
      expect(goal.type).toBe("thinking");
      expect(goal.status).toBe("pending");
      expect(goal.steps).toEqual([]);
      expect(tracker.goals).toHaveLength(1);
    });

    it("assigns unique ids", () => {
      const tracker = new ProgressTrackerImpl();
      const g1 = tracker.addGoal("A", "thinking");
      const g2 = tracker.addGoal("B", "search");

      expect(g1.id).not.toBe(g2.id);
    });
  });

  describe("updateGoalStatus", () => {
    it("updates goal status", () => {
      const tracker = new ProgressTrackerImpl();
      const goal = tracker.addGoal("Research", "thinking");

      tracker.updateGoalStatus(goal.id, "in_progress");
      expect(tracker.goals[0].status).toBe("in_progress");

      tracker.updateGoalStatus(goal.id, "completed");
      expect(tracker.goals[0].status).toBe("completed");
    });

    it("ignores unknown goal id", () => {
      const tracker = new ProgressTrackerImpl();
      tracker.updateGoalStatus("unknown", "completed");
      // No error thrown
    });
  });

  describe("addStep", () => {
    it("adds step to goal", () => {
      const tracker = new ProgressTrackerImpl();
      const goal = tracker.addGoal("Research", "thinking");
      const step = tracker.addStep(goal.id, "Step 1", {
        description: "First step",
        tags: ["tag1"],
        status: "in_progress",
      });

      expect(step.title).toBe("Step 1");
      expect(step.description).toBe("First step");
      expect(step.status).toBe("in_progress");
      expect(step.tags).toEqual(["tag1"]);
      expect(goal.steps).toHaveLength(1);
    });

    it("defaults step status to pending", () => {
      const tracker = new ProgressTrackerImpl();
      const goal = tracker.addGoal("Research", "thinking");
      const step = tracker.addStep(goal.id, "Step 1");

      expect(step.status).toBe("pending");
    });

    it("throws for unknown goal id", () => {
      const tracker = new ProgressTrackerImpl();

      expect(() => tracker.addStep("unknown", "Step 1")).toThrow(
        "Goal not found",
      );
    });
  });

  describe("updateStepStatus", () => {
    it("updates step status", () => {
      const tracker = new ProgressTrackerImpl();
      const goal = tracker.addGoal("Research", "thinking");
      const step = tracker.addStep(goal.id, "Step 1");

      tracker.updateStepStatus(goal.id, step.id, "completed");

      expect(goal.steps[0].status).toBe("completed");
    });

    it("ignores unknown goal or step id", () => {
      const tracker = new ProgressTrackerImpl();
      const goal = tracker.addGoal("Research", "thinking");

      tracker.updateStepStatus("unknown", "unknown", "completed");
      tracker.updateStepStatus(goal.id, "unknown", "completed");
      // No errors thrown
    });
  });

  describe("subscribe", () => {
    it("notifies listeners on goal add", () => {
      const tracker = new ProgressTrackerImpl();
      const listener = vi.fn();
      tracker.subscribe(listener);

      tracker.addGoal("Research", "thinking");

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(tracker.goals);
    });

    it("notifies listeners on status changes", () => {
      const tracker = new ProgressTrackerImpl();
      const listener = vi.fn();

      const goal = tracker.addGoal("Research", "thinking");
      tracker.subscribe(listener);

      tracker.updateGoalStatus(goal.id, "in_progress");
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("notifies on step add and update", () => {
      const tracker = new ProgressTrackerImpl();
      const listener = vi.fn();

      const goal = tracker.addGoal("Research", "thinking");
      tracker.subscribe(listener);

      const step = tracker.addStep(goal.id, "Step 1");
      expect(listener).toHaveBeenCalledTimes(1);

      tracker.updateStepStatus(goal.id, step.id, "completed");
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it("returns unsubscribe function", () => {
      const tracker = new ProgressTrackerImpl();
      const listener = vi.fn();
      const unsub = tracker.subscribe(listener);

      tracker.addGoal("A", "thinking");
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();
      tracker.addGoal("B", "thinking");
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });
});
