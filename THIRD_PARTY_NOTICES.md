# Third-party sources

## Zashboard and local connection adapter

- Official frontend: https://github.com/Zephyruso/zashboard, MIT, Copyright 2024 Zephyruso.
- Initial pinned release: `v3.29.1`, source commit `50717b02dac68425cdc5b80cb754bea768ee4fc9`.
- Unmodified official `dist-no-fonts.zip`, initial SHA-256 `21371cd111b6b3d87774f3ea3ddeacdcb0f6aff8690a16d652daa3ea6e3b0145`. Cached under `.local/zashboard/`, served locally at `/dashboard-ui/<version>/` (legacy `/zashboard/` remains); no frontend fork.
- User-confirmed updates use official stable GitHub release assets and verify their SHA-256 and size. Each installed version retains its release manifest and license; the current/previous pointers are stored locally. Scheduled checks never install an update.
- Full MIT license: `web/src/vendor/zashboard/LICENSE`, also served alongside the downloaded bundle. The upstream bundle includes its own `THIRD_PARTY_NOTICES.md`.
- The local adapter follows upstream `src/api/clash.ts`, `src/types/index.d.ts` and the documented URL connection parameters. Upstream `test/mock-server.mjs` was inspected as a protocol reference; its fabricated traffic and latency fixtures were not adopted.
- WebSocket transport: https://github.com/gorilla/websocket, pinned `v1.5.3`, BSD-2-Clause. Its license is available in the Go module cache and the upstream source.

## meta-json-schema

- Source: https://github.com/dongchengjie/meta-json-schema
- Version: 1.19.32
- Commit: `531b9f036c593246d0b2f8181e8d003282fc6f03`
- License: MIT, Copyright (c) 2024 dongchengjie
- Vendored, unchanged: `web/src/vendor/meta-json-schema/schema.json`
- Full license: `web/src/vendor/meta-json-schema/LICENSE`
- Project corrections are separate in `overrides.json`: SSR `udp`, MASQUE `name-cert-verify`, checked against Mihomo v1.19.32 option structs. Display adaptation is in `mihomoSchema.ts`; it is not the validation schema.

## react-jsonschema-form

- Source: https://github.com/rjsf-team/react-jsonschema-form
- Packages: `@rjsf/core`, `@rjsf/utils`, `@rjsf/validator-ajv8`, all pinned to 6.11.0.
- License: Apache-2.0. Package licenses are distributed with the npm packages.
- Used for nested fields, arrays, dictionaries, widgets and schema validation integration.

## YAML editor and language service

- Monaco Editor: https://github.com/microsoft/monaco-editor, 0.54.0, MIT.
- monaco-yaml: https://github.com/remcohaszing/monaco-yaml, 5.5.1, MIT. Reuses Red Hat's YAML language service in a browser worker.
- Monaco is pinned across the dependency tree to the API used by monaco-yaml's worker. DOMPurify is overridden to 3.4.17 to include its security fixes; the 0.57 package layout is incompatible with this language-service integration.
- Licenses and Monaco's third-party notices are distributed under `web/public/licenses/`. The YAML schema and corrections use the meta-json-schema attribution above.
- Integration: `yamlLanguage.ts` / `yaml.worker.ts`; the upstream Vite worker entry approach is used. Configuration and node schemas remain local; schema requests and formatting are disabled.

## Proxy group ordering dependencies

- dnd-kit: https://github.com/clauderic/dnd-kit, MIT. Installed versions: `@dnd-kit/core` 6.3.1, `@dnd-kit/sortable` 10.0.0, `@dnd-kit/utilities` 3.2.2. Used for pointer, touch and keyboard sorting. Full licenses are included in the npm packages.
- regexp2: https://github.com/dlclark/regexp2, MIT, v1.12.0. Used for bounded local previews with Mihomo's regular-expression dialect. The license is included in the Go module distribution.
- Native order and filtering behavior was checked against Mihomo v1.19.33 `adapter/outboundgroup/groupbase.go` and `adapter/outboundgroup/parser.go`, and against the official executable. Subscription handling remains in Mihomo; no core implementation is bundled in the manager.

## MetaCubeX keyword and regex data

Preset supplements are filtered from MetaCubeX/meta-rules-dat (GPL-3.0), retaining
only DOMAIN-KEYWORD and DOMAIN-REGEX for the selected service categories. The
independent `rules` branch publishes source commits, hashes and the unchanged
upstream license alongside each batch. See [rules/SOURCES.md](rules/SOURCES.md)
and [rules/LICENSE.MetaCubeX](rules/LICENSE.MetaCubeX). The generator and manager
integration are Rivo code; no Mihomo parser or matcher implementation was copied.

## Read-only implementation references

These repositories informed the review. No code was copied from them into the application.

| Repository | Commit | License | Reference |
| --- | --- | --- | --- |
| https://github.com/MetaCubeX/mihomo | `88dcbf7f1614a67c3b36b848ee3592dfa92ada36` (v1.19.32) | GPL-3.0 | `adapter/parser.go`, outbound option structs and protocol semantics |
| https://github.com/vernesong/OpenClash | `e553e82e01c697aefbe1555261a503f425e00ccd` | MIT | `proxies-config.lua`: protocol-specific options and unset semantics |
| https://github.com/nikkinikki-org/OpenWrt-nikki | `78e1a751d55ed0762811f054ee699049473da7b8` | GPL-3.0 | `editor.js`, `profile.js`, `mixin.js`, `proxy.js`: source/runtime and router integration boundaries |
| https://github.com/GUI-for-Cores/GUI.for.Clash | `b479b89225a0823f1e331ade1e12f8df3103a446` | GPL-3.0 | proxy YAML editor and group configuration workflow |

The pinned source clones used for the audit are ignored under `.local/upstream/`.

The LAN interception rules also follow Nikki's connection-direction reply bypass
and local/broadcast/anycast/multicast destination exclusions in
`nikki/files/ucode/hijack.ut`, lines 604–619 of commit
`78e1a751d55ed0762811f054ee699049473da7b8`. These standard nftables predicates are
applied to the manager's own table; Nikki's UCI template and service scripts are
not bundled.
