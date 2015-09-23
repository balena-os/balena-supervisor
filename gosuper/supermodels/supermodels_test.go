package supermodels

import (
	"log"
	"os"
	"reflect"
	"testing"
)

var apps *AppsCollection
var config *Config

func TestMain(m *testing.M) {
	var err error
	if err = os.MkdirAll("/data", 0755); err != nil {
		log.Fatal("Could not create test directory for supermodels")
	} else if apps, config, err = New("/data/resin-supervisor.db"); err != nil {
		log.Fatal(err)
	} else {
		os.Exit(m.Run())
	}
}

func TestAppCreateGetDestroy(t *testing.T) {
	app := App{AppId: 1234, Commit: "abcd45678", ImageId: "registry.resin.io/hi/abcd45678", Env: map[string]string{"TESTING": "true", "SUCCESS": "hope so"}}
	if err := apps.CreateOrUpdate(&app); err != nil {
		t.Fatal(err)
	} else {
		app2 := App{AppId: 1234}
		if err = apps.Get(&app2); err != nil {
			t.Fatal(err)
		} else if app.AppId != app2.AppId || app.Commit != app2.Commit || app.ImageId != app2.ImageId || !reflect.DeepEqual(app.Env, app2.Env) {
			t.Fatalf("Saved app and recovered app do not match, expected:\n%v\nGot:\n%v\n", app, app2)
		} else if err = apps.Destroy(&app2); err != nil {
			t.Fatal(err)
		} else if err = apps.Get(&app2); err != nil {
			t.Fatal(err)
		} else if app2.AppId != 0 {
			t.Fatalf("App destroy didn't work, app is %v\n", app2)
		}
	}
}

func TestConfigSetGet(t *testing.T) {
	theKey := "foo"
	theValue := "bar"
	if err := config.Set(theKey, theValue); err != nil {
		t.Fatal(err)
	} else if val, err := config.Get(theKey); err != nil {
		t.Fatal(err)
	} else if val != theValue {
		t.Fatalf(`Config value doesn't match what was set, expected: "%s" got: "%s"\n`, theValue, val)
	}
}
