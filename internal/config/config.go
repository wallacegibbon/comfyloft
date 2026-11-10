// Package config turns environment variables into an immutable configuration.
//
// Every default here matches the previous Node implementation: the canvas app,
// the start script and the docs all depend on these ports and paths, so changing
// a default is effectively changing the public contract.
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Version is what /health and the startup log report.
const Version = "0.1.0"

// Config holds every runtime parameter of the server. It is treated as
// immutable after construction, so it may be shared across goroutines.
type Config struct {
	RootDir string
	// ServerHost/ServerPort are the server's own listen address, so they are named that way:
	// a bare HOST/PORT is what every other tool in an environment also sets, and picking those
	// up by accident is a real bug (a stray PORT=3000 would move the server).
	ServerPort int
	ServerHost string

	ComfyURL         string
	InstallIntoComfy bool // INSTALL_INTO_COMFY=1; installs are refused without it (internal/resource/install_policy.go)

	ScanOnStart bool

	WorkflowDir string
	DataDir     string
	// RuntimeConfigPath, when set, is where the server also writes the first-paint script as a file, for a
	// canvas published by a static host with no server in the request path (#220). It is a copy of what
	// `GET /config.js` answers; empty — the normal case — means nothing is written anywhere.
	RuntimeConfigPath string
	// WebDir, when set, is a canvas bundle this server serves itself (#219): `GET /` answers with its
	// `index.html` and any file under it. Empty means somebody else serves the canvas — a development
	// server, typically — and the server answers only `/api/*`.
	WebDir string
	// CanvasRoot is where the canvases live, one directory each. It is the workspace itself, so it
	// is named by its own variable rather than nested under DATA_DIR: data/ is the server's
	// bookkeeping (tasks, uploads), and a user who backs up their work backs up this.
	CanvasRoot string

	PublicBaseURL string
	// PublicBaseURLSet records that the operator named the address (PUBLIC_BASE_URL) instead of it being
	// derived from the bind. It is what tells the first-paint script whether the canvas is served somewhere
	// other than this server (#219): a page this server served knows its own origin, and that is the only
	// answer that stays right behind a LAN name, a phone or a reverse proxy.
	PublicBaseURLSet bool
	CorsOrigins      []string

	RequestTimeoutMs   int
	VideoTimeoutMs     int
	AudioTimeoutMs     int
	PollIntervalMs     int
	ComfyRetryAttempts int
	ComfyRetryDelayMs  int

	TaskRetentionDays int
	MaxStoredTasks    int
	CleanupIntervalMs int

	// The agent. Its own config directory holds model.conf and the skills the user installs; the
	// server names it and never reads or writes it. An empty AgentBin means "find it" (see
	// AGENT_BIN_DISCOVERY in internal/agent).
	AgentBin        string
	AgentConfigPath string
	// SpeechProfilesPath is the file the speech servers live in: an address, a model name and a credential
	// each, and which one dictation uses. It is the operator's file, not the workspace's: a key typed into
	// the panel has to outlive `rm -rf data/`, which is what that directory is for (#350).
	SpeechProfilesPath string
	// AgentAutoSummarize is AGENT_AUTO_SUMMARIZE: the share of the model's context, in percent, at which
	// AlayaCore summarizes the conversation to make room. 0 — the default, and what an unset variable
	// means — is off, and the flag is then not passed at all.
	AgentAutoSummarize int
	// AgentSkills is the container of the skills this server ships (prompts/skills), passed to the
	// agent so it can read them itself. The wording is the agent's business, not the server's.
	AgentSkills string

	MaxUploadBytes int64
	// MaxImportBytes bounds one imported canvas archive, body and unpacked bytes alike. It is its own
	// number rather than MaxUploadBytes: a canvas archive carries every picture and clip a canvas shows,
	// so it is orders of magnitude larger than one reference image.
	MaxImportBytes      int64
	MaxWorkflowBytes    int64
	ResourceConcurrency int
}

// Option overrides a single field, mirroring the old loadConfig(overrides).
type Option func(*Config)

// WithServerHost overrides the listen address.
func WithServerHost(host string) Option { return func(c *Config) { c.ServerHost = host } }

// WithComfyURL overrides the ComfyUI base URL.
func WithComfyURL(url string) Option { return func(c *Config) { c.ComfyURL = url } }

// WithWorkflowDir overrides the server workflow directory.
func WithWorkflowDir(dir string) Option { return func(c *Config) { c.WorkflowDir = dir } }

// WithAgentConfigPath overrides the agent's configuration directory.
//
// It exists for tests: without it every test server writes `mcp.conf` into the operator's real
// `<UserConfigDir>/comfyloft/alayacore`, which `make check` was doing to the developer's home directory
// (#244).
func WithAgentConfigPath(dir string) Option { return func(c *Config) { c.AgentConfigPath = dir } }

// WithSpeechProfilesPath overrides where the speech profile list lives.
//
// It exists for tests, for the same reason as WithAgentConfigPath: without it every test server would write
// a `speech.json` into the operator's real `<UserConfigDir>/comfyloft` (#244, #350).
func WithSpeechProfilesPath(path string) Option {
	return func(c *Config) { c.SpeechProfilesPath = path }
}

// WithDataDir overrides the data directory.
func WithDataDir(dir string) Option { return func(c *Config) { c.DataDir = dir } }

// WithCanvasRoot overrides the canvas root.
func WithCanvasRoot(dir string) Option { return func(c *Config) { c.CanvasRoot = dir } }

// WithRuntimeConfigPath names a file to also write the first-paint script to, or turns that off with "".
func WithRuntimeConfigPath(path string) Option { return func(c *Config) { c.RuntimeConfigPath = path } }

// WithWebDir makes the server serve a canvas bundle from `dir` (tests, and a caller that does not want to
// go through WEB_DIR). Empty leaves the canvas to whoever serves it now.
func WithWebDir(dir string) Option { return func(c *Config) { c.WebDir = dir } }

// WithoutScanOnStart disables the startup scan (tests).
func WithoutScanOnStart() Option {
	return func(c *Config) { c.ScanOnStart = false }
}

// WithRequestTimeout overrides the image generation timeout.
func WithRequestTimeout(ms int) Option { return func(c *Config) { c.RequestTimeoutMs = ms } }

// WithPollInterval overrides the history poll interval.
func WithPollInterval(ms int) Option { return func(c *Config) { c.PollIntervalMs = ms } }

// WithPublicBaseURL overrides the externally visible base URL. Naming one also tells the first-paint script
// that the canvas is served from that address rather than from this server (#219).
func WithPublicBaseURL(url string) Option {
	return func(c *Config) {
		c.PublicBaseURL = url
		c.PublicBaseURLSet = true
	}
}

// Load reads the environment, validates it, and returns the configuration.
func Load(opts ...Option) (*Config, error) {
	root := resolveRootDir()

	// Parsed before the struct literal so a number that cannot mean anything stops the server here,
	// naming the variable, rather than being rounded to "off" by the lenient int parsing the settings
	// above use — an operator who mistyped a threshold would otherwise get no summarization and no word
	// about it.
	autoSummarize, err := autoSummarizeValue(os.Getenv("AGENT_AUTO_SUMMARIZE"))
	if err != nil {
		return nil, err
	}

	cfg := &Config{
		RootDir:          root,
		ServerPort:       intValue(os.Getenv("COMFYLOFT_SERVER_PORT"), 8190),
		ServerHost:       stringOr(os.Getenv("COMFYLOFT_SERVER_HOST"), "127.0.0.1"),
		ComfyURL:         stringOr(os.Getenv("COMFY_URL"), "http://127.0.0.1:8188"),
		InstallIntoComfy: boolValue(os.Getenv("INSTALL_INTO_COMFY")),
		ScanOnStart:      os.Getenv("SCAN_ON_START") != "0",
		PublicBaseURL:    strings.TrimSpace(os.Getenv("PUBLIC_BASE_URL")),
		PublicBaseURLSet: strings.TrimSpace(os.Getenv("PUBLIC_BASE_URL")) != "",
		CorsOrigins: listValue(os.Getenv("CORS_ORIGINS"),
			"http://localhost:3000,http://127.0.0.1:3000,http://localhost:8188,http://127.0.0.1:8188"),
		RequestTimeoutMs: intValue(os.Getenv("REQUEST_TIMEOUT_MS"), 10*60*1000),
		// A long render, not an endless one: a run that never ends is a conversation that waits for a message
		// that never comes, and the ceiling is the only thing that ends a job ComfyUI is still "working on"
		// (#285). Unset takes the default; an explicit `0` still means no limit, said on purpose.
		VideoTimeoutMs:      millisOrDefault(os.Getenv("VIDEO_TIMEOUT_MS"), 3*60*60*1000),
		AudioTimeoutMs:      millisOrDefault(os.Getenv("AUDIO_TIMEOUT_MS"), 30*60*1000),
		PollIntervalMs:      intValue(os.Getenv("POLL_INTERVAL_MS"), 750),
		ComfyRetryAttempts:  intValue(os.Getenv("COMFY_RETRY_ATTEMPTS"), 3),
		ComfyRetryDelayMs:   intValue(os.Getenv("COMFY_RETRY_DELAY_MS"), 500),
		TaskRetentionDays:   countValue(os.Getenv("TASK_RETENTION_DAYS")),
		MaxStoredTasks:      countValue(os.Getenv("MAX_STORED_TASKS")),
		CleanupIntervalMs:   intValue(os.Getenv("CLEANUP_INTERVAL_MS"), 60*60*1000),
		MaxUploadBytes:      int64(intValue(os.Getenv("MAX_UPLOAD_BYTES"), 50*1024*1024)),
		MaxImportBytes:      int64Value(os.Getenv("MAX_IMPORT_BYTES"), 8<<30),
		MaxWorkflowBytes:    int64(intValue(os.Getenv("MAX_WORKFLOW_BYTES"), 5*1024*1024)),
		ResourceConcurrency: intValue(os.Getenv("RESOURCE_CONCURRENCY"), 2),
		AgentBin:            strings.TrimSpace(os.Getenv("ALAYACORE_BIN")),
		AgentConfigPath:     strings.TrimSpace(os.Getenv("AGENT_CONFIG_PATH")),
		AgentAutoSummarize:  autoSummarize,
		AgentSkills:         filepath.Join(root, "prompts", "skills"),
	}

	// The user's config directory is the product's, not the binary's: `comfyloft-server` names one of the two
	// programs here, and a directory a person opens in a file manager should say which app it belongs to
	// (#146, #350). Both files below hang off the same one.
	userConfig := ""
	if dir, err := os.UserConfigDir(); err == nil {
		userConfig = filepath.Join(dir, "comfyloft")
	}

	// The agent keeps its own configuration; the server only says where. A default under the user's
	// config directory (the platform's, not a hardcoded ~/.config) so a fresh directory is created by
	// the agent itself on first spawn.
	//
	// No per-machine segment (#245). This directory holds the operator's models and keys, which are the same
	// wherever the server runs; keying it by the bind address lost them when the address moved (#243), and
	// keying it by the hostname only made that rarer. What a segment would protect — two machines sharing one
	// home directory overwriting each other's `mcp.conf` — is a setup that needs an explicit
	// `AGENT_CONFIG_PATH` anyway.
	if cfg.AgentConfigPath == "" && userConfig != "" {
		cfg.AgentConfigPath = filepath.Join(userConfig, "alayacore")
	}

	cfg.WorkflowDir = absOrJoin(root, os.Getenv("WORKFLOW_DIR"), "workflows")
	cfg.DataDir = absOrJoin(root, os.Getenv("DATA_DIR"), "data")
	cfg.CanvasRoot = absOrJoin(root, os.Getenv("CANVAS_ROOT"), "canvases")
	// The speech list is the operator's the way the agent's models are, and for the same measured reason: a
	// credential typed into the panel must not die with `rm -rf data/`, which is what the data directory is
	// for (#350). It is a file, not a directory, because it is one list — its own variable names it.
	cfg.SpeechProfilesPath = strings.TrimSpace(os.Getenv("SPEECH_PROFILES_PATH"))
	if cfg.SpeechProfilesPath == "" {
		if userConfig != "" {
			cfg.SpeechProfilesPath = filepath.Join(userConfig, "speech.json")
		} else {
			// No home directory to speak of: the list stays with the rest of the state rather than in a path
			// this process cannot name.
			cfg.SpeechProfilesPath = filepath.Join(cfg.DataDir, "speech.json")
		}
	}
	// No default: an empty value means "no file to write", and a server run outside a served bundle
	// should not invent one.
	cfg.RuntimeConfigPath = strings.TrimSpace(os.Getenv("RUNTIME_CONFIG_PATH"))
	// No default either, and for the mirror reason: a server that guessed a bundle would answer `/` with
	// whatever an old build left there. `start.sh` names the one it built.
	cfg.WebDir = strings.TrimSpace(os.Getenv("WEB_DIR"))

	for _, opt := range opts {
		opt(cfg)
	}

	// An option may have replaced a directory, so resolve them all at the end.
	cfg.WorkflowDir = absPath(cfg.WorkflowDir)
	cfg.DataDir = absPath(cfg.DataDir)
	cfg.CanvasRoot = absPath(cfg.CanvasRoot)
	if cfg.RuntimeConfigPath != "" {
		cfg.RuntimeConfigPath = absPath(cfg.RuntimeConfigPath)
	}
	if cfg.WebDir != "" {
		cfg.WebDir = absPath(cfg.WebDir)
	}
	if cfg.SpeechProfilesPath != "" {
		cfg.SpeechProfilesPath = absPath(cfg.SpeechProfilesPath)
	}
	cfg.ComfyURL = strings.TrimRight(cfg.ComfyURL, "/")

	if cfg.PublicBaseURL == "" {
		cfg.PublicBaseURL = fmt.Sprintf("http://%s:%d", cfg.ServerHost, cfg.ServerPort)
	}
	cfg.PublicBaseURL = strings.TrimRight(cfg.PublicBaseURL, "/")

	// COMFYLOFT_SERVER_HOST is bound exactly as given: 192.168.3.232 is as much "local" as 127.0.0.1 for
	// someone who wants their phone on the same network, and a server that refuses to start
	// teaches nothing. main.go warns when the bind is reachable from the network and /api/*
	// has no token, which is the part that actually matters.
	if contains(cfg.CorsOrigins, "*") {
		return nil, fmt.Errorf("CORS_ORIGINS must not be a wildcard; list the canvas origins explicitly (a canvas served from the same host as the server is allowed automatically)")
	}

	for _, dir := range []string{cfg.WorkflowDir, cfg.DataDir, cfg.CanvasRoot} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("cannot create directory %s: %w", dir, err)
		}
	}
	return cfg, nil
}

// resolveRootDir locates the asset root: the directory holding workflows/,
// resources.json and prompts/.
//
// The old implementation used __dirname + "..", which was safe because the
// source never moved. Once this ships as a single binary that assumption dies,
// so probe COMFYLOFT_SERVER_ROOT first, then the executable's directory, then the working
// directory, accepting the first one that actually looks like the asset root.
func resolveRootDir() string {
	if explicit := strings.TrimSpace(os.Getenv("COMFYLOFT_SERVER_ROOT")); explicit != "" {
		return absPath(explicit)
	}
	// The working directory comes first: launch scripts cd into the server root,
	// and a binary sitting in bin/ must not treat bin/ as the asset root.
	var candidates []string
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, cwd)
	}
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Dir(exe))
	}
	for _, dir := range candidates {
		if hasMarker(dir) {
			return dir
		}
	}
	if len(candidates) > 0 {
		return candidates[0]
	}
	return "."
}

// hasMarker reports whether dir really is the server asset root.
//
// A bare "workflows" directory is not enough: the server creates its own workflow
// directory on startup, so a wrong guess would leave behind the very marker that
// keeps justifying it. Requiring a known file makes the check self-correcting.
func hasMarker(dir string) bool {
	if info, err := os.Stat(filepath.Join(dir, "workflows", "registry.json")); err == nil && info.Mode().IsRegular() {
		return true
	}
	if info, err := os.Stat(filepath.Join(dir, "resources.json")); err == nil && info.Mode().IsRegular() {
		return true
	}
	return false
}

// IsLoopbackHost reports whether the host name is a loopback address.
func IsLoopbackHost(host string) bool {
	switch strings.ToLower(strings.TrimSpace(host)) {
	case "127.0.0.1", "localhost", "::1", "[::1]":
		return true
	}
	return false
}

func absOrJoin(root, value, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return filepath.Join(root, fallback)
	}
	return value
}

func absPath(value string) string {
	if value == "" {
		return ""
	}
	if abs, err := filepath.Abs(value); err == nil {
		return abs
	}
	return value
}

func stringOr(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

// intValue mirrors the old num(): a positive integer, otherwise the fallback.
// autoSummarizeValue reads AGENT_AUTO_SUMMARIZE: 0 or unset (off), or 1-100 (the threshold percentage).
//
// Stricter than the numbers above it on purpose. Those have a working default to fall back to, so a
// mistyped value costs a setting the operator can see is still the default; this one's default is off,
// which looks exactly like a model that never filled up. AlayaCore refuses an out-of-range threshold for
// the same reason (its own `validate.go`), and there is no point in the server accepting a number the
// agent will reject a second later at spawn.
func autoSummarizeValue(value string) (int, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("AGENT_AUTO_SUMMARIZE must be a whole percentage, got %q", value)
	}
	if parsed < 0 || parsed > 100 {
		return 0, fmt.Errorf("AGENT_AUTO_SUMMARIZE must be 0 (off) or 1-100 (a threshold percentage), got %d", parsed)
	}
	return parsed, nil
}

func intValue(value string, fallback int) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

// int64Value reads a byte count that does not fit an int on every build (a canvas archive can be
// gigabytes), falling back when the value is unusable.
func int64Value(value string, fallback int64) int64 {
	parsed, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

// intOrZero allows zero, e.g. VIDEO_TIMEOUT_MS=0 means "no timeout".
func intOrZero(value string) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed < 0 {
		return 0
	}
	return parsed
}

// millisOrDefault reads a millisecond budget that may be unset (the default), a number, or an explicit `0`
// for "no limit". A render's ceiling is the one timeout where zero is a real answer and "unset" is not the
// same as zero: video and audio have a default because a run nobody ends never reports back (#285), and an
// operator who wants the old unbounded wait says so.
func millisOrDefault(value string, fallback int) int {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return intOrZero(value)
}

// countValue mirrors the old count(): zero is valid.
func countValue(value string) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed < 0 {
		return 0
	}
	return parsed
}

// boolValue reads an opt-in flag. Anything that is not an accepted spelling is false, which
// is the safe direction here: INSTALL_INTO_COMFY gates a refusal, and a typo must not
// silently enable installs on a host that cannot reach ComfyUI's model folders.
func boolValue(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

func listValue(value, fallback string) []string {
	raw := value
	if strings.TrimSpace(raw) == "" {
		raw = fallback
	}
	var out []string
	for _, item := range strings.Split(raw, ",") {
		if trimmed := strings.TrimSpace(item); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func contains(items []string, target string) bool {
	for _, item := range items {
		if item == target {
			return true
		}
	}
	return false
}
