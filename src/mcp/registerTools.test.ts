import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hasExplicitMutationConfirmation, registerEasyEdaTools } from "./registerTools.js";

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function makeClient(bridge: { endpoint: string; getStatus: () => unknown; call: ReturnType<typeof vi.fn> }): Promise<Client> {
  const server = new McpServer({
    name: "test-server",
    version: "0.0.0"
  });
  registerEasyEdaTools(server, bridge as never);

  const client = new Client({
    name: "test-client",
    version: "0.0.0"
  });
  clients.push(client);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ]);
  return client;
}

describe("mutation confirmation guard", () => {
  it("accepts explicit confirmation phrases", () => {
    expect(hasExplicitMutationConfirmation("confirma salvar")).toBe(true);
    expect(hasExplicitMutationConfirmation("I confirm this save")).toBe(true);
  });

  it("rejects vague or missing confirmation", () => {
    expect(hasExplicitMutationConfirmation("pode salvar")).toBe(false);
    expect(hasExplicitMutationConfirmation("save it")).toBe(false);
  });

  it("blocks mutating actions without explicit confirmation", async () => {
    const bridge = {
      endpoint: "ws://127.0.0.1:8765",
      getStatus: () => ({ connected: true, updatedAt: new Date().toISOString() }),
      call: vi.fn()
    };
    const client = await makeClient(bridge);

    const result = await client.callTool({
      name: "easyeda_confirmed_action",
      arguments: {
        action: "save",
        confirmation: "pode salvar"
      }
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain('Action "save" was blocked');
    expect(bridge.call).not.toHaveBeenCalled();
  });

  it("forwards confirmed actions to the bridge", async () => {
    const bridge = {
      endpoint: "ws://127.0.0.1:8765",
      getStatus: () => ({ connected: true, updatedAt: new Date().toISOString() }),
      call: vi.fn(async () => ({ saved: true, documentUuid: "doc-123" }))
    };
    const client = await makeClient(bridge);

    const result = await client.callTool({
      name: "easyeda_confirmed_action",
      arguments: {
        action: "save",
        confirmation: "confirma salvar",
        timeoutMs: 12_345
      }
    });

    expect(bridge.call).toHaveBeenCalledWith("confirmedAction", {
      action: "save",
      confirmation: "confirma salvar",
      params: undefined
    }, 12_345);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      action: "save",
      result: {
        saved: true,
        documentUuid: "doc-123"
      }
    });
  });

  it("forwards verify_connections checks and preserves structured results", async () => {
    const bridge = {
      endpoint: "ws://127.0.0.1:8765",
      getStatus: () => ({ connected: true, updatedAt: new Date().toISOString() }),
      call: vi.fn(async () => ({
        checks: [
          {
            id: "u5-vcc",
            type: "pin_on_net",
            status: "pass",
            message: "Pin is on expected net.",
            evidence: {
              reason: "matched node",
              nodeIds: ["node:1"],
              nets: ["VBUS"]
            }
          }
        ],
        summary: {
          passed: 1,
          warnings: 0,
          failed: 0,
          unknown: 0
        },
        confidence: "high"
      }))
    };
    const client = await makeClient(bridge);

    const result = await client.callTool({
      name: "easyeda_verify_connections",
      arguments: {
        checks: [
          {
            id: "u5-vcc",
            type: "pin_on_net",
            component: "U5",
            pinName: "VCC",
            net: "VBUS"
          }
        ],
        maxHops: 6,
        timeoutMs: 20_000
      }
    });

    expect(bridge.call).toHaveBeenCalledWith("verifyConnections", {
      checks: [
        {
          id: "u5-vcc",
          type: "pin_on_net",
          component: "U5",
          pinName: "VCC",
          net: "VBUS"
        }
      ],
      includeRaw: false,
      allPages: true,
      maxHops: 6
    }, 20_000);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      result: {
        summary: {
          passed: 1,
          failed: 0
        },
        confidence: "high"
      }
    });
  });

  it("returns a doctor report without calling the bridge RPC layer", async () => {
    const bridge = {
      endpoint: "ws://127.0.0.1:8765",
      getStatus: () => ({
        connected: false,
        connectionState: "disconnected",
        message: "Extension not connected.",
        updatedAt: new Date().toISOString()
      }),
      call: vi.fn()
    };
    const client = await makeClient(bridge);

    const result = await client.callTool({
      name: "easyeda_doctor",
      arguments: {}
    });

    expect(bridge.call).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("diagnostics");
    expect(result.structuredContent).toMatchObject({
      doctor: {
        bridge: {
          endpoint: "ws://127.0.0.1:8765"
        },
        extension: {
          connected: false
        }
      }
    });
  });

  it("forwards device library searches to the bridge", async () => {
    const bridge = {
      endpoint: "ws://127.0.0.1:8765",
      getStatus: () => ({ connected: true, updatedAt: new Date().toISOString() }),
      call: vi.fn(async () => ({
        query: "C141836",
        count: 1,
        devices: [{ uuid: "dev-1", libraryUuid: "lib-sys", name: "TLV62569DBVR" }]
      }))
    };
    const client = await makeClient(bridge);

    const result = await client.callTool({
      name: "easyeda_search_devices",
      arguments: { query: "C141836", limit: 5 }
    });

    expect(bridge.call).toHaveBeenCalledWith("libSearchDevices", {
      query: "C141836",
      limit: 5,
      page: 1
    }, 15_000);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      result: {
        count: 1,
        devices: [{ uuid: "dev-1" }]
      }
    });
  });

  it("blocks schematic draw batches without explicit confirmation", async () => {
    const bridge = {
      endpoint: "ws://127.0.0.1:8765",
      getStatus: () => ({ connected: true, updatedAt: new Date().toISOString() }),
      call: vi.fn()
    };
    const client = await makeClient(bridge);

    const result = await client.callTool({
      name: "easyeda_sch_draw",
      arguments: {
        confirmation: "draw it",
        ops: [{ op: "netLabel", net: "GND", x: 0, y: 0 }]
      }
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("blocked");
    expect(bridge.call).not.toHaveBeenCalled();
  });

  it("forwards confirmed schematic draw batches to the bridge", async () => {
    const bridge = {
      endpoint: "ws://127.0.0.1:8765",
      getStatus: () => ({ connected: true, updatedAt: new Date().toISOString() }),
      call: vi.fn(async () => ({
        completed: 2,
        failed: 0,
        results: [
          { index: 0, op: "placeComponent", ok: true, primitiveId: "$u1", pins: [] },
          { index: 1, op: "wire", ok: true, primitiveId: "$w1" }
        ]
      }))
    };
    const client = await makeClient(bridge);

    const result = await client.callTool({
      name: "easyeda_sch_draw",
      arguments: {
        confirmation: "I confirm drawing these primitives",
        ops: [
          {
            op: "placeComponent",
            device: { uuid: "dev-1", libraryUuid: "lib-sys" },
            x: 100,
            y: 200,
            designator: "U1"
          },
          { op: "wire", points: [[100, 200, 140, 200]], net: "VBUS_5V" }
        ],
        timeoutMs: 45_000
      }
    });

    expect(bridge.call).toHaveBeenCalledWith("schDraw", {
      ops: [
        {
          op: "placeComponent",
          device: { uuid: "dev-1", libraryUuid: "lib-sys" },
          x: 100,
          y: 200,
          designator: "U1"
        },
        { op: "wire", points: [[100, 200, 140, 200]], net: "VBUS_5V" }
      ],
      continueOnError: false
    }, 45_000);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      result: {
        completed: 2,
        failed: 0
      }
    });
  });

  it("rejects draw ops that do not match the op schema", async () => {
    const bridge = {
      endpoint: "ws://127.0.0.1:8765",
      getStatus: () => ({ connected: true, updatedAt: new Date().toISOString() }),
      call: vi.fn()
    };
    const client = await makeClient(bridge);

    const result = await client.callTool({
      name: "easyeda_sch_draw",
      arguments: {
        confirmation: "I confirm",
        ops: [{ op: "placeComponent", x: 0, y: 0 }]
      }
    });

    expect(result.isError).toBe(true);
    expect(bridge.call).not.toHaveBeenCalled();
  });

  it("gates schematic deletes behind explicit confirmation and forwards ids", async () => {
    const bridge = {
      endpoint: "ws://127.0.0.1:8765",
      getStatus: () => ({ connected: true, updatedAt: new Date().toISOString() }),
      call: vi.fn(async () => ({
        results: [{ primitiveId: "$u1", type: "Component", deleted: true }]
      }))
    };
    const client = await makeClient(bridge);

    const blocked = await client.callTool({
      name: "easyeda_sch_delete",
      arguments: { confirmation: "delete them", primitiveIds: ["$u1"] }
    });
    expect(blocked.isError).toBe(true);
    expect(bridge.call).not.toHaveBeenCalled();

    const result = await client.callTool({
      name: "easyeda_sch_delete",
      arguments: { confirmation: "confirmed, delete", primitiveIds: ["$u1"] }
    });
    expect(bridge.call).toHaveBeenCalledWith("schDelete", {
      primitiveIds: ["$u1"]
    }, 30_000);
    expect(result.isError).toBeFalsy();
  });

  it("gates PCB draw batches behind confirmation and forwards ops", async () => {
    const bridge = {
      endpoint: "ws://127.0.0.1:8765",
      getStatus: () => ({ connected: true, updatedAt: new Date().toISOString() }),
      call: vi.fn(async () => ({ completed: 1, failed: 0, results: [{ index: 0, op: "moveComponent", ok: true, primitiveId: "$u6" }] }))
    };
    const client = await makeClient(bridge);

    const blocked = await client.callTool({
      name: "easyeda_pcb_draw",
      arguments: {
        confirmation: "move it",
        ops: [{ op: "moveComponent", designator: "U6", x: 100, y: 100 }]
      }
    });
    expect(blocked.isError).toBe(true);
    expect(bridge.call).not.toHaveBeenCalled();

    const result = await client.callTool({
      name: "easyeda_pcb_draw",
      arguments: {
        confirmation: "I confirm the move",
        ops: [{ op: "moveComponent", designator: "U6", x: 100, y: 100 }],
        timeoutMs: 30_000
      }
    });
    expect(bridge.call).toHaveBeenCalledWith("pcbDraw", {
      ops: [{ op: "moveComponent", designator: "U6", x: 100, y: 100 }],
      continueOnError: false
    }, 30_000);
    expect(result.isError).toBeFalsy();
  });

  it("marks the active document as available when documentInfo exists", async () => {
    const bridge = {
      endpoint: "ws://127.0.0.1:8765",
      getStatus: () => ({
        connected: true,
        connectionState: "connected",
        activeDocumentType: "schematic",
        documentInfo: {
          documentType: 1,
          uuid: "doc-123"
        },
        updatedAt: new Date().toISOString()
      }),
      call: vi.fn()
    };
    const client = await makeClient(bridge);

    const result = await client.callTool({
      name: "easyeda_doctor",
      arguments: {}
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      doctor: {
        activeDocument: {
          available: true,
          type: "schematic"
        }
      }
    });
  });
});
