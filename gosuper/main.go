package main

import (
	"fmt"
	"net/http"

	"resin-supervisor/Godeps/_workspace/src/github.com/gorilla/mux"
)

func homeHandler(w http.ResponseWriter, r *http.Request) {
	fmt.Fprintln(w, "Hello, resin user!")
}

func main() {
	fmt.Println("I'm in the main loop!!")
	r := mux.NewRouter()
	r.HandleFunc("/", homeHandler)
	http.ListenAndServe(":8080", r)

}
