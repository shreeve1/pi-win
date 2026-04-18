/**
 * PowerShell Bash Override
 *
 * Replaces the built-in bash tool with a PowerShell 5.1-compatible implementation
 * for Windows workstations. Spawns powershell.exe instead of /bin/sh.
 *
 * Place in: .pi/extensions/powershell-bash/index.ts  (project-local)
 *       or: ~/.pi/agent/extensions/powershell-bash/index.ts  (global)
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	createBashTool,
	type BashOperations,
} from "@mariozechner/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";

function createPowerShellBashOps(cwd: string): BashOperations {
	return {
		exec: (command, execCwd, { onData, signal, timeout }) =>
			new Promise((resolve, reject) => {
				// Write command to a temp .ps1 file to avoid quoting issues
				const tmpFile = join(tmpdir(), `pi-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
				// Prepend Set-Location so the command runs in the correct directory
				const script = `Set-Location -LiteralPath '${execCwd.replace(/'/g, "''")}'\n${command}`;
				writeFileSync(tmpFile, script, "utf8");

				const args = [
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy", "Bypass",
					"-File", tmpFile,
				];

				const child = spawn("powershell.exe", args, {
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env },
					windowsHide: true,
				});

				let timedOut = false;
				const timer = timeout
					? setTimeout(() => {
							timedOut = true;
							child.kill();
						}, timeout * 1000)
					: undefined;

				child.stdout.on("data", onData);
				child.stderr.on("data", onData);

				child.on("error", (e) => {
					if (timer) clearTimeout(timer);
					try { unlinkSync(tmpFile); } catch {}
					reject(e);
				});

				const onAbort = () => child.kill();
				signal?.addEventListener("abort", onAbort, { once: true });

				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					try { unlinkSync(tmpFile); } catch {}
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code ?? 1 });
				});
			}),
	};
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const psOps = createPowerShellBashOps(cwd);
	const psBashTool = createBashTool(cwd, { operations: psOps });

	pi.registerTool({
		...psBashTool,
		description:
			"Execute a PowerShell command on this Windows workstation. " +
			"Commands run via powershell.exe (PS 5.1). " +
			"Output is truncated to 2000 lines or 50KB. " +
			"Optionally provide a timeout in seconds.",
		promptGuidelines: [
			"Use backslashes in paths: C:\\Windows not C:/Windows.",
			"Quote paths with spaces: \"C:\\Program Files\\...\".",
			"Use -Encoding UTF8 with Out-File and Set-Content for plain text.",
			"Add -UseBasicParsing with Invoke-WebRequest.",
			"Add -ErrorAction SilentlyContinue on commands that may fail.",
		],
	});
}
