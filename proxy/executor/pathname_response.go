package executor

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
)

// Response URL rewriting for the direct pathname destinations (REHOR-652
// review fix). Real SDK clients (Octokit, gitbeaker) follow absolute Link
// pagination URLs and Location redirects verbatim, which drops the
// gateway-injected credential and bypasses the mandatory proxy. The
// rewriter below pulls every URL that names the route's own upstream back
// into the gateway prefix, so pagination and redirects keep flowing through
// the credential-injecting route:
//
//	https://api.github.com/repositories/1?page=2   -> /github/repositories/1?page=2
//	//gitlab.example.com/api/v4/x?paged=1          -> /gitlab/api/v4/x?paged=1
//	/repos/o/r?page=2 (relative)                   -> /github/repos/o/r?page=2
//
// Rules, mirroring how clients resolve these values:
//
//   - An absolute URL is same-upstream only when its scheme (ignoring
//     case) equals the upstream's and its host[:port] equals the
//     upstream's after default-port normalization (https 443, http 80).
//     Userinfo never contributes to the match, and a URL carrying
//     userinfo is rejected outright: "https://api.github.com@evil.example/"
//     names evil.example, not the upstream, and a credential embedded in a
//     response URL must not be processed at all.
//   - A scheme-relative reference (//host[:port]/path) is resolved by
//     clients against their own scheme (https in production). It matches
//     only when its authority names the upstream with an explicit port
//     equal to the upstream's port, or with no port when the upstream is
//     on the default https port 443.
//   - A relative-path reference keeps the pre-existing behavior of the
//     prefix rewriters (rewriteLocationPrefix): exactly one destination
//     prefix is prepended, query and fragment untouched. The absolute and
//     relative branches are mutually exclusive, so a value is never
//     prefixed twice.
//   - Relative references without a leading slash and query- or
//     fragment-only references resolve against the gateway request path,
//     which already carries the prefix, and pass through unchanged.
//   - Anything else — a foreign absolute URL, a foreign scheme-relative
//     reference, a URL with userinfo, or a value that cannot be parsed —
//     is rejected with errUnapprovedOrigin: the response fails closed
//     with a clear 502 instead of handing the client a proxy-authenticated
//     arbitrary target. The offending URL (which may itself carry a
//     credential in its query) is never echoed to the client or the logs.
//
// Link headers (RFC 8288) get the same per-URL treatment: every
// <uri-reference> element is rewritten with the rules above and the
// element's parameters are preserved verbatim, including quoted strings
// containing commas. A foreign-origin element rejects the whole response —
// pagination links must name the upstream the route proxies to.
//
// This rewriter is wired ONLY into the direct pathname destinations
// (/github, /gitlab, /jira). The legacy loopback routes keep their existing
// relative-only Location rewrites and their documented absolute-URL
// passthrough (git smart HTTP redirects to content CDNs).

// errUnapprovedOrigin marks a response URL (Location or Link element) that
// does not name the route's upstream. The ReverseProxy error handler turns
// it into a fixed, credential-free 502.
var errUnapprovedOrigin = errors.New("upstream response url outside the approved destination")

// upstreamRewrite rewrites same-upstream response URLs into one
// destination's gateway prefix. It is built from the route's validated
// upstream target, so the scheme and host it matches are fixed at
// construction time and can never come from a request.
type upstreamRewrite struct {
	prefix string // gateway path prefix, e.g. "/github"
	scheme string // upstream scheme, lowercased ("http" or "https")
	host   string // upstream host or host:port, lowercased
}

// newUpstreamRewrite builds the rewriter for one destination prefix from
// its validated upstream target.
func newUpstreamRewrite(prefix string, target *url.URL) *upstreamRewrite {
	return &upstreamRewrite{
		prefix: prefix,
		scheme: strings.ToLower(target.Scheme),
		host:   strings.ToLower(target.Host),
	}
}

// rewriteResponse rewrites every Location and Link header value of a
// proxied response in place. Any unapproved origin fails the response.
func (rw *upstreamRewrite) rewriteResponse(resp *http.Response) error {
	if locs := resp.Header.Values("Location"); len(locs) > 0 {
		resp.Header.Del("Location")
		for _, loc := range locs {
			out, err := rw.rewriteLocationValue(loc)
			if err != nil {
				return err
			}
			resp.Header.Add("Location", out)
		}
	}
	if links := resp.Header.Values("Link"); len(links) > 0 {
		resp.Header.Del("Link")
		for _, value := range links {
			out, err := rw.rewriteLinkHeader(value)
			if err != nil {
				return err
			}
			resp.Header.Add("Link", out)
		}
	}
	return nil
}

// rewriteLocationValue rewrites one Location value (or one Link
// uri-reference) with the rules documented on upstreamRewrite.
func (rw *upstreamRewrite) rewriteLocationValue(loc string) (string, error) {
	if loc == "" {
		return loc, nil
	}
	if strings.HasPrefix(loc, "//") || hasURLScheme(loc) {
		u, err := url.Parse(loc)
		if err != nil {
			return "", errUnapprovedOrigin
		}
		if !rw.matches(u) {
			return "", errUnapprovedOrigin
		}
		return rw.gatewayPath(u), nil
	}
	if loc[0] == '/' {
		// Relative-path reference: the existing prefix behavior, verbatim —
		// prefix + value, so query and fragment bytes are untouched and the
		// prefix is applied exactly once.
		return rw.prefix + loc, nil
	}
	// Relative reference without a leading slash (or query-/fragment-only):
	// resolves against the gateway request path, which carries the prefix.
	return loc, nil
}

// rewriteLinkHeader rewrites one Link header value. Elements are split on
// commas that are neither inside a <uri-reference> nor inside a quoted
// parameter, each element's uri-reference is rewritten with the Location
// rules, and the element's parameters are preserved verbatim.
func (rw *upstreamRewrite) rewriteLinkHeader(value string) (string, error) {
	elements := splitLinkElements(value)
	for i, el := range elements {
		trimmed := strings.TrimSpace(el)
		if !strings.HasPrefix(trimmed, "<") {
			// Not a URI-bearing element (or a stray separator): nothing to
			// rewrite, nothing the client would follow as a URL.
			continue
		}
		end := strings.IndexByte(trimmed, '>')
		if end < 0 {
			continue
		}
		uri := trimmed[1:end]
		out, err := rw.rewriteLocationValue(uri)
		if err != nil {
			return "", err
		}
		elements[i] = "<" + out + ">" + trimmed[end+1:]
	}
	return strings.Join(elements, ", "), nil
}

// matches reports whether u names the route's upstream. Scheme-relative
// references are resolved with the production client scheme (https); see
// the rules on upstreamRewrite.
func (rw *upstreamRewrite) matches(u *url.URL) bool {
	if u.User != nil {
		// A URL with userinfo is either an origin-confusion attempt or an
		// embedded credential; either way it is not approved.
		return false
	}
	if u.Host == "" {
		return false
	}
	if u.Scheme != "" {
		if !strings.EqualFold(u.Scheme, rw.scheme) {
			return false
		}
		return sameHostPort(u.Scheme, u.Host, rw.scheme, rw.host)
	}
	// Scheme-relative authority: the client resolves it with its own
	// scheme, https in production, so the implicit port is 443.
	return sameHostPort("https", u.Host, rw.scheme, rw.host)
}

// gatewayPath renders u as a gateway-prefixed path reference, preserving
// the escaping of the path and the query and fragment byte-for-byte.
func (rw *upstreamRewrite) gatewayPath(u *url.URL) string {
	out := rw.prefix + u.EscapedPath()
	if u.RawQuery != "" {
		out += "?" + u.RawQuery
	}
	if u.Fragment != "" || u.RawFragment != "" {
		out += "#" + u.EscapedFragment()
	}
	return out
}

// sameHostPort compares two host[:port] authorities under their schemes,
// normalizing an absent port to the scheme's default (http 80, https 443)
// so "https://api.example.com" and "https://api.example.com:443" are the
// same origin. Hostnames compare case-insensitively; IPv6 brackets are
// kept intact.
func sameHostPort(schemeA, hostA, schemeB, hostB string) bool {
	nameA, portA := splitAuthorityHostPort(hostA)
	nameB, portB := splitAuthorityHostPort(hostB)
	if !strings.EqualFold(nameA, nameB) {
		return false
	}
	if portA == "" {
		portA = defaultSchemePort(schemeA)
	}
	if portB == "" {
		portB = defaultSchemePort(schemeB)
	}
	return portA == portB
}

// splitAuthorityHostPort splits a host or host:port authority, respecting
// bracketed IPv6 literals.
func splitAuthorityHostPort(host string) (name, port string) {
	if strings.HasPrefix(host, "[") {
		if i := strings.IndexByte(host, ']'); i >= 0 {
			if i+1 < len(host) && host[i+1] == ':' {
				return host[:i+1], host[i+2:]
			}
			return host, ""
		}
	}
	if i := strings.LastIndexByte(host, ':'); i >= 0 {
		return host[:i], host[i+1:]
	}
	return host, ""
}

// defaultSchemePort returns the default port for a URL scheme, or "" when
// the scheme has none (only http and https upstreams can be configured).
func defaultSchemePort(scheme string) string {
	switch scheme {
	case "http":
		return "80"
	case "https":
		return "443"
	}
	return ""
}

// hasURLScheme reports whether v starts with an RFC 3986 scheme prefix
// (ALPHA followed by ALPHA/DIGIT/+/-/. up to a colon), i.e. whether the
// value is an absolute URL rather than a relative reference.
func hasURLScheme(v string) bool {
	i := strings.IndexByte(v, ':')
	if i <= 0 {
		return false
	}
	for j := 0; j < i; j++ {
		c := v[j]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z':
			// Scheme characters at any position.
		case j > 0 && (c >= '0' && c <= '9' || c == '+' || c == '-' || c == '.'):
			// Non-first position extras.
		default:
			return false
		}
	}
	return true
}

// splitLinkElements splits one Link header value into its comma-separated
// elements, ignoring commas inside <uri-references> and inside quoted
// parameter values (quoted parameters may legitimately contain commas,
// e.g. title="Page 1, of 5"). Escaped quotes inside quoted strings are not
// interpreted; they do not occur in practice and mis-splitting them can
// only make the rewriter conservative (it fails the response).
func splitLinkElements(value string) []string {
	var elements []string
	var b strings.Builder
	inAngle, inQuote := false, false
	for i := 0; i < len(value); i++ {
		c := value[i]
		switch {
		case inQuote:
			b.WriteByte(c)
			if c == '"' {
				inQuote = false
			}
		case c == '<':
			inAngle = true
			b.WriteByte(c)
		case c == '>':
			inAngle = false
			b.WriteByte(c)
		case c == '"':
			inQuote = true
			b.WriteByte(c)
		case c == ',' && !inAngle && !inQuote:
			elements = append(elements, b.String())
			b.Reset()
		default:
			b.WriteByte(c)
		}
	}
	elements = append(elements, b.String())
	return elements
}
