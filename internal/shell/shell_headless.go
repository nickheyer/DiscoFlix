//go:build headless

package shell

import "context"

// Reports headless because this build carries no UI libraries
func Detect(forceHeadless bool) Detection {
	return Detection{Mode: ModeHeadless, Reason: "this binary was built with the headless tag and contains no desktop UI"}
}

// Returns at once because a headless build has no UI to run
func Run(ctx context.Context, d Detection, o Options) error {
	return nil
}
