# Agent Transfer

Two tools for the SiYuan Agent: **download** a web file into the workspace assets, and **upload** an asset to a URL. Requires SiYuan ≥ 3.8.0; SiYuan's own agent approval prompts still appear as usual.

Try "download this image: https://example.com/a.png". Uploads to non-whitelisted targets show a confirmation dialog first — you decide.

## Download: save a web file into assets

Agent tool `download_asset` (required `url`; optional `filename`, inferred from the URL when omitted).

- Files land in the workspace `assets/` folder with SiYuan's standard deduplicated naming; the agent gets back a path ready for document references.
- 50 MB per file; http/https only; localhost / private-network addresses are rejected.
- On failure the agent receives the reason and can retry with corrected parameters.

## Upload: send an asset to an external URL (confirmed by you)

Agent tool `upload_asset`. **A confirmation dialog shows the filename, size and target URL before uploading** anything to a non-whitelisted address:

- **Allow once / Deny once**: affects only the current upload;
- **Whitelist & upload / Blacklist**: edit the URL into a wildcard (e.g. `https://*.example.com`) before saving if you like — whitelisted targets upload without asking again, blacklisted ones are refused outright;
- blacklisted targets are refused without a dialog; whitelisted ones upload silently.

Lists are managed in the plugin **Settings**. Rule syntax: one `scheme://host[:port]` per line; wildcards like `https://*.example.com` match the domain and all subdomains; paths are ignored; `#` starts a comment.

Parameters:

| Param | Required | Description |
| --- | --- | --- |
| `path` | yes | file inside assets; a bare filename auto-matches SiYuan's timestamp-suffixed copies |
| `url` | yes | http(s) target; supports `{{vars.NAME}}` variables |
| `method` | no | `POST` (default) or `PUT` |
| `headers` | no | extra request headers; credentials referenced as `{{secrets.NAME}}` (see below) |
| `multipart` | no | `true` for form-style uploads (file-sharing services etc.) |
| `fileField` / `fields` | no | form field name for the file (default `file`) and extra text fields |

After a successful upload the remote response (e.g. a sharing link) is returned to the agent. Limits: 32 MB per file; http/https only; private-network hosts are always rejected; only files inside assets can be uploaded.

### Credentials (tokens and other secrets)

Configure secrets and their allowed hosts in **SiYuan Settings → AI**; the agent references them as `{{secrets.NAME}}` in headers. Plaintext never appears in the chat, logs or results, and is only sent to hosts you authorized.

## Debug log

The plugin **Settings** offer exporting a redacted per-call log (args, gating verdicts, your decisions, network results) as `.txt` to diagnose agent issues; the last 2000 entries are kept and can be cleared in one click.
