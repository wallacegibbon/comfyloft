package server

// The agent's hands, on a socket only this machine can reach.
//
// A tool call arrives here from the bridge (`comfyloft-mcp`), which AlayaCore spawned; the server
// routes it down the session's websocket to the browser tab that can actually run it. AlayaCore is
// configured with one static `mcp.conf`, so the file cannot say which session a call belongs to —
// the session travels in the spawned process's environment instead, and the bridge puts it in a header.
//
// The listener is a second, loopback-only one rather than a route on the main mux. Two reasons:
// `/api` is served on whatever `COMFYLOFT_SERVER_HOST` says, which can be a LAN address, and a tool that creates
// nodes and starts generations has no business being reachable from the network with no token. And the
// identity header makes a browser-driven cross-site POST impossible without a CORS preflight, which
// this listener never answers.

import (
	"fmt"
	"net"
	"net/http"
	"time"

	"comfyloft/internal/httpx"
	"comfyloft/internal/mcpstdio"
)

// startMCPListener binds the bridge's endpoint on 127.0.0.1 and serves until Close.
//
// The port is ephemeral on purpose: it is not part of any configuration, it is written into the
// environment of the processes that need it, and a stable port would be a thing to collide over.
func (s *Server) startMCPListener() error {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("cannot listen for the MCP bridge: %w", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /mcp", func(w http.ResponseWriter, r *http.Request) {
		ctx := &httpx.Ctx{W: w, R: r, RequestID: httpx.RequestIDOf(r)}
		if err := s.handleMCP(ctx); err != nil {
			httpx.WriteError(w, err)
		}
	})
	server := &http.Server{
		Handler:           httpx.Recover(s.logger)(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}
	s.mcpListener = listener
	s.mcpServer = server
	s.mcpURL = fmt.Sprintf("http://127.0.0.1:%d", listener.Addr().(*net.TCPAddr).Port)
	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			s.logger.Warn("MCP bridge listener stopped: %s", err)
		}
	}()
	return nil
}

// mcpEndpoint is what the agent's environment is told. Empty when the listener never started, which the
// bridge reports as "nowhere to send the call" — one sentence, one side.
func (s *Server) mcpEndpoint() string { return s.mcpURL }

// closeMCP stops the bridge listener. Its sessions are already gone by then: the shutdown path releases
// every agent process first (Sessions.CloseAll), which is also what ends the bridge's in-flight calls.
func (s *Server) closeMCP() {
	if s.mcpServer != nil {
		_ = s.mcpServer.Close()
	}
}

// checkBridge refuses a bridge this build does not speak to.
//
// Two binaries means a mixed install is possible — a rebuilt bridge against a server process that has
// not been restarted. Without this the failure is a JSON-RPC parse error somewhere inside AlayaCore,
// which tells a reader nothing about which half to replace.
func (s *Server) checkBridge(r *http.Request) error {
	version := r.Header.Get("X-Comfyloft-Bridge")
	if version == mcpstdio.Version {
		return nil
	}
	if version == "" {
		return httpx.BadRequest("bridge_version_missing", "this endpoint is for comfyloft-mcp, which sends X-Comfyloft-Bridge; the server is not an MCP server for anything else")
	}
	return httpx.BadRequest("bridge_version_mismatch", fmt.Sprintf("comfyloft-mcp speaks bridge %s and this server speaks %s; rebuild both from the same source", version, mcpstdio.Version))
}

// sessionOf is the session an MCP call belongs to, from the header the bridge wrote.
//
// An empty header is a bridge that was spawned by something other than this server; an unknown value is
// a session that is gone — its browser tab closed, or its process was released. They are different
// failures and they read differently, because the fix is different.
func (s *Server) sessionOf(r *http.Request) (string, error) {
	session := r.Header.Get("X-Comfyloft-Session")
	if session == "" {
		return "", httpx.BadRequest("bridge_session_missing", "the bridge sent no X-Comfyloft-Session; it was not spawned by this server")
	}
	return session, nil
}
