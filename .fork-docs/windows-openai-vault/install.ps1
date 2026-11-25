param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('\A[a-p]{32}\z')]
    [string]$ExtensionId
)

$ErrorActionPreference = 'Stop'
$framework = Join-Path ([Environment]::GetFolderPath('Windows')) 'Microsoft.NET\Framework64\v4.0.30319'
if (-not (Test-Path -LiteralPath (Join-Path $framework 'csc.exe'))) {
    $framework = Join-Path ([Environment]::GetFolderPath('Windows')) 'Microsoft.NET\Framework\v4.0.30319'
}
$compiler = Join-Path $framework 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
    throw '.NET Framework 4.x C# compiler not found.'
}

$name = 'com.sakutto.openai_vault'
$path = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Sakutto\NativeHost'
New-Item -ItemType Directory -Path $path -Force | Out-Null
# Compile in a uniquely named file, so a failed build cannot replace a working host.
$build = Join-Path $path ('Vault-' + [Guid]::NewGuid().ToString('N') + '.exe')
$exe = Join-Path $path 'SakuttoOpenAIVault.exe'
$manifest = Join-Path $path ($name + '.json')
try {
    & $compiler /nologo /target:exe /optimize+ "/out:$build" /reference:System.Security.dll /reference:System.Web.Extensions.dll (Join-Path $PSScriptRoot 'Vault.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Failed to compile the Windows key vault.' }
    if ([IO.File]::Exists($exe)) { [IO.File]::Replace($build, $exe, [NullString]::Value) }
    else { [IO.File]::Move($build, $exe) }
} finally {
    if (Test-Path -LiteralPath $build) { Remove-Item -LiteralPath $build -Force }
}

$registration = @{
    name = $name
    description = 'Sakutto OpenAI key vault (Windows user DPAPI)'
    path = $exe
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json
[IO.File]::WriteAllText($manifest, $registration, [Text.UTF8Encoding]::new($false))

# Set the per-user registration, with no admin privileges and no secret in the registry.
$registry = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Software\Google\Chrome\NativeMessagingHosts\$name")
try {
    $registry.SetValue('', $manifest, [Microsoft.Win32.RegistryValueKind]::String)
} finally {
    $registry.Dispose()
}
Write-Host 'Sakutto OpenAI key vault registered for this Chrome extension ID.'
