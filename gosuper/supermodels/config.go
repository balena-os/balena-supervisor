package supermodels

import (
	"resin-supervisor/gosuper/Godeps/_workspace/src/github.com/boltdb/bolt"
)

type Config struct {
}

// Get a config value from the database.
func (config Config) Get(key string) (value string, err error) {
	err = Database.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("Config"))
		value = string(b.Get([]byte(key)))
		return nil
	})
	return
}

// Set a config value in the database.
func (config Config) Set(key string, val string) (err error) {
	err = Database.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("Config"))
		return b.Put([]byte(key), []byte(val))
	})
	return
}
