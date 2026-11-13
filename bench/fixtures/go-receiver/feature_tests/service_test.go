package service

import "testing"

func TestFetchEntry(t *testing.T) { if (&Ledger{}).FetchEntry("x") != "x" { t.Fatal("wrong entry") } }
