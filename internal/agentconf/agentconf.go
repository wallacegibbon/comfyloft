// Package agentconf reads and writes AlayaCore's configuration files: `model.conf` and `mcp.conf`.
//
// Both are one format — `key: value` lines, blocks separated by a `---` line, a value either a quoted
// string or JSON (a list, an object, raw provider JSON). The rules are AlayaCore's, and they are stated in
// three places there: `internal/config/parser.go` (blocks, keys, the four escapes it unquotes),
// `internal/config/formatter.go` (`FormatKeyValue`, which is what an entry looks like on the way out) and
// the `config:"..."` tags on the structs themselves (`agent/model_config.go` and `mcp/types.go`). This
// package is the server's only copy of them, in both directions, so the two files cannot drift apart.
//
// **Why the server writes these files at all.** `mcp.conf` has always been the server's: the bridge
// AlayaCore starts is the server's to point it at (`writeMCPConf`). `model.conf` became the server's when
// AlayaCore's wire version 19 removed `:model_sync` — the command that rewrote the file from a list sent
// over the wire — leaving `:model_load`, which only re-reads the file a running process already has on disk
// (its `docs/commands.md`). So the choice was never "the server writes it or AlayaCore does": after v19 the
// alternatives are "the server writes it" and "models cannot be edited from the canvas at all". An editor
// that needed an agent process to answer could not even repair a `model.conf` that stops the agent from
// starting — no usable model is fatal at startup (`internal/app/session.go` there).
//
// **What this package deliberately does not do.** It does not decide what a good model is; `Model.Validate`
// does, and it is a copy of AlayaCore's own validation rules because a file this server writes has to be a
// file that loads. Nor does it tidy anything away: a line it does not understand — a comment, a key a newer
// AlayaCore added, a value that would not parse — travels through `extra` and is written back verbatim, so
// an edit from the canvas never deletes something the canvas has never seen.
package agentconf

import (
	"strconv"
	"strings"
)

// blocks is a file as the blocks it holds, split on a line that is exactly `---` — which is how AlayaCore
// splits it, its `ParseKeyValueBlocks`. CRLF is normalized first, because a file a Windows editor saved
// otherwise yields one block whose later `---` lines are values rather than separators.
func blocks(content string) [][]string {
	content = strings.ReplaceAll(content, "\r\n", "\n")
	var (
		all     [][]string
		current []string
	)
	for _, line := range strings.Split(content, "\n") {
		if strings.TrimSpace(line) == "---" {
			all = append(all, current)
			current = nil
			continue
		}
		current = append(current, line)
	}
	return append(all, current)
}

// field is one `key: value` line: the key, the value unquoted, and the line as the file wrote it.
type field struct {
	key   string
	value string
	raw   string
}

// parseBlock reads one block into the fields it states and the lines it must carry unread — the comments, which
// are for whoever opens the file next. A line that is not a comment and not a `key: value` pair is dropped and
// reported: no reader can use it (AlayaCore reports it too and goes on), and a file this server writes is a file
// without it. A duplicate key keeps its first occurrence, as it does to AlayaCore (`claimKey` there), and the
// second is dropped and reported rather than written twice.
func parseBlock(lines []string) (fields []field, others []string, problems []string) {
	seen := map[string]bool{}
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if strings.HasPrefix(trimmed, "#") {
			others = append(others, trimmed)
			continue
		}
		key, value, ok := splitField(trimmed)
		if !ok {
			problems = append(problems, "not a `key: value` line: "+strconv.Quote(trimmed)+" — dropped")
			continue
		}
		if seen[key] {
			// The first one is the value. The second is a line this build would have to drop to write a file
			// AlayaCore accepts, so it says that rather than writing both.
			problems = append(problems, "duplicate key "+strconv.Quote(key)+": the first value is kept, this line is dropped")
			continue
		}
		seen[key] = true
		fields = append(fields, field{key: key, value: value, raw: trimmed})
	}
	return fields, others, problems
}

// splitField cuts one line at its first colon and unquotes the value.
//
// The key must be a word: a line whose key is not one — a lone JSON object, say — is not a field, and saying
// so is better than reading it as a key and dropping it. The first colon, because a value may hold the rest:
// a URL written without quotes, a provider's JSON.
func splitField(line string) (key, value string, ok bool) {
	colon := strings.IndexByte(line, ':')
	if colon < 0 {
		return "", "", false
	}
	key = strings.TrimSpace(line[:colon])
	if !isKey(key) {
		return "", "", false
	}
	return key, unquote(strings.TrimSpace(line[colon+1:])), true
}

// isKey reports whether the text is a config key: a letter or underscore, then letters, digits, underscores
// or hyphens — AlayaCore's `validKeyPattern`.
func isKey(text string) bool {
	if text == "" {
		return false
	}
	for index, r := range text {
		switch {
		case r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z'):
		case index > 0 && (r == '-' || (r >= '0' && r <= '9')):
		default:
			return false
		}
	}
	return true
}

// unquote removes one pair of the quotes a value may carry. Single quotes are taken as they stand, and a
// double-quoted value is unescaped with the same four sequences AlayaCore knows — `\\`, `\"`, `\n`, `\r`.
// A sequence it does not know is kept as the two characters it is: dropping either would change the value
// on the way back.
func unquote(value string) string {
	if len(value) < 2 {
		return value
	}
	switch {
	case value[0] == '"' && value[len(value)-1] == '"':
		return unescape(value[1 : len(value)-1])
	case value[0] == '\'' && value[len(value)-1] == '\'':
		return value[1 : len(value)-1]
	}
	return value
}

// unescape undoes the four escapes `quote` writes.
func unescape(value string) string {
	if !strings.ContainsRune(value, '\\') {
		return value
	}
	var out strings.Builder
	out.Grow(len(value))
	for index := 0; index < len(value); index++ {
		if value[index] == '\\' && index+1 < len(value) {
			switch value[index+1] {
			case '\\':
				out.WriteByte('\\')
			case '"':
				out.WriteByte('"')
			case 'n':
				out.WriteByte('\n')
			case 'r':
				out.WriteByte('\r')
			default:
				out.WriteByte('\\')
				out.WriteByte(value[index+1])
			}
			index++
			continue
		}
		out.WriteByte(value[index])
	}
	return out.String()
}

// quote is a string value as a file writes it: wrapped in double quotes, with the four characters a
// one-line value cannot hold escaped. It is AlayaCore's `escapeQuotedStr` and nothing more — `%q` would also
// escape a tab as `\t`, which its reader keeps as the two characters it sees.
func quote(value string) string {
	var out strings.Builder
	out.Grow(len(value) + 2)
	out.WriteByte('"')
	for _, r := range value {
		switch r {
		case '\\':
			out.WriteString(`\\`)
		case '"':
			out.WriteString(`\"`)
		case '\n':
			out.WriteString(`\n`)
		case '\r':
			out.WriteString(`\r`)
		default:
			out.WriteRune(r)
		}
	}
	out.WriteByte('"')
	return out.String()
}

// blockWriter builds one block's lines.
type blockWriter struct {
	out strings.Builder
}

func (w *blockWriter) line(key, value string) {
	w.out.WriteString(key)
	w.out.WriteString(": ")
	w.out.WriteString(value)
	w.out.WriteByte('\n')
}

// raw writes a line back as it arrived, for everything this package does not own.
func (w *blockWriter) raw(line string) {
	w.out.WriteString(line)
	w.out.WriteByte('\n')
}

// String is the block without its trailing newline, ready to be joined to the others.
func (w *blockWriter) String() string {
	return strings.TrimSuffix(w.out.String(), "\n")
}

// joinBlocks is a whole file: the blocks in order, separated by `---`, and one trailing newline. No blocks
// is no file at all, which is what AlayaCore's own writer produces for an empty list.
func joinBlocks(formatted []string) []byte {
	if len(formatted) == 0 {
		return nil
	}
	return []byte(strings.Join(formatted, "\n---\n") + "\n")
}
