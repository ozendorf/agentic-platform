export const BUILTIN_CAPABILITIES: Record<string, string> = {
  "repo:read": "Read files in the run's workspace",
  "repo:write": "Create or modify files in the run's workspace",
  exec: "Run allowlisted commands in the workspace",
  "github:read": "Read from GitHub (clone, API reads)",
  "github:write": "Push branches, open PRs, write to GitHub",
};

export function describeCapability(c: string): string {
  if (BUILTIN_CAPABILITIES[c]) return BUILTIN_CAPABILITIES[c];
  const [ns, level] = c.split(":");
  return `${level === "read" ? "Read from" : "Write to"} ${ns} (MCP)`;
}

export function isWrite(c: string) {
  return c === "exec" || c.endsWith(":write");
}
