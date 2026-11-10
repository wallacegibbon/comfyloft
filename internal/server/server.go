// Package server wires every module into the HTTP surface the canvas talks to.
package server

import (
	"errors"
	"net"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"comfyloft/internal/agent"
	"comfyloft/internal/canvas"
	"comfyloft/internal/comfy"
	"comfyloft/internal/config"
	"comfyloft/internal/generate"
	"comfyloft/internal/httpx"
	"comfyloft/internal/logx"
	"comfyloft/internal/resource"
	"comfyloft/internal/settings"
	"comfyloft/internal/setup"
	"comfyloft/internal/store"
	"comfyloft/internal/task"
	"comfyloft/internal/upload"
	"comfyloft/internal/util"
	"comfyloft/internal/workflow"
)

// Server holds every subsystem plus the HTTP handler.
type Server struct {
	cfg        *config.Config
	logger     *logx.Logger
	comfy      *comfy.Client
	hub        *generate.Hub
	runner     *generate.Runner
	mainModels *store.MainModels
	// speechProfiles is the list of speech servers, which one dictation uses, and their credentials: server-side
	// only, never in the preferences document (that one is handed to every browser), never sent back to a page
	// (#246, #252).
	speechProfiles *store.SpeechProfiles
	registry       *workflow.Registry
	tasks          *task.Store
	uploads        *upload.Store
	// canvases is the workspace: one directory per canvas, owned by the server and backed up by
	// copying it. Nothing else in the server knows what a node is, and this is the reason.
	canvases *canvas.Store
	// settings is the preferences document: opaque here, owned by the canvas, kept beside the data so
	// it survives a cleared browser and travels with the workspace.
	settings *settings.Store
	// agentSessions holds the agents a socket started, one per client-chosen name.
	agentSessions *agent.Sessions
	setup         *setup.Manager
	resources     *resource.Manager

	// The bridge's endpoint: a second listener, bound to 127.0.0.1, that only comfyloft-mcp talks to.
	mcpServer   *http.Server
	mcpListener net.Listener
	mcpURL      string

	startedAt time.Time
}

// New constructs the whole server. Everything is loaded before the first request,
// so a half-initialized server can never answer.
func New(cfg *config.Config, logger *logx.Logger) (*Server, error) {
	// A server that was killed mid-write leaves its temporary file next to the target; nothing reads it
	// again, so startup is the one moment it can be swept safely.
	util.SweepTempFiles(cfg.DataDir)
	util.SweepTempFiles(cfg.CanvasRoot)

	comfyClient, err := comfy.New(comfy.Options{
		BaseURL:       cfg.ComfyURL,
		TimeoutMs:     cfg.RequestTimeoutMs,
		RetryAttempts: cfg.ComfyRetryAttempts,
		RetryDelayMs:  cfg.ComfyRetryDelayMs,
		Logger:        logger,
	})
	if err != nil {
		return nil, err
	}

	mainModels := store.NewMainModels(cfg.DataDir, logger)
	mainModels.Load()

	registry := workflow.NewRegistry(workflow.RegistryOptions{
		Dir:              cfg.WorkflowDir,
		MaxWorkflowBytes: cfg.MaxWorkflowBytes,
		Logger:           logger,
		MainModelFileFor: mainModels.FileForWorkflow,
	})
	if err := registry.Load(); err != nil {
		return nil, err
	}

	canvases, err := canvas.New(cfg.CanvasRoot)
	if err != nil {
		return nil, err
	}

	tasks, err := task.New(task.Options{
		DataDir:       cfg.DataDir,
		FilesDirFor:   canvases.FilesPath,
		PublicBaseURL: cfg.PublicBaseURL,
		Logger:        logger,
		RetentionDays: cfg.TaskRetentionDays,
		MaxTasks:      cfg.MaxStoredTasks,
	})
	if err != nil {
		return nil, err
	}
	tasks.Load()

	uploads := upload.New(canvases, cfg.MaxUploadBytes, logger)

	preferences, err := settings.New(cfg.DataDir)
	if err != nil {
		return nil, err
	}

	speechProfiles := store.NewSpeechProfiles(store.SpeechProfilesOptions{
		File:       cfg.SpeechProfilesPath,
		RetiredDir: cfg.DataDir,
		Logger:     logger,
	})
	speechProfiles.Load()

	setupManager := setup.New(setup.Options{
		Config:        cfg,
		Registry:      registry,
		Comfy:         comfyClient,
		Logger:        logger,
		MainModelFile: mainModels.FileForWorkflow,
	})

	resources := resource.New(resource.Options{
		Config:     cfg,
		Setup:      setupManager,
		Registry:   registry,
		MainModels: mainModels,
		Logger:     logger,
	})
	resources.Init()

	hub := generate.NewHub(cfg.ComfyURL, logger)

	server := &Server{
		cfg:            cfg,
		logger:         logger,
		comfy:          comfyClient,
		hub:            hub,
		runner:         generate.NewRunner(comfyClient, hub, logger, cfg.RequestTimeoutMs, cfg.PollIntervalMs),
		mainModels:     mainModels,
		speechProfiles: speechProfiles,
		registry:       registry,
		tasks:          tasks,
		uploads:        uploads,
		canvases:       canvases,
		settings:       preferences,
		setup:          setupManager,
		resources:      resources,
		agentSessions:  agent.NewSessions(logger),
		startedAt:      time.Now(),
	}

	server.writeMCPConf()
	server.writeFirstPaintFile()
	// What happens at the end of a run: the agent that asked for it is told, as a message from the user
	// (run_notice.go). Wired before the first request, so a run cannot finish with nobody listening.
	tasks.SetOnFinish(server.onRunFinished)
	// Runs that were out when this process last stopped are still rendering: hand them back to the queue
	// before serving anything, so a restart costs the progress bar and not the work (#236).
	server.resumeInterruptedRuns()
	go server.sweepAllCanvasFiles()
	if err := server.startMCPListener(); err != nil {
		return nil, err
	}
	logger.Info("agent: MCP bridge listening on %s (static mcp.conf in %s)", server.mcpURL, cfg.AgentConfigPath)

	if cfg.ScanOnStart {
		setupManager.Start()
	}
	return server, nil
}

// Close stops what the server started that is not the main HTTP server: the bridge listener, and the agents.
//
// The agents are released here rather than left to the sockets going away. Closing stdin when this process
// exits does end them — a healthy one exits on end of input — but relying on it means the shutdown order is
// the OS's rather than ours, and an agent that is wedged (or mid-turn) would outlive the server that started
// it. `CloseAll` releases them in parallel and each release is bounded, so this returns.
func (s *Server) Close() {
	s.agentSessions.CloseAll("server stopping")
	s.closeMCP()
}

// Setup exposes the setup manager for lifecycle control.
func (s *Server) Setup() *setup.Manager { return s.setup }

// Tasks exposes the task store for lifecycle control.
func (s *Server) Tasks() *task.Store { return s.tasks }

// Handler returns the fully wrapped HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	s.routes(mux)

	// A catch-all on the mux itself keeps routing inside net/http, which is what
	// populates r.PathValue for the {id} patterns. Wrapping the mux and calling its
	// handler directly would leave those values empty.
	//
	// Only the methods and paths `GET /` does not take reach it: the canvas bundle answers a GET, and
	// everything else is a 404 in the same envelope (`web.go`, `notFound`).
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteError(w, httpx.NotFound("not_found", "Not found: "+r.Method+" "+r.URL.Path))
	})

	return httpx.Chain(
		mux,
		httpx.Recover(s.logger),
		httpx.WithRequestID(s.logger),
		httpx.CORS(s.cfg),
		httpx.Guard(s.cfg),
	)
}

// route registers a business handler and centralizes error rendering.
func (s *Server) route(mux *http.ServeMux, pattern string, handler httpx.Handler) {
	mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		ctx := &httpx.Ctx{W: w, R: r, RequestID: httpx.RequestIDOf(r), MaxFileBytes: s.cfg.MaxUploadBytes}
		if err := handler(ctx); err != nil {
			if s.writeKnownError(w, err) {
				return
			}
			httpx.WriteError(w, err)
		}
	})
}

// writeKnownError maps subsystem errors that are not httpx.Error onto the wire.
func (s *Server) writeKnownError(w http.ResponseWriter, err error) bool {
	var comfyErr *comfy.Error
	if errors.As(err, &comfyErr) {
		status := comfyErr.Status
		if status == 0 {
			status = http.StatusBadGateway
		}
		httpx.WriteError(w, httpx.NewError(status, comfyErr.Code, comfyErr.Message).WithDetails(comfyErr.Details))
		return true
	}
	var coded interface{ Code() string }
	if errors.As(err, &coded) {
		httpx.WriteError(w, httpx.NewError(http.StatusBadRequest, coded.Code(), err.Error()))
		return true
	}
	return false
}

// okJSON writes {ok:true, ...} which most admin endpoints return.
func okJSON(w http.ResponseWriter, values map[string]any) {
	payload := map[string]any{"ok": true}
	for key, value := range values {
		payload[key] = value
	}
	httpx.OK(w, payload)
}

// bodyOrEmpty returns the parsed request body, tolerating an absent body.
func bodyOrEmpty(ctx *httpx.Ctx) (map[string]any, error) {
	body, err := ctx.Body()
	if err != nil {
		return nil, err
	}
	if body == nil {
		return map[string]any{}, nil
	}
	return body, nil
}

func defaultMime(value string) string {
	if value == "" {
		return "image/png"
	}
	return value
}

// RGBA hint text that transparent output needs.
const (
	rgbaPrefix = "This is an RGBA format image with transparency."
	rgbaSuffix = "The image has an alpha channel and a transparent background."
)

// applyBackgroundPrompt wraps a prompt when the workflow supports transparency.
func applyBackgroundPrompt(text, background string, entry *workflow.Entry) string {
	if background != "transparent" || entry == nil || entry.BackgroundPrompt == "" {
		return text
	}
	trimmed := strings.TrimSpace(text)
	lowered := strings.ToLower(trimmed)
	if strings.Contains(lowered, "alpha channel") || strings.Contains(lowered, "rgba") {
		return trimmed
	}
	return strings.TrimSpace(rgbaPrefix + " " + trimmed + " " + rgbaSuffix)
}

// enrichParameters swaps optionsFrom placeholders for ComfyUI's live option lists.
func (s *Server) enrichParameters(parameters []any) []any {
	loaders := s.setup.LoaderOptions()
	out := make([]any, 0, len(parameters))
	for _, item := range parameters {
		object, ok := item.(map[string]any)
		if !ok {
			out = append(out, item)
			continue
		}
		source := strings.TrimSpace(util.StringField(object, "optionsFrom"))
		if source == "" {
			out = append(out, item)
			continue
		}
		classType := strings.SplitN(source, ".", 2)[0]
		copied := make(map[string]any, len(object)+1)
		for key, value := range object {
			copied[key] = value
		}
		options := make([]any, 0, len(loaders[classType]))
		for _, name := range loaders[classType] {
			options = append(options, name)
		}
		copied["options"] = options
		out = append(out, copied)
	}
	return out
}

// probeVideoPath reads the length of a video that is already on disk (an upload).
func (s *Server) probeVideoPath(path string) int {
	if path == "" || !util.Exists(path) {
		return 0
	}
	return s.probeVideoFile(path)
}

// probeVideoFile answers the 17k+5 frame count of one file, out of the same probe every other reader uses.
func (s *Server) probeVideoFile(temporary string) int {
	probe, err := s.probeMedia(temporary)
	if err != nil {
		// Degrading to "unknown length" is legitimate, but it must be visible: the
		// character-swap workflows silently produce the wrong duration without it.
		if errors.Is(err, exec.ErrNotFound) {
			s.logger.Warn("ffprobe is not installed; the source video length is unknown and character-swap workflows fall back to the default duration")
		} else {
			s.logger.Warn("ffprobe failed to read the video metadata: %s", err)
		}
		return 0
	}
	video, ok := videoStream(probe.Streams)
	if !ok {
		return 0
	}
	fps := rateValue(video.frameRate)
	if fps <= 0 {
		return 0
	}
	frames := int(fps*probe.Duration + 0.5)
	if frames < 1 {
		return 1
	}
	return frames
}
