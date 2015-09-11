package supermodels

import (
	"resin-supervisor/gosuper/Godeps/_workspace/src/github.com/boltdb/bolt"
)

var Database *bolt.DB

func Initialize() (apps AppsCollection, config Config, err error) {
	Database, err = bolt.Open("/data/resin-supervisor.db", 0600, nil)
	return
}
