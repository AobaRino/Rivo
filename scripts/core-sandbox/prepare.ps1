param([string]$Output = '.local/core-update-20261026')
$ErrorActionPreference = 'Stop'
$taskOutput = [IO.Path]::GetFullPath((Join-Path (Get-Location) $Output))
New-Item -ItemType Directory -Path (Join-Path $taskOutput 'fixtures') -Force | Out-Null
$taskFixtures = Join-Path $taskOutput 'fixtures'
$taskMap = @{}
$taskReleases = @()
function Save-Response([string]$Url, [string]$File, $Value) {
    $Value | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $taskFixtures $File) -Encoding utf8NoBOM
    $taskMap[$Url] = @{file=$File; status=200}
}
foreach ($taskVersion in @('v1.19.31','v1.19.32','v1.19.33')) {
    $taskUrl = 'https://api.github.com/repos/MetaCubeX/mihomo/releases/tags/' + $taskVersion
    $taskRelease = Invoke-RestMethod -Uri $taskUrl -Headers @{'User-Agent'='Rivo-sandbox'}
    if ($taskRelease.tag_name -ne $taskVersion -or $taskRelease.prerelease -or $taskRelease.draft) { throw 'Unexpected release' }
    $taskReleases += $taskRelease
    Save-Response $taskUrl ($taskVersion + '.json') $taskRelease
    $taskName = 'mihomo-linux-amd64-v1-' + $taskVersion + '.gz'
    $taskAsset = $taskRelease.assets | Where-Object name -eq $taskName
    if ($taskAsset.digest -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Missing trusted digest' }
    $taskAssetFile = Join-Path $taskFixtures $taskName
    if (-not (Test-Path -LiteralPath $taskAssetFile)) { Invoke-WebRequest -Uri $taskAsset.browser_download_url -OutFile $taskAssetFile }
    $taskHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $taskAssetFile).Hash.ToLowerInvariant()
    if ('sha256:' + $taskHash -ne $taskAsset.digest -or (Get-Item -LiteralPath $taskAssetFile).Length -ne $taskAsset.size) { throw 'Release hash/size mismatch' }
    $taskMap[$taskAsset.browser_download_url] = @{file=$taskName;status=200}
    $taskNpmVersion = $taskVersion.TrimStart('v')
    $taskNpmUrl = 'https://registry.npmjs.org/meta-json-schema/' + $taskNpmVersion
    try { $taskNpm = Invoke-RestMethod -Uri $taskNpmUrl }
    catch {
        if ([int]$_.Exception.Response.StatusCode -ne 404) { throw }
        $taskMap[$taskNpmUrl] = @{status=404}
        Write-Output "$taskVersion verified; matching Schema unavailable (404)"
        continue
    }
    Save-Response $taskNpmUrl ('schema-' + $taskNpmVersion + '.json') $taskNpm
    $taskTgz = 'schema-' + $taskNpmVersion + '.tgz'
    $taskTgzPath = Join-Path $taskFixtures $taskTgz
    if (-not (Test-Path -LiteralPath $taskTgzPath)) { Invoke-WebRequest -Uri $taskNpm.dist.tarball -OutFile $taskTgzPath }
    $taskSha = [Security.Cryptography.SHA512]::HashData([IO.File]::ReadAllBytes($taskTgzPath))
    if ('sha512-' + [Convert]::ToBase64String($taskSha) -ne $taskNpm.dist.integrity) { throw 'Schema integrity mismatch' }
    $taskMap[$taskNpm.dist.tarball] = @{file=$taskTgz;status=200}
    Write-Output "$taskVersion and matching Schema verified"
}
Save-Response 'https://api.github.com/repos/MetaCubeX/mihomo/releases?per_page=30' 'releases.json' @($taskReleases | Sort-Object tag_name -Descending)
$taskMap | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $taskFixtures 'index.json') -Encoding utf8NoBOM
$taskKey = [Security.Cryptography.RSA]::Create(2048)
$taskRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Rivo isolated sandbox', $taskKey, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
$taskRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true))
$taskSan = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
@('api.github.com','github.com','registry.npmjs.org') | ForEach-Object { $taskSan.AddDnsName($_) }
$taskRequest.CertificateExtensions.Add($taskSan.Build())
$taskCert = $taskRequest.CreateSelfSigned([DateTimeOffset]::Now.AddHours(-1), [DateTimeOffset]::Now.AddDays(7))
$taskCert.ExportCertificatePem() | Set-Content -LiteralPath (Join-Path $taskFixtures 'ca.crt') -Encoding ascii
$taskCert.ExportCertificatePem() | Set-Content -LiteralPath (Join-Path $taskFixtures 'server.crt') -Encoding ascii
$taskKey.ExportRSAPrivateKeyPem() | Set-Content -LiteralPath (Join-Path $taskFixtures 'server.key') -Encoding ascii
$taskCert.Dispose()
$taskKey.Dispose()
