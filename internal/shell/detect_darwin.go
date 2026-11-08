//go:build darwin && !headless

package shell

import (
	"fmt"

	"github.com/ebitengine/purego"
)

const (
	securityFramework     = "/System/Library/Frameworks/Security.framework/Security"
	callerSecuritySession = 0xFFFFFFFF
)

// Inspects the security session through Security.framework without touching AppKit or Wails
func Detect(forceHeadless bool) Detection {
	return decideDarwin(forceHeadless, darwinProbe{sessionAttributes: securitySessionAttributes})
}

// Returns the SessionAttributeBits of the caller session from SessionGetInfo
func securitySessionAttributes() (uint32, error) {
	lib, err := purego.Dlopen(securityFramework, purego.RTLD_NOW|purego.RTLD_LOCAL)
	if err != nil {
		return 0, err
	}
	defer purego.Dlclose(lib)
	sym, err := purego.Dlsym(lib, "SessionGetInfo")
	if err != nil {
		return 0, err
	}
	var getInfo func(session uint32, id *uint32, attrs *uint32) int32
	purego.RegisterFunc(&getInfo, sym)
	var id, attrs uint32
	if status := getInfo(callerSecuritySession, &id, &attrs); status != 0 {
		return 0, fmt.Errorf("SessionGetInfo returned OSStatus %d", status)
	}
	return attrs, nil
}
