// Package assets embeds the same vendored schema used by the browser.
package assets

import _ "embed"

const SchemaVersion = "1.19.32"

//go:embed web/src/vendor/meta-json-schema/schema.json
var Schema []byte

//go:embed web/src/vendor/zashboard/LICENSE
var DashboardLicense []byte
