package pinejs

import (
	"fmt"
	"io/ioutil"
	"net/http"
	"net/url"
	"strings"
)

func (c *Client) sanitisePath(path string) (string, error) {
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}

	// Strip host information so we request /foo/bar rather than
	// http://example.com/foo/bar. This affects the GET header and failing to do
	// this can cause the server to erroneously 404.
	//
	// We generate a URL combining the endpoint and the provided path so we pick
	// up all of the path to request, e.g. endpoint
	// 'http://example.com/foo/bar/baz', path '/gwargh/fwargh/mwargh' should
	// produce a sanitised path of '/foo/bar/baz/gwargh/fwargh/mwargh'.
	if u, err := url.Parse(c.Endpoint + path); err != nil {
		return "", err
	} else {
		return u.Path, nil
	}
}

// Mutate input request and set path as requested, accounting for issues arising
// with server redirects corrupting queries.
func preprocessRequest(req *http.Request, path string, query map[string][]string) {
	// Identify ourselves.
	req.Header.Add("User-Agent", "PineJS/v1 GoBindings/"+Version())

	// Need to use Opaque to prevent redirects causing invalid encoding of the
	// query string.
	req.URL.Opaque = path + encodeQuery(query)
}

// request performs an HTTP request using the specific method, path, input
// interface and query options, and returns the response.
//
// If the method writes data the function marshals the input data into JSON and
// sends it as MIME type application/json.
//
// Any specified query optinos are encoded as a query string with special
// handling to prevent encoding of keys (something Go's net/url library likes to
// do.)
func (c *Client) request(method, path string, v interface{}, queryOptions QueryOptions) ([]byte, error) {
	if body, err := toJsonReader(v); err != nil {
		return nil, err
	} else if path, err := c.sanitisePath(path); err != nil {
		return nil, err
	} else if req, err := http.NewRequest(method, c.Endpoint, body); err != nil {
		return nil, err
	} else {
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}

		query := make(map[string][]string)
		if queryOptions != nil {
			for key, val := range queryOptions.toMap() {
				query[key] = val
			}
		}

		if c.APIKey != "" {
			query["apikey"] = []string{c.APIKey}
		}

		preprocessRequest(req, path, query)

		logDebug.Printf("Requesting %s %s\n", method, req.URL)
		if res, err := http.DefaultClient.Do(req); err != nil {
			return nil, err
		} else {
			defer res.Body.Close()

			if data, err := ioutil.ReadAll(res.Body); err != nil {
				return nil, err
			} else if res.StatusCode/100 != 2 && res.StatusCode != http.StatusNotModified {
				return nil, fmt.Errorf("%d: %s", res.StatusCode, data)
			} else {
				return data, nil
			}
		}
	}
}
