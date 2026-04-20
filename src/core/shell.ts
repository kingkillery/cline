export function resolveInteractiveShellCommand(): { binary: string; args: string[] } {
	if (process.platform === "win32") {
		const command = process.env.COMSPEC?.trim();
		if (command) {
			return {
				binary: command,
				args: [],
			};
		}
		return {
			binary: "powershell.exe",
			args: ["-NoLogo"],
		};
	}

	const command = process.env.SHELL?.trim();
	if (command) {
		return {
			binary: command,
			args: ["-i"],
		};
	}
	return {
		binary: "bash",
		args: ["-i"],
	};
}

export type ShellQuoteStyle = "posix" | "windows";

function normalizeShellQuoteStyle(style?: ShellQuoteStyle): ShellQuoteStyle {
	if (style) {
		return style;
	}
	return process.platform === "win32" ? "windows" : "posix";
}

export function quoteShellArg(value: string, style?: ShellQuoteStyle): string {
	if (normalizeShellQuoteStyle(style) === "windows") {
		return `"${value.replaceAll('"', '""')}"`;
	}
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildShellCommandLine(binary: string, args: string[], style?: ShellQuoteStyle): string {
	return [binary, ...args].map((part) => quoteShellArg(part, style)).join(" ");
}
