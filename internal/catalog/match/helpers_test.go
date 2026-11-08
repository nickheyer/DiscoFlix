package match

import "errors"

// Catalog thresholds the shipped priors are judged against
const (
	acceptLine = 0.95
	reviewLine = 0.5
)

var errScore = errors.New("score outside its bounds or without an explanation")
