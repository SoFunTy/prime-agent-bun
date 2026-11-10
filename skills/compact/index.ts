// Bun kernel skill. The factory receives the kernel context and returns the
// value bound to the skill's global name. See
// prime-agent-bun-runtime/KERNEL-API.md for the contract.
export default function createSkill(ctx: {
  hostRequest(type: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>>;
}) {
  return {
    status: () => ctx.hostRequest("compact.status"),
    run: (options: { instructions?: string } = {}) => {
      const payload: Record<string, unknown> = {};
      if (options?.instructions !== undefined) {
        if (typeof options.instructions !== "string") {
          throw new TypeError("instructions must be a string");
        }
        payload.instructions = options.instructions;
      }
      return ctx.hostRequest("compact.run", payload);
    },
  };
}
