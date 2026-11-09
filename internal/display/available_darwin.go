//go:build darwin

package display

import (
	"errors"
	"fmt"

	"github.com/ebitengine/purego"
)

const (
	securityFramework       = "/System/Library/Frameworks/Security.framework/Security"
	callerSecuritySession   = 0xFFFFFFFF
	sessionHasGraphicAccess = 0x0010 // SessionAttributeBits from AuthSession.h
)

// Available needs a security session with graphic access, which LaunchDaemons and SSH logins lack
func Available() error {
	lib, err := purego.Dlopen(securityFramework, purego.RTLD_NOW|purego.RTLD_LOCAL)
	if err != nil {
		return err
	}
	defer func() { _ = purego.Dlclose(lib) }()
	sym, err := purego.Dlsym(lib, "SessionGetInfo")
	if err != nil {
		return err
	}
	var getInfo func(session uint32, id *uint32, attrs *uint32) int32
	purego.RegisterFunc(&getInfo, sym)
	var id, attrs uint32
	if status := getInfo(callerSecuritySession, &id, &attrs); status != 0 {
		return fmt.Errorf("SessionGetInfo returned OSStatus %d", status)
	}
	if attrs&sessionHasGraphicAccess == 0 {
		return errors.New("the security session has no graphic access")
	}
	return nil
}
