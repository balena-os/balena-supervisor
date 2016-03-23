// pinejs implements an interface to pine.js
// See https://bitbucket.org/rulemotion/pinejs
package pinejs

import (
	"errors"
	"io"
	"log"
	"os"
)

// The current implementation version.
func Version() string {
	return "0.0.5"
}

const (
	logFlags      = log.Ldate | log.Ltime
	logFlagsDebug = logFlags | log.Lshortfile
)

var (
	logAlert = log.New(os.Stderr, "", logFlags)
	logDebug *log.Logger // Defaults to /dev/null in init()
	nullFile *os.File
)

func init() {
	var err error
	if nullFile, err = os.Open(os.DevNull); err != nil {
		ShowDebugOutput()
		logDebug.Printf("Can't open null output at %s, defaulting to debug logs on.",
			os.DevNull)
	} else {
		// Default to no debug output.
		logDebug = log.New(nullFile, "", 0)
	}
}

// ShowDebugOutput enables the debug logger, outputting to stderr.
func ShowDebugOutput() {
	if nullFile != nil {
		nullFile.Close()
		nullFile = nil
	}

	logDebug = log.New(os.Stderr, "", logFlagsDebug)
}

// Client represents an HTTP client to a pine.js server.
type Client struct {
	APIKey, Endpoint string
	reader           io.Reader
}

// NewClient returns a client initialised to the provided endpoint and API key.
func NewClient(endpoint, apiKey string) *Client {
	return &Client{apiKey, endpoint, nil}
}

// Get returns data from the pine.js client for a particular resource and places
// it into the provided v interface. Optionally, query options can be set on the
// data.
//
// Get expects v to be a pointer to a struct, and there to be an Id field set to
// a valid id (i.e. non-zero.)
//
// Get determines the name of resource to retrieve from a pinejs tag placed on
// any field in the struct, or if this is not present, the struct name in lower
// case.
//
// Data is decoded using the standard library's encoding/json package, so ensure
// to export all fields you wish to decode to and set json tags as appropriate.
//
// Additionally, if you plan to later write data, you ought to set the omitempty
// tag on id fields. See resin/resin.go for a good example of how to accomplish
// all this.
//
// Currently, if one of the fields you import is an unexpanded nested struct,
// the library will simply set the Id field and expect you to manually request
// the rest of the struct's data.
func (c *Client) Get(v interface{}, queryOptions ...QueryOption) error {
	if _, err := isPointerToStruct(v); err != nil {
		return err
	}

	if omitted, err := isIdOmitted(v); err != nil {
		return err
	} else if omitted {
		return errors.New("id not set")
	}

	if path, err := getSinglePath(v); err != nil {
		return err
	} else if data, err := c.request("GET", path, nil, QueryOptions(queryOptions)); err != nil {
		return err
	} else {
		return decode(v, data, first)
	}
}

// List returns all elements of a specific resource according to the query
// options specified, if any.
//
// List expects v to be a pointer to a slice of structs.
//
// See Get for further details.
func (c *Client) List(v interface{}, queryOptions ...QueryOption) error {
	if _, err := isPointerToSliceStructs(v); err != nil {
		return err
	} else if name, err := resourceName(v); err != nil {
		return err
	} else if data, err := c.request("GET", name, nil, QueryOptions(queryOptions)); err != nil {
		return err
	} else {
		return decode(v, data, theD)
	}
}

// Read choose to Get or List depending on the type of v - Get if v is a pointer
// to a struct, List if v is a pointer to a slice.
//
// See Get and List for further details.
func (c *Client) Read(v interface{}, queryOptions ...QueryOption) error {
	if isSlice, _ := isPointerToSliceStructs(v); isSlice {
		return c.List(v, queryOptions...)
	} else if isStruct, _ := isPointerToStruct(v); isStruct {
		return c.Get(v, queryOptions...)
	}

	return errors.New("not a pointer to a struct or slice")
}

// Create generates a new entity of a specific resource, and populates fields as
// they are in the database, including Id.
//
// Create expects v to be a pointer to a struct.
//
// See Get for further details.
func (c *Client) Create(v interface{}, queryOptions ...QueryOption) error {
	if _, err := isPointerToStruct(v); err != nil {
		return err
	}

	if id, err := resourceId(v); err != nil {
		return err
	} else if id > 0 {
		return errors.New("attempting to create with id set")
	}

	if name, err := resourceName(v); err != nil {
		return err
	} else if data, err := c.request("POST", name, v, QueryOptions(queryOptions)); err != nil {
		return err
	} else {
		return decode(v, data, self)
	}
}

// Update updates a specific resource's entity given a specific id. All fields
// are overwritten. If an entity with the specific id doesn't already exist, it
// is created.
//
// Update expects v to be a pointer to a struct, and there to be an Id field set to
// a valid id (i.e. non-zero.)
//
// See Get for further details.
func (c *Client) Update(v interface{}) error {
	if _, err := isPointerToStruct(v); err != nil {
		return err
	}

	if omitted, err := isIdOmitted(v); err != nil {
		return err
	} else if omitted {
		return errors.New("id not set")
	}

	if path, err := getSinglePath(v); err != nil {
		return err
	} else if _, err := c.request("PUT", path, v, nil); err != nil {
		return err
	}

	return nil
}

// Patch updates a specific resource's entity given a specific id, updating only
// the specified fields.
//
// Patch expects v to be a pointer to a struct, and there to be an Id field set to
// a valid id (i.e. non-zero.)
//
// See Get for further details.
func (c *Client) Patch(v interface{}) error {
	if _, err := isPointerToStruct(v); err != nil {
		return err
	}

	if omitted, err := isIdOmitted(v); err != nil {
		return err
	} else if omitted {
		return errors.New("id not set")
	}

	if path, err := getSinglePath(v); err != nil {
		return err
	} else if _, err := c.request("PATCH", path, v, nil); err != nil {
		return err
	}

	return nil
}

// Deletes deletes a specific resource's entity given a specific id.
//
// Delete expects v to be a pointer to a struct, and there to be an Id field set to
// a valid id (i.e. non-zero.)
//
// See Get for further details.
func (c *Client) Delete(v interface{}) error {
	if _, err := isPointerToStruct(v); err != nil {
		return err
	}

	if omitted, err := isIdOmitted(v); err != nil {
		return err
	} else if omitted {
		return errors.New("id not set")
	}

	if path, err := getSinglePath(v); err != nil {
		return err
	} else if _, err := c.request("DELETE", path, v, nil); err != nil {
		return err
	}

	return nil
}
