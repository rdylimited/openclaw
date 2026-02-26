import type { AgentTool } from "@mariozechner/pi-agent-core";
import { toToolDefinitions } from "../pi-tool-definition-adapter.js";

type AnyAgentTool = AgentTool;

// When openaiCompletionsTools is enabled, pass tools via builtInTools so the SDK
// includes them in the API request's `tools` parameter (native structured tool calling).
// Otherwise, pass via customTools (text descriptions injected into system prompt).
export function splitSdkTools(options: {
  tools: AnyAgentTool[];
  sandboxEnabled: boolean;
  useNativeTools?: boolean;
}): {
  builtInTools: AnyAgentTool[];
  customTools: ReturnType<typeof toToolDefinitions>;
} {
  const { tools, useNativeTools } = options;
  if (useNativeTools) {
    return {
      builtInTools: tools,
      customTools: [],
    };
  }
  return {
    builtInTools: [],
    customTools: toToolDefinitions(tools),
  };
}
