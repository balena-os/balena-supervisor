package supermodels

type AppsCollection struct {
}

type App struct {
	AppId       int64
	Commit      string
	ContainerId string
	Env         map[string]string
	ImageId     string
}

func (apps *AppsCollection) Create(app *App) (err error) {
	return
}

func (apps *AppsCollection) Update(app *App) (err error) {
	return
}

func (apps *AppsCollection) Destroy(app *App) (err error) {
	return
}

func (apps *AppsCollection) Get(app *App) (err error) {
	return
}
