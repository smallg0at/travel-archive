import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FirewallAttempt, FirewallStatus } from "@travel-archive/shared";

/**
 * The Windows Firewall half of "let the phone read this".
 *
 * Opening a port is a change to the machine's security, so it is never done
 * silently: the settings page names the rule and the ports, the reader presses
 * a button, and Windows asks for consent through UAC. This module is the part
 * that runs after that consent.
 *
 * **By port, not by program path.** An installed app's executable moves with
 * every version (and a dev checkout has another path again), so a path-scoped
 * rule would be orphaned by an upgrade: still open, aimed at a file that no
 * longer exists. A port-scoped rule survives upgrades, and the price is that
 * it is wider than this one program — anything that later listens on those
 * ports while the rule exists is allowed too. The UI says exactly that rather
 * than hiding the trade-off in a comment here.
 *
 * **The rule name is fixed**, so it can be found and removed by a person who
 * never opens the app: `netsh advfirewall firewall delete rule
 * name="TravelArchive Remote Reader"`.
 */

export const FIREWALL_RULE = "TravelArchive Remote Reader";

/** How long the UAC prompt may sit unanswered before the attempt gives up. */
const ELEVATION_TIMEOUT_MS = 180_000;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(file: string, args: string[], timeout: number): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const failure = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        const code = failure && typeof failure.code === "number" ? failure.code : failure ? 1 : 0;
        resolve({
          code,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          timedOut: Boolean(failure?.killed),
        });
      },
    );
  });
}

/** PowerShell, quietly: no profile (it is where `fnm` lives and is not ours), no banner. */
function powershell(script: string, timeout: number): Promise<Run> {
  return run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    timeout,
  );
}

function portsOf(value: unknown): number[] {
  if (typeof value !== "string" && typeof value !== "number") return [];
  return String(value)
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
}

/**
 * Reads the rule out of Windows, rather than remembering what we did.
 *
 * `Get-NetFirewallRule` answers with objects, so the answer does not depend on
 * the language Windows is installed in; parsing `netsh`'s prose would. A
 * missing NetSecurity module is reported as unreadable with the exception
 * text, not folded into "no rule" — those call for different advice.
 */
export async function firewallStatus(ports: number[]): Promise<FirewallStatus> {
  const base: FirewallStatus = {
    supported: process.platform === "win32",
    readable: false,
    rule: FIREWALL_RULE,
    ports,
    rulePorts: [],
    present: false,
    enabled: null,
    allows: false,
    via: null,
    programRule: null,
    profile: null,
    networkProfile: null,
    networkPrivate: true,
    detail: null,
  };
  if (!base.supported) return { ...base, readable: true };

  // The executable Windows' own first-listen prompt would have asked about.
  // Matching it is the difference between "the phone is blocked" and "Windows
  // already let it through, under a rule this page did not write".
  const exe = process.execPath.replace(/'/g, "''");

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "  if (-not (Get-Command Get-NetFirewallRule -ErrorAction SilentlyContinue)) { throw 'Get-NetFirewallRule is not available on this Windows install.' }",
    // SilentlyContinue matters: with Stop, a *missing* rule throws "No
    // MSFT_NetFirewallRule objects found", which is the ordinary state before
    // the button is pressed, not a reason to call the check unreadable.
    `  $rules = @(Get-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -ErrorAction SilentlyContinue)`,
    "  $out = [ordered]@{ readable = $true; present = $false }",
    // The profile the rule has to apply to is the one Windows has the network
    // on *now*, not the one it had when the rule was written.
    "  $out.network = (@(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { [string]$_.IPv4Connectivity -ne 'Disconnected' } | ForEach-Object { [string]$_.NetworkCategory } | Select-Object -Unique) -join ', ')",
    "  if ($rules.Count -gt 0) {",
    "    $rule = $rules | Sort-Object Enabled -Descending | Select-Object -First 1",
    "    $portFilter = $rule | Get-NetFirewallPortFilter",
    "    $out.present = $true",
    "    $out.enabled = [bool]$rule.Enabled",
    "    $out.profile = [string]$rule.Profile",
    "    $out.action = [string]$rule.Action",
    "    $out.direction = [string]$rule.Direction",
    "    $out.ports = (@($portFilter.LocalPort) -join ',')",
    "  }",
    // Any enabled inbound allow rule pinned to this executable, whichever
    // profile it covers: the caller decides whether it is wide enough.
    `  $exe = '${exe}'`,
    "  $program = $null",
    "  foreach ($filter in @(Get-NetFirewallApplicationFilter -Program $exe -ErrorAction SilentlyContinue)) {",
    "    foreach ($rule in @($filter | Get-NetFirewallRule -ErrorAction SilentlyContinue)) {",
    "      if (-not $rule) { continue }",
    "      if ([string]$rule.Direction -ne 'Inbound' -or [string]$rule.Action -ne 'Allow' -or -not [bool]$rule.Enabled) { continue }",
    "      $portFilter = $rule | Get-NetFirewallPortFilter",
    "      $program = [pscustomobject]@{",
    "        name = [string]$rule.DisplayName",
    "        profile = [string]$rule.Profile",
    "        protocol = [string]$portFilter.Protocol",
    "        ports = (@($portFilter.LocalPort) -join ',')",
    "      }",
    "      break",
    "    }",
    "    if ($program) { break }",
    "  }",
    "  $out.program = $program",
    "  [pscustomobject]$out | ConvertTo-Json -Compress",
    "} catch {",
    "  [pscustomobject]@{ readable = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress",
    "  exit 0",
    "}",
  ].join("\n");

  const res = await powershell(script, 20_000);
  const raw = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join("\n");
  if (res.timedOut) return { ...base, detail: raw || "Get-NetFirewallRule did not answer within 20s." };
  if (res.code !== 0) return { ...base, detail: raw || `PowerShell exited with code ${res.code}.` };

  try {
    const parsed = JSON.parse(res.stdout.trim()) as {
      readable?: boolean;
      present?: boolean;
      enabled?: boolean;
      profile?: string;
      action?: string;
      direction?: string;
      ports?: string;
      network?: string;
      program?: { name?: string; profile?: string; protocol?: string; ports?: string } | null;
      error?: string;
    };
    if (parsed.readable === false) return { ...base, detail: parsed.error ?? raw };

    /** `"Private, Public"` → `["private", "public"]`. */
    const profilesOf = (value: string | null | undefined): string[] =>
      String(value ?? "")
        .toLowerCase()
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);

    // What Windows has the network on right now. A rule restricted to Private
    // does nothing while this says Public — the phone would still be blocked,
    // and the row must not claim otherwise.
    const networkProfile = parsed.network?.trim() || null;
    const activeProfiles = profilesOf(networkProfile);
    const networkPrivate = activeProfiles.length === 0 || activeProfiles.includes("private");
    const appliesNow = (ruleProfile: string | null | undefined): boolean => {
      const parts = profilesOf(ruleProfile);
      if (parts.length === 0 || parts.includes("any")) return true;
      // No connected network to compare against: keep the old assumption
      // rather than inventing a Public one.
      if (activeProfiles.length === 0) return parts.includes("private");
      return parts.some((part) => activeProfiles.includes(part));
    };

    // The port-scoped rule this page adds, when it is there and covers now.
    const foundPorts = portsOf(parsed.ports);
    const covers = ports.every((port) => foundPorts.includes(port));
    // Windows spells the enumeration "Inbound" through Get-NetFirewallRule and
    // "In" through netsh; both mean the same direction and neither is worth a
    // false "not allowed" in the UI.
    const direction = (parsed.direction ?? "").toLowerCase();
    const namedAllows =
      parsed.present === true &&
      parsed.enabled === true &&
      parsed.action?.toLowerCase() === "allow" &&
      (direction === "in" || direction === "inbound") &&
      covers &&
      appliesNow(parsed.profile);

    // A rule Windows' first-listen prompt created for this executable. Usually
    // it carries no port or protocol restriction ("Any"), which covers ours;
    // the check is written out rather than assumed, because a narrower program
    // rule would not. Its profile is checked the same way: a Private-only
    // program rule is no more use on a Public network than our own.
    const program = parsed.program ?? null;
    const programPorts = String(program?.ports ?? "");
    const protocol = (program?.protocol ?? "").toLowerCase();
    const programAllows = Boolean(
      program &&
        (protocol === "tcp" || protocol === "any") &&
        (programPorts.toLowerCase() === "any" ||
          ports.every((port) => portsOf(programPorts).includes(port))) &&
        appliesNow(program.profile),
    );

    return {
      ...base,
      readable: true,
      present: parsed.present === true,
      enabled: parsed.enabled ?? null,
      allows: namedAllows || programAllows,
      via: namedAllows ? "named" : programAllows ? "program" : null,
      programRule: programAllows ? (program?.name ?? null) : null,
      profile: parsed.profile ?? (programAllows ? (program?.profile ?? null) : null),
      networkProfile,
      networkPrivate,
      rulePorts: foundPorts,
      detail: raw || null,
    };
  } catch {
    return { ...base, detail: raw || "The firewall check returned something that is not JSON." };
  }
}

/**
 * Adds (or refreshes) the rule behind one UAC consent.
 *
 * The delete-then-add pair runs **inside the elevated process**, because both
 * halves need elevation and two prompts for one button is a worse experience
 * than two commands in one script. Deleting first is what makes a port change
 * honest: the rule name is fixed, so without the delete an old port would stay
 * open under a name that now claims to cover different ones.
 *
 * The attempt is judged by re-reading the rule afterwards, not by the command's
 * exit code: a success that is not observable is reported as a failure, with
 * the command's own output attached.
 */
export async function allowThroughFirewall(ports: number[]): Promise<FirewallAttempt> {
  if (process.platform !== "win32") {
    return {
      ok: false,
      output: null,
      error: "Windows Firewall only exists on Windows.",
      status: await firewallStatus(ports),
    };
  }
  const wanted = ports.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
  if (wanted.length === 0) {
    return {
      ok: false,
      output: null,
      error: "No listener port to allow.",
      status: await firewallStatus(ports),
    };
  }

  const dir = await mkdtemp(join(tmpdir(), "travel-archive-firewall-"));
  const scriptPath = join(dir, "allow.ps1");
  const resultPath = join(dir, "result.txt");
  const localport = wanted.join(",");
  // The path is ours and has no quotes; doubling single quotes is still the
  // right habit for a string spliced into PowerShell source.
  const quoted = (value: string) => `'${value.replace(/'/g, "''")}'`;

  const script = [
    "$ErrorActionPreference = 'Continue'",
    `$rule = '${FIREWALL_RULE}'`,
    `$result = ${quoted(resultPath)}`,
    "$lines = New-Object System.Collections.Generic.List[string]",
    `$deleted = (& netsh advfirewall firewall delete rule name="$rule" 2>&1 | Out-String).Trim()`,
    '$lines.Add("delete: " + $deleted)',
    `$added = (& netsh advfirewall firewall add rule name="$rule" dir=in action=allow protocol=TCP localport=${localport} profile=private enable=yes 2>&1 | Out-String).Trim()`,
    "$code = $LASTEXITCODE",
    '$lines.Add("add (exit $code): " + $added)',
    "try { Set-Content -LiteralPath $result -Value ($lines -join [Environment]::NewLine) -Encoding UTF8 } catch { }",
    "exit $code",
  ].join("\r\n");

  try {
    await writeFile(scriptPath, script, "utf-8");
  } catch (err) {
    const status = await firewallStatus(ports);
    return { ok: false, output: null, error: `Could not write the elevation script: ${(err as Error).message}`, status };
  }

  const outer = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    `  Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${quoted(scriptPath)})`,
    "} catch {",
    "  [Console]::Error.WriteLine($_.Exception.Message)",
    "  exit 1",
    "}",
  ].join("\n");

  const elevated = await powershell(outer, ELEVATION_TIMEOUT_MS);
  const rawOutput = await readFile(resultPath, "utf-8")
    .then((text) => text.trim())
    .catch(() => null);
  await rm(dir, { recursive: true, force: true }).catch(() => {});

  const status = await firewallStatus(ports);
  const elevationFailed =
    elevated.code !== 0
      ? elevated.timedOut
        ? `Windows did not answer the elevation request within ${Math.round(ELEVATION_TIMEOUT_MS / 1000)}s.`
        : [elevated.stderr.trim(), elevated.stdout.trim()].filter(Boolean).join("\n") ||
          `The elevation request exited with code ${elevated.code}.`
      : null;

  // The observable answer wins: a rule that is there and covers the ports is
  // there even if the elevation wrapper was interrupted after it landed.
  if (status.allows) {
    return { ok: true, output: rawOutput, error: null, status };
  }
  return {
    ok: false,
    output: rawOutput,
    error:
      elevationFailed ??
      (rawOutput
        ? "The command ran, but Windows still does not report the rule."
        : "The elevated command produced no output and no rule was found."),
    status,
  };
}
