package agent

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"comfyloft/internal/logx"
)

// Process is one running `alayacore --rawio`, owned by one request.
//
// Nothing keeps it alive beyond that request: run.go releases it when the answer ends, and a
// cancelled request sends `CI cancel` so the agent winds its own task down. The server does not
// layer a timeout of its own on top — the process is what knows what a half-finished step means.
type Process struct {
	Cmd    *exec.Cmd
	Stdin  *bufio.Writer
	Stdout *bufio.Reader
	// Stderr keeps the child's last lines. A core that dies at startup says why only there: a
	// refused session file, an unknown model, a bad config. Losing that turns "your model name is
	// wrong" into "connection closed".
	Stderr    *stderrTail
	Log       *logx.Logger
	startedAt time.Time

	stdinFile *os.File

	// writeMu keeps one frame's bytes together: a write and its flush are two calls, and two writers (a
	// prompt from the canvas, a tool answer, a command) would otherwise interleave halves.
	writeMu sync.Mutex

	waitOnce sync.Once
	waitErr  error
}

// SpawnOptions is what one request may influence. Everything else is the operator's, fixed in the
// server's configuration: the config directory, the tool list, the skill container.
type SpawnOptions struct {
	Binary     string
	ConfigPath string
	// Skills is the container of skill directories passed as `--skill`. The agent reads them itself;
	// the server only says where they are.
	Skills string
	// Tools is the `--builtin-tools` list. Read-only file access is what a skill needs in order to be
	// activated at all (the agent loads a skill by reading its SKILL.md); no other tool is enabled.
	Tools string
	// Env is what this spawn knows that the operator's environment does not: where the MCP bridge should
	// send its calls, and which session it speaks for. AlayaCore hands its environment to the stdio
	// servers it starts, so this is how a per-session fact reaches a static `mcp.conf`.
	Env []string
	// AutoSummarize is the share of the model's context, in percent, at which AlayaCore summarizes the
	// conversation to make room. 0 is off, and off is the absence of the flag rather than the number 0:
	// a setting the operator never made is not the server's to state.
	AutoSummarize int
	// Session is the file AlayaCore keeps this conversation in. It is not work: it is what lets the next
	// process replay what was said. Empty means the conversation dies with the process, which is what a
	// session that is not a conversation wants — the models editor is asked one command and nothing after it.
	Session string
	// System is text appended to the agent's own system prompt, one entry per `--system` flag. It is for
	// what a tool description cannot say: the rule that chooses between the tools.
	System []string
	// Log records what happened in terms someone who knows AlayaCore can follow: the command line,
	// every frame in both directions, and how the process ended.
	Log *logx.Logger
}

// args builds the command line. Built-in tools are always disabled: this route asks an agent for
// words, and a request must not be able to hand itself a shell. The model is not a flag: it is set
// with `CI model_set` once the session is ready, which is where the agent reports the outcome.
func (o SpawnOptions) args() []string {
	args := []string{"--rawio", "--builtin-tools=" + o.Tools}
	if o.AutoSummarize > 0 {
		args = append(args, fmt.Sprintf("--auto-summarize=%d", o.AutoSummarize))
	}
	if o.ConfigPath != "" {
		args = append(args, "--config-path", o.ConfigPath)
	}
	if o.Skills != "" {
		args = append(args, "--skill", o.Skills)
	}
	// The conversation's own file: AlayaCore loads it and replays it before it is ready, and saves each
	// turn as it ends. That file, not this process, is what remembers a conversation.
	if o.Session != "" {
		args = append(args, "--session", o.Session)
	}
	for _, text := range o.System {
		args = append(args, "--system", text)
	}
	return args
}

// findBinary locates alayacore: the configured path, then PATH, then next to this executable — the
// same order the rest of the ecosystem uses, so a bundled copy wins over a stale one on PATH.
func findBinary(configured string) string {
	if configured = strings.TrimSpace(configured); configured != "" {
		return configured
	}
	if path, err := exec.LookPath("alayacore"); err == nil {
		return path
	}
	if exe, err := os.Executable(); err == nil {
		beside := filepath.Join(filepath.Dir(exe), "alayacore")
		if info, err := os.Stat(beside); err == nil && info.Size() > 0 {
			return beside
		}
	}
	return "alayacore"
}

// Spawn starts the agent. The caller must Release it.
func Spawn(o SpawnOptions) (*Process, error) {
	cmd := exec.Command(findBinary(o.Binary), o.args()...)
	if len(o.Env) > 0 {
		// Prepended to the inherited environment so a later assignment wins, which is Go's rule for a
		// duplicate name and the one that lets a caller override what the operator exported.
		cmd.Env = append(o.Env, os.Environ()...)
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	// stderr is an explicit pipe rather than cmd.StderrPipe(), because Wait closes a pipe it owns
	// itself and the tail is still being read on the release path. With our own descriptors, Wait
	// cannot touch the read end.
	stderrRead, stderrWrite, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = stderrWrite

	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		_ = stderrRead.Close()
		_ = stderrWrite.Close()
		return nil, err
	}
	// The parent's copy of the write end is not ours to keep: holding it open would mean the pipe
	// never reaches EOF after the child exits.
	_ = stderrWrite.Close()

	tail := newStderrTail()
	go tail.drain(stderrRead)

	if o.Log != nil {
		o.Log.Info("agent: spawn pid=%d binary=%s config=%s skills=%s tools=%q", cmd.Process.Pid, cmd.Path, o.ConfigPath, o.Skills, o.Tools)
	}

	in := bufio.NewWriter(stdin)
	return &Process{
		Cmd:       cmd,
		Stdin:     in,
		Stdout:    bufio.NewReaderSize(stdout, 64<<10),
		Stderr:    tail,
		stdinFile: stdin.(*os.File),
		Log:       o.Log,
		startedAt: time.Now(),
	}, nil
}

// Write sends one frame and flushes it. A frame that was never flushed reads as the agent going
// quiet, so every write here is followed by one.
//
// The lock is what keeps a frame whole: a write and its flush are two calls, so a command that arrived while
// the canvas was sending a prompt would otherwise interleave two half-frames on the agent's stdin. The session
// has a lock of its own for sequences that must stay in order; this one is about the bytes.
func (p *Process) Write(tag, value string) error {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	p.logFrame(">>", tag, value)
	if err := WriteFrame(p.Stdin, tag, value); err != nil {
		return err
	}
	return p.Stdin.Flush()
}

// Read returns the next frame, logging it. Everything the agent says passes through here, so the log
// is the transcript: a reader who knows AlayaCore can see the frames in order.
func (p *Process) Read() (*Frame, error) {
	frame, err := ReadFrame(p.Stdout)
	if frame != nil {
		p.logFrame("<<", frame.Tag, frame.Value)
	}
	return frame, err
}

func (p *Process) logFrame(direction, tag, value string) {
	if p.Log == nil || isDelta(tag) {
		return
	}
	p.Log.Info("agent %s %s %s", direction, tag, truncateFrame(redactKeys(value)))
}

// isDelta reports the streaming plane — `Ax`, `Af`, `Uf`. They arrive per token, and a transcript made
// of them buries the frames that say what happened. The closing `request done` line already counts
// them, which is all a reader needs: how many deltas a turn took.
func isDelta(tag string) bool {
	return tag == TagAssistantXDelta || tag == TagAssistantFDelta || tag == TagUserFDelta
}

// reAPIKey matches the value of an api_key field in a frame body. `SM model_list` carries every key
// from model.conf in cleartext; the transcript is worth having, the keys in it are not.
var reAPIKey = regexp.MustCompile(`("api_key":\s*)"(?:[^"\\]|\\.)*"`)

func redactKeys(value string) string {
	return reAPIKey.ReplaceAllString(value, `$1"***"`)
}

// truncateFrame keeps a frame's head. A rewrite of an H3 prompt is thousands of characters and is not
// more informative for it; the shape of the beginning is what tells a reader what the frame is.
func truncateFrame(value string) string {
	const limit = 400
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + fmt.Sprintf("… (%d runes)", len(runes))
}

// Wait reaps the child once and returns its exit error. Callers that may race (the reader's end of
// stream and Release) get the same answer from the sync.Once.
func (p *Process) Wait() error {
	p.waitOnce.Do(func() { p.waitErr = p.Cmd.Wait() })
	return p.waitErr
}

// releasePatience is how long the agent is given to end once its input is closed, before it is killed. It is
// short on purpose: end of input is answered in about a second (measured, idle and mid-turn alike), so this is
// the bound on how long a caller waits rather than a deadline for an agent's task.
var releasePatience = 2 * time.Second

// Release ends the process: end of input first, and a kill if that does not take.
//
// **Why end of input and not `quit`.** `quit` is AlayaCore's documented exit, and its semantics are "a task
// that is already running is allowed to finish first" — which makes it useless for the one case that matters,
// a task that never finishes. The terminal interface completes the pair by asking a person whether to `cancel`
// first, and there is no person here. End of input needs no answer: a rawio session whose stdin closes ends,
// writing `SM session closed` on the way out, and the conversation file already holds what it wrote.
//
// **Why a kill at all.** `Release` sits on the request path — a `DELETE` of a session answers from it — and on
// the shutdown path, where an agent that will not end is a server that will not stop. So after
// `releasePatience` the process is killed, and that is the trade this makes (#250): the tail of a turn in
// flight is what it can cost, and a release that always ends is what it buys. A conversation is a short thing
// here, and the alternative — waiting forever on an agent that may be looping — is not a trade at all.
func (p *Process) Release() {
	if p.stdinFile != nil {
		_ = p.stdinFile.Close()
	}
	killed := false
	if !p.exitedWithin(releasePatience) {
		killed = true
		_ = p.Cmd.Process.Kill()
	}
	err := p.Wait()
	if p.Log != nil {
		// The tail is the reason a spawn failed, so it is worth a line of its own when it exists.
		if tail := p.Stderr.Last(); tail != "" {
			p.Log.Warn("agent: stderr %s", truncateFrame(tail))
		}
		if killed {
			p.Log.Warn("agent: pid=%d did not end on end of input; killed", p.Cmd.Process.Pid)
		}
		p.Log.Info("agent: exit pid=%d err=%v lived=%dms", p.Cmd.Process.Pid, err, time.Since(p.startedAt).Milliseconds())
	}
}

// exitedWithin waits up to d for the process to be reaped. The wait itself is the shared `sync.Once`, so a
// probe that times out leaves nothing behind: the goroutine it started returns the moment the process does.
func (p *Process) exitedWithin(d time.Duration) bool {
	done := make(chan struct{})
	go func() {
		_ = p.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(d):
		return false
	}
}

// stderrTail keeps the last few lines the child wrote. Bounded: a chatty child must not grow the
// server's memory, and only the last line is ever quoted (that is where the reason is).
type stderrTail struct {
	mu    sync.Mutex
	lines []string
	// done is closed when the child's stderr reaches EOF, so a reader that has just seen the process die
	// can wait for its last words instead of racing the goroutine that is still copying them.
	done chan struct{}
}

// newStderrTail builds a tail whose done channel the drain closes.
func newStderrTail() *stderrTail { return &stderrTail{done: make(chan struct{})} }

// settled waits up to the timeout for the drain to finish. It is only used on the startup-failure path,
// where the child is already gone and the pipe therefore closes on its own.
func (t *stderrTail) settled(timeout time.Duration) {
	select {
	case <-t.done:
	case <-time.After(timeout):
	}
}

const stderrTailLines = 20

func (t *stderrTail) drain(r *os.File) {
	defer close(t.done)
	defer r.Close()
	buf := make([]byte, 4096)
	var pending string
	for {
		n, err := r.Read(buf)
		if n > 0 {
			pending += string(buf[:n])
			for {
				index := strings.IndexByte(pending, '\n')
				if index < 0 {
					break
				}
				t.push(pending[:index])
				pending = pending[index+1:]
			}
		}
		if err != nil {
			if strings.TrimSpace(pending) != "" {
				t.push(pending)
			}
			return
		}
	}
}

func (t *stderrTail) push(line string) {
	line = strings.TrimRight(line, "\r")
	if strings.TrimSpace(line) == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.lines = append(t.lines, line)
	if len(t.lines) > stderrTailLines {
		t.lines = t.lines[len(t.lines)-stderrTailLines:]
	}
}

// Last returns the most recent line, which for a startup failure is the whole reason.
func (t *stderrTail) Last() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.lines) == 0 {
		return ""
	}
	return t.lines[len(t.lines)-1]
}
