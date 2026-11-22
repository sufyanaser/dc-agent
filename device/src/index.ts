import { isSea } from "node:sea";
import { AuditLog } from "./audit.js";
import { Approver } from "./approval.js";
import { approvalModeFor, parseMode } from "./cli.js";
import { BridgeManager } from "./bridges.js";
import { dispatch, dispatchBridge } from "./dispatch.js";
import { VERSION } from "./version.js";
import { loadConfig } from "./config.js";
import { configPath, logPath } from "./home.js";
import { acquireInstance } from "./instance.js";
import { runInstallerMode } from "./installer/main.js";
import { createLogger } from "./log.js";
import { RelayClient } from "./relay-client.js";
import { categoryAllowed, type Category } from "./policy.js";
import { TOOLS } from "./tools.js";


function enabledTools(profile: string): string[] {
  return TOOLS.filter((t) => categoryAllowed(profile as any, t.category as Category)).map((t) => t.name);
}

/** Windowless-safe: everything goes to the log file, nothing to stdout/stderr. */
async function runAgent(): Promise<void> {
  const log = createLogger(logPath());
  // A background process has nobody to read a stack trace: log and keep serving.
  process.on("uncaughtException", (err) => log(`uncaught: ${err.stack ?? err.message}`));
  process.on("unhandledRejection", (err) => log(`unhandled rejection: ${String(err)}`));

  const lock = await acquireInstance();
  if (!lock.ok) {
    log("already running, exiting");
    process.exit(0);
  }

  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    log(`fatal configuration error, agent not started: ${err instanceof Error ? err.message : String(err)}`);
    lock.release();
    // Exit 0 on purpose: a supervisor (launchd) must not restart a config error in a loop.
    process.exit(0);
  }

  const approver = new Approver(approvalModeFor(cfg.policy.approvalMode, isSea()), cfg.policy.approvalTimeoutSec);
  const audit = new AuditLog(cfg.policy.auditLog, cfg.policy.auditContent);
  const tools = enabledTools(cfg.policy.profile);

  log(`dc-custom device ${VERSION} | id=${cfg.deviceId} | profile=${cfg.policy.profile} | tools=${tools.length} | bridges=${Object.keys(cfg.bridges).join(",") || "none"} | audit=${cfg.policy.auditLog}`);

  let client: RelayClient | null = null;
  const bridges = new BridgeManager(cfg.bridges, { log, onChange: () => client?.refreshHello() });

  client = new RelayClient({
    url: cfg.relayUrl,
    token: cfg.deviceToken,
    deviceId: cfg.deviceId,
    version: VERSION,
    profile: cfg.policy.profile,
    tools,
    log,
    bridges: () => bridges.tools(),
    onCall: async (msg) => dispatch({ cfg: cfg.policy, approver, audit }, msg.tool, msg.args),
    onBridgeCall: async (msg) => dispatchBridge({ cfg: cfg.policy, approver, audit, bridges }, msg.bridge, msg.tool, msg.args),
  });
  const relay = client;

  const stop = () => {
    log("stopping");
    bridges.stop();
    relay.stop();
    lock.release();
    setTimeout(() => process.exit(0), 200);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("exit", () => {
    bridges.stop();
    lock.release();
  });
  relay.start();
  bridges.start();
}

function checkConfig(): void {
  const cfg = loadConfig();
  const { deviceToken: _t, ...safe } = cfg;
  process.stdout.write(JSON.stringify({ config: configPath(), ...safe, tools: enabledTools(cfg.policy.profile) }, null, 2) + "\n");
}

function main(): void {
  const mode = parseMode(process.argv.slice(2), isSea());
  if (mode === "check") return checkConfig();
  if (mode === "run") {
    void runAgent();
    return;
  }
  void runInstallerMode(mode, process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      createLogger(logPath())(`installer failed: ${err instanceof Error ? err.stack : String(err)}`);
      process.exit(1);
    },
  );
}

try {
  main();
} catch (err) {
  createLogger(logPath())(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
