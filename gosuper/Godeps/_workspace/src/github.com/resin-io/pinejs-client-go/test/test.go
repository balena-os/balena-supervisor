package main

import (
	"fmt"

	"pinejs-client-go"
	"pinejs-client-go/resin"
)

func main() {
	resinApi := &pinejs.Client{
		Endpoint: "https://alpha.resin.io/ewa",
		APIKey:   "bananasbananas",
	}

	// var userApps []resin.Application
	myApp := resin.Application{Id: 338}

	resinApi.List(&userApps)

	// if err != nil {
	// 	fmt.Println(err)
	// }

	// for _, app := range userApps {
	// 	fmt.Println(app.AppName)
	// 	for _, device := range app.Devices {
	// 		fmt.Println("-->", device)
	// 	}
	// }

	fmt.Println("Getting one Application")

	resinApi.Get(&myApp)

	fmt.Println(myApp)
}
