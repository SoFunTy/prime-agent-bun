// Bun kernel skill. The factory receives the kernel context and returns the
// value bound to the skill's global name. See
// prime-agent-bun-runtime/KERNEL-API.md for the contract.
export default function createSkill(ctx: {
  hostRequest(type: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>>;
}) {
  return {
    get: () => ctx.hostRequest("goal.get"),
    create: (options: { objective: string; token_budget?: number; tokenBudget?: number }) => {
      const objective = options?.objective;
      const budget = options?.token_budget ?? options?.tokenBudget;
      if (typeof objective !== "string") {
        throw new TypeError("objective must be a string");
      }
      if (budget !== undefined && !Number.isInteger(budget)) {
        throw new TypeError("token_budget must be an integer");
      }
      const payload: Record<string, unknown> = { objective };
      if (budget !== undefined) {
        payload.token_budget = budget;
      }
      return ctx.hostRequest("goal.create", payload);
    },
    complete: () => ctx.hostRequest("goal.complete"),
  };
}
