package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// isolateEnv clears every variable the loader reads so tests never inherit the
// developer's shell.
func isolateEnv(t *testing.T) {
	t.Helper()
	for _, name := range []string{
		"COMFYLOFT_SERVER_PORT", "COMFYLOFT_SERVER_HOST", "COMFY_URL",
		"INSTALL_INTO_COMFY",
		"SCAN_ON_START",
		"WORKFLOW_DIR", "DATA_DIR", "CANVAS_ROOT", "PUBLIC_BASE_URL", "CORS_ORIGINS",
		"REQUEST_TIMEOUT_MS", "VIDEO_TIMEOUT_MS", "POLL_INTERVAL_MS",
		"COMFY_RETRY_ATTEMPTS", "COMFY_RETRY_DELAY_MS", "TASK_RETENTION_DAYS",
		"MAX_STORED_TASKS", "CLEANUP_INTERVAL_MS",
		"MAX_UPLOAD_BYTES", "MAX_WORKFLOW_BYTES",
		"RESOURCE_CONCURRENCY", "COMFYLOFT_SERVER_ROOT",
		"ALAYACORE_BIN", "AGENT_CONFIG_PATH", "AGENT_AUTO_SUMMARIZE", "SPEECH_PROFILES_PATH",
	} {
		t.Setenv(name, "")
	}
}

func TestDefaults(t *testing.T) {
	isolateEnv(t)
	root := t.TempDir()
	t.Setenv("COMFYLOFT_SERVER_ROOT", root)
	t.Setenv("DATA_DIR", filepath.Join(root, "data"))

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.ServerPort != 8190 || cfg.ServerHost != "127.0.0.1" {
		t.Errorf("listen = %s:%d", cfg.ServerHost, cfg.ServerPort)
	}
	if cfg.ComfyURL != "http://127.0.0.1:8188" {
		t.Errorf("ComfyURL = %q", cfg.ComfyURL)
	}
	if cfg.PublicBaseURL != "http://127.0.0.1:8190" {
		t.Errorf("PublicBaseURL = %q", cfg.PublicBaseURL)
	}
	if cfg.RequestTimeoutMs != 10*60*1000 {
		t.Errorf("RequestTimeoutMs = %d", cfg.RequestTimeoutMs)
	}
	// Video and audio are long, and they are not endless: a run nobody can end is a conversation that waits
	// for a message forever (#285). The default is hours, well past anything a card renders, and `0` still
	// means "no limit" for whoever says so on purpose.
	if cfg.VideoTimeoutMs != 3*60*60*1000 {
		t.Errorf("VideoTimeoutMs = %d, want three hours", cfg.VideoTimeoutMs)
	}
	if cfg.AudioTimeoutMs != 30*60*1000 {
		t.Errorf("AudioTimeoutMs = %d, want thirty minutes", cfg.AudioTimeoutMs)
	}
	for _, dir := range []string{cfg.WorkflowDir, cfg.DataDir, cfg.CanvasRoot} {
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			t.Errorf("directory %q was not created", dir)
		}
	}
}

// COMFYLOFT_SERVER_HOST is bound as given. A LAN address is how the workbench is reached from a phone, so there
// is no second switch to remember: the only thing the server still refuses is a wildcard CORS
// list, because that hands /v1/* to any page in the browser.
func TestNonLoopbackHostIsAccepted(t *testing.T) {
	isolateEnv(t)
	root := t.TempDir()
	t.Setenv("COMFYLOFT_SERVER_ROOT", root)
	t.Setenv("DATA_DIR", filepath.Join(root, "data"))
	t.Setenv("COMFYLOFT_SERVER_HOST", "192.168.3.232")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load with a LAN COMFYLOFT_SERVER_HOST: %v", err)
	}
	if cfg.ServerHost != "192.168.3.232" {
		t.Errorf("server host = %q", cfg.ServerHost)
	}
	if cfg.PublicBaseURL != "http://192.168.3.232:8190" {
		t.Errorf("public base url = %q, want it derived from COMFYLOFT_SERVER_HOST", cfg.PublicBaseURL)
	}
}

func TestCorsWildcardIsRejected(t *testing.T) {
	isolateEnv(t)
	root := t.TempDir()
	t.Setenv("COMFYLOFT_SERVER_ROOT", root)
	t.Setenv("DATA_DIR", filepath.Join(root, "data"))
	t.Setenv("CORS_ORIGINS", "*")

	if _, err := Load(); err == nil {
		t.Fatal("a wildcard CORS origin must be refused")
	}
}

func TestInvalidNumbersFallBack(t *testing.T) {
	isolateEnv(t)
	root := t.TempDir()
	t.Setenv("COMFYLOFT_SERVER_ROOT", root)
	t.Setenv("DATA_DIR", filepath.Join(root, "data"))
	t.Setenv("COMFYLOFT_SERVER_PORT", "not-a-number")
	t.Setenv("POLL_INTERVAL_MS", "-5")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.ServerPort != 8190 {
		t.Errorf("ServerPort = %d, want the default", cfg.ServerPort)
	}
	if cfg.PollIntervalMs != 750 {
		t.Errorf("PollIntervalMs = %d, want the default", cfg.PollIntervalMs)
	}
}

// Installs are refused unless this is set, so a typo must read as "not set" rather than
// silently enabling them.
func TestInstallIntoComfyIsOptIn(t *testing.T) {
	isolateEnv(t)
	root := t.TempDir()
	t.Setenv("COMFYLOFT_SERVER_ROOT", root)
	t.Setenv("DATA_DIR", filepath.Join(root, "data"))

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.InstallIntoComfy {
		t.Error("InstallIntoComfy is on by default; installs must be refused until stated")
	}

	for _, value := range []string{"1", "true", "TRUE", " on "} {
		t.Setenv("INSTALL_INTO_COMFY", value)
		cfg, err = Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if !cfg.InstallIntoComfy {
			t.Errorf("INSTALL_INTO_COMFY=%q was not read as true", value)
		}
	}

	for _, value := range []string{"0", "false", "nope", "", "yes please"} {
		t.Setenv("INSTALL_INTO_COMFY", value)
		cfg, err = Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if cfg.InstallIntoComfy {
			t.Errorf("INSTALL_INTO_COMFY=%q was read as true", value)
		}
	}
}

func TestCorsListParsing(t *testing.T) {
	isolateEnv(t)
	root := t.TempDir()
	t.Setenv("COMFYLOFT_SERVER_ROOT", root)
	t.Setenv("DATA_DIR", filepath.Join(root, "data"))
	t.Setenv("CORS_ORIGINS", " http://a , , http://b ")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(cfg.CorsOrigins) != 2 || cfg.CorsOrigins[0] != "http://a" || cfg.CorsOrigins[1] != "http://b" {
		t.Errorf("CorsOrigins = %v", cfg.CorsOrigins)
	}
}

func TestResolveRootDirPrefersMarker(t *testing.T) {
	// A directory is only accepted as the asset root when it contains a real marker
	// file, so a half-created tree cannot hijack the choice.
	fakeRoot := t.TempDir()
	if hasMarker(fakeRoot) {
		t.Fatal("an empty directory must not look like the asset root")
	}
	if err := os.MkdirAll(filepath.Join(fakeRoot, "workflows"), 0o755); err != nil {
		t.Fatal(err)
	}
	if hasMarker(fakeRoot) {
		t.Fatal("a bare workflows/ directory is not enough of a marker")
	}
	if err := os.WriteFile(filepath.Join(fakeRoot, "workflows", "registry.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !hasMarker(fakeRoot) {
		t.Fatal("workflows/registry.json must be recognized as the marker")
	}

	resourcesRoot := t.TempDir()
	if err := os.MkdirAll(filepath.Join(resourcesRoot, "payload"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(resourcesRoot, "resources.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !hasMarker(resourcesRoot) {
		t.Fatal("resources.json must be recognized as the marker")
	}
}

func TestIsLoopbackHost(t *testing.T) {
	for _, host := range []string{"127.0.0.1", "localhost", "::1", "[::1]", "LOCALHOST"} {
		if !IsLoopbackHost(host) {
			t.Errorf("IsLoopbackHost(%q) = false", host)
		}
	}
	for _, host := range []string{"0.0.0.0", "192.168.1.5", "example.com", ""} {
		if IsLoopbackHost(host) {
			t.Errorf("IsLoopbackHost(%q) = true", host)
		}
	}
}

// The canvas root is the workspace itself, so it is its own variable with its own default: DATA_DIR
// is the server's bookkeeping, and moving it must not move somebody's canvases with it.
func TestCanvasRootHasItsOwnDefaultAndItsOwnVariable(t *testing.T) {
	isolateEnv(t)
	root := t.TempDir()
	t.Setenv("COMFYLOFT_SERVER_ROOT", root)
	t.Setenv("DATA_DIR", filepath.Join(root, "data"))

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if want := filepath.Join(root, "canvases"); cfg.CanvasRoot != want {
		t.Errorf("CanvasRoot = %q, want %q", cfg.CanvasRoot, want)
	}

	elsewhere := filepath.Join(root, "somewhere-else")
	t.Setenv("CANVAS_ROOT", elsewhere)
	moved, err := Load()
	if err != nil {
		t.Fatalf("Load with CANVAS_ROOT: %v", err)
	}
	if moved.CanvasRoot != elsewhere {
		t.Errorf("CanvasRoot = %q, want %q", moved.CanvasRoot, elsewhere)
	}
	if info, err := os.Stat(elsewhere); err != nil || !info.IsDir() {
		t.Errorf("CANVAS_ROOT was not created: %v", err)
	}
	if moved.DataDir != cfg.DataDir {
		t.Errorf("moving the canvases moved DATA_DIR to %q", moved.DataDir)
	}
}

// The agent's directory is one place, and nothing about where the server listens is in it.
//
// It was keyed by the bind address, and the models behind it disappeared when the address changed — a fresh
// directory, the agent's placeholder model, and a 404 from whatever that placeholder pointed at (#243). It
// was then keyed by the hostname, which only made that rarer; the directory holds the operator's models and
// keys, which are the same wherever the server runs (#245).
func TestAgentDirectoryDoesNotDependOnWhereTheServerListens(t *testing.T) {
	isolateEnv(t)
	t.Setenv("COMFYLOFT_SERVER_HOST", "192.168.3.232")
	onLan, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	t.Setenv("COMFYLOFT_SERVER_HOST", "127.0.0.1")
	onLoopback, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if onLan.AgentConfigPath == "" {
		t.Fatal("no agent configuration directory")
	}
	if onLan.AgentConfigPath != onLoopback.AgentConfigPath {
		t.Fatalf("the agent directory followed the bind address: %q then %q", onLan.AgentConfigPath, onLoopback.AgentConfigPath)
	}
	// The address the agent dials still has to follow the bind — that is `mcp.conf`, written per start.
	if onLan.ServerHost == onLoopback.ServerHost {
		t.Fatalf("the bind address did not change in this test, so it proves nothing")
	}
}

// `.../comfyloft/alayacore`, and nothing between them: no machine name, no address, no port.
func TestAgentDirectoryHasNoSegmentOfItsOwn(t *testing.T) {
	isolateEnv(t)
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if want := "/comfyloft/alayacore"; !strings.HasSuffix(filepath.ToSlash(cfg.AgentConfigPath), want) {
		t.Fatalf("AgentConfigPath = %q, want it to end in %q", cfg.AgentConfigPath, want)
	}
}

// The directory is the product's, not the binary's (#146, #350), and the speech list is a file in it beside the
// agent's: one user config directory, two things that belong to the operator.
func TestSpeechProfilesSitInTheConfigDirectory(t *testing.T) {
	isolateEnv(t)
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if want := "/comfyloft/speech.json"; !strings.HasSuffix(filepath.ToSlash(cfg.SpeechProfilesPath), want) {
		t.Fatalf("SpeechProfilesPath = %q, want it to end in %q", cfg.SpeechProfilesPath, want)
	}
	if filepath.Dir(cfg.SpeechProfilesPath) != filepath.Dir(cfg.AgentConfigPath) {
		t.Fatalf("the speech list is in %q and the agent's configuration in %q, want one directory",
			filepath.Dir(cfg.SpeechProfilesPath), filepath.Dir(cfg.AgentConfigPath))
	}
	// Not in `data/`: that directory is what an operator wipes to clear the task index, and a key typed into
	// the panel must outlive it.
	if strings.HasPrefix(filepath.ToSlash(cfg.SpeechProfilesPath), filepath.ToSlash(cfg.DataDir)+"/") {
		t.Fatalf("SpeechProfilesPath = %q, want a credential out of the data directory", cfg.SpeechProfilesPath)
	}
}

// TestAutoSummarizeIsTheOperatorsNumberOrNothing: the percentage is passed through when the operator set
// one, and is off when they did not — and a number that cannot be a percentage stops the server rather
// than becoming "off", because off is invisible: an operator who mistyped 150 would get a conversation
// that silently never summarizes.
func TestAutoSummarizeIsTheOperatorsNumberOrNothing(t *testing.T) {
	for _, tc := range []struct {
		value   string
		want    int
		wantErr bool
	}{
		{value: "", want: 0},
		{value: "0", want: 0},
		{value: "65", want: 65},
		{value: "100", want: 100},
		{value: " 40 ", want: 40},
		{value: "101", wantErr: true},
		{value: "-1", wantErr: true},
		{value: "65%", wantErr: true},
		{value: "sixty", wantErr: true},
	} {
		isolateEnv(t)
		root := t.TempDir()
		t.Setenv("COMFYLOFT_SERVER_ROOT", root)
		t.Setenv("DATA_DIR", filepath.Join(root, "data"))
		t.Setenv("AGENT_AUTO_SUMMARIZE", tc.value)

		cfg, err := Load()
		switch {
		case tc.wantErr:
			if err == nil {
				t.Errorf("%q: Load succeeded with AutoSummarize = %d, want an error", tc.value, cfg.AgentAutoSummarize)
			} else if !strings.Contains(err.Error(), "AGENT_AUTO_SUMMARIZE") {
				t.Errorf("%q: error does not name the variable: %v", tc.value, err)
			}
		case err != nil:
			t.Errorf("%q: Load: %v", tc.value, err)
		case cfg.AgentAutoSummarize != tc.want:
			t.Errorf("%q: AutoSummarize = %d, want %d", tc.value, cfg.AgentAutoSummarize, tc.want)
		}
	}
}
