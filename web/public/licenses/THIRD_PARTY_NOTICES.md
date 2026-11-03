# Third-party sources

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

## Read-only implementation references

These repositories informed the review. No code was copied from them into the application.

| Repository | Commit | License | Reference |
| --- | --- | --- | --- |
| https://github.com/MetaCubeX/mihomo | `88dcbf7f1614a67c3b36b848ee3592dfa92ada36` (v1.19.32) | GPL-3.0 | `adapter/parser.go`, outbound option structs and protocol semantics |
| https://github.com/vernesong/OpenClash | `e553e82e01c697aefbe1555261a503f425e00ccd` | MIT | `proxies-config.lua`: protocol-specific options and unset semantics |
| https://github.com/nikkinikki-org/OpenWrt-nikki | `78e1a751d55ed0762811f054ee699049473da7b8` | GPL-3.0 | `editor.js`, `profile.js`, `mixin.js`, `proxy.js`: source/runtime and router integration boundaries |
| https://github.com/GUI-for-Cores/GUI.for.Clash | `b479b89225a0823f1e331ade1e12f8df3103a446` | GPL-3.0 | proxy YAML editor and group configuration workflow |

The pinned source clones used for the audit are ignored under `.local/upstream/`.
