package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"comfyloft/internal/logx"
	"comfyloft/internal/util"
)

/**
 * The speech servers the user configured, which of them dictation uses, and the credential each one wants.
 *
 * **Why this is the server's file and not a preference.** Speech-to-text is an OpenAI-compatible
 * `POST /v1/audio/transcriptions` on somebody else's machine — an audio.cpp server on this one, or a paid
 * provider — so a profile is a fact about a server, and its key is part of it. The preferences document
 * (`data/settings.json`) is served whole by `GET /config.js` to every browser that loads the canvas (#220) and
 * is written out as a file for a static host when the operator names `RUNTIME_CONFIG_PATH`, so a credential in
 * it would be a credential for every client and a published one for the internet. That is the rule the agent's
 * models already follow: the server holds the list, the page is shown `hasKey` and never the key (#246, #249).
 *
 * **Why it is not in `data/`.** `data/` is the directory an operator wipes to clear the task index and the locks
 * — the README calls it runtime state — so a credential typed into the panel must not live there, or a reset
 * deletes a key nobody meant to delete (#350). It is the operator's file, like the agent's `model.conf`: same
 * reason (#243, #245), the operator has one set of endpoints and keys. It sits *beside* `alayacore/` and not
 * inside it, because that directory is AlayaCore's — the server writes only `mcp.conf` there, which is a message
 * to the agent — and its `AGENT_CONFIG_PATH` moves a namespace this file does not belong to.
 *
 * **Why a list and not one server.** One address, one model name and one key is a description of one machine
 * (#239, #246) — and a workspace is used from a laptop at a desk with a local gguf on the CPU and from a
 * laptop in a café with a hosted whisper. The list makes both exist at once and one of them active; the
 * recording never changes shape, because whatever `Active` answers is what the request is sent to.
 *
 * **The list is the file.** A page sends back the whole list it is looking at, in its order, with one entry
 * added, changed or removed; an entry that is missing is a profile that was deleted. That is one write, one
 * atomic rename and one answer, and it leaves no room for a half-applied edit — the same rule `model_sync`
 * takes for the agent's models.
 *
 * **The key travels with its entry.** A page is never shown one, so an entry that arrives without a `key`
 * field says nothing about the stored one and keeps it; `""` removes it. `Set`-by-id was not needed: the list
 * *is* the state, so an id that is not in it is a key that is not stored.
 */
type SpeechProfile struct {
	ID    int    `json:"id"`
	Name  string `json:"name"`
	URL   string `json:"url"`
	Model string `json:"model"`
	Key   string `json:"key,omitempty"`
}

// Destination is where this profile's recordings are sent, as one line for the log: which profile, the address,
// the model, and whether a credential travels with it — never the credential itself.
//
// It is `agent`'s own answer to the same question (`Model`'s base URL), because these are the two places this
// server sends a request somebody else's server answers, and both are worth a line when something is slow, wrong
// or refused.
func (p SpeechProfile) Destination() string {
	parts := []string{p.URL}
	if p.Model != "" {
		parts = append(parts, "model "+p.Model)
	}
	if p.Key != "" {
		parts = append(parts, "with a key")
	}
	// A profile with no name is described by its address alone, which is what the window shows for it too — a
	// line that repeated the address as the name would read like a mistake.
	if name := strings.TrimSpace(p.Name); name != "" {
		return fmt.Sprintf("%q -> %s", name, strings.Join(parts, ", "))
	}
	return strings.Join(parts, ", ")
}

// SpeechProfileView is one profile as a page may see it: everything but the key, which a page only ever
// learns the presence of.
type SpeechProfileView struct {
	ID     int    `json:"id"`
	Name   string `json:"name"`
	URL    string `json:"url"`
	Model  string `json:"model"`
	HasKey bool   `json:"hasKey"`
}

// SpeechProfileInput is one profile as a page sent it back: no id for a new one, and no key unless there is one
// to give. A nil Key keeps the stored one; `""` removes it.
type SpeechProfileInput struct {
	ID    int
	Name  string
	URL   string
	Model string
	Key   *string
}

// SpeechProfiles is the list, which entry is active, and the file it lives in.
type SpeechProfiles struct {
	file       string
	retiredDir string
	logger     *logx.Logger
	mu         sync.RWMutex
	// profiles is in the user's order, which is the order the page shows and sends back.
	profiles []SpeechProfile
	// activeID is the profile dictation uses. It is never 0 while a profile exists: a list with nothing active
	// is a list where the microphone fails for a reason nothing on screen explains.
	activeID int
	// nextID numbers the profiles a page adds, so an id is stable for as long as the entry exists.
	nextID int
}

// SpeechProfilesOptions is where the list lives, where the files this build retired live, and the log.
type SpeechProfilesOptions struct {
	// File is the list itself, written owner-only (#350).
	File string
	// RetiredDir is `<dataDir>`, which held the list until #350 and still holds the single `speech-key.json` of
	// #246. Neither is read; both are named once in the log and neither is moved or deleted, because a
	// credential somebody typed is not this process's to delete.
	RetiredDir string
	Logger     *logx.Logger
}

// NewSpeechProfiles builds the store for the file the operator named — `<UserConfigDir>/comfyloft/speech.json`
// by default.
func NewSpeechProfiles(opts SpeechProfilesOptions) *SpeechProfiles {
	return &SpeechProfiles{file: opts.File, retiredDir: opts.RetiredDir, logger: opts.Logger, nextID: 1}
}

// SpeechProfileUnknownError reports a list that names a profile this store does not have, which is a page and a
// server disagreeing rather than a typo: refusing it is better than inventing an entry.
type SpeechProfileUnknownError struct{ ID int }

// Error implements the error interface.
func (e *SpeechProfileUnknownError) Error() string {
	return fmt.Sprintf("there is no speech profile %d", e.ID)
}

// Code returns the documented error code for the HTTP layer.
func (e *SpeechProfileUnknownError) Code() string { return "speech_profile_unknown" }

// Load reads the list. A missing file is the ordinary case — nothing configured — and says nothing.
func (s *SpeechProfiles) Load() {
	s.warnAboutRetiredFiles()
	data, err := os.ReadFile(s.file)
	if err != nil {
		if !os.IsNotExist(err) {
			s.logger.Warn("failed to read the speech profiles: %s", err)
		}
		// Said even when there is no file: "nothing is configured" is the answer a reader needs when dictation
		// refuses, and it is the same line the configured case writes.
		s.mu.RLock()
		defer s.mu.RUnlock()
		s.logActive("")
		return
	}
	var document struct {
		Profiles []SpeechProfile `json:"profiles"`
		Active   int             `json:"active"`
	}
	if err := json.Unmarshal(stripBOM(data), &document); err != nil {
		s.logger.Warn("failed to read the speech profiles: %s", err)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.install(document.Profiles, document.Active)
	s.logActive("%d profile(s) loaded; ", len(s.profiles))
}

// logActive says where dictation would go, which is the one fact about this file worth a line: a wrong address
// here is a recording sent to the wrong machine, and the panel only shows what came back.
func (s *SpeechProfiles) logActive(prefix string, args ...any) {
	if profile, ok := s.activeLocked(); ok {
		s.logger.Info("speech: "+prefix+"dictation goes to %s", append(args, profile.Destination())...)
		return
	}
	s.logger.Info("speech: "+prefix+"no profile configured, so dictation will say so", args...)
}

// warnAboutRetiredFiles says so when a file this build no longer reads is still there.
//
// Neither is read and neither is removed: a credential somebody typed is not this process's to delete. But a
// secret file nothing will ever read again should not sit in a directory unexplained — and the one in `data/`
// is a list the operator would otherwise believe is still dictation's.
func (s *SpeechProfiles) warnAboutRetiredFiles() {
	if s.retiredDir == "" {
		return
	}
	if old := filepath.Join(s.retiredDir, "speech-key.json"); fileExists(old) {
		s.logger.Info("speech: %s is no longer read — a credential now belongs to the profile that uses it", old)
	}
	if old := filepath.Join(s.retiredDir, "speech.json"); old != s.file && fileExists(old) {
		s.logger.Info("speech: %s is no longer read — the list lives in %s (move it there, this build does not)", old, s.file)
	}
}

// fileExists reports a file that is there, whatever it holds.
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// List is every profile as a page may see it, and the id of the active one (0 when there are none).
func (s *SpeechProfiles) List() ([]SpeechProfileView, int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	views := make([]SpeechProfileView, 0, len(s.profiles))
	for _, profile := range s.profiles {
		views = append(views, SpeechProfileView{ID: profile.ID, Name: profile.Name, URL: profile.URL, Model: profile.Model, HasKey: profile.Key != ""})
	}
	return views, s.activeID
}

// Active is the profile dictation uses, credential included, or false when nothing is configured.
//
// This is the one reader that gets the key, because this is the one place that puts it on a request. Nothing
// that answers a page may call it.
func (s *SpeechProfiles) Active() (SpeechProfile, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.activeLocked()
}

func (s *SpeechProfiles) activeLocked() (SpeechProfile, bool) {
	for _, profile := range s.profiles {
		if profile.ID == s.activeID {
			return profile, true
		}
	}
	return SpeechProfile{}, false
}

// Replace makes the list these entries and this entry active, and writes the file.
//
// An unknown id is refused rather than adopted: it means the page is editing a list the server no longer has,
// and the answer to that is "reload", not a second profile with the same id.
func (s *SpeechProfiles) Replace(inputs []SpeechProfileInput, active int) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	stored := make(map[int]SpeechProfile, len(s.profiles))
	for _, profile := range s.profiles {
		stored[profile.ID] = profile
	}
	profiles := make([]SpeechProfile, 0, len(inputs))
	nextID := s.nextID
	for _, input := range inputs {
		profile := SpeechProfile{Name: strings.TrimSpace(input.Name), URL: strings.TrimSpace(input.URL), Model: strings.TrimSpace(input.Model)}
		if input.ID > 0 {
			previous, known := stored[input.ID]
			if !known {
				return &SpeechProfileUnknownError{ID: input.ID}
			}
			profile.ID, profile.Key = previous.ID, previous.Key
		} else {
			profile.ID, nextID = nextID, nextID+1
		}
		if input.Key != nil {
			profile.Key = strings.TrimSpace(*input.Key)
		}
		profiles = append(profiles, profile)
	}

	// An active id that is not in the new list is the first entry: a page that just removed the active profile
	// sends the id it had, and "none active" would make the microphone fail with nothing on screen saying why.
	chosen := 0
	for _, profile := range profiles {
		if profile.ID == active {
			chosen = active
			break
		}
	}
	if chosen == 0 && len(profiles) > 0 {
		chosen = profiles[0].ID
	}

	if err := s.persist(profiles, chosen); err != nil {
		return err
	}
	before := ""
	if profile, ok := s.activeLocked(); ok {
		before = profile.Destination()
	}
	s.profiles, s.activeID, s.nextID = profiles, chosen, nextID
	// Only a change to the line is worth a line: the list is saved on every edit, and re-saving an unchanged profile
	// is not news. The name is part of it, because a reader looking for "which of these is active" needs it.
	if after, ok := s.activeLocked(); ok && after.Destination() != before {
		s.logActive("%d profile(s) saved; ", len(s.profiles))
	} else if !ok && before != "" {
		s.logActive("")
	}
	return nil
}

// persist writes the document, owner-only: it is the only file here that holds credentials.
func (s *SpeechProfiles) persist(profiles []SpeechProfile, active int) error {
	payload, err := json.MarshalIndent(map[string]any{"version": 1, "profiles": profiles, "active": active}, "", "  ")
	if err != nil {
		return fmt.Errorf("store: cannot encode the speech profiles: %w", err)
	}
	if err := util.WriteFileAtomicMode(s.file, append(payload, '\n'), 0o600); err != nil {
		return fmt.Errorf("store: cannot write %s: %w", s.file, err)
	}
	return nil
}

// install takes over a document read from disk, renumbering what cannot be an id and dropping what cannot be a
// profile. A file is somebody's to edit, and an entry with no address is an entry a request cannot be sent to.
func (s *SpeechProfiles) install(stored []SpeechProfile, active int) {
	profiles := make([]SpeechProfile, 0, len(stored))
	seen := make(map[int]bool, len(stored))
	s.nextID = 1
	for _, profile := range stored {
		profile.Name = strings.TrimSpace(profile.Name)
		profile.URL = strings.TrimSpace(profile.URL)
		profile.Model = strings.TrimSpace(profile.Model)
		profile.Key = strings.TrimSpace(profile.Key)
		if profile.URL == "" {
			continue
		}
		if profile.ID < 1 || seen[profile.ID] {
			profile.ID = s.nextID
		}
		seen[profile.ID] = true
		if profile.ID >= s.nextID {
			s.nextID = profile.ID + 1
		}
		profiles = append(profiles, profile)
	}
	s.profiles, s.activeID = profiles, active
	if _, ok := s.activeLocked(); !ok {
		s.activeID = 0
		if len(profiles) > 0 {
			s.activeID = profiles[0].ID
		}
	}
}
