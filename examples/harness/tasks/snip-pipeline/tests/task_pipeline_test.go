package engine

import (
	"strings"
	"testing"

	"github.com/edouard-claude/snip/internal/filter"
)

func TestApplyPipelineTrailingNewline(t *testing.T) {
	out, err := ApplyPipeline(&filter.Filter{Name: "t"}, "a\nb\n")
	if err != nil {
		t.Fatal(err)
	}
	if out != "a\nb\n" {
		t.Errorf("got %q, want %q", out, "a\nb\n")
	}
	out, err = ApplyPipeline(&filter.Filter{Name: "t"}, "a\nb")
	if err != nil {
		t.Fatal(err)
	}
	if out != "a\nb\n" {
		t.Errorf("without a final newline: got %q, want %q", out, "a\nb\n")
	}
}

func TestApplyPipelineErrorWrap(t *testing.T) {
	f := &filter.Filter{Name: "t", Pipeline: filter.Pipeline{{ActionName: "keep_lines", Params: map[string]any{}}}}
	_, err := ApplyPipeline(f, "x\n")
	if err == nil || !strings.Contains(err.Error(), "pipeline[0] keep_lines") {
		t.Fatalf("want an error naming pipeline[0] keep_lines, got %v", err)
	}
}
