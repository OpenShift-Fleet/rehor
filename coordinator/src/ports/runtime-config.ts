/** Provider-neutral MCP transport configuration forwarded to a runtime adapter. */
export type McpServerConfig =
  | {
      type?: "stdio";
      command: string;
      args?: readonly string[];
      env?: Readonly<Record<string, string>>;
      timeout?: number;
      alwaysLoad?: boolean;
    }
  | {
      type: "http" | "sse";
      url: string;
      headers?: Readonly<Record<string, string>>;
      timeout?: number;
      alwaysLoad?: boolean;
    };
