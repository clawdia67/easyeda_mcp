import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type WebSocketRegistration = {
  onMessage?: (event: MessageEvent<string>) => Promise<void>;
  onOpen?: () => Promise<void>;
};

function component(designator: string, primitiveId: string, value = designator): Record<string, unknown> {
  return {
    designator,
    primitiveId,
    name: value,
    x: 0,
    y: 0
  };
}

function pin(pinNumber: string, pinName: string, x: number, y: number): Record<string, unknown> {
  return {
    primitiveId: `$pin-${pinNumber}-${pinName}`,
    pinNumber,
    pinName,
    x,
    y
  };
}

function wire(net: string | undefined, path: number[][]): Record<string, unknown> {
  return {
    primitiveId: `$wire-${net ?? "unnamed"}-${path.length}`,
    net,
    line: path
  };
}

describe("EasyEDA extension bridge handlers", () => {
  let sentMessages: Array<{ id: string; message: string }> = [];
  let registration: WebSocketRegistration;
  let dialogMessages: Array<{ title: string; message: string }> = [];
  let savedDocumentUuids: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    sentMessages = [];
    registration = {};
    dialogMessages = [];
    savedDocumentUuids = [];

    vi.stubGlobal("eda", {
      sys_WebSocket: {
        register: vi.fn((_id: string, _uri: string, onMessage: WebSocketRegistration["onMessage"], onOpen: WebSocketRegistration["onOpen"]) => {
          registration = { onMessage, onOpen };
        }),
        send: vi.fn((id: string, message: string) => {
          sentMessages.push({ id, message });
        })
      },
      sys_Dialog: {
        showInformationMessage: vi.fn((message: string, title: string) => {
          dialogMessages.push({ title, message });
        })
      },
      sys_Log: {
        warn: vi.fn(),
        error: vi.fn()
      },
      dmt_SelectControl: {
        getCurrentDocumentInfo: vi.fn(async () => ({
          uuid: "doc-123",
          type: "schematic",
          name: "Power Supply.Schematic"
        }))
      },
      dmt_EditorControl: {
        getSplitScreenTree: vi.fn(async () => []),
        zoomToRegion: vi.fn(async () => undefined)
      },
      sch_PrimitiveComponent: {
        getAll: vi.fn(async () => [component("U5", "$u5", "TP4057"), component("R7", "$r7", "2k"), component("C4", "$c4", "4.7uF")]),
        getAllPinsByPrimitiveId: vi.fn(async (primitiveId: string) => {
          const pinsByPrimitive: Record<string, unknown[]> = {
            $u5: [
              pin("1", "BAT", 60, 0),
              pin("2", "VCC", 20, 0),
              pin("6", "PROG", 90, 20)
            ],
            $r7: [
              pin("1", "1", 90, 20),
              pin("2", "2", 90, 40)
            ],
            $c4: [
              pin("1", "1", 20, 0),
              pin("2", "2", 20, 20)
            ]
          };
          return pinsByPrimitive[primitiveId] ?? [];
        })
      },
      sch_PrimitiveWire: {
        getAll: vi.fn(async () => [
          wire("VBUS", [[0, 0, 20, 0]]),
          wire("VBAT_LIPO", [[60, 0, 80, 0]]),
          wire(undefined, [[90, 20, 100, 20]]),
          wire("GND", [[20, 20, 20, 40], [20, 40, 90, 40]])
        ])
      },
      sch_PrimitiveText: {
        getAll: vi.fn(async () => [])
      },
      sch_Document: {
        save: vi.fn(async (uuid: string) => {
          savedDocumentUuids.push(uuid);
        })
      }
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("auto-connects on activation and sends hello on open", async () => {
    const extension = await import("./index.js");

    extension.activate("onStartupFinished");
    expect(registration.onOpen).toBeTypeOf("function");

    await registration.onOpen?.();

    const helloMessage = JSON.parse(sentMessages.at(0)?.message ?? "{}");
    expect(helloMessage.kind).toBe("hello");
    expect(helloMessage.protocolVersion).toBe("0.1.0");
    expect(helloMessage.compatibility).toMatchObject({
      compatible: true,
      expectedProtocolVersion: "0.1.0"
    });
  });

  it("infers schematic type from numeric documentType in status", async () => {
    vi.stubGlobal("eda", {
      ...(globalThis as { eda: Record<string, unknown> }).eda,
      dmt_SelectControl: {
        getCurrentDocumentInfo: vi.fn(async () => ({
          uuid: "doc-123",
          documentType: 1
        }))
      }
    });

    const extension = await import("./index.js");

    extension.activate("onStartupFinished");
    await registration.onOpen?.();

    const helloMessage = JSON.parse(sentMessages.at(0)?.message ?? "{}");
    expect(helloMessage.status.activeDocumentType).toBe("schematic");
  });

  it("responds to verifyConnections requests with structured results", async () => {
    const extension = await import("./index.js");

    extension.connect();
    await registration.onOpen?.();

    await registration.onMessage?.({
      data: JSON.stringify({
        kind: "call",
        requestId: "verify-1",
        method: "verifyConnections",
        params: {
          checks: [
            {
              id: "u5-vcc",
              type: "pin_on_net",
              component: "U5",
              pinName: "VCC",
              net: "VBUS"
            },
            {
              id: "u5-prog",
              type: "pull_to_net",
              signal: { component: "U5", pinName: "PROG" },
              net: "GND",
              through: { kind: "resistor" }
            }
          ]
        }
      })
    } as MessageEvent<string>);

    const resultMessage = JSON.parse(sentMessages.at(-1)?.message ?? "{}");
    expect(resultMessage.kind).toBe("result");
    expect(resultMessage.requestId).toBe("verify-1");
    expect(resultMessage.result.summary).toMatchObject({
      passed: 2,
      failed: 0,
      unknown: 0
    });
    expect(resultMessage.result.checks.map((check: { status: string }) => check.status)).toEqual(["pass", "pass"]);
  });

  it("executes confirmed save actions and returns success payload", async () => {
    const extension = await import("./index.js");

    extension.connect();
    await registration.onMessage?.({
      data: JSON.stringify({
        kind: "call",
        requestId: "save-1",
        method: "confirmedAction",
        params: {
          action: "save"
        }
      })
    } as MessageEvent<string>);

    const resultMessage = JSON.parse(sentMessages.at(-1)?.message ?? "{}");
    expect(savedDocumentUuids).toEqual(["doc-123"]);
    expect(resultMessage.kind).toBe("result");
    expect(resultMessage.result).toMatchObject({
      action: "save",
      saved: true,
      documentUuid: "doc-123"
    });
  });

  it("reports draw capabilities in the hello handshake when creation APIs exist", async () => {
    vi.stubGlobal("eda", {
      ...(globalThis as { eda: Record<string, unknown> }).eda,
      sch_PrimitiveComponent: {
        ...((globalThis as { eda: Record<string, any> }).eda.sch_PrimitiveComponent),
        create: vi.fn()
      },
      sch_PrimitiveWire: {
        ...((globalThis as { eda: Record<string, any> }).eda.sch_PrimitiveWire),
        create: vi.fn()
      },
      lib_Device: {
        search: vi.fn()
      }
    });

    const extension = await import("./index.js");
    extension.activate("onStartupFinished");
    await registration.onOpen?.();

    const helloMessage = JSON.parse(sentMessages.at(0)?.message ?? "{}");
    expect(helloMessage.capabilities).toMatchObject({
      schDraw: true,
      libSearch: true
    });
  });

  it("searches library devices and returns simplified items", async () => {
    const search = vi.fn(async () => [
      {
        uuid: "dev-1",
        libraryUuid: "lib-sys",
        name: "TLV62569DBVR",
        description: "buck",
        symbol: { name: "TLV62569", uuid: "sym-1", libraryUuid: "lib-sys" },
        footprint: { name: "SOT-23-5", uuid: "fp-1", libraryUuid: "lib-sys" },
        otherProperty: { "Supplier Part": "C141836" }
      }
    ]);
    vi.stubGlobal("eda", {
      ...(globalThis as { eda: Record<string, unknown> }).eda,
      lib_Device: { search }
    });

    const extension = await import("./index.js");
    extension.connect();
    await registration.onMessage?.({
      data: JSON.stringify({
        kind: "call",
        requestId: "libsearch-1",
        method: "libSearchDevices",
        params: { query: "C141836", limit: 5, page: 2 }
      })
    } as MessageEvent<string>);

    expect(search).toHaveBeenCalledWith("C141836", undefined, undefined, undefined, 5, 2);
    const resultMessage = JSON.parse(sentMessages.at(-1)?.message ?? "{}");
    expect(resultMessage.kind).toBe("result");
    expect(resultMessage.result.count).toBe(1);
    expect(resultMessage.result.devices[0]).toMatchObject({
      uuid: "dev-1",
      libraryUuid: "lib-sys",
      name: "TLV62569DBVR",
      footprint: { name: "SOT-23-5" }
    });
  });

  it("executes a schDraw batch in order and returns primitive ids and pins", async () => {
    const create = vi.fn(async () => ({
      getState_PrimitiveId: () => "$new-u1"
    }));
    const modify = vi.fn(async () => undefined);
    const wireCreate = vi.fn(async () => ({
      getState_PrimitiveId: () => "$new-wire"
    }));
    const createNetLabel = vi.fn(async () => ({
      getState_PrimitiveId: () => "$new-label"
    }));
    const createNetFlag = vi.fn(async () => ({
      getState_PrimitiveId: () => "$new-gnd"
    }));
    vi.stubGlobal("eda", {
      ...(globalThis as { eda: Record<string, unknown> }).eda,
      sch_PrimitiveComponent: {
        ...((globalThis as { eda: Record<string, any> }).eda.sch_PrimitiveComponent),
        create,
        modify,
        createNetFlag,
        getAllPinsByPrimitiveId: vi.fn(async () => [
          {
            getState_PrimitiveId: () => "$new-u1-pin1",
            getState_PinNumber: () => "1",
            getState_PinName: () => "VIN",
            getState_X: () => 100,
            getState_Y: () => 200
          }
        ])
      },
      sch_PrimitiveWire: { create: wireCreate },
      sch_PrimitiveAttribute: { createNetLabel }
    });

    const extension = await import("./index.js");
    extension.connect();
    await registration.onMessage?.({
      data: JSON.stringify({
        kind: "call",
        requestId: "draw-1",
        method: "schDraw",
        params: {
          ops: [
            {
              op: "placeComponent",
              device: { uuid: "dev-1", libraryUuid: "lib-sys" },
              x: 100,
              y: 200,
              rotation: 90,
              designator: "U1"
            },
            { op: "wire", points: [[100, 200, 140, 200]], net: "VBUS_5V" },
            { op: "netLabel", net: "VBUS_5V", x: 140, y: 200 },
            { op: "netFlag", kind: "Ground", net: "GND", x: 100, y: 260 }
          ]
        }
      })
    } as MessageEvent<string>);

    expect(create).toHaveBeenCalledWith(
      { uuid: "dev-1", libraryUuid: "lib-sys" },
      100,
      200,
      undefined,
      90,
      undefined,
      undefined,
      undefined
    );
    expect(modify).toHaveBeenCalledWith("$new-u1", { designator: "U1" });
    expect(wireCreate).toHaveBeenCalledWith([[100, 200, 140, 200]], "VBUS_5V");
    expect(createNetLabel).toHaveBeenCalledWith(140, 200, "VBUS_5V");
    expect(createNetFlag).toHaveBeenCalledWith("Ground", "GND", 100, 260, undefined, undefined);

    const resultMessage = JSON.parse(sentMessages.at(-1)?.message ?? "{}");
    expect(resultMessage.kind).toBe("result");
    expect(resultMessage.result.completed).toBe(4);
    expect(resultMessage.result.failed).toBe(0);
    expect(resultMessage.result.results.map((entry: { primitiveId?: string }) => entry.primitiveId)).toEqual([
      "$new-u1",
      "$new-wire",
      "$new-label",
      "$new-gnd"
    ]);
    expect(resultMessage.result.results[0].pins).toEqual([
      {
        primitiveId: "$new-u1-pin1",
        pinNumber: "1",
        pinName: "VIN",
        x: 100,
        y: 200
      }
    ]);
  });

  it("stops a schDraw batch at the first failing op and reports partial results", async () => {
    const wireCreate = vi.fn(async () => undefined);
    const createNetLabel = vi.fn();
    vi.stubGlobal("eda", {
      ...(globalThis as { eda: Record<string, unknown> }).eda,
      sch_PrimitiveWire: { create: wireCreate },
      sch_PrimitiveAttribute: { createNetLabel }
    });

    const extension = await import("./index.js");
    extension.connect();
    await registration.onMessage?.({
      data: JSON.stringify({
        kind: "call",
        requestId: "draw-2",
        method: "schDraw",
        params: {
          ops: [
            { op: "wire", points: [[0, 0, 40, 0]], net: "SIG_A" },
            { op: "netLabel", net: "SIG_A", x: 40, y: 0 }
          ]
        }
      })
    } as MessageEvent<string>);

    const resultMessage = JSON.parse(sentMessages.at(-1)?.message ?? "{}");
    expect(resultMessage.kind).toBe("result");
    expect(resultMessage.result.completed).toBe(0);
    expect(resultMessage.result.failed).toBe(1);
    expect(resultMessage.result.results).toHaveLength(1);
    expect(resultMessage.result.results[0]).toMatchObject({ index: 0, ok: false });
    expect(createNetLabel).not.toHaveBeenCalled();
  });

  it("deletes primitives by resolved type", async () => {
    const componentDelete = vi.fn(async () => true);
    const wireDelete = vi.fn(async () => true);
    vi.stubGlobal("eda", {
      ...(globalThis as { eda: Record<string, unknown> }).eda,
      sch_Primitive: {
        getPrimitiveTypeByPrimitiveId: vi.fn(async (id: string) => (id === "$u5" ? "Component" : "Wire"))
      },
      sch_PrimitiveComponent: {
        ...((globalThis as { eda: Record<string, any> }).eda.sch_PrimitiveComponent),
        delete: componentDelete
      },
      sch_PrimitiveWire: {
        ...((globalThis as { eda: Record<string, any> }).eda.sch_PrimitiveWire),
        delete: wireDelete
      }
    });

    const extension = await import("./index.js");
    extension.connect();
    await registration.onMessage?.({
      data: JSON.stringify({
        kind: "call",
        requestId: "delete-1",
        method: "schDelete",
        params: { primitiveIds: ["$u5", "$wire-1"] }
      })
    } as MessageEvent<string>);

    expect(componentDelete).toHaveBeenCalledWith("$u5");
    expect(wireDelete).toHaveBeenCalledWith("$wire-1");
    const resultMessage = JSON.parse(sentMessages.at(-1)?.message ?? "{}");
    expect(resultMessage.kind).toBe("result");
    expect(resultMessage.result.results).toEqual([
      { primitiveId: "$u5", type: "Component", deleted: true },
      { primitiveId: "$wire-1", type: "Wire", deleted: true }
    ]);
  });

  it("moves a PCB component by designator and draws an outline line", async () => {
    const modify = vi.fn(async () => ({ getState_PrimitiveId: () => "$pcb-u6" }));
    const lineCreate = vi.fn(async () => ({ getState_PrimitiveId: () => "$outline-1" }));
    vi.stubGlobal("eda", {
      ...(globalThis as { eda: Record<string, unknown> }).eda,
      pcb_PrimitiveComponent: {
        getAll: vi.fn(async () => [
          { getState_PrimitiveId: () => "$pcb-u6", getState_Designator: () => "U6" },
          { getState_PrimitiveId: () => "$pcb-j1", getState_Designator: () => "J1" }
        ]),
        modify
      },
      pcb_PrimitiveLine: { create: lineCreate }
    });

    const extension = await import("./index.js");
    extension.connect();
    await registration.onMessage?.({
      data: JSON.stringify({
        kind: "call",
        requestId: "pcb-1",
        method: "pcbDraw",
        params: {
          ops: [
            { op: "moveComponent", designator: "U6", x: 1000, y: 400, rotation: 90 },
            { op: "line", net: "", layer: 11, startX: 0, startY: 0, endX: 2500, endY: 0, lineWidth: 6 }
          ]
        }
      })
    } as MessageEvent<string>);

    expect(modify).toHaveBeenCalledWith("$pcb-u6", { x: 1000, y: 400, rotation: 90 });
    expect(lineCreate).toHaveBeenCalledWith("", 11, 0, 0, 2500, 0, 6);
    const resultMessage = JSON.parse(sentMessages.at(-1)?.message ?? "{}");
    expect(resultMessage.result.completed).toBe(2);
    expect(resultMessage.result.results.map((entry: { primitiveId?: string }) => entry.primitiveId)).toEqual([
      "$pcb-u6",
      "$outline-1"
    ]);
  });

  it("creates keepout regions and pours through polygon sources", async () => {
    const createPolygon = vi.fn((source: unknown) => ({ source }));
    const regionCreate = vi.fn(async () => ({ getState_PrimitiveId: () => "$keepout" }));
    const pourCreate = vi.fn(async () => ({ getState_PrimitiveId: () => "$gnd-pour" }));
    vi.stubGlobal("eda", {
      ...(globalThis as { eda: Record<string, unknown> }).eda,
      pcb_MathPolygon: { createPolygon },
      pcb_PrimitiveRegion: { create: regionCreate },
      pcb_PrimitivePour: { create: pourCreate }
    });

    const extension = await import("./index.js");
    extension.connect();
    await registration.onMessage?.({
      data: JSON.stringify({
        kind: "call",
        requestId: "pcb-2",
        method: "pcbDraw",
        params: {
          ops: [
            { op: "region", layer: 1, polygon: ["R", 100, 100, 708, 236, 0, 0], ruleTypes: [2, 5, 7], regionName: "antenna-keepout" },
            { op: "pour", net: "GND", layer: 15, polygon: ["R", 0, 0, 2500, 800, 0, 0], pourName: "gnd-plane" }
          ]
        }
      })
    } as MessageEvent<string>);

    expect(createPolygon).toHaveBeenCalledTimes(2);
    expect(regionCreate).toHaveBeenCalledWith(1, { source: ["R", 100, 100, 708, 236, 0, 0] }, [2, 5, 7], "antenna-keepout");
    expect(pourCreate).toHaveBeenCalledWith("GND", 15, { source: ["R", 0, 0, 2500, 800, 0, 0] }, undefined, undefined, "gnd-plane", undefined);
    const resultMessage = JSON.parse(sentMessages.at(-1)?.message ?? "{}");
    expect(resultMessage.result.completed).toBe(2);
  });

  it("returns PCB component pads when includePads is set", async () => {
    vi.stubGlobal("eda", {
      ...(globalThis as { eda: Record<string, unknown> }).eda,
      pcb_PrimitiveComponent: {
        getAll: vi.fn(async () => [
          { getState_PrimitiveId: () => "$pcb-j1", getState_Designator: () => "J1", getState_X: () => 206, getState_Y: () => -415 }
        ]),
        getAllPinsByPrimitiveId: vi.fn(async () => [
          { getState_PrimitiveId: () => "$pcb-j1-a6", getState_PadNumber: () => "A6", getState_Net: () => "USB_DP", getState_X: () => 180, getState_Y: () => -400 }
        ])
      },
      pcb_Net: { getAllNetsName: vi.fn(async () => ["USB_DP"]) }
    });

    const extension = await import("./index.js");
    extension.connect();
    await registration.onMessage?.({
      data: JSON.stringify({
        kind: "call",
        requestId: "pads-1",
        method: "pcbInfo",
        params: { includePads: true }
      })
    } as MessageEvent<string>);

    const resultMessage = JSON.parse(sentMessages.at(-1)?.message ?? "{}");
    expect(resultMessage.result.components[0].pads).toEqual([
      { primitiveId: "$pcb-j1-a6", padNumber: "A6", net: "USB_DP", x: 180, y: -400, layer: undefined, rotation: undefined }
    ]);
  });

  it("falls back to per-class deletes when the PCB type lookup returns nothing", async () => {
    const lineDelete = vi.fn(async (id: string) => id === "$outline-1");
    const componentDelete = vi.fn(async () => false);
    vi.stubGlobal("eda", {
      ...(globalThis as { eda: Record<string, unknown> }).eda,
      pcb_Primitive: { getPrimitiveTypeByPrimitiveId: vi.fn(async () => undefined) },
      pcb_PrimitiveComponent: { delete: componentDelete },
      pcb_PrimitiveLine: { delete: lineDelete }
    });

    const extension = await import("./index.js");
    extension.connect();
    await registration.onMessage?.({
      data: JSON.stringify({
        kind: "call",
        requestId: "pcbdel-1",
        method: "pcbDelete",
        params: { primitiveIds: ["$outline-1"] }
      })
    } as MessageEvent<string>);

    const resultMessage = JSON.parse(sentMessages.at(-1)?.message ?? "{}");
    expect(resultMessage.result.results[0]).toMatchObject({
      primitiveId: "$outline-1",
      deleted: true,
      fallback: true,
      type: "pcb_PrimitiveLine"
    });
  });

  it("creates a board via confirmedAction createBoard", async () => {
    const createBoard = vi.fn(async () => "Board1");
    vi.stubGlobal("eda", {
      ...(globalThis as { eda: Record<string, unknown> }).eda,
      dmt_Board: { createBoard }
    });

    const extension = await import("./index.js");
    extension.connect();
    await registration.onMessage?.({
      data: JSON.stringify({
        kind: "call",
        requestId: "board-1",
        method: "confirmedAction",
        params: { action: "createBoard", params: { schematicUuid: "sch-123" } }
      })
    } as MessageEvent<string>);

    expect(createBoard).toHaveBeenCalledWith("sch-123", undefined);
    const resultMessage = JSON.parse(sentMessages.at(-1)?.message ?? "{}");
    expect(resultMessage.result).toMatchObject({ action: "createBoard", created: true, boardName: "Board1" });
  });

  it("shows diagnostics with connection and document details", async () => {
    const extension = await import("./index.js");

    extension.connect();
    await extension.runDiagnostics();

    expect(dialogMessages.at(-1)).toMatchObject({
      title: "EasyEDA MCP Bridge Diagnostics"
    });
    expect(dialogMessages.at(-1)?.message).toContain("Bridge URI: ws://127.0.0.1:8765");
    expect(dialogMessages.at(-1)?.message).toContain("Connection phase:");
    expect(dialogMessages.at(-1)?.message).toContain("Document: Power Supply.Schematic");
  });
});
