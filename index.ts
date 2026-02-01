/**
 * Interactive PTY launcher for Daytona sandboxes.
 * Lists sandboxes, connects via tmux, and forwards stdin/stdout.
 */
import { Daytona } from "@daytonaio/sdk";

const PTY_ID = "daytona-shell-session";
const TMUX_SESSION = "daytona-shell";

type Sandbox = Awaited<ReturnType<Daytona["create"]>>;
type PtyHandle = Awaited<ReturnType<Sandbox["process"]["createPty"]>>;

interface MenuItem {
  type: "create" | "sandbox";
  sandbox?: Sandbox;
  status?: string[];
}

/** Install tmux in the sandbox if not present (apt). */
async function ensureTmux(sandbox: Sandbox) {
  const check = await sandbox.process.executeCommand("command -v tmux");
  if (check.exitCode === 0) return;

  await sandbox.process.executeCommand(
    "sudo rm -f /etc/apt/sources.list.d/yarn.list 2>/dev/null; sudo apt-get update -qq && sudo apt-get install -y -qq tmux",
    undefined,
    undefined,
    120
  );
  const verify = await sandbox.process.executeCommand("command -v tmux");
  if (verify.exitCode !== 0)
    throw new Error(
      "Tmux not found. Install manually in sandbox or use an image with tmux."
    );
}

/** Derive a short label from a command line (e.g. "node server.js" → "server"). */
function friendlyCommand(args: string): string {
  const a = args.trim();
  if (!a || a === "-") return "shell";
  const parts = a.split(/\s+/);
  const base = parts[0]?.split("/").pop() || "";
  if (["bash", "zsh", "sh", "dash", "fish", "-sh"].includes(base)) return "shell";
  if (base === "node" && parts[1]) {
    const script = parts[1].split("/").pop() || parts[1];
    return script.replace(/\.(js|ts|mjs|cjs)$/, "") || base;
  }
  if (base === "python" && parts[1]) {
    const script = parts[1].split("/").pop() || parts[1];
    return script.replace(/\.py$/, "") || base;
  }
  return base;
}

/** Return human-readable status for each tmux pane (e.g. "shell | node"). */
async function getTmuxStatus(sandbox: Sandbox): Promise<string[]> {
  try {
    if (sandbox.state !== "started") return [`[${sandbox.state}]`];
    const hasSession = await sandbox.process.executeCommand(
      `tmux has-session -t ${TMUX_SESSION} 2>/dev/null`
    );
    if (hasSession.exitCode !== 0) return ["[started, no tmux]"];
    const out = await sandbox.process.executeCommand(
      `tmux list-panes -t ${TMUX_SESSION} -F "#{pane_tty}" 2>/dev/null | while read tty; do ps -o args= -t "$tty" 2>/dev/null || true; done`
    );
    const lines = (out.result || "").trim().split("\n").filter(Boolean);
    if (!lines.length) return ["(no panes)"];
    const names = [...new Set(lines.map(friendlyCommand))]
      .filter((n) => !/^\[.*\]$/.test(n))
      .sort((a, b) => (a === "shell" ? 1 : b === "shell" ? -1 : 0));
    return [names.join(" | ")];
  } catch {
    return [`[${sandbox.state ?? "?"}]`];
  }
}

const TMUX_DETACHED = "[detached (from session";

/** PTY data handler: echo to stdout, buffer last 80 chars, call onDetach when tmux "[detached" appears. */
function createOnData(onDetach: () => void, suppressMs: number) {
  let buffer = "";
  let suppress = true;
  setTimeout(() => {
    suppress = false;
  }, suppressMs);
  return (data: Uint8Array) => {
    const text = new TextDecoder().decode(data);
    if (!suppress) {
      for (const char of text) process.stdout.write(char);
    }
    buffer += text;
    if (buffer.length > 80) buffer = buffer.slice(-80);
    if (buffer.includes(TMUX_DETACHED)) onDetach();
  };
}

/** Attach to sandbox PTY, start/attach tmux, wire stdin and resize. Exits on Ctrl+D or tmux detach. */
async function connectToSandbox(sandbox: Sandbox, isNewSandbox: boolean) {
  let ptyHandle: PtyHandle | null = null;

  if (isNewSandbox) {
    await ensureTmux(sandbox);
  }

  let exitResolve: () => void;
  const exitPromise = new Promise<void>((r) => {
    exitResolve = r;
  });

  const doExit = async () => {
    process.stdin.removeAllListeners("data");
    process.stdout.removeAllListeners("resize");
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    await ptyHandle?.disconnect?.();
    exitResolve!();
  };

  const onData = createOnData(doExit, 1500);
  const tmuxCmd = `tmux attach-session -t ${TMUX_SESSION} \\; set -g status off || tmux new-session -s ${TMUX_SESSION} \\; set -g status off`;

  // Prefer reconnecting to existing PTY; fall back to creating a new one.
  try {
    ptyHandle = await sandbox.process.connectPty(PTY_ID, { onData });
    await ptyHandle.waitForConnection();
    showLoadingModal("Starting tmux...");
    await ptyHandle.sendInput(`${tmuxCmd}\n`);
  } catch {
    ptyHandle = await sandbox.process.createPty({
      id: PTY_ID,
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      onData,
    });
    await ptyHandle.waitForConnection();
    showLoadingModal("Starting tmux...");
    await ptyHandle.sendInput(`${tmuxCmd}\n`);
  }

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  process.stdout.on("resize", async () => {
    if (ptyHandle)
      await sandbox.process.resizePtySession(
        PTY_ID,
        process.stdout.columns || 80,
        process.stdout.rows || 24
      );
  });

  process.stdin.on("data", async (key: string) => {
    // Ctrl+D: send tmux prefix+d (detach), then exit.
    if (key === "\u0004") {
      await ptyHandle?.sendInput("\x02d");
      await new Promise((r) => setTimeout(r, 200));
      await doExit();
    } else if (ptyHandle) {
      await ptyHandle.sendInput(key);
    }
  });

  await Promise.race([ptyHandle.wait().then(() => {}), exitPromise]);
}

/** Clear screen and show message centered; hide cursor. */
function showLoadingModal(message: string) {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  process.stdout.write("\x1b[2J\x1b[H");
  const line = `  ${message}`;
  const y = Math.floor(rows / 2);
  const x = Math.max(1, Math.floor((cols - line.length) / 2) + 1);
  process.stdout.write(`\x1b[${y};${x}H${line}`);
  process.stdout.write("\x1b[?25l");
}

/** Draw TUI menu: sandbox list, selected row highlighted, footer with key hints. */
function renderMenu(
  items: MenuItem[],
  selected: number,
  confirmingDelete?: { name: string }
) {
  const cols = process.stdout.columns || 80;
  const width = cols - 2;
  const sep = " " + "─".repeat(width - 2);
  const rev = (s: string) => `\x1b[7m${s.padEnd(width)}\x1b[0m`;
  const trunc = (s: string, max: number) =>
    s.length <= max ? s : s.slice(0, max - 3) + "...";
  const lines: string[] = [" daytona", sep, ""];
  const maxStatusLen = width - 18; // prefix + shortId + "  ·  "
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const prefix = i === selected ? "› " : "  ";
    let row: string;
    if (item.type === "create") {
      row = `${prefix}+ Create new sandbox`;
    } else {
      const shortId = item.sandbox!.id.slice(0, 8);
      const status = trunc((item.status ?? ["..."])[0] ?? "...", maxStatusLen);
      row = `${prefix}${shortId}  ·  ${status}`;
    }
    lines.push(i === selected ? rev(row) : row.padEnd(width));
  }
  lines.push("", sep);
  if (confirmingDelete) {
    lines.push(" ⌫ again to confirm   ↑↓ Esc cancel");
  } else {
    lines.push(" ↑↓ select   ↵ connect   ⌫ delete");
  }
  return lines.join("\n");
}

/** Main TUI: load sandboxes, handle ↑↓/Enter/Backspace/Delete/Esc, connect or create. */
async function runMenu() {
  const daytona = new Daytona();
  let selected = 0;
  let items: MenuItem[] = [];

  const loadItems = async (openedId?: string) => {
    const result = await daytona.list(undefined, 1, 50);
    let sandboxes = result.items.filter((s) => s.state === "started" || s.state === "stopped");
    if (openedId) {
      const idx = sandboxes.findIndex((s) => s.id === openedId);
      if (idx > 0)
        sandboxes = [sandboxes[idx]!, ...sandboxes.slice(0, idx), ...sandboxes.slice(idx + 1)];
    }
    const statuses = await Promise.all(sandboxes.map((s) => getTmuxStatus(s)));
    items = [
      ...sandboxes.map((s, i) => ({
        type: "sandbox" as const,
        sandbox: s,
        status: statuses[i],
      })),
      { type: "create" },
    ];
    selected = Math.min(selected, items.length - 1);
  };

  await loadItems();

  let confirmingDelete: { sandbox: Sandbox; name: string } | null = null;

  const draw = () => {
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(
      renderMenu(items, selected, confirmingDelete ?? undefined)
    );
    process.stdout.write("\x1b[?25l");
  };

  if (!process.stdin.isTTY) {
    console.log("TTY required for menu.");
    return;
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  draw();

  process.stdout.on("resize", draw);

  let escapeBuffer = "";
  let escapeTimeout: ReturnType<typeof setTimeout> | null = null;

  const handleKey = async (key: string) => {
    const doDelete = async (sandbox: Sandbox) => {
      try {
        await sandbox.delete();
        confirmingDelete = null;
        await loadItems();
        selected = Math.min(selected, items.length - 1);
        draw();
      } catch (e) {
        console.error("Delete failed:", e);
        draw();
      }
    };

    if (confirmingDelete) {
      if (key === "\x7f" || key === "\x08") {
        await doDelete(confirmingDelete.sandbox);
        return;
      }
      if (key === "\u0003") {
        confirmingDelete = null;
        draw();
        return;
      }
    }

    if (escapeBuffer || key.startsWith("\x1b")) {
      if (escapeTimeout) {
        clearTimeout(escapeTimeout);
        escapeTimeout = null;
      }
      escapeBuffer += key;
      if (escapeBuffer === "\x1b[A" || escapeBuffer === "\x1bOA") {
        escapeBuffer = "";
        confirmingDelete = null;
        selected = Math.max(0, selected - 1);
        draw();
      } else if (escapeBuffer === "\x1b[B" || escapeBuffer === "\x1bOB") {
        escapeBuffer = "";
        confirmingDelete = null;
        selected = Math.min(items.length - 1, selected + 1);
        draw();
      } else if (escapeBuffer === "\x1b[3~") {
        escapeBuffer = "";
        if (confirmingDelete) {
          await doDelete(confirmingDelete.sandbox);
        } else {
          const item = items[selected];
          if (item.type === "sandbox" && item.sandbox) {
            confirmingDelete = {
              sandbox: item.sandbox,
              name: item.sandbox.name || item.sandbox.id.slice(0, 12),
            };
            draw();
          }
        }
      } else if (escapeBuffer === "\x1b" && confirmingDelete) {
        escapeTimeout = setTimeout(() => {
          if (escapeBuffer === "\x1b") {
            escapeBuffer = "";
            confirmingDelete = null;
            draw();
          }
          escapeTimeout = null;
        }, 80);
      } else if (escapeBuffer.length > 10) {
        escapeBuffer = "";
      }
      return;
    }

    if (key === "\x7f" || key === "\x08") {
      const item = items[selected];
      if (item.type === "sandbox" && item.sandbox) {
        confirmingDelete = {
          sandbox: item.sandbox,
          name: item.sandbox.name || item.sandbox.id.slice(0, 12),
        };
        draw();
      }
      return;
    }

    if (key === "\n" || key === "\r") {
      const item = items[selected];
      process.stdout.write("\x1b[?25h");
      process.stdin.removeAllListeners("data");
      try {
        let openedId: string | undefined;
        if (item.type === "create") {
          showLoadingModal("Creating sandbox...");
          const sandbox = await daytona.create();
          showLoadingModal("Installing tmux...");
          await connectToSandbox(sandbox, true);
          openedId = sandbox.id;
        } else if (item.sandbox) {
          const s = item.sandbox;
          if (s.state !== "started") {
            showLoadingModal("Starting sandbox...");
            await daytona.start(s);
          }
          showLoadingModal("Connecting...");
          await connectToSandbox(s, false);
          openedId = s.id;
        }
        await loadItems(openedId);
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdout.on("resize", draw);
        process.stdin.on("data", handleKey);
        draw();
      } catch (e) {
        console.error(e);
        process.exit(1);
      }
      return;
    }

    if (key === "\u0003") {
      process.stdout.write("\x1b[?25h");
      process.exit(0);
    }
  };

  process.stdin.on("data", handleKey);
}

async function main() {
  try {
    await runMenu();
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main().catch(console.error);
