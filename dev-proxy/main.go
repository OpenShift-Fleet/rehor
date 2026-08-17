package main

import (
	caddycmd "github.com/caddyserver/caddy/v2/cmd"

	_ "github.com/caddyserver/caddy/v2/modules/standard"
	_ "github.com/caddyserver/cache-handler"
	_ "github.com/caddyserver/transform-encoder"
	_ "github.com/RedHatInsights/frontend-development-proxy/rh_identity_transform"
)

func main() {
	caddycmd.Main()
}
