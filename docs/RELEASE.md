# Release Process

Cutting a new release of the AspisFile Desktop Viewer.

## Required GitHub Secrets

Add these in **Settings → Secrets and variables → Actions → New repository secret**
at https://github.com/panog3t-sudo/aspisfile-desktop/settings/secrets/actions.

| Secret | Purpose | Where it comes from |
|---|---|---|
| `APPLE_CERTIFICATE` | Developer ID Application cert (base64 .p12) | Exported from Keychain Access — see below |
| `APPLE_CERTIFICATE_PASSWORD` | Password used when exporting the .p12 | Set during the Keychain export dialog |
| `APPLE_SIGNING_IDENTITY` | Full identity string e.g. `Developer ID Application: Your Name (37M8KCP95L)` | Run `security find-identity -v -p codesigning` locally and copy the matching line |
| `APPLE_ID` | Apple ID email used for the developer account | The email you log into developer.apple.com with |
| `APPLE_PASSWORD` | App-specific password (not your Apple ID password) | Generate at https://appleid.apple.com → Sign-In and Security → App-Specific Passwords |
| `APPLE_TEAM_ID` | 10-character team identifier | Visible at https://developer.apple.com/account, "Membership" tab |

A Windows code-signing certificate is not yet provisioned — the workflow produces
an unsigned `.msi` for now. Users see a SmartScreen warning on first run and click
"More info → Run anyway". Wire `WINDOWS_CERTIFICATE` + `WINDOWS_CERTIFICATE_PASSWORD`
when the cert arrives.

## Exporting the Apple Certificate from Keychain

The certificate must be installed in your local Keychain first (this happens
automatically when you accept the cert request through Xcode or the developer
portal). Then:

1. Open **Keychain Access** (`/Applications/Utilities/Keychain Access.app`)
2. Select the **login** keychain on the left, then **My Certificates** on the right
3. Find the row labelled `Developer ID Application: <Your Name> (<TEAM_ID>)`
4. Right-click → **Export "Developer ID Application: …"**
5. Save as `aspisfile-cert.p12`. Set a strong password — this is what goes into `APPLE_CERTIFICATE_PASSWORD`
6. Convert to base64 for the GitHub secret:
   ```bash
   base64 -i aspisfile-cert.p12 -o aspisfile-cert.b64
   ```
7. Open `aspisfile-cert.b64` and copy its contents into the `APPLE_CERTIFICATE` secret
8. Delete both files locally — they're no longer needed

## Generating the App-Specific Password

1. Sign in at https://appleid.apple.com with the same Apple ID
2. Open **Sign-In and Security → App-Specific Passwords**
3. Click **+ Generate an app-specific password**
4. Label it `AspisFile Notarisation CI` or similar
5. Copy the generated password (format: `xxxx-xxxx-xxxx-xxxx`) into `APPLE_PASSWORD`

## Cutting a Release

Tag the desired commit and push the tag — that triggers the workflow.

```bash
# From the desktop repo root, on main with all desired commits landed
git tag v1.0.0
git push origin main
git push origin v1.0.0
```

The workflow:
1. Builds a universal `.dmg` on macOS (Apple Silicon + Intel)
2. Builds an unsigned `.msi` on Windows
3. Renames both to stable names (`AspisFile.dmg`, `AspisFile.msi`) so the
   web `/downloads/*` redirects don't need updating between versions
4. Creates a published GitHub Release with both files attached

Monitor at: https://github.com/panog3t-sudo/aspisfile-desktop/actions

## Re-running a Release

If a release fails (e.g. notarisation timeout) and you need to rebuild the
same version:

```bash
# Delete the local + remote tag
git tag -d v1.0.0
git push origin :refs/tags/v1.0.0

# Delete the failed GitHub Release in the UI
# (Releases page → click release → Delete this release)

# Re-tag and push
git tag v1.0.0
git push origin v1.0.0
```

Or, simpler: bump to `v1.0.1`.

## Version Numbering

- Bug fix only: `v1.0.0` → `v1.0.1`
- New feature, backward compatible: `v1.0.0` → `v1.1.0`
- Breaking change: `v1.0.0` → `v2.0.0`

Update `src-tauri/tauri.conf.json:version` and `package.json:version` to match
the tag — Tauri embeds the version in the binary and the updater compares against it.

## Download URLs

End users reach the artifacts via the web app:
- `https://aspisfile.com/downloads/AspisFile.dmg`
- `https://aspisfile.com/downloads/AspisFile.msi`

Both are 307 redirects to `https://github.com/panog3t-sudo/aspisfile-desktop/releases/latest/download/<file>`.
This URL always points at the newest release, so the redirect destinations
never need updating.
