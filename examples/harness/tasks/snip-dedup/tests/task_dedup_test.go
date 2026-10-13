package filter

import (
	"reflect"
	"sort"
	"testing"
)

func TestDedupCountSuffix(t *testing.T) {
	res, err := dedup(lines("a", "a", "a", "b"), map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	got := append([]string{}, res.Lines...)
	sort.Strings(got)
	if want := []string{"a (x3)", "b"}; !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestDedupOrder(t *testing.T) {
	res, err := dedup(lines("b", "a", "a", "c", "c", "c"), map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"c (x3)", "a (x2)", "b"}; !reflect.DeepEqual(res.Lines, want) {
		t.Errorf("got %v, want %v", res.Lines, want)
	}
}

func TestDedupNormalize(t *testing.T) {
	res, err := dedup(lines("12:01 error x", "12:02 error x"), map[string]any{"normalize": []any{`^\d+:\d+`}})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"error x (x2)"}; !reflect.DeepEqual(res.Lines, want) {
		t.Errorf("got %v, want %v", res.Lines, want)
	}
}
