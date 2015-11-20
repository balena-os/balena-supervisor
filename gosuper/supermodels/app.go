package supermodels

import (
	"encoding/json"
	"reflect"
	"strconv"

	"resin-supervisor/gosuper/Godeps/_workspace/src/github.com/boltdb/bolt"
)

type AppsCollection struct {
	db *bolt.DB
}

type App struct {
	AppId       int
	Commit      string
	ContainerId string
	Env         map[string]string
	ImageId     string
}

// Create or update an App in the database (identified by its AppId)
func (apps *AppsCollection) CreateOrUpdate(app *App) error {
	return apps.db.Update(func(tx *bolt.Tx) (err error) {
		if jsonApp, err := json.Marshal(app); err == nil {
			b := tx.Bucket([]byte("Apps"))
			err = b.Put([]byte(strconv.Itoa(app.AppId)), jsonApp)
		}
		return
	})
}

// Delete an App from the database (identified by its AppId)
func (apps *AppsCollection) Destroy(app *App) error {
	return apps.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("Apps"))
		return b.Delete([]byte(strconv.Itoa(app.AppId)))
	})
}

// Get an App from the database (identified by its AppId)
func (apps *AppsCollection) Get(app *App) error {
	return apps.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("Apps"))
		v := b.Get([]byte(strconv.Itoa(app.AppId)))
		if v == nil {
			v = []byte("{}")
		}
		p := reflect.ValueOf(app).Elem()
		p.Set(reflect.Zero(p.Type()))
		return json.Unmarshal(v, app)
	})
}

type AppCallback func(*App) error

// Get an App from the database (identified by its AppId) and execute a callback within a transaction.
// The app struct will be populated with the App and then passed to the callback, so the contents of
// the passed struct can be modified by the callback too.
func (apps *AppsCollection) GetAndDo(app *App, callback AppCallback) error {
	return apps.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("Apps"))
		v := b.Get([]byte(strconv.Itoa(app.AppId)))
		if v == nil {
			v = []byte("{}")
		}
		p := reflect.ValueOf(app).Elem()
		p.Set(reflect.Zero(p.Type()))
		if err := json.Unmarshal(v, app); err != nil {
			return err
		} else {
			return callback(app)
		}
	})
}
