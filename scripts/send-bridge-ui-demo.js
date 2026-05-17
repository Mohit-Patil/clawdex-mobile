#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const DEFAULT_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "unknown",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
];

function usage() {
  console.log(`Usage:
  npm run bridge:ui:demo
  npm run bridge:ui:demo -- --thread <thread-id>

Options:
  --thread <id>     Send the demo surface to a specific thread.
  --modal           Send as a modal instead of a workflow card.
  --banner          Send as a banner instead of a workflow card.
  --title <text>    Override the surface title.
`);
}

function parseArgs(argv) {
  const options = {
    threadId: "",
    presentation: "workflowCard",
    title: "Goal",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--thread") {
      options.threadId = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--modal") {
      options.presentation = "modal";
      continue;
    }
    if (arg === "--banner") {
      options.presentation = "banner";
      continue;
    }
    if (arg === "--title") {
      options.title = argv[index + 1] || options.title;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${filePath}. Run setup first.`);
  }

  const env = {};
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function buildBridgeBaseUrl(env) {
  if (env.BRIDGE_CONNECT_URL) {
    return env.BRIDGE_CONNECT_URL.replace(/\/+$/, "");
  }

  const host = env.BRIDGE_HOST || "127.0.0.1";
  const port = env.BRIDGE_PORT || "8787";
  return `http://${host}:${port}`;
}

function parseBridgePort(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    return parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  } catch {
    return "";
  }
}

function readLiveBridgeToken(baseUrl) {
  const port = parseBridgePort(baseUrl);
  if (!port) {
    return "";
  }

  let lsofOutput = "";
  try {
    lsofOutput = execFileSync("lsof", [
      "-nP",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }

  const lines = lsofOutput.trim().split(/\r?\n/).slice(1);
  for (const line of lines) {
    const columns = line.trim().split(/\s+/);
    const pid = columns[1];
    if (!pid || !/^\d+$/.test(pid)) {
      continue;
    }

    try {
      const processOutput = execFileSync("ps", ["eww", "-p", pid], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const match = processOutput.match(/\bBRIDGE_AUTH_TOKEN=([^\s]+)/);
      if (match?.[1]) {
        return match[1];
      }
    } catch {
      // Try the next listener.
    }
  }

  return "";
}

class BridgeRpcClient {
  constructor(options) {
    this.url = options.url;
    this.token = options.token;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const WebSocketCtor = resolveWebSocketConstructor();
      const socket = createWebSocket(WebSocketCtor, this.url, this.token);
      this.socket = socket;
      let settled = false;

      socket.onopen = () => {
        settled = true;
        resolve();
      };
      socket.onerror = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error(error?.message || "Failed to connect to bridge websocket"));
      };
      socket.onmessage = (event) => this.handleMessage(event.data);
      socket.onclose = (code) => {
        if (!settled) {
          settled = true;
          reject(new Error(`Bridge websocket closed before connecting (${String(code)})`));
          return;
        }
        for (const { reject: rejectPending } of this.pending.values()) {
          rejectPending(new Error("Bridge websocket closed"));
        }
        this.pending.clear();
      };
    });
  }

  request(method, params) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Bridge websocket is not connected");
    }

    const id = String(this.nextId);
    this.nextId += 1;
    this.socket.send(JSON.stringify({ id, method, params }));

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout for ${method}`));
      }, 15000);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }

    if (!message.id || !this.pending.has(message.id)) {
      return;
    }

    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error.message || "Bridge RPC failed"));
      return;
    }

    pending.resolve(message.result);
  }

  close() {
    this.socket?.close();
  }
}

function resolveWebSocketConstructor() {
  try {
    return require("ws");
  } catch {
    if (typeof WebSocket === "function") {
      return WebSocket;
    }
  }

  throw new Error("No WebSocket client is available for this Node.js runtime.");
}

function createWebSocket(WebSocketCtor, url, token) {
  const isWsPackage =
    typeof WebSocketCtor === "function" && Boolean(WebSocketCtor.Server || WebSocketCtor.WebSocket);
  if (isWsPackage) {
    return new WebSocketCtor(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  }

  const separator = url.includes("?") ? "&" : "?";
  return new WebSocketCtor(`${url}${separator}token=${encodeURIComponent(token)}`);
}

async function resolveLatestThreadId(client) {
  const response = await client.request("thread/list", {
    cursor: null,
    limit: 1,
    sortKey: "updated_at",
    modelProviders: null,
    sourceKinds: DEFAULT_SOURCE_KINDS,
    archived: false,
    cwd: null,
  });

  const threadId = response?.data?.[0]?.id;
  if (typeof threadId !== "string" || !threadId.trim()) {
    throw new Error("No chat found. Create or open a chat in the mobile app first.");
  }

  return threadId;
}

function buildSurface(options, threadId) {
  const now = new Date().toISOString();
  return {
    id: `goal-demo-${Date.now()}`,
    threadId,
    turnId: null,
    kind: "goal",
    presentation: options.presentation,
    tone: "info",
    title: options.title,
    subtitle: "Bridge UI demo",
    bodyMarkdown:
      "This came from the bridge through the generic UI surface contract. Future provider updates can use the same path.",
    blocks: [
      {
        type: "checklist",
        items: [
          { label: "Bridge emitted a generic surface", status: "completed" },
          { label: "Mobile rendered it without provider-specific UI", status: "inProgress" },
          { label: "Future Codex goal mapper can reuse this contract", status: "pending" },
        ],
      },
      {
        type: "keyValue",
        items: [
          { label: "Kind", value: "goal" },
          { label: "Presentation", value: options.presentation },
        ],
      },
      {
        type: "progress",
        label: "Trial progress",
        value: 3,
        max: 10,
        detail: "Sample progress block",
      },
    ],
    actions: [{ id: "dismiss", label: "Dismiss", style: "secondary" }],
    dismissible: true,
    createdAt: now,
    updatedAt: now,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(__dirname, "..");
  const env = readEnvFile(path.join(root, ".env.secure"));
  const token = env.BRIDGE_AUTH_TOKEN || "";
  if (!token) {
    throw new Error("BRIDGE_AUTH_TOKEN is missing in .env.secure.");
  }

  const baseUrl = buildBridgeBaseUrl(env);
  const wsUrl = `${baseUrl.replace(/^http/, "ws")}/rpc`;
  let client = new BridgeRpcClient({ url: wsUrl, token });

  try {
    await client.connect();
  } catch (error) {
    const liveToken = readLiveBridgeToken(baseUrl);
    if (!liveToken || liveToken === token) {
      throw error;
    }

    client.close();
    client = new BridgeRpcClient({ url: wsUrl, token: liveToken });
    await client.connect();
    console.log("Using token from the live bridge process because .env.secure is stale.");
  }

  try {
    const threadId = options.threadId || (await resolveLatestThreadId(client));
    const surface = buildSurface(options, threadId);
    await client.request("bridge/ui/present", surface);
    console.log(`Sent ${options.presentation} demo surface to thread ${threadId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unknown bridge method|method not found|not allowed/i.test(message)) {
      throw new Error(
        `${message}\nThe running bridge does not have bridge/ui support yet. Restart the bridge from this checkout, then run this command again.`
      );
    }
    throw error;
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
