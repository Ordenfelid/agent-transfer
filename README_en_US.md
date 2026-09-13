# Download Asset

A SiYuan Agent tool: **download a resource from a given URL into the workspace `assets/` folder** and return the asset path ready for document references.

## What it does

Registers an agent tool named `download_asset`:

| Param | Required | Description |
| --- | --- | --- |
| `url` | yes | Full http(s) URL of the resource |
| `filename` | no | Target filename (with extension); inferred from the URL when omitted |

- Download goes through the kernel proxy `/api/network/forwardProxy` (no CORS limits), returned as base64 and decoded locally.
- Ingestion goes through `/api/asset/upload` with `assetsDirPath: /assets/`; the kernel applies its standard asset naming/dedup and the final path comes from `succMap`.
- Declares `localWrite + dataEgress` effects, so the agent asks for user approval before running the tool.

## Built-in constraints

- Only `http/https`; localhost / private-network hosts are rejected.
- 50 MB per-file limit (the kernel proxy buffers the whole body in memory).
- Filenames are stripped of path parts and control characters; extensions are completed from Content-Type.
- All failures return an `error` string (with the reason) so the model can self-correct.

## Development

The project lives inside `{workspace}/data/plugins/download-asset/`; build output goes to the project root (SiYuan loads `<plugin dir>/index.js`).

```bash
npm install
npm run dev      # watch build; disable->enable the plugin in SiYuan to reload
npm run build    # release build: dist/ + package.zip
npm run check    # tsc type check
```

Requires SiYuan >= 3.8.0.
