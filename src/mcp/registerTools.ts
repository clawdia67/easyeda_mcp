import * as z from "zod/v4";
import type { EasyEdaBridge } from "../bridge/EasyEdaBridge.js";
import { ok, fail } from "./toolResult.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PROTOCOL_VERSION, type EditorStatus } from "../protocol/messages.js";

const DefaultTimeoutSchema = z.number().int().positive().max(120_000).default(10_000);
const EndpointRefSchema = z.union([
  z.object({
    component: z.string().min(1),
    pin: z.string().min(1).optional(),
    pinName: z.string().min(1).optional()
  }),
  z.object({
    net: z.string().min(1)
  })
]);
const PassiveConstraintSchema = z.object({
  kind: z.enum(["resistor", "capacitor", "inductor", "diode", "led", "passive"]).optional(),
  component: z.string().min(1).optional(),
  value: z.string().min(1).optional()
});
const ConnectionCheckSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().min(1).optional(),
    type: z.literal("pin_connected"),
    component: z.string().min(1),
    pin: z.string().min(1).optional(),
    pinName: z.string().min(1).optional()
  }),
  z.object({
    id: z.string().min(1).optional(),
    type: z.literal("pin_on_net"),
    component: z.string().min(1),
    pin: z.string().min(1).optional(),
    pinName: z.string().min(1).optional(),
    net: z.string().min(1)
  }),
  z.object({
    id: z.string().min(1).optional(),
    type: z.literal("same_node"),
    left: EndpointRefSchema,
    right: EndpointRefSchema
  }),
  z.object({
    id: z.string().min(1).optional(),
    type: z.literal("path_exists"),
    from: EndpointRefSchema,
    to: EndpointRefSchema,
    through: PassiveConstraintSchema.optional(),
    maxHops: z.number().int().positive().max(20).optional()
  }),
  z.object({
    id: z.string().min(1).optional(),
    type: z.literal("path_absent"),
    from: EndpointRefSchema,
    to: EndpointRefSchema,
    through: PassiveConstraintSchema.optional(),
    maxHops: z.number().int().positive().max(20).optional()
  }),
  z.object({
    id: z.string().min(1).optional(),
    type: z.literal("pull_to_net"),
    signal: EndpointRefSchema,
    net: z.string().min(1),
    through: PassiveConstraintSchema,
    maxHops: z.number().int().positive().max(20).optional()
  }),
  z.object({
    id: z.string().min(1).optional(),
    type: z.literal("decoupled_to_net"),
    power: EndpointRefSchema,
    referenceNet: z.string().min(1),
    capacitorValue: z.string().min(1).optional(),
    maxHops: z.number().int().positive().max(20).optional()
  })
]);

const SchDrawOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("placeComponent"),
    device: z.object({
      uuid: z.string().min(1),
      libraryUuid: z.string().min(1)
    }).describe("A device from easyeda_search_devices results."),
    x: z.number(),
    y: z.number(),
    subPartName: z.string().min(1).optional(),
    rotation: z.number().optional(),
    mirror: z.boolean().optional(),
    designator: z.string().min(1).optional().describe("Designator to assign after placement, such as U1."),
    name: z.string().min(1).optional().describe("Value/name text to assign after placement, such as 10k."),
    addIntoBom: z.boolean().optional(),
    addIntoPcb: z.boolean().optional()
  }),
  z.object({
    op: z.literal("wire"),
    points: z.array(z.array(z.number()).min(4)).min(1)
      .describe("Polyline segments as [x1,y1,x2,y2,...] arrays; segments must be connected and horizontal/vertical. Schematic units are 10 mil."),
    net: z.string().min(1).optional()
  }),
  z.object({
    op: z.literal("netLabel"),
    net: z.string().min(1),
    x: z.number(),
    y: z.number()
  }),
  z.object({
    op: z.literal("netFlag"),
    kind: z.enum(["Power", "Ground", "AnalogGround", "ProtectGround"]),
    net: z.string().min(1),
    x: z.number(),
    y: z.number(),
    rotation: z.number().optional(),
    mirror: z.boolean().optional()
  }),
  z.object({
    op: z.literal("netPort"),
    direction: z.enum(["IN", "OUT", "BI"]).default("BI"),
    net: z.string().min(1),
    x: z.number(),
    y: z.number(),
    rotation: z.number().optional(),
    mirror: z.boolean().optional()
  }),
  z.object({
    op: z.literal("text"),
    content: z.string().min(1),
    x: z.number(),
    y: z.number(),
    rotation: z.number().optional(),
    fontSize: z.number().positive().optional()
  }),
  z.object({
    op: z.literal("modifyComponent"),
    primitiveId: z.string().min(1),
    property: z.record(z.string(), z.unknown())
      .describe("Properties accepted by SCH_PrimitiveComponent.modify, such as x, y, rotation, designator, name.")
  })
]);

const PcbLayerSchema = z.number().int().describe("EasyEDA PCB layer id: 1=TOP, 2=BOTTOM, 3/4=silk, 11=BOARD_OUTLINE, 15/16=INNER_1/INNER_2, 13=DOCUMENT.");
const PcbPolygonSchema = z.array(z.union([z.string(), z.number()])).min(3)
  .describe("EasyEDA polygon source array in mil, e.g. ['R', x, y, width, height, rotation, cornerRadius] or ['L', x1, y1, x2, y2, ...] or ['CIRCLE', x, y, radius].");

const PcbDrawOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("moveComponent"),
    designator: z.string().min(1).optional(),
    primitiveId: z.string().min(1).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    rotation: z.number().optional(),
    layer: z.number().int().optional().describe("1=TOP, 2=BOTTOM"),
    primitiveLock: z.boolean().optional()
  }),
  z.object({
    op: z.literal("line"),
    net: z.string().default(""),
    layer: PcbLayerSchema,
    startX: z.number(),
    startY: z.number(),
    endX: z.number(),
    endY: z.number(),
    lineWidth: z.number().positive().optional()
  }),
  z.object({
    op: z.literal("arc"),
    net: z.string().default(""),
    layer: PcbLayerSchema,
    startX: z.number(),
    startY: z.number(),
    endX: z.number(),
    endY: z.number(),
    arcAngle: z.number(),
    lineWidth: z.number().positive().optional()
  }),
  z.object({
    op: z.literal("via"),
    net: z.string().default(""),
    x: z.number(),
    y: z.number(),
    holeDiameter: z.number().positive(),
    diameter: z.number().positive()
  }),
  z.object({
    op: z.literal("region"),
    layer: PcbLayerSchema,
    polygon: PcbPolygonSchema,
    ruleTypes: z.array(z.number().int()).optional()
      .describe("EPCB_PrimitiveRegionRuleType values: 2=no components, 5=no wires, 6=no fills, 7=no pours, 8=no inner electrical layers."),
    regionName: z.string().min(1).optional()
  }),
  z.object({
    op: z.literal("pour"),
    net: z.string().min(1),
    layer: PcbLayerSchema,
    polygon: PcbPolygonSchema,
    pourName: z.string().min(1).optional(),
    pourPriority: z.number().int().optional()
  })
]);

const mutatingConfirmationRegex = /\bconfirma\b|\bconfirmo\b|\bconfirmed\b|\bi confirm\b/i;

export function hasExplicitMutationConfirmation(confirmation: string): boolean {
  return mutatingConfirmationRegex.test(confirmation);
}

export function registerEasyEdaTools(server: McpServer, bridge: EasyEdaBridge): void {
  server.registerTool(
    "easyeda_live_status",
    {
      title: "EasyEDA Pro live status",
      description: "Checks whether the EasyEDA Pro extension is connected and reports active document/capability information.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const status = bridge.getStatus();
      const summary = status.connected
        ? status.compatibility?.compatible === false
          ? "EasyEDA Pro extension is connected, but its bridge protocol is incompatible."
          : "EasyEDA Pro extension is connected."
        : "EasyEDA Pro extension is not connected.";
      return ok(summary, {
        status,
        bridgeEndpoint: bridge.endpoint
      });
    }
  );

  server.registerTool(
    "easyeda_doctor",
    {
      title: "EasyEDA Pro bridge diagnostics",
      description: "Returns a structured diagnosis of the local MCP bridge, EasyEDA Pro extension connection state, protocol compatibility, active document context, and suggested next steps.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const status = bridge.getStatus();
      const hasDocumentContext = Boolean(status.documentName || status.projectName || status.documentInfo);
      const nextSteps = doctorNextSteps(status);
      const summary = status.connected
        ? status.compatibility?.compatible === false
          ? "Bridge diagnostics found a protocol compatibility problem."
          : "Bridge diagnostics look healthy."
        : "Bridge diagnostics found that the EasyEDA Pro extension is disconnected.";
      return ok(summary, {
        doctor: {
          server: {
            name: "easyeda-pro-mcp",
            version: "0.1.0",
            protocolVersion: PROTOCOL_VERSION
          },
          bridge: {
            endpoint: bridge.endpoint
          },
          extension: {
            connected: status.connected,
            connectionState: status.connectionState ?? (status.connected ? "connected" : "disconnected"),
            version: status.extensionVersion,
            protocolVersion: status.protocolVersion,
            compatibility: status.compatibility ?? {
              compatible: false,
              expectedProtocolVersion: PROTOCOL_VERSION,
              actualProtocolVersion: status.protocolVersion,
              reason: "The extension has not reported protocol compatibility yet."
            }
          },
          activeDocument: {
            available: hasDocumentContext,
            type: status.activeDocumentType ?? "unknown",
            projectName: status.projectName,
            documentName: status.documentName
          },
          status,
          nextSteps
        }
      });
    }
  );

  registerReadTool(server, bridge, {
    name: "easyeda_get_context",
    title: "Get EasyEDA Pro editor context",
    description: "Summarizes active project, active document, selection, and editor context from the open EasyEDA Pro instance.",
    method: "getContext",
    inputSchema: {
      timeoutMs: DefaultTimeoutSchema
    },
    summary: "Fetched EasyEDA Pro context."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_find_component",
    title: "Find EasyEDA Pro component",
    description: "Finds a component by designator, name, value, footprint, or property in the active EasyEDA Pro project.",
    method: "findComponent",
    inputSchema: {
      query: z.string().min(1).describe("Designator, value, name, footprint, or property text to search for."),
      limit: z.number().int().positive().max(100).default(20),
      timeoutMs: DefaultTimeoutSchema
    },
    summary: "Searched EasyEDA Pro components."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_find_net",
    title: "Find EasyEDA Pro net",
    description: "Finds a net by name and returns available connections or metadata from the active project.",
    method: "findNet",
    inputSchema: {
      query: z.string().min(1).describe("Net name or partial net name to search for."),
      limit: z.number().int().positive().max(100).default(20),
      timeoutMs: DefaultTimeoutSchema
    },
    summary: "Searched EasyEDA Pro nets."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_schematic_snapshot",
    title: "Get EasyEDA Pro schematic snapshot",
    description: "Returns a structured snapshot of the active schematic: components, pins, nets, wires, labels, and confidence metadata.",
    method: "schematicSnapshot",
    inputSchema: {
      includeRaw: z.boolean().default(true).describe("Include compact raw EasyEDA API data for fallback reasoning."),
      allPages: z.boolean().default(true).describe("Collect all schematic pages when EasyEDA Pro exposes them."),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Fetched EasyEDA Pro schematic snapshot."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_list_schematic_components",
    title: "List schematic components",
    description: "Lists normalized schematic components with designator, value/name, footprint, position, and key properties.",
    method: "listSchematicComponents",
    inputSchema: {
      query: z.string().min(1).optional().describe("Optional text filter against component fields."),
      limit: z.number().int().positive().max(500).default(100),
      includeRaw: z.boolean().default(false),
      allPages: z.boolean().default(true),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Listed EasyEDA Pro schematic components."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_get_component_pins",
    title: "Get schematic component pins",
    description: "Returns all known pins for a schematic component, including pin number, pin name, position, and net when available.",
    method: "getComponentPins",
    inputSchema: {
      query: z.string().min(1).describe("Component designator or text query, such as U1, USB1, or regulator part number."),
      includeRaw: z.boolean().default(true),
      allPages: z.boolean().default(true),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Fetched schematic component pins."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_trace_net",
    title: "Trace schematic net",
    description: "Shows the pins, components, wires, labels, and ports associated with a schematic net.",
    method: "traceNet",
    inputSchema: {
      query: z.string().min(1).describe("Net name or partial net name, such as GND, VCC_5V, or SDA."),
      includeRaw: z.boolean().default(true),
      allPages: z.boolean().default(true),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Traced schematic net."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_trace_component",
    title: "Trace schematic component",
    description: "Groups a schematic component's connections by pin and net, with evidence for each connection.",
    method: "traceComponent",
    inputSchema: {
      query: z.string().min(1).describe("Component designator or text query, such as U1 or USB1."),
      includeRaw: z.boolean().default(true),
      allPages: z.boolean().default(true),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Traced schematic component."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_find_unconnected_pins",
    title: "Find unconnected schematic pins",
    description: "Identifies schematic pins without a confirmed net in the normalized EasyEDA Pro data.",
    method: "findUnconnectedPins",
    inputSchema: {
      includePowerPins: z.boolean().default(true).describe("When false, suppress pins whose names look like power pins."),
      limit: z.number().int().positive().max(500).default(100),
      includeRaw: z.boolean().default(true),
      allPages: z.boolean().default(true),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Found schematic pins without confirmed nets."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_validate_schematic_area",
    title: "Validate schematic area",
    description: "Runs generic read-only schematic checks against selected components/nets or the whole schematic.",
    method: "validateSchematicArea",
    inputSchema: {
      components: z.array(z.string().min(1)).optional().describe("Optional component designators or queries to focus on."),
      nets: z.array(z.string().min(1)).optional().describe("Optional net names or queries to focus on."),
      includeGlobalChecks: z.boolean().default(true),
      includeRaw: z.boolean().default(false),
      allPages: z.boolean().default(true),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Validated EasyEDA Pro schematic area."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_verify_connections",
    title: "Verify schematic connections",
    description: "Runs generic read-only connection assertions against the active schematic, including pin/net checks and passive paths through resistors, capacitors, inductors, diodes, or LEDs.",
    method: "verifyConnections",
    inputSchema: {
      checks: z.array(ConnectionCheckSchema).min(1).max(50).describe("Structured connection assertions to verify against the active schematic."),
      includeRaw: z.boolean().default(false),
      allPages: z.boolean().default(true),
      maxHops: z.number().int().positive().max(20).default(4),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Verified EasyEDA Pro schematic connections."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_navigate_component",
    title: "Navigate to EasyEDA Pro component",
    description: "Navigates/highlights a component in the EasyEDA Pro editor when the extension can locate it.",
    method: "navigateComponent",
    inputSchema: {
      query: z.string().min(1).describe("Component designator or search query."),
      timeoutMs: DefaultTimeoutSchema
    },
    summary: "Requested EasyEDA Pro component navigation."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_navigate_region",
    title: "Navigate to EasyEDA Pro region",
    description: "Navigates to coordinates or a rectangular region in the active EasyEDA Pro PCB/document.",
    method: "navigateRegion",
    inputSchema: {
      x: z.number().optional(),
      y: z.number().optional(),
      left: z.number().optional(),
      top: z.number().optional(),
      right: z.number().optional(),
      bottom: z.number().optional(),
      timeoutMs: DefaultTimeoutSchema
    },
    summary: "Requested EasyEDA Pro region navigation."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_zoom_board",
    title: "Zoom EasyEDA Pro board outline",
    description: "Zooms the active PCB editor to the board outline.",
    method: "zoomBoard",
    inputSchema: {
      timeoutMs: DefaultTimeoutSchema
    },
    summary: "Requested EasyEDA Pro board zoom."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_export_bom",
    title: "Export EasyEDA Pro BOM",
    description: "Exports a BOM from the active EasyEDA Pro project through the extension.",
    method: "exportBom",
    inputSchema: {
      fileName: z.string().min(1).optional(),
      format: z.enum(["csv", "xlsx", "json"]).default("csv"),
      scope: z.enum(["pcb", "schematic", "auto"]).default("auto"),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Requested EasyEDA Pro BOM export."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_export_netlist",
    title: "Export EasyEDA Pro netlist",
    description: "Exports a netlist from the active EasyEDA Pro schematic or PCB through the extension.",
    method: "exportNetlist",
    inputSchema: {
      fileName: z.string().min(1).optional(),
      scope: z.enum(["pcb", "schematic", "auto"]).default("auto"),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Requested EasyEDA Pro netlist export."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_export_gerber",
    title: "Export EasyEDA Pro Gerber",
    description: "Exports Gerber fabrication files from the active EasyEDA Pro PCB through the extension.",
    method: "exportGerber",
    inputSchema: {
      fileName: z.string().min(1).optional(),
      timeoutMs: DefaultTimeoutSchema.default(60_000)
    },
    summary: "Requested EasyEDA Pro Gerber export."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_export_pdf",
    title: "Export EasyEDA Pro PDF",
    description: "Exports a PDF from the active EasyEDA Pro document through the extension.",
    method: "exportPdf",
    inputSchema: {
      fileName: z.string().min(1).optional(),
      scope: z.enum(["pcb", "schematic", "auto"]).default("auto"),
      timeoutMs: DefaultTimeoutSchema.default(60_000)
    },
    summary: "Requested EasyEDA Pro PDF export."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_search_devices",
    title: "Search EasyEDA Pro device library",
    description: "Searches the EasyEDA Pro device library (system library by default) by keyword, part number, or LCSC number and returns devices that can be placed with easyeda_sch_draw.",
    method: "libSearchDevices",
    inputSchema: {
      query: z.string().min(1).describe("Keyword, MPN, or LCSC part number such as C141836."),
      limit: z.number().int().positive().max(50).default(10),
      page: z.number().int().positive().default(1),
      timeoutMs: DefaultTimeoutSchema.default(15_000)
    },
    summary: "Searched EasyEDA Pro device library."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_sch_netlist",
    title: "Get EasyEDA Pro schematic netlist",
    description: "Returns EasyEDA Pro's own netlist text for the active schematic (its net engine's ground truth), plus the project net info when available.",
    method: "schNetlist",
    inputSchema: {
      netlistType: z.string().min(1).optional().describe("Optional EasyEDA netlist type; omit for the default format."),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Fetched EasyEDA Pro schematic netlist."
  });

  server.registerTool(
    "easyeda_sch_draw",
    {
      title: "Draw schematic primitives",
      description: "Creates schematic primitives (library components, wires, net labels, net flags, net ports, text) in the active EasyEDA Pro schematic as one sequential batch. Mutating: the confirmation text must explicitly confirm drawing.",
      inputSchema: {
        ops: z.array(SchDrawOpSchema).min(1).max(200).describe("Draw operations executed in order."),
        continueOnError: z.boolean().default(false).describe("Keep executing later ops after one fails; failed ops are always reported."),
        confirmation: z.string().describe("Must include an explicit confirmation phrase such as 'I confirm'."),
        timeoutMs: DefaultTimeoutSchema.default(60_000)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ ops, continueOnError, confirmation, timeoutMs }) => {
      try {
        if (!hasExplicitMutationConfirmation(confirmation)) {
          return fail(new Error(`Drawing was blocked. The confirmation text must explicitly include a confirmation phrase such as "I confirm".`));
        }
        const result = await bridge.call("schDraw", { ops, continueOnError }, timeoutMs);
        return ok(`Executed schematic draw batch of ${ops.length} op(s).`, {
          result
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "easyeda_sch_delete",
    {
      title: "Delete schematic primitives",
      description: "Deletes schematic primitives (components, wires, texts, attributes) by primitive id in the active EasyEDA Pro schematic. Mutating: the confirmation text must explicitly confirm deletion.",
      inputSchema: {
        primitiveIds: z.array(z.string().min(1)).min(1).max(200),
        confirmation: z.string().describe("Must include an explicit confirmation phrase such as 'I confirm'."),
        timeoutMs: DefaultTimeoutSchema.default(30_000)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ primitiveIds, confirmation, timeoutMs }) => {
      try {
        if (!hasExplicitMutationConfirmation(confirmation)) {
          return fail(new Error(`Deletion was blocked. The confirmation text must explicitly include a confirmation phrase such as "I confirm".`));
        }
        const result = await bridge.call("schDelete", { primitiveIds }, timeoutMs);
        return ok(`Requested deletion of ${primitiveIds.length} schematic primitive(s).`, {
          result
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  registerReadTool(server, bridge, {
    name: "easyeda_pcb_info",
    title: "Get EasyEDA Pro PCB info",
    description: "Lists PCB components (designator, position in mil, rotation, layer), net names, and active-document info from the open PCB.",
    method: "pcbInfo",
    inputSchema: {
      includeBBox: z.boolean().default(false).describe("Also fetch each component's bounding box (slower)."),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Fetched EasyEDA Pro PCB info."
  });

  server.registerTool(
    "easyeda_pcb_draw",
    {
      title: "Draw/modify PCB primitives",
      description: "Executes a sequential batch of PCB operations in the active EasyEDA Pro PCB: move/rotate components, draw lines/arcs (board outline on layer 11, tracks on copper layers with a net), vias, rule regions (keepouts), and copper pours. Coordinates are in mil. Mutating: the confirmation text must explicitly confirm.",
      inputSchema: {
        ops: z.array(PcbDrawOpSchema).min(1).max(300).describe("PCB operations executed in order."),
        continueOnError: z.boolean().default(false),
        confirmation: z.string().describe("Must include an explicit confirmation phrase such as 'I confirm'."),
        timeoutMs: DefaultTimeoutSchema.default(60_000)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ ops, continueOnError, confirmation, timeoutMs }) => {
      try {
        if (!hasExplicitMutationConfirmation(confirmation)) {
          return fail(new Error(`PCB drawing was blocked. The confirmation text must explicitly include a confirmation phrase such as "I confirm".`));
        }
        const result = await bridge.call("pcbDraw", { ops, continueOnError }, timeoutMs);
        return ok(`Executed PCB draw batch of ${ops.length} op(s).`, {
          result
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "easyeda_pcb_delete",
    {
      title: "Delete PCB primitives",
      description: "Deletes PCB primitives (components, lines, arcs, vias, regions, pours, fills, strings) by primitive id in the active EasyEDA Pro PCB. Mutating and destructive: requires an explicit confirmation phrase.",
      inputSchema: {
        primitiveIds: z.array(z.string().min(1)).min(1).max(200),
        confirmation: z.string().describe("Must include an explicit confirmation phrase such as 'I confirm'."),
        timeoutMs: DefaultTimeoutSchema.default(30_000)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ primitiveIds, confirmation, timeoutMs }) => {
      try {
        if (!hasExplicitMutationConfirmation(confirmation)) {
          return fail(new Error(`Deletion was blocked. The confirmation text must explicitly include a confirmation phrase such as "I confirm".`));
        }
        const result = await bridge.call("pcbDelete", { primitiveIds }, timeoutMs);
        return ok(`Requested deletion of ${primitiveIds.length} PCB primitive(s).`, {
          result
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "easyeda_confirmed_action",
    {
      title: "Confirmed EasyEDA Pro action",
      description: "Runs a mutating EasyEDA Pro action only when the confirmation text explicitly confirms the action. createBoard pairs a new PCB document with a schematic (pass params.schematicUuid); importChanges syncs the schematic netlist/footprints into the active PCB.",
      inputSchema: {
        action: z.enum(["save", "importChanges", "autoroute", "autolayout", "createBoard"]),
        confirmation: z.string().describe("Must include an explicit confirmation phrase such as 'confirma salvar'."),
        params: z.record(z.string(), z.unknown()).optional(),
        timeoutMs: DefaultTimeoutSchema.default(60_000)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ action, confirmation, params, timeoutMs }) => {
      try {
        if (!hasExplicitMutationConfirmation(confirmation)) {
          return fail(new Error(`Action "${action}" was blocked. The confirmation text must explicitly include a confirmation phrase such as "confirma salvar".`));
        }
        const result = await bridge.call("confirmedAction", { action, confirmation, params }, timeoutMs);
        return ok(`Executed confirmed EasyEDA Pro action: ${action}.`, {
          action,
          result
        });
      } catch (error) {
        return fail(error);
      }
    }
  );
}

function doctorNextSteps(status: EditorStatus): string[] {
  if (!status.connected) {
    return [
      "Open EasyEDA Pro.",
      "Install or reload the EasyEDA MCP extension.",
      "Enable external interaction/WebSocket permission in EasyEDA Pro.",
      "Keep the MCP server running and wait for the extension to auto-connect."
    ];
  }

  if (status.compatibility?.compatible === false) {
    return [
      "Rebuild and reload the EasyEDA Pro extension.",
      "Restart the MCP client session so it reloads the latest tool catalog.",
      "Verify that the extension and MCP server are built from the same repository state."
    ];
  }

  if (!status.documentName && !status.projectName) {
    return [
      "Open a schematic or PCB document in EasyEDA Pro.",
      "Run easyeda_get_context or easyeda_live_status again after the document finishes loading."
    ];
  }

  return [
    "The bridge looks healthy.",
    "Use easyeda_live_status for quick checks and easyeda_get_context for deeper editor state."
  ];
}

type ReadToolConfig = {
  name: string;
  title: string;
  description: string;
  method: string;
  inputSchema: z.ZodRawShape;
  summary: string;
};

function registerReadTool(
  server: McpServer,
  bridge: EasyEdaBridge,
  config: ReadToolConfig
): void {
  server.registerTool(
    config.name,
    {
      title: config.title,
      description: config.description,
      inputSchema: config.inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    } as never,
    async (args: Record<string, unknown>) => {
      try {
        const { timeoutMs, ...params } = args as Record<string, unknown> & { timeoutMs?: number };
        const result = await bridge.call(config.method, params, timeoutMs);
        return ok(config.summary, {
          result
        });
      } catch (error) {
        return fail(error);
      }
    }
  );
}
