// Bun kernel skill. The factory receives the kernel context and returns the
// value bound to the skill's global name. See
// prime-agent-bun-runtime/KERNEL-API.md for the contract.
export default function createSkill(ctx: {
  hostRequest(type: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>>;
}) {
  return {
    status: () => ctx.hostRequest("refine.status"),
    run: (options: { instructions?: string; global_?: boolean; global?: boolean } = {}) => {
      const payload: Record<string, unknown> = {};
      if (options?.instructions !== undefined) {
        if (typeof options.instructions !== "string") {
          throw new TypeError("instructions must be a string");
        }
        payload.instructions = options.instructions;
      }
      const global = options?.global_ ?? options?.global;
      if (global !== undefined && typeof global !== "boolean") {
        throw new TypeError("global_ must be a boolean");
      }
      if (global === true) {
        payload.global = true;
      }
      return ctx.hostRequest("refine.run", payload);
    },
  };
}
