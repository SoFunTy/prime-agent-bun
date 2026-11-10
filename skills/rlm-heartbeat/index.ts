// Bun kernel skill. The factory receives the kernel context and returns the
// value bound to the skill's global name. See
// prime-agent-bun-runtime/KERNEL-API.md for the contract.
const DELIVERY_MODES = ["steer", "follow_up"];

function normalizeDeliveryMode(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TypeError("delivery_mode must be a string");
  }
  if (!DELIVERY_MODES.includes(value)) {
    throw new Error('delivery_mode must be "steer" or "follow_up"');
  }
  return value;
}

export default function createSkill(ctx: {
  hostRequest(type: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>>;
}) {
  return {
    list: (options: { include_inactive?: boolean } = {}) => {
      const includeInactive = options?.include_inactive ?? false;
      if (typeof includeInactive !== "boolean") {
        throw new TypeError("include_inactive must be a boolean");
      }
      return ctx.hostRequest("rlm_heartbeat.list", { include_inactive: includeInactive });
    },
    create: (options: {
      instruction: string;
      interval?: string;
      label?: string;
      delivery_mode?: string;
      deliveryMode?: string;
    }) => {
      if (typeof options?.instruction !== "string") {
        throw new TypeError("instruction must be a string");
      }
      const payload: Record<string, unknown> = { instruction: options.instruction };
      if (options.interval !== undefined) {
        payload.interval = options.interval;
      }
      if (options.label !== undefined) {
        payload.label = options.label;
      }
      const mode = normalizeDeliveryMode(options.delivery_mode ?? options.deliveryMode);
      if (mode !== undefined) {
        payload.delivery_mode = mode;
      }
      return ctx.hostRequest("rlm_heartbeat.create", payload);
    },
    update: (options: {
      id: string;
      status?: string;
      instruction?: string;
      interval?: string;
      label?: string;
      delivery_mode?: string;
    }) => {
      if (typeof options?.id !== "string") {
        throw new TypeError("id must be a string");
      }
      const payload: Record<string, unknown> = { id: options.id };
      for (const key of ["status", "instruction", "interval", "label"] as const) {
        if (options[key] !== undefined) {
          payload[key] = options[key];
        }
      }
      const mode = normalizeDeliveryMode(options.delivery_mode);
      if (mode !== undefined) {
        payload.delivery_mode = mode;
      }
      return ctx.hostRequest("rlm_heartbeat.update", payload);
    },
    delete: (options: { id: string }) => {
      if (typeof options?.id !== "string") {
        throw new TypeError("id must be a string");
      }
      return ctx.hostRequest("rlm_heartbeat.delete", { id: options.id });
    },
  };
}
