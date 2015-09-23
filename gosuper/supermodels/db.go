package supermodels

import (
	"fmt"

	"resin-supervisor/gosuper/Godeps/_workspace/src/github.com/boltdb/bolt"
)

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

func New(dbPath string) (*AppsCollection, *Config, error) {
	if db, err := bolt.Open(dbPath, 0600, nil); err != nil {
		return nil, nil, err
	} else if err = db.Update(createBuckets); err != nil {
		return nil, nil, err
	} else {
		apps := AppsCollection{db: db}
		config := Config{db: db}
		return &apps, &config, nil
	}
}
