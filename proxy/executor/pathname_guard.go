package executor

import (
	"bytes"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
)

// GitLab credential-source request guard (REHOR-652 review fix).
//
// GitLab accepts request credentials from more sources than headers: per
// lib/gitlab/auth/auth_finders.rb, the private-token, job-token, and
// OAuth token finders read TOP-LEVEL REQUEST PARAMETERS (Rack merges the
// query string and form/JSON bodies into one params hash) BEFORE falling
// back to headers. A caller-supplied
//
//	/gitlab/api/v4/projects?private_token=glpat-...
//
// therefore overrides the gateway-injected Private-Token header — the
// caller, not the proxy, picks the upstream identity, and GitLab's
// documented OAuth `access_token` query/body parameter behaves the same
// way via Doorkeeper. The proxy layer must be the sole token source on the
// upstream leg, so the gitlab destination rejects any request that carries
// a destination authentication parameter instead of forwarding it.
//
// Rejected parameter names (top level, compared after percent-decoding,
// case-insensitively — stricter than Rack's exact lowercase symbols, which
// only ever removes smuggling room):
//
//	private_token         PAT param (auth_finders.rb PRIVATE_TOKEN_PARAM)
//	personal_access_token legacy PAT param alias
//	access_token          OAuth2 param (Doorkeeper from_access_token_param)
//	job_token             CI job token param (JOB_TOKEN_PARAM)
//
// The alternative GitLab auth headers — Private-Token, Job-Token, and
// Deploy-Token (auth_finders.rb HEADER_TOKEN_KEYS) — cannot override the
// injected header (they are dropped by stripPathnameAuthHeaders before
// injection), and Authorization/Cookie are already removed by the shared
// gateway strip.
//
// Body inspection is bounded and content-type scoped, mirroring the exact
// media types Rack itself parses into request params (Rack::Request
// form_pairs_parse_type / MediaType.type):
//
//   - application/x-www-form-urlencoded (any method) and application/json
//     (including +json vendor types) bodies are inspected for top-level
//     authentication keys. Ordinary payloads are restored byte-for-byte.
//   - multipart/form-data — and multipart/related, multipart/mixed, the
//     other types Rack parses as multipart — are walked with the standard
//     library reader and rejected when any part's field name is an
//     authentication parameter (file parts included, conservatively). The
//     walk is deliberately strict: the boundary must be a plain RFC 2046
//     boundary, every part must carry exactly one Content-Disposition with
//     exactly one plain name parameter, and any structural or parametric
//     ambiguity — malformed part headers, unexpected end of body, missing
//     or duplicate names, RFC 2231 name* parameters, a boundary Rack would
//     truncate differently — fails closed with a fixed message instead of
//     being skipped. Rack accepts several of those shapes, so a lenient
//     reader here would be a parsing differential, not extra compatibility.
//   - A POST with no media type (missing or empty Content-Type) is parsed
//     by Rack as urlencoded form data, so the guard inspects it the same
//     way; other methods without a content type are not params sources and
//     pass.
//   - A body that claims to be JSON but does not parse fails closed with
//     a fixed message; an inspectable body above the size bound fails
//     closed with 413. Neither error ever echoes the body or a credential.
//   - Other content types (raw bodies, text) are not Rack params sources
//     and pass through uninspected, keeping ordinary payload streams
//     working.
//
// Nested bracket keys (private_token[foo]) become Hash values in Rack and
// cannot authenticate (the token lookup gets Hash#to_s, which matches
// nothing), so they pass — the same is true of file parts generally, but
// those are still rejected by name as a conservative stance. The
// runner-token `token` parameter is deliberately NOT blocked: it
// authenticates only CI runner endpoints, not general API requests, and
// blocking a parameter that generic would blanket-break ordinary traffic.
// The GitLab Sudo header/param is likewise out of scope: it impersonates
// only when the proxy's own injected token is an administrator PAT, which
// is a deployment configuration concern. This guard is scoped to the
// gitlab destination only.

// gitlabBodyInspectLimit bounds how much of an inspectable request body
// the guard reads. GitLab API payloads from supported clients (gitbeaker
// JSON) are far smaller; anything larger claiming a form/JSON content type
// fails closed rather than passing uninspected.
const gitlabBodyInspectLimit = 1 << 20 // 1 MiB

// gitlabAuthParamNames lists the top-level request parameters GitLab
// authenticates with (see the file comment for the exact sources).
var gitlabAuthParamNames = map[string]bool{
	"private_token":         true,
	"personal_access_token": true,
	"access_token":          true,
	"job_token":             true,
}

// Fixed, credential-free rejection messages. They name the contract
// violation, never the parameter value (which is the caller's credential).
const (
	errGitlabAuthQuery         = "gitlab destination does not accept authentication parameters in the query string"
	errGitlabAuthBody          = "gitlab destination does not accept authentication parameters in the request body"
	errGitlabInvalidJSON       = "gitlab destination request body is not valid JSON"
	errGitlabBodyTooLarge      = "gitlab destination request body exceeds the gateway body inspection limit"
	errGitlabMultipartBoundary = "gitlab destination multipart request body has no usable boundary parameter"
	errGitlabMultipartBadBody  = "gitlab destination multipart request body is malformed"
)

// maxContentDispositionBytes is the scan window Rack gives its
// multipart Content-Disposition regex; beyond it Rack falls back to
// naming the part from its Content-ID header. The guard does not
// implement that fallback, so an oversized Content-Disposition is
// rejected rather than interpreted differently than Rack would.
const maxContentDispositionBytes = 1536

// gitlabAuthRequestGuard is the request guard wired into the gitlab
// pathname destination. It rejects authentication parameters in the query
// string and in supported bodies before any upstream hop, restoring
// passing bodies byte-for-byte.
func gitlabAuthRequestGuard(r *http.Request) *routeRejection {
	if gitlabAuthParamsPresent(r.URL.RawQuery) {
		return &routeRejection{
			status:  http.StatusBadRequest,
			class:   "gitlab_auth_param_query",
			message: errGitlabAuthQuery,
		}
	}
	if r.Body == nil || r.ContentLength == 0 {
		return nil
	}
	base := baseContentType(r.Header.Get("Content-Type"))
	form := base == "application/x-www-form-urlencoded"
	jsonBody := base == "application/json" || strings.HasSuffix(base, "+json")
	// Rack parses exactly these multipart types into params (form data plus
	// the parseable multipart/related and multipart/mixed).
	multipartBody := base == "multipart/form-data" ||
		base == "multipart/related" || base == "multipart/mixed"
	if !form && !jsonBody && !multipartBody {
		if base == "" && r.Method == http.MethodPost {
			// Rack: a POST with a nil media type (no or empty Content-Type)
			// is urlencoded form data.
			form = true
		} else {
			return nil
		}
	}
	var boundary string
	if multipartBody {
		var ok bool
		boundary, ok = extractMultipartBoundary(r.Header.Get("Content-Type"))
		if !ok {
			return &routeRejection{
				status:  http.StatusBadRequest,
				class:   "gitlab_body_multipart_boundary",
				message: errGitlabMultipartBoundary,
			}
		}
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, gitlabBodyInspectLimit+1))
	// Restore the exact bytes for every outcome below; a rejected request
	// never reaches the proxy, so the restore only matters on the pass
	// paths, but keeping it unconditional leaves no half-read body behind.
	r.Body = io.NopCloser(bytes.NewReader(body))
	r.ContentLength = int64(len(body))
	if err != nil {
		return &routeRejection{
			status:  http.StatusBadRequest,
			class:   "gitlab_body_unreadable",
			message: "gitlab destination request body could not be read",
		}
	}
	if len(body) == 0 {
		return nil
	}
	if len(body) > gitlabBodyInspectLimit {
		return &routeRejection{
			status:  http.StatusRequestEntityTooLarge,
			class:   "gitlab_body_too_large",
			message: errGitlabBodyTooLarge,
		}
	}
	switch {
	case multipartBody:
		if rej := inspectMultipartBody(body, boundary); rej != nil {
			return rej
		}
	case form:
		if gitlabAuthParamsPresent(string(body)) {
			return &routeRejection{
				status:  http.StatusBadRequest,
				class:   "gitlab_auth_param_body",
				message: errGitlabAuthBody,
			}
		}
	default: // JSON
		// Only a top-level object can contribute params keys. Any other
		// valid JSON document (array, string, number) has no keys and passes.
		var top any
		if err := json.Unmarshal(body, &top); err != nil {
			return &routeRejection{
				status:  http.StatusBadRequest,
				class:   "gitlab_body_invalid_json",
				message: errGitlabInvalidJSON,
			}
		}
		if obj, ok := top.(map[string]any); ok {
			for key := range obj {
				if gitlabAuthParamNames[strings.ToLower(key)] {
					return &routeRejection{
						status:  http.StatusBadRequest,
						class:   "gitlab_auth_param_body",
						message: errGitlabAuthBody,
					}
				}
			}
		}
	}
	return nil
}

// gitlabAuthParamsPresent reports whether any &-separated pair (a query
// string or a urlencoded body) carries a top-level authentication
// parameter name. Names are percent-decoded once — exactly what Rack's
// query parser does — and compared case-insensitively. Duplicate names and
// encoded names are caught; a name that only appears as a value, nested
// bracket keys, and double-encoded names are not.
func gitlabAuthParamsPresent(pairs string) bool {
	for _, pair := range strings.Split(pairs, "&") {
		if gitlabAuthParamPair(pair) {
			return true
		}
	}
	return false
}

// gitlabAuthParamPair reports whether one &-separated pair's decoded name
// is a GitLab authentication parameter. An undecodable name (invalid
// percent-encoding) is compared raw: Rack leaves such names literal, so
// they cannot become an auth key either way.
func gitlabAuthParamPair(pair string) bool {
	if pair == "" {
		return false
	}
	name := pair
	if i := strings.IndexByte(pair, '='); i >= 0 {
		name = pair[:i]
	}
	if decoded, err := url.QueryUnescape(name); err == nil {
		name = decoded
	}
	return gitlabAuthParamNames[strings.ToLower(name)]
}

// baseContentType extracts the lowercased media type from a Content-Type
// header, ignoring parameters (charset etc.) the same way Rack derives the
// media type: everything before the first semicolon or comma, trimmed.
// Rack's MediaType.type splits on both separators, so
// "application/json,text/plain" has media type application/json for Rack
// and for this guard alike.
func baseContentType(contentType string) string {
	cut := len(contentType)
	for i := 0; i < len(contentType); i++ {
		if contentType[i] == ';' || contentType[i] == ',' {
			cut = i
			break
		}
	}
	return strings.ToLower(strings.TrimSpace(contentType[:cut]))
}

// extractMultipartBoundary returns the multipart boundary parameter of a
// Content-Type header value, validated against the RFC 2046 boundary
// grammar. Rack's own extraction (its MULTIPART regex) truncates the value
// at the first quote, semicolon, or comma, so a boundary containing any of
// those characters makes the two parsers disagree about where the parts
// are; such values — and any unparseable Content-Type — fail closed here
// instead of being interpreted differently than Rack would.
func extractMultipartBoundary(contentType string) (string, bool) {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return "", false
	}
	boundary := params["boundary"]
	if !validMultipartBoundary(boundary) {
		return "", false
	}
	return boundary, true
}

// validMultipartBoundary reports whether b is an RFC 2046 boundary: 1-70
// bchars — bcharsnospace plus SPACE, no trailing space. Characters outside
// that set (commas, semicolons, quotes, backslashes, controls, non-ASCII)
// are rejected because Rack truncates a boundary at some of them and
// parses the body with the shorter one; a boundary the two parsers cannot
// agree on is a differential, never a legitimate value.
func validMultipartBoundary(b string) bool {
	if len(b) == 0 || len(b) > 70 {
		return false
	}
	for i := 0; i < len(b); i++ {
		c := b[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case c == '\'' || c == '(' || c == ')' || c == '+' || c == '_' ||
			c == '-' || c == '.' || c == '/' || c == ':' || c == '=' || c == '?':
		case c == ' ':
			if i == len(b)-1 {
				return false
			}
		default:
			return false
		}
	}
	return true
}

// inspectMultipartBody walks the parts of a buffered multipart body with
// the standard library reader and rejects the request when any part's
// field name is a GitLab authentication parameter. The walk is strict:
// any structural error from the standard parser (a malformed part header,
// an unexpected end of body) and any part that does not carry exactly one
// Content-Disposition with exactly one plain name parameter is rejected
// rather than skipped. Rack — the parser that feeds GitLab's request
// params — accepts several shapes the standard reader rejects (an
// unterminated part header whose Content-Disposition is still consumed, a
// close delimiter followed by more parts, Content-ID naming) and ignores
// RFC 2231 name* parameters the standard library would merge; failing
// closed on every ambiguous shape keeps this guard's verdict a superset
// of Rack's instead of a differential.
func inspectMultipartBody(body []byte, boundary string) *routeRejection {
	reader := multipart.NewReader(bytes.NewReader(body), boundary)
	parts := 0
	for {
		part, err := reader.NextRawPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return multipartMalformedRejection()
		}
		parts++
		name, ok := partFieldName(part)
		if !ok {
			return multipartMalformedRejection()
		}
		if gitlabAuthParamNames[strings.ToLower(name)] {
			return &routeRejection{
				status:  http.StatusBadRequest,
				class:   "gitlab_auth_param_body",
				message: errGitlabAuthBody,
			}
		}
	}
	if parts == 0 {
		// The body is non-empty and the boundary is valid, yet no part
		// was found. No supported client produces that shape, and
		// accepting it would rely on boundary-line detection matching
		// Rack's exactly, so it fails closed.
		return multipartMalformedRejection()
	}
	return nil
}

// multipartMalformedRejection is the fixed, credential-free rejection for
// any multipart shape the guard does not accept.
func multipartMalformedRejection() *routeRejection {
	return &routeRejection{
		status:  http.StatusBadRequest,
		class:   "gitlab_body_multipart_malformed",
		message: errGitlabMultipartBadBody,
	}
}

// partFieldName extracts the plain name= parameter of a part's single
// Content-Disposition header. ok is false when the shape is ambiguous or
// unsupported: no Content-Disposition or more than one, a
// Content-Disposition longer than Rack's 1536-byte scan window (where
// Rack names the part from its Content-ID instead), zero or multiple name
// parameters, an empty name, or any RFC 2231 extended name* parameter
// (Rack ignores those; the standard library merges them into name — the
// parsers disagree, so the request fails closed).
func partFieldName(part *multipart.Part) (string, bool) {
	dispositions := part.Header.Values("Content-Disposition")
	if len(dispositions) != 1 {
		return "", false
	}
	disposition := dispositions[0]
	if len(disposition) > maxContentDispositionBytes {
		return "", false
	}
	name := ""
	count := 0
	for _, param := range splitOutsideQuotes(disposition, ';') {
		param = strings.TrimSpace(param)
		eq := strings.IndexByte(param, '=')
		if eq < 0 {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(param[:eq]))
		if strings.HasPrefix(key, "name*") {
			return "", false
		}
		if key != "name" {
			continue
		}
		count++
		value := strings.TrimSpace(param[eq+1:])
		if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
			value = unescapeQuoted(value[1 : len(value)-1])
		}
		name = value
	}
	if count != 1 || name == "" {
		return "", false
	}
	return name, true
}

// splitOutsideQuotes splits s on sep, ignoring separators inside quoted
// strings (a quoted parameter value may legitimately contain the
// separator).
func splitOutsideQuotes(s string, sep byte) []string {
	var out []string
	var b strings.Builder
	inQuote := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case inQuote:
			b.WriteByte(c)
			if c == '\\' && i+1 < len(s) {
				i++
				b.WriteByte(s[i])
			} else if c == '"' {
				inQuote = false
			}
		case c == '"':
			inQuote = true
			b.WriteByte(c)
		case c == sep:
			out = append(out, b.String())
			b.Reset()
		default:
			b.WriteByte(c)
		}
	}
	out = append(out, b.String())
	return out
}

// unescapeQuoted resolves backslash escapes inside a quoted parameter
// value.
func unescapeQuoted(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) {
			i++
		}
		b.WriteByte(s[i])
	}
	return b.String()
}
