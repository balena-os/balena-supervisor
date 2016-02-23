package supermodels

import (
	"github.com/boltdb/bolt"
)

type Config struct {
	db *bolt.DB
}

// Get a config value from the database.
func (config Config) Get(key string) (value string, err error) {
	err = config.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("Config"))
		value = string(b.Get([]byte(key)))
		return nil
	})
	return
}

// Set a config value in the database.
func (config Config) Set(key string, val string) (err error) {
	err = config.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("Config"))
		return b.Put([]byte(key), []byte(val))
	})
	return
}

func (config Config) SetBatch(keyvals map[string]string) (err error) {
	err = config.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("Config"))
		for key, val := range keyvals {
			if e := b.Put([]byte(key), []byte(val)); e != nil {
				return e
			}
		}
		return nil
	})
	return
}
