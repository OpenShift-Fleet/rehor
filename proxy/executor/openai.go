package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	// defaultOpenAIBaseURL has no /v1 suffix: clients already send
	// /v1/chat/completions or /v1/responses and the path is forwarded unchanged.
	defaultOpenAIBaseURL = "https://api.openai.com"
	openAIUpstreamHost   = "api.openai.com"

	// maxChatRequestBytes caps the request body we buffer to read "model".
	maxChatRequestBytes = 32 << 20
	// maxUsageScrapeBytes caps the non-streaming JSON response we buffer to
	// read token usage. Streaming responses are never buffered.
	maxUsageScrapeBytes = 1 << 20
)

// openaiModelKey carries the allowlisted model from the request handler to
// ModifyResponse, which labels token metrics with it.
const openaiModelKey contextKey = "openaiModel"

type openaiProxyConfig struct {
	APIKey    string
	Policy    *OpenAIPolicy
	Upstream  *url.URL
	Transport http.RoundTripper
	Org       string
	Project   string
}

type openaiModelEntry struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	OwnedBy string `json:"owned_by"`
}

type openaiModelList struct {
	Object string             `json:"object"`
	Data   []openaiModelEntry `json:"data"`
}

// NewOpenAIProxy returns the OpenAI-compatible gateway handler. The upstream
// is OPENAI_BASE_URL when set (host must be api.openai.com), else the default.
func NewOpenAIProxy(apiKey string, policy *OpenAIPolicy) http.Handler {
	raw := os.Getenv("OPENAI_BASE_URL")
	if raw == "" {
		raw = defaultOpenAIBaseURL
	}
	upstream, err := url.Parse(raw)
	if err != nil {
		log.Fatalf("openai: invalid OPENAI_BASE_URL %q: %v", raw, err)
	}
	if upstream.Scheme != "https" || upstream.Host != openAIUpstreamHost {
		log.Fatalf("openai: OPENAI_BASE_URL must be https://%s, got %q", openAIUpstreamHost, raw)
	}

	return newOpenAIProxy(openaiProxyConfig{
		APIKey:   apiKey,
		Policy:   policy,
		Upstream: upstream,
		Org:      os.Getenv("OPENAI_ORG"),
		Project:  os.Getenv("OPENAI_PROJECT"),
	})
}

func newOpenAIProxy(cfg openaiProxyConfig) http.Handler {
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(cfg.Upstream)
			// Client already sends /v1/...; do not prepend /v1 like Vertex does.
			r.Out.URL.Path = r.In.URL.Path
			r.Out.URL.RawQuery = r.In.URL.RawQuery
			r.Out.Host = cfg.Upstream.Host
			r.Out.Header.Set("Authorization", "Bearer "+cfg.APIKey)
			r.Out.Header.Del("OpenAI-Organization")
			r.Out.Header.Del("OpenAI-Project")
			if cfg.Org != "" {
				r.Out.Header.Set("OpenAI-Organization", cfg.Org)
			}
			if cfg.Project != "" {
				r.Out.Header.Set("OpenAI-Project", cfg.Project)
			}
		},
		FlushInterval: -1,
		ModifyResponse: func(resp *http.Response) error {
			if err := stripSensitiveResponseHeaders(resp); err != nil {
				return err
			}
			recordOpenAIUsage(resp)
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("openai: upstream error: %v", err)
			http.Error(w, `{"error":"upstream unavailable"}`, http.StatusBadGateway)
		},
		Transport: cfg.Transport,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("GET /v1/models", func(w http.ResponseWriter, r *http.Request) {
		list := openaiModelList{Object: "list", Data: []openaiModelEntry{}}
		for _, m := range cfg.Policy.Models() {
			list.Data = append(list.Data, openaiModelEntry{ID: m, Object: "model", OwnedBy: "rehor"})
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(list); err != nil {
			log.Printf("openai: models encode error: %v", err)
		}
	})
	handleOpenAIRequest := func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()

		r.Body = http.MaxBytesReader(w, r.Body, maxChatRequestBytes)
		buf, err := io.ReadAll(r.Body)
		r.Body.Close()
		if err != nil {
			status := http.StatusBadRequest
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				status = http.StatusRequestEntityTooLarge
			}
			http.Error(w, `{"error":"unreadable request body"}`, status)
			log.Printf("openai: bad-body status=%d err=%v", status, err)
			OpenAIModelRequestsTotal.WithLabelValues("unknown", "bad_body").Inc()
			return
		}

		model, err := ExtractChatModel(buf)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusBadRequest)
			log.Printf("openai: bad-body err=%s", err)
			OpenAIModelRequestsTotal.WithLabelValues("unknown", "bad_body").Inc()
			return
		}
		if err := cfg.Policy.Check(model); err != nil {
			http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusForbidden)
			log.Printf("openai: policy-deny model=%s", model)
			OpenAIModelRequestsTotal.WithLabelValues(model, "denied").Inc()
			return
		}

		// Restore the body we consumed; the upstream POST must carry it.
		stream := chatStreamRequested(buf)
		r.Body = io.NopCloser(bytes.NewReader(buf))
		r.ContentLength = int64(len(buf))
		r = r.WithContext(context.WithValue(r.Context(), openaiModelKey, model))

		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		proxy.ServeHTTP(rec, r)
		OpenAIModelRequestsTotal.WithLabelValues(model, strconv.Itoa(rec.status)).Inc()

		log.Printf("openai: model=%s stream=%t status=%d req_id=%s size=%d dur=%s",
			model, stream, rec.status, w.Header().Get("X-Request-Id"), len(buf),
			time.Since(start).Round(time.Millisecond))
	}
	mux.HandleFunc("POST /v1/chat/completions", handleOpenAIRequest)
	mux.HandleFunc("POST /v1/responses", handleOpenAIRequest)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"path not allowed"}`, http.StatusNotFound)
		log.Printf("openai: path-not-allowed method=%s path=%s", r.Method, r.URL.Path)
		OpenAIModelRequestsTotal.WithLabelValues("unknown", "bad_path").Inc()
	})

	return mux
}

// chatStreamRequested reports whether the payload asked for SSE. Only used for
// the log line; a parse failure is not an error at this point.
func chatStreamRequested(body []byte) bool {
	var payload struct {
		Stream bool `json:"stream"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return false
	}
	return payload.Stream
}

// recordOpenAIUsage scrapes token counts from a non-streaming JSON response.
// Streaming bodies are left untouched so Flush is never delayed; missing usage
// is not an error.
func recordOpenAIUsage(resp *http.Response) {
	model, _ := resp.Request.Context().Value(openaiModelKey).(string)
	if model == "" {
		return
	}
	if !strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") {
		return
	}
	if resp.ContentLength > maxUsageScrapeBytes {
		return
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxUsageScrapeBytes))
	resp.Body.Close()
	resp.Body = io.NopCloser(bytes.NewReader(body))
	if err != nil {
		return
	}

	var payload struct {
		Usage struct {
			PromptTokens     float64 `json:"prompt_tokens"`
			CompletionTokens float64 `json:"completion_tokens"`
			InputTokens      float64 `json:"input_tokens"`
			OutputTokens     float64 `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return
	}
	prompt := payload.Usage.PromptTokens
	if prompt == 0 {
		prompt = payload.Usage.InputTokens
	}
	completion := payload.Usage.CompletionTokens
	if completion == 0 {
		completion = payload.Usage.OutputTokens
	}
	if prompt > 0 {
		OpenAITokensTotal.WithLabelValues(model, "prompt").Add(prompt)
	}
	if completion > 0 {
		OpenAITokensTotal.WithLabelValues(model, "completion").Add(completion)
	}
}

func ValidateOpenAIConfig(apiKey string, policy *OpenAIPolicy) error {
	if apiKey == "" {
		return fmt.Errorf("OPENAI_API_KEY is required")
	}
	if policy == nil || len(policy.allowed) == 0 {
		return fmt.Errorf("OPENAI_ALLOWED_MODELS must list at least one model")
	}
	return nil
}
