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

The source lives outside the SiYuan workspace (keeps `node_modules` out of kernel sync/snapshot); builds go to `dist/`, and `npm run deploy` installs them into the workspace (override the target with `SIYUAN_PLUGIN_DIR`).

```bash
npm install
npm run deploy   # build + install dist/ into {workspace}/data/plugins/download-asset/
npm run dev      # watch build into dist/; deploy, then disable->enable the plugin to reload
npm run build    # release build: dist/ + package.zip
npm run check    # tsc type check
npm test         # handler smoke tests against a mocked kernel (21 assertions)
```

Requires SiYuan >= 3.8.0.
