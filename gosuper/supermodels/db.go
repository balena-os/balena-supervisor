package supermodels

import (
	"fmt"

	"resin-supervisor/gosuper/Godeps/_workspace/src/github.com/boltdb/bolt"
)

var Database *bolt.DB
var allTheApps AppsCollection
var theConfig Config

func createBuckets(tx *bolt.Tx) error {
	_, err := tx.CreateBucketIfNotExists([]byte("Apps"))
	if err != nil {
		return fmt.Errorf("create Apps bucket: %s", err)
	}

	_, err = tx.CreateBucketIfNotExists([]byte("Config"))
	if err != nil {
		return fmt.Errorf("create Config bucket: %s", err)
	}
	return nil
}

func Initialize() (apps AppsCollection, config Config, err error) {
	if Database, err = bolt.Open("/data/resin-supervisor.db", 0600, nil); err != nil {
		return
	}
	apps = allTheApps
	config = theConfig
	err = Database.Update(createBuckets)
	return
}
