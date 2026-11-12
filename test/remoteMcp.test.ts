import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runWithTenant, type TenantContext } from "../src/paths.js";
import {
  assertSafeUrl,
  deleteConnection,
  describeConnections,
  isPrivateAddress,
  remoteMcpServers,
  remoteToolGroups,
  remoteToolNamesFor,
  saveConnection,
  slugify,
  testConnection,
} from "../src/tools/remoteMcp.js";
import { buildToolDefRegistry } from "../src/providers/toolRegistry.js";
import { toAiSdkTools } from "../src/providers/toolAdapter.js";

const tenant = (organizationId: string): TenantContext => ({
  userId: "u1",
  email: "u1@example.com",
  name: "U One",
  organizationId,
  organizationName: organizationId,
});

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
    "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.63.255.255", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows %s", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("assertSafeUrl", () => {
  it("rejects anything but https unless private targets are allowed", async () => {
    await expect(assertSafeUrl("http://93.184.216.34/mcp")).rejects.toThrow(/https/);
    await expect(assertSafeUrl("ftp://93.184.216.34/mcp")).rejects.toThrow(/https/);
    await expect(assertSafeUrl("nonsense")).rejects.toThrow(/valid URL/);
  });

  it("rejects credentials in the URL", async () => {
    await expect(assertSafeUrl("https://user:pw@93.184.216.34/mcp")).rejects.toThrow(/username or password/);
  });

  it("rejects loopback, private, metadata and localhost targets", async () => {
    for (const url of ["https://127.0.0.1/mcp", "https://[::1]/mcp", "https://10.0.0.5/mcp", "https://169.254.169.254/latest", "https://localhost/mcp"]) {
      await expect(assertSafeUrl(url), url).rejects.toThrow(/private or internal|Could not resolve/);
    }
  });

  it("accepts a public https address", async () => {
    await expect(assertSafeUrl("https://93.184.216.34/mcp")).resolves.toBeInstanceOf(URL);
  });
});

describe("slugify", () => {
  it("makes a short tool-name-safe id", () => {
    expect(slugify("Fandb ERP")).toBe("fandb_erp");
    expect(slugify("  --RMS (Prod)--  ")).toBe("rms_prod");
    expect(slugify("A very long connection name that keeps going")).toBe("a_very_long_connecti");
    expect(slugify("Ends at a break point!!")).toBe("ends_at_a_break_poin");
    expect(slugify("***")).toBe("");
  });
});

describe("remote MCP connection (end to end against a local MCP server)", () => {
  const KEY = "s3cret-key-1234";
  let http: Server;
  let url: string;

  beforeAll(async () => {
    process.env.REMOTE_MCP_ALLOW_PRIVATE = "true";
    const app = express();
    app.use(express.json());
    app.post("/mcp", async (req, res) => {
      if (req.headers.authorization !== `Bearer ${KEY}`) {
        // Echoes the header back, like a careless server might, so the test proves the key is redacted.
        res.status(401).json({ error: `bad key: ${req.headers.authorization}` });
        return;
      }
      const server = new McpServer({ name: "fake-erp", version: "1.0.0" });
      server.registerTool(
        "get_sales",
        {
          description: "Sales totals for a date range",
          inputSchema: { from: z.string().describe("Start date, YYYY-MM-DD"), limit: z.number().int().optional() },
          annotations: { readOnlyHint: true },
        },
        async ({ from, limit }) => ({ content: [{ type: "text" as const, text: `sales since ${from} (limit ${limit ?? "none"}): 42` }] }),
      );
      server.registerTool("refund_order", { description: "Refund an order", inputSchema: { id: z.string() } }, async () => ({
        content: [{ type: "text" as const, text: "refunded" }],
      }));
      server.registerTool(
        "delete_all",
        { description: "Delete everything", inputSchema: {}, annotations: { readOnlyHint: false, destructiveHint: true } },
        async () => ({ content: [{ type: "text" as const, text: "gone" }] }),
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
    await new Promise<void>((resolve) => {
      http = app.listen(0, "127.0.0.1", resolve);
    });
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  });

  afterAll(async () => {
    delete process.env.REMOTE_MCP_ALLOW_PRIVATE;
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });

  it("discovers only read-only tools and reports the rest as hidden", async () => {
    await runWithTenant(tenant("org-a"), async () => {
      const conn = await saveConnection({ name: "Fandb ERP", url, key: KEY });
      expect(conn.id).toBe("fandb_erp");
      const status = await testConnection(conn.id);
      expect(status).toMatchObject({ status: "ok", toolCount: 1, hiddenCount: 2 });
    });
  });

  it("gives its tools to the configured agents only, under a namespaced name", async () => {
    await runWithTenant(tenant("org-a"), async () => {
      expect(remoteToolNamesFor("finance")).toEqual(["mcp__remote_fandb_erp__get_sales"]);
      expect(remoteToolNamesFor("analysis")).toHaveLength(1);
      expect(remoteToolNamesFor("hr")).toEqual([]);
    });
  });

  it("registers for the Claude path and the fallback/Codex registry", async () => {
    await runWithTenant(tenant("org-a"), async () => {
      expect(Object.keys(remoteMcpServers())).toEqual(["remote_fandb_erp"]);
      expect(remoteToolGroups().map((g) => g.server)).toEqual(["remote_fandb_erp"]);
      expect(buildToolDefRegistry().has("mcp__remote_fandb_erp__get_sales")).toBe(true);
    });
  });

  it("calls the remote tool, passing arguments and labelling the result as untrusted data", async () => {
    await runWithTenant(tenant("org-a"), async () => {
      const [def] = remoteToolGroups()[0].defs;
      const result = await def.handler({ from: "2026-01-01", limit: 5 }, undefined);
      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("untrusted data");
      expect(text).toContain("sales since 2026-01-01 (limit 5): 42");
    });
  });

  it("exposes a schema the AI SDK fallback path accepts", async () => {
    await runWithTenant(tenant("org-a"), async () => {
      const tools = toAiSdkTools(remoteToolGroups()[0].defs);
      expect(Object.keys(tools)).toEqual(["get_sales"]);
    });
  });

  it("never returns the key from the API view", async () => {
    await runWithTenant(tenant("org-a"), async () => {
      const view = JSON.stringify(describeConnections());
      expect(view).not.toContain(KEY);
      expect(describeConnections()[0].keyMasked).toBe("••••1234");
    });
  });

  it("keeps the stored key when updated without one", async () => {
    await runWithTenant(tenant("org-a"), async () => {
      await saveConnection({ name: "Fandb ERP", url, agents: ["finance"] });
      expect(await testConnection("fandb_erp")).toMatchObject({ status: "ok", toolCount: 1 });
      expect(remoteToolNamesFor("finance")).toHaveLength(1);
      expect(remoteToolNamesFor("analysis")).toEqual([]);
    });
  });

  it("reports a rejected key as an error, without leaking it, and drops the tools", async () => {
    await runWithTenant(tenant("org-a"), async () => {
      await saveConnection({ name: "Fandb ERP", url, key: "wrong-key-9999" });
      const status = await testConnection("fandb_erp");
      expect(status?.status).toBe("error");
      expect(status?.toolCount).toBe(0);
      expect(status?.error).toContain("bad key"); // the server's message is still shown...
      expect(JSON.stringify(status)).not.toContain("wrong-key-9999"); // ...but not the key it echoed
      expect(remoteToolNamesFor("finance")).toEqual([]);
    });
  });

  it("is invisible to other organizations", async () => {
    await runWithTenant(tenant("org-b"), async () => {
      expect(describeConnections()).toEqual([]);
      expect(remoteToolNamesFor("finance")).toEqual([]);
    });
  });

  it("requires a key for a new connection", async () => {
    await runWithTenant(tenant("org-b"), async () => {
      await expect(saveConnection({ name: "No Key", url })).rejects.toThrow(/key is required/);
    });
  });

  it("refuses a private URL when the operator hasn't allowed them", async () => {
    delete process.env.REMOTE_MCP_ALLOW_PRIVATE;
    try {
      await runWithTenant(tenant("org-b"), async () => {
        await expect(saveConnection({ name: "Internal", url, key: KEY })).rejects.toThrow(/https/);
        await expect(saveConnection({ name: "Internal", url: "https://127.0.0.1/mcp", key: KEY })).rejects.toThrow(/private or internal/);
      });
    } finally {
      process.env.REMOTE_MCP_ALLOW_PRIVATE = "true";
    }
  });

  it("deletes a connection and its tools", async () => {
    await runWithTenant(tenant("org-a"), async () => {
      expect(deleteConnection("fandb_erp")).toBe(true);
      expect(deleteConnection("fandb_erp")).toBe(false);
      expect(describeConnections()).toEqual([]);
      expect(remoteToolNamesFor("finance")).toEqual([]);
    });
  });
});
