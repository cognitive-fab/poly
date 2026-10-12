package filter

import (
	"reflect"
	"sort"
	"testing"
)

func TestGroupByCounts(t *testing.T) {
	in := lines("ERR a", "WARN b", "ERR c", "ERR d", "WARN e")
	res, err := groupBy(in, map[string]any{"pattern": `^(\w+)`})
	if err != nil {
		t.Fatal(err)
	}
	got := append([]string{}, res.Lines...)
	sort.Strings(got)
	if want := []string{"ERR: 3", "WARN: 2"}; !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestAggregateOutput(t *testing.T) {
	in := lines("PASS foo", "FAIL bar", "PASS baz", "PASS qux", "FAIL quux")
	res, err := aggregate(in, map[string]any{"patterns": map[string]any{"pass": `^PASS`, "fail": `^FAIL`}})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"fail: 2", "pass: 3"}; !reflect.DeepEqual(res.Lines, want) {
		t.Errorf("got %v, want %v", res.Lines, want)
	}
}
