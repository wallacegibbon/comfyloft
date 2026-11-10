package store

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"comfyloft/internal/logx"
)

func quietLogger() *logx.Logger { return logx.NewWithWriter("test", os.Stderr) }

func TestMainModelsPerPackAndWorkflow(t *testing.T) {
	dir := t.TempDir()
	models := NewMainModels(dir, quietLogger())
	models.Load()

	if err := models.Set("moss", "moss_balanced.safetensors", []string{"image-moss-sft-8step"}); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if got := models.FileForPack("moss"); got != "moss_balanced.safetensors" {
		t.Errorf("FileForPack = %q", got)
	}
	// The pack-level choice is the fallback for its workflows.
	if got := models.FileForWorkflow("image-moss-sft-8step"); got != "moss_balanced.safetensors" {
		t.Errorf("FileForWorkflow = %q", got)
	}

	// A workflow-scoped override wins and can also mean "use the authored default".
	if err := models.SetForWorkflow("image-z-image-turbo", "zit_fp8.safetensors"); err != nil {
		t.Fatalf("SetForWorkflow: %v", err)
	}
	if got := models.FileForWorkflow("image-z-image-turbo"); got != "zit_fp8.safetensors" {
		t.Errorf("override = %q", got)
	}
	if err := models.SetForWorkflow("image-z-image-turbo", ""); err != nil {
		t.Fatalf("clear override: %v", err)
	}
	if got := models.FileForWorkflow("image-z-image-turbo"); got != "" {
		t.Errorf("cleared override = %q, want empty", got)
	}

	reloaded := NewMainModels(dir, quietLogger())
	reloaded.Load()
	if got := reloaded.FileForPack("moss"); got != "moss_balanced.safetensors" {
		t.Errorf("pack selection did not persist: %q", got)
	}
}

func TestMainModelsErrors(t *testing.T) {
	models := NewMainModels(t.TempDir(), quietLogger())
	models.Load()

	if err := models.Set("", "f", nil); err == nil {
		t.Error("expected an error for a missing pack id")
	}
	if err := models.SetForWorkflow("", "f"); err == nil {
		t.Error("expected an error for a missing workflow id")
	}
	if err := models.SetForWorkflow("wf", ""); err != nil {
		t.Errorf("clearing an override should be allowed: %v", err)
	}
}

func TestStripBOM(t *testing.T) {
	withBOM := []byte{0xEF, 0xBB, 0xBF, 'h', 'i'}
	if got := string(stripBOM(withBOM)); got != "hi" {
		t.Errorf("stripBOM = %q", got)
	}
	without := []byte("hi")
	if got := string(stripBOM(without)); got != "hi" {
		t.Errorf("stripBOM mutated a clean payload: %q", got)
	}
}

// A speech profile list is somebody's file, so what is read out of it has to be usable: an entry with no address
// is an entry no request can be sent to, and ids that collide or are missing are renumbered rather than trusted.
func TestSpeechProfilesLoadRepairsWhatTheFileSays(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "speech.json")
	document := `{"version":1,"active":99,"profiles":[
	  {"id":3,"name":" one ","url":"http://127.0.0.1:1/v1/audio/transcriptions","model":" refine ","key":" sk-test "},
	  {"id":3,"name":"two","url":"http://127.0.0.1:2/v1/audio/transcriptions"},
	  {"id":0,"name":"three","url":"http://127.0.0.1:3/v1/audio/transcriptions"},
	  {"id":4,"name":"nowhere","url":"  "}
	]}`
	if err := os.WriteFile(file, []byte(document), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	profiles := speechStore(dir, quietLogger())
	profiles.Load()
	views, active := profiles.List()
	if len(views) != 3 {
		t.Fatalf("loaded %d profiles, want the three with an address", len(views))
	}
	seen := map[int]bool{}
	for index, view := range views {
		if view.ID < 1 || seen[view.ID] {
			t.Errorf("profile %d has id %d, want an id of its own", index, view.ID)
		}
		seen[view.ID] = true
	}
	if views[0].Name != "one" || views[0].Model != "refine" || !views[0].HasKey {
		t.Errorf("first profile = %+v, want it trimmed with its key", views[0])
	}
	// An active id naming nothing is the first profile: a list with nothing active is a microphone that fails
	// with nothing on screen explaining it.
	if active != views[0].ID {
		t.Errorf("active = %d, want the first profile %d", active, views[0].ID)
	}
	if profile, ok := profiles.Active(); !ok || profile.Key != "sk-test" || profile.ID != views[0].ID {
		t.Errorf("Active = %+v/%v, want the first profile with its key", profile, ok)
	}
}

// A page adding a profile after the file was written gets an id no other profile has, and the next one gets a
// different one — even when the page sends the list back unchanged in between.
func TestSpeechProfilesNumberNewEntriesAfterTheHighestID(t *testing.T) {
	dir := t.TempDir()
	profiles := speechStore(dir, quietLogger())
	profiles.Load()

	first := SpeechProfileInput{URL: "http://127.0.0.1:1/v1/audio/transcriptions"}
	if err := profiles.Replace([]SpeechProfileInput{first}, 0); err != nil {
		t.Fatalf("first Replace: %v", err)
	}
	views, _ := profiles.List()
	kept := SpeechProfileInput{ID: views[0].ID, URL: views[0].URL}
	second := SpeechProfileInput{URL: "http://127.0.0.1:2/v1/audio/transcriptions"}
	if err := profiles.Replace([]SpeechProfileInput{kept, second}, 0); err != nil {
		t.Fatalf("second Replace: %v", err)
	}
	views, _ = profiles.List()
	if len(views) != 2 || views[0].ID == views[1].ID {
		t.Fatalf("ids after adding a second profile: %+v", views)
	}

	// A restart reads the ids back, and the next addition still does not reuse one.
	reloaded := speechStore(dir, quietLogger())
	reloaded.Load()
	views, _ = reloaded.List()
	third := SpeechProfileInput{URL: "http://127.0.0.1:3/v1/audio/transcriptions"}
	if err := reloaded.Replace([]SpeechProfileInput{{ID: views[0].ID, URL: views[0].URL}, {ID: views[1].ID, URL: views[1].URL}, third}, 0); err != nil {
		t.Fatalf("third Replace: %v", err)
	}
	views, _ = reloaded.List()
	seen := map[int]bool{}
	for _, view := range views {
		if seen[view.ID] {
			t.Errorf("id %d was reused for %q", view.ID, view.Name)
		}
		seen[view.ID] = true
	}
}

// speechStore is the store a test reads and writes: the list is a file of its own (#350), and the directory the
// retired files live in is left as whatever the caller made it, so one test's leftovers are another's subject.
func speechStore(dir string, logger *logx.Logger) *SpeechProfiles {
	return NewSpeechProfiles(SpeechProfilesOptions{File: filepath.Join(dir, "speech.json"), Logger: logger})
}

// The list moved out of `data/` (#350), so the file that is still there is not read — and a reader who finds a
// profile list in the directory they thought dictation used has to be told, once, where the real one is.
func TestSpeechProfilesDoNotReadTheRetiredDataFile(t *testing.T) {
	root := t.TempDir()
	dataDir, configDir := filepath.Join(root, "data"), filepath.Join(root, "config")
	for _, dir := range []string{dataDir, configDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	retired := filepath.Join(dataDir, "speech.json")
	if err := os.WriteFile(retired, []byte(`{"version":1,"active":1,"profiles":[
	  {"id":1,"name":"old","url":"http://127.0.0.1:1/v1/audio/transcriptions","key":"sk-old"}
	]}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	buffer := &bytes.Buffer{}
	profiles := NewSpeechProfiles(SpeechProfilesOptions{
		File:       filepath.Join(configDir, "speech.json"),
		RetiredDir: dataDir,
		Logger:     logx.NewWithWriter("test", buffer),
	})
	profiles.Load()

	if views, active := profiles.List(); len(views) != 0 || active != 0 {
		t.Errorf("List = %+v/%d, want the retired file left alone", views, active)
	}
	line := buffer.String()
	if !strings.Contains(line, retired) || !strings.Contains(line, filepath.Join(configDir, "speech.json")) {
		t.Errorf("log = %q, want the retired file and where the list lives now", line)
	}
	// The retired key is on disk and never in the log — the same rule the live file follows (#255).
	if strings.Contains(line, "sk-old") {
		t.Errorf("log = %q, carries the retired key", line)
	}
	// Nothing was written to the new path either: the operator moves the file, this build does not.
	if _, err := os.Stat(filepath.Join(configDir, "speech.json")); !os.IsNotExist(err) {
		t.Errorf("the list was created at %s, want only a line about the file to move", filepath.Join(configDir, "speech.json"))
	}
}

// Which server the audio goes to is the one fact about this file worth a line, and the credential must not be in
// it: the log is a file somebody pastes into an issue (#255).
func TestSpeechProfilesSayWhereDictationGoes(t *testing.T) {
	buffer := &bytes.Buffer{}
	key := "sk-test"
	profiles := speechStore(t.TempDir(), logx.NewWithWriter("test", buffer))

	// Nothing configured yet: the line says so rather than saying nothing, because the panel's refusal ("no speech
	// server is configured") is what a reader will be looking at.
	profiles.Load()
	if !strings.Contains(buffer.String(), "speech: no profile configured") {
		t.Errorf("log = %q, want it to say nothing is configured", buffer.String())
	}

	buffer.Reset()
	if err := profiles.Replace([]SpeechProfileInput{{
		Name:  "Local audio.cpp",
		URL:   "http://127.0.0.1:18080/v1/audio/transcriptions",
		Model: "refine",
		Key:   &key,
	}}, 0); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	line := buffer.String()
	for _, want := range []string{"dictation goes to", `"Local audio.cpp"`, "http://127.0.0.1:18080/v1/audio/transcriptions", "model refine", "with a key"} {
		if !strings.Contains(line, want) {
			t.Errorf("log = %q, want it to contain %q", line, want)
		}
	}
	if strings.Contains(line, key) {
		t.Errorf("log = %q, carries the key itself", line)
	}

	// Switching which profile is active is the case the whole feature exists for, so it is a line.
	buffer.Reset()
	other := "https://api.openai.com/v1/audio/transcriptions"
	if err := profiles.Replace([]SpeechProfileInput{
		{ID: 1, URL: "http://127.0.0.1:18080/v1/audio/transcriptions", Model: "refine"},
		{Name: "OpenAI", URL: other, Model: "whisper-1"},
	}, 2); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if !strings.Contains(buffer.String(), other) {
		t.Errorf("log = %q, want the newly active address", buffer.String())
	}

	// Re-saving the same list is not news.
	buffer.Reset()
	if err := profiles.Replace([]SpeechProfileInput{
		{ID: 1, URL: "http://127.0.0.1:18080/v1/audio/transcriptions", Model: "refine"},
		{ID: 2, Name: "OpenAI", URL: other, Model: "whisper-1"},
	}, 2); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if buffer.Len() != 0 {
		t.Errorf("log = %q, want no line when nothing moved", buffer.String())
	}
}
