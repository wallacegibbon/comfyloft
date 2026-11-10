package server

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"comfyloft/internal/httpx"
)

/**
 * The hop to the speech server, and the list of servers it can be sent to.
 *
 * What is worth asserting here is invisible from the outside: that the recording goes to the *active* profile
 * and nowhere else, that the model and the credential on that request are the profile's rather than anything
 * the page said, that the list is written owner-only and no key is ever in an answer, and that a refusal is
 * passed on in the speech server's own words rather than being translated into something vaguer.
 */

// speechAnswer is what the fake speech server makes of one request.
type speechAnswer struct {
	path     string
	model    string
	language string
	auth     string
	key      string
	audio    []byte
	url      string
	filename string
	hits     atomic.Int32
}

// fakeSpeech starts a stand-in for the OpenAI-compatible endpoint. `reply` writes the answer.
func fakeSpeech(t *testing.T, got *speechAnswer, reply func(w http.ResponseWriter)) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got != nil {
			got.hits.Add(1)
		}
		form, err := httpx.ParseMultipart(r, 0)
		if err != nil {
			t.Errorf("the forwarded request is not multipart: %v", err)
			http.Error(w, "not multipart", http.StatusBadRequest)
			return
		}
		if got != nil {
			got.path = r.URL.Path
			got.model = firstValue(form.Values, "model")
			got.language = firstValue(form.Values, "language")
			got.auth = r.Header.Get("Authorization")
			got.key = firstValue(form.Values, "key")
			got.url = firstValue(form.Values, "url")
			if len(form.Files) > 0 {
				got.audio = form.Files[0].Bytes
				got.filename = form.Files[0].Filename
			}
		}
		reply(w)
	}))
}

// speechPost sends one recording through the server.
func speechPost(t *testing.T, server *httptest.Server, fields map[string]string, audio []byte) (int, map[string]any) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for name, value := range fields {
		if err := writer.WriteField(name, value); err != nil {
			t.Fatalf("write field %s: %v", name, err)
		}
	}
	if audio != nil {
		part, err := writer.CreateFormFile("file", "speech.wav")
		if err != nil {
			t.Fatalf("create file part: %v", err)
		}
		if _, err := part.Write(audio); err != nil {
			t.Fatalf("write audio: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	request, err := http.NewRequest(http.MethodPost, server.URL+"/api/speech/transcriptions", &body)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatalf("post speech: %v", err)
	}
	defer response.Body.Close()
	var decoded map[string]any
	_ = json.NewDecoder(response.Body).Decode(&decoded)
	return response.StatusCode, decoded
}

// profilesGet reads GET /api/speech/profiles.
func profilesGet(t *testing.T, server *httptest.Server) (int, map[string]any) {
	t.Helper()
	response, err := server.Client().Get(server.URL + "/api/speech/profiles")
	if err != nil {
		t.Fatalf("get speech profiles: %v", err)
	}
	defer response.Body.Close()
	var decoded map[string]any
	_ = json.NewDecoder(response.Body).Decode(&decoded)
	return response.StatusCode, decoded
}

// profilesPut writes PUT /api/speech/profiles.
func profilesPut(t *testing.T, server *httptest.Server, body map[string]any) (int, map[string]any) {
	t.Helper()
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	request, err := http.NewRequest(http.MethodPut, server.URL+"/api/speech/profiles", bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatalf("put speech profiles: %v", err)
	}
	defer response.Body.Close()
	var decoded map[string]any
	_ = json.NewDecoder(response.Body).Decode(&decoded)
	return response.StatusCode, decoded
}

// profilesOf reads the `profiles` array of an answer.
func profilesOf(t *testing.T, payload map[string]any) []map[string]any {
	t.Helper()
	raw, ok := payload["profiles"].([]any)
	if !ok {
		t.Fatalf("the answer carries no profiles list: %v", payload)
	}
	out := make([]map[string]any, 0, len(raw))
	for _, entry := range raw {
		object, ok := entry.(map[string]any)
		if !ok {
			t.Fatalf("a profile is not an object: %v", entry)
		}
		out = append(out, object)
	}
	return out
}

// configure stores one profile pointing at `address` and makes it active, answering its id.
func configure(t *testing.T, server *httptest.Server, address, model, key string) int {
	t.Helper()
	profile := map[string]any{"name": "Test", "url": address, "model": model}
	if key != "" {
		profile["key"] = key
	}
	status, payload := profilesPut(t, server, map[string]any{"profiles": []any{profile}})
	if status != http.StatusOK {
		t.Fatalf("configure status = %d, want 200: %v", status, payload)
	}
	profiles := profilesOf(t, payload)
	if len(profiles) != 1 {
		t.Fatalf("configure left %d profiles, want 1", len(profiles))
	}
	return int(profiles[0]["id"].(float64))
}

func TestSpeechSendsTheRecordingToTheActiveProfile(t *testing.T) {
	var active, other speechAnswer
	speech := fakeSpeech(t, &active, func(w http.ResponseWriter) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"text":   "帮我画一只猫",
			"timing": map[string]any{"wall_ms": 271.5, "audio_duration_ms": 1000, "rtf": 0.2715},
		})
	})
	defer speech.Close()
	elsewhere := fakeSpeech(t, &other, func(w http.ResponseWriter) {
		_ = json.NewEncoder(w).Encode(map[string]any{"text": "wrong server"})
	})
	defer elsewhere.Close()

	httpServer := httptest.NewServer(newTestServer(t, newFakeComfy(t)).Handler())
	defer httpServer.Close()

	// Two profiles, the second one active: the interesting failure is sending to the wrong one.
	status, payload := profilesPut(t, httpServer, map[string]any{"profiles": []any{
		map[string]any{"name": "Elsewhere", "url": elsewhere.URL + "/v1/audio/transcriptions", "model": "refine"},
		map[string]any{"name": "Active", "url": speech.URL + "/v1/audio/transcriptions", "model": "whisper-1", "key": "sk-profile"},
	}})
	if status != http.StatusOK {
		t.Fatalf("profiles status = %d, want 200: %v", status, payload)
	}
	profiles := profilesOf(t, payload)
	activeID := profiles[1]["id"].(float64)
	status, payload = profilesPut(t, httpServer, map[string]any{"profiles": profiles, "active": activeID})
	if status != http.StatusOK || payload["active"] != activeID {
		t.Fatalf("activating answered %d/%v, want 200 with active=%v", status, payload["active"], activeID)
	}

	audio := []byte("RIFF\x24\x00\x00\x00WAVEfmt " + string(make([]byte, 16)))
	// The page names a model, a key and an address of its own: none of them may reach the speech server, which
	// is sent the profile's model instead. A route that forwarded the form would pass all three through.
	status, payload = speechPost(t, httpServer, map[string]string{
		"language": "zh",
		"model":    "not-the-profiles-model",
		"key":      "sk-from-the-page",
		"url":      elsewhere.URL,
	}, audio)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %v", status, payload)
	}
	if payload["text"] != "帮我画一只猫" {
		t.Errorf("text = %v, want the speech server's transcript", payload["text"])
	}

	if got := active.hits.Load(); got != 1 {
		t.Fatalf("the active profile was called %d times, want 1", got)
	}
	if got := other.hits.Load(); got != 0 {
		t.Errorf("the inactive profile was called %d times, want 0", got)
	}
	if active.path != "/v1/audio/transcriptions" {
		t.Errorf("path = %q, want /v1/audio/transcriptions", active.path)
	}
	if active.model != "whisper-1" {
		t.Errorf("model = %q, want the profile's whisper-1", active.model)
	}
	if active.language != "zh" {
		t.Errorf("language = %q, want the page's hint", active.language)
	}
	if !bytes.Equal(active.audio, audio) {
		t.Errorf("the audio arrived as %d bytes, want the %d that were sent", len(active.audio), len(audio))
	}
	if active.filename != "speech.wav" {
		t.Errorf("filename = %q, want speech.wav", active.filename)
	}
	// The credential comes from the profile and from nowhere else, and it is a header: the protocol has no
	// field by that name, and OpenAI refuses a field it does not know.
	if active.auth != "Bearer sk-profile" {
		t.Errorf("Authorization = %q, want the profile's key as a Bearer token", active.auth)
	}
	if active.key != "" {
		t.Errorf("the forwarded request carries key = %q, want it dropped", active.key)
	}
	if active.url != "" {
		t.Errorf("the forwarded request carries url = %q, want it dropped", active.url)
	}
}

// A profile with no key is a server that wants none: an `Authorization` header invented on behalf of a key that
// does not exist is a header the user never asked for.
func TestSpeechInvitesNoCredentialWhenTheProfileHasNone(t *testing.T) {
	var got speechAnswer
	speech := fakeSpeech(t, &got, func(w http.ResponseWriter) {
		_ = json.NewEncoder(w).Encode(map[string]any{"text": "你好"})
	})
	defer speech.Close()

	server := httptest.NewServer(newTestServer(t, newFakeComfy(t)).Handler())
	defer server.Close()

	configure(t, server, speech.URL+"/v1/audio/transcriptions", "refine", "")
	status, payload := speechPost(t, server, map[string]string{"language": "en"}, []byte("RIFF"))
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %v", status, payload)
	}
	if got.auth != "" {
		t.Errorf("Authorization = %q, want no header at all", got.auth)
	}
}

// A model the profile leaves blank is no field at all: `model` is required by the protocol, and a server that
// wants one says so in its own words. A name invented here would be worse than the silence.
func TestSpeechSendsNoModelWhenTheProfileNamesNone(t *testing.T) {
	var got speechAnswer
	speech := fakeSpeech(t, &got, func(w http.ResponseWriter) {
		_ = json.NewEncoder(w).Encode(map[string]any{"text": ""})
	})
	defer speech.Close()

	server := httptest.NewServer(newTestServer(t, newFakeComfy(t)).Handler())
	defer server.Close()

	configure(t, server, speech.URL+"/v1/audio/transcriptions", "", "")
	status, payload := speechPost(t, server, map[string]string{"language": "en"}, []byte("RIFF"))
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %v", status, payload)
	}
	if got.model != "" {
		t.Errorf("model = %q, want no model field", got.model)
	}
}

// Nothing configured is a 400 with a sentence rather than a 502 from a dial to the empty string, and it says
// where a server is added.
func TestSpeechRefusesWhenNoProfileIsConfigured(t *testing.T) {
	server := httptest.NewServer(newTestServer(t, newFakeComfy(t)).Handler())
	defer server.Close()

	status, payload := speechPost(t, server, map[string]string{"language": "zh"}, []byte("RIFF"))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %v", status, payload)
	}
	failure, _ := payload["error"].(map[string]any)
	if failure["code"] != "speech_profile_missing" {
		t.Errorf("code = %v, want speech_profile_missing", failure["code"])
	}
}

func TestSpeechRefusesWhatItCannotSend(t *testing.T) {
	server := httptest.NewServer(newTestServer(t, newFakeComfy(t)).Handler())
	defer server.Close()

	cases := []struct {
		name   string
		fields map[string]string
		audio  []byte
		code   string
	}{
		{"no audio", map[string]string{}, nil, "speech_no_audio"},
		{"no address", nil, []byte("RIFF"), "speech_address_missing"},
		{"not an http address", nil, []byte("RIFF"), "speech_address_invalid"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			// A profile is configured for every case but the first: "no address" is a list that cannot be
			// stored, so the address cases rewrite the list before posting.
			switch testCase.code {
			case "speech_address_missing":
				status, payload := profilesPut(t, server, map[string]any{"profiles": []any{map[string]any{"url": "  ", "model": "refine"}}})
				if status != http.StatusBadRequest {
					t.Fatalf("storing a profile with no address answered %d, want 400: %v", status, payload)
				}
				failure, _ := payload["error"].(map[string]any)
				if failure["code"] != testCase.code {
					t.Errorf("code = %v, want %s", failure["code"], testCase.code)
				}
				return
			case "speech_address_invalid":
				status, payload := profilesPut(t, server, map[string]any{"profiles": []any{map[string]any{"url": "ftp://127.0.0.1:18080/v1/audio/transcriptions"}}})
				if status != http.StatusBadRequest {
					t.Fatalf("storing an ftp profile answered %d, want 400: %v", status, payload)
				}
				failure, _ := payload["error"].(map[string]any)
				if failure["code"] != testCase.code {
					t.Errorf("code = %v, want %s", failure["code"], testCase.code)
				}
				return
			}
			status, payload := speechPost(t, server, testCase.fields, testCase.audio)
			if status != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400: %v", status, payload)
			}
			failure, _ := payload["error"].(map[string]any)
			if failure["code"] != testCase.code {
				t.Errorf("code = %v, want %s", failure["code"], testCase.code)
			}
		})
	}
}

// 401, 413 and 429 are three different things to the person reading the panel — a wrong key, a recording that
// is too long, and a provider asking for less traffic — and a 400 for all three says none of them.
func TestSpeechKeepsTheStatusThatSaysWhatWentWrong(t *testing.T) {
	cases := []struct {
		name   string
		status int
		want   int
	}{
		{"the key was refused", http.StatusUnauthorized, http.StatusUnauthorized},
		{"the recording is too long", http.StatusRequestEntityTooLarge, http.StatusRequestEntityTooLarge},
		{"too fast", http.StatusTooManyRequests, http.StatusTooManyRequests},
		{"the far side is broken", http.StatusInternalServerError, http.StatusBadGateway},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			speech := fakeSpeech(t, nil, func(w http.ResponseWriter) {
				w.WriteHeader(testCase.status)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"error": map[string]any{"message": "Incorrect API key provided"},
				})
			})
			defer speech.Close()

			server := httptest.NewServer(newTestServer(t, newFakeComfy(t)).Handler())
			defer server.Close()

			configure(t, server, speech.URL, "whisper-1", "sk-test")
			status, payload := speechPost(t, server, map[string]string{"language": "zh"}, []byte("RIFF"))
			if status != testCase.want {
				t.Fatalf("status = %d, want %d: %v", status, testCase.want, payload)
			}
			failure, _ := payload["error"].(map[string]any)
			if failure["message"] != "Incorrect API key provided" {
				t.Errorf("message = %v, want the speech server's own sentence", failure["message"])
			}
		})
	}
}

func TestSpeechPassesOnWhyTheServerRefused(t *testing.T) {
	speech := fakeSpeech(t, nil, func(w http.ResponseWriter) {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{"message": "only WAV audio uploads are currently supported for transcription"},
		})
	})
	defer speech.Close()

	server := httptest.NewServer(newTestServer(t, newFakeComfy(t)).Handler())
	defer server.Close()

	configure(t, server, speech.URL, "refine", "")
	status, payload := speechPost(t, server, nil, []byte("not a wav"))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", status)
	}
	// Word for word: it names the thing to change, and this route has nothing better to say.
	failure, _ := payload["error"].(map[string]any)
	if failure["message"] != "only WAV audio uploads are currently supported for transcription" {
		t.Errorf("message = %v, want the speech server's own sentence", failure["message"])
	}
}

// An address that nothing is listening on is the likely failure of a hand-typed port, and the sentence has to
// carry the address: "could not reach anything" leaves the user looking at the wrong setting.
func TestSpeechSaysWhichAddressItCouldNotReach(t *testing.T) {
	server := httptest.NewServer(newTestServer(t, newFakeComfy(t)).Handler())
	defer server.Close()

	// A closed port: opened and closed here, so it is a real refusal rather than a slow dial.
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	address := dead.URL + "/v1/audio/transcriptions"
	dead.Close()

	configure(t, server, address, "refine", "")
	status, payload := speechPost(t, server, nil, []byte("RIFF"))
	if status != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502: %v", status, payload)
	}
	failure, _ := payload["error"].(map[string]any)
	message, _ := failure["message"].(string)
	if !strings.Contains(message, address) {
		t.Errorf("message = %q, want it to name %s", message, address)
	}
}

// The list is the file: it is written owner-only, the answer says whether each profile has a key and never the
// key itself, an entry that arrives without a key field keeps the stored one, and `""` removes it.
//
// The key must not travel to a page: `data/settings.json` is served to every browser that loads the canvas, so a
// key there would be a key for anyone who can reach the server (#246). The rule is now per profile (#252).
func TestSpeechProfilesAreStoredOnDiskAndNeverSentBack(t *testing.T) {
	server := newTestServer(t, newFakeComfy(t))
	httpServer := httptest.NewServer(server.Handler())
	defer httpServer.Close()

	status, payload := profilesGet(t, httpServer)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %v", status, payload)
	}
	if profiles := profilesOf(t, payload); len(profiles) != 0 {
		t.Fatalf("a fresh server lists %d profiles, want none", len(profiles))
	}
	if payload["active"] != float64(0) {
		t.Errorf("active = %v, want 0 when nothing is configured", payload["active"])
	}

	status, payload = profilesPut(t, httpServer, map[string]any{"profiles": []any{
		map[string]any{"name": "  Local  ", "url": "http://127.0.0.1:18080/v1/audio/transcriptions", "model": " refine ", "key": "  sk-test  "},
	}})
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %v", status, payload)
	}
	profiles := profilesOf(t, payload)
	if len(profiles) != 1 {
		t.Fatalf("%d profiles after storing one, want 1", len(profiles))
	}
	first := profiles[0]
	// The first profile of a list is active without being asked: a list with nothing active is a list where
	// dictation fails with nothing on screen explaining it.
	if payload["active"] != first["id"] {
		t.Errorf("active = %v, want the only profile's id %v", payload["active"], first["id"])
	}
	id := int(first["id"].(float64))
	if first["name"] != "Local" || first["model"] != "refine" {
		t.Errorf("name/model = %v/%v, want them trimmed to Local/refine", first["name"], first["model"])
	}
	if first["hasKey"] != true {
		t.Errorf("hasKey = %v, want true", first["hasKey"])
	}

	file := server.cfg.SpeechProfilesPath
	info, err := os.Stat(file)
	if err != nil {
		t.Fatalf("the list was not written to %s: %v", file, err)
	}
	// Owner-only: a task index that only its owner can read is a workspace somebody cannot copy; a credential
	// that a second account can read is a credential that has leaked.
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("file mode = %o, want 600", mode)
	}
	// The key is on disk — that is the point of storing it — and never in an answer.
	if stored, err := os.ReadFile(file); err != nil || !strings.Contains(string(stored), "sk-test") {
		t.Errorf("the key is not in %s (%v): %s", file, err, stored)
	}

	status, payload = profilesGet(t, httpServer)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %v", status, payload)
	}
	if profiles := profilesOf(t, payload); profiles[0]["hasKey"] != true {
		t.Errorf("hasKey = %v after a stored key, want true", profiles[0]["hasKey"])
	}
	if leaked := findString(payload, "sk-test"); leaked != "" {
		t.Errorf("an answer carries the key in %q", leaked)
	}

	// An entry the page sends back without a key field is the page saying nothing about it, which is how a
	// stored key survives an edit to the address.
	status, payload = profilesPut(t, httpServer, map[string]any{"profiles": []any{
		map[string]any{"id": id, "name": "Local", "url": "http://127.0.0.1:18080/v1/audio/transcriptions", "model": "refine"},
	}})
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %v", status, payload)
	}
	if profiles := profilesOf(t, payload); profiles[0]["hasKey"] != true {
		t.Errorf("hasKey = %v after an edit that said nothing about the key, want true", profiles[0]["hasKey"])
	}
	if stored, _ := os.ReadFile(file); !strings.Contains(string(stored), "sk-test") {
		t.Errorf("the stored key was dropped by an edit that did not mention it: %s", stored)
	}

	// A blank key is a clear, spelled as one.
	status, payload = profilesPut(t, httpServer, map[string]any{"profiles": []any{
		map[string]any{"id": id, "name": "Local", "url": "http://127.0.0.1:18080/v1/audio/transcriptions", "model": "refine", "key": ""},
	}})
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %v", status, payload)
	}
	if profiles := profilesOf(t, payload); profiles[0]["hasKey"] != false {
		t.Errorf("hasKey = %v after a blank key, want false", profiles[0]["hasKey"])
	}
	if stored, _ := os.ReadFile(file); strings.Contains(string(stored), "sk-test") {
		t.Errorf("the cleared key is still on disk: %s", stored)
	}
}

// An active id that is not in the list becomes the first entry, and an empty list has none: the active id can
// never name a profile that is not there.
func TestSpeechActiveFollowsTheList(t *testing.T) {
	httpServer := httptest.NewServer(newTestServer(t, newFakeComfy(t)).Handler())
	defer httpServer.Close()

	status, payload := profilesPut(t, httpServer, map[string]any{"profiles": []any{
		map[string]any{"name": "one", "url": "http://127.0.0.1:1/v1/audio/transcriptions"},
		map[string]any{"name": "two", "url": "http://127.0.0.1:2/v1/audio/transcriptions"},
	}, "active": 9999})
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %v", status, payload)
	}
	profiles := profilesOf(t, payload)
	if payload["active"] != profiles[0]["id"] {
		t.Errorf("active = %v, want the first profile %v", payload["active"], profiles[0]["id"])
	}

	// Deleting the active one leaves the list with one entry, and that entry is active.
	status, payload = profilesPut(t, httpServer, map[string]any{"profiles": []any{profiles[1]}, "active": profiles[0]["id"]})
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %v", status, payload)
	}
	if payload["active"] != profiles[1]["id"] {
		t.Errorf("active = %v, want the remaining profile %v", payload["active"], profiles[1]["id"])
	}

	status, payload = profilesPut(t, httpServer, map[string]any{"profiles": []any{}})
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %v", status, payload)
	}
	if len(profilesOf(t, payload)) != 0 || payload["active"] != float64(0) {
		t.Errorf("an emptied list is %v with active %v, want no profiles and 0", payload["profiles"], payload["active"])
	}
}

// A list the server cannot read is a 400 with a code, never a 500: it is the page's mistake, and saying which
// field it is about is the whole answer.
func TestSpeechProfilesRefuseWhatTheyCannotRead(t *testing.T) {
	httpServer := httptest.NewServer(newTestServer(t, newFakeComfy(t)).Handler())
	defer httpServer.Close()

	// One real profile, so an id can be named that is not in the list.
	_, payload := profilesPut(t, httpServer, map[string]any{"profiles": []any{
		map[string]any{"name": "one", "url": "http://127.0.0.1:1/v1/audio/transcriptions"},
	}})
	id := int(profilesOf(t, payload)[0]["id"].(float64))

	cases := []struct {
		name string
		body map[string]any
		code string
	}{
		{"no profiles field", map[string]any{}, "speech_profiles_missing"},
		{"profiles that are not a list", map[string]any{"profiles": "one"}, "speech_profiles_invalid"},
		{"an entry that is not an object", map[string]any{"profiles": []any{"one"}}, "speech_profiles_invalid"},
		{"an id that is not a whole number", map[string]any{"profiles": []any{map[string]any{"id": 1.5, "url": "http://127.0.0.1:1/x"}}}, "speech_profile_id_invalid"},
		{"a duplicated id", map[string]any{"profiles": []any{
			map[string]any{"id": id, "url": "http://127.0.0.1:1/v1/audio/transcriptions"},
			map[string]any{"id": id, "url": "http://127.0.0.1:2/v1/audio/transcriptions"},
		}}, "speech_profile_id_invalid"},
		{"an id the server does not have", map[string]any{"profiles": []any{map[string]any{"id": id + 100, "url": "http://127.0.0.1:1/x"}}}, "speech_profile_unknown"},
		{"a key that is not a string", map[string]any{"profiles": []any{map[string]any{"url": "http://127.0.0.1:1/x", "key": 5}}}, "speech_key_invalid"},
		{"an active id that is not a number", map[string]any{"profiles": []any{}, "active": "one"}, "speech_profile_id_invalid"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			status, payload := profilesPut(t, httpServer, testCase.body)
			if status != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400: %v", status, payload)
			}
			failure, _ := payload["error"].(map[string]any)
			if failure["code"] != testCase.code {
				t.Errorf("code = %v, want %s", failure["code"], testCase.code)
			}
		})
	}

	// A refused list is not a list: the profile that was there is still the profile that is there.
	status, payload := profilesGet(t, httpServer)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %v", status, payload)
	}
	if profiles := profilesOf(t, payload); len(profiles) != 1 || int(profiles[0]["id"].(float64)) != id {
		t.Errorf("the list changed under a refused edit: %v", profiles)
	}
}

// findString is the path to a value equal to `want` anywhere in a decoded JSON answer, or "".
func findString(value any, want string) string {
	switch typed := value.(type) {
	case string:
		if typed == want {
			return "the value itself"
		}
	case map[string]any:
		for key, entry := range typed {
			if path := findString(entry, want); path != "" {
				return key + "." + path
			}
		}
	case []any:
		for _, entry := range typed {
			if path := findString(entry, want); path != "" {
				return path
			}
		}
	}
	return ""
}
