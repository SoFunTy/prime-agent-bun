// Bun kernel skill. The factory receives the kernel context and returns the
// value bound to the skill's global name. See
// prime-agent-bun-runtime/KERNEL-API.md for the contract.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface RunOptions {
  query: string;
  max_output?: number;
  timeout?: number;
  num_results?: number;
}

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function agentDir(): string {
  return (
    process.env.PRIME_AGENT_CODING_AGENT_DIR ??
    process.env.PI_CODING_AGENT_DIR ??
    join(homedir(), ".prime", "agent")
  );
}

function resolveConfigValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.startsWith("!")) {
    return "";
  }
  return (process.env[trimmed] ?? trimmed).trim();
}

function resolveApiKey(): string {
  const fromEnv = (process.env.SERPER_API_KEY ?? "").trim();
  if (fromEnv !== "") {
    return fromEnv;
  }
  try {
    const auth = JSON.parse(readFileSync(join(agentDir(), "auth.json"), "utf8")) as Record<string, unknown>;
    const cred = auth["serper"];
    if (cred !== null && typeof cred === "object" && (cred as Record<string, unknown>).type === "api_key") {
      return resolveConfigValue(String((cred as Record<string, unknown>).key ?? ""));
    }
  } catch {
    // no saved key
  }
  return "";
}

function formatResults(data: Record<string, unknown>, query: string, numResults: number): string {
  const sections: string[] = [];
  const kg = data.knowledgeGraph as Record<string, unknown> | undefined;
  if (kg) {
    const lines: string[] = [];
    const title = String(kg.title ?? "").trim();
    if (title !== "") {
      lines.push(`Knowledge Graph: ${title}`);
    }
    const description = String(kg.description ?? "").trim();
    if (description !== "") {
      lines.push(description);
    }
    for (const [key, value] of Object.entries((kg.attributes as Record<string, unknown>) ?? {})) {
      const text = String(value).trim();
      if (text !== "") {
        lines.push(`${key}: ${text}`);
      }
    }
    if (lines.length > 0) {
      sections.push(lines.join("\n"));
    }
  }
  const organic = Array.isArray(data.organic) ? data.organic : [];
  organic.slice(0, numResults).forEach((entry, index) => {
    const result = entry as Record<string, unknown>;
    const lines = [`Result ${index}: ${String(result.title ?? "").trim() || "Untitled"}`];
    const link = String(result.link ?? "").trim();
    if (link !== "") {
      lines.push(`URL: ${link}`);
    }
    const snippet = String(result.snippet ?? "").trim();
    if (snippet !== "") {
      lines.push(snippet);
    }
    sections.push(lines.join("\n"));
  });
  const alsoAsk = Array.isArray(data.peopleAlsoAsk) ? data.peopleAlsoAsk.slice(0, 3) : [];
  const questions: string[] = [];
  for (const item of alsoAsk) {
    const question = String((item as Record<string, unknown>).question ?? "").trim();
    if (question === "") {
      continue;
    }
    let entry = `Q: ${question}`;
    const answer = String((item as Record<string, unknown>).snippet ?? "").trim();
    if (answer !== "") {
      entry += `\nA: ${answer}`;
    }
    questions.push(entry);
  }
  if (questions.length > 0) {
    sections.push("People Also Ask:\n" + questions.join("\n"));
  }
  return sections.length === 0 ? `No results returned for query: ${query}` : sections.join("\n\n---\n\n");
}

export default function createSkill() {
  const run = async (options: RunOptions): Promise<string> => {
    const query = options?.query;
    if (typeof query !== "string") {
      throw new TypeError("query must be a string");
    }
    const apiKey = resolveApiKey();
    if (apiKey === "") {
      return [
        "Web search is not set up yet: no Serper API key is configured.",
        "Tell the user how to enable it:",
        "  1. Get a free API key at https://serper.dev (sign up, copy the key).",
        '  2. In Prime Agent, run /mcp, choose "Serper (web search)", and paste the key.',
        "Do not ask the user to set environment variables. Once the key is saved, web search works automatically.",
      ].join("\n");
    }
    const maxOutput = options.max_output ?? 8192;
    const timeoutSeconds = options.timeout ?? envInt("PRIME_AGENT_WEBSEARCH_TIMEOUT", 45);
    const numResults = options.num_results ?? envInt("PRIME_AGENT_WEBSEARCH_NUM_RESULTS", 5);
    let body: string;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
      try {
        const response = await fetch("https://google.serper.dev/search", {
          method: "POST",
          headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ q: query }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Serper search error (${response.status})`);
        }
        body = formatResults((await response.json()) as Record<string, unknown>, query, numResults);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      body = `Error searching for '${query}': ${error instanceof Error ? error.message : String(error)}`;
    }
    let output = `Results for query "${query}":\n\n${body}`;
    if (output.length > maxOutput) {
      const total = output.length;
      const marker = `\n... [output truncated, ${total} chars total] ...\n`;
      const half = Math.max(0, Math.floor((maxOutput - marker.length) / 2));
      output = output.slice(0, half) + marker + output.slice(output.length - half);
      if (output.length > maxOutput) {
        output = output.slice(0, maxOutput);
      }
    }
    return output;
  };
  const callable = (options: RunOptions) => run(options);
  callable.run = run;
  return callable;
}
