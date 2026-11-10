// Bun kernel skill. The factory receives the kernel context and returns the
// value bound to the skill's global name. See
// prime-agent-bun-runtime/KERNEL-API.md for the contract.
export default function createSkill(ctx: {
  hostRequest(type: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>>;
}) {
  return {
    list_agents: () => ctx.hostRequest("agent_observe.list"),
    get_agent: (options: { target: string }) => {
      if (typeof options?.target !== "string") {
        throw new TypeError("target must be a string");
      }
      return ctx.hostRequest("agent_observe.get", { target: options.target });
    },
    recent_messages: (options: { target: string; limit?: number; max_chars?: number }) => {
      const { target, limit = 8, max_chars = 800 } = options ?? {};
      if (typeof target !== "string" || !Number.isInteger(limit) || !Number.isInteger(max_chars)) {
        throw new TypeError("target must be a string and limit/max_chars integers");
      }
      return ctx.hostRequest("agent_observe.recent", { target, limit, max_chars });
    },
  };
}
