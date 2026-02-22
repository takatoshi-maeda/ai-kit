import type {
  ProgressTracker,
  ProgressGoal,
  ProgressStep,
  ProgressStatus,
  ProgressType,
  ProgressListener,
} from "../types/agent.js";

export class ProgressTrackerImpl implements ProgressTracker {
  private _goals: ProgressGoal[] = [];
  private listeners = new Set<ProgressListener>();
  private nextId = 0;

  get goals(): ProgressGoal[] {
    return this._goals;
  }

  subscribe(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  addGoal(title: string, type: ProgressType): ProgressGoal {
    const goal: ProgressGoal = {
      id: String(this.nextId++),
      title,
      type,
      status: "pending",
      steps: [],
    };
    this._goals.push(goal);
    this.notify();
    return goal;
  }

  updateGoalStatus(goalId: string, status: ProgressStatus): void {
    const goal = this._goals.find((g) => g.id === goalId);
    if (!goal) return;
    goal.status = status;
    this.notify();
  }

  addStep(
    goalId: string,
    title: string,
    options?: {
      description?: string;
      tags?: string[];
      status?: ProgressStatus;
    },
  ): ProgressStep {
    const goal = this._goals.find((g) => g.id === goalId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);
    const step: ProgressStep = {
      id: String(this.nextId++),
      title,
      description: options?.description,
      status: options?.status ?? "pending",
      tags: options?.tags,
    };
    goal.steps.push(step);
    this.notify();
    return step;
  }

  updateStepStatus(
    goalId: string,
    stepId: string,
    status: ProgressStatus,
  ): void {
    const goal = this._goals.find((g) => g.id === goalId);
    if (!goal) return;
    const step = goal.steps.find((s) => s.id === stepId);
    if (!step) return;
    step.status = status;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this._goals);
    }
  }
}
