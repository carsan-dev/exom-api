# Invoke by path: & .\scripts\provision-selected-synthetic-users.ps1
# Never paste passwords into JavaScript, arguments, environment, or a file.
$ErrorActionPreference = 'Stop'
$client = $null
$superadmin = $null
$bytes = $null
$jsonChars = $null
$builder = [System.Collections.Generic.List[char]]::new()
$process = $null
$exitCode = 1
function Add-Literal([string] $text) {
    foreach ($character in $text.ToCharArray()) { $builder.Add($character) }
}
function Add-SecureJson([System.Security.SecureString] $secure) {
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        $builder.Add([char]34)
        for ($i = 0; $i -lt $secure.Length; $i++) {
            $code = [int][Runtime.InteropServices.Marshal]::ReadInt16($pointer, $i * 2) -band 0xffff
            if ($code -eq 34 -or $code -eq 92) {
                $builder.Add([char]92); $builder.Add([char]$code)
            } elseif ($code -lt 32) {
                Add-Literal ('\u' + $code.ToString('x4'))
            } else { $builder.Add([char]$code) }
        }
        $builder.Add([char]34)
    } finally {
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        $code = 0
    }
}
try {
    $helper = Join-Path $PSScriptRoot 'provision-selected-synthetic-users.cjs'
    $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    if ($node -isnot [string] -or [string]::IsNullOrWhiteSpace($node)) { throw 'NODE_EXECUTABLE_NOT_FOUND' }
    $client = Read-Host 'Password for cliente@exom.dev (Firebase minimum 6)' -AsSecureString
    $superadmin = Read-Host 'Password for superadmin@exom.dev (Firebase minimum 6)' -AsSecureString
    Add-Literal '{"clientPassword":'
    Add-SecureJson $client
    Add-Literal ',"superadminPassword":'
    Add-SecureJson $superadmin
    Add-Literal '}'
    $jsonChars = $builder.ToArray()
    $bytes = [System.Text.UTF8Encoding]::new($false, $true).GetBytes($jsonChars)
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $node
    # Only the quoted helper path is an argument. STDIN carries the UTF-8 JSON.
    $info.Arguments = '"' + $helper + '"'
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.WorkingDirectory = Split-Path $PSScriptRoot -Parent
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $info
    if (-not $process.Start()) { throw 'START_FAILED' }
    try {
        $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
        $process.StandardInput.BaseStream.Flush()
    } finally { $process.StandardInput.Close() }
    $process.WaitForExit()
    $exitCode = $process.ExitCode
} catch {
    # Do not print exception messages or PowerShell ErrorRecord bodies.
    [Console]::Error.WriteLine('PROVISION_WRAPPER_FAILED')
} finally {
    if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    if ($null -ne $jsonChars) { [Array]::Clear($jsonChars, 0, $jsonChars.Length) }
    for ($i = 0; $i -lt $builder.Count; $i++) { $builder[$i] = [char]0 }
    $builder.Clear()
    if ($null -ne $client) { $client.Dispose() }
    if ($null -ne $superadmin) { $superadmin.Dispose() }
    if ($null -ne $process) { $process.Dispose() }
}
exit $exitCode
