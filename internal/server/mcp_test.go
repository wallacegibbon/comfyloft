package server

// The MCP endpoint, through the HTTP layer: what AlayaCore sees when it reads the `mcp.conf` this
// server wrote for it.
//
// These tests are about the two halves that have to agree: a call arrives carrying only a session name in
// a header — put there by the bridge from the environment its parent inherited — so that name has to be
// enough to find the session that sent it; and the tool names the model sees are not the names that
// arrive here.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"comfyloft/internal/config"
	"comfyloft/internal/mcpstdio"
)

// startMCPServer is a server whose agent is the fake binary and whose operator configuration has one
// file in it, so a session's copy can be recognised.
func startMCPServer(t *testing.T) (*httptest.Server, *Server, string) {
	t.Helper()
	dir := t.TempDir()
	binary := filepath.Join(dir, "fake-agent")
	if err := os.WriteFile(binary, []byte(fakeAgentScript), 0o755); err != nil {
		t.Fatalf("write fake agent: %v", err)
	}
	configDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(configDir, "model.conf"), []byte("the operator's models\n"), 0o644); err != nil {
		t.Fatalf("write model.conf: %v", err)
	}
	t.Setenv("FAKE_SPAWN_LOG", filepath.Join(dir, "spawned"))
	t.Setenv("ALAYACORE_BIN", binary)
	t.Setenv("AGENT_CONFIG_PATH", configDir)

	srv := newTestServer(t, newFakeComfy(t), config.WithAgentConfigPath(configDir))
	server := httptest.NewServer(srv.Handler())
	t.Cleanup(server.Close)
	return server, srv, configDir
}

// postMCP sends one JSON-RPC call to the bridge endpoint and returns the status and the decoded answer.
//
// The endpoint is the loopback listener, not the main handler: a tool that creates nodes has no business
// on the address COMFYLOFT_SERVER_HOST names, and this is also what lets the tests check the two headers without
// going through a real bridge process.
func postMCP(t *testing.T, server *Server, session string, call map[string]any) (int, map[string]any, error) {
	t.Helper()
	body, err := json.Marshal(call)
	if err != nil {
		return 0, nil, err
	}
	request, err := http.NewRequest(http.MethodPost, server.mcpURL+"/mcp", bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	if session != "" {
		request.Header.Set("X-Comfyloft-Session", session)
	}
	request.Header.Set("X-Comfyloft-Bridge", mcpstdio.Version)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	var answer map[string]any
	if response.StatusCode == http.StatusOK {
		if err := json.NewDecoder(response.Body).Decode(&answer); err != nil {
			return response.StatusCode, nil, err
		}
	}
	return response.StatusCode, answer, nil
}

// mcpCall is postMCP for a call that is supposed to happen on this goroutine.
func mcpCall(t *testing.T, server *Server, session string, call map[string]any) (int, map[string]any) {
	t.Helper()
	status, answer, err := postMCP(t, server, session, call)
	if err != nil {
		t.Fatalf("mcp call: %v", err)
	}
	return status, answer
}

// toolCall is one `tools/call`, which is what an agent does once it has decided to use a tool.
func toolCall(id int, name string, arguments map[string]any) map[string]any {
	return map[string]any{
		"jsonrpc": "2.0", "id": id, "method": "tools/call",
		"params": map[string]any{"name": name, "arguments": arguments},
	}
}

// toolAnswerOf wraps content blocks the way the canvas sends them back.
func toolAnswerOf(callID string, content ...any) map[string]any {
	return map[string]any{"toolResult": map[string]any{"callId": callID, "content": content}}
}

// textBlock is one text content block, which is what most tools answer with.
func textBlock(text string) map[string]any {
	return map[string]any{"type": "text", "text": text}
}

// textOfResult is the one text block a tool result carries.
func textOfResult(t *testing.T, result map[string]any) string {
	t.Helper()
	content, ok := result["content"].([]any)
	if !ok || len(content) != 1 {
		t.Fatalf("result content = %v, want one block", result["content"])
	}
	return content[0].(map[string]any)["text"].(string)
}

// resultOf is the `result` of a call that has to succeed.
func resultOf(t *testing.T, answer map[string]any) map[string]any {
	t.Helper()
	if failure, ok := answer["error"]; ok {
		t.Fatalf("call failed: %v", failure)
	}
	result, ok := answer["result"].(map[string]any)
	if !ok {
		t.Fatalf("answer has no result: %v", answer)
	}
	return result
}

// TestMCPHandshakeIsEnoughToDiscoverTheTools: what AlayaCore does on connect — initialize, then
// tools/list — and what it has to get back for the server to show up at all.
func TestMCPHandshakeIsEnoughToDiscoverTheTools(t *testing.T) {
	_, server, _ := startMCPServer(t)

	_, answer := mcpCall(t, server, "whatever", map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{},
	})
	handshake := resultOf(t, answer)
	if handshake["protocolVersion"] != mcpProtocolVersion {
		t.Fatalf("protocolVersion = %v, want %q", handshake["protocolVersion"], mcpProtocolVersion)
	}
	if _, ok := handshake["serverInfo"]; !ok {
		t.Fatalf("handshake has no serverInfo: %v", handshake)
	}

	_, answer = mcpCall(t, server, "whatever", map[string]any{
		"jsonrpc": "2.0", "id": 2, "method": "tools/list",
	})
	tools, ok := resultOf(t, answer)["tools"].([]any)
	if !ok || len(tools) == 0 {
		t.Fatalf("tools/list = %v, want at least one tool", answer)
	}
	// The vocabulary, in the order it is offered: a name that disappears from here is a tool the canvas
	// can no longer be asked for.
	var names []string
	for _, tool := range tools {
		names = append(names, tool.(map[string]any)["name"].(string))
	}
	if strings.Join(names, ",") != "ping,list_nodes,create_node,connect,capture_frame,join_clips,set_prompt,set_text,set_node,generate,list_models,stop_node,read_node,read_prompt,read_text,read_media,delete_node,restore_node,focus_node,move_node,group_nodes,ungroup_nodes,resize_node" {
		t.Fatalf("tools/list = %v, want ping, list_nodes, create_node, connect, capture_frame, join_clips, set_prompt, set_text, set_node, generate, list_models, stop_node, read_node, read_prompt, read_text, read_media, delete_node, restore_node, focus_node, move_node, group_nodes, ungroup_nodes, resize_node", names)
	}
}

// TestAgentSpawnCarriesTheCanvasRule: the rule that chooses between the tools travels in the agent's
// system prompt, because a tool description explains one tool and a skill has to be read before it can
// help. It is set on every spawn, canvas panel and node panel alike. The last rule is #203: a prompt is
// said once, in the box or in a connected text node, and the agent may not write both — the panel stopped
// copying the connected text into the box in #185, and `create_node` still let the agent do it.
//
// One phrase per rule, in the order the prompt states them: a paragraph that loses its rule is a behaviour
// that quietly goes back to being decided by the model's taste (#281, #282, #286).
func TestAgentSpawnCarriesTheCanvasRule(t *testing.T) {
	server := newTestServer(t, newFakeComfy(t))

	system := strings.Join(server.agentOptions().System, "\n")
	wants := []string{
		"Your tools are the canvas_* tools",
		"Prefer a connection to a copy",
		"copy content only when the user asked for a separate copy",
		// #286: candidates are one card the pictures share, pressed one by one.
		"several pictures of the same thing to choose from",
		"leave their own prompts empty",
		"press each one with canvas_generate",
		"press only after the canvas has answered your connections",
		"another candidate is a new node",
		// #286: layout is checked against the sizes, not guessed.
		"read the card sizes list_nodes reports",
		"not on top of each other",
		// #290: a group is structure the user owns, and membership is not geometry.
		"A group is a container, not a picture",
		"Grouping is the user's tidying",
		"never from where the cards are",
		// #286: asking about a node is answered by moving the user's view to it.
		"Naming a node is not showing it",
		"name it with an @ in front",
		"the id the tools answer with",
		// The panel draws Markdown and no HTML: a model that dresses an @id in a tag shows the tag.
		"not dressed in a tag",
		"the panel draws no HTML",
		"the viewport is the user's",
		// #203: said once, in the box or in the card.
		"leave that node's own prompt empty",
		"only that node needs them",
		"carries nothing",
		"canvas_set_text",
		"canvas_read_text",
		"canvas_read_prompt",
		// The shape of a run and which run it is are one call, and it is checked against what the workflow publishes.
		"canvas_set_node",
		"canvas_read_node reads it back",
		// The model is still the one change that alters what the picture is, and that rule is now said in words
		// rather than carried by a tool of its own.
		"change the model when the user asks for that model",
		// The one read that costs real context has a name of its own, so the cheap ones stay cheap.
		"canvas_read_media",
		// #312: the model list is data, and the prompt only says where to ask.
		"canvas_list_models",
		// #323/#324: a longer clip is a chain of clips, and joining them is not a run.
		"canvas_capture_frame",
		"the first frame of the next clip",
		"canvas_join_clips",
		"in the order you name",
		// #326: a run reports back on its own, so waiting for it or polling it is the wrong thing to do with
		// a turn. It was in `generate`'s description and answer, which is where a rule about working goes to
		// be forgotten: the temptation arrives after the call, when the description has been read and gone.
		"Pressing is not waiting",
		"finished, failed or cancelled",
		"Do not wait for it and do not poll the node",
		// #310: a run the agent started can be ended, and that is what makes pressing safe.
		"canvas_stop_node",
		"Press nothing you cannot stop",
		// #327: a delete is a move into the canvas's trash, so it is neither permanent nor something to avoid.
		"Deleting is a move, not a loss",
		"canvas_restore_node",
		"a mistake of yours is one call away from being undone",
	}
	for _, want := range wants {
		if !strings.Contains(system, want) {
			t.Fatalf("the agent's system prompt does not mention %q: %q", want, system)
		}
	}

	// The mechanism, not just the policy: `connect` says what a text connection does, because that is the
	// fact the agent got wrong — it took the connection as a reason the box did not matter — and it carries
	// one worked example of each order, because the table used to describe only one direction and text into
	// a picture is the wiring #203 asks for (#206).
	for _, tool := range server.mcpTools() {
		if tool.Name != "connect" {
			continue
		}
		for _, want := range []string{"say them twice", "fromNodeId is the text node", "a picture into a text node"} {
			if !strings.Contains(tool.Description, want) {
				t.Fatalf("connect does not say %q: %q", want, tool.Description)
			}
		}
	}
}

// TestMCPToolIsRunByTheCanvas is the whole point of the pipe: a call carries no identity, the URL has to
// be enough to find the session, and only the page can actually run the tool.
func TestMCPToolIsRunByTheCanvas(t *testing.T) {
	server, api, _ := startMCPServer(t)
	session := canvasSession(t, server)
	conn := openSocket(t, server, session)

	answered := make(chan map[string]any, 1)
	go func() {
		_, answer, err := postMCP(t, api, session, toolCall(3, "ping", map[string]any{"where": "here"}))
		if err != nil {
			answered <- map[string]any{"post": err.Error()}
			return
		}
		answered <- answer
	}()

	// The page is asked, with an id to answer with and the arguments as they were sent.
	asked := nextEvent(t, conn)
	if asked["type"] != "tool" || asked["name"] != "ping" {
		t.Fatalf("canvas was asked %v, want a ping tool call", asked)
	}
	callID, ok := asked["callId"].(string)
	if !ok || callID == "" {
		t.Fatalf("tool call has no id: %v", asked)
	}
	if arguments, ok := asked["arguments"].(map[string]any); !ok || arguments["where"] != "here" {
		t.Fatalf("arguments = %v, want the call's own", asked["arguments"])
	}

	send(t, conn, toolAnswerOf(callID, textBlock("pong from the page")))

	answer := <-answered
	if failure, ok := answer["post"]; ok {
		t.Fatalf("post: %v", failure)
	}
	result := resultOf(t, answer)
	if text := textOfResult(t, result); text != "pong from the page" {
		t.Fatalf("tool result = %q, want what the canvas said", text)
	}
	if result["isError"] != nil {
		t.Fatalf("the call is an error: %v", result)
	}
}

// TestMCPCarriesTheBlocksThePageProduced is what a read tool needs: the content the canvas sends reaches
// AlayaCore unchanged. Nothing here inspects it, so a media block — and any field a later revision adds to
// one — has to survive the trip exactly as written.
func TestMCPCarriesTheBlocksThePageProduced(t *testing.T) {
	server, api, _ := startMCPServer(t)
	session := canvasSession(t, server)
	conn := openSocket(t, server, session)

	answered := make(chan map[string]any, 1)
	go func() {
		_, answer, err := postMCP(t, api, session, toolCall(8, "read_node", map[string]any{"nodeId": "image-1"}))
		if err != nil {
			answered <- map[string]any{"post": err.Error()}
			return
		}
		answered <- answer
	}()

	asked := nextEvent(t, conn)
	// A picture and a sentence, as the page would send a node's picture with its prompt.
	blocks := []any{
		textBlock("a red ceramic teapot"),
		map[string]any{"type": "image", "data": "iVBORw0KGgoAAAANSUhEUg==", "mimeType": "image/png"},
		map[string]any{"type": "resource", "resource": map[string]any{"uri": "canvas://video-1", "mimeType": "video/mp4", "blob": "AAAAIGZ0eXBpc29t"}},
	}
	send(t, conn, toolAnswerOf(asked["callId"].(string), blocks...))

	result := resultOf(t, <-answered)
	got, err := json.Marshal(result["content"])
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	want, err := json.Marshal(blocks)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(got) != string(want) {
		t.Fatalf("content = %s, want it carried through as %s", got, want)
	}
}

// TestMCPToolReportsWhatTheCanvasCalledAFailure: a tool that failed is a result the agent can read, not a
// broken response.
func TestMCPToolReportsWhatTheCanvasCalledAFailure(t *testing.T) {
	server, api, _ := startMCPServer(t)
	session := canvasSession(t, server)
	conn := openSocket(t, server, session)

	answered := make(chan map[string]any, 1)
	go func() {
		_, answer, err := postMCP(t, api, session, toolCall(4, "ping", map[string]any{}))
		if err != nil {
			answered <- map[string]any{"post": err.Error()}
			return
		}
		answered <- answer
	}()

	asked := nextEvent(t, conn)
	send(t, conn, map[string]any{"toolResult": map[string]any{
		"callId": asked["callId"], "content": []any{textBlock("there is no such node")}, "isError": true,
	}})

	result := resultOf(t, <-answered)
	if result["isError"] != true {
		t.Fatalf("a tool the canvas failed is not reported as one: %v", result)
	}
	if text := textOfResult(t, result); text != "there is no such node" {
		t.Fatalf("tool result = %q, want the canvas's reason", text)
	}
}

// TestMCPToolSaysWhenNoCanvasIsWatching: the agent outlives the page, so a tool call it makes while nobody
// is looking has nobody to run it — and has to be answered anyway, in words the agent can act on. It is not
// the end of the session: the next page runs the next call.
func TestMCPToolSaysWhenNoCanvasIsWatching(t *testing.T) {
	server, api, _ := startMCPServer(t)
	session := canvasSession(t, server)
	conn := openSocket(t, server, session)
	_ = conn.Close()
	time.Sleep(300 * time.Millisecond) // long enough for the server to notice the socket is gone

	_, answer := mcpCall(t, api, session, toolCall(5, "ping", map[string]any{}))
	result := resultOf(t, answer)
	if result["isError"] != true {
		t.Fatalf("a call with no canvas behind it is not an error: %v", result)
	}
	if text := textOfResult(t, result); !strings.Contains(text, "no canvas is connected") {
		t.Fatalf("answer = %q, want it to say no canvas is watching", text)
	}
	if got := spawns(t, os.Getenv("FAKE_SPAWN_LOG")); got != 1 {
		t.Fatalf("spawned %d agents, want the one the session already had", got)
	}
}

// TestMCPUnknownToolIsRefused: the vocabulary is the server's, so a name it never advertised does not
// reach the canvas at all.
func TestMCPUnknownToolIsRefused(t *testing.T) {
	server, api, _ := startMCPServer(t)
	session := canvasSession(t, server)
	openSocket(t, server, session)

	_, answer := mcpCall(t, api, session, toolCall(6, "empty_the_canvas", map[string]any{}))
	result := resultOf(t, answer)
	if text := textOfResult(t, result); !strings.Contains(text, "no tool named") {
		t.Fatalf("answer = %q, want it to refuse the name", text)
	}
}

// TestMCPToolSaysWhenNoAgentOwnsTheSession: a call that arrives after the session was released is
// answered, not dropped — the agent is waiting for this write.
func TestMCPToolSaysWhenNoAgentOwnsTheSession(t *testing.T) {
	_, server, _ := startMCPServer(t)

	_, answer := mcpCall(t, server, "canvas-1", toolCall(7, "ping", map[string]any{}))
	result := resultOf(t, answer)
	if result["isError"] != true {
		t.Fatalf("a call with no agent behind it is not an error: %v", result)
	}
	if text := textOfResult(t, result); !strings.Contains(text, "no agent") {
		t.Fatalf("answer = %q, want it to say no agent is attached", text)
	}
}

// TestMCPNotificationIsAccepted: `notifications/initialized` has no id and no answer, and a server that
// replies to it leaves the client waiting for an answer to something it never asked.
func TestMCPNotificationIsAccepted(t *testing.T) {
	_, server, _ := startMCPServer(t)

	status, answer := mcpCall(t, server, "whatever", map[string]any{
		"jsonrpc": "2.0", "method": "notifications/initialized",
	})
	if status != http.StatusAccepted {
		t.Fatalf("notification answered %d, want %d", status, http.StatusAccepted)
	}
	if answer != nil {
		t.Fatalf("notification was answered with %v, want nothing", answer)
	}
}

// TestMCPOneStaticConfigServesEverySession is the point of moving the identity out of the URL: the file
// AlayaCore reads says nothing about a session, so two canvases can share it, and what tells them apart
// is the environment the server put in each spawned process.
func TestMCPOneStaticConfigServesEverySession(t *testing.T) {
	server, api, configDir := startMCPServer(t)
	envLog := filepath.Join(t.TempDir(), "environ")
	t.Setenv("FAKE_ENV_LOG", envLog)

	one := canvasSession(t, server)
	openSocket(t, server, one)
	first := waitForEnv(t, envLog)

	// The file the agent reads: written by the server, identical for everyone, naming the bridge.
	written, err := os.ReadFile(filepath.Join(configDir, "mcp.conf"))
	if err != nil {
		t.Fatalf("read mcp.conf: %v", err)
	}
	for _, want := range []string{"server: canvas", "comfyloft-mcp", "proto-version: " + mcpProtocolVersion} {
		if !strings.Contains(string(written), want) {
			t.Fatalf("mcp.conf = %q, want it to contain %q", written, want)
		}
	}
	if strings.Contains(string(written), strings.TrimPrefix(one, canvasSessionPrefix)) {
		t.Fatalf("mcp.conf names a session: %q", written)
	}

	// And the session, in the process's environment, pointing at the listener that is running now.
	if first.session != one {
		t.Fatalf("COMFYLOFT_SESSION = %q, want the canvas that opened the socket (%q)", first.session, one)
	}
	if first.endpoint != api.mcpURL {
		t.Fatalf("COMFYLOFT_MCP = %q, want %q", first.endpoint, api.mcpURL)
	}

	// A second session gets its own environment and the same file.
	two := canvasSession(t, server)
	openSocket(t, server, two)
	second := waitForEnv(t, envLog)
	if second.session != two || second.endpoint != first.endpoint {
		t.Fatalf("second spawn = %+v, want session %q at the same endpoint", second, two)
	}
	again, err := os.ReadFile(filepath.Join(configDir, "mcp.conf"))
	if err != nil {
		t.Fatalf("read mcp.conf: %v", err)
	}
	if string(again) != string(written) {
		t.Fatalf("mcp.conf changed between sessions: %q -> %q", written, again)
	}
}

// TestMCPRefusesABridgeItDoesNotSpeak: two binaries can be from different builds, and the failure has to
// name both sides instead of turning into a handshake EOF inside AlayaCore.
func TestMCPRefusesABridgeItDoesNotSpeak(t *testing.T) {
	_, server, _ := startMCPServer(t)

	post := func(bridge, session string) (int, string) {
		request, err := http.NewRequest(http.MethodPost, server.mcpURL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		if bridge != "" {
			request.Header.Set("X-Comfyloft-Bridge", bridge)
		}
		if session != "" {
			request.Header.Set("X-Comfyloft-Session", session)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatalf("post: %v", err)
		}
		defer response.Body.Close()
		body := make([]byte, 512)
		n, _ := response.Body.Read(body)
		return response.StatusCode, string(body[:n])
	}

	if status, body := post("999", "canvas-1"); status != http.StatusBadRequest || !strings.Contains(body, "rebuild both") {
		t.Fatalf("a newer bridge answered %d %q, want a 400 that says to rebuild both", status, body)
	}
	if status, body := post("", "canvas-1"); status != http.StatusBadRequest || !strings.Contains(body, "comfyloft-mcp") {
		t.Fatalf("a bridge with no version answered %d %q, want a 400 naming the bridge", status, body)
	}
	if status, body := post(mcpstdio.Version, ""); status != http.StatusBadRequest || !strings.Contains(body, "X-Comfyloft-Session") {
		t.Fatalf("a bridge with no session answered %d %q, want a 400 naming the missing header", status, body)
	}
}

// TestMCPListenerIsLoopbackOnly: the endpoint must not be reachable from whatever address COMFYLOFT_SERVER_HOST
// names, so the address it reports has to be a loopback one.
func TestMCPListenerIsLoopbackOnly(t *testing.T) {
	_, server, _ := startMCPServer(t)
	host := strings.TrimPrefix(strings.TrimSuffix(strings.TrimPrefix(server.mcpURL, "http://"), ""), "")
	host = strings.Split(host, ":")[0]
	if host != "127.0.0.1" {
		t.Fatalf("MCP endpoint = %q, want a loopback address", server.mcpURL)
	}
}

// spawnEnv is what the fake agent recorded about one spawn.
type spawnEnv struct{ endpoint, session string }

// waitForEnv blocks until the fake agent has recorded one more spawn's environment.
func waitForEnv(t *testing.T, path string) spawnEnv {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	seen := 0
	for {
		if raw, err := os.ReadFile(path); err == nil {
			lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
			if strings.TrimSpace(lines[0]) != "" && len(lines) > seen {
				seen = len(lines)
				parts := strings.Split(lines[seen-1], "|")
				if len(parts) == 2 {
					return spawnEnv{endpoint: parts[0], session: parts[1]}
				}
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("the fake agent recorded no environment at %s", path)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestToolsDescribeWhatTheCanvasAccepts: the schema is the only thing the model reads before it calls, so it
// has to describe the call the canvas will take. Two of them had drifted from the code beside them — #335 made
// `ungroup_nodes` take a group and refuse a member, and `create_node` makes a group, which the canvas's own
// create menu offers and the tool's own answer still described (#336).
func TestToolsDescribeWhatTheCanvasAccepts(t *testing.T) {
	server := newTestServer(t, newFakeComfy(t))
	found := map[string]mcpTool{}
	for _, tool := range server.mcpTools() {
		found[tool.Name] = tool
	}

	ungroup, ok := found["ungroup_nodes"]
	if !ok {
		t.Fatal("there is no ungroup_nodes tool")
	}
	if !strings.Contains(strings.ToLower(ungroup.Description), "dissolve") {
		t.Fatalf("ungroup_nodes does not say what it does to a group: %q", ungroup.Description)
	}
	// The sentence that was there before #335: a member id does not leave its group, it is refused.
	for _, gone := range []string{"it leaves the group it is in", "the nodes to take out of theirs"} {
		if strings.Contains(ungroup.Description, gone) {
			t.Fatalf("ungroup_nodes still promises %q: %q", gone, ungroup.Description)
		}
	}
	if strings.Contains(string(ungroup.InputSchema), "take out of theirs") {
		t.Fatalf("ungroup_nodes' argument still offers a member's id: %s", ungroup.InputSchema)
	}

	create, ok := found["create_node"]
	if !ok {
		t.Fatal("there is no create_node tool")
	}
	var schema struct {
		Properties struct {
			Type struct {
				Enum []string `json:"enum"`
			} `json:"type"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(create.InputSchema, &schema); err != nil {
		t.Fatalf("create_node's schema is not JSON: %v", err)
	}
	// A group is a type the canvas makes, so a schema without it and a description that explains it were
	// telling the model two different things.
	for _, want := range []string{"image", "video", "audio", "text", "group"} {
		if !slices.Contains(schema.Properties.Type.Enum, want) {
			t.Fatalf("create_node cannot be asked for %q: %v", want, schema.Properties.Type.Enum)
		}
	}
}
