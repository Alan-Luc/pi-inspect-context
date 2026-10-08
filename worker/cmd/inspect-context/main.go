package main

import (
	"fmt"
	"os"

	inspectcontext "inspect-context-go"
)

func main() {
	if err := inspectcontext.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "inspect_context:", err)
		os.Exit(1)
	}
}
