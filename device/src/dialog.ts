import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { dcHome } from "./home.js";
import type { ApprovalRequest } from "./approval.js";

// Tool name and summary reach the script only through environment variables,
// never through string interpolation, so tool arguments cannot inject script code.
const WINDOWS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$f = New-Object System.Windows.Forms.Form
$f.Text = 'dc-custom'
$f.TopMost = $true
$f.StartPosition = 'CenterScreen'
$f.FormBorderStyle = 'FixedDialog'
$f.MaximizeBox = $false
$f.MinimizeBox = $false
$f.ClientSize = New-Object System.Drawing.Size(460,190)
if ($env:DC_APPROVE_ICON -and (Test-Path -LiteralPath $env:DC_APPROVE_ICON)) { $f.Icon = New-Object System.Drawing.Icon($env:DC_APPROVE_ICON) }
$t = New-Object System.Windows.Forms.Label
$t.Text = 'Allow this action on this computer?'
$t.Font = New-Object System.Drawing.Font('Segoe UI',11,[System.Drawing.FontStyle]::Bold)
$t.SetBounds(16,14,428,26)
$s = New-Object System.Windows.Forms.TextBox
$s.Multiline = $true
$s.ReadOnly = $true
$s.ScrollBars = 'Vertical'
$s.Text = $env:DC_APPROVE_TOOL + ': ' + $env:DC_APPROVE_SUMMARY
$s.SetBounds(16,48,428,84)
$ok = New-Object System.Windows.Forms.Button
$ok.Text = 'Allow'
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$ok.SetBounds(268,146,84,30)
$no = New-Object System.Windows.Forms.Button
$no.Text = 'Deny'
$no.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$no.SetBounds(360,146,84,30)
$f.Controls.AddRange(@($t,$s,$ok,$no))
$f.CancelButton = $no
$f.Add_Shown({ $f.Activate() })
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [int]$env:DC_APPROVE_TIMEOUT * 1000
$timer.Add_Tick({ $f.DialogResult = [System.Windows.Forms.DialogResult]::Cancel; $f.Close() })
$timer.Start()
$r = $f.ShowDialog()
if ($r -eq [System.Windows.Forms.DialogResult]::OK) { exit 0 } else { exit 1 }
`;

const MAC_SCRIPT = `
set toolText to (system attribute "DC_APPROVE_TOOL")
set summaryText to (system attribute "DC_APPROVE_SUMMARY")
set secs to (system attribute "DC_APPROVE_TIMEOUT") as integer
set iconPath to (system attribute "DC_APPROVE_ICON")
if iconPath is not "" then
  display dialog "Allow this action on this computer?" & return & return & toolText & ": " & summaryText with title "dc-custom" buttons {"Deny", "Allow"} default button "Deny" cancel button "Deny" with icon (POSIX file iconPath) giving up after secs
else
  display dialog "Allow this action on this computer?" & return & return & toolText & ": " & summaryText with title "dc-custom" buttons {"Deny", "Allow"} default button "Deny" cancel button "Deny" giving up after secs
end if
`;

/** Icon file installed next to the config (`icon.ico` on Windows, `icon.icns` on macOS), or "" if absent. */
function iconFile(): string {
  const file = path.join(dcHome(), process.platform === "win32" ? "icon.ico" : "icon.icns");
  return existsSync(file) ? file : "";
}

export function showApprovalDialog(req: ApprovalRequest, timeoutSec: number, signal?: AbortSignal): Promise<boolean> {
  const env = {
    ...process.env,
    DC_APPROVE_TOOL: req.tool.slice(0, 100),
    DC_APPROVE_SUMMARY: req.summary.slice(0, 1000),
    DC_APPROVE_TIMEOUT: String(timeoutSec),
    DC_APPROVE_ICON: iconFile(),
  };

  let file: string;
  let args: string[];
  if (process.platform === "win32") {
    file = "powershell.exe";
    const encoded = Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64");
    args = ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded];
  } else if (process.platform === "darwin") {
    file = "osascript";
    args = ["-e", MAC_SCRIPT];
  } else {
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    let out = "";
    const child = spawn(file, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], signal });
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.on("error", () => resolve(false)); // spawn failure or abort
    child.on("close", (code) => {
      if (process.platform === "win32") resolve(code === 0);
      else resolve(code === 0 && /button returned:Allow/.test(out) && !/gave up:true/.test(out));
    });
  });
}

const NOTICE_WINDOWS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$f = New-Object System.Windows.Forms.Form
$f.Text = $env:DC_NOTICE_TITLE
$f.TopMost = $true
$f.StartPosition = 'CenterScreen'
$f.FormBorderStyle = 'FixedDialog'
$f.MaximizeBox = $false
$f.MinimizeBox = $false
$f.ClientSize = New-Object System.Drawing.Size(440,150)
if ($env:DC_APPROVE_ICON -and (Test-Path -LiteralPath $env:DC_APPROVE_ICON)) { $f.Icon = New-Object System.Drawing.Icon($env:DC_APPROVE_ICON) }
$t = New-Object System.Windows.Forms.Label
$t.Text = $env:DC_NOTICE_TEXT
$t.Font = New-Object System.Drawing.Font('Segoe UI',10)
if ($env:DC_NOTICE_KIND -eq 'error') { $t.ForeColor = [System.Drawing.Color]::FromArgb(178,34,34) }
$t.SetBounds(20,20,400,80)
$ok = New-Object System.Windows.Forms.Button
$ok.Text = 'OK'
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$ok.SetBounds(336,102,84,30)
$f.Controls.AddRange(@($t,$ok))
$f.AcceptButton = $ok
$f.Add_Shown({ $f.Activate() })
[void]$f.ShowDialog()
`;

const NOTICE_MAC_SCRIPT = `
set titleText to (system attribute "DC_NOTICE_TITLE")
set bodyText to (system attribute "DC_NOTICE_TEXT")
set iconPath to (system attribute "DC_APPROVE_ICON")
if iconPath is not "" then
  display dialog bodyText with title titleText buttons {"OK"} default button "OK" with icon (POSIX file iconPath)
else
  display dialog bodyText with title titleText buttons {"OK"} default button "OK"
end if
`;

/** One-button message box with the app icon, shown by the hidden installer. Never throws. */
export function showNotice(title: string, text: string, kind: "info" | "error"): Promise<void> {
  const env = {
    ...process.env,
    DC_NOTICE_TITLE: title,
    DC_NOTICE_TEXT: text.slice(0, 600),
    DC_NOTICE_KIND: kind,
    DC_APPROVE_ICON: iconFile(),
  };
  let file: string;
  let args: string[];
  if (process.platform === "win32") {
    file = "powershell.exe";
    const encoded = Buffer.from(NOTICE_WINDOWS_SCRIPT, "utf16le").toString("base64");
    args = ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded];
  } else if (process.platform === "darwin") {
    file = "osascript";
    args = ["-e", NOTICE_MAC_SCRIPT];
  } else {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const child = spawn(file, args, { env, windowsHide: true, stdio: "ignore" });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
}

const TOKEN_WINDOWS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$f = New-Object System.Windows.Forms.Form
$f.Text = 'dc-custom'
$f.TopMost = $true
$f.StartPosition = 'CenterScreen'
$f.FormBorderStyle = 'FixedDialog'
$f.MaximizeBox = $false
$f.MinimizeBox = $false
$f.ClientSize = New-Object System.Drawing.Size(460,170)
if ($env:DC_APPROVE_ICON -and (Test-Path -LiteralPath $env:DC_APPROVE_ICON)) { $f.Icon = New-Object System.Drawing.Icon($env:DC_APPROVE_ICON) }
$t = New-Object System.Windows.Forms.Label
$t.Text = 'Paste the device token for this computer (from your relay setup):'
$t.Font = New-Object System.Drawing.Font('Segoe UI',10)
$t.SetBounds(16,16,428,40)
$box = New-Object System.Windows.Forms.TextBox
$box.UseSystemPasswordChar = $true
$box.SetBounds(16,62,428,26)
$ok = New-Object System.Windows.Forms.Button
$ok.Text = 'Install'
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$ok.SetBounds(268,120,84,30)
$no = New-Object System.Windows.Forms.Button
$no.Text = 'Cancel'
$no.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$no.SetBounds(360,120,84,30)
$f.Controls.AddRange(@($t,$box,$ok,$no))
$f.AcceptButton = $ok
$f.CancelButton = $no
$f.Add_Shown({ $f.Activate(); $box.Focus() })
if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($box.Text); exit 0 } else { exit 1 }
`;

const TOKEN_MAC_SCRIPT = `
set iconPath to (system attribute "DC_APPROVE_ICON")
if iconPath is not "" then
  set r to display dialog "Paste the device token for this computer (from your relay setup):" default answer "" with hidden answer with title "dc-custom" buttons {"Cancel", "Install"} default button "Install" cancel button "Cancel" with icon (POSIX file iconPath)
else
  set r to display dialog "Paste the device token for this computer (from your relay setup):" default answer "" with hidden answer with title "dc-custom" buttons {"Cancel", "Install"} default button "Install" cancel button "Cancel"
end if
return text returned of r
`;

/** Masked input box for the device token. Resolves the typed text, or null if cancelled or unavailable. */
export function showTokenPrompt(): Promise<string | null> {
  const env = { ...process.env, DC_APPROVE_ICON: iconFile() };
  let file: string;
  let args: string[];
  if (process.platform === "win32") {
    file = "powershell.exe";
    const encoded = Buffer.from(TOKEN_WINDOWS_SCRIPT, "utf16le").toString("base64");
    args = ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded];
  } else if (process.platform === "darwin") {
    file = "osascript";
    args = ["-e", TOKEN_MAC_SCRIPT];
  } else {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(file, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 && out.trim() ? out.trim() : null));
  });
}
