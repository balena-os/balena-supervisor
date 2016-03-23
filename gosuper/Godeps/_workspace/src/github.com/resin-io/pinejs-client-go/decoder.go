package pinejs

import (
	"bytes"
	"encoding/json"
	"errors"
	"reflect"

	"resin-supervisor/gosuper/Godeps/_workspace/src/github.com/bitly/go-simplejson"
)

// Walk the input JSON, checking for any case where the field to be written is a
// struct or pointer to a struct, but the source is deferred as defined by
// checkDeferred(), and set id field to unmarshal later.
func walkJson(parent *simplejson.Json) error {
	switch getJsonNodeType(parent) {
	case jsonObject:
		if fs, err := getJsonFields(parent); err != nil {
			return err
		} else {
			for name, j := range fs {
				if id, deferred := checkDeferred(j); deferred {
					setDeferred(id, name, parent)
				} else {
					walkJson(j)
				}
			}
		}
	case jsonArray:
		if js, err := getJsonArray(parent); err != nil {
			return err
		} else {
			for _, j := range js {
				walkJson(j)
			}
		}
	}
	// Other fields do not need to be checked.
	return nil
}

// Check whether the specified object is in fact a deferred object - if so
// simply return the object's ID.
func checkDeferred(node *simplejson.Json) (int, bool) {
	if id, err := node.Get("__id").Int(); err != nil {
		return 0, false
	} else {
		return id, true
	}
}

type IdOnly struct {
	Id int `json:"id"`
}

func setDeferred(id int, name string, parent *simplejson.Json) {
	parent.Set(name, &IdOnly{id})
}

func unmarshal(v interface{}, j *simplejson.Json) error {
	if b, err := j.MarshalJSON(); err != nil {
		return err
	} else {
		r := bytes.NewReader(b)
		d := json.NewDecoder(r)
		return d.Decode(v)
	}
}

func decode(v interface{}, data []byte, predicate transformJSONFunc) error {
	if v == nil {
		// reflect.Typeof(nil) throws...
		return errors.New("nil interface")
	}

	ty := reflect.TypeOf(v)

	if ty.Kind() != reflect.Ptr {
		return errors.New("non-pointer target type")
	}

	if j, err := simplejson.NewJson(data); err != nil {
		return err
	} else {
		// Transform input JSON according to predicate.
		j = predicate(j)

		if j == nil {
			// Nothing to do.
			return nil
		}

		// Walk JSON looking for deferred structs and fixing them up.
		walkJson(j)

		return unmarshal(v, j)
	}
}

// Predicates

// These are used to transform input before attempting to unmarshal and vary
// depending on the caller.

type transformJSONFunc func(*simplejson.Json) *simplejson.Json

// Retrieve an array of data at field "d" from input json, or nil if doesn't
// exist.
func theD(j *simplejson.Json) *simplejson.Json {
	// Check we have data to get.
	if j == nil {
		return nil
	} else if _, has := j.CheckGet("d"); !has {
		return nil
	}

	return j.Get("d")
}

// Retrieve the first element of an array of data at field "d" from input json,
// or nil if doesn't exist.
func first(j *simplejson.Json) *simplejson.Json {
	if j = theD(j); j == nil {
		return nil
	} else if arr, err := j.Array(); err != nil || len(arr) == 0 {
		return nil
	}

	return j.GetIndex(0)
}

// Simply return the input json. Useful for the POST response which just echos
// the object back.
func self(j *simplejson.Json) *simplejson.Json {
	return j
}
