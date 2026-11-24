package server

import (
	"net/http"
)

// routesGeneration registers the generation side of the surface.
//
// There is no file route here any more: media is produced by `POST /api/canvases/{id}/runs` and served
// from the canvas that owns it (`GET /api/canvases/{id}/files/{name}`), so the server has no scratch
// directory to serve out of (#156). Prompts are the agent's, on `/api/agent/socket/{session}`, and a run
// carries its own preview frame and step count — there is nothing else here to route.
func (s *Server) routesGeneration(mux *http.ServeMux) {
	s.routesAgent(mux)
	// The agent's models are a file the preferences window reads and writes, not a session: the editor works
	// when no agent does, which is the case it is for (`routes_models.go`).
	s.routesModels(mux)
}
