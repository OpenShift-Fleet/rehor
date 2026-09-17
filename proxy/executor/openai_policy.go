package executor

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
)

type OpenAIPolicy struct {
	allowed map[string]bool
}

func NewOpenAIPolicy(models []string) *OpenAIPolicy {
	p := &OpenAIPolicy{allowed: make(map[string]bool, len(models))}
	for _, m := range models {
		m = strings.TrimSpace(m)
		if m != "" {
			p.allowed[m] = true
		}
	}
	return p
}

// OpenAIPolicyFromEnv reads OPENAI_ALLOWED_MODELS (comma-separated).
// Returns nil if the env var is empty — caller must provide models.
func OpenAIPolicyFromEnv() *OpenAIPolicy {
	env := os.Getenv("OPENAI_ALLOWED_MODELS")
	if env == "" {
		return nil
	}
	return NewOpenAIPolicy(strings.Split(env, ","))
}

func (p *OpenAIPolicy) Check(model string) error {
	if p == nil || !p.allowed[model] {
		return fmt.Errorf("model not allowed: %s", model)
	}
	return nil
}

// Models returns the allowlisted model IDs, sorted, for GET /v1/models.
func (p *OpenAIPolicy) Models() []string {
	if p == nil {
		return nil
	}
	out := make([]string, 0, len(p.allowed))
	for m := range p.allowed {
		out = append(out, m)
	}
	sort.Strings(out)
	return out
}

// ExtractChatModel reads the "model" field from a Chat Completions or
// Responses request body. It never logs or returns any other part of the payload.
func ExtractChatModel(body []byte) (string, error) {
	var payload struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", fmt.Errorf("invalid JSON body")
	}
	if payload.Model == "" {
		return "", fmt.Errorf("missing model")
	}
	return payload.Model, nil
}
