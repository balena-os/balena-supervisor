package pinejs

import "fmt"

// QueryOptionType specifies the OData query option you wish to use.
type QueryOptionType int

const (
	Expand QueryOptionType = iota
	Filter
	Select
)

// String returns the OData $-prefixed name for the query option.
func (qt QueryOptionType) String() string {
	switch qt {
	case Expand:
		return "$expand"
	case Filter:
		return "$filter"
	case Select:
		return "$select"
	}

	return fmt.Sprintf("?Unknown Type?: %d", qt)
}

type QueryOption struct {
	Type    QueryOptionType
	Content []string
}

// QueryOptions is a collection of OData query options.
type QueryOptions []QueryOption

func (qs QueryOptions) toMap() map[string][]string {
	ret := make(map[string][]string)

	for _, q := range qs {
		name := q.Type.String()
		ret[name] = append(ret[name], q.Content...)
	}

	return ret
}

func parseQueryOption(queryOption, aVal interface{}) *QueryOption {
	var strs []string

	switch val := aVal.(type) {
	case string:
		strs = []string{val}
	case []string:
		strs = val
	case nil:
		return nil
	}

	return &QueryOption{queryOption.(QueryOptionType), strs}
}

// NewQueryOptions is a convenience function for inputting query options.
//
// Use it where QueryOptions are expected, e.g.:-
// NewQueryOptions(pinejs.Expand, []string {"foo", "bar"}, pinejs.Select, "bar", etc.)
//
// Values can either be specified as a string or an array of strings.
func NewQueryOptions(pairs ...interface{}) QueryOptions {
	if len(pairs) < 2 {
		return nil
	}

	var ret QueryOptions
	for i := 0; i < len(pairs)-1; i += 2 {
		if ptr := parseQueryOption(pairs[i], pairs[i+1]); ptr == nil {
			continue
		} else {
			ret = append(ret, *ptr)
		}
	}

	return ret
}
