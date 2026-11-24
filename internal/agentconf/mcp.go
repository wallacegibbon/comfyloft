package agentconf

import "encoding/json"

// MCP is one block of `mcp.conf`: a server AlayaCore may reach the canvas's tools through.
//
// Only the stdio shape is modelled, because that is the only one this server writes: `command` names the
// bridge, `args` is empty here, and `proto-version` is the version both sides speak. The http shape (`url`,
// `auth-*`) is the operator's to add by hand — a block this package does not read is not one it rewrites.
type MCP struct {
	Server       string
	Command      string
	Args         []string
	ProtoVersion string
}

// FormatMCP writes the one block `mcp.conf` holds.
//
// `args` is always stated, as `[]`: an empty list is what this server has, and a line that is absent would
// read as "not used" rather than "none". The keys are AlayaCore's `mcp` config tags, in the order its own
// writer emits them.
func FormatMCP(server MCP) []byte {
	var w blockWriter
	w.line("server", quote(server.Server))
	w.line("command", quote(server.Command))
	args, err := json.Marshal(server.Args)
	if err != nil || server.Args == nil {
		args = []byte("[]")
	}
	w.line("args", string(args))
	w.line("proto-version", quote(server.ProtoVersion))
	return joinBlocks([]string{w.String()})
}
