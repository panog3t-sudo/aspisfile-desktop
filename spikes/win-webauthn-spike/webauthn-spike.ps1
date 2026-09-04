# AspisFile — Windows WebAuthn de-risking spike (zero-install PowerShell/C# version)
#
# Proves, against the REAL server:
#   CLAIM 1 — a non-browser process can emit origin "https://aspisfile.com" in
#             its own clientDataJSON and have register-verify/authenticate-verify
#             accept it unchanged.
#   CLAIM 2 — with dwAuthenticatorAttachment=ANY the NATIVE Windows dialog offers
#             Windows Hello + "use a phone or tablet" (QR) + security key, in-app,
#             with NO Edge and NO Microsoft Password Manager. WATCH + SCREENSHOT it.
#
# Uses only built-in Windows PowerShell (Add-Type compiles the C# P/Invoke).
# Throwaway: allocations are intentionally leaked (the process exits).
#
# Run:  see README.md ("Zero-install" section).

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# ---- config (env) --------------------------------------------------------
$Base  = if ($env:ASPIS_BASE)  { $env:ASPIS_BASE }  else { 'https://aspisfile.com' }
$Email = $env:ASPIS_EMAIL
$Rt    = $env:ASPIS_RT
$Mode  = if ($env:ASPIS_MODE)  { $env:ASPIS_MODE }  else { 'both' }
if (-not $Email) { throw 'Set $env:ASPIS_EMAIL = <recipient email>' }

Write-Host "AspisFile Windows WebAuthn spike"
Write-Host "  base  = $Base"
Write-Host "  email = $Email"
Write-Host "  mode  = $Mode`n"

# ---- C# interop: the Win32 WebAuthn ceremonies ---------------------------
$cs = @'
using System;
using System.Runtime.InteropServices;

public static class Spike
{
    const uint ATTACHMENT_ANY   = 0;
    const uint UV_REQUIRED      = 1;
    const uint ATTESTATION_NONE = 1;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct RpInfo {
        public uint dwVersion;
        [MarshalAs(UnmanagedType.LPWStr)] public string pwszId;
        [MarshalAs(UnmanagedType.LPWStr)] public string pwszName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pwszIcon;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct UserInfo {
        public uint dwVersion;
        public uint cbId;
        public IntPtr pbId;
        [MarshalAs(UnmanagedType.LPWStr)] public string pwszName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pwszIcon;
        [MarshalAs(UnmanagedType.LPWStr)] public string pwszDisplayName;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct CoseParam {
        public uint dwVersion;
        [MarshalAs(UnmanagedType.LPWStr)] public string pwszCredentialType;
        public int lAlg;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct CoseParams { public uint cCredentialParameters; public IntPtr pCredentialParameters; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ClientData {
        public uint dwVersion;
        public uint cbClientDataJSON;
        public IntPtr pbClientDataJSON;
        [MarshalAs(UnmanagedType.LPWStr)] public string pwszHashAlgId;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Creds { public uint cCredentials; public IntPtr pCredentials; }
    [StructLayout(LayoutKind.Sequential)]
    struct Exts  { public uint cExtensions;  public IntPtr pExtensions;  }
    [StructLayout(LayoutKind.Sequential)]
    struct MakeOpts {
        public uint dwVersion;
        public uint dwTimeoutMilliseconds;
        public Creds CredentialList;
        public Exts  Extensions;
        public uint dwAuthenticatorAttachment;
        public int  bRequireResidentKey;
        public uint dwUserVerificationRequirement;
        public uint dwAttestationConveyancePreference;
        public uint dwFlags;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct GetOpts {
        public uint dwVersion;
        public uint dwTimeoutMilliseconds;
        public Creds CredentialList;
        public Exts  Extensions;
        public uint dwAuthenticatorAttachment;
        public uint dwUserVerificationRequirement;
        public uint dwFlags;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Attestation {
        public uint dwVersion;
        public IntPtr pwszFormatType;
        public uint cbAuthenticatorData;   public IntPtr pbAuthenticatorData;
        public uint cbAttestation;         public IntPtr pbAttestation;
        public uint dwAttestationDecodeType; public IntPtr pvAttestationDecode;
        public uint cbAttestationObject;   public IntPtr pbAttestationObject;
        public uint cbCredentialId;        public IntPtr pbCredentialId;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Credential {
        public uint dwVersion; public uint cbId; public IntPtr pbId; public IntPtr pwszCredentialType;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Assertion {
        public uint dwVersion;
        public uint cbAuthenticatorData; public IntPtr pbAuthenticatorData;
        public uint cbSignature;         public IntPtr pbSignature;
        public Credential Cred;
        public uint cbUserId;            public IntPtr pbUserId;
    }

    [DllImport("webauthn.dll")] static extern int WebAuthNGetApiVersionNumber();
    [DllImport("webauthn.dll")] static extern int WebAuthNIsUserVerifyingPlatformAuthenticatorAvailable(out int available);
    [DllImport("webauthn.dll", CharSet = CharSet.Unicode)] static extern IntPtr WebAuthNGetErrorName(int hr);
    [DllImport("webauthn.dll", CharSet = CharSet.Unicode)]
    static extern int WebAuthNAuthenticatorMakeCredential(
        IntPtr hWnd, ref RpInfo rp, ref UserInfo user, ref CoseParams cose,
        ref ClientData cd, ref MakeOpts opts, out IntPtr pAttestation);
    [DllImport("webauthn.dll", CharSet = CharSet.Unicode)]
    static extern int WebAuthNAuthenticatorGetAssertion(
        IntPtr hWnd, [MarshalAs(UnmanagedType.LPWStr)] string rpId,
        ref ClientData cd, ref GetOpts opts, out IntPtr pAssertion);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();

    static string B64Url(byte[] b) {
        return Convert.ToBase64String(b).TrimEnd('=').Replace('+','-').Replace('/','_');
    }
    static IntPtr Buf(byte[] b) {
        IntPtr p = Marshal.AllocHGlobal(b.Length);
        Marshal.Copy(b, 0, p, b.Length);
        return p;
    }
    static string ErrName(int hr) {
        IntPtr p = WebAuthNGetErrorName(hr);
        return p == IntPtr.Zero ? "" : Marshal.PtrToStringUni(p);
    }

    public static int  ApiVersion()     { return WebAuthNGetApiVersionNumber(); }
    public static bool HelloAvailable() { int a = 0; WebAuthNIsUserVerifyingPlatformAuthenticatorAvailable(out a); return a != 0; }

    public class RegResult  { public string CredentialId; public string AttestationObject; public string Format; }
    public class AuthResult { public string CredentialId; public string AuthenticatorData; public string Signature; public string UserHandle; }

    public static RegResult Register(string rpId, string rpName, byte[] userId, string userName, byte[] clientDataJson) {
        var rp   = new RpInfo   { dwVersion = 1, pwszId = rpId, pwszName = rpName };
        var user = new UserInfo { dwVersion = 1, cbId = (uint)userId.Length, pbId = Buf(userId), pwszName = userName, pwszDisplayName = userName };

        int[] algs = new int[] { -7, -257 };
        int sz = Marshal.SizeOf(typeof(CoseParam));
        IntPtr arr = Marshal.AllocHGlobal(sz * algs.Length);
        for (int i = 0; i < algs.Length; i++) {
            var cp = new CoseParam { dwVersion = 1, pwszCredentialType = "public-key", lAlg = algs[i] };
            Marshal.StructureToPtr(cp, IntPtr.Add(arr, i * sz), false);
        }
        var cose = new CoseParams { cCredentialParameters = (uint)algs.Length, pCredentialParameters = arr };
        var cd   = new ClientData { dwVersion = 1, cbClientDataJSON = (uint)clientDataJson.Length, pbClientDataJSON = Buf(clientDataJson), pwszHashAlgId = "SHA-256" };
        var opts = new MakeOpts {
            dwVersion = 1, dwTimeoutMilliseconds = 90000,
            dwAuthenticatorAttachment = ATTACHMENT_ANY,
            bRequireResidentKey = 1,
            dwUserVerificationRequirement = UV_REQUIRED,
            dwAttestationConveyancePreference = ATTESTATION_NONE,
        };

        IntPtr outPtr;
        int hr = WebAuthNAuthenticatorMakeCredential(GetForegroundWindow(), ref rp, ref user, ref cose, ref cd, ref opts, out outPtr);
        if (hr != 0)            throw new Exception("MakeCredential HRESULT 0x" + hr.ToString("X8") + " (" + ErrName(hr) + ")");
        if (outPtr == IntPtr.Zero) throw new Exception("null attestation");

        var att = (Attestation)Marshal.PtrToStructure(outPtr, typeof(Attestation));
        byte[] attObj = new byte[att.cbAttestationObject]; Marshal.Copy(att.pbAttestationObject, attObj, 0, (int)att.cbAttestationObject);
        byte[] credId = new byte[att.cbCredentialId];      Marshal.Copy(att.pbCredentialId,      credId, 0, (int)att.cbCredentialId);
        string fmt = att.pwszFormatType == IntPtr.Zero ? "" : Marshal.PtrToStringUni(att.pwszFormatType);
        return new RegResult { CredentialId = B64Url(credId), AttestationObject = B64Url(attObj), Format = fmt };
    }

    public static AuthResult Authenticate(string rpId, byte[] clientDataJson) {
        var cd   = new ClientData { dwVersion = 1, cbClientDataJSON = (uint)clientDataJson.Length, pbClientDataJSON = Buf(clientDataJson), pwszHashAlgId = "SHA-256" };
        var opts = new GetOpts {
            dwVersion = 1, dwTimeoutMilliseconds = 90000,
            dwAuthenticatorAttachment = ATTACHMENT_ANY,
            dwUserVerificationRequirement = UV_REQUIRED,
        };
        IntPtr outPtr;
        int hr = WebAuthNAuthenticatorGetAssertion(GetForegroundWindow(), rpId, ref cd, ref opts, out outPtr);
        if (hr != 0)            throw new Exception("GetAssertion HRESULT 0x" + hr.ToString("X8") + " (" + ErrName(hr) + ")");
        if (outPtr == IntPtr.Zero) throw new Exception("null assertion");

        var a = (Assertion)Marshal.PtrToStructure(outPtr, typeof(Assertion));
        byte[] authData = new byte[a.cbAuthenticatorData]; Marshal.Copy(a.pbAuthenticatorData, authData, 0, (int)a.cbAuthenticatorData);
        byte[] sig      = new byte[a.cbSignature];         Marshal.Copy(a.pbSignature,         sig,      0, (int)a.cbSignature);
        byte[] credId   = new byte[a.Cred.cbId];           Marshal.Copy(a.Cred.pbId,           credId,   0, (int)a.Cred.cbId);
        string userHandle = null;
        if (a.cbUserId > 0 && a.pbUserId != IntPtr.Zero) {
            byte[] uid = new byte[a.cbUserId]; Marshal.Copy(a.pbUserId, uid, 0, (int)a.cbUserId);
            userHandle = B64Url(uid);
        }
        return new AuthResult { CredentialId = B64Url(credId), AuthenticatorData = B64Url(authData), Signature = B64Url(sig), UserHandle = userHandle };
    }
}
'@
Add-Type -TypeDefinition $cs -Language CSharp | Out-Null

# ---- helpers -------------------------------------------------------------
function ConvertTo-B64Url([byte[]]$b) {
    [Convert]::ToBase64String($b).TrimEnd('=').Replace('+','-').Replace('/','_')
}
function ConvertFrom-B64Url([string]$s) {
    $t = $s.Replace('-','+').Replace('_','/')
    switch ($t.Length % 4) { 2 { $t += '==' } 3 { $t += '=' } }
    [Convert]::FromBase64String($t)
}
# POST JSON without throwing on 4xx/5xx, so we can print verify error bodies.
function Invoke-Json($url, $headers, $body) {
    try {
        $r = Invoke-WebRequest -Method Post -Uri $url -Headers $headers -ContentType 'application/json' -Body $body -UseBasicParsing
        return @{ status = [int]$r.StatusCode; body = [string]$r.Content }
    } catch {
        $resp = $_.Exception.Response
        $status = if ($resp) { [int]$resp.StatusCode } else { 0 }
        $b = ''
        if ($resp) { $sr = New-Object IO.StreamReader($resp.GetResponseStream()); $b = $sr.ReadToEnd() }
        return @{ status = $status; body = $b }
    }
}

Write-Host ("WebAuthN API version = {0}; platform authenticator (Hello) available = {1}`n" -f ([Spike]::ApiVersion()), ([Spike]::HelloAvailable()))
if ([Spike]::ApiVersion() -eq 0) { throw 'webauthn.dll unavailable / too old (need Win10 1903+).' }

# ---- REGISTER ------------------------------------------------------------
if ($Mode -eq 'register' -or $Mode -eq 'both') {
    if (-not $Rt) { throw 'register mode needs $env:ASPIS_RT (rt from the enrollment deep-link).' }

    $r = Invoke-Json "$Base/api/v1/recipient-passkeys/register-options" @{ Authorization = "Bearer $Rt" } '{}'
    if ($r.status -ne 200) { throw "register-options $($r.status): $($r.body)" }
    $opts = $r.body | ConvertFrom-Json
    $rpId     = if ($opts.rp.id) { $opts.rp.id } else { 'aspisfile.com' }
    $userName = if ($opts.user.name) { $opts.user.name } else { $Email }
    $userId   = ConvertFrom-B64Url $opts.user.id
    Write-Host "register-options ok: rp.id=$rpId, challenge len=$($opts.challenge.Length)"

    $cdJson  = '{"type":"webauthn.create","challenge":"' + $opts.challenge + '","origin":"https://aspisfile.com","crossOrigin":false}'
    $cdBytes = [Text.Encoding]::UTF8.GetBytes($cdJson)

    Write-Host "`n-> MakeCredential: WATCH the native dialog (Hello / phone-QR / security key)...`n"
    $reg = [Spike]::Register($rpId, 'AspisFile', $userId, $userName, $cdBytes)
    Write-Host "attestation format = $($reg.Format); credId + attObj captured."

    $response = [ordered]@{
        id = $reg.CredentialId; rawId = $reg.CredentialId; type = 'public-key'
        response = [ordered]@{
            clientDataJSON    = (ConvertTo-B64Url $cdBytes)
            attestationObject = $reg.AttestationObject
            transports        = @('internal')
        }
        clientExtensionResults = @{}
    }
    $body = [ordered]@{
        response = $response
        device_label = 'Win spike'
        device_fingerprint = "Windows|$Email|Win spike"
        sync_status = 'single_device'
        transports = @('internal')
    } | ConvertTo-Json -Depth 12

    $rv = Invoke-Json "$Base/api/v1/recipient-passkeys/register-verify" @{ Authorization = "Bearer $Rt" } $body
    Write-Host "`n=== register-verify -> $($rv.status) ===`n$($rv.body)`n"
    if ($rv.status -ge 200 -and $rv.status -lt 300 -and $rv.body -match '"success"\s*:\s*true') {
        Write-Host ">>> CLAIM 1 (register) PROVEN: native origin accepted by the real server. <<<" -ForegroundColor Green
    } else {
        Write-Host ">>> CLAIM 1 (register) FAILED - read the error above (origin? UV? attestation?). <<<" -ForegroundColor Yellow
    }
}

# ---- AUTHENTICATE --------------------------------------------------------
if ($Mode -eq 'authenticate' -or $Mode -eq 'both') {
    $r = Invoke-Json "$Base/api/v1/recipient-passkeys/authenticate-options" @{} (@{ email = $Email } | ConvertTo-Json)
    if ($r.status -ne 200) { throw "authenticate-options $($r.status): $($r.body)" }
    $opts = $r.body | ConvertFrom-Json
    $rpId = if ($opts.rpId) { $opts.rpId } else { 'aspisfile.com' }
    Write-Host "authenticate-options ok: rpId=$rpId, challenge len=$($opts.challenge.Length)"

    $cdJson  = '{"type":"webauthn.get","challenge":"' + $opts.challenge + '","origin":"https://aspisfile.com","crossOrigin":false}'
    $cdBytes = [Text.Encoding]::UTF8.GetBytes($cdJson)

    Write-Host "`n-> GetAssertion: native dialog again...`n"
    $auth = [Spike]::Authenticate($rpId, $cdBytes)

    $response = [ordered]@{
        id = $auth.CredentialId; rawId = $auth.CredentialId; type = 'public-key'
        response = [ordered]@{
            clientDataJSON    = (ConvertTo-B64Url $cdBytes)
            authenticatorData = $auth.AuthenticatorData
            signature         = $auth.Signature
            userHandle        = $auth.UserHandle
        }
        clientExtensionResults = @{}
    }
    $body = [ordered]@{ email = $Email; response = $response } | ConvertTo-Json -Depth 12

    $rv = Invoke-Json "$Base/api/v1/recipient-passkeys/authenticate-verify" @{} $body
    Write-Host "`n=== authenticate-verify -> $($rv.status) ===`n$($rv.body)`n"
    if ($rv.status -ge 200 -and $rv.status -lt 300 -and $rv.body -match '"success"\s*:\s*true') {
        Write-Host ">>> CLAIM 1 (authenticate) PROVEN: native assertion accepted by the real server. <<<" -ForegroundColor Green
    } else {
        Write-Host ">>> CLAIM 1 (authenticate) FAILED - read the error above. <<<" -ForegroundColor Yellow
    }
}

Write-Host "`nDone. For CLAIM 2, confirm the dialog you saw was the native Windows one"
Write-Host "(Hello / 'use a phone or tablet' QR / security key) - NOT Edge, NOT Password Manager. Screenshot it."
