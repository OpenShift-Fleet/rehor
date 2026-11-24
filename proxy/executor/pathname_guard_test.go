package executor

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestGitlabAuthParamsPresent pins the Rack-faithful detection of
// destination authentication parameters in ampersand-separated pairs (query
// strings and urlencoded bodies): exact top-level names (decoded, compared
// case-insensitively), duplicates, and percent-encoded names are caught;
// ordinary parameters, values that merely contain a token name, nested
// (bracketed) keys, and double-encoded names are not.
func TestGitlabAuthParamsPresent(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want bool
	}{
		{"empty", "", false},
		{"ordinary params", "membership=true&per_page=100", false},
		{"private token", "private_token=glpat-x", true},
		{"access token", "access_token=oauth-x", true},
		{"job token", "job_token=ci-x", true},
		{"legacy personal access token", "personal_access_token=glpat-x", true},
		{"uppercase name", "PRIVATE_TOKEN=glpat-x", true},
		{"mixed case name", "Private_Token=glpat-x", true},
		{"percent encoded name", "private%5Ftoken=glpat-x", true},
		{"percent encoded uppercase name", "%50RIVATE_TOKEN=x", true},
		{"duplicate params", "a=1&private_token=x&private_token=y", true},
		{"mid-query", "a=1&job_token=y&b=2", true},
		{"bare name without value", "private_token", true},
		{"token name as value", "search=private_token&per_page=1", false},
		{"hyphenated name is not a rack key", "private-token=x", false},
		{"nested bracket key is not top level", "auth[private_token]=x", false},
		{"double encoded name", "private%255Ftoken=x", false},
		{"runner token param not blanket-blocked", "token=x", false},
		{"semicolon inside value", "search=a;b", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := gitlabAuthParamsPresent(tc.raw); got != tc.want {
				t.Fatalf("gitlabAuthParamsPresent(%q) = %v, want %v", tc.raw, got, tc.want)
			}
		})
	}
}

// TestGitlabAuthRequestGuard pins the request guard: query parameters and
// supported form/JSON bodies carrying destination authentication parameters
// are rejected with fixed, credential-free messages; ordinary payloads pass
// and are restored byte-for-byte; malformed or oversized inspectable bodies
// fail closed; unsupported content types pass uninspected.
func TestGitlabAuthRequestGuard(t *testing.T) {
	rejectQuery := func(r *http.Request) *routeRejection {
		rej := gitlabAuthRequestGuard(r)
		if rej != nil {
			defer r.Body.Close()
		}
		return rej
	}

	t.Run("clean query passes", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/gitlab/api/v4/projects?membership=true&per_page=5", nil)
		if rej := rejectQuery(req); rej != nil {
			t.Fatalf("clean query rejected: %+v", rej)
		}
	})

	t.Run("auth query parameter rejected", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/gitlab/api/v4/projects?private_token=glpat-caller", nil)
		rej := rejectQuery(req)
		if rej == nil {
			t.Fatal("private_token query not rejected")
		}
		if rej.status != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rej.status)
		}
		if !strings.Contains(rej.message, "query string") {
			t.Fatalf("message %q must name the query string", rej.message)
		}
		if strings.Contains(rej.message, "glpat-caller") {
			t.Fatalf("message %q echoes the credential", rej.message)
		}
	})

	t.Run("encoded duplicate auth query rejected", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/gitlab/api/v4/projects?a=1&job%5Ftoken=x&job_token=y", nil)
		if rej := rejectQuery(req); rej == nil {
			t.Fatal("encoded duplicate job_token not rejected")
		}
	})

	formReq := func(body string) *http.Request {
		req := httptest.NewRequest("POST", "/gitlab/api/v4/projects", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		return req
	}

	t.Run("clean form body passes and is preserved", func(t *testing.T) {
		body := "name=repo&description=a+b&default_branch=main"
		req := formReq(body)
		if rej := rejectQuery(req); rej != nil {
			t.Fatalf("clean form rejected: %+v", rej)
		}
		got, err := io.ReadAll(req.Body)
		if err != nil {
			t.Fatal(err)
		}
		req.Body.Close()
		if string(got) != body {
			t.Fatalf("body not restored byte-for-byte: %q", string(got))
		}
		if req.ContentLength != int64(len(body)) {
			t.Fatalf("ContentLength = %d, want %d", req.ContentLength, len(body))
		}
	})

	t.Run("auth param in form body rejected", func(t *testing.T) {
		req := formReq("name=repo&access_token=oauth-caller")
		rej := rejectQuery(req)
		if rej == nil {
			t.Fatal("access_token form param not rejected")
		}
		if !strings.Contains(rej.message, "request body") {
			t.Fatalf("message %q must name the request body", rej.message)
		}
		if strings.Contains(rej.message, "oauth-caller") {
			t.Fatalf("message %q echoes the credential", rej.message)
		}
	})

	jsonReq := func(body, contentType string) *http.Request {
		req := httptest.NewRequest("POST", "/gitlab/api/v4/projects", strings.NewReader(body))
		req.Header.Set("Content-Type", contentType)
		return req
	}

	t.Run("clean json body passes and is preserved", func(t *testing.T) {
		body := `{"name":"repo","nested":{"private_token":"not-a-key"}}`
		req := jsonReq(body, "application/json")
		if rej := rejectQuery(req); rej != nil {
			t.Fatalf("clean json rejected: %+v", rej)
		}
		got, _ := io.ReadAll(req.Body)
		req.Body.Close()
		if string(got) != body {
			t.Fatalf("body not restored byte-for-byte: %q", string(got))
		}
	})

	t.Run("json charset inspected", func(t *testing.T) {
		req := jsonReq(`{"private_token":"glpat-x"}`, "application/json; charset=utf-8")
		if rej := rejectQuery(req); rej == nil {
			t.Fatal("charset-suffixed json body not inspected")
		}
	})

	t.Run("vendor json suffix inspected", func(t *testing.T) {
		req := jsonReq(`{"job_token":"ci-x"}`, "application/vnd.api+json")
		if rej := rejectQuery(req); rej == nil {
			t.Fatal("+json body not inspected")
		}
	})

	t.Run("top level auth key rejected", func(t *testing.T) {
		for _, key := range []string{"private_token", "access_token", "job_token", "personal_access_token"} {
			req := jsonReq(`{"`+key+`":"x"}`, "application/json")
			if rej := rejectQuery(req); rej == nil {
				t.Fatalf("json key %q not rejected", key)
			}
		}
	})

	t.Run("nested json key passes", func(t *testing.T) {
		req := jsonReq(`{"filter":{"private_token":"x"}}`, "application/json")
		if rej := rejectQuery(req); rej != nil {
			t.Fatalf("nested json key rejected: %+v", rej)
		}
	})

	t.Run("json array body passes", func(t *testing.T) {
		req := jsonReq(`[1,2,3]`, "application/json")
		if rej := rejectQuery(req); rej != nil {
			t.Fatalf("array body rejected: %+v", rej)
		}
	})

	t.Run("invalid json fails closed", func(t *testing.T) {
		req := jsonReq(`{"name":`, "application/json")
		rej := rejectQuery(req)
		if rej == nil {
			t.Fatal("invalid json not rejected")
		}
		if rej.status != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rej.status)
		}
		if !strings.Contains(rej.message, "not valid JSON") {
			t.Fatalf("message %q must name the invalid JSON", rej.message)
		}
	})

	t.Run("oversized form body fails closed", func(t *testing.T) {
		big := strings.Repeat("k=v&", (gitlabBodyInspectLimit/4)+8)
		req := formReq(big)
		rej := rejectQuery(req)
		if rej == nil {
			t.Fatal("oversized form body not rejected")
		}
		if rej.status != http.StatusRequestEntityTooLarge {
			t.Fatalf("status = %d, want 413", rej.status)
		}
	})

	t.Run("oversized json body fails closed", func(t *testing.T) {
		big := `{"pad":"` + strings.Repeat("a", gitlabBodyInspectLimit+16) + `"}`
		req := jsonReq(big, "application/json")
		rej := rejectQuery(req)
		if rej == nil {
			t.Fatal("oversized json body not rejected")
		}
		if rej.status != http.StatusRequestEntityTooLarge {
			t.Fatalf("status = %d, want 413", rej.status)
		}
	})

	t.Run("missing content type on POST is form data", func(t *testing.T) {
		// Rack parses a POST body with no media type as form data
		// (form_pairs_parse_type: meth == POST && type.nil?); the same
		// override must not sneak past with the header omitted.
		req := httptest.NewRequest("POST", "/gitlab/api/v4/projects", strings.NewReader("private_token=glpat-caller"))
		rej := rejectQuery(req)
		if rej == nil {
			t.Fatal("POST body without content type not inspected")
		}
		if rej.status != http.StatusBadRequest || !strings.Contains(rej.message, "request body") {
			t.Fatalf("rejection = %+v, want 400 body message", rej)
		}
	})

	t.Run("unsupported content type passes uninspected", func(t *testing.T) {
		req := jsonReq("private_token=x", "text/plain")
		if rej := rejectQuery(req); rej != nil {
			t.Fatalf("text/plain rejected: %+v", rej)
		}
		req = jsonReq("\x00\x01binary", "application/octet-stream")
		if rej := rejectQuery(req); rej != nil {
			t.Fatalf("octet-stream rejected: %+v", rej)
		}
	})

	t.Run("empty chunked body passes", func(t *testing.T) {
		req := httptest.NewRequest("POST", "/gitlab/api/v4/projects", strings.NewReader(""))
		req.Header.Set("Content-Type", "application/json")
		req.ContentLength = -1
		if rej := rejectQuery(req); rej != nil {
			t.Fatalf("empty chunked body rejected: %+v", rej)
		}
	})

	t.Run("chunked clean body passes restored", func(t *testing.T) {
		req := httptest.NewRequest("POST", "/gitlab/api/v4/projects", strings.NewReader(`{"name":"x"}`))
		req.Header.Set("Content-Type", "application/json")
		req.ContentLength = -1
		if rej := rejectQuery(req); rej != nil {
			t.Fatalf("chunked clean body rejected: %+v", rej)
		}
		got, _ := io.ReadAll(req.Body)
		req.Body.Close()
		if string(got) != `{"name":"x"}` {
			t.Fatalf("body not restored: %q", string(got))
		}
	})
}

// TestGitlabDestinationCredentialContract verifies end to end, against the
// real gateway, that the proxy layer is the sole GitLab credential source:
// authentication parameters in the query string and in form/JSON bodies are
// rejected before any upstream hop, the alternative GitLab auth headers
// (Job-Token, Deploy-Token) are stripped alongside Private-Token, and
// ordinary requests flow unchanged with the injected token only.
func TestGitlabDestinationCredentialContract(t *testing.T) {
	handler, pb := newPathnameGateway(t)
	gw := httptest.NewServer(handler)
	defer gw.Close()

	client := &http.Client{Timeout: 10 * time.Second}

	post := func(path, contentType, body string) *http.Response {
		t.Helper()
		req, err := http.NewRequest("POST", gw.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	rejected := func(name, path, contentType, body, credential string) {
		t.Helper()
		before := pb.gitlab.count()
		var resp *http.Response
		if contentType == "" {
			req, err := http.NewRequest("GET", gw.URL+path, nil)
			if err != nil {
				t.Fatal(err)
			}
			resp, err = client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
		} else {
			resp = post(path, contentType, body)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400", name, resp.StatusCode)
		}
		payload, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		if strings.Contains(string(payload), credential) {
			t.Fatalf("%s: body %q echoes the credential", name, string(payload))
		}
		if !strings.Contains(string(payload), "authentication parameters") {
			t.Fatalf("%s: body %q must name the rejected authentication parameters", name, string(payload))
		}
		if pb.gitlab.count() != before {
			t.Fatalf("%s: request reached the gitlab upstream", name)
		}
	}

	// The GitLab auth_finders contract: params beat the injected
	// Private-Token header, so any of these forms would override the proxy
	// credential if forwarded.
	rejected("query private_token", "/gitlab/api/v4/projects?private_token=glpat-caller", "", "", "glpat-caller")
	rejected("query access_token", "/gitlab/api/v4/projects?access_token=oauth-caller", "", "", "oauth-caller")
	rejected("query encoded job_token", "/gitlab/api/v4/projects?scope=x&job%5Ftoken=ci-caller", "", "", "ci-caller")
	rejected("form access_token", "/gitlab/api/v4/projects", "application/x-www-form-urlencoded", "name=x&access_token=oauth-caller", "oauth-caller")
	rejected("json private_token", "/gitlab/api/v4/projects", "application/json", `{"name":"x","private_token":"glpat-caller"}`, "glpat-caller")
	rejected("json job_token", "/gitlab/api/v4/projects", "application/json", `{"job_token":"ci-caller"}`, "ci-caller")

	t.Run("ordinary json request passes with body intact", func(t *testing.T) {
		before := pb.gitlab.count()
		body := `{"name":"repo","description":"a b"}`
		resp := post("/gitlab/api/v4/projects", "application/json", body)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
		if pb.gitlab.count() != before+1 {
			t.Fatal("gitlab upstream did not record the request")
		}
		rec := pb.gitlab.last(t)
		if rec.body != body {
			t.Fatalf("body = %q, want byte-identical %q", rec.body, body)
		}
		if got := rec.header.Get("Private-Token"); got != "gl-secret-token" {
			t.Fatalf("Private-Token = %q, want injected token", got)
		}
	})

	t.Run("ordinary query parameters pass", func(t *testing.T) {
		resp, err := client.Get(gw.URL + "/gitlab/api/v4/projects?membership=true&per_page=7")
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
		if got := pb.gitlab.last(t).query; got != "membership=true&per_page=7" {
			t.Fatalf("query = %q, want ordinary params preserved", got)
		}
	})

	t.Run("alternative gitlab auth headers stripped", func(t *testing.T) {
		req, err := http.NewRequest("GET", gw.URL+"/gitlab/api/v4/projects", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Private-Token", "caller-pat")
		req.Header.Set("Job-Token", "caller-job")
		req.Header.Set("Deploy-Token", "caller-deploy")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
		h := pb.gitlab.last(t).header
		for _, name := range []string{"Job-Token", "Deploy-Token"} {
			if got := h.Get(name); got != "" {
				t.Fatalf("%s reached the gitlab upstream: %q", name, got)
			}
		}
		if got := h.Get("Private-Token"); got != "gl-secret-token" {
			t.Fatalf("Private-Token = %q, want injected token", got)
		}
	})

	t.Run("guard is gitlab-scoped only", func(t *testing.T) {
		// The parameter contract is the GitLab credential-source fix; the
		// github destination keeps forwarding ordinary query strings.
		before := pb.github.count()
		resp, err := client.Get(gw.URL + "/github/repos/o/r?private_token=not-gitlab")
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
		if pb.github.count() != before+1 {
			t.Fatal("github upstream did not record the request")
		}
		if got := pb.github.last(t).query; got != "private_token=not-gitlab" {
			t.Fatalf("github query = %q, want forwarded unchanged", got)
		}
	})
}

// TestGitlabGuardRejectsMalformedBodyClosed verifies a body that claims to
// be JSON but cannot be parsed fails closed with the fixed message rather
// than being forwarded uninspected.
func TestGitlabGuardRejectsMalformedBodyClosed(t *testing.T) {
	handler, pb := newPathnameGateway(t)

	req := httptest.NewRequest("POST", "/gitlab/api/v4/projects", bytes.NewReader([]byte(`{"name": `)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "not valid JSON") {
		t.Fatalf("body %q must name the invalid JSON", rec.Body.String())
	}
	if pb.gitlab.count() != 0 {
		t.Fatal("malformed body reached the gitlab upstream")
	}
}

// multipartPart is one part of a test multipart body: the raw
// Content-Disposition (plus optional part headers) and the part content.
type multipartPart struct {
	disposition string
	content     string
}

// multipartTestBody assembles a syntactically valid multipart body.
func multipartTestBody(boundary string, parts ...multipartPart) string {
	var b strings.Builder
	for _, p := range parts {
		b.WriteString("--" + boundary + "\r\n")
		b.WriteString(p.disposition)
		b.WriteString("\r\n\r\n")
		b.WriteString(p.content)
		b.WriteString("\r\n")
	}
	b.WriteString("--" + boundary + "--\r\n")
	return b.String()
}

// TestGitlabMultipartGuard pins the multipart inspection: Rails/Rack merge
// multipart form fields into request params, so a private_token FIELD
// overrides the injected header exactly like the query/body finding. Known
// auth field names are rejected (file parts included, conservatively),
// ordinary field/file payloads pass byte-for-byte, missing boundaries and
// oversized bodies fail closed, and forged delimiters inside file content
// cannot hide a later auth field.
func TestGitlabMultipartGuard(t *testing.T) {
	guard := func(r *http.Request) *routeRejection {
		rej := gitlabAuthRequestGuard(r)
		if rej != nil {
			r.Body.Close()
		}
		return rej
	}
	multipartReq := func(contentType, body string) *http.Request {
		req := httptest.NewRequest("POST", "/gitlab/api/v4/projects", strings.NewReader(body))
		req.Header.Set("Content-Type", contentType)
		return req
	}
	const bound = "testboundary123"
	ct := "multipart/form-data; boundary=" + bound

	t.Run("auth field rejected", func(t *testing.T) {
		body := multipartTestBody(bound,
			multipartPart{`Content-Disposition: form-data; name="description"`, "ok"},
			multipartPart{`Content-Disposition: form-data; name="private_token"`, "glpat-caller"},
		)
		rej := guard(multipartReq(ct, body))
		if rej == nil {
			t.Fatal("multipart private_token field not rejected")
		}
		if rej.status != http.StatusBadRequest || !strings.Contains(rej.message, "request body") {
			t.Fatalf("rejection = %+v, want 400 body message", rej)
		}
		if strings.Contains(rej.message, "glpat-caller") {
			t.Fatalf("message %q echoes the credential", rej.message)
		}
	})

	t.Run("job token field rejected", func(t *testing.T) {
		body := multipartTestBody(bound,
			multipartPart{`Content-Disposition: form-data; name="job_token"`, "ci-caller"},
		)
		if rej := guard(multipartReq(ct, body)); rej == nil {
			t.Fatal("multipart job_token field not rejected")
		}
	})

	t.Run("file part named private token rejected", func(t *testing.T) {
		body := multipartTestBody(bound,
			multipartPart{`Content-Disposition: form-data; name="private_token"; filename="tok.txt"` + "\r\n" + `Content-Type: text/plain`, "glpat-caller"},
		)
		if rej := guard(multipartReq(ct, body)); rej == nil {
			t.Fatal("multipart file part named private_token not rejected")
		}
	})

	t.Run("ordinary field and file pass byte-preserved", func(t *testing.T) {
		payload := "binary-ish\r\npayload --not-a-boundary\r\nwith lines"
		body := multipartTestBody(bound,
			multipartPart{`Content-Disposition: form-data; name="avatar"; filename="a.png"` + "\r\n" + `Content-Type: image/png`, payload},
			multipartPart{`Content-Disposition: form-data; name="description"`, "hello world"},
		)
		req := multipartReq(ct, body)
		if rej := guard(req); rej != nil {
			t.Fatalf("ordinary multipart rejected: %+v", rej)
		}
		got, _ := io.ReadAll(req.Body)
		req.Body.Close()
		if string(got) != body {
			t.Fatalf("multipart body not restored byte-for-byte:\n got %q\nwant %q", string(got), body)
		}
	})

	t.Run("quoted boundary parsed", func(t *testing.T) {
		qct := `multipart/form-data; boundary="quoted bound"`
		body := multipartTestBody("quoted bound",
			multipartPart{`Content-Disposition: form-data; name="access_token"`, "oauth-caller"},
		)
		if rej := guard(multipartReq(qct, body)); rej == nil {
			t.Fatal("quoted-boundary multipart auth field not rejected")
		}
	})

	t.Run("missing boundary param fails closed", func(t *testing.T) {
		body := multipartTestBody(bound,
			multipartPart{`Content-Disposition: form-data; name="x"`, "y"},
		)
		rej := guard(multipartReq("multipart/form-data", body))
		if rej == nil {
			t.Fatal("multipart without boundary param not rejected")
		}
		if rej.status != http.StatusBadRequest || !strings.Contains(rej.message, "boundary") {
			t.Fatalf("rejection = %+v, want 400 boundary message", rej)
		}
	})

	t.Run("oversized multipart fails closed", func(t *testing.T) {
		body := multipartTestBody(bound,
			multipartPart{`Content-Disposition: form-data; name="avatar"; filename="big.bin"`, strings.Repeat("a", gitlabBodyInspectLimit+64)},
		)
		rej := guard(multipartReq(ct, body))
		if rej == nil {
			t.Fatal("oversized multipart not rejected")
		}
		if rej.status != http.StatusRequestEntityTooLarge {
			t.Fatalf("status = %d, want 413", rej.status)
		}
	})

	t.Run("garbage structure fails closed", func(t *testing.T) {
		// A non-empty body with a valid boundary that yields no parts is
		// not a shape any supported client produces, and accepting it
		// would depend on boundary-line detection matching Rack's
		// exactly — it fails closed.
		req := multipartReq(ct, "this is not a multipart body at all")
		if rej := guard(req); rej == nil {
			t.Fatal("unparseable multipart structure passed uninspected")
		}
	})

	t.Run("nested bracket field passes", func(t *testing.T) {
		// Rack turns private_token[foo] into a Hash value, and GitLab's
		// token lookup cannot authenticate with a Hash; it is not a
		// credential source, so it passes.
		body := multipartTestBody(bound,
			multipartPart{`Content-Disposition: form-data; name="private_token[foo]"`, "x"},
		)
		req := multipartReq(ct, body)
		if rej := guard(req); rej != nil {
			t.Fatalf("nested bracket multipart field rejected: %+v", rej)
		}
	})

	t.Run("forged delimiter in file cannot hide later auth field", func(t *testing.T) {
		forge := "--" + bound + "\r\n" + `Content-Disposition: form-data; name="innocent"` + "\r\n\r\njunk\r\n"
		body := multipartTestBody(bound,
			multipartPart{`Content-Disposition: form-data; name="file"; filename="f"`, forge},
			multipartPart{`Content-Disposition: form-data; name="private_token"`, "glpat-caller"},
		)
		if rej := guard(multipartReq(ct, body)); rej == nil {
			t.Fatal("auth field after forged delimiter not rejected")
		}
	})

	t.Run("folded content disposition still inspected", func(t *testing.T) {
		body := multipartTestBody(bound,
			multipartPart{"Content-Disposition: form-data;\r\n name=\"private_token\"", "x"},
		)
		if rej := guard(multipartReq(ct, body)); rej == nil {
			t.Fatal("folded Content-Disposition hid the auth field name")
		}
	})

	t.Run("multipart related inspected", func(t *testing.T) {
		body := multipartTestBody(bound,
			multipartPart{`Content-Disposition: form-data; name="private_token"`, "x"},
		)
		req := multipartReq("multipart/related; boundary="+bound+`; type="text/xml"`, body)
		if rej := guard(req); rej == nil {
			t.Fatal("multipart/related auth field not rejected")
		}
	})

	t.Run("multipart mixed inspected", func(t *testing.T) {
		body := multipartTestBody(bound,
			multipartPart{`Content-Disposition: form-data; name="private_token"`, "x"},
		)
		req := multipartReq("multipart/mixed; boundary="+bound, body)
		if rej := guard(req); rej == nil {
			t.Fatal("multipart/mixed auth field not rejected")
		}
	})

	t.Run("transport padding after delimiter accepted", func(t *testing.T) {
		var b strings.Builder
		b.WriteString("--" + bound + "  \r\n")
		b.WriteString(`Content-Disposition: form-data; name="private_token"`)
		b.WriteString("\r\n\r\nx\r\n")
		b.WriteString("--" + bound + "--\r\n")
		req := multipartReq(ct, b.String())
		if rej := guard(req); rej == nil {
			t.Fatal("auth field after padded delimiter not rejected")
		}
	})
}

// TestGitlabMultipartRackDifferentials pins the multipart shapes an audit
// proved Rack (3.2.8, lib/rack/multipart/parser.rb) parses into a
// top-level private_token String that a lenient names-only parser misses.
// The guard must reject every one of them — by the auth-parameter path or
// by failing closed on the ambiguous shape; which one is shape-dependent,
// so the test only asserts a rejection with a fixed credential-free
// message and no upstream dependency on the body.
func TestGitlabMultipartRackDifferentials(t *testing.T) {
	guard := func(r *http.Request) *routeRejection {
		rej := gitlabAuthRequestGuard(r)
		if rej != nil {
			r.Body.Close()
		}
		return rej
	}
	multipartReq := func(contentType, body string) *http.Request {
		req := httptest.NewRequest("POST", "/gitlab/api/v4/user", strings.NewReader(body))
		req.Header.Set("Content-Type", contentType)
		return req
	}

	cases := []struct {
		name, contentType, body string
		note                    string
	}{
		{
			"unterminated part header spans next delimiter",
			"multipart/form-data; boundary=B",
			"--B\r\nContent-Disposition: form-data; name=\"private_token\"\r\n--B\r\nContent-Disposition: form-data; name=\"ok\"\r\n\r\nx\r\n--B--\r\n",
			"Rack's head scan spans the delimiter and still consumes the first Content-Disposition",
		},
		{
			"comma in boundary parameter",
			"multipart/form-data; boundary=x,y",
			"--x\r\nContent-Disposition: form-data; name=\"private_token\"\r\n\r\nstolen\r\n--x--\r\n",
			"Rack truncates the boundary at the comma and parses with x",
		},
		{
			"semicolon inside quoted boundary",
			`multipart/form-data; boundary="a;b"`,
			"--a\r\nContent-Disposition: form-data; name=\"private_token\"\r\n\r\nstolen\r\n--a--\r\n",
			"Rack truncates the quoted boundary at the semicolon and parses with a",
		},
		{
			"escaped quote inside quoted boundary",
			"multipart/form-data; boundary=\"a\\\"b\"",
			"--a\\\r\nContent-Disposition: form-data; name=\"private_token\"\r\n\r\nstolen\r\n--a\\--\r\n",
			"Rack truncates the boundary at the escaped quote and parses with a\\",
		},
		{
			"content-id named part",
			"multipart/form-data; boundary=B",
			"--B\r\nContent-ID: private_token\r\n\r\nstolen\r\n--B--\r\n",
			"Rack names a part without Content-Disposition from its Content-ID",
		},
		{
			"duplicate name parameters",
			"multipart/form-data; boundary=B",
			"--B\r\nContent-Disposition: form-data; name=foo; name=private_token\r\n\r\nstolen\r\n--B--\r\n",
			"Rack's parameter loop keeps the LAST name; first-wins parsing misses it",
		},
		{
			"close delimiter followed by more parts",
			"multipart/form-data; boundary=B",
			"--B--junk\r\n--B\r\nContent-Disposition: form-data; name=\"private_token\"\r\n\r\nstolen\r\n--B--\r\n",
			"Rack rescans after a non-final close delimiter and finds the later part",
		},
		{
			"rfc 2231 extended name parameter",
			"multipart/form-data; boundary=B",
			"--B\r\nContent-Disposition: form-data; name*=us-ascii'en'private_token\r\n\r\nstolen\r\n--B--\r\n",
			"Rack ignores name*; the standard library merges it into name — ambiguous shape",
		},
		{
			"part without any name parameter",
			"multipart/form-data; boundary=B",
			"--B\r\nContent-Disposition: form-data; filename=\"f.txt\"\r\n\r\nstolen\r\n--B--\r\n",
			"strict shape: every part must carry exactly one plain name",
		},
		{
			"empty multipart body with only a close delimiter",
			"multipart/form-data; boundary=B",
			"--B--\r\n",
			"non-empty body, valid boundary, zero parts — fails closed",
		},
	}
	for _, tc := range cases {
		rej := guard(multipartReq(tc.contentType, tc.body))
		if rej == nil {
			t.Errorf("%s: passed uninspected — %s", tc.name, tc.note)
			continue
		}
		if rej.status != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", tc.name, rej.status)
		}
		if strings.Contains(rej.message, "stolen") {
			t.Errorf("%s: message %q echoes body content", tc.name, rej.message)
		}
	}
}

// TestGitlabMissingContentTypePolicy pins the nil-media-type rule: Rack
// parses a POST body with no content type as urlencoded form data, so the
// guard inspects it identically; other methods with no content type are
// not params sources and pass.
func TestGitlabMissingContentTypePolicy(t *testing.T) {
	guard := func(method, body string) *routeRejection {
		req := httptest.NewRequest(method, "/gitlab/api/v4/projects", strings.NewReader(body))
		rej := gitlabAuthRequestGuard(req)
		if rej != nil {
			req.Body.Close()
		}
		return rej
	}

	t.Run("post without content type inspected as form", func(t *testing.T) {
		if rej := guard("POST", "private_token=glpat-caller"); rej == nil {
			t.Fatal("POST form body without content type not inspected")
		}
	})

	t.Run("post with empty content type inspected as form", func(t *testing.T) {
		req := httptest.NewRequest("POST", "/gitlab/api/v4/projects", strings.NewReader("job_token=ci-caller"))
		req.Header.Set("Content-Type", "")
		rej := gitlabAuthRequestGuard(req)
		if rej != nil {
			req.Body.Close()
		}
		if rej == nil {
			t.Fatal("empty content type not treated as nil media type")
		}
	})

	t.Run("clean post without content type passes preserved", func(t *testing.T) {
		req := httptest.NewRequest("POST", "/gitlab/api/v4/projects", strings.NewReader("name=x&state=opened"))
		if rej := gitlabAuthRequestGuard(req); rej != nil {
			req.Body.Close()
			t.Fatalf("clean no-content-type POST rejected: %+v", rej)
		}
		got, _ := io.ReadAll(req.Body)
		req.Body.Close()
		if string(got) != "name=x&state=opened" {
			t.Fatalf("body not restored: %q", string(got))
		}
	})

	t.Run("get without content type passes", func(t *testing.T) {
		if rej := guard("GET", "private_token=glpat-caller"); rej != nil {
			t.Fatal("GET body must not be form-parsed (Rack parses POST only)")
		}
	})

	t.Run("put without content type passes", func(t *testing.T) {
		if rej := guard("PUT", "private_token=glpat-caller"); rej != nil {
			t.Fatal("PUT body must not be form-parsed (Rack parses POST only)")
		}
	})

	t.Run("comma in content type media type still matches rack", func(t *testing.T) {
		// Rack's media-type extraction splits on ';' or ','; a content
		// type like "application/json,text/plain" parses as JSON for Rack
		// and must be inspected for the guard too.
		req := httptest.NewRequest("POST", "/gitlab/api/v4/projects", strings.NewReader(`{"private_token":"x"}`))
		req.Header.Set("Content-Type", "application/json,text/plain")
		rej := gitlabAuthRequestGuard(req)
		if rej != nil {
			req.Body.Close()
		}
		if rej == nil {
			t.Fatal("comma-suffixed JSON content type not inspected")
		}
	})
}

// TestGitlabDestinationMultipartAndNilTypeContract verifies end to end,
// against the real gateway, that multipart auth fields and content-type-less
// POST form bodies are rejected before any upstream hop and ordinary
// multipart payloads flow with the injected token and byte-identical body.
func TestGitlabDestinationMultipartAndNilTypeContract(t *testing.T) {
	handler, pb := newPathnameGateway(t)
	gw := httptest.NewServer(handler)
	defer gw.Close()

	client := &http.Client{Timeout: 10 * time.Second}
	const bound = "contractboundary"
	ct := "multipart/form-data; boundary=" + bound

	post := func(contentType, body string) *http.Response {
		t.Helper()
		req, err := http.NewRequest("POST", gw.URL+"/gitlab/api/v4/projects", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	rejected := func(name, contentType, body, credential string) {
		t.Helper()
		before := pb.gitlab.count()
		resp := post(contentType, body)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400", name, resp.StatusCode)
		}
		payload, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		if strings.Contains(string(payload), credential) {
			t.Fatalf("%s: body %q echoes the credential", name, string(payload))
		}
		if !strings.Contains(string(payload), "authentication parameters") {
			t.Fatalf("%s: body %q must name the rejected authentication parameters", name, string(payload))
		}
		if pb.gitlab.count() != before {
			t.Fatalf("%s: request reached the gitlab upstream", name)
		}
	}

	rejected("multipart private_token field", ct, multipartTestBody(bound,
		multipartPart{`Content-Disposition: form-data; name="private_token"`, "glpat-caller"},
		multipartPart{`Content-Disposition: form-data; name="title"`, "x"},
	), "glpat-caller")

	rejected("post form body without content type", "", "name=x&access_token=oauth-caller", "oauth-caller")

	t.Run("ordinary multipart passes with body intact", func(t *testing.T) {
		before := pb.gitlab.count()
		body := multipartTestBody(bound,
			multipartPart{`Content-Disposition: form-data; name="avatar"; filename="a.png"` + "\r\n" + `Content-Type: image/png`, "\x89PNG\r\nfake bytes"},
			multipartPart{`Content-Disposition: form-data; name="description"`, "avatar upload"},
		)
		resp := post(ct, body)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
		if pb.gitlab.count() != before+1 {
			t.Fatal("gitlab upstream did not record the request")
		}
		rec := pb.gitlab.last(t)
		if rec.body != body {
			t.Fatalf("multipart body not forwarded byte-identical:\n got %q\nwant %q", rec.body, body)
		}
		if got := rec.header.Get("Private-Token"); got != "gl-secret-token" {
			t.Fatalf("Private-Token = %q, want injected token", got)
		}
	})

	t.Run("clean post without content type passes", func(t *testing.T) {
		before := pb.gitlab.count()
		resp := post("", "name=x")
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
		if pb.gitlab.count() != before+1 {
			t.Fatal("gitlab upstream did not record the request")
		}
		if got := pb.gitlab.last(t).body; got != "name=x" {
			t.Fatalf("body = %q, want forwarded unchanged", got)
		}
	})
}
