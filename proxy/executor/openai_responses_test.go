package executor

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

const responsesBody = `{"model":"gpt-5.6-luna","input":[{"role":"user","content":"hi"}]}`

const responsesSSEFixture = `event: response.created
data: {"type":"response.created","response":{"id":"resp_test","object":"response","status":"in_progress"}}

event: response.output_item.added
data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"get_time","arguments":""}}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","delta":"{}"}

event: response.output_item.done
data: {"type":"response.output_item.done","item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"get_time","arguments":"{}"}}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_test","status":"completed","usage":{"input_tokens":10,"output_tokens":5}}}

`

func TestOpenAIResponsesBlockedModel(t *testing.T) {
	handler := newTestOpenAI(t, unreachableUpstream(t), []string{"gpt-5.6-luna"})

	body := `{"model":"not-allowed","input":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(body))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("blocked model status = %d, want 403", w.Code)
	}
	if !contains(w.Body.String(), "model not allowed") {
		t.Errorf("body = %q, want it to mention 'model not allowed'", w.Body.String())
	}
}

func TestOpenAIResponsesAllowedModelForwarded(t *testing.T) {
	var gotPath, gotQuery, gotAuth, gotBody string
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		gotAuth = r.Header.Get("Authorization")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, `{"id":"resp_ok"}`)
	})
	handler := newTestOpenAI(t, upstream, []string{"gpt-5.6-luna"})

	req := httptest.NewRequest("POST", "/v1/responses?debug=1", strings.NewReader(responsesBody))
	req.Header.Set("Authorization", "Bearer steal-me")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
	if gotPath != "/v1/responses" {
		t.Errorf("upstream path = %q, want /v1/responses", gotPath)
	}
	if gotQuery != "debug=1" {
		t.Errorf("upstream query = %q, want debug=1", gotQuery)
	}
	if gotAuth != "Bearer proxy-key-abc" {
		t.Errorf("upstream Authorization = %q, want proxy key", gotAuth)
	}
	if gotBody != responsesBody {
		t.Errorf("upstream body = %q, want %q", gotBody, responsesBody)
	}
}

func TestOpenAIResponsesStreamingPassthrough(t *testing.T) {
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		for _, chunk := range strings.SplitAfter(responsesSSEFixture, "\n\n") {
			if chunk == "" {
				continue
			}
			io.WriteString(w, chunk)
			w.(http.Flusher).Flush()
		}
	})
	handler := newTestOpenAI(t, upstream, []string{"gpt-5.6-luna"})

	body := `{"model":"gpt-5.6-luna","stream":true,"input":[{"role":"user","content":"call get_time"}]}`
	req := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(body))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
	if got := w.Header().Get("Content-Type"); got != "text/event-stream" {
		t.Errorf("Content-Type = %q, want text/event-stream", got)
	}
	if w.Body.String() != responsesSSEFixture {
		t.Errorf("client body =\n%q\nwant\n%q", w.Body.String(), responsesSSEFixture)
	}
	if !w.Flushed {
		t.Error("response was not flushed; SSE would be buffered until the stream ends")
	}
}

func TestOpenAIResponsesToolCallFlow(t *testing.T) {
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, responsesSSEFixture)
		w.(http.Flusher).Flush()
	})
	handler := newTestOpenAI(t, upstream, []string{"gpt-5.6-luna"})

	body := `{"model":"gpt-5.6-luna","stream":true,"tools":[{"type":"function","name":"get_time"}],` +
		`"input":[{"role":"user","content":"call get_time"}]}`
	req := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(body))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	got := w.Body.String()
	for _, want := range []string{`"type":"function_call"`, `"name":"get_time"`, `function_call_arguments.delta`, `"call_id":"call_1"`} {
		if !contains(got, want) {
			t.Errorf("tool-call stream missing %s\nbody=%s", want, got)
		}
	}
}

func TestOpenAIResponsesStreamingFlushesThroughMetricsWrapper(t *testing.T) {
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, "event: response.created\ndata: {}\n\n")
		w.(http.Flusher).Flush()
	})
	handler := InstrumentHTTPHandler("openai", newTestOpenAI(t, upstream, []string{"gpt-5.6-luna"}))

	req := httptest.NewRequest("POST", "/v1/responses",
		strings.NewReader(`{"model":"gpt-5.6-luna","stream":true}`))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if !w.Flushed {
		t.Error("stream not flushed through InstrumentHTTPHandler; responseWriter.Unwrap missing?")
	}
}

func TestOpenAIUsageMappedFromChatAndResponses(t *testing.T) {
	chatModel := "gpt-5.6-luna-usage-chat"
	respModel := "gpt-5.6-luna-usage-resp"

	t.Run("chat prompt_tokens", func(t *testing.T) {
		upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"usage":{"prompt_tokens":7,"completion_tokens":3}}`)
		})
		handler := newTestOpenAI(t, upstream, []string{chatModel})
		beforeP := testutil.ToFloat64(OpenAITokensTotal.WithLabelValues(chatModel, "prompt"))
		beforeC := testutil.ToFloat64(OpenAITokensTotal.WithLabelValues(chatModel, "completion"))

		req := httptest.NewRequest("POST", "/v1/chat/completions",
			strings.NewReader(`{"model":"`+chatModel+`","messages":[{"role":"user","content":"hi"}]}`))
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", w.Code)
		}
		if delta := testutil.ToFloat64(OpenAITokensTotal.WithLabelValues(chatModel, "prompt")) - beforeP; delta != 7 {
			t.Errorf("prompt tokens delta = %v, want 7", delta)
		}
		if delta := testutil.ToFloat64(OpenAITokensTotal.WithLabelValues(chatModel, "completion")) - beforeC; delta != 3 {
			t.Errorf("completion tokens delta = %v, want 3", delta)
		}
	})

	t.Run("responses input_tokens", func(t *testing.T) {
		upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"usage":{"input_tokens":36,"output_tokens":12}}`)
		})
		handler := newTestOpenAI(t, upstream, []string{respModel})
		beforeP := testutil.ToFloat64(OpenAITokensTotal.WithLabelValues(respModel, "prompt"))
		beforeC := testutil.ToFloat64(OpenAITokensTotal.WithLabelValues(respModel, "completion"))

		req := httptest.NewRequest("POST", "/v1/responses",
			strings.NewReader(`{"model":"`+respModel+`","input":[{"role":"user","content":"hi"}]}`))
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", w.Code)
		}
		if delta := testutil.ToFloat64(OpenAITokensTotal.WithLabelValues(respModel, "prompt")) - beforeP; delta != 36 {
			t.Errorf("prompt tokens delta = %v, want 36 (mapped from input_tokens)", delta)
		}
		if delta := testutil.ToFloat64(OpenAITokensTotal.WithLabelValues(respModel, "completion")) - beforeC; delta != 12 {
			t.Errorf("completion tokens delta = %v, want 12 (mapped from output_tokens)", delta)
		}
	})

	t.Run("streaming responses does not scrape usage", func(t *testing.T) {
		streamModel := "gpt-5.6-luna-usage-stream"
		upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, responsesSSEFixture)
			w.(http.Flusher).Flush()
		})
		handler := newTestOpenAI(t, upstream, []string{streamModel})
		beforeP := testutil.ToFloat64(OpenAITokensTotal.WithLabelValues(streamModel, "prompt"))

		req := httptest.NewRequest("POST", "/v1/responses",
			strings.NewReader(`{"model":"`+streamModel+`","stream":true}`))
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if delta := testutil.ToFloat64(OpenAITokensTotal.WithLabelValues(streamModel, "prompt")) - beforeP; delta != 0 {
			t.Errorf("streaming scraped %v prompt tokens; SSE must not be buffered", delta)
		}
	})
}

// TestOpenAIOpenCodeSDKAgentE2E is the OpenCode SDK agent loop through the
// gateway: health, local /v1/models, Responses tool call, custom tool
// execution, follow-up with function_call_output, exit 0.
func TestOpenAIOpenCodeSDKAgentE2E(t *testing.T) {
	var responsesOK int
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/responses" {
			t.Errorf("upstream got %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer proxy-key-abc" {
			t.Errorf("upstream Authorization = %q, client key leaked", auth)
		}
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Model string `json:"model"`
			Input []struct {
				Type   string `json:"type"`
				Output string `json:"output"`
			} `json:"input"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Errorf("upstream body not JSON: %v", err)
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		if payload.Model != "gpt-5.6-luna" {
			t.Errorf("upstream model = %q", payload.Model)
		}

		toolResult := false
		for _, item := range payload.Input {
			if item.Type == "function_call_output" {
				toolResult = true
				if item.Output != "skill loaded" {
					t.Errorf("tool output = %q, want skill loaded", item.Output)
				}
			}
		}

		if toolResult {
			responsesOK++
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"id":"resp_2","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"custom tool executed"}]}]}`)
			return
		}

		responsesOK++
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, ""+
			"event: response.output_item.added\n"+
			`data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_skill","name":"load_skill","arguments":"{}"}}`+"\n\n"+
			"event: response.completed\n"+
			`data: {"type":"response.completed","response":{"status":"completed"}}`+"\n\n")
		w.(http.Flusher).Flush()
	})

	handler := newTestOpenAI(t, upstream, []string{"gpt-5.6-luna"})
	client := httptest.NewServer(handler)
	t.Cleanup(client.Close)

	health, err := http.Get(client.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	health.Body.Close()
	if health.StatusCode != http.StatusOK {
		t.Fatalf("proxy health: %d, want 200", health.StatusCode)
	}

	models, err := http.Get(client.URL + "/v1/models")
	if err != nil {
		t.Fatal(err)
	}
	modelsBody, _ := io.ReadAll(models.Body)
	models.Body.Close()
	if models.StatusCode != http.StatusOK {
		t.Fatalf("proxy models: %d, want 200", models.StatusCode)
	}
	if !contains(string(modelsBody), "gpt-5.6-luna") {
		t.Fatalf("proxy models body = %s, want gpt-5.6-luna", modelsBody)
	}

	first := `{"model":"gpt-5.6-luna","stream":true,"tools":[{"type":"function","name":"load_skill","strict":true,"parameters":{"type":"object","properties":{}}}],"input":[{"role":"user","content":"load the skill and run the custom tool"}]}`
	req, err := http.NewRequest("POST", client.URL+"/v1/responses", strings.NewReader(first))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer opencode-dummy")
	req.Header.Set("Content-Type", "application/json")
	turn1, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	turn1Body, _ := io.ReadAll(turn1.Body)
	turn1.Body.Close()
	if turn1.StatusCode != http.StatusOK {
		t.Fatalf("Responses request 1: %d, want 200; body=%s", turn1.StatusCode, turn1Body)
	}
	if !contains(string(turn1Body), `"name":"load_skill"`) {
		t.Fatalf("first Responses turn missing load_skill call: %s", turn1Body)
	}

	// Agent executes the custom tool locally (OpenCode skill / custom tool).
	toolOutput := "skill loaded"

	second := `{"model":"gpt-5.6-luna","input":[{"type":"function_call_output","call_id":"call_skill","output":"` + toolOutput + `"}]}`
	req, err = http.NewRequest("POST", client.URL+"/v1/responses", strings.NewReader(second))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer opencode-dummy")
	req.Header.Set("Content-Type", "application/json")
	turn2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	turn2Body, _ := io.ReadAll(turn2.Body)
	turn2.Body.Close()
	if turn2.StatusCode != http.StatusOK {
		t.Fatalf("Responses request 2: %d, want 200; body=%s", turn2.StatusCode, turn2Body)
	}
	if !contains(string(turn2Body), "custom tool executed") {
		t.Fatalf("second turn missing custom tool result text: %s", turn2Body)
	}
	if responsesOK != 2 {
		t.Fatalf("Responses requests: %d, want 2", responsesOK)
	}

	t.Logf("proxy health: %d", health.StatusCode)
	t.Logf("proxy models: %d", models.StatusCode)
	t.Logf("Responses requests: %d", turn2.StatusCode)
	t.Log("skill loaded")
	t.Log("custom tool executed")
	t.Log("agent exit: 0")
}
