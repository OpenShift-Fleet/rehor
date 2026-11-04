import { afterEach, describe, expect, it, vi } from "vitest";

import * as entrypoint from "../src/runtimes/opencode/vertex-provider";

const { createVertexProxyProvider } = entrypoint;

afterEach(() => vi.unstubAllEnvs());

describe("Vertex proxy provider adapter", () => {
  it("exports the factory discovered by the V2 AI SDK plugin", () => {
    // @opencode/core 2.1.2 plugin/provider/sdk-factory.ts selects the first create* export.
    expect(Object.keys(entrypoint)).toEqual(["createVertexProxyProvider"]);
    const factory =
      // biome-ignore lint/performance/noDynamicNamespaceImportAccess: reproduce V2's dynamic factory discovery.
      entrypoint[
        Object.keys(entrypoint).find((key) => key.startsWith("create")) as keyof typeof entrypoint
      ];
    const provider = factory();
    expect(provider.specificationVersion).toBe("v3");
    expect(typeof provider).toBe("function");

    for (const id of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5@20251001"]) {
      const model = provider.languageModel(id);
      expect(model.specificationVersion).toBe("v3");
      expect(model.modelId).toBe(id);
    }
  });

  it.each([undefined, "http://127.0.0.1:8443"])(
    "preserves V2's injected transport and proxy-only auth with baseURL %s",
    async (baseURL) => {
      vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/nonexistent/rehor-no-adc.json");
      vi.stubEnv("GOOGLE_VERTEX_PROJECT", "must-not-use-project");
      vi.stubEnv("GOOGLE_VERTEX_LOCATION", "must-not-use-location");
      const transport = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "msg_mock",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "hello" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
      const controller = new AbortController();
      const model = createVertexProxyProvider({ baseURL, fetch: transport }).languageModel(
        "claude-sonnet-4-6",
      );
      const result = await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "Say hello" }] }],
        abortSignal: controller.signal,
      });

      expect(result.content).toEqual([{ type: "text", text: "hello" }]);
      expect(transport).toHaveBeenCalledOnce();
      const [url, request] = transport.mock.calls[0];
      expect(String(url)).toBe(
        `${baseURL ?? "http://devbot-proxy:8443"}/v1/projects/dummy-project/locations/dummy-region/publishers/anthropic/models/claude-sonnet-4-6:rawPredict`,
      );
      expect(new Headers(request?.headers).get("authorization")).toBe(
        "Bearer rehor-proxy-placeholder",
      );
      expect(request?.signal).toBe(controller.signal);
      expect(JSON.parse(String(request?.body))).toMatchObject({
        anthropic_version: "vertex-2023-10-16",
        messages: [{ role: "user", content: [{ type: "text", text: "Say hello" }] }],
      });
    },
  );

  it.each([
    "https://aiplatform.googleapis.com",
    "https://devbot-proxy:8443",
    "http://devbot-proxy:8450",
    "http://devbot-proxy",
    "http://user:password@devbot-proxy:8443",
    "http://devbot-proxy:8443/v1",
    "http://devbot-proxy:8443?project=other",
    "http://devbot-proxy:8443#other",
  ])("rejects provider URL %s", (baseURL) => {
    expect(() => createVertexProxyProvider({ baseURL })).toThrow(
      "Vertex provider must use Rehor proxy",
    );
  });
});
