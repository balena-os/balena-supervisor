package mixpanel

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
)

// The Mixapanel struct store the mixpanel endpoint and the project token
type Mixpanel struct {
	Token  string
	ApiURL string
}

// People represents a consumer, and is used on People Analytics
type People struct {
	m  *Mixpanel
	id string
}

type trackParams struct {
	Event      string                 `json:"event"`
	Properties map[string]interface{} `json:"properties"`
}

// Track create a events to current distinct id
func (m *Mixpanel) Track(distinctId string, eventName string,
	properties map[string]interface{}) (*http.Response, error) {
	params := trackParams{Event: eventName}

	params.Properties = make(map[string]interface{}, 0)
	params.Properties["token"] = m.Token
	params.Properties["distinct_id"] = distinctId

	for key, value := range properties {
		params.Properties[key] = value
	}

	return m.send("track", params)
}

// Identify call mixpanel 'engage' and returns People instance
func (m *Mixpanel) Identify(id string) *People {
	params := map[string]interface{}{"$token": m.Token, "$distinct_id": id}
	m.send("engage", params)
	return &People{m: m, id: id}
}

// Track create a events to current people
func (p *People) Track(eventName string, properties map[string]interface{}) (*http.Response, error) {
	return p.m.Track(p.id, eventName, properties)
}

// Create a Update Operation to current people, see https://mixpanel.com/help/reference/http
func (p *People) Update(operation string, updateParams map[string]interface{}) (*http.Response, error) {
	params := map[string]interface{}{
		"$token":       p.m.Token,
		"$distinct_id": p.id,
	}
	params[operation] = updateParams
	return p.m.send("engage", params)
}

func (m *Mixpanel) to64(data string) string {
	bytes := []byte(data)
	return base64.StdEncoding.EncodeToString(bytes)
}

func (m *Mixpanel) send(eventType string, params interface{}) (*http.Response, error) {

	dataJSON, _ := json.Marshal(params)
	data := string(dataJSON)

	url := m.ApiURL + "/" + eventType + "?data=" + m.to64(data)
	return http.Get(url)
}

// NewMixpanel returns the client instance
func NewMixpanel(token string) *Mixpanel {
	return &Mixpanel{
		Token:  token,
		ApiURL: "https://api.mixpanel.com",
	}
}
