// Bun kernel skill. The factory receives the kernel context and returns the
// value bound to the skill's global name. See
// prime-agent-bun-runtime/KERNEL-API.md for the contract.
const MESSAGE_MIME = "application/vnd.prime-agent.agent-message+json";
const ROLES = ["parent", "sibling", "child"];

interface SendOptions {
  message?: string;
  broadcast_message?: string;
  broadcast?: string;
  receiver_role?: string;
  receiverRole?: string;
  receiver_name?: string;
  receiverName?: string;
}

export default function createSkill(ctx: {
  hostRequest(type: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>>;
  emit(data: Record<string, unknown>): void;
}) {
  const send = async (options: SendOptions = {}): Promise<Record<string, unknown>> => {
    const broadcast = options.broadcast_message ?? options.broadcast;
    const receiverRole = options.receiver_role ?? options.receiverRole;
    const receiverName = options.receiver_name ?? options.receiverName;
    let payload: Record<string, unknown>;
    if (broadcast !== undefined) {
      if (options.message !== undefined && options.message !== "all") {
        throw new TypeError("use receiver_role and receiver_name for direct messages");
      }
      if (receiverRole !== undefined || receiverName !== undefined) {
        throw new TypeError("broadcast cannot be combined with receiver_role/receiver_name");
      }
      payload = { target: "all", message: broadcast };
    } else {
      if (!ROLES.includes(receiverRole as string)) {
        throw new Error('receiver_role must be "parent", "sibling", or "child"');
      }
      if (typeof options.message !== "string") {
        throw new TypeError("message must be a string");
      }
      if (receiverRole === "parent") {
        if (receiverName !== undefined) {
          throw new Error("receiver_name must be omitted for parent messages");
        }
      } else if (typeof receiverName !== "string" || receiverName.trim() === "") {
        throw new Error("receiver_name is required for sibling and child messages");
      }
      payload = { message: options.message, receiver_role: receiverRole, receiver_name: receiverName };
    }
    const receipt = await ctx.hostRequest("agent_message.send", payload);
    const receipts = receipt.receipts;
    if (Array.isArray(receipts)) {
      for (const item of receipts) {
        if (item !== null && typeof item === "object" && "deliveryStatus" in (item as object)) {
          emitSent((item as Record<string, unknown>), receiverRole);
        }
      }
    } else {
      emitSent(receipt, receiverRole);
    }
    return receipt;
  };

  const emitSent = (receipt: Record<string, unknown>, receiverRole: string | undefined): void => {
    try {
      const label = receipt.deliveryStatus === "queued" ? "Agent message queued" : "Agent message sent";
      const display: Record<string, unknown> = { ...receipt };
      if (receiverRole !== undefined && ROLES.includes(receiverRole)) {
        display.receiverRole = receiverRole;
      }
      ctx.emit({ [MESSAGE_MIME]: display, "text/plain": label });
    } catch {
      // display is best-effort
    }
  };

  const callable = (options: SendOptions) => send(options);
  callable.send = send;
  callable.run = send;
  return callable;
}
