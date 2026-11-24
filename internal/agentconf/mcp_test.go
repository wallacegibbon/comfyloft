package agentconf

import "testing"

// The file this server writes for the agent's MCP bridge: one block, the keys AlayaCore's `mcp` tags name,
// and `args` stated as `[]` rather than left out.
func TestFormatMCPIsTheBlockAlayaCoreReads(t *testing.T) {
	got := string(FormatMCP(MCP{Server: "canvas", Command: "/opt/comfyloft/comfyloft-mcp", ProtoVersion: "2025-11-25"}))
	want := `server: "canvas"
command: "/opt/comfyloft/comfyloft-mcp"
args: []
proto-version: "2025-11-25"
`
	if got != want {
		t.Fatalf("format =\n%s\nwant\n%s", got, want)
	}
}

// A path with a character the file has to escape comes back as the path it was — the reason this file and
// `model.conf` share one writer: `%q` there would turn a tab into the two characters `\t`, which AlayaCore's
// reader does not unescape.
func TestFormatMCPEscapesWhatAlayaCoreUnescapes(t *testing.T) {
	bridge := "/home/some one/tab\there/back\\slash/comfyloft-mcp"
	got := string(FormatMCP(MCP{Server: "canvas", Command: bridge, ProtoVersion: "2025-11-25"}))

	fields, others, problems := parseBlock(blocks(got)[0])
	if len(problems) != 0 || len(others) != 0 {
		t.Fatalf("problems = %v, extras = %v", problems, others)
	}
	for _, field := range fields {
		if field.key == "command" && field.value != bridge {
			t.Fatalf("command = %q, want %q (from %q)", field.value, bridge, got)
		}
	}
}
