declare const eda: EasyEdaApi;
import {
  buildSchematicSnapshot,
  findUnconnectedPins,
  getComponentPins,
  listSchematicComponents,
  traceComponent,
  traceNet,
  validateSchematicArea,
  verifyConnections,
  type RawSchematicData,
  type SchematicSnapshot
} from "../../src/schematic/analysis.js";
import {
  PROTOCOL_VERSION,
  evaluateProtocolCompatibility,
  type ProtocolCompatibility
} from "../../src/protocol/messages.js";
import { getBridgeConfig, getBridgeUri } from "./bridgeConfig.js";

type EasyEdaApi = Record<string, any>;

type BridgeCallMessage = {
  kind: "call";
  requestId: string;
  method: string;
  params?: Record<string, any>;
  timeoutMs?: number;
};

type BridgeResultMessage = {
  kind: "result";
  requestId: string;
  result: unknown;
};

type BridgeErrorMessage = {
  kind: "error";
  requestId: string;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

const WS_ID = "easyeda-mcp-bridge";
const EXTENSION_VERSION = "0.1.0";
const bridgeConfig = getBridgeConfig();

type ConnectionPhase = "idle" | "connecting" | "connected" | "blocked";

type ConnectionState = {
  phase: ConnectionPhase;
  attemptIndex: number;
  lastError?: BridgeErrorMessage["error"];
  lastOpenAt?: string;
  lastStatusAt?: string;
  lastHandshakeAt?: string;
  lastAttemptAt?: string;
  connectedOnce: boolean;
  compatibility: ProtocolCompatibility;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  openTimeoutTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
};

const connectionState: ConnectionState = {
  phase: "idle",
  attemptIndex: 0,
  connectedOnce: false,
  compatibility: evaluateProtocolCompatibility(PROTOCOL_VERSION)
};

const handlers: Record<string, (params: Record<string, any>) => Promise<unknown> | unknown> = {
  getContext,
  findComponent,
  findNet,
  schematicSnapshot,
  listSchematicComponents: listSchematicComponentsTool,
  listSchematicComponentsTool,
  getComponentPins: getComponentPinsTool,
  getComponentPinsTool,
  traceNet: traceNetTool,
  traceNetTool,
  traceComponent: traceComponentTool,
  traceComponentTool,
  findUnconnectedPins: findUnconnectedPinsTool,
  findUnconnectedPinsTool,
  validateSchematicArea: validateSchematicAreaTool,
  validateSchematicAreaTool,
  verifyConnections: verifyConnectionsTool,
  verifyConnectionsTool,
  navigateComponent,
  navigateRegion,
  zoomBoard,
  exportBom,
  exportNetlist,
  exportGerber,
  exportPdf,
  confirmedAction,
  libSearchDevices,
  schDraw,
  schDelete,
  schNetlist,
  pcbInfo,
  pcbDraw,
  pcbDelete
};

export function activate(status?: "onStartupFinished", arg?: string): void {
  log("warn", `EasyEDA MCP Bridge activated: ${status ?? "manual"} ${arg ?? ""}`);
  void ensureBridgeConnected({ reason: "activation", manual: false });
}

export function connect(): void {
  void ensureBridgeConnected({ reason: "manual-connect", manual: true, resetAttempts: true });
}

export function reconnect(): void {
  resetConnectionTimers();
  connectionState.phase = "idle";
  connectionState.attemptIndex = 0;
  void ensureBridgeConnected({ reason: "manual-reconnect", manual: true, resetAttempts: true });
}

export async function showStatus(): Promise<void> {
  const diagnostics = await collectDiagnostics();
  showMessage("EasyEDA MCP Bridge Status", formatStatusSummary(diagnostics));
}

export async function runDiagnostics(): Promise<void> {
  const diagnostics = await collectDiagnostics();
  showMessage("EasyEDA MCP Bridge Diagnostics", formatDiagnostics(diagnostics));
}

async function ensureBridgeConnected(options: { reason: string; manual: boolean; resetAttempts?: boolean }): Promise<void> {
  if (options.resetAttempts) {
    connectionState.attemptIndex = 0;
  }

  if (connectionState.phase === "connecting") {
    return;
  }

  if (connectionState.phase === "connected" && !options.manual) {
    return;
  }

  await startBridge(options);
}

async function startBridge(options: { reason: string; manual: boolean }): Promise<void> {
  ensureApi("sys_WebSocket", "register");
  resetConnectionTimers();
  connectionState.phase = "connecting";
  connectionState.lastAttemptAt = new Date().toISOString();

  const wsUri = getBridgeUri(bridgeConfig);
  const attemptIndex = connectionState.attemptIndex;
  const openTimeoutMs = bridgeConfig.openTimeoutMs;
  connectionState.openTimeoutTimer = setTimeout(() => {
    const error = apiError("bridge_open_timeout", `Timed out waiting for EasyEDA MCP Bridge to open ${wsUri}.`);
    handleConnectionFailure(normalizeError(error), {
      manual: options.manual,
      shouldRetry: true
    });
  }, openTimeoutMs);

  try {
    eda.sys_WebSocket.register(
      WS_ID,
      wsUri,
      async (event: MessageEvent<string>) => {
        await handleMessage(event.data);
      },
      async () => {
        connectionState.phase = "connected";
        connectionState.lastOpenAt = new Date().toISOString();
        connectionState.lastHandshakeAt = connectionState.lastOpenAt;
        connectionState.lastError = undefined;
        connectionState.compatibility = evaluateProtocolCompatibility(PROTOCOL_VERSION);
        connectionState.attemptIndex = 0;
        clearOpenTimeout();
        send({
          kind: "hello",
          client: "easyeda-pro-extension",
          version: EXTENSION_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          compatibility: connectionState.compatibility,
          capabilities: detectCapabilities(),
          status: await getStatus()
        });
        startHeartbeat();
        if (!connectionState.connectedOnce || options.manual) {
          connectionState.connectedOnce = true;
          showMessage("EasyEDA MCP Bridge", `Connected to ${wsUri}.`);
        }
      }
    );
  } catch (error) {
    handleConnectionFailure(normalizeError(error), {
      manual: options.manual,
      shouldRetry: true
    });
    return;
  }

  log("warn", `Bridge connection attempt ${attemptIndex + 1} started for ${options.reason} -> ${wsUri}`);
}

async function handleMessage(raw: string): Promise<void> {
  let message: BridgeCallMessage;
  try {
    message = JSON.parse(raw) as BridgeCallMessage;
  } catch (error) {
    log("warn", "Ignored malformed MCP bridge message", error);
    return;
  }

  if (message.kind !== "call" || !message.requestId || !message.method) {
    return;
  }

  try {
    const handler = handlers[message.method];
    if (!handler) {
      throw apiError("unknown_method", `Unsupported MCP bridge method: ${message.method}`);
    }
    const result = await handler(message.params ?? {});
    send({
      kind: "result",
      requestId: message.requestId,
      result
    });
  } catch (error) {
    send({
      kind: "error",
      requestId: message.requestId,
      error: normalizeError(error)
    });
  }
}

function send(message: Record<string, unknown>): void {
  ensureApi("sys_WebSocket", "send");
  try {
    eda.sys_WebSocket.send(WS_ID, JSON.stringify(message));
  } catch (error) {
    handleConnectionFailure(normalizeError(error), {
      manual: false,
      shouldRetry: true
    });
    throw error;
  }
}

async function getStatus(): Promise<Record<string, unknown>> {
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl.getCurrentDocumentInfo());
  return {
    connected: connectionState.phase === "connected",
    connectionState: connectionState.phase,
    extensionVersion: EXTENSION_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    compatibility: connectionState.compatibility,
    capabilities: detectCapabilities(),
    activeDocumentType: inferDocumentType(documentInfo),
    projectName: pickString(documentInfo, ["projectName", "project", "parentName"]),
    documentName: pickString(documentInfo, ["name", "title", "documentName"]),
    message: connectionState.lastError?.message,
    documentInfo: sanitize(documentInfo),
    updatedAt: new Date().toISOString()
  };
}

async function emitStatusUpdate(): Promise<void> {
  send({
    kind: "status",
    compatibility: connectionState.compatibility,
    status: await getStatus()
  });
  connectionState.lastStatusAt = new Date().toISOString();
}

function startHeartbeat(): void {
  if (connectionState.heartbeatTimer) {
    clearInterval(connectionState.heartbeatTimer);
  }
  connectionState.heartbeatTimer = setInterval(() => {
    void emitStatusUpdate().catch((error) => {
      handleConnectionFailure(normalizeError(error), {
        manual: false,
        shouldRetry: true
      });
    });
  }, bridgeConfig.heartbeatIntervalMs);
}

function clearOpenTimeout(): void {
  if (connectionState.openTimeoutTimer) {
    clearTimeout(connectionState.openTimeoutTimer);
    connectionState.openTimeoutTimer = undefined;
  }
}

function resetConnectionTimers(): void {
  clearOpenTimeout();
  if (connectionState.reconnectTimer) {
    clearTimeout(connectionState.reconnectTimer);
    connectionState.reconnectTimer = undefined;
  }
  if (connectionState.heartbeatTimer) {
    clearInterval(connectionState.heartbeatTimer);
    connectionState.heartbeatTimer = undefined;
  }
}

function handleConnectionFailure(
  error: BridgeErrorMessage["error"],
  options: { manual: boolean; shouldRetry: boolean }
): void {
  clearOpenTimeout();
  if (connectionState.heartbeatTimer) {
    clearInterval(connectionState.heartbeatTimer);
    connectionState.heartbeatTimer = undefined;
  }

  connectionState.lastError = error;
  connectionState.compatibility = evaluateProtocolCompatibility(PROTOCOL_VERSION);
  connectionState.phase = isPermissionLikeError(error) ? "blocked" : "idle";

  const hasRetryLeft = options.shouldRetry && connectionState.attemptIndex < bridgeConfig.reconnectDelayMs.length - 1;
  if (hasRetryLeft) {
    const nextAttempt = connectionState.attemptIndex + 1;
    const delayMs = bridgeConfig.reconnectDelayMs[nextAttempt];
    connectionState.attemptIndex = nextAttempt;
    connectionState.reconnectTimer = setTimeout(() => {
      connectionState.reconnectTimer = undefined;
      void ensureBridgeConnected({
        reason: "retry",
        manual: false
      });
    }, delayMs);
  }

  if (options.manual || !hasRetryLeft || connectionState.phase === "blocked") {
    showMessage("EasyEDA MCP Bridge", [
      error.message,
      "",
      ...diagnosticHints(error)
    ].join("\n"));
  }
}

async function collectDiagnostics(): Promise<Record<string, unknown>> {
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl.getCurrentDocumentInfo());
  return {
    bridge: {
      uri: getBridgeUri(bridgeConfig),
      config: bridgeConfig
    },
    websocket: {
      registerAvailable: Boolean(eda.sys_WebSocket?.register),
      sendAvailable: Boolean(eda.sys_WebSocket?.send)
    },
    connection: {
      phase: connectionState.phase,
      connectedOnce: connectionState.connectedOnce,
      lastAttemptAt: connectionState.lastAttemptAt,
      lastOpenAt: connectionState.lastOpenAt,
      lastHandshakeAt: connectionState.lastHandshakeAt,
      lastStatusAt: connectionState.lastStatusAt,
      lastError: connectionState.lastError,
      compatibility: connectionState.compatibility
    },
    activeDocument: {
      available: Boolean(documentInfo),
      type: inferDocumentType(documentInfo),
      projectName: pickString(documentInfo, ["projectName", "project", "parentName"]),
      documentName: pickString(documentInfo, ["name", "title", "documentName"])
    },
    nextSteps: diagnosticHints(connectionState.lastError)
  };
}

function formatStatusSummary(diagnostics: Record<string, unknown>): string {
  const connection = diagnostics.connection as Record<string, unknown>;
  const document = diagnostics.activeDocument as Record<string, unknown>;
  return [
    `Bridge URI: ${getBridgeUri(bridgeConfig)}`,
    `Connection phase: ${String(connection.phase ?? "unknown")}`,
    `Last open: ${String(connection.lastOpenAt ?? "never")}`,
    `Document: ${String(document.documentName ?? document.projectName ?? "none")}`
  ].join("\n");
}

function formatDiagnostics(diagnostics: Record<string, unknown>): string {
  const websocket = diagnostics.websocket as Record<string, unknown>;
  const connection = diagnostics.connection as Record<string, unknown>;
  const document = diagnostics.activeDocument as Record<string, unknown>;
  const nextSteps = Array.isArray(diagnostics.nextSteps) ? diagnostics.nextSteps as string[] : [];

  return [
    `Bridge URI: ${getBridgeUri(bridgeConfig)}`,
    `WebSocket register available: ${String(websocket.registerAvailable)}`,
    `WebSocket send available: ${String(websocket.sendAvailable)}`,
    `Connection phase: ${String(connection.phase ?? "unknown")}`,
    `Last open: ${String(connection.lastOpenAt ?? "never")}`,
    `Last status: ${String(connection.lastStatusAt ?? "never")}`,
    `Compatibility: ${String((connection.compatibility as Record<string, unknown>)?.compatible ?? false)}`,
    `Document: ${String(document.documentName ?? document.projectName ?? "none")}`,
    nextSteps.length > 0 ? `Next steps:\n- ${nextSteps.join("\n- ")}` : "Next steps: none"
  ].join("\n");
}

function diagnosticHints(error?: BridgeErrorMessage["error"]): string[] {
  if (isPermissionLikeError(error)) {
    return [
      "Enable external interaction/WebSocket permission for the extension in EasyEDA Pro.",
      "Reload the extension and let it auto-connect again."
    ];
  }

  if (error?.code === "bridge_open_timeout") {
    return [
      "Make sure the MCP server is running locally.",
      `Confirm the bridge endpoint is reachable at ${getBridgeUri(bridgeConfig)}.`
    ];
  }

  return [
    "Keep EasyEDA Pro open while the MCP server is running.",
    "Use Reconnect or Run Diagnostics from the extension menu if the bridge stays unavailable."
  ];
}

function isPermissionLikeError(error?: BridgeErrorMessage["error"]): boolean {
  const message = `${error?.message ?? ""} ${error?.code ?? ""}`.toLowerCase();
  return message.includes("permission") || message.includes("external interaction") || message.includes("sys_websocket");
}

async function getContext(): Promise<Record<string, unknown>> {
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl.getCurrentDocumentInfo());
  const splitScreenTree = await optionalCall(() => eda.dmt_EditorControl.getSplitScreenTree());
  const pcbNets = await optionalCall(() => getPcbNetNames());
  const pcbComponents = await optionalCall(() => getPcbComponents());
  const schComponents = await optionalCall(() => getSchematicComponents());

  return {
    status: await getStatus(),
    documentInfo: sanitize(documentInfo),
    splitScreenTree: sanitize(splitScreenTree),
    counts: {
      pcbNets: Array.isArray(pcbNets) ? pcbNets.length : undefined,
      pcbComponents: Array.isArray(pcbComponents) ? pcbComponents.length : undefined,
      schematicComponents: Array.isArray(schComponents) ? schComponents.length : undefined
    },
    betaApi: true
  };
}

async function findComponent(params: Record<string, any>): Promise<Record<string, unknown>> {
  const query = String(params.query ?? "").toLowerCase();
  const limit = Number(params.limit ?? 20);
  const pcb = (await optionalCall(() => getPcbComponents())) ?? [];
  const schematic = (await optionalCall(() => getSchematicComponents())) ?? [];
  const all = [
    ...toArray(pcb).map((item) => ({ source: "pcb", item })),
    ...toArray(schematic).map((item) => ({ source: "schematic", item }))
  ];
  const matches = all.filter(({ item }) => JSON.stringify(item).toLowerCase().includes(query)).slice(0, limit);

  return {
    query,
    count: matches.length,
    matches: matches.map(({ source, item }) => ({ source, component: simplifyPrimitive(item) })),
    betaApi: true
  };
}

async function findNet(params: Record<string, any>): Promise<Record<string, unknown>> {
  const query = String(params.query ?? "").toLowerCase();
  const limit = Number(params.limit ?? 20);
  const names = toArray(await getPcbNetNames()).filter((name) => String(name).toLowerCase().includes(query)).slice(0, limit);
  const nets = [];
  for (const name of names) {
    const detail = await optionalCall(() => eda.pcb_Net.getNet(name));
    const length = await optionalCall(() => eda.pcb_Net.getNetLength(name));
    nets.push({
      name,
      detail: sanitize(detail),
      length
    });
  }

  return {
    query,
    count: nets.length,
    nets,
    betaApi: true
  };
}

async function schematicSnapshot(params: Record<string, any>): Promise<SchematicSnapshot> {
  return collectSchematicSnapshot({
    includeRaw: params.includeRaw !== false,
    allPages: params.allPages !== false
  });
}

async function listSchematicComponentsTool(params: Record<string, any>): Promise<Record<string, unknown>> {
  const snapshot = await collectSchematicSnapshot({ includeRaw: params.includeRaw === true, allPages: params.allPages !== false });
  const components = listSchematicComponents(snapshot, stringOrUndefined(params.query), Number(params.limit ?? 100));
  return {
    components,
    count: components.length,
    totalComponents: snapshot.counts.components,
    confidence: snapshot.confidence,
    warnings: snapshot.warnings,
    betaApi: true
  };
}

async function getComponentPinsTool(params: Record<string, any>): Promise<Record<string, unknown>> {
  const snapshot = await collectSchematicSnapshot({ includeRaw: params.includeRaw !== false, allPages: params.allPages !== false });
  const result = getComponentPins(snapshot, String(params.query ?? ""));
  return {
    ...result,
    betaApi: true
  };
}

async function traceNetTool(params: Record<string, any>): Promise<Record<string, unknown>> {
  const snapshot = await collectSchematicSnapshot({ includeRaw: params.includeRaw !== false, allPages: params.allPages !== false });
  const result = traceNet(snapshot, String(params.query ?? ""));
  return {
    ...result,
    betaApi: true
  };
}

async function traceComponentTool(params: Record<string, any>): Promise<Record<string, unknown>> {
  const snapshot = await collectSchematicSnapshot({ includeRaw: params.includeRaw !== false, allPages: params.allPages !== false });
  const result = traceComponent(snapshot, String(params.query ?? ""));
  return {
    ...result,
    betaApi: true
  };
}

async function findUnconnectedPinsTool(params: Record<string, any>): Promise<Record<string, unknown>> {
  const snapshot = await collectSchematicSnapshot({ includeRaw: params.includeRaw !== false, allPages: params.allPages !== false });
  const result = findUnconnectedPins(snapshot, {
    includePowerPins: params.includePowerPins !== false,
    limit: Number(params.limit ?? 100)
  });
  return {
    ...result,
    betaApi: true
  };
}

async function validateSchematicAreaTool(params: Record<string, any>): Promise<Record<string, unknown>> {
  const snapshot = await collectSchematicSnapshot({ includeRaw: params.includeRaw !== false, allPages: params.allPages !== false });
  const result = validateSchematicArea(snapshot, {
    components: Array.isArray(params.components) ? params.components.map(String) : undefined,
    nets: Array.isArray(params.nets) ? params.nets.map(String) : undefined,
    includeGlobalChecks: params.includeGlobalChecks !== false
  });
  return {
    ...result,
    snapshotCounts: snapshot.counts,
    snapshotWarnings: snapshot.warnings,
    betaApi: true
  };
}

async function verifyConnectionsTool(params: Record<string, any>): Promise<Record<string, unknown>> {
  const snapshot = await collectSchematicSnapshot({ includeRaw: params.includeRaw !== false, allPages: params.allPages !== false });
  const result = verifyConnections(snapshot, Array.isArray(params.checks) ? params.checks : [], {
    maxHops: Number(params.maxHops ?? 4)
  });
  return {
    ...result,
    snapshotCounts: snapshot.counts,
    snapshotWarnings: snapshot.warnings,
    betaApi: true
  };
}

async function navigateComponent(params: Record<string, any>): Promise<Record<string, unknown>> {
  const result = await findComponent({ query: params.query, limit: 1 });
  const first = (result.matches as any[])?.[0];
  if (!first) {
    throw apiError("component_not_found", `No component matched "${params.query}".`);
  }

  const primitiveId = first.component.primitiveId ?? first.component.id ?? first.component.uuid;
  if (!primitiveId) {
    return {
      navigated: false,
      reason: "Matched component did not expose a primitive id.",
      match: first,
      betaApi: true
    };
  }

  const primitiveApi = first.source === "pcb" ? eda.pcb_Primitive : eda.sch_Primitive;
  const bbox = await optionalCall(() => primitiveApi.getPrimitivesBBox([primitiveId]));
  const region = normalizeBBox(bbox);
  if (region) {
    await zoomToRegion(region.left, region.right, region.top, region.bottom);
  }

  return {
    navigated: Boolean(region),
    primitiveId,
    region,
    match: first,
    betaApi: true
  };
}

async function navigateRegion(params: Record<string, any>): Promise<Record<string, unknown>> {
  if (isNumber(params.x) && isNumber(params.y)) {
    if (eda.pcb_Document?.navigateToCoordinates) {
      await eda.pcb_Document.navigateToCoordinates(params.x, params.y);
      return { navigated: true, mode: "coordinates", x: params.x, y: params.y };
    }
    if (eda.dmt_EditorControl?.zoomTo) {
      await eda.dmt_EditorControl.zoomTo(params.x, params.y, params.scaleRatio ?? 1);
      return { navigated: true, mode: "zoomTo", x: params.x, y: params.y, betaApi: true };
    }
  }

  for (const key of ["left", "right", "top", "bottom"]) {
    if (!isNumber(params[key])) {
      throw apiError("invalid_region", "Provide either x/y coordinates or left/right/top/bottom region values.");
    }
  }

  await zoomToRegion(params.left, params.right, params.top, params.bottom);
  return {
    navigated: true,
    mode: "region",
    region: {
      left: params.left,
      right: params.right,
      top: params.top,
      bottom: params.bottom
    },
    betaApi: true
  };
}

async function zoomBoard(): Promise<Record<string, unknown>> {
  ensureApi("pcb_Document", "zoomToBoardOutline");
  await eda.pcb_Document.zoomToBoardOutline();
  return {
    zoomed: true,
    betaApi: true
  };
}

async function exportBom(params: Record<string, any>): Promise<Record<string, unknown>> {
  const fileName = params.fileName ?? `easyeda-bom-${timestamp()}`;
  const format = params.format ?? "csv";
  const api = pickManufactureApi(params.scope, "getBomFile");
  const file = await api.getBomFile(fileName, format);
  return saveApiFile(file, `${fileName}.${format}`, true);
}

async function exportNetlist(params: Record<string, any>): Promise<Record<string, unknown>> {
  const fileName = params.fileName ?? `easyeda-netlist-${timestamp()}`;
  const api = pickManufactureApi(params.scope, "getNetlistFile");
  const file = await api.getNetlistFile(fileName, params.netlistType);
  return saveApiFile(file, `${fileName}.net`, true);
}

async function exportGerber(params: Record<string, any>): Promise<Record<string, unknown>> {
  ensureApi("pcb_ManufactureData", "getGerberFile");
  const fileName = params.fileName ?? `easyeda-gerber-${timestamp()}`;
  const file = await eda.pcb_ManufactureData.getGerberFile(fileName);
  return saveApiFile(file, `${fileName}.zip`, true);
}

async function exportPdf(params: Record<string, any>): Promise<Record<string, unknown>> {
  const fileName = params.fileName ?? `easyeda-export-${timestamp()}`;
  if (params.scope === "schematic" || (!eda.pcb_ManufactureData?.getPdfFile && eda.sch_ManufactureData?.getExportDocumentFile)) {
    const file = await eda.sch_ManufactureData.getExportDocumentFile(fileName, "pdf");
    return saveApiFile(file, `${fileName}.pdf`, true);
  }
  ensureApi("pcb_ManufactureData", "getPdfFile");
  const file = await eda.pcb_ManufactureData.getPdfFile(fileName);
  return saveApiFile(file, `${fileName}.pdf`, true);
}

async function confirmedAction(params: Record<string, any>): Promise<Record<string, unknown>> {
  const action = String(params.action ?? "");
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl.getCurrentDocumentInfo());
  const documentUuid = pickString(documentInfo, ["uuid", "documentUuid", "id"]);

  if (action === "save") {
    if (eda.pcb_Document?.save) {
      await eda.pcb_Document.save(documentUuid);
      return { action, saved: true, documentUuid };
    }
    if (eda.sch_Document?.save) {
      await eda.sch_Document.save(documentUuid);
      return { action, saved: true, documentUuid };
    }
  }

  if (action === "importChanges") {
    ensureApi("pcb_Document", "importChanges");
    await eda.pcb_Document.importChanges(params.uuid ?? documentUuid);
    return { action, imported: true, documentUuid: params.uuid ?? documentUuid };
  }

  if (action === "autoroute") {
    ensureApi("pcb_Document", "importAutoRouteJsonFile");
    if (!params.params?.file) {
      throw apiError("missing_file", "autoroute requires params.file from an EasyEDA-compatible autoroute JSON/SES file.");
    }
    await eda.pcb_Document.importAutoRouteJsonFile(params.params.file);
    return { action, imported: true, betaApi: true };
  }

  if (action === "createBoard") {
    ensureApi("dmt_Board", "createBoard");
    const boardName = await eda.dmt_Board.createBoard(params.params?.schematicUuid, params.params?.pcbUuid);
    if (!boardName) {
      throw apiError("create_board_failed", "EasyEDA Pro did not create the board.");
    }
    return { action, created: true, boardName, betaApi: true };
  }

  if (action === "autolayout") {
    ensureApi("pcb_Document", "importAutoLayoutJsonFile");
    if (!params.params?.file) {
      throw apiError("missing_file", "autolayout requires params.file from an EasyEDA-compatible autolayout JSON file.");
    }
    await eda.pcb_Document.importAutoLayoutJsonFile(params.params.file);
    return { action, imported: true, betaApi: true };
  }

  throw apiError("unsupported_action", `Unsupported or unavailable confirmed action: ${action}.`);
}

async function libSearchDevices(params: Record<string, any>): Promise<Record<string, unknown>> {
  ensureApi("lib_Device", "search");
  const query = String(params.query ?? "").trim();
  if (!query) {
    throw apiError("invalid_query", "libSearchDevices requires a non-empty query.");
  }
  const limit = Number(params.limit ?? 10);
  const page = Number(params.page ?? 1);
  const results = toArray(await eda.lib_Device.search(query, undefined, undefined, undefined, limit, page));
  return {
    query,
    count: results.length,
    devices: results.map(simplifyDeviceSearchItem),
    betaApi: true
  };
}

function simplifyDeviceSearchItem(value: unknown): Record<string, unknown> {
  const item = sanitize(value) as Record<string, unknown>;
  const otherProperty = isRecord(item.otherProperty) ? item.otherProperty : undefined;
  return {
    uuid: item.uuid,
    libraryUuid: item.libraryUuid,
    name: item.name,
    description: item.description,
    symbol: item.symbol,
    footprint: item.footprint,
    supplierId: item.supplierId ?? otherProperty?.["Supplier Part"],
    otherProperty
  };
}

async function schDraw(params: Record<string, any>): Promise<Record<string, unknown>> {
  const ops = Array.isArray(params.ops) ? params.ops : [];
  if (ops.length === 0) {
    throw apiError("no_ops", "schDraw requires at least one op.");
  }
  const continueOnError = params.continueOnError === true;
  const results: Array<Record<string, unknown>> = [];
  for (let index = 0; index < ops.length; index++) {
    const op = isRecord(ops[index]) ? ops[index] as Record<string, any> : {};
    try {
      results.push({ index, op: op.op, ok: true, ...(await runDrawOp(op)) });
    } catch (error) {
      results.push({ index, op: op.op, ok: false, error: normalizeError(error) });
      if (!continueOnError) {
        break;
      }
    }
  }
  const completed = results.filter((entry) => entry.ok === true).length;
  return {
    completed,
    failed: results.length - completed,
    skipped: ops.length - results.length,
    results,
    betaApi: true
  };
}

async function runDrawOp(op: Record<string, any>): Promise<Record<string, unknown>> {
  switch (op.op) {
    case "placeComponent": {
      ensureApi("sch_PrimitiveComponent", "create");
      const device = isRecord(op.device) ? op.device : undefined;
      if (!device?.uuid || !device?.libraryUuid) {
        throw apiError("invalid_device", "placeComponent requires device.uuid and device.libraryUuid.");
      }
      const created = await eda.sch_PrimitiveComponent.create(
        { uuid: String(device.uuid), libraryUuid: String(device.libraryUuid) },
        op.x,
        op.y,
        op.subPartName,
        op.rotation,
        op.mirror,
        op.addIntoBom,
        op.addIntoPcb
      );
      const primitiveId = readPrimitiveId(created);
      if (!primitiveId) {
        throw apiError("create_failed", "EasyEDA Pro did not create the component (no primitive id returned).");
      }
      const modifyProperty: Record<string, unknown> = {};
      if (typeof op.designator === "string" && op.designator) {
        modifyProperty.designator = op.designator;
      }
      if (typeof op.name === "string" && op.name) {
        modifyProperty.name = op.name;
      }
      if (Object.keys(modifyProperty).length > 0 && eda.sch_PrimitiveComponent.modify) {
        await optionalCall(() => eda.sch_PrimitiveComponent.modify(primitiveId, modifyProperty));
      }
      const pins = toArray(await optionalCall(() => eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId)))
        .map(simplifyPinPrimitive);
      return { primitiveId, pins };
    }
    case "wire": {
      ensureApi("sch_PrimitiveWire", "create");
      const created = await eda.sch_PrimitiveWire.create(op.points, op.net);
      const primitiveId = readPrimitiveId(created);
      if (!primitiveId) {
        throw apiError("create_failed", "EasyEDA Pro did not create the wire (check that segments are connected and horizontal/vertical).");
      }
      return { primitiveId };
    }
    case "netLabel": {
      ensureApi("sch_PrimitiveAttribute", "createNetLabel");
      const created = await eda.sch_PrimitiveAttribute.createNetLabel(op.x, op.y, op.net);
      const primitiveId = readPrimitiveId(created);
      if (!primitiveId) {
        throw apiError("create_failed", "EasyEDA Pro did not create the net label (it must land on a wire or pin).");
      }
      return { primitiveId };
    }
    case "netFlag": {
      ensureApi("sch_PrimitiveComponent", "createNetFlag");
      const created = await eda.sch_PrimitiveComponent.createNetFlag(op.kind, op.net, op.x, op.y, op.rotation, op.mirror);
      const primitiveId = readPrimitiveId(created);
      if (!primitiveId) {
        throw apiError("create_failed", "EasyEDA Pro did not create the net flag.");
      }
      return { primitiveId };
    }
    case "netPort": {
      ensureApi("sch_PrimitiveComponent", "createNetPort");
      const created = await eda.sch_PrimitiveComponent.createNetPort(op.direction ?? "BI", op.net, op.x, op.y, op.rotation, op.mirror);
      const primitiveId = readPrimitiveId(created);
      if (!primitiveId) {
        throw apiError("create_failed", "EasyEDA Pro did not create the net port.");
      }
      return { primitiveId };
    }
    case "text": {
      ensureApi("sch_PrimitiveText", "create");
      const created = await eda.sch_PrimitiveText.create(op.x, op.y, op.content, op.rotation, null, null, op.fontSize ?? null);
      const primitiveId = readPrimitiveId(created);
      if (!primitiveId) {
        throw apiError("create_failed", "EasyEDA Pro did not create the text.");
      }
      return { primitiveId };
    }
    case "modifyComponent": {
      ensureApi("sch_PrimitiveComponent", "modify");
      const modified = await eda.sch_PrimitiveComponent.modify(String(op.primitiveId), isRecord(op.property) ? op.property : {});
      return { primitiveId: readPrimitiveId(modified) ?? String(op.primitiveId) };
    }
    default:
      throw apiError("unknown_op", `Unsupported schDraw op: ${String(op.op)}.`);
  }
}

async function schDelete(params: Record<string, any>): Promise<Record<string, unknown>> {
  ensureApi("sch_Primitive", "getPrimitiveTypeByPrimitiveId");
  const primitiveIds = toArray(params.primitiveIds).map(String).filter((id) => id.trim());
  if (primitiveIds.length === 0) {
    throw apiError("no_primitive_ids", "schDelete requires at least one primitive id.");
  }
  const deleteApis: Record<string, { api: string; method: string }> = {
    Component: { api: "sch_PrimitiveComponent", method: "delete" },
    Wire: { api: "sch_PrimitiveWire", method: "delete" },
    Text: { api: "sch_PrimitiveText", method: "delete" },
    Attribute: { api: "sch_PrimitiveAttribute", method: "delete" }
  };
  const results: Array<Record<string, unknown>> = [];
  for (const primitiveId of primitiveIds) {
    const type = String(await eda.sch_Primitive.getPrimitiveTypeByPrimitiveId(primitiveId) ?? "");
    const target = deleteApis[type];
    if (!target || !eda[target.api]?.[target.method]) {
      results.push({ primitiveId, type: type || undefined, deleted: false, reason: `No delete API for primitive type "${type || "unknown"}".` });
      continue;
    }
    const deleted = await eda[target.api][target.method](primitiveId);
    results.push({ primitiveId, type, deleted: deleted === true });
  }
  return { results, betaApi: true };
}

async function schNetlist(params: Record<string, any>): Promise<Record<string, unknown>> {
  ensureApi("sch_Primitive", "getNetlist");
  const netlist = await eda.sch_Primitive.getNetlist(params.netlistType);
  const projectNets = await optionalCall(() =>
    eda.sch_Primitive?.getCurrentProjectAllNets ? eda.sch_Primitive.getCurrentProjectAllNets() : undefined
  );
  return {
    netlist: String(netlist ?? ""),
    projectNets: sanitize(projectNets),
    betaApi: true
  };
}

async function pcbInfo(params: Record<string, any>): Promise<Record<string, unknown>> {
  ensureApi("pcb_PrimitiveComponent", "getAll");
  const components = toArray(await eda.pcb_PrimitiveComponent.getAll());
  const simplified: Array<Record<string, unknown>> = [];
  for (const component of components) {
    const record = isRecord(component) ? component as Record<string, any> : {};
    const call = (name: string): unknown => (typeof record[name] === "function" ? record[name]() : undefined);
    const entry: Record<string, unknown> = {
      primitiveId: call("getState_PrimitiveId") ?? record.primitiveId ?? record.id,
      designator: call("getState_Designator") ?? record.designator,
      name: call("getState_Name") ?? record.name,
      x: call("getState_X") ?? record.x,
      y: call("getState_Y") ?? record.y,
      rotation: call("getState_Rotation") ?? record.rotation,
      layer: call("getState_Layer") ?? record.layer,
      primitiveLock: call("getState_PrimitiveLock") ?? record.primitiveLock
    };
    if (params.includeBBox === true && entry.primitiveId && eda.pcb_Primitive?.getPrimitivesBBox) {
      const bbox = await optionalCall(() => eda.pcb_Primitive.getPrimitivesBBox([String(entry.primitiveId)]));
      if (bbox) {
        entry.bbox = sanitize(bbox);
      }
    }
    simplified.push(entry);
  }
  const nets = await optionalCall(() => getPcbNetNames());
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl.getCurrentDocumentInfo());
  return {
    components: simplified,
    componentCount: simplified.length,
    nets: toArray(nets).map(String),
    documentInfo: sanitize(documentInfo),
    unitNote: "PCB canvas coordinates are in mil.",
    betaApi: true
  };
}

async function pcbDraw(params: Record<string, any>): Promise<Record<string, unknown>> {
  const ops = Array.isArray(params.ops) ? params.ops : [];
  if (ops.length === 0) {
    throw apiError("no_ops", "pcbDraw requires at least one op.");
  }
  const continueOnError = params.continueOnError === true;
  const results: Array<Record<string, unknown>> = [];
  for (let index = 0; index < ops.length; index++) {
    const op = isRecord(ops[index]) ? ops[index] as Record<string, any> : {};
    try {
      results.push({ index, op: op.op, ok: true, ...(await runPcbDrawOp(op)) });
    } catch (error) {
      results.push({ index, op: op.op, ok: false, error: normalizeError(error) });
      if (!continueOnError) {
        break;
      }
    }
  }
  const completed = results.filter((entry) => entry.ok === true).length;
  return {
    completed,
    failed: results.length - completed,
    skipped: ops.length - results.length,
    results,
    betaApi: true
  };
}

async function resolvePcbComponentId(op: Record<string, any>): Promise<string> {
  if (typeof op.primitiveId === "string" && op.primitiveId) {
    return op.primitiveId;
  }
  const designator = String(op.designator ?? "").trim();
  if (!designator) {
    throw apiError("missing_target", "moveComponent requires primitiveId or designator.");
  }
  ensureApi("pcb_PrimitiveComponent", "getAll");
  const components = toArray(await eda.pcb_PrimitiveComponent.getAll());
  for (const component of components) {
    const record = isRecord(component) ? component as Record<string, any> : {};
    const call = (name: string): unknown => (typeof record[name] === "function" ? record[name]() : undefined);
    const candidate = String(call("getState_Designator") ?? record.designator ?? "");
    if (candidate === designator) {
      const id = call("getState_PrimitiveId") ?? record.primitiveId ?? record.id;
      if (typeof id === "string" && id) {
        return id;
      }
    }
  }
  throw apiError("component_not_found", `No PCB component with designator "${designator}".`);
}

function buildPcbPolygon(source: unknown): unknown {
  ensureApi("pcb_MathPolygon", "createPolygon");
  return eda.pcb_MathPolygon.createPolygon(source);
}

async function runPcbDrawOp(op: Record<string, any>): Promise<Record<string, unknown>> {
  switch (op.op) {
    case "moveComponent": {
      ensureApi("pcb_PrimitiveComponent", "modify");
      const primitiveId = await resolvePcbComponentId(op);
      const property: Record<string, unknown> = {};
      for (const key of ["x", "y", "rotation", "layer", "primitiveLock"]) {
        if (op[key] !== undefined) {
          property[key] = op[key];
        }
      }
      const modified = await eda.pcb_PrimitiveComponent.modify(primitiveId, property);
      return { primitiveId: readPrimitiveId(modified) ?? primitiveId };
    }
    case "line": {
      ensureApi("pcb_PrimitiveLine", "create");
      const created = await eda.pcb_PrimitiveLine.create(
        String(op.net ?? ""),
        op.layer,
        op.startX,
        op.startY,
        op.endX,
        op.endY,
        op.lineWidth
      );
      const primitiveId = readPrimitiveId(created);
      if (!primitiveId) {
        throw apiError("create_failed", "EasyEDA Pro did not create the PCB line.");
      }
      return { primitiveId };
    }
    case "arc": {
      ensureApi("pcb_PrimitiveArc", "create");
      const created = await eda.pcb_PrimitiveArc.create(
        String(op.net ?? ""),
        op.layer,
        op.startX,
        op.startY,
        op.endX,
        op.endY,
        op.arcAngle,
        op.lineWidth
      );
      const primitiveId = readPrimitiveId(created);
      if (!primitiveId) {
        throw apiError("create_failed", "EasyEDA Pro did not create the PCB arc.");
      }
      return { primitiveId };
    }
    case "via": {
      ensureApi("pcb_PrimitiveVia", "create");
      const created = await eda.pcb_PrimitiveVia.create(
        String(op.net ?? ""),
        op.x,
        op.y,
        op.holeDiameter,
        op.diameter
      );
      const primitiveId = readPrimitiveId(created);
      if (!primitiveId) {
        throw apiError("create_failed", "EasyEDA Pro did not create the via.");
      }
      return { primitiveId };
    }
    case "region": {
      ensureApi("pcb_PrimitiveRegion", "create");
      const polygon = buildPcbPolygon(op.polygon);
      const created = await eda.pcb_PrimitiveRegion.create(
        op.layer,
        polygon,
        Array.isArray(op.ruleTypes) ? op.ruleTypes : undefined,
        op.regionName
      );
      const primitiveId = readPrimitiveId(created);
      if (!primitiveId) {
        throw apiError("create_failed", "EasyEDA Pro did not create the region.");
      }
      return { primitiveId };
    }
    case "pour": {
      ensureApi("pcb_PrimitivePour", "create");
      const polygon = buildPcbPolygon(op.polygon);
      const created = await eda.pcb_PrimitivePour.create(
        String(op.net ?? ""),
        op.layer,
        polygon,
        undefined,
        undefined,
        op.pourName,
        op.pourPriority
      );
      const primitiveId = readPrimitiveId(created);
      if (!primitiveId) {
        throw apiError("create_failed", "EasyEDA Pro did not create the copper pour.");
      }
      return { primitiveId };
    }
    default:
      throw apiError("unknown_op", `Unsupported pcbDraw op: ${String(op.op)}.`);
  }
}

async function pcbDelete(params: Record<string, any>): Promise<Record<string, unknown>> {
  ensureApi("pcb_Primitive", "getPrimitiveTypeByPrimitiveId");
  const primitiveIds = toArray(params.primitiveIds).map(String).filter((id) => id.trim());
  if (primitiveIds.length === 0) {
    throw apiError("no_primitive_ids", "pcbDelete requires at least one primitive id.");
  }
  const deleteApis: Record<string, string> = {
    Component: "pcb_PrimitiveComponent",
    Line: "pcb_PrimitiveLine",
    Arc: "pcb_PrimitiveArc",
    Via: "pcb_PrimitiveVia",
    Region: "pcb_PrimitiveRegion",
    Pour: "pcb_PrimitivePour",
    Fill: "pcb_PrimitiveFill",
    String: "pcb_PrimitiveString",
    Polyline: "pcb_PrimitivePolyline"
  };
  const results: Array<Record<string, unknown>> = [];
  for (const primitiveId of primitiveIds) {
    const type = String(await eda.pcb_Primitive.getPrimitiveTypeByPrimitiveId(primitiveId) ?? "");
    const api = deleteApis[type];
    if (!api || !eda[api]?.delete) {
      results.push({ primitiveId, type: type || undefined, deleted: false, reason: `No delete API for PCB primitive type "${type || "unknown"}".` });
      continue;
    }
    const deleted = await eda[api].delete(primitiveId);
    results.push({ primitiveId, type, deleted: deleted === true });
  }
  return { results, betaApi: true };
}

function readPrimitiveId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, any>;
  if (typeof record.getState_PrimitiveId === "function") {
    const id = record.getState_PrimitiveId();
    return typeof id === "string" && id ? id : undefined;
  }
  return stringOrUndefined(record.primitiveId ?? record.id ?? record.uuid);
}

function simplifyPinPrimitive(value: unknown): Record<string, unknown> {
  const record = isRecord(value) ? value as Record<string, any> : {};
  const call = (name: string): unknown => (typeof record[name] === "function" ? record[name]() : undefined);
  return {
    primitiveId: call("getState_PrimitiveId") ?? record.primitiveId ?? record.id,
    pinNumber: call("getState_PinNumber") ?? record.pinNumber ?? record.number,
    pinName: call("getState_PinName") ?? record.pinName ?? record.name,
    x: call("getState_X") ?? record.x,
    y: call("getState_Y") ?? record.y
  };
}

function detectCapabilities(): Record<string, boolean> {
  return {
    websocket: Boolean(eda.sys_WebSocket?.register && eda.sys_WebSocket?.send),
    pcbDocument: Boolean(eda.pcb_Document),
    schDocument: Boolean(eda.sch_Document),
    pcbManufactureData: Boolean(eda.pcb_ManufactureData),
    schManufactureData: Boolean(eda.sch_ManufactureData),
    fileSystem: Boolean(eda.sys_FileSystem?.saveFile),
    schDraw: Boolean(eda.sch_PrimitiveComponent?.create && eda.sch_PrimitiveWire?.create),
    libSearch: Boolean(eda.lib_Device?.search),
    pcbDraw: Boolean(eda.pcb_PrimitiveComponent?.modify && eda.pcb_PrimitiveLine?.create)
  };
}

async function getPcbComponents(): Promise<unknown[]> {
  ensureApi("pcb_PrimitiveComponent", "getAll");
  return toArray(await eda.pcb_PrimitiveComponent.getAll());
}

async function getSchematicComponents(): Promise<unknown[]> {
  ensureApi("sch_PrimitiveComponent", "getAll");
  return toArray(await eda.sch_PrimitiveComponent.getAll(undefined, true));
}

async function collectSchematicSnapshot(options: { includeRaw: boolean; allPages: boolean }): Promise<SchematicSnapshot> {
  ensureApi("sch_PrimitiveComponent", "getAll");
  const components = toArray(await eda.sch_PrimitiveComponent.getAll(undefined, options.allPages));
  const pinsByComponent: Record<string, unknown[]> = {};

  if (eda.sch_PrimitiveComponent?.getAllPinsByPrimitiveId) {
    for (const component of components) {
      const componentRecord = component && typeof component === "object" ? component as Record<string, unknown> : {};
      const primitiveId = stringOrUndefined(componentRecord.primitiveId ?? componentRecord.id ?? componentRecord.uuid);
      if (!primitiveId) {
        continue;
      }
      const pins = await optionalCall(() => eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId));
      pinsByComponent[primitiveId] = toArray(pins);
    }
  }

  const rawData: RawSchematicData = {
    components,
    pinsByComponent,
    wires: await optionalCall(() => eda.sch_PrimitiveWire?.getAll ? eda.sch_PrimitiveWire.getAll() : []),
    texts: await optionalCall(() => eda.sch_PrimitiveText?.getAll ? eda.sch_PrimitiveText.getAll() : []),
    includeRaw: options.includeRaw
  };
  return buildSchematicSnapshot(rawData);
}

async function getPcbNetNames(): Promise<unknown[]> {
  ensureApi("pcb_Net", "getAllNetsName");
  if (eda.pcb_Net.getAllNetsName) {
    return toArray(await eda.pcb_Net.getAllNetsName());
  }
  return toArray(await eda.pcb_Net.getAllNetName());
}

async function zoomToRegion(left: number, right: number, top: number, bottom: number): Promise<void> {
  if (eda.pcb_Document?.navigateToRegion) {
    await eda.pcb_Document.navigateToRegion(left, right, top, bottom);
    return;
  }
  ensureApi("dmt_EditorControl", "zoomToRegion");
  await eda.dmt_EditorControl.zoomToRegion(left, right, top, bottom);
}

function pickManufactureApi(scope: string | undefined, method: string): any {
  if (scope === "schematic") {
    ensureApi("sch_ManufactureData", method);
    return eda.sch_ManufactureData;
  }
  if (scope === "pcb") {
    ensureApi("pcb_ManufactureData", method);
    return eda.pcb_ManufactureData;
  }
  if (eda.pcb_ManufactureData?.[method]) {
    return eda.pcb_ManufactureData;
  }
  ensureApi("sch_ManufactureData", method);
  return eda.sch_ManufactureData;
}

async function saveApiFile(file: unknown, fallbackFileName: string, betaApi: boolean): Promise<Record<string, unknown>> {
  const normalizedFile = extractFile(file);
  if (!normalizedFile) {
    return {
      saved: false,
      file: sanitize(file),
      reason: "EasyEDA returned a non-File value; returning it without saving.",
      betaApi
    };
  }

  ensureApi("sys_FileSystem", "saveFile");
  const fileName = (normalizedFile as File).name || fallbackFileName;
  const saveResult = await eda.sys_FileSystem.saveFile(normalizedFile, fileName);
  return {
    saved: true,
    fileName,
    saveResult: sanitize(saveResult),
    betaApi
  };
}

function extractFile(value: unknown): unknown {
  if (typeof File !== "undefined" && value instanceof File) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.find((item) => typeof File !== "undefined" && item instanceof File) ?? value[0];
  }
  if (value && typeof value === "object" && "file" in value) {
    return (value as { file: unknown }).file;
  }
  return value;
}

function simplifyPrimitive(value: unknown): Record<string, unknown> {
  const item = sanitize(value) as Record<string, unknown>;
  return {
    primitiveId: item.primitiveId ?? item.id ?? item.uuid,
    designator: item.designator ?? item.name ?? item.displayName ?? item.prefix,
    value: item.value ?? item.comment ?? item.title,
    footprint: item.footprint ?? item.package ?? item.packageName,
    x: item.x,
    y: item.y,
    layer: item.layer,
    raw: item
  };
}

function normalizeBBox(value: unknown): { left: number; right: number; top: number; bottom: number } | undefined {
  const item = Array.isArray(value) ? value[0] : value;
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const box = item as Record<string, unknown>;
  const left = numeric(box.left ?? box.minX ?? box.x1);
  const right = numeric(box.right ?? box.maxX ?? box.x2);
  const top = numeric(box.top ?? box.minY ?? box.y1);
  const bottom = numeric(box.bottom ?? box.maxY ?? box.y2);
  if ([left, right, top, bottom].every((number) => number !== undefined)) {
    return { left, right, top, bottom } as { left: number; right: number; top: number; bottom: number };
  }
  return undefined;
}

function ensureApi(objectName: string, methodName: string): void {
  if (!eda[objectName]?.[methodName]) {
    throw apiError("api_unavailable", `EasyEDA Pro API eda.${objectName}.${methodName} is unavailable in this context.`);
  }
}

function apiError(code: string, message: string, details?: unknown): Error & { code: string; details?: unknown } {
  const error = new Error(message) as Error & { code: string; details?: unknown };
  error.code = code;
  error.details = details;
  return error;
}

function normalizeError(error: unknown): BridgeErrorMessage["error"] {
  if (error instanceof Error) {
    const coded = error as Error & { code?: string; details?: unknown };
    return {
      code: coded.code ?? "easyeda_extension_error",
      message: error.message,
      details: sanitize(coded.details)
    };
  }
  return {
    code: "easyeda_extension_error",
    message: String(error)
  };
}

async function optionalCall<T>(fn: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    log("warn", "Optional EasyEDA API call failed", error);
    return undefined;
  }
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) {
    return "[MaxDepth]";
  }
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (typeof File !== "undefined" && value instanceof File) {
    return {
      name: value.name,
      size: value.size,
      type: value.type
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => sanitize(item, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
    if (typeof item !== "function") {
      output[key] = sanitize(item, depth + 1);
    }
  }
  return output;
}

function pickString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string") {
      return record[key] as string;
    }
  }
  return undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function inferDocumentType(documentInfo: unknown): string {
  const record = isRecord(documentInfo) ? documentInfo : undefined;
  const numericType = record
    ? [
      record.documentType,
      record.doctype,
      record.type
    ].find((value) => typeof value === "number")
    : undefined;

  if (numericType === 1) return "schematic";
  if (numericType === 2) return "pcb";

  const raw = JSON.stringify(documentInfo ?? {}).toLowerCase();
  if (raw.includes("pcb")) return "pcb";
  if (raw.includes("sch") || raw.includes("schematic")) return "schematic";
  if (raw.includes("footprint")) return "footprint";
  if (raw.includes("symbol")) return "symbol";
  return "unknown";
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function log(level: "warn" | "error", message: string, details?: unknown): void {
  if (eda.sys_Log?.[level]) {
    eda.sys_Log[level](`[easyeda-mcp] ${message}`, details);
    return;
  }
  console[level](`[easyeda-mcp] ${message}`, details);
}

function showMessage(title: string, message: string): void {
  if (eda.sys_Dialog?.showInformationMessage) {
    eda.sys_Dialog.showInformationMessage(message, title);
    return;
  }
  log("warn", `${title}: ${message}`);
}
